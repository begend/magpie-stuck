#!/usr/bin/env node
// 历史会话导入：把 Claude Code / Codex 的本机会话文件转换成插件记录，写入 <数据目录>/imported/YYYY-MM-DD.jsonl。
// 去重是会话级的：会话 uuid 的 sha1 前 12 位（= 网关记录的 session_header）或算出的会话 id 已在
// 捕获数据里 → 整个会话文件跳过（网关捕获带真实耗时/token，优先用捕获的）；分析时 mergeCalls 再兜底一次。
// 用法：node scripts/import-history.mjs [--dry] [--limit N] [--claude-dir DIR] [--codex-dir DIR]
// 数据目录：MAGPIE_STUCK_CONFIG_DIR 或 $XDG_CONFIG_HOME/magpie 或 ~/.config/magpie，下的 magpie-stuck/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { compactMessage, clipMsg, scrub, stripInjected, buildSessions, detect, summarize, validateRules, defaultRules,
  dayOf, sessionKey, anthropicMsgs, textOf, parseArgs } from "../page/core.js";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");
const hashMsg = (m) => sha1(JSON.stringify([m.role, m.text, m.calls, m.results])).slice(0, 16);
const DAY_MS = 86400000, MAX_LATENCY = 30 * 60000, USAGE_WINDOW = 20000;

// ---------- 通用：把一次「请求的新增消息」组装成插件记录 ----------
// steps: [{ messages, ts, model, in_tok, out_tok, cache_read, restart, latency }]
function assembleSession(agent, uuid, cwd, protocol, streams, maxText) {
  const records = [];
  for (const st of streams) {
    const header = sha1(uuid + (st.suffix || "")).slice(0, 12);
    let conv = 0, sid = null;
    for (const step of st.steps) {
      if (!step.messages.length) continue;
      // 同一个会话文件 = 一个会话：sid 只按首个含用户消息的 step 算一次；
      // 重写/压缩只把 offset 归零（buildSessions 会还原成「历史被裁剪」信号），不换会话。
      if (step.restart) conv = 0;
      if (!sid) sid = sessionKey(agent, uuid + (st.suffix || ""), step.messages, sha1);
      const msgs = step.messages.map((m) => {
        const cm = compactMessage(clipMsg(m, maxText), { user: maxText, assistant: maxText, result: Math.floor(maxText / 2), cmd: 2000 });
        cm.h = hashMsg(m);
        return cm;
      });
      records.push({ ts: step.ts, agent, origin: "imported", protocol, model: step.model || "", served: step.model || "",
        stream: false, path: "", cwd: cwd || "", ok: step.ok !== false,
        latency_ms: Math.max(0, step.latency || 0), in_tok: step.in_tok || 0, out_tok: step.out_tok || 0, cache_read: step.cache_read || 0,
        session: sid, session_header: header, offset: conv, nmsgs: conv + msgs.length, msgs, reply: null, ntools: 0 });
      conv += msgs.length;
    }
  }
  return records;
}
const stepOf = (buf, extra = {}) => {
  const asst = buf.filter((x) => x.m.role === "assistant");
  const ts = (asst.length ? asst[asst.length - 1] : buf[buf.length - 1]).ts;
  const first = buf[0].ts, last = asst.length ? asst[asst.length - 1].ts : ts;
  return { messages: buf.map((x) => x.m), ts, latency: Number.isFinite(last - first) ? Math.min(Math.max(last - first, 0), MAX_LATENCY) : 0, ...extra };
};

// ---------- Magpie usage.jsonl：给导入的会话补真实耗时 / token / 状态码 ----------
function usageIndex(file) {
  const idx = new Map();   // `${agent}\0${session uuid}` -> [{t, ms, in, out, cr, cw, status, served, provider, used}]
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (!line.startsWith("{")) continue;
      let u; try { u = JSON.parse(line); } catch { continue; }
      const t = Date.parse(u.t || "");
      if (!u.agent || !u.session || !Number.isFinite(t)) continue;
      const k = `${u.agent}\0${u.session}`;
      if (!idx.has(k)) idx.set(k, []);
      idx.get(k).push({ t, ms: u.ms || 0, in: u.in || 0, out: u.out || 0, cr: u.cache_read || 0, cw: u.cache_write || 0,
        status: u.status || 0, served: u.served || "", provider: u.provider || "", used: false });
    }
    for (const rows of idx.values()) rows.sort((a, b) => a.t - b.t);
  } catch {}
  return idx;
}
function enrich(records, uuid, agent, idx) {
  const rows = idx.get(`${agent}\0${uuid}`) || [];
  for (const r of records) {
    let best = null;
    for (const row of rows) {
      if (row.used) continue;
      const dt = Math.abs(row.t - r.ts);
      if (dt > USAGE_WINDOW) continue;
      if (!best || dt < best.dt) best = { dt, row };
    }
    if (!best) continue;
    best.row.used = true;
    const u = best.row;
    if (u.ms > 0) r.latency_ms = u.ms;
    if (u.status > 0) r.ok = u.status < 400;
    if (!r.in_tok && u.in) { r.in_tok = u.in + u.cr + u.cw; r.out_tok = u.out; }
    if (u.served) r.served = u.served;
    if (u.provider) r.provider = u.provider;
  }
  return records;
}

// ---------- Claude Code：~/.claude/projects/<项目>/<sessionId>.jsonl ----------
// 条目流按 isSidechain 拆成主流 + 若干子代理流（网关实时视角里子代理也是独立会话）；
// parentUuid 断链 / isCompactSummary / 重启 = 历史被改写，下一条消息起 offset 归 0。
function splitClaudeStreams(entries) {
  const streams = []; let main = { suffix: "", items: [] }, side = null;
  streams.push(main);
  for (const e of entries) {
    if (e.isSidechain) {
      if (!side) streams.push(side = { suffix: "-side-" + (streams.length - 1), items: [] });
      side.items.push(e);
    } else { main.items.push(e); if (side) side = null; }
  }
  return streams.filter((s) => s.items.length);
}
function claudeStreamSteps(items) {
  const steps = []; let buf = [], hasAsst = false, lastUuid = null, restart = false, usage = null;
  const flush = () => {
    if (!hasAsst) return;                       // 没有模型回复的悬空消息不构成一次调用
    const asst = buf.filter((x) => x.m.role === "assistant");
    const u = asst[asst.length - 1].usage;
    steps.push(stepOf(buf, { restart, in_tok: u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0,
      out_tok: u ? u.output_tokens || 0 : 0, cache_read: u ? u.cache_read_input_tokens || 0 : 0 }));
    buf = []; hasAsst = false; restart = false; usage = null;
  };
  for (const e of items) {
    const t = Date.parse(e.timestamp || "");
    if (e.type === "assistant" && e.message) {
      const [m] = anthropicMsgs({ messages: [e.message] });
      if (m && (m.text || m.calls?.length)) {
        if (lastUuid != null && e.parentUuid !== lastUuid) restart = true;
        lastUuid = e.uuid ?? lastUuid;
        buf.push({ m, ts: t, usage: e.message.usage || null }); hasAsst = true;
      }
    } else if (e.type === "user" && e.message) {
      if (lastUuid != null && e.parentUuid !== lastUuid) restart = true;
      if (e.isCompactSummary) restart = true;
      lastUuid = e.uuid ?? lastUuid;
      if (hasAsst) flush();
      const [m] = anthropicMsgs({ messages: [e.message] });
      if (m && (m.text || m.results?.length)) buf.push({ m, ts: t });
    }
  }
  flush();
  return steps;
}
function convertClaudeFile(file, maxText) {
  const entries = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && (e.type === "user" || e.type === "assistant") && e.message) entries.push(e); } catch {}
  }
  const uuid = path.basename(file, ".jsonl");
  let cwd = "";
  for (const e of entries) if (e.cwd) { cwd = e.cwd; break; }
  const streams = splitClaudeStreams(entries).map((s) => ({ suffix: s.suffix, steps: claudeStreamSteps(s.items) }));
  return { uuid, cwd, protocol: "anthropic", streams };
}

// ---------- Codex：~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl ----------
// response_item 是对话本体；turn_context 带模型；compacted = 历史压缩；event_msg/token_count 带 last_token_usage。
function codexSteps(items) {
  const steps = []; let buf = [], hasAsst = false, restart = false;
  let uuid = "", cwd = "", model = "", tok = null, tokFresh = false;
  const flush = () => {
    if (!hasAsst) return;
    steps.push(stepOf(buf, { restart, model, in_tok: tokFresh ? (tok.input_tokens || 0) + (tok.cached_input_tokens || 0) : 0,
      out_tok: tokFresh ? (tok.output_tokens || 0) : 0, cache_read: tokFresh ? (tok.cached_input_tokens || 0) : 0 }));
    buf = []; hasAsst = false; restart = false; tokFresh = false;
  };
  const attach = (call, t) => {
    const last = buf[buf.length - 1];
    if (last && last.m.role === "assistant" && !(last.m.results || []).length) last.m.calls.push(call);
    else buf.push({ m: { role: "assistant", text: "", calls: [call], results: [] }, ts: t });
    hasAsst = true;
  };
  for (const e of items) {
    const t = Date.parse(e.timestamp || "");
    const p = e.payload || {};
    if (e.type === "session_meta") { uuid = p.session_id || p.id || uuid; cwd = p.cwd || cwd; continue; }
    if (e.type === "turn_context") { model = p.model || model; continue; }
    if (e.type === "compacted") { if (hasAsst) flush(); restart = true; continue; }
    if (e.type === "event_msg") {
      if (p.type === "token_count" && p.info?.last_token_usage) { tok = p.info.last_token_usage; tokFresh = true; }
      continue;
    }
    if (e.type !== "response_item") continue;
    if (p.type === "message") {
      const text = textOf(p.content ?? p.text ?? "");
      if (p.role === "assistant") {
        if (!text) continue;
        buf.push({ m: { role: "assistant", text, calls: [], results: [] }, ts: t }); hasAsst = true;
      } else if (p.role === "user") {
        if (hasAsst) flush();
        if (text) buf.push({ m: { role: "user", text, calls: [], results: [] }, ts: t });
      }
    } else if (p.type === "function_call" || p.type === "custom_tool_call") {
      attach({ id: p.call_id || p.id || "", name: p.name || "", args: parseArgs(p.arguments ?? p.input) }, t);
    } else if (p.type === "local_shell_call") {
      attach({ id: p.call_id || p.id || "", name: "local_shell", args: { command: p.action?.command } }, t);
    } else if (p.type === "function_call_output" || p.type === "custom_tool_call_output" || p.type === "local_shell_call_output") {
      const out = p.output;
      const text = typeof out === "string" ? out : textOf(out);
      buf.push({ m: { role: "tool", text: "", calls: [], results: [{ id: p.call_id || "", text, is_error: false }] }, ts: t });
    }
  }
  flush();
  return { uuid, cwd, steps };
}
function convertCodexFile(file, maxText) {
  const items = [];
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try { const e = JSON.parse(line); if (e && e.type) items.push(e); } catch {}
  }
  const conv = codexSteps(items);
  if (!conv.uuid) { const m = /rollout-.*-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(path.basename(file)); conv.uuid = m ? m[1] : sha1(file).slice(0, 12); }
  return { uuid: conv.uuid, cwd: conv.cwd, protocol: "responses", streams: [{ suffix: "", steps: conv.steps }] };
}

// ---------- 主流程 ----------
function readJsonl(file) {
  const out = [];
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      if (line.trim()) try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out;
}
export function importAll({ cfgDir, claudeDir, codexDir, dry = false, limit = 0, log = console.error } = {}) {
  cfgDir = cfgDir || process.env.MAGPIE_STUCK_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie");
  claudeDir = claudeDir || path.join(os.homedir(), ".claude", "projects");
  codexDir = codexDir || path.join(os.homedir(), ".codex", "sessions");
  const dataDir = path.join(cfgDir, "magpie-stuck");
  // 插件选项（maxTextChars / outputDir）与 export-day.mjs 同一套解析
  let opt = {};
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(cfgDir, "plugins.json"), "utf8"));
    const mine = (pj.plugins ?? []).find((p) => typeof p?.spec === "string" && p.spec.toLowerCase().includes("magpie-stuck"));
    opt = mine?.options || {};
  } catch {}
  const maxText = Number(opt.maxTextChars) > 0 ? Number(opt.maxTextChars) : 20000;
  const outDir = path.isAbsolute(opt.outputDir || "") ? opt.outputDir : path.join(cfgDir, opt.outputDir || "magpie-stuck");
  const importedDir = path.join(outDir, "imported");

  // 捕获数据的会话索引：uuid 会话头 + 会话 id，命中即整文件跳过
  const capIds = new Set(), capHdrs = new Set();
  try {
    for (const f of fs.readdirSync(path.join(outDir, "calls"))) {
      if (!/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      for (const c of readJsonl(path.join(outDir, "calls", f))) {
        if (c.session) capIds.add(c.session);
        if (c.session_header) capHdrs.add(c.session_header);
      }
    }
  } catch {}

  let manifest = { sessions: {} };
  try { manifest = JSON.parse(fs.readFileSync(path.join(importedDir, "manifest.json"), "utf8")) || manifest; } catch {}
  if (!manifest.sessions) manifest.sessions = {};

  const idx = usageIndex(path.join(cfgDir, "usage.jsonl"));
  const sources = [
    { name: "claude", dir: claudeDir, list: () => listClaudeFiles(claudeDir), convert: (f) => convertClaudeFile(f, maxText) },
    { name: "codex", dir: codexDir, list: () => listCodexFiles(codexDir), convert: (f) => convertCodexFile(f, maxText) },
  ];
  const stats = { files: 0, imported: 0, records: 0, skippedDup: 0, skippedManifest: 0, noSteps: 0, days: {} };
  const byDay = new Map();   // day -> [records]

  for (const src of sources) {
    for (const file of src.list()) {
      stats.files++;
      if (limit && stats.files > limit) break;
      const st = fs.statSync(file);
      const probe = src.convert(file);
      if (!probe.uuid || !probe.streams.some((s) => s.steps.length)) { stats.noSteps++; continue; }
      const mkey = `${src.name}\0${probe.uuid}`;
      const m = manifest.sessions[mkey];
      if (m && m.size === st.size && m.mtime === st.mtimeMs) { stats.skippedManifest++; continue; }
      const records = enrich(assembleSession(src.name, probe.uuid, probe.cwd, probe.protocol, probe.streams, maxText), probe.uuid, src.name, idx);
      if (records.some((r) => capIds.has(r.session) || capHdrs.has(r.session_header))) {
        stats.skippedDup++;
        manifest.sessions[mkey] = { file, size: st.size, mtime: st.mtimeMs, records: 0, skipped: "captured", at: Date.now() };
        continue;
      }
      if (!records.length) { stats.noSteps++; continue; }
      stats.imported++;
      stats.records += records.length;
      for (const r of records) {
        const d = dayOf(r.ts);
        if (!byDay.has(d)) byDay.set(d, []);
        byDay.get(d).push(r);
      }
      manifest.sessions[mkey] = { file, size: st.size, mtime: st.mtimeMs, records: records.length, at: Date.now() };
      if (dry) log(`[dry] ${src.name} ${path.basename(file)} → ${records.length} 条记录`);
    }
  }
  if (!dry) {
    fs.mkdirSync(importedDir, { recursive: true, mode: 0o700 });
    for (const [day, recs] of byDay) {
      recs.sort((a, b) => a.ts - b.ts);
      fs.appendFileSync(path.join(importedDir, `${day}.jsonl`), recs.map((r) => JSON.stringify(r)).join("\n") + "\n", { mode: 0o600 });
      stats.days[day] = (stats.days[day] || 0) + recs.length;
    }
    fs.writeFileSync(path.join(importedDir, "manifest.json"), JSON.stringify(manifest, null, 1), { mode: 0o600 });
  }
  return stats;
}
function listClaudeFiles(dir) {
  const out = [];
  let projects = [];
  try { projects = fs.readdirSync(dir).filter((d) => !d.startsWith(".")); } catch { return out; }
  for (const p of projects) {
    // 项目目录下除了顶层 <sessionId>.jsonl，还有 <sessionId>/subagents/agent-*.jsonl（子代理会话，卡点高发）；
    // memory 子目录不是会话，跳过
    const walk = (d, depth) => {
      let es = [];
      try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const e of es) {
        const fp = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== "memory" && depth < 4) walk(fp, depth + 1); }
        else if (e.isFile() && e.name.endsWith(".jsonl")) out.push(fp);
      }
    };
    walk(path.join(dir, p), 1);
  }
  return out.sort();
}
function listCodexFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let es = [];
    try { es = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of es) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 4) walk(p, depth + 1); }
      else if (e.isFile() && /^rollout-.*\.jsonl$/.test(e.name)) out.push(p);
    }
  };
  walk(dir, 0);
  return out.sort();
}

// 导入后的历史也跑一遍规则，给出即时的分布概览
export function importedOverview(cfgDir) {
  cfgDir = cfgDir || process.env.MAGPIE_STUCK_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie");
  let opt = {};
  try {
    const pj = JSON.parse(fs.readFileSync(path.join(cfgDir, "plugins.json"), "utf8"));
    const mine = (pj.plugins ?? []).find((p) => typeof p?.spec === "string" && p.spec.toLowerCase().includes("magpie-stuck"));
    opt = mine?.options || {};
  } catch {}
  const outDir = path.isAbsolute(opt.outputDir || "") ? opt.outputDir : path.join(cfgDir, opt.outputDir || "magpie-stuck");
  const v = validateRules(opt.rules && Array.isArray(opt.rules.rules) ? opt.rules : defaultRules());
  const cfg = v.errors.length ? validateRules(defaultRules()).cfg : v.cfg;
  const days = {};
  try { for (const f of fs.readdirSync(path.join(outDir, "imported"))) if (/^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) days[f.slice(0, 10)] = 1; } catch {}
  const totals = { days: Object.keys(days).sort(), sessions: 0, calls: 0, hits: 0, by_rule: {} };
  for (const day of totals.days) {
    const calls = readJsonl(path.join(outDir, "imported", `${day}.jsonl`));
    if (!calls.length) continue;
    const sessions = buildSessions(calls);
    const sum = summarize(detect(sessions, cfg), sessions);
    totals.sessions += sum.sessions; totals.calls += sum.calls; totals.hits += sum.hits;
    for (const [k, n] of sum.by_rule) totals.by_rule[k] = (totals.by_rule[k] || 0) + n;
  }
  return totals;
}

async function main() {
  const args = process.argv.slice(2);
  const argVal = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const t0 = Date.now();
  const stats = importAll({
    dry: args.includes("--dry"),
    limit: Number(argVal("--limit")) || 0,
    claudeDir: argVal("--claude-dir"),
    codexDir: argVal("--codex-dir"),
  });
  console.error(`文件 ${stats.files} 个：导入 ${stats.imported}（${stats.records} 条记录），已捕获跳过 ${stats.skippedDup}，此前已导入跳过 ${stats.skippedManifest}，无对话 ${stats.noSteps}；用时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  for (const [day, n] of Object.entries(stats.days).sort()) console.error(`  ${day}: ${n} 条`);
  const ov = importedOverview();
  console.error(`历史卡点：${ov.sessions} 会话 / ${ov.calls} 调用 / ${ov.hits} 个卡点`);
  for (const [k, n] of Object.entries(ov.by_rule).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.error(`  ${k}: ${n}`);
}
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) main();
