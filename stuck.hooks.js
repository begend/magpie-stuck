// magpie-stuck —— magpie gateway hooks 插件
// 在 Magpie 的 Bun 插件宿主里运行：onResponse 拿到每次调用的请求体 + 拼好的回复，
// 精简后按天写入本机 <配置目录>/magpie-stuck/calls/YYYY-MM-DD.jsonl，
// 并把最近几天的精简会话写进 plugins.json 本插件条目的 options._status，
// App 内的「卡点」页面经 magpie.options.get() 读取后在页面里跑规则。
// 规则保存在 options.rules（页面可视化编辑），所有数据只留在本机。

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { DEFAULTS, normalizeRequest, parseReply, usageOf, compactMessage, clipMsg, scrub, stripInjected,
  buildSessions, detect, summarize, groupIssues, validateRules, defaultRules, dayOf, shiftDay, sessionKey as mkSessionKey, mergeCalls } from "./page/core.js";

const CFG_DIR = process.env.MAGPIE_STUCK_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie");
const PLUGINS_JSON = path.join(CFG_DIR, "plugins.json");
const USAGE_JSONL = path.join(CFG_DIR, "usage.jsonl");
const NAME = "magpie-stuck";

let OPT = { ...DEFAULTS };
let rawUser = {};
const sessState = new Map();   // `${day}\0${sid}` -> 已存消息哈希
const lastSid = new Map();     // `${day}\0${agent}` -> 最近会话
let loadedDays = new Set();
let pending = 0;               // 上次快照后新增的调用数
let lastSnapAt = 0;
let snapTimer = null;
let stats = { captured: 0, skippedOrigin: 0, skippedAgent: 0, failed: 0, errors: 0, startedAt: Date.now() };

// ---------- 小工具 ----------
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, file);
}
function appendLine(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n", { mode: 0o600 });
}
function log(msg) { try { console.error(`[${NAME}] ${msg}`); } catch {} }
const findMine = (cfg) => (cfg?.plugins ?? []).find((p) => typeof p?.spec === "string" && p.spec.toLowerCase().includes(NAME));
const callsFile = (day) => path.join(OPT.dir, "calls", `${day}.jsonl`);
const importedFile = (day) => path.join(OPT.dir, "imported", `${day}.jsonl`);
const sha = (s) => crypto.createHash("sha1").update(s).digest("hex");
const sessionKey = (agent, sessHeader, msgs) => mkSessionKey(agent, sessHeader, msgs, sha);

// ---------- options ----------
function loadOptions() {
  const mine = findMine(readJson(PLUGINS_JSON));
  rawUser = mine?.options && typeof mine.options === "object" ? mine.options : {};
  OPT = { ...DEFAULTS, ...rawUser };
  OPT.dir = path.isAbsolute(OPT.outputDir) ? OPT.outputDir : path.join(CFG_DIR, OPT.outputDir);
  rollupCache.clear();
  return OPT;
}
function rulesCfg() {
  const r = rawUser.rules && Array.isArray(rawUser.rules.rules) ? rawUser.rules : defaultRules();
  const { cfg, errors } = validateRules(r);
  return errors.length ? validateRules(defaultRules()).cfg : cfg;
}

// ---------- 读写调用记录 ----------
function readCalls(day, sub = "calls") {
  const file = sub === "calls" ? callsFile(day) : importedFile(day);
  let raw = "";
  try { raw = fs.readFileSync(file, "utf8"); } catch { return []; }
  const out = [];
  for (const line of raw.split("\n")) { if (line.trim()) try { out.push(JSON.parse(line)); } catch {} }
  return out;
}
function loadDayState(day) {
  if (loadedDays.has(day)) return;
  loadedDays.add(day);
  for (const c of readCalls(day)) {
    const k = `${day}\0${c.session}`;
    const hs = sessState.get(k) || [];
    hs.length = Math.min(hs.length, c.offset || 0);
    for (const m of c.msgs || []) hs.push(m.h);
    sessState.set(k, hs);
    lastSid.set(`${day}\0${c.agent}`, c.session);
  }
}

// 从 Magpie 自己的 usage.jsonl 补实际服务的模型 / 状态码（找同 agent、同请求模型、时间最近的一条）
function enrichFromUsage(rec) {
  try {
    const st = fs.statSync(USAGE_JSONL);
    const fd = fs.openSync(USAGE_JSONL, "r");
    const len = Math.min(st.size, 64 * 1024);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, st.size - len);
    fs.closeSync(fd);
    let best = null;
    for (const line of buf.toString("utf8").split("\n").reverse()) {
      if (!line.startsWith("{")) continue;
      let u; try { u = JSON.parse(line); } catch { continue; }
      if (u.agent !== rec.agent || (u.req && u.req !== rec.model)) continue;
      const dt = Math.abs(Date.parse(u.t) - (rec.ts + rec.latency_ms));
      if (dt < 5000 && (!best || dt < best.dt)) best = { dt, u };
    }
    if (best) {
      rec.served = best.u.served || best.u.model || "";
      rec.provider = best.u.provider || "";
      rec.status = best.u.status || 0;
      if (!rec.in_tok && best.u.in) { rec.in_tok = best.u.in + (best.u.cache_read || 0) + (best.u.cache_write || 0); rec.out_tok = best.u.out || 0; }
    }
  } catch {}
}

function capture(reply, ctx) {
  const origin = ctx.origin || "unknown";
  if (!(OPT.captureOrigins || []).includes(origin)) { stats.skippedOrigin++; return; }
  const agent = ctx.agent || "unknown";
  if ((OPT.ignoreAgents || []).includes(agent)) { stats.skippedAgent++; return; }
  const body = ctx.request;
  const t0 = ctx.state?.t0 || Date.now();
  const ts = t0, day = dayOf(ts);
  const norm = normalizeRequest(body, ctx.protocol);
  const n = OPT.maxTextChars;
  const msgs = norm.messages.map((m) => {
    const full = clipMsg(m, n);
    const cm = compactMessage(full, { user: n, assistant: n, result: Math.floor(n / 2), cmd: 2000 });
    cm.h = sha(JSON.stringify([m.role, m.text, m.calls, m.results])).slice(0, 16);
    return cm;
  });
  let rmsg = null;
  if (ctx.success && reply) {
    const pr = parseReply(reply, ctx.protocol);
    if (pr) { rmsg = compactMessage(clipMsg(pr, n), { user: n, assistant: n, result: n, cmd: 2000 }); rmsg.h = sha(JSON.stringify([pr.role, pr.text, pr.calls, pr.results])).slice(0, 16); }
  }
  const usage = ctx.success && reply ? usageOf(reply) : { in_tok: 0, out_tok: 0, cache_read: 0 };
  const rec = { ts, agent, origin, protocol: norm.protocol, model: ctx.model || body?.model || "", served: (reply && reply.model) || "",
    stream: !!ctx.stream, path: ctx.path || "", cwd: ctx.cwd || "", ok: ctx.success === true,
    latency_ms: Math.max(0, Date.now() - t0), ...usage, ntools: norm.ntools };
  enrichFromUsage(rec);
  if (!rec.ok) stats.failed++;
  loadDayState(day);
  let sid;
  if (msgs.length) sid = sessionKey(agent, ctx.session || "", norm.messages.map((m) => ({ role: m.role, text: m.text })));
  else sid = lastSid.get(`${day}\0${agent}`) || `${agent}-unparsed`;
  lastSid.set(`${day}\0${agent}`, sid);
  const key = `${day}\0${sid}`;
  const hs = sessState.get(key) || [];
  let lcp = 0;
  while (lcp < hs.length && lcp < msgs.length && hs[lcp] === msgs[lcp].h) lcp++;
  rec.session = sid; rec.session_header = ctx.session ? sha(ctx.session).slice(0, 12) : "";
  rec.offset = lcp; rec.nmsgs = msgs.length; rec.msgs = msgs.slice(lcp); rec.reply = rmsg;
  if (msgs.length) { hs.length = lcp; for (const m of msgs.slice(lcp)) hs.push(m.h); sessState.set(key, hs); }
  appendLine(callsFile(day), rec);
  stats.captured++;
  pending++;
  scheduleSnapshot();
}

// ---------- 面板快照：写进 options._status，App 内页面经 magpie.options.get() 读取 ----------
// 注意：Magpie 发现 plugins.json 变化会重启插件宿主，所以严格节流，只在有新调用时写。
const SHRINK = [
  { user: 600, assistant: 400, result: 300, cmd: 300, last: 160 },
  { user: 300, assistant: 200, result: 160, cmd: 160, last: 80 },
  { user: 140, assistant: 100, result: 90, cmd: 100, last: 40 },
];
const cut = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n) + "…" : t; };
const headTail = (t, n) => { t = String(t || ""); return t.length > 2 * n ? t.slice(0, n) + "\n…\n" + t.slice(-n) : t; };
function shrinkMsg(m, L) {
  const o = { role: m.role, text: cut(m.text, m.role === "user" ? L.user : L.assistant) };
  if (m.h) o.h = m.h;
  if (m.calls) o.calls = m.calls.map((c) => ({ ...c, cmd: c.cmd ? cut(c.cmd, L.cmd) : undefined,
    files: c.files?.map((f) => ({ ...f, last: cut(f.last, L.last), so: f.so.slice(0, 60), sn: f.sn.slice(0, 60) })) }));
  if (m.results) o.results = m.results.map((r) => ({ id: r.id, is_error: r.is_error, text: headTail(r.text, L.result) }));
  return o;
}
function snapshotDays() {
  const days = [];
  for (let i = 0; i < Math.max(1, OPT.snapshotDays); i++) days.push(dayOf(Date.now() - i * 86400000));
  return days;
}

// ---------- 每日汇总（rollup）：捕获 + 导入合并后的计数，给页面的多时间维度报表用 ----------
// 只存计数不存会话，一天不到 1KB，40 天也能塞进快照。按文件 mtime 缓存，快照节流期间零开销。
const ROLLUP_DAYS = 40;
const ROLLUP_ALGO = 5;   // 快照派生算法版本（rollup + 明细合并 + 问题片段计数）：升级后启动时自动重发快照
const rollupCache = new Map();   // day -> { key, rollup }
function dayRollup(day, cfg) {
  const files = [callsFile(day), importedFile(day)];
  const key = files.map((f) => { try { const s = fs.statSync(f); return `${s.mtimeMs}:${s.size}`; } catch { return ""; } }).join("|");
  const cached = rollupCache.get(day);
  if (cached && cached.key === key) return cached.rollup;
  const calls = mergeCalls(readCalls(day), readCalls(day, "imported"));
  let rollup = { day, calls: 0, sessions: 0, hits: 0, by_rule: [], by_agent: [], by_model: [], by_severity: [] };
  if (calls.length) {
    const sessions = buildSessions(calls);
    const hits = detect(sessions, cfg);
    const sum = summarize(hits, sessions);
    rollup = { day, calls: sum.calls, sessions: sum.sessions, hits: sum.hits, issues: groupIssues(hits, sessions).length,
      by_rule: sum.by_rule, by_agent: sum.by_agent, by_model: sum.by_model, by_severity: sum.by_severity };
  }
  rollupCache.set(day, { key, rollup });
  return rollup;
}
function buildRollups(cfg) {
  const out = [];
  for (let i = 0; i < ROLLUP_DAYS; i++) {
    const r = dayRollup(dayOf(Date.now() - i * 86400000), cfg);
    if (r.calls > 0) out.push(r);
  }
  return out;
}

function buildStatus(level, rollups) {
  const L = SHRINK[Math.min(level, SHRINK.length - 1)];
  const keepDays = level >= SHRINK.length ? Math.max(1, OPT.snapshotDays - (level - SHRINK.length + 1)) : OPT.snapshotDays;
  const cfg = rulesCfg();
  const days = [];
  for (const day of snapshotDays().slice(0, keepDays)) {
    const calls = mergeCalls(readCalls(day), readCalls(day, "imported"));
    if (!calls.length) continue;
    const small = calls.map((c) => ({ ...c, msgs: (c.msgs || []).map((m) => shrinkMsg(m, L)), reply: c.reply ? shrinkMsg(c.reply, L) : null }));
    const sessions = buildSessions(small);
    const hits = detect(buildSessions(calls), cfg);   // 宿主侧用完整文本算一遍，页面可对照
    for (const s of sessions) { for (const m of s.messages) delete m.h; delete s.stats; }
    days.push({ day, calls: calls.length, hostHits: hits.length, hostSummary: summarize(hits, sessions), sessions });
  }
  return { updatedAt: Date.now(), version: 2, rollupAlgo: ROLLUP_ALGO, stats, dir: OPT.dir, rollupDays: ROLLUP_DAYS, rollups: rollups || [], days };
}
function writeSnapshot(force = false) {
  try {
    if (!force && (!pending || Date.now() - lastSnapAt < OPT.publishSeconds * 1000)) return false;
    const cfg = readJson(PLUGINS_JSON); if (!cfg) return false;
    const mine = findMine(cfg); if (!mine) return false;
    const rollups = buildRollups(rulesCfg());
    let st, text, level = 0;
    for (; level < SHRINK.length + 4; level++) {
      st = buildStatus(level, rollups);
      text = JSON.stringify(st);
      if (text.length <= OPT.snapshotMaxKB * 1024) break;
    }
    st.level = level; st.bytes = text.length;
    mine.options = { ...(mine.options ?? {}), _status: st };
    if (stats.lastExport && mine.options._export?.nonce === stats.lastExport.nonce) delete mine.options._export;
    lastSnapAt = Date.now();
    pending = 0;
    writeText(PLUGINS_JSON, JSON.stringify(cfg, null, 2));
    return true;
  } catch (e) { stats.errors++; log(`快照写入失败: ${e.message}`); return false; }
}
function scheduleSnapshot() {
  if (snapTimer) return;
  const wait = Math.max(2000, OPT.publishSeconds * 1000 - (Date.now() - lastSnapAt));
  snapTimer = setTimeout(() => { snapTimer = null; if (!writeSnapshot()) { if (pending) scheduleSnapshot(); } }, wait);
  snapTimer.unref?.();
}

// ---------- 导出：页面把 options._export 设成 {day, nonce} 或 {from, to, nonce}，宿主写出 JSON ----------
// 导出范围 = 捕获记录 + 导入记录（mergeCalls 会话级去重，捕获优先）
export function exportRange(from, to) {
  const days = [];
  for (let d = from; days.length < 62 && d <= to; d = shiftDay(d, 1)) days.push(d);
  const calls = [];
  for (const day of days) calls.push(...mergeCalls(readCalls(day), readCalls(day, "imported")));
  const cfg = rulesCfg();
  const sessions = buildSessions(calls);
  const hits = detect(sessions, cfg);
  const name = from === to ? `magpie-stuck-${from}.json` : `magpie-stuck-${from}_to_${to}.json`;
  const out = path.join(OPT.dir, "exports", name);
  writeText(out, JSON.stringify({ from, to, exportedAt: Date.now(), rules: cfg, summary: summarize(hits, sessions), hits, sessions, calls }, null, 1));
  return out;
}
export function exportDay(day) { return exportRange(day, day); }
function handleExport() {
  const req = rawUser._export;
  if (!req || typeof req !== "object") return;
  if (stats.lastExport && stats.lastExport.nonce === req.nonce) return;   // 已处理
  const dayRe = /^\d{4}-\d{2}-\d{2}$/;
  const label = req.day ? String(req.day) : (req.from && req.to ? `${req.from}~${req.to}` : "");
  const ok = req.day ? dayRe.test(String(req.day))
    : dayRe.test(String(req.from || "")) && dayRe.test(String(req.to || "")) && String(req.from) <= String(req.to);
  if (!label || !ok) return;
  try {
    const file = req.day ? exportDay(String(req.day)) : exportRange(String(req.from), String(req.to));
    stats.lastExport = { day: req.day, from: req.from, to: req.to, nonce: req.nonce, file, at: Date.now() };
    log(`已导出 ${label} → ${file}`);
  } catch (e) { stats.lastExport = { day: req.day, from: req.from, to: req.to, nonce: req.nonce, error: e.message, at: Date.now() }; }
  writeSnapshot(true);
}

function pruneOld() {
  try {
    const dir = path.join(OPT.dir, "calls"), lim = Date.now() - OPT.retainDays * 86400000;
    for (const f of fs.readdirSync(dir)) {
      const m = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
      if (m && Date.parse(m[1] + "T23:59:59") < lim) fs.unlinkSync(path.join(dir, f));
    }
  } catch {}
}

// ---------- 网关钩子 ----------
export function onRequest(body, ctx) {
  if (ctx?.state) ctx.state.t0 = Date.now();
  return undefined;   // 不改请求
}

export function onResponse(reply, ctx) {
  try { if (ctx?.request) capture(reply, ctx); } catch (e) { stats.errors++; log(`记录失败: ${e.message}`); }
}

// ---------- options 变更轮询（页面改了规则 / 发起导出时，宿主一般会被 Magpie 重启；这里兜底） ----------
let lastRaw = "";
function watchOptions() {
  try { lastRaw = fs.readFileSync(PLUGINS_JSON, "utf8"); } catch {}
  const t = setInterval(() => {
    try {
      const raw = fs.readFileSync(PLUGINS_JSON, "utf8");
      if (raw === lastRaw) return;
      lastRaw = raw;
      loadOptions();
      handleExport();
    } catch {}
  }, 5_000);
  t.unref?.();
}

// ---------- 启动（宿主加载 / 重启时执行） ----------
loadOptions();
if (rawUser._status?.stats?.lastExport) stats.lastExport = rawUser._status.stats.lastExport;
pruneOld();
handleExport();
// 页面保存规则时会去掉 _status（options 请求体上限 64 KiB），这里尽快补发快照
// 上一个宿主实例来不及发布的调用（被重启打断）也在这里补上；导入的新数据同样触发
{
  let newest = 0;
  try { newest = fs.statSync(callsFile(dayOf(Date.now()))).mtimeMs; } catch {}
  try {
    const idir = path.join(OPT.dir, "imported");
    for (const f of fs.readdirSync(idir)) newest = Math.max(newest, fs.statSync(path.join(idir, f)).mtimeMs);
  } catch {}
  if (newest && (!rawUser._status || newest > (rawUser._status.updatedAt || 0) || rawUser._status.rollupAlgo !== ROLLUP_ALGO)) { pending = 1; scheduleSnapshot(); }
}
watchOptions();
