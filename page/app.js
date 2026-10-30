// magpie-stuck 页面：运行在 Magpie App 的插件沙箱 iframe 里（只允许脚本，CSP 禁止 fetch）。
// 数据只经 bridge：magpie.options.get() 读宿主写入的 options._status 快照，
// 规则存在 options.rules，用 magpie.options.set() 保存。规则检测在页面里实时跑。
import { clone, RULE_TYPES, SEVERITIES, SEVERITY_LABEL, defaultRules, validateRules, detect, summarize, groupIssues, formatLocal, stripInjected, shiftDay } from "./core.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const HAS_BRIDGE = typeof window !== "undefined" && typeof window.magpie?.options?.get === "function";

const S = {
  opts: null, snap: null, snapStale: false, saved: null, draft: null, dirty: false,
  day: "", tab: "dash", range: "day", filter: {}, session: null, focusMsg: null, open: {}, preview: null,
  note: null, loadedAt: 0, error: "",
};

// ---------- 数据 ----------
async function load() {
  try {
    const o = (await magpie.options.get()) || {};
    S.opts = o;
    if (o._status && o._status.days) { S.snap = o._status; S.snapStale = false; }
    else if (S.snap) S.snapStale = true;
    const r = o.rules && Array.isArray(o.rules.rules) ? o.rules : defaultRules();
    const v = validateRules(r);
    S.saved = v.errors.length ? validateRules(defaultRules()).cfg : v.cfg;
    if (!S.dirty) S.draft = clone(S.saved);
    S.error = v.errors.length ? "已保存的规则有错误，暂用默认规则：" + v.errors.join("；") : "";
    S.loadedAt = Date.now();
  } catch (e) { S.error = "读取插件数据失败：" + (e?.message || e); }
}

function days() { return (S.snap?.days || []).map((d) => d.day); }
function dayData(day) { return (S.snap?.days || []).find((d) => d.day === day); }
const cache = new Map();
function analyse(day, cfg) {
  const d = dayData(day);
  if (!d) return { sessions: [], hits: [], sum: summarize([], []) };
  const key = day + "|" + (S.snap?.updatedAt || 0) + "|" + JSON.stringify(cfg);
  if (cache.has(key)) return cache.get(key);
  const sessions = clone(d.sessions);
  const hits = detect(sessions, cfg);
  const out = { sessions, hits, sum: summarize(hits, sessions) };
  if (cache.size > 20) cache.clear();
  cache.set(key, out);
  return out;
}
const current = () => analyse(S.day, S.saved);

// ---------- 时间维度：今日 / 近3天 / 近7天 / 近30天 ----------
// 明细（可点进会话）只来自快照里的最近几天；更早的区间只有宿主发布的每日汇总（rollups）。
const RANGES = { "3d": 3, "7d": 7, "30d": 30 };
const rangeLabel = () => (S.range === "day" ? "今日" : `近 ${RANGES[S.range]} 天`);
function rangeDays() {
  const anchor = days()[0];
  if (!anchor) return S.day ? [S.day] : [];
  if (S.range === "day") return [S.day];
  const out = [];
  for (let i = 0; i < RANGES[S.range]; i++) out.push(shiftDay(anchor, -i));
  return out;
}
function rollupAgg() {
  const byDay = new Map((S.snap?.rollups || []).map((r) => [r.day, r]));
  const agg = { calls: 0, sessions: 0, hits: 0, issues: 0, by_rule: {}, by_agent: {}, by_model: {}, by_severity: {}, perDay: [], covered: 0 };
  for (const d of rangeDays()) {
    const r = byDay.get(d);
    agg.perDay.push([d, r?.hits || 0]);
    if (!r) continue;
    agg.covered++;
    agg.calls += r.calls || 0; agg.sessions += r.sessions || 0; agg.hits += r.hits || 0; agg.issues += r.issues || 0;
    const add = (dst, rows) => { for (const [k, n] of rows || []) dst[k] = (dst[k] || 0) + n; };
    add(agg.by_rule, r.by_rule); add(agg.by_agent, r.by_agent); add(agg.by_model, r.by_model); add(agg.by_severity, r.by_severity);
  }
  return agg;
}
const sortRows = (obj) => Object.entries(obj).sort((a, b) => b[1] - a[1]);
function rangeDetail() {
  const hits = [], sessById = new Map();
  for (const d of rangeDays()) {
    if (!dayData(d)) continue;
    const { sessions, hits: hs } = analyse(d, S.saved);
    for (const s of sessions) sessById.set(s.id, s);
    hits.push(...hs);
  }
  return { hits: filtered(hits), sessById };
}

// ---------- 渲染 ----------
function render() {
  renderTop();
  for (const t of ["dash", "sess", "issues", "rules", "export"]) $(t).classList.toggle("hidden", S.tab !== t);
  for (const b of document.querySelectorAll("#tabs button")) b.classList.toggle("on", b.dataset.tab === S.tab);
  if (S.tab === "dash") renderDash();
  if (S.tab === "sess") renderSess();
  if (S.tab === "issues") renderIssues();
  if (S.tab === "rules") renderRules();
  if (S.tab === "export") renderExport();
}

function renderTop() {
  const ds = days();
  if (!S.day || !ds.includes(S.day)) S.day = ds[0] || "";
  for (const b of document.querySelectorAll("#ranges button")) b.classList.toggle("on", b.dataset.val === S.range);
  const dayLbl = $("day")?.parentElement;
  if (dayLbl) dayLbl.style.display = S.range === "day" ? "" : "none";
  $("day").innerHTML = ds.length ? ds.map((d) => `<option ${d === S.day ? "selected" : ""}>${d}</option>`).join("") : "<option>无数据</option>";
  $("status").textContent = S.snap
    ? `快照 ${formatLocal(S.snap.updatedAt)} · 最近 ${S.snap.days.length} 天共 ${S.snap.days.reduce((a, d) => a + (d.calls || 0), 0)} 次调用 · ${Math.round((S.snap.bytes || 0) / 1024)} KB`
    : (S.opts ? "还没有数据" : "连接 Magpie…");
  const b = [];
  if (S.error) b.push(`<div class="banner bad">${esc(S.error)}</div>`);
  if (S.snapStale) b.push(`<div class="banner">规则已保存，Magpie 正在重启插件宿主，通常几秒内会按新规则重新发布快照（若没有，下一次网关调用或重新打开本页时发布）；在此之前先用页面里已有的数据。</div>`);
  if (S.opts && !S.snap) b.push(`<div class="banner">还没有采集到调用。让 Claude Code / Codex / Cursor 等经本机 Magpie 发起请求后，约 ${S.opts.publishSeconds || 90} 秒内这里会出现数据（首次快照只等 2 秒）。</div>`);
  if (S.note) b.push(`<div class="banner ${S.note.kind || ""}">${esc(S.note.text)}</div>`);
  $("banner").innerHTML = b.join("");
}

function bars(title, rows, key) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const body = rows.length ? rows.slice(0, 12).map(([k, n]) =>
    `<div class="row ${S.filter[key] === k ? "on" : ""}" data-act="filter" data-key="${key}" data-val="${esc(k)}" title="${esc(k)}">
      <span class="lbl">${esc(key === "severity" ? SEVERITY_LABEL[k] || k : k)}</span><span class="bar"><i style="width:${(n / max) * 100}%"></i></span><span class="n">${n}</span></div>`).join("")
    : `<div class="muted">无</div>`;
  return `<div class="card bars"><h3>${title}</h3>${body}</div>`;
}

function filtered(hits) {
  return hits.filter((h) => Object.entries(S.filter).every(([k, v]) => !v || h[k] === v));
}

function renderDash() {
  if (!S.snap) { $("dash").innerHTML = `<div class="empty">暂无数据</div>`; return; }
  if (S.range !== "day") return renderDashRange();
  const { sessions, hits, sum } = current();
  const fh = filtered(hits);
  const trend = days().slice().reverse().map((d) => [d, analyse(d, S.saved).hits.length]);
  const tmax = Math.max(1, ...trend.map((t) => t[1]));
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  const fl = Object.entries(S.filter).filter(([, v]) => v);
  $("dash").innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>会话</span><b>${sum.sessions}</b></div>
      <div class="kpi"><span>调用</span><b>${sum.calls}</b></div>
      <div class="kpi"><span>卡点</span><b>${sum.hits}</b></div>
      <div class="kpi"><span>有卡点的会话</span><b>${sum.sessions_with_hits}</b></div>
      <div class="kpi"><span>高危卡点</span><b>${hits.filter((h) => h.severity === "high").length}</b></div>
    </div>
    <div class="cols">
      <div class="card"><h3>按天（最近 ${trend.length} 天）</h3><div class="trend">${trend.map(([d, n]) =>
        `<div data-act="day" data-val="${d}" class="${d === S.day ? "on" : ""}"><i style="height:${(n / tmax) * 50 + 2}px"></i>${n}<br>${d.slice(5)}</div>`).join("")}</div></div>
      ${bars("按规则", sum.by_rule.map(([k, n]) => [k, n]), "rule_name")}
      ${bars("按 Agent", sum.by_agent, "agent")}
      ${bars("按模型", sum.by_model, "model")}
      ${bars("按严重级别", sum.by_severity, "severity")}
    </div>
    <div class="card">
      <div class="filters"><h3 style="margin:0">卡点明细（${fh.length}）</h3>
        ${fl.map(([k, v]) => `<span class="pill" data-act="unfilter" data-key="${k}" title="点击去掉筛选">${esc(k === "severity" ? SEVERITY_LABEL[v] : v)} ✕</span>`).join("")}</div>
      ${fh.length ? `<table><tr><th>时间</th><th>级别</th><th>规则</th><th>Agent</th><th>模型</th><th>会话</th><th>证据</th></tr>
        ${fh.slice(0, 400).map((h) => `<tr class="click" data-act="open" data-sess="${esc(h.session)}" data-msg="${h.msg ?? ""}">
          <td class="mono">${formatLocal(h.ts).slice(11)}</td><td><span class="sev ${h.severity}">${SEVERITY_LABEL[h.severity] || h.severity}</span></td>
          <td>${esc(h.rule_name)}</td><td>${esc(h.agent)}</td><td class="mono">${esc(h.model)}</td>
          <td>${esc(sessById.get(h.session)?.title || h.session)}</td><td class="ev">${esc(h.evidence)}</td></tr>`).join("")}</table>`
        : `<div class="empty">这一天没有命中的卡点${fl.length ? "（或被筛选掉了）" : ""} 🎉</div>`}
    </div>`;
}

// 「问题」视图：确定性聚合成的问题片段（一个片段 = 多个相关信号的证据链），按严重级别与返工量排序
function renderIssues() {
  if (!S.snap) { $("issues").innerHTML = `<div class="empty">暂无数据</div>`; return; }
  const { sessions, hits } = current();
  const issues = groupIssues(hits, sessions);
  const sessById = new Map(sessions.map((s) => [s.id, s]));
  $("issues").innerHTML = issues.length ? issues.slice(0, 60).map((is) => {
    const s = sessById.get(is.session) || {};
    const imp = [];
    if (is.impact.rework_operations) imp.push(`返工操作 ${is.impact.rework_operations}`);
    if (is.impact.tokens_in_window) imp.push(`窗口消耗 ${is.impact.tokens_in_window.toLocaleString()} token`);
    if (is.impact.recovered != null) imp.push(is.impact.recovered ? "已恢复" : "窗口内未恢复");
    return `<div class="card issue">
      <div class="ihd"><span class="sev ${is.severity}">${SEVERITY_LABEL[is.severity] || is.severity}</span>
        <b>${esc(is.title)}</b><span class="sub">置信 ${(is.confidence * 100).toFixed(0)}%</span><span class="spacer"></span>
        <button class="link" data-act="open" data-sess="${esc(is.session)}" data-msg="${is.msg_from ?? ""}">查看会话 →</button></div>
      <div class="sub">${esc(is.agent)} · ${esc(s.title || is.session)} · ${formatLocal(is.start_ts).slice(5, 16)} · 消息 #${is.msg_from ?? "?"}–#${is.msg_to ?? "?"}
        ${imp.length ? " · " + imp.join(" · ") : ""}</div>
      <div class="sigrow">${is.rules.map((r) => `<span class="pill">${esc(r)}</span>`).join("")}</div>
      <ol class="evchain">${is.evidence.map((e) => `<li><b>${esc(e.rule)}</b>${e.msg != null ? ` <span class="mono">#${e.msg}</span>` : ""}：${esc(e.text)}</li>`).join("")}</ol>
      <div class="sub">根因假设：<span class="mono">${esc(is.root_cause.category)}</span>（${esc(is.root_cause.status)}，待人工/LLM 确认）</div>
    </div>`;
  }).join("") : `<div class="card"><div class="empty">这一天没有聚合出问题片段 🎉</div></div>`;
}

// 区间模式：KPI/趋势/分布来自宿主发布的每日汇总（含导入的历史），明细表只含快照内的最近几天
function renderDashRange() {
  const agg = rollupAgg();
  const { hits, sessById } = rangeDetail();
  const tmax = Math.max(1, ...agg.perDay.map((t) => t[1]));
  const trend = agg.perDay.slice().reverse();
  const fl = Object.entries(S.filter).filter(([, v]) => v);
  const snapDays = new Set(days());
  const uncovered = rangeDays().filter((d) => !snapDays.has(d)).length;
  const n = rangeLabel();
  $("dash").innerHTML = `
    <div class="kpis">
      <div class="kpi"><span>${n}会话</span><b>${agg.sessions}</b></div>
      <div class="kpi"><span>${n}调用</span><b>${agg.calls}</b></div>
      <div class="kpi"><span>${n}卡点</span><b>${agg.hits}</b></div>
      <div class="kpi"><span>${n}问题片段</span><b>${agg.issues}</b></div>
      <div class="kpi"><span>有数据的天</span><b>${agg.covered}/${rangeDays().length}</b></div>
      <div class="kpi"><span>高危卡点（${n}）</span><b>${agg.by_severity.high || 0}</b></div>
    </div>
    <div class="cols">
      <div class="card"><h3>按天（${n}）</h3><div class="trend">${trend.map(([d, hn]) =>
        `<div data-act="dayzoom" data-val="${d}" class="${d === S.day ? "on" : ""}" title="点这天回到今日视图"><i style="height:${(hn / tmax) * 50 + 2}px"></i>${hn}<br>${d.slice(5)}</div>`).join("")}</div></div>
      ${bars("按规则", sortRows(agg.by_rule), "rule_name")}
      ${bars("按 Agent", sortRows(agg.by_agent), "agent")}
      ${bars("按模型", sortRows(agg.by_model), "model")}
      ${bars("按严重级别", sortRows(agg.by_severity), "severity")}
    </div>
    <div class="card">
      <div class="filters"><h3 style="margin:0">卡点明细（${hits.length}，仅快照内的最近 ${days().length} 天）</h3>
        ${fl.map(([k, v]) => `<span class="pill" data-act="unfilter" data-key="${k}" title="点击去掉筛选">${esc(k === "severity" ? SEVERITY_LABEL[v] : v)} ✕</span>`).join("")}</div>
      ${uncovered ? `<div class="sub" style="margin-bottom:6px">区间里有 ${uncovered} 天超出快照明细范围，只计入上方汇总；这些天的完整明细用「导出」页的区间导出或命令行 export-range。</div>` : ""}
      ${hits.length ? `<table><tr><th>时间</th><th>级别</th><th>规则</th><th>Agent</th><th>模型</th><th>会话</th><th>证据</th></tr>
        ${hits.slice(0, 400).map((h) => `<tr class="click" data-act="open" data-sess="${esc(h.session)}" data-msg="${h.msg ?? ""}">
          <td class="mono">${formatLocal(h.ts).slice(5, 16)}</td><td><span class="sev ${h.severity}">${SEVERITY_LABEL[h.severity] || h.severity}</span></td>
          <td>${esc(h.rule_name)}</td><td>${esc(h.agent)}</td><td class="mono">${esc(h.model)}</td>
          <td>${esc(sessById.get(h.session)?.title || h.session)}</td><td class="ev">${esc(h.evidence)}</td></tr>`).join("")}</table>`
        : `<div class="empty">这个区间没有命中明细${fl.length ? "（或被筛选掉了）" : ""}</div>`}
    </div>`;
}

function renderSess() {
  if (!S.snap) { $("sess").innerHTML = `<div class="empty">暂无数据</div>`; return; }
  const { sessions, hits } = current();
  const hitsBy = new Map();
  for (const h of hits) { if (!hitsBy.has(h.session)) hitsBy.set(h.session, []); hitsBy.get(h.session).push(h); }
  const list = sessions.slice().sort((a, b) => (hitsBy.get(b.id)?.length || 0) - (hitsBy.get(a.id)?.length || 0) || b.start - a.start);
  if (!S.session || !sessions.find((s) => s.id === S.session)) S.session = list[0]?.id || null;
  const s = sessions.find((x) => x.id === S.session);
  const sh = (s && hitsBy.get(s.id)) || [];
  const byMsg = new Map();
  for (const h of sh) if (h.msg != null) { if (!byMsg.has(h.msg)) byMsg.set(h.msg, []); byMsg.get(h.msg).push(h); }
  for (const h of sh) for (const m of h.msgs || []) if (m !== h.msg) { if (!byMsg.has(m)) byMsg.set(m, []); if (!byMsg.get(m).includes(h)) byMsg.get(m).push(h); }
  const dur = (ms) => ms >= 60000 ? `${(ms / 60000).toFixed(1)} 分钟` : `${Math.round(ms / 1000)} 秒`;
  $("sess").innerHTML = `<div class="split">
    <div class="card slist">${list.map((x) => `<div class="sitem ${x.id === S.session ? "on" : ""}" data-act="sel" data-sess="${esc(x.id)}">
      <div class="t">${esc(x.title || "(无标题)")}</div>
      <div class="sub">${esc(x.agent)} · ${x.calls.length} 次调用 · ${formatLocal(x.start).slice(11, 16)} · ${dur(x.end - x.start)}
      ${hitsBy.get(x.id)?.length ? ` · <b style="color:var(--bad)">${hitsBy.get(x.id).length} 个卡点</b>` : ""}</div></div>`).join("") || `<div class="empty">无会话</div>`}</div>
    <div class="card tl">${s ? `
      <h3>${esc(s.title || s.id)}</h3>
      <div class="sub">${esc(s.agent)} · ${s.models.map((m) => `<span class="pill mono">${esc(m)}</span>`).join("")} ${s.cwd ? "· " + esc(s.cwd) : ""} · ${formatLocal(s.start)} → ${formatLocal(s.end).slice(11)}
        · 输入 token 峰值 ${Math.max(0, ...s.calls.map((c) => c.in_tok || 0)).toLocaleString()} · 历史被裁剪 ${s.rewrites.length} 次</div>
      ${(() => { const st = s.stats || {}; const fv = st.first_verify_pass;
        return `<div class="sub">任务 <span class="pill">${esc(st.task_type || "其他")}</span> · 重复失败率 <b>${Math.round((st.repeat_fail_ratio || 0) * 100)}%</b>
        · 首次验证 ${fv == null ? "未验" : fv ? "✅ 通过" : "❌ 失败"} · 纠偏 ${st.corrections || 0} 次
        · 时间构成：活跃 ${Math.round((st.active_ms || 0) / 1000)}s + 间隙 ${Math.round((st.idle_ms || 0) / 1000)}s（用户思考/本地处理）</div>`; })()}
      <div style="margin:8px 0">${sh.length ? sh.map((h) => `<div><span class="sev ${h.severity}">${SEVERITY_LABEL[h.severity]}</span> <b>${esc(h.rule_name)}</b>
        ${h.msg != null ? `<button class="link" data-act="jump" data-msg="${h.msg}">#${h.msg} 定位</button>` : ""} <span class="muted">${esc(h.evidence)}</span></div>`).join("") : `<span class="muted">这个会话没有卡点</span>`}</div>
      ${s.messages.map((m, i) => msgHtml(m, i, byMsg.get(i), s)).join("")}` : `<div class="empty">选择左侧会话</div>`}</div></div>`;
  if (S.focusMsg != null) {
    const el = document.getElementById("m" + S.focusMsg);
    el?.scrollIntoView?.({ block: "center" });
    S.focusMsg = null;
  }
}

function msgHtml(m, i, mh, s) {
  if (m.role === "system") return "";
  const roleLbl = { user: "用户", assistant: "助手", tool: "工具结果" }[m.role] || m.role;
  const call = s.calls[m.call] || {};
  let body = "";
  const text = m.role === "user" ? stripInjected(m.text) : m.text;
  if (text) body += `<pre>${esc(text)}</pre>`;
  for (const c of m.calls || []) {
    body += `<div class="mono">🔧 <b>${esc(c.name)}</b> ${c.cmd ? esc(c.cmd) : ""}${(c.files || []).map((f) => ` <span class="pill">${esc(f.path)} −${f.del} +${f.add}</span>`).join("")}</div>`;
  }
  for (const r of m.results || []) body += `<pre class="${r.is_error ? "err" : ""}">${esc(r.text)}</pre>`;
  return `<div class="m ${m.role} ${mh ? "hit" : ""}" id="m${i}">
    <div class="h">#${i} ${roleLbl} · ${formatLocal(m.ts).slice(11)} · 第 ${m.call + 1} 次请求 ${esc(call.model || "")}${m.from_reply ? " · 最终回复" : ""}
      ${call.in_tok ? ` · in ${call.in_tok.toLocaleString()} / out ${(call.out_tok || 0).toLocaleString()}` : ""}${call.latency_ms ? ` · ${(call.latency_ms / 1000).toFixed(1)}s` : ""}${call.ok === false ? ` · <span style="color:var(--bad)">调用失败</span>` : ""}</div>
    ${body}${(mh || []).map((h) => `<span class="tag">${esc(h.rule_name)}</span>`).join("")}</div>`;
}

// ---------- 规则编辑器 ----------
function fieldHtml(ri, spec, v) {
  const id = `f-${ri}-${spec.key}`, a = `data-rule="${ri}" data-key="${spec.key}" data-kind="${spec.kind}" id="${id}"`;
  let inp;
  if (spec.kind === "bool") inp = `<select ${a}><option value="true" ${v ? "selected" : ""}>是</option><option value="false" ${!v ? "selected" : ""}>否</option></select>`;
  else if (spec.kind === "enum") inp = `<select ${a}>${spec.help.split("|").map((o) => `<option ${o === v ? "selected" : ""}>${o}</option>`).join("")}</select>`;
  else if (spec.kind === "list") inp = `<textarea rows="${Math.min(6, Math.max(2, (v || []).length))}" ${a}>${esc((v || []).join("\n"))}</textarea><div class="hint">一行一个</div>`;
  else inp = `<input ${a} value="${esc(v)}" ${spec.kind === "int" || spec.kind === "float" ? `inputmode="decimal"` : ""}>`;
  return `<div class="field"><label for="${id}">${esc(spec.label)}</label>${inp}</div>`;
}

function renderRules() {
  const d = S.draft || (S.draft = clone(S.saved));
  const pv = S.preview;
  const typeOpts = Object.entries(RULE_TYPES).map(([k, t]) => `<option value="${k}">${esc(t.label)}</option>`).join("");
  const st = d.settings;
  $("rules").innerHTML = `
    <div class="card"><div class="top" style="margin:0">
      <button class="primary" data-act="save" ${S.dirty ? "" : "disabled"}>保存规则</button>
      <button data-act="preview">预览（${esc(S.day || "无数据")}）</button>
      <button data-act="discard" ${S.dirty ? "" : "disabled"}>放弃修改</button>
      <button class="danger" data-act="reset">恢复默认规则</button>
      <span class="spacer"></span>
      <select id="newType">${typeOpts}</select><button data-act="add">+ 添加规则</button>
      <span class="msg ${S.dirty ? "bad" : "ok"}">${S.dirty ? "有未保存的修改" : "已与 Magpie 中保存的一致"}</span>
    </div>
    ${pv ? `<div style="margin-top:8px"><b>预览</b>：草稿规则在 ${esc(pv.day)} 命中 <b>${pv.after}</b> 个（已保存规则 ${pv.before} 个）
      ${pv.errors.length ? `<div class="msg bad">${esc(pv.errors.join("；"))}</div>` : ""}
      <table style="margin-top:4px"><tr><th>规则</th><th>已保存</th><th>草稿</th><th>变化</th></tr>${pv.rows.map((r) => `<tr><td>${esc(r.name)}</td><td>${r.before}</td><td>${r.after}</td>
      <td class="delta ${r.after > r.before ? "up" : r.after < r.before ? "down" : ""}">${r.after - r.before > 0 ? "+" : ""}${r.after - r.before}</td></tr>`).join("")}</table></div>` : ""}
    </div>
    ${d.rules.map((r, ri) => {
      const t = RULE_TYPES[r.type] || { label: r.type, params: [], desc: "" };
      const open = S.open[r.id];
      return `<div class="rule ${r.enabled === false ? "off" : ""}">
        <div class="hd" data-act="toggleOpen" data-id="${esc(r.id)}">
          <input type="checkbox" data-act="enable" data-rule="${ri}" ${r.enabled !== false ? "checked" : ""} title="启用/停用">
          <span class="sev ${r.severity}">${SEVERITY_LABEL[r.severity]}</span>
          <span class="nm">${esc(r.name)}</span><span class="sub">${esc(t.label)} · ${esc(r.id)}</span>
          <span class="spacer"></span>
          ${pv ? `<span class="sub">预览命中 ${pv.rows.find((x) => x.id === r.id)?.after ?? 0}</span>` : ""}
          <button data-act="dup" data-rule="${ri}">复制</button><button class="danger" data-act="del" data-rule="${ri}">删除</button>
          <span>${open ? "▾" : "▸"}</span></div>
        ${open ? `<div class="bd"><div class="sub" style="margin-bottom:6px">${esc(t.desc)}</div><div class="grid">
          <div class="field"><label>名称</label><input data-rule="${ri}" data-top="name" value="${esc(r.name)}"></div>
          <div class="field"><label>ID（唯一）</label><input data-rule="${ri}" data-top="id" value="${esc(r.id)}"></div>
          <div class="field"><label>严重级别</label><select data-rule="${ri}" data-top="severity">${SEVERITIES.map((s) => `<option value="${s}" ${s === r.severity ? "selected" : ""}>${SEVERITY_LABEL[s]}</option>`).join("")}</select></div>
          ${t.params.map((p) => fieldHtml(ri, p, r.params?.[p.key])).join("")}
          <div class="field" style="grid-column:1/-1"><label>说明</label><input data-rule="${ri}" data-top="description" value="${esc(r.description || "")}"></div>
        </div></div>` : ""}</div>`;
    }).join("")}
    <div class="card"><h3>全局设置（工具分类与错误识别）</h3><div class="grid">
      ${[["read_tools", "只读工具"], ["edit_tools", "编辑工具"], ["shell_tools", "命令行工具"], ["error_patterns", "工具输出的错误模式（正则）"]].map(([k, l]) =>
        `<div class="field"><label>${l}</label><textarea rows="5" data-set="${k}" data-kind="list">${esc(st[k].join("\n"))}</textarea><div class="hint">一行一个</div></div>`).join("")}
      <div class="field"><label>只读命令（正则，命中则 shell 调用算「只读」）</label><textarea rows="3" data-set="readonly_cmd_regex">${esc(st.readonly_cmd_regex)}</textarea></div>
      <div class="field"><label>只读工具的输出也匹配错误模式</label><select data-set="error_patterns_on_read_tools" data-kind="bool"><option value="false">否</option><option value="true" ${st.error_patterns_on_read_tools ? "selected" : ""}>是</option></select></div>
    </div></div>
    <div class="card"><h3>原始 JSON</h3><textarea id="rawRules" rows="10">${esc(JSON.stringify(d, null, 2))}</textarea>
      <button data-act="applyRaw" style="margin-top:6px">用上面的 JSON 替换草稿</button></div>`;
}

function setDirty() { S.dirty = JSON.stringify(S.draft) !== JSON.stringify(S.saved); S.preview = null; }

function onRuleInput(el) {
  const d = S.draft;
  if (el.dataset.set) {
    const k = el.dataset.set;
    d.settings[k] = el.dataset.kind === "list" ? el.value.split("\n").map((s) => s.trim()).filter(Boolean) : el.dataset.kind === "bool" ? el.value === "true" : el.value;
  } else if (el.dataset.rule != null && (el.dataset.key || el.dataset.top)) {
    const r = d.rules[+el.dataset.rule];
    if (el.dataset.top) {
      if (el.dataset.top === "id" && S.open[r.id]) { delete S.open[r.id]; S.open[el.value] = true; }
      r[el.dataset.top] = el.value;
    } else {
      const k = el.dataset.kind;
      r.params[el.dataset.key] = k === "list" ? el.value.split("\n").map((s) => s.trim()).filter(Boolean)
        : k === "bool" ? el.value === "true" : k === "int" || k === "float" ? (el.value.trim() === "" || isNaN(+el.value) ? el.value : +el.value) : el.value;
    }
  } else return false;
  setDirty();
  const raw = $("rawRules"); if (raw) raw.value = JSON.stringify(d, null, 2);
  const m = document.querySelector("#rules .msg"); if (m) { m.className = "msg bad"; m.textContent = "有未保存的修改"; }
  for (const b of document.querySelectorAll('#rules [data-act="save"], #rules [data-act="discard"]')) b.disabled = !S.dirty;
  return true;
}

function preview() {
  const { cfg, errors } = validateRules(S.draft);
  const before = analyse(S.day, S.saved).hits;
  const after = errors.length ? [] : analyse(S.day, cfg).hits;
  const ids = [...new Set([...S.draft.rules.map((r) => r.id), ...S.saved.rules.map((r) => r.id)])];
  const nm = (id) => (S.draft.rules.find((r) => r.id === id) || S.saved.rules.find((r) => r.id === id))?.name || id;
  S.preview = { day: S.day, errors, before: before.length, after: after.length,
    rows: ids.map((id) => ({ id, name: nm(id), before: before.filter((h) => h.rule === id).length, after: after.filter((h) => h.rule === id).length })) };
}

async function saveRules() {
  const { cfg, errors } = validateRules(S.draft);
  if (errors.length) { S.note = { kind: "bad", text: "规则有错误，未保存：" + errors.join("；") }; return; }
  try {
    const cur = (await magpie.options.get()) || {};
    const { _status, ...rest } = cur;   // 快照可能很大（请求体上限 64 KiB），保存时去掉，宿主会重新发布
    await magpie.options.set({ ...rest, rules: cfg });
    S.saved = clone(cfg); S.draft = clone(cfg); S.dirty = false; S.preview = null;
    S.snapStale = !!S.snap;
    S.note = { kind: "ok", text: `已保存 ${cfg.rules.length} 条规则到 Magpie 插件配置（plugins.json）。` };
  } catch (e) { S.note = { kind: "bad", text: "保存失败：" + (e?.message || e) }; }
}

// ---------- 导出 ----------
function exportPayload(day) {
  const d = dayData(day);
  const { sessions, hits, sum } = analyse(day, S.saved);
  return { day, exportedAt: Date.now(), source: "magpie-stuck 页面快照（文本已截断；完整数据用「写到本机文件」）", rules: S.saved, summary: sum, hits, sessions, calls: d?.calls };
}
function hitsCsv(day) {
  const { hits } = analyse(day, S.saved);
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  return ["时间,级别,规则,Agent,模型,会话,证据", ...hits.map((h) => [formatLocal(h.ts), SEVERITY_LABEL[h.severity], h.rule_name, h.agent, h.model, h.session, h.evidence].map(q).join(","))].join("\n");
}
function renderExport() {
  const le = S.snap?.stats?.lastExport;
  $("export").innerHTML = `<div class="card"><h3>导出 ${esc(S.day || "")}</h3>
    <p class="sub">导出当天所有会话、命中的卡点和当前规则（含导入的历史会话，去重后）。iframe 沙箱可能拦截下载，此时用「复制」或「写到本机文件」。</p>
    <div class="top"><button class="primary" data-act="dl" data-fmt="json">下载 JSON</button><button data-act="dl" data-fmt="csv">下载卡点 CSV</button>
      <button data-act="copy">复制 JSON</button><button data-act="toFile">写到本机文件（完整数据）</button>
      <button data-act="toFileRange">区间 JSON（宿主完整数据）</button></div>
    <p class="sub">「区间 JSON」按顶部当前区间（${rangeLabel()}）导出，由插件宿主合并捕获与导入历史后写到本机 exports/magpie-stuck-起_to_止.json。</p>
    ${le ? `<div class="sub">上次写出：${esc(le.day)} → <span class="mono">${esc(le.file || le.error || "")}</span>（${formatLocal(le.at)}）</div>` : ""}
    ${S.snap?.dir ? `<div class="sub">数据目录：<span class="mono">${esc(S.snap.dir)}</span>；命令行导出：<span class="mono">node scripts/export-day.mjs ${esc(S.day)}</span></div>` : ""}
    <textarea id="exportText" rows="14" readonly style="margin-top:8px">${esc(S.day ? JSON.stringify(exportPayload(S.day), null, 1).slice(0, 200000) : "")}</textarea></div>`;
}
function download(name, text, type) {
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement("a"); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    S.note = { kind: "ok", text: `已发起下载 ${name}（若没有反应，说明沙箱拦截了下载，请用「复制」或「写到本机文件」）` };
  } catch (e) { S.note = { kind: "bad", text: "下载被拦截：" + e.message }; }
}
async function exportToFile() {
  try {
    const cur = (await magpie.options.get()) || {};
    const { _status, ...rest } = cur;
    await magpie.options.set({ ...rest, _export: { day: S.day, nonce: Date.now() } });
    S.snapStale = !!S.snap;
    S.note = { kind: "ok", text: `已请求导出 ${S.day}。插件宿主通常几秒内写出到数据目录的 exports/magpie-stuck-${S.day}.json（若宿主没在运行，则在下一次网关调用或重新打开本页时写出），完成后本页会显示文件路径。` };
  } catch (e) { S.note = { kind: "bad", text: "请求失败：" + (e?.message || e) }; }
}
// 区间导出：让宿主把（捕获 + 导入合并、会话级去重后的）完整数据写到本机 exports/
async function exportToFileRange() {
  const ds = rangeDays();
  if (ds.length < 2) { S.note = { kind: "bad", text: "请先切到一个多天区间" }; return; }
  const from = ds[ds.length - 1], to = ds[0];
  try {
    const cur = (await magpie.options.get()) || {};
    const { _status, ...rest } = cur;
    await magpie.options.set({ ...rest, _export: { from, to, nonce: Date.now() } });
    S.snapStale = !!S.snap;
    S.note = { kind: "ok", text: `已请求导出 ${from} ~ ${to}（含导入的历史会话）。宿主几秒内写到数据目录的 exports/magpie-stuck-${from}_to_${to}.json。` };
  } catch (e) { S.note = { kind: "bad", text: "请求失败：" + (e?.message || e) }; }
}

// ---------- 事件 ----------
async function onClick(e) {
  const el = e.target.closest?.("[data-act],[data-tab]");
  if (!el) return;
  if (el.dataset.tab) { S.tab = el.dataset.tab; render(); return; }
  const act = el.dataset.act, ri = el.dataset.rule != null ? +el.dataset.rule : null;
  switch (act) {
    case "refresh": S.note = null; await load(); break;
    case "range": S.range = el.dataset.val; break;
    case "dayzoom": S.range = "day"; S.day = el.dataset.val; break;
    case "filter": S.filter[el.dataset.key] = S.filter[el.dataset.key] === el.dataset.val ? "" : el.dataset.val; break;
    case "unfilter": delete S.filter[el.dataset.key]; break;
    case "day": S.day = el.dataset.val; break;
    case "open": S.tab = "sess"; S.session = el.dataset.sess; S.focusMsg = el.dataset.msg === "" ? null : +el.dataset.msg; break;
    case "sel": S.session = el.dataset.sess; break;
    case "jump": S.focusMsg = +el.dataset.msg; break;
    case "toggleOpen": if (e.target.closest("button,input")) return; S.open[el.dataset.id] = !S.open[el.dataset.id]; break;
    case "enable": S.draft.rules[ri].enabled = el.checked; setDirty(); break;
    case "del": if (typeof confirm === "function" && !confirm(`删除规则「${S.draft.rules[ri].name}」？（保存后生效）`)) return; S.draft.rules.splice(ri, 1); setDirty(); break;
    case "dup": { const r = clone(S.draft.rules[ri]); r.id = r.id + "-copy-" + Date.now().toString(36).slice(-4); r.name += "（副本）"; S.draft.rules.splice(ri + 1, 0, r); S.open[r.id] = true; setDirty(); break; }
    case "add": {
      const type = $("newType").value, t = RULE_TYPES[type], params = {};
      for (const p of t.params) params[p.key] = clone(p.default);
      const r = { id: `${type.replace(/_/g, "-")}-${Date.now().toString(36).slice(-5)}`, name: t.label + "（新）", type, enabled: true, severity: "medium", params, description: t.desc };
      S.draft.rules.push(r); S.open[r.id] = true; setDirty(); break;
    }
    case "discard": S.draft = clone(S.saved); setDirty(); break;
    case "reset": if (typeof confirm === "function" && !confirm("把草稿恢复为 15 条默认规则？（保存后生效）")) return; S.draft = defaultRules(); setDirty(); break;
    case "applyRaw":
      try { const v = JSON.parse($("rawRules").value); const { cfg, errors } = validateRules(v); if (errors.length) throw new Error(errors.join("；")); S.draft = cfg; setDirty(); S.note = null; }
      catch (err) { S.note = { kind: "bad", text: "JSON 无效：" + err.message }; }
      break;
    case "preview": preview(); break;
    case "save": await saveRules(); break;
    case "dl": if (el.dataset.fmt === "csv") download(`magpie-stuck-${S.day}.csv`, "\ufeff" + hitsCsv(S.day), "text/csv"); else download(`magpie-stuck-${S.day}.json`, JSON.stringify(exportPayload(S.day), null, 1), "application/json"); break;
    case "copy": { const t = $("exportText"); t.select?.(); let ok = false; try { ok = document.execCommand("copy"); } catch {} S.note = ok ? { kind: "ok", text: "已复制到剪贴板" } : { text: "已选中文本框内容，请按 Ctrl/Cmd+C 复制" }; break; }
    case "toFile": await exportToFile(); break;
    case "toFileRange": await exportToFileRange(); break;
    default: return;
  }
  render();
}

async function main() {
  if (!HAS_BRIDGE) { $("status").textContent = "这个页面需要在 Magpie App 的「插件 → 卡点」里打开"; return; }
  try { await magpie.ready; } catch {}
  document.addEventListener("click", (e) => onClick(e).catch((err) => { S.note = { kind: "bad", text: String(err?.message || err) }; render(); }));
  document.addEventListener("input", (e) => { if (e.target.closest?.("#rules")) onRuleInput(e.target); });
  document.addEventListener("change", (e) => {
    if (e.target.id === "day") { S.day = e.target.value; S.preview = null; render(); return; }
    if (e.target.closest?.("#rules") && e.target.tagName === "SELECT" && onRuleInput(e.target)) render();
  });
  await load();
  render();
  setInterval(async () => {
    const before = S.snap?.updatedAt;
    await load();
    // 编辑规则时不整页重画，免得打断输入
    if (S.snap?.updatedAt !== before && S.tab !== "rules") render(); else renderTop();
  }, 5000);
}

main();
