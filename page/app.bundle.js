// 自动生成，勿手改：node scripts/build-page.mjs
(function () {
"use strict";
// magpie-stuck 共享核心：协议归一化、会话精简、声明式卡点规则引擎。
// 没有 Node/Bun 依赖：stuck.hooks.js（Bun 宿主）和 page/（App 内沙箱页面）共用。
// 规则是 JSON（type + params），不执行任意代码。

// ---------- 全局设置（工具分类、错误识别） ----------
const DEFAULT_SETTINGS = {
  read_tools: ["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead", "TodoRead",
    "read_file", "grep_search", "file_search", "codebase_search", "list_dir", "search_files",
    "list_files", "read", "grep", "glob", "view", "find", "search", "fetch", "ReadFile", "ListDir"],
  edit_tools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "str_replace_editor", "str_replace_based_edit_tool",
    "apply_patch", "edit_file", "write_file", "search_replace", "create_file", "replace_in_file",
    "write_to_file", "edit", "write", "StrReplace", "Delete", "delete_file"],
  shell_tools: ["Bash", "run_terminal_cmd", "shell", "exec_command", "local_shell", "execute_command",
    "run_command", "terminal", "bash", "Shell", "container.exec"],
  readonly_cmd_regex: "^\\s*(cat|ls|ll|tree|pwd|head|tail|less|wc|grep|rg|ag|find|fd|sed\\s+-n|awk|which|file|stat|du|echo|" +
    "git\\s+(status|log|diff|show|branch|blame|grep)|python3?\\s+-c\\s+['\"]?import\\s|nl)\\b",
  error_patterns: ["exit code[:\\s]+[1-9]\\d*", "exit status [1-9]", "exited with (code )?[1-9]",
    "Traceback \\(most recent call last\\)", "(^|\\n)\\s*\\w*Error: ", "command not found",
    "<tool_use_error>", "\\bFAILED\\b", "No such file or directory", "npm ERR!",
    "BUILD FAILURE", "compilation failed", "cannot find symbol", "\\bpanic: ",
    "error\\[E\\d+\\]", "(^|\\n)error: ", "\\d+ failed\\b", "String to replace not found",
    "old_string .*not found|not unique"],
  error_patterns_on_read_tools: false,
};

const SEVERITIES = ["low", "medium", "high"];
const SEVERITY_LABEL = { low: "低", medium: "中", high: "高" };

// 跨规则共享的启发式常量：验证命令、人工纠偏关键词（会话指标与新规则共用同一套）
const VERIFY_CMD_RE_STR = "test|pytest|jest|vitest|go |cargo|mvn|gradle|make|npm|pnpm|yarn|tsc|lint|build";
const CORRECTION_KEYWORDS = ["不对", "重来", "不是这个意思", "你又", "还是不行", "错了", "不是这样", "别改", "我说的是", "没让你", "搞错", "还是报错", "又错", "that's wrong", "not what i", "you broke", "still failing", "still not"];

const P = (key, label, kind, def, help = "") => ({ key, label, kind, default: def, help });
const RULE_TYPES = {
  tool_error_retry: { label: "工具调用失败重试", scope: "session",
    desc: "同一个工具连续报错（tool_result 带 is_error，或输出命中错误模式）。",
    params: [P("min_consecutive", "连续失败次数 ≥", "int", 3), P("tool_regex", "只看这些工具（正则，空=全部）", "str", "")] },
  command_repeat_fail: { label: "测试/编译反复失败", scope: "session",
    desc: "同一根因（错误签名相同，可以是不同命令）的失败链 ≥ N 次。",
    params: [P("min_failures", "失败次数 ≥", "int", 2), P("key_words", "命令取前 N 个词作为同一命令（0=整条）", "int", 3),
      P("cmd_regex", "只看匹配的命令（正则，空=全部）", "str", "test|pytest|jest|vitest|go |cargo|mvn|gradle|make|npm|pnpm|yarn|tsc|build|lint|python|node")] },
  edit_churn: { label: "打转（反复编辑）", scope: "session",
    desc: "同一文件同一区域被反复修改：后一次编辑的 old_string 与前一次的 new_string 有重叠行。",
    params: [P("min_edits", "同区域编辑次数 ≥", "int", 3), P("mode", "region=同区域 / file=同文件即可", "enum", "region", "region|file"),
      P("window_msgs", "只统计相邻 N 条消息内（0=不限）", "int", 0)] },
  rewrite: { label: "推翻（大面积删除/重写）", scope: "session",
    desc: "单次删除很多行，或会话累计删除/新增比过高，或 assistant 说要换方案。",
    params: [P("single_min_deleted", "单次编辑删除行数 ≥", "int", 60), P("total_min_deleted", "会话累计删除行数 ≥", "int", 120),
      P("ratio", "删除/新增 ≥", "float", 0.6),
      P("keywords", "assistant 话术关键词", "list", ["换个思路", "换一种方案", "换个方案", "推倒重来", "重写", "回滚", "start over", "different approach", "rewrite", "revert"])] },
  blind_exploration: { label: "盲目探索", scope: "session",
    desc: "连续很多轮只读文件/grep/ls，没有任何修改。",
    params: [P("min_turns", "连续只读轮数 ≥", "int", 8)] },
  repeated_work: { label: "重复劳动", scope: "session",
    desc: "重复读取相同内容、重复执行得到相同结果的命令（中间有编辑且结果变了算验证，不算）、或编辑后回到更早的内容（改了又改回去）。",
    params: [P("min_repeats", "同一目标重复次数 ≥", "int", 3),
      P("revert_overlap", "回退判定：内容签名重合度 ≥", "float", 0.6),
      P("check_reads", "检测重复读取", "bool", true), P("check_execs", "检测重复执行", "bool", true),
      P("check_reverts", "检测回退/翻转", "bool", true)] },
  no_progress_loop: { label: "无进展循环", scope: "session",
    desc: "一段时间内持续消耗调用，但错误签名不变（同一根因反复尝试）：既可能是盲试相同命令，也可能是「改了→同样报错」的修复循环。进展 = 出现新错误签名 / 错误消失。",
    params: [P("min_failed", "同一错误失败次数 ≥", "int", 3),
      P("max_err_sigs", "窗口内不同错误签名 ≤", "int", 1),
      P("report_recovery", "检测后续是否恢复", "bool", true)] },
  regression_rework: { label: "回归与返工", scope: "session",
    desc: "同一验证命令先前通过、经过代码修改后失败——新修改破坏了已验证的行为。",
    params: [P("cmd_regex", "验证命令（正则）", "str", "test|pytest|jest|vitest|go |cargo|mvn|gradle|make|npm|pnpm|yarn|tsc|lint"),
      P("require_edit_between", "通过→失败之间必须有代码修改", "bool", true)] },
  context_bloat: { label: "上下文膨胀", scope: "session",
    desc: "单次输入 token 突增、超过上限，或发生了压缩/历史被裁剪。",
    params: [P("ratio", "相邻两次输入 token 比 ≥", "float", 1.8), P("min_jump", "且增量 ≥", "int", 30000),
      P("max_input", "单次输入 token ≥（0=不检查）", "int", 150000),
      P("detect_rewrite", "历史被裁剪/压缩也算", "bool", true),
      P("keywords", "压缩提示词", "list", ["continued from a previous conversation", "summary of the conversation", "conversation summary", "/compact", "上下文已压缩"])] },
  user_correction: { label: "人工纠偏", scope: "session",
    desc: "用户消息里出现纠正/否定的说法。",
    params: [P("keywords", "关键词（包含即命中，不区分大小写）", "list", CORRECTION_KEYWORDS),
      P("regex", "正则（可选）", "list", [])] },
  done_without_evidence: { label: "完成声明缺验证", scope: "session",
    desc: "assistant 宣布完成，但最后一次代码修改之后没有成功运行过验证命令（implemented ≠ verified）；或验证仍在失败时宣布完成。纯问答/无代码会话不判。",
    params: [P("done_regex", "「完成」话术（正则）", "str", "已完成|完成了|搞定|已修复|修复了|已经实现|已实现|全部通过|all (tests )?pass|is now (working|fixed)|successfully (implemented|fixed|completed)|I'?ve (fixed|implemented|completed)|\\bdone\\b"),
      P("verify_regex", "验证命令（正则）", "str", VERIFY_CMD_RE_STR),
      P("blocked_regex", "「受阻」话术，命中则不判（正则）", "str", "无法|权限不够|没有权限|cannot access|no access|not available|blocked by")] },
  requirement_drift: { label: "需求偏离", scope: "session",
    desc: "确定性子集：用户要求只读/不要改仍然修改文件；同一纠偏说法反复出现；修改用户从未提及的文件（默认关，噪声较高）。",
    params: [P("constraint_regex", "只读/不要改 约束（正则）", "str", "只(要)?(分析|审查|看|读|讲解)|(不要|先别|别)(改|动|修改|写)|don'?t (change|modify|edit|touch)|read.?only|analysis only"),
      P("correction_regex", "纠偏说法（正则，用于重复纠偏计数）", "str", CORRECTION_KEYWORDS.join("|")),
      P("repeat_min", "同类纠偏次数 ≥", "int", 2),
      P("check_scope", "检测修改用户未提及的文件", "bool", false)] },
  model_switch: { label: "模型切换", scope: "session",
    desc: "同一会话中途换了模型（常说明前一个模型卡住了）。",
    params: [P("ignore_models_regex", "忽略这些模型（正则）", "str", "haiku|title|embed"), P("min_switches", "切换次数 ≥", "int", 1)] },
  premature_done: { label: "过早宣布完成", scope: "session",
    desc: "assistant 声称完成后，用户紧接着又提出修改或报问题。",
    params: [P("done_regex", "「完成」话术（正则）", "str", "已完成|完成了|搞定|已修复|修复了|已经实现|已实现|全部通过|all (tests )?pass|is now (working|fixed)|successfully (implemented|fixed|completed)|I'?ve (fixed|implemented|completed)|\\bdone\\b"),
      P("followup_regex", "随后用户消息（正则）", "str", "不对|还是|又|报错|错误|不行|没有|失败|bug|问题|修改|改一下|再|但是|error|fail|wrong|still|doesn'?t|not work|broken"),
      P("within_msgs", "在之后 N 条消息内", "int", 6)] },
  slow_costly: { label: "慢和贵", scope: "day",
    desc: "会话（或单次调用）的耗时/token 高于当天同组中位数的若干倍。",
    params: [P("metric", "指标", "enum", "latency_ms", "latency_ms|tokens|cost"), P("unit", "统计单位", "enum", "session", "session|call"),
      P("multiplier", "≥ 中位数 × ", "float", 3.0), P("min_samples", "样本数 ≥ 才比较", "int", 5),
      P("group_by", "按谁分组比较", "enum", "task_type", "agent|model|all|task_type")] },
  keyword: { label: "自定义关键词", scope: "session",
    desc: "在指定角色的消息里匹配关键词/正则（通用规则，可自己加）。",
    params: [P("roles", "角色（user / assistant / tool）", "list", ["user"]), P("keywords", "关键词", "list", []),
      P("regex", "正则", "list", []), P("min_count", "命中次数 ≥ 才报", "int", 1)] },
  threshold: { label: "自定义阈值", scope: "session",
    desc: "会话级指标超过阈值（通用规则）。",
    params: [P("metric", "指标", "enum", "tool_errors", "calls|tool_calls|tool_errors|edits|user_msgs|max_input_tokens|total_tokens|latency_ms|failed_calls"),
      P("value", "≥", "float", 10)] },
};

const clone = (x) => JSON.parse(JSON.stringify(x));
function mk(id, type, name, severity, params = {}) {
  const d = {};
  for (const p of RULE_TYPES[type].params) d[p.key] = clone(p.default);
  return { id, name, type, enabled: true, severity, params: { ...d, ...params }, description: RULE_TYPES[type].desc };
}

function defaultRules() {
  return { version: 1, settings: clone(DEFAULT_SETTINGS), rules: [
    mk("tool-error-retry", "tool_error_retry", "工具调用失败重试", "medium"),
    mk("cmd-repeat-fail", "command_repeat_fail", "测试/编译反复失败", "high"),
    mk("edit-churn", "edit_churn", "打转：同文件同区域反复编辑", "high"),
    mk("rewrite", "rewrite", "推翻：大面积删除/重写", "high"),
    mk("blind-explore", "blind_exploration", "盲目探索：只读不改", "medium"),
    mk("repeated-work", "repeated_work", "重复劳动：重复读取/执行/回退", "medium"),
    mk("no-progress-loop", "no_progress_loop", "无进展循环：同一错误反复尝试", "high"),
    mk("regression-rework", "regression_rework", "回归：修改弄坏先前通过的验证", "high"),
    mk("context-bloat", "context_bloat", "上下文膨胀/压缩", "low"),
    mk("user-correction", "user_correction", "人工纠偏", "high"),
    mk("model-switch", "model_switch", "模型切换", "low"),
    mk("done-without-evidence", "done_without_evidence", "完成声明缺验证", "high"),
    mk("requirement-drift", "requirement_drift", "需求偏离：约束违反/重复纠偏", "medium"),
    mk("slow-costly", "slow_costly", "慢和贵（耗时）", "low"),
    // 网关钩子拿不到 Magpie 计算的费用，第二条默认按 token 量比较（见 README）
    mk("slow-costly-cost", "slow_costly", "慢和贵（token 花费）", "low", { metric: "tokens" }),
  ] };
}

function tryRegex(pat, flags, errs, where) {
  try { new RegExp(pat, flags); return true; } catch (e) { errs.push(`${where}的正则无效：${pat}（${e.message}）`); return false; }
}

// 返回 { cfg, errors }：补全缺省参数、强制类型、检查正则。不修改入参。
function validateRules(input) {
  const errs = [];
  if (!input || typeof input !== "object" || !Array.isArray(input.rules)) return { cfg: input, errors: ["根对象需要 rules 数组"] };
  const cfg = clone(input);
  cfg.version = cfg.version || 1;
  cfg.settings = { ...clone(DEFAULT_SETTINGS), ...(cfg.settings || {}) };
  const st = cfg.settings;
  for (const k of ["read_tools", "edit_tools", "shell_tools", "error_patterns"]) {
    if (!Array.isArray(st[k])) st[k] = String(st[k] ?? "").split(/[\n,]/);
    st[k] = st[k].map(String).map(s => s.trim()).filter(Boolean);
  }
  st.error_patterns_on_read_tools = !!st.error_patterns_on_read_tools;
  for (const pat of [...st.error_patterns, st.readonly_cmd_regex]) tryRegex(pat, "i", errs, "全局设置里");
  const ids = new Set();
  cfg.rules.forEach((r, i) => {
    const t = RULE_TYPES[r?.type];
    if (!t) { errs.push(`第 ${i + 1} 条规则类型未知：${r?.type}`); return; }
    r.id = String(r.id || `rule-${i + 1}`);
    if (ids.has(r.id)) errs.push(`规则 id 重复：${r.id}`);
    ids.add(r.id);
    r.name = String(r.name || t.label);
    r.enabled = r.enabled !== false;
    if (!SEVERITIES.includes(r.severity)) r.severity = "medium";
    const p = (r.params = r.params && typeof r.params === "object" ? r.params : {});
    for (const spec of t.params) {
      const k = spec.key;
      if (!(k in p)) p[k] = clone(spec.default);
      const v = p[k];
      if (spec.kind === "int" || spec.kind === "float") {
        const n = Number(v);
        if (!Number.isFinite(n)) errs.push(`规则「${r.name}」参数「${spec.label}」要填数字`);
        else p[k] = spec.kind === "int" ? Math.trunc(n) : n;
      } else if (spec.kind === "bool") p[k] = v === true || v === "true";
      else if (spec.kind === "list") p[k] = (Array.isArray(v) ? v : String(v ?? "").split("\n")).map(String).filter(s => s.trim());
      else if (spec.kind === "enum") { if (!spec.help.split("|").includes(v)) errs.push(`规则「${r.name}」参数「${spec.label}」只能是 ${spec.help}`); }
      else p[k] = String(v ?? "");
    }
    for (const k of ["tool_regex", "cmd_regex", "ignore_models_regex", "done_regex", "followup_regex", "verify_regex", "blocked_regex", "constraint_regex", "correction_regex"]) if (p[k]) tryRegex(p[k], "i", errs, `规则「${r.name}」`);
    for (const pat of Array.isArray(p.regex) ? p.regex : []) tryRegex(pat, "i", errs, `规则「${r.name}」`);
  });
  return { cfg, errors: errs };
}

// ---------- 协议归一化：{role, text, calls:[{id,name,args}], results:[{id,text,is_error}]} ----------
function textOf(c) {
  if (c == null) return "";
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map(b => {
    if (typeof b === "string") return b;
    if (!b || typeof b !== "object") return "";
    if (["image", "image_url", "input_image"].includes(b.type)) return "[图片]";
    if (typeof b.text === "string") return b.text;
    if ("content" in b) return textOf(b.content);
    return "";
  }).filter(Boolean).join("\n");
  if (typeof c === "object") {
    for (const k of ["text", "content", "output", "result"]) if (typeof c[k] === "string" || Array.isArray(c[k])) return textOf(c[k]);
    return JSON.stringify(c).slice(0, 4000);
  }
  return String(c);
}
function parseArgs(a) {
  if (typeof a === "string") { try { return JSON.parse(a); } catch { return a; } }
  return a ?? {};
}
const msg = (role, text = "", calls = [], results = []) => ({ role, text: text || "", calls, results });

function detectProtocol(body) {
  if (!body || typeof body !== "object") return "unknown";
  if ("contents" in body) return "gemini";
  if ("input" in body || "instructions" in body) return "responses";
  const msgs = body.messages;
  if (Array.isArray(msgs)) {
    if ("system" in body || "anthropic_version" in body) return "anthropic";
    for (const m of msgs) {
      if (!m || typeof m !== "object") continue;
      if (["tool", "system", "developer"].includes(m.role) || "tool_calls" in m) return "chat";
      if (Array.isArray(m.content)) for (const b of m.content) {
        if (b && ["tool_use", "tool_result", "thinking"].includes(b.type)) return "anthropic";
        if (b && b.type === "image_url") return "chat";
      }
    }
    return body.max_tokens && !("stream_options" in body) ? "anthropic" : "chat";
  }
  return "unknown";
}

function anthropicMsgs(body) {
  const out = [];
  if (body.system) out.push(msg("system", textOf(body.system)));
  for (const m of body.messages || []) {
    if (!m || typeof m !== "object") continue;
    const role = m.role || "user", c = m.content;
    if (typeof c === "string") { out.push(msg(role, c)); continue; }
    const texts = [], calls = [], results = [];
    for (const b of c || []) {
      if (!b || typeof b !== "object") continue;
      if (b.type === "text") texts.push(b.text || "");
      else if (b.type === "tool_use" || b.type === "server_tool_use") calls.push({ id: b.id || "", name: b.name || "", args: b.input || {} });
      else if (b.type === "tool_result" || b.type === "web_search_tool_result") results.push({ id: b.tool_use_id || "", text: textOf(b.content), is_error: !!b.is_error });
    }
    if (results.length) out.push(msg("tool", texts.join("\n"), [], results));
    else out.push(msg(role, texts.join("\n"), calls));
  }
  return out;
}
function chatMsgs(body) {
  const out = [];
  for (const m of body.messages || []) {
    if (!m || typeof m !== "object") continue;
    let role = m.role || "user";
    if (role === "developer") role = "system";
    if (role === "tool" || role === "function") { out.push(msg("tool", "", [], [{ id: m.tool_call_id || m.name || "", text: textOf(m.content), is_error: false }])); continue; }
    const calls = (m.tool_calls || []).map(tc => ({ id: tc.id || "", name: tc.function?.name || "", args: parseArgs(tc.function?.arguments) }));
    out.push(msg(role, textOf(m.content), calls));
  }
  return out;
}
function responsesMsgs(body) {
  const out = [];
  if (body.instructions) out.push(msg("system", textOf(body.instructions)));
  const inp = body.input;
  if (typeof inp === "string") { out.push(msg("user", inp)); return out; }
  for (const it of inp || []) {
    if (!it || typeof it !== "object") continue;
    const t = it.type || ("role" in it ? "message" : "");
    if (t === "message") out.push(msg(it.role === "developer" ? "system" : (it.role || "user"), textOf(it.content)));
    else if (["function_call", "custom_tool_call", "local_shell_call"].includes(t)) {
      const call = t === "local_shell_call"
        ? { id: it.call_id || it.id || "", name: "local_shell", args: { command: it.action?.command } }
        : { id: it.call_id || it.id || "", name: it.name || "", args: parseArgs(it.arguments ?? it.input) };
      const last = out[out.length - 1];
      if (last && last.role === "assistant" && !last.results.length) last.calls.push(call); else out.push(msg("assistant", "", [call]));
    } else if (["function_call_output", "custom_tool_call_output", "local_shell_call_output"].includes(t)) {
      const r = { id: it.call_id || "", text: textOf(it.output), is_error: false };
      const last = out[out.length - 1];
      if (last && last.role === "tool") last.results.push(r); else out.push(msg("tool", "", [], [r]));
    }
  }
  return out;
}
function geminiMsgs(body) {
  const out = [];
  const si = body.systemInstruction || body.system_instruction;
  if (si) out.push(msg("system", textOf(si.parts ?? si)));
  for (const c of body.contents || []) {
    const role = c.role === "model" ? "assistant" : "user";
    const texts = [], calls = [], results = [];
    for (const p of c.parts || []) {
      if ("text" in p) texts.push(p.text);
      else if (p.functionCall) calls.push({ id: p.functionCall.id || p.functionCall.name || "", name: p.functionCall.name || "", args: p.functionCall.args || {} });
      else if (p.functionResponse) results.push({ id: p.functionResponse.id || p.functionResponse.name || "", text: textOf(p.functionResponse.response), is_error: false });
    }
    if (results.length) out.push(msg("tool", texts.join("\n"), [], results)); else out.push(msg(role, texts.join("\n"), calls));
  }
  return out;
}
const NORMALIZERS = { anthropic: anthropicMsgs, chat: chatMsgs, responses: responsesMsgs, gemini: geminiMsgs };

function normalizeRequest(body, protocol) {
  const p = NORMALIZERS[protocol] ? protocol : detectProtocol(body);
  return { protocol: p, messages: NORMALIZERS[p] ? NORMALIZERS[p](body) : [], ntools: Array.isArray(body?.tools) ? body.tools.length : 0 };
}

// onResponse 拿到的是 Magpie 拼好的整段回复（流式也拼成该协议的非流式形状）
function parseReply(reply, protocol) {
  if (!reply || typeof reply !== "object") return null;
  if (reply.error && !reply.choices && !reply.content && !reply.output) return msg("assistant", "[错误回复] " + JSON.stringify(reply.error).slice(0, 2000));
  if (Array.isArray(reply.content)) return anthropicMsgs({ messages: [{ role: "assistant", content: reply.content }] })[0];
  if (Array.isArray(reply.choices)) return chatMsgs({ messages: [{ ...(reply.choices[0]?.message || {}), role: "assistant" }] })[0];
  const resp = reply.response && Array.isArray(reply.response.output) ? reply.response : reply;
  if (Array.isArray(resp.output)) {
    const ms = responsesMsgs({ input: resp.output.filter(o => o && o.type !== "reasoning").map(o => o.type === "message" ? { ...o, role: o.role || "assistant" } : o) });
    const m = msg("assistant");
    for (const x of ms) { m.text += x.text; m.calls.push(...x.calls); }
    return m;
  }
  if (Array.isArray(reply.candidates)) return geminiMsgs({ contents: [{ ...(reply.candidates[0]?.content || {}), role: "model" }] })[0];
  return null;
}

function usageOf(reply) {
  const r = reply?.response && reply.response.usage ? reply.response : reply;
  const u = r?.usage, g = r?.usageMetadata;
  if (u) {
    if ("prompt_tokens" in u || "completion_tokens" in u) return { in_tok: u.prompt_tokens || 0, out_tok: u.completion_tokens || 0, cache_read: u.prompt_tokens_details?.cached_tokens || 0 };
    const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    if ("cache_read_input_tokens" in u || "cache_creation_input_tokens" in u) return { in_tok: (u.input_tokens || 0) + cr + cw, out_tok: u.output_tokens || 0, cache_read: cr };
    return { in_tok: u.input_tokens || 0, out_tok: u.output_tokens || 0, cache_read: u.input_tokens_details?.cached_tokens || 0 };
  }
  if (g) return { in_tok: g.promptTokenCount || 0, out_tok: g.candidatesTokenCount || 0, cache_read: g.cachedContentTokenCount || 0 };
  return { in_tok: 0, out_tok: 0, cache_read: 0 };
}

// ---------- 脱敏 / 注入文本 ----------
const SECRET_RE = /(sk-ant-[A-Za-z0-9_\-]{16,}|sk-[A-Za-z0-9_\-]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|xox[baprs]-[A-Za-z0-9\-]{10,}|eyJ[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{20,}\.[A-Za-z0-9_\-]{10,})/g;
const scrub = (s) => typeof s === "string" ? s.replace(SECRET_RE, "[已脱敏]") : s;
function stripInjected(t) {
  return String(t || "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")
    .replace(/<(environment_context|user_instructions|command-[a-z]+|local-command-stdout)>[\s\S]*?<\/\1>/g, "").trim();
}

// ---------- 工具参数精简：命令、文件、编辑的行数与特征行哈希 ----------
function cmdOf(args) {
  if (args && typeof args === "object" && !Array.isArray(args)) {
    let c = args.command ?? args.cmd ?? args.script ?? "";
    if (Array.isArray(c)) {
      const head = c.slice(0, 2).join(" ");
      c = (["bash -lc", "bash -c", "sh -c"].includes(head) ? c.slice(2) : c).map(String).join(" ");
    }
    return String(c);
  }
  return typeof args === "string" ? args : "";
}
function patchFiles(p) {
  const out = []; let cur = null, old = [], nw = [];
  for (const line of p.split("\n")) {
    const m = /^\*\*\* (Update|Add|Delete) File: (.+)/.exec(line);
    if (m) {
      if (cur) out.push([cur, old.join("\n"), nw.join("\n"), "patch"]);
      cur = m[2].trim(); old = []; nw = [];
      if (m[1] === "Delete") { out.push([cur, "", "", "delete"]); cur = null; }
      continue;
    }
    if (cur == null) continue;
    if (line.startsWith("-") && !line.startsWith("---")) old.push(line.slice(1));
    else if (line.startsWith("+") && !line.startsWith("+++")) nw.push(line.slice(1));
  }
  if (cur) out.push([cur, old.join("\n"), nw.join("\n"), "patch"]);
  return out;
}
function filesOf(name, args) {
  if (typeof args === "string") return args.includes("*** Begin Patch") || args.includes("*** Update File") ? patchFiles(args) : [];
  if (!args || typeof args !== "object") return [];
  const path = args.file_path || args.path || args.target_file || args.filePath || args.filename || "";
  if (typeof args.input === "string" && args.input.includes("*** ")) return patchFiles(args.input);
  if (typeof args.patch === "string") return patchFiles(args.patch);
  if (Array.isArray(args.edits)) return args.edits.filter(e => e && typeof e === "object").map(e => [path, e.old_string || "", e.new_string || "", "edit"]);
  const old = args.old_string ?? args.old_str ?? args.search ?? "";
  const nw = args.new_string ?? args.new_str ?? args.replace ?? "";
  const content = args.content ?? args.file_text ?? args.contents ?? args.code_edit;
  if (String(name).toLowerCase().includes("delete") && path) return [[path, "", "", "delete"]];
  if (old || nw) return [[path, String(old || ""), String(nw || ""), "edit"]];
  if (content != null) return [[path, "", String(content), "write"]];
  return [];
}
function h32(s) { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(36); }
// 读取/搜索类工具的目标（文件路径、URL、查询词）——压缩时就要提取，事件重建时 args 已被丢弃
const readPathOf = (a) => { a = a || {}; return String(a.file_path || a.path || a.target_file || a.filePath || a.filename || a.url || a.query || a.pattern || ""); };
const sigLines = (t) => [...new Set(String(t || "").split("\n").map(l => l.trim()).filter(l => l.length > 3).map(h32))].slice(0, 400);
const nLines = (t) => t ? String(t).split("\n").length : 0;

const head = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n) + "…" : t; };
// 结果文本保留首尾（错误码、"N failed" 常在末尾）
const headTail = (t, n) => { t = String(t || ""); return t.length > 2 * n ? t.slice(0, n) + "\n…\n" + t.slice(-n) : t; };

// 按长度截断消息（先脱敏）。工具参数是对象时：序列化→脱敏截断→重新解析；
// 截断破坏了 JSON 就降级为 {_truncated}，绝不能让单条大参数丢掉整条记录。
function clipMsg(m, n) {
  const c = (t) => { t = scrub(String(t ?? "")); return t.length > n ? t.slice(0, n) + "…[截断]" : t; };
  const ca = (a) => {
    if (typeof a === "string") return c(a);
    const s = c(JSON.stringify(a ?? {}));
    try { return JSON.parse(s); } catch { return { _truncated: s.slice(0, n) }; }
  };
  return { ...m, text: c(m.text), calls: (m.calls || []).map((x) => ({ ...x, args: ca(x.args) })),
    results: (m.results || []).map((r) => ({ ...r, text: c(r.text) })) };
}

// 精简消息：规则需要的都在，体积小，可以放进 options 快照给页面
function compactMessage(m, lim = { user: 1200, assistant: 600, result: 500, cmd: 400 }) {
  const out = { role: m.role, text: m.role === "user" || m.role === "system" ? head(m.role === "system" ? "" : stripInjected(m.text), lim.user) : head(m.text, lim.assistant) };
  if (m.calls?.length) out.calls = m.calls.map(c => {
    const files = filesOf(c.name, c.args).map(([path, old, nw, kind]) => ({ path, kind, del: nLines(old), add: nLines(nw), so: sigLines(old), sn: sigLines(nw), last: head(nw, 160) }));
    const cc = { id: c.id, name: c.name };
    const cmd = cmdOf(c.args); if (cmd) cc.cmd = head(cmd, lim.cmd);
    if (files.length) cc.files = files;
    else { const p = readPathOf(c.args); if (p) cc.path = head(p, 300); }   // 读取/搜索目标（重复劳动检测用）
    try { cc.ah = h32(JSON.stringify(c.args ?? {})); } catch { cc.ah = ""; }  // 参数指纹（盲试 vs 调整后再试）
    return cc;
  });
  if (m.results?.length) out.results = m.results.map(r => ({ id: r.id, text: headTail(r.text, lim.result), is_error: !!r.is_error }));
  return out;
}

// ---------- 会话重建（存储是增量：offset + 新增消息） ----------
// 会话键 = agent + 会话头 + 首条用户消息的哈希。sha 由调用方注入（宿主/导入器用 node:crypto 的 sha1）。
function sessionKey(agent, sessHeader, msgs, sha) {
  const u = msgs.find((m) => m.role === "user" && stripInjected(m.text)) || msgs.find((m) => m.role === "system");
  const base = stripInjected(u?.text || "").slice(0, 2000);
  return `${agent || "unknown"}-${sha(`${agent}\0${sessHeader}\0${base}`).slice(0, 10)}`;
}

// 合并捕获记录与导入记录：会话级去重只针对「捕获 vs 导入」（捕获优先，避免同一会话重复计数）；
// 导入记录之间不去重——同一会话的多条增量记录（offset 切片）必须全部保留。
function mergeCalls(captured, imported) {
  const ids = new Set(), hdrs = new Set();
  for (const c of captured) { if (c.session) ids.add(c.session); if (c.session_header) hdrs.add(c.session_header); }
  const out = captured.slice();
  for (const c of imported || []) {
    if ((c.session && ids.has(c.session)) || (c.session_header && hdrs.has(c.session_header))) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

function shiftDay(day, n) { return dayOf(Date.parse(`${day}T12:00:00`) + n * 86400000); }

function buildSessions(calls) {
  const sessions = new Map();
  for (const c of [...calls].sort((a, b) => a.ts - b.ts)) {
    let s = sessions.get(c.session);
    if (!s) sessions.set(c.session, s = { id: c.session, agent: c.agent, cwd: c.cwd || "", calls: [], messages: [], rewrites: [] });
    const ci = s.calls.length;
    const { msgs, reply, ...meta } = c;
    s.calls.push(meta);
    if (msgs && (msgs.length || c.nmsgs)) {
      const off = c.offset || 0;
      if (off < s.messages.length) { s.rewrites.push({ call: ci, from: s.messages.length, to: off }); s.messages.length = off; }
      for (const m of msgs) s.messages.push({ ...m, call: ci, ts: c.ts });
    }
    s._lastReply = c.ok !== false && reply ? { ci, reply, ts: c.ts + (c.latency_ms || 0) } : s._lastReply;
  }
  for (const s of sessions.values()) {
    const lr = s._lastReply; delete s._lastReply;
    if (lr) {
      const last = s.messages[s.messages.length - 1];
      if (!last || last.h !== lr.reply.h) s.messages.push({ ...lr.reply, call: lr.ci, ts: lr.ts, from_reply: true });
    }
    s.models = [...new Set(s.calls.map(c => c.model).filter(Boolean))].sort();
    s.start = s.calls[0].ts;
    const lc = s.calls[s.calls.length - 1];
    s.end = lc.ts + (lc.latency_ms || 0);
    const u = s.messages.find(m => m.role === "user" && !m.results?.length && stripInjected(m.text));
    const t = stripInjected(u?.text || "").replace(/\n/g, " ");
    s.title = t.length > 60 ? t.slice(0, 60) + "…" : t;
  }
  return [...sessions.values()];
}

// ---------- 规则引擎 ----------
// 只读命令里的「写特征」否决：awk/sed 等带重定向或写参数时实际是写操作，不能凭 readonly 正则判成只读
const WRITE_CMD_RE = /(^|\s)(tee|dd|chmod|chown|mv|cp|rm|touch|mkdir|rmdir|kill)\b|(^|\s)sed\s+(-[a-zA-Z]*i|-i)[a-zA-Z]*\s|>>|2>|&>|(^\s|\s)>\s/;
class Ctx {
  constructor(st) {
    this.s = st;
    this.read = new Set(st.read_tools); this.edit = new Set(st.edit_tools); this.shell = new Set(st.shell_tools);
    this.ro = new RegExp(st.readonly_cmd_regex, "i");
    this.err = st.error_patterns.map(p => new RegExp(p, "i"));
  }
  kind(c) {
    if (this.edit.has(c.name)) return "edit";
    if (this.read.has(c.name)) return "read";
    if (this.shell.has(c.name)) {
      if (WRITE_CMD_RE.test(String(c.cmd || ""))) return "shell";   // 写特征否决优先
      const parts = String(c.cmd || "").split(/&&|\|\||;|\|/).filter(x => x.trim() && !/^\s*cd\s/.test(x));
      return parts.length && parts.every(x => this.ro.test(x)) ? "read" : "shell";
    }
    return c.files?.length ? "edit" : "other";
  }
  isError(kind, r) {
    if (r.is_error) return true;
    if (kind === "read" && !this.s.error_patterns_on_read_tools) return false;
    const t = String(r.text || "").slice(0, 6000);
    return this.err.some(p => p.test(t));
  }
}

// ---------- 事件重建：把会话消息派生成统一的工具事件流（错误签名 / 参数指纹 / 结果指纹），供跨轮检测器共用 ----------
const safeJson = (x) => { try { return JSON.stringify(x ?? {}); } catch { return "{}"; } };
// 错误签名：去掉数字/十六进制串等易变部分，保留语句结构 —— 同根因的报错应得到同一签名
const errSigOf = (t) => h32(String(t || "").toLowerCase().replace(/0x[0-9a-f]+/g, "#").replace(/\b[0-9a-f]{16,}\b/g, "#")
  .replace(/\d+/g, "N").replace(/\s+/g, " ").trim().slice(0, 300));

function features(sess, ctx) {
  const results = new Map();
  sess.messages.forEach((m, i) => { for (const r of m.results || []) if (!results.has(r.id)) results.set(r.id, [i, r]); });
  const ev = [];
  sess.messages.forEach((m, i) => {
    if (m.role !== "assistant") return;
    for (const c of m.calls || []) {
      const kind = ctx.kind(c);
      const [ri, r] = results.get(c.id) || [null, null];
      const errText = r ? String(r.text || "") : "";
      const isErr = r ? ctx.isError(kind, r) : false;
      const files = kind === "edit" ? c.files || [] : [];
      ev.push({ msg: i, ts: m.ts || (sess.calls[m.call] || {}).ts || 0, name: c.name, kind, result: r, result_msg: ri,
        error: isErr,
        cmd: (kind === "shell" || kind === "read") && ctx.shell.has(c.name) ? c.cmd || "" : "", files,
        target: kind === "edit" ? ((files[0] || {}).path || "") : (kind === "read" ? (ctx.shell.has(c.name) ? String(c.cmd || "").slice(0, 120) : String(c.path || readPathOf(c.args || {}))) : ""),
        argsHash: c.ah || h32(safeJson(c.args)),
        resHash: r ? h32(errText.slice(0, 2000)) : null,
        errSig: isErr ? errSigOf(errText) : null });
    }
  });
  sess._events = ev;
}

const snip = (t, n = 220) => { t = String(t || "").replace(/\n/g, " ⏎ ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };
function hit(rule, sess, msgIdx, evidence, extra = {}) {
  const m = msgIdx != null ? sess.messages[msgIdx] : null;
  const call = m ? m.call : null;
  const model = call != null ? sess.calls[call]?.model : (sess.models[sess.models.length - 1] || "");
  return { rule: rule.id, rule_name: rule.name, type: rule.type, severity: rule.severity, session: sess.id, agent: sess.agent,
    model: model || "", msg: msgIdx ?? null, call, ts: m ? m.ts : sess.start, evidence, ...extra };
}
function* userMsgs(sess) {
  for (let i = 0; i < sess.messages.length; i++) {
    const m = sess.messages[i];
    if (m.role === "user" && !(m.results || []).length) { const t = stripInjected(m.text); if (t) yield [i, t]; }
  }
}
function firstMsgOfCall(sess, ci) {
  const i = sess.messages.findIndex(m => m.call >= ci);
  return i >= 0 ? i : (sess.messages.length ? sess.messages.length - 1 : null);
}
const intersects = (a, b) => { const s = new Set(b); return a.some(x => s.has(x)); };

const IMPL = {
  tool_error_retry(rule, sess) {
    const p = rule.params, out = [], streak = new Map();
    const rx = p.tool_regex ? new RegExp(p.tool_regex) : null;
    const flush = (n) => {
      const st = streak.get(n) || []; streak.delete(n);
      if (st.length < p.min_consecutive) return;
      // 盲试 = 参数完全相同的一次次重试；参数有调整 = 在适应（置信度略低）
      const adapted = st.some((x, i) => i > 0 && x.argsHash !== st[i - 1].argsHash);
      out.push(hit(rule, sess, st[0].msg, `${n} 连续失败 ${st.length} 次${adapted ? "（参数有调整，仍在适应）" : "（参数完全相同的盲试）"}；最后一次：` + snip(st[st.length - 1].result.text),
        { count: st.length, blind: !adapted, msgs: st.map(x => x.msg) }));
    };
    for (const e of sess._events) {
      if (!e.result || (rx && !rx.test(e.name))) continue;
      if (e.error) { if (!streak.has(e.name)) streak.set(e.name, []); streak.get(e.name).push(e); } else flush(e.name);
    }
    for (const n of [...streak.keys()]) flush(n);
    return out;
  },
  command_repeat_fail(rule, sess) {
    const p = rule.params, groups = new Map();
    const rx = p.cmd_regex ? new RegExp(p.cmd_regex, "i") : null;
    const norm = (cmd) => { const w = cmd.trim().replace(/^\s*(cd\s+\S+\s*&&\s*)+/, "").replace(/\s+/g, " ").split(" "); return p.key_words > 0 ? w.slice(0, p.key_words).join(" ") : w.join(" "); };
    // 按「根因」分组：is_error 事件用错误签名（跨命令的同根因失败链）；
    // 文本模式命中的兜底错误用 命令+签名，避免把不同来源的泛化错误串成一条链。
    for (const e of sess._events) if (e.kind === "shell" && e.error && e.cmd && (!rx || rx.test(e.cmd))) {
      const k = (e.result && e.result.is_error ? "E:" + (e.errSig || e.resHash) : "C:" + norm(e.cmd) + "|" + (e.errSig || e.resHash));
      if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e);
    }
    const out = [];
    for (const [, es] of groups) if (es.length >= p.min_failures) {
      const cmds = [...new Set(es.map(x => snip(x.cmd, 40)))];
      out.push(hit(rule, sess, es[0].msg, `${cmds.length > 1 ? "同一错误出现在 " + cmds.length + " 条命令（" + cmds.join("、") + "）" : `\`${cmds[0]}\``} 失败 ${es.length} 次；最后报错：` + snip((es[es.length - 1].result || {}).text, 160),
        { count: es.length, msgs: es.map(x => x.msg) }));
    }
    return out;
  },
  edit_churn(rule, sess) {
    const p = rule.params, out = [], perFile = new Map();
    for (const e of sess._events) if (e.kind === "edit") for (const f of e.files) if (f.path && f.kind !== "delete") {
      if (!perFile.has(f.path)) perFile.set(f.path, []); perFile.get(f.path).push({ msg: e.msg, f });
    }
    for (const [path, edits] of perFile) {
      let chains;
      if (p.mode === "file") chains = [edits];
      else {
        chains = [];
        for (const ed of edits) {
          const ch = chains.find(ch => {
            const last = ch[ch.length - 1];
            const near = !p.window_msgs || ed.msg - last.msg <= p.window_msgs;
            return near && (intersects(ed.f.so, [...last.f.sn, ...last.f.so]) || (!ed.f.del && !last.f.del));
          });
          if (ch) ch.push(ed); else chains.push([ed]);
        }
      }
      for (const ch of chains) if (ch.length >= p.min_edits)
        out.push(hit(rule, sess, ch[0].msg, `${path} 同一区域被改了 ${ch.length} 次；最后一次改成：` + snip(ch[ch.length - 1].f.last, 140), { count: ch.length, file: path, msgs: ch.map(x => x.msg) }));
    }
    return out;
  },
  rewrite(rule, sess) {
    const p = rule.params, out = [], written = new Map();
    let totDel = 0, totAdd = 0, first = null;
    for (const e of sess._events) if (e.kind === "edit") for (const f of e.files) {
      let d = f.del, a = f.add;
      if ((f.kind === "write" || f.kind === "delete") && written.has(f.path)) d = written.get(f.path);
      if (f.kind === "write") written.set(f.path, a);
      totDel += d; totAdd += a;
      if (d && first == null) first = e.msg;
      if (d >= p.single_min_deleted) out.push(hit(rule, sess, e.msg, `${f.path} 一次删除/重写了 ${d} 行（新增 ${a} 行）`, { deleted: d, added: a, file: f.path }));
    }
    if (totDel >= p.total_min_deleted && totDel >= p.ratio * Math.max(totAdd, 1))
      out.push(hit(rule, sess, first, `会话累计删除 ${totDel} 行 / 新增 ${totAdd} 行，比值 ${(totDel / Math.max(totAdd, 1)).toFixed(2)}`, { deleted: totDel, added: totAdd }));
    const kws = p.keywords.map(k => k.toLowerCase());
    sess.messages.forEach((m, i) => {
      if (m.role !== "assistant" || !m.text) return;
      const low = m.text.toLowerCase(), k = kws.find(k => low.includes(k));
      if (k) out.push(hit(rule, sess, i, `assistant 说「${k}」：` + snip(m.text, 160), { keyword: k }));
    });
    return out;
  },
  blind_exploration(rule, sess) {
    const p = rule.params, out = [], byMsg = new Map();
    for (const e of sess._events) { if (!byMsg.has(e.msg)) byMsg.set(e.msg, []); byMsg.get(e.msg).push(e); }
    let streak = [];
    for (const mi of [...[...byMsg.keys()].sort((a, b) => a - b), null]) {
      const es = mi == null ? null : byMsg.get(mi);
      if (es && es.every(e => e.kind === "read")) { streak.push(mi); continue; }
      if (streak.length >= p.min_turns) {
        const names = streak.slice(-3).flatMap(m => byMsg.get(m).map(e => e.name + (e.cmd ? ":" + snip(e.cmd, 30) : "")));
        out.push(hit(rule, sess, streak[0], `连续 ${streak.length} 轮只读/搜索没有改动；最后几步：` + names.slice(-4).join(", "), { count: streak.length, msgs: streak }));
      }
      streak = [];
    }
    return out;
  },
  repeated_work(rule, sess) {
    const p = rule.params, out = [];
    const evs = sess._events.filter(e => e.result);
    // a) 重复读取 / 重复执行：同一目标的结果指纹完全相同的连续重复（结果变了 = 有新信息或验证生效，不打断）
    if (p.check_reads || p.check_execs) {
      const byTarget = new Map();
      for (const e of evs) {
        if (e.kind !== "read" && e.kind !== "shell") continue;
        if (e.kind === "read" && !p.check_reads) continue;
        if (e.kind === "shell" && !p.check_execs) continue;
        if (!e.target) continue;
        if (!byTarget.has(e.target)) byTarget.set(e.target, []);
        byTarget.get(e.target).push(e);
      }
      for (const [target, list] of byTarget) {
        let run = [];
        const flush = () => {
          if (run.length >= p.min_repeats) {
            const label = run[0].kind === "read" ? "读取" : "执行";
            out.push(hit(rule, sess, run[0].msg, `${label} \`${snip(target, 80)}\` ${run.length} 次结果完全相同（没有新信息）`,
              { count: run.length, msgs: run.map(e => e.msg), target }));
          }
          run = [];
        };
        for (const e of list) {
          if (run.length && e.resHash !== run[run.length - 1].resHash) flush();
          if (e.resHash != null) run.push(e);
        }
        flush();
      }
    }
    // b) 回退/翻转：同一文件后来的编辑把内容改回了更早编辑之前的状态（改了又改回去 = 确定的重复劳动）
    if (p.check_reverts) {
      const byFile = new Map();
      for (const e of evs) if (e.kind === "edit") for (const f of e.files) {
        if (!f.path || f.kind === "delete") continue;
        if (!byFile.has(f.path)) byFile.set(f.path, []);
        byFile.get(f.path).push({ msg: e.msg, so: f.so || [], sn: f.sn || [] });
      }
      const frac = (a, b) => { if (!a.length) return 0; const s = new Set(b); return a.filter(x => s.has(x)).length / a.length; };
      for (const [path, edits] of byFile) {
        let done = false;
        for (let j = 2; j < edits.length && !done; j++) {
          for (let i = j - 2; i >= 0; i--) {
            // 增量被撤销：编辑 i 删掉的行后来被编辑 j 改了回来，且编辑 i 新增的行没有留下来
            const dOld = edits[i].so.filter(x => !edits[i].sn.includes(x));
            const dNew = edits[i].sn.filter(x => !edits[i].so.includes(x));
            if (dOld.length < 2 || !dNew.length) continue;
            if (frac(dOld, edits[j].sn) >= p.revert_overlap && frac(dNew, edits[j].sn) <= 1 - p.revert_overlap) {
              out.push(hit(rule, sess, edits[i].msg, `${path} 第 ${i + 1} 次编辑的改动在第 ${j + 1} 次编辑时被撤销（改了又改回去）`,
                { count: j - i + 1, file: path, msgs: [edits[i].msg, edits[j].msg] }));
              done = true; break;
            }
          }
        }
      }
    }
    return out;
  },
  no_progress_loop(rule, sess) {
    const p = rule.params, out = [];
    const evs = sess._events.filter(e => e.result);
    let run = [];
    const flush = () => {
      const fails = run.filter(e => e.error);
      if (fails.length >= p.min_failed) {
        const sigs = new Set(fails.map(e => e.errSig || e.resHash));
        if (sigs.size <= Math.max(1, p.max_err_sigs)) {
          let rec = null;
          if (p.report_recovery) {
            const startIdx = evs.indexOf(run[run.length - 1]);
            for (const e of evs.slice(startIdx + 1)) {
              if (!e.error && (e.name === fails[0].name || (e.target && e.target === fails[0].target))) { rec = e; break; }
            }
          }
          const calls = new Set(run.map(e => sess.messages[e.msg]?.call).filter(x => x != null));
          let tok = 0;
          for (const c of calls) { const cc = sess.calls[c] || {}; tok += (cc.in_tok || 0) + (cc.out_tok || 0); }
          out.push(hit(rule, sess, fails[0].msg,
            `${fails.length} 次失败是同一个错误：` + snip((fails[0].result || {}).text || "", 120) + (rec ? "；之后已恢复" : "；窗口内未见恢复"),
            { count: fails.length, recovered: !!rec, tokens_in_window: tok, msgs: run.map(e => e.msg) }));
        }
      }
      run = [];
    };
    for (const e of evs) {
      if (!run.length && !e.error) continue;          // 从首个失败开始建窗
      if (e.error) { run.push(e); continue; }
      // 同工具的成功 = 恢复，窗口结束；窗口过长也强制结算，避免把不同阶段黏成一团
      if (e.name === run[run.length - 1].name || run.length >= Math.max(6, p.min_failed * 3)) flush();
      else run.push(e);
    }
    flush();
    return out;
  },
  regression_rework(rule, sess) {
    const p = rule.params, out = [];
    const rx = p.cmd_regex ? new RegExp(p.cmd_regex, "i") : null;
    const seq = new Map();   // cmdHash -> [{msg, ok, editsAt}]
    const reported = new Set();
    let edits = 0;
    for (const e of sess._events) {
      if (e.kind === "edit" && (e.files || []).length) { edits++; continue; }
      if (!e.result || e.kind !== "shell" || !e.cmd) continue;
      if (rx && !rx.test(e.cmd)) continue;
      const k = h32(e.cmd.trim().replace(/\s+/g, " "));
      const arr = seq.get(k) || [];
      if (!reported.has(k) && e.error) {
        let prior = null;
        for (let i = arr.length - 1; i >= 0; i--) if (arr[i].ok) { prior = arr[i]; break; }
        if (prior && (!p.require_edit_between || edits > prior.editsAt)) {
          out.push(hit(rule, sess, e.msg, `\`${snip(e.cmd, 80)}\` 先前通过，期间经过 ${edits - prior.editsAt} 次代码修改后失败（新修改疑似引入回归）`,
            { count: 2, msgs: [prior.msg, e.msg] }));
          reported.add(k);
        }
      }
      arr.push({ msg: e.msg, ok: !e.error, editsAt: edits });
      seq.set(k, arr);
    }
    return out;
  },
  context_bloat(rule, sess) {
    const p = rule.params, out = [];
    let prev = null, maxHit = false;
    sess.calls.forEach((c, ci) => {
      if (c.ok === false) return;
      const t = c.in_tok || 0, mi = firstMsgOfCall(sess, ci);
      if (prev && t >= prev * p.ratio && t - prev >= p.min_jump) out.push(hit(rule, sess, mi, `输入 token 从 ${prev.toLocaleString()} 涨到 ${t.toLocaleString()}（×${(t / prev).toFixed(1)}）`, { call_override: ci }));
      if (p.max_input && t >= p.max_input && !maxHit) { maxHit = true; out.push(hit(rule, sess, mi, `单次输入 ${t.toLocaleString()} token，超过 ${p.max_input.toLocaleString()}`, { call_override: ci })); }
      prev = t || prev;
    });
    if (p.detect_rewrite && sess.rewrites.length) {
      const rw = sess.rewrites[0];
      out.push(hit(rule, sess, firstMsgOfCall(sess, rw.call), `历史被裁剪/压缩 ${sess.rewrites.length} 次；第一次：消息数 ${rw.from} → 保留前 ${rw.to} 条`, { call_override: rw.call, count: sess.rewrites.length }));
    }
    const kws = p.keywords.map(k => k.toLowerCase());
    sess.messages.forEach((m, i) => {
      if ((m.role !== "user" && m.role !== "system") || !m.text) return;
      const low = m.text.toLowerCase(), k = kws.find(k => low.includes(k));
      if (k) out.push(hit(rule, sess, i, `出现压缩提示「${k}」`));
    });
    return out;
  },
  user_correction(rule, sess) {
    const p = rule.params, out = [];
    const kws = p.keywords.map(k => k.toLowerCase()), rxs = p.regex.map(r => new RegExp(r, "i"));
    for (const [i, t] of userMsgs(sess)) {
      const low = t.toLowerCase();
      let k = kws.find(k => low.includes(k));
      if (!k) { for (const r of rxs) { const m = r.exec(t); if (m) { k = m[0]; break; } } }
      if (k) out.push(hit(rule, sess, i, `用户说「${k}」：` + snip(t, 180), { keyword: k }));
    }
    return out;
  },
  model_switch(rule, sess) {
    const p = rule.params, out = [], sw = [];
    const ign = p.ignore_models_regex ? new RegExp(p.ignore_models_regex, "i") : null;
    let prev = null;
    sess.calls.forEach((c, ci) => {
      const m = c.model || "";
      if (!m || (ign && ign.test(m))) return;
      if (prev && m !== prev) sw.push([ci, prev, m]);
      prev = m;
    });
    if (sw.length >= p.min_switches) for (const [ci, a, b] of sw) out.push(hit(rule, sess, firstMsgOfCall(sess, ci), `模型 ${a} → ${b}`, { call_override: ci, model_from: a, model_to: b }));
    return out;
  },
  premature_done(rule, sess) {
    const p = rule.params, out = [];
    const done = new RegExp(p.done_regex, "i"), fol = new RegExp(p.followup_regex, "i");
    const users = [...userMsgs(sess)];
    sess.messages.forEach((m, i) => {
      if (m.role !== "assistant" || !m.text || (m.calls || []).length) return;
      const d = done.exec(m.text); if (!d) return;
      const nxt = users.find(([j]) => j > i);
      if (nxt && nxt[0] - i <= p.within_msgs && fol.test(nxt[1])) out.push(hit(rule, sess, i, `assistant 说「${d[0]}」，随后用户：` + snip(nxt[1], 150), { followup_msg: nxt[0] }));
    });
    return out;
  },
  done_without_evidence(rule, sess) {
    const p = rule.params, out = [];
    const done = new RegExp(p.done_regex, "i"), verify = new RegExp(p.verify_regex, "i");
    const blocked = p.blocked_regex ? new RegExp(p.blocked_regex, "i") : null;
    let lastEdit = -1; const verifys = [];
    for (const e of sess._events) {
      if (e.kind === "edit") lastEdit = Math.max(lastEdit, e.msg);
      if (e.kind === "shell" && e.cmd && verify.test(e.cmd)) verifys.push({ msg: e.msg, ok: !e.error });
    }
    if (lastEdit < 0 && !verifys.length) return out;   // 纯问答/无代码会话不判
    sess.messages.forEach((m, i) => {
      if (m.role !== "assistant" || !m.text || (m.calls || []).length) return;
      const d = done.exec(m.text); if (!d) return;
      if (blocked && blocked.test(m.text)) return;     // 声明受阻原因的，不算 premature
      const v = [...verifys].reverse().find(x => x.msg < i);
      const afterEdit = v && v.msg > lastEdit;
      if (afterEdit && v.ok) return;                    // verified：修改后有验证通过，不报
      const status = afterEdit ? "failed_verify" : "implemented";
      if (out.some(x => x.status === status)) return;   // 每种状态报一次
      out.push(hit(rule, sess, i, status === "failed_verify"
        ? `说「${d[0]}」，但最后一次代码修改之后验证命令仍在失败`
        : `说「${d[0]}」，但最后一次代码修改之后没有运行过验证（implemented，不等于 verified）`, { status }));
    });
    return out;
  },
  requirement_drift(rule, sess) {
    const p = rule.params, out = [];
    const constraint = p.constraint_regex ? new RegExp(p.constraint_regex, "i") : null;
    const corrRx = new RegExp(p.correction_regex || "不可能的正则$", "i");
    const users = [...userMsgs(sess)];
    // 1) 约束违反：用户明确「只分析/不要改」之后，下一次用户发言之前仍然修改了文件
    if (constraint) {
      for (let u = 0; u < users.length; u++) {
        const [ui, ut] = users[u];
        if (!constraint.test(ut)) continue;
        const nextU = u + 1 < users.length ? users[u + 1][0] : Infinity;
        const edit = sess._events.find(e => e.kind === "edit" && e.msg > ui && e.msg < nextU);
        if (edit) out.push(hit(rule, sess, edit.msg, `用户说「${snip(ut, 60)}」，仍然修改了 ${(edit.files || []).map(f => f.path).filter(Boolean).join("、") || "文件"}`,
          { kind: "constraint_violation", constraint_msg: ui }));
      }
    }
    // 2) 重复纠偏：同一纠偏说法出现 ≥ N 次（同一问题被反复指出）
    const kwCount = new Map();
    for (const [ui, ut] of users) {
      const m = corrRx.exec(ut);
      if (m) { const k = m[0].toLowerCase(); if (!kwCount.has(k)) kwCount.set(k, []); kwCount.get(k).push(ui); }
    }
    for (const [k, msgs] of kwCount) if (msgs.length >= p.repeat_min)
      out.push(hit(rule, sess, msgs[0], `「${k}」类的纠偏出现了 ${msgs.length} 次——同一问题被反复指出`, { kind: "repeat_correction", count: msgs.length, msgs }));
    // 3) 范围漂移（默认关）：修改了用户从未提及的文件
    if (p.check_scope) {
      const mentioned = new Set();
      for (const [, ut] of users) for (const m of ut.matchAll(/[\w.\-/]+\.(?:js|jsx|ts|tsx|py|go|rs|java|rb|php|c|cpp|h|hpp|cs|swift|kt|md|json|ya?ml|toml|sh|sql|html|css|vue)/gi)) mentioned.add(m[0].split("/").pop().toLowerCase());
      const unmentioned = new Map();
      for (const e of sess._events) if (e.kind === "edit") for (const f of e.files || []) {
        if (!f.path) continue;
        if (!mentioned.has(f.path.split("/").pop().toLowerCase())) unmentioned.set(f.path, (unmentioned.get(f.path) || 0) + 1);
      }
      if (unmentioned.size >= 3) out.push(hit(rule, sess, null, `修改的 ${unmentioned.size} 个文件用户从未提及：` + [...unmentioned.keys()].slice(0, 3).join("、") + "…（范围漂移候选，低置信）", { kind: "scope_drift", count: unmentioned.size }));
    }
    return out;
  },
  keyword(rule, sess) {
    const p = rule.params, out = [];
    const kws = p.keywords.map(k => k.toLowerCase()), rxs = p.regex.map(r => new RegExp(r, "i"));
    sess.messages.forEach((m, i) => {
      if (!p.roles.includes(m.role)) return;
      let t = m.text + (m.role === "tool" ? "\n" + (m.results || []).map(r => r.text).join("\n") : "");
      if (m.role === "user") t = stripInjected(t);
      const low = t.toLowerCase();
      let k = kws.find(k => low.includes(k));
      if (!k) { for (const r of rxs) { const mm = r.exec(t); if (mm) { k = mm[0]; break; } } }
      if (k) out.push(hit(rule, sess, i, `${m.role} 命中「${k}」：` + snip(t, 160), { keyword: k }));
    });
    return out.length >= p.min_count ? out : [];
  },
  threshold(rule, sess) {
    const v = sess.stats[rule.params.metric];
    return v != null && v >= rule.params.value ? [hit(rule, sess, null, `${rule.params.metric} = ${v}，≥ ${rule.params.value}`, { value: v })] : [];
  },
};

function metric(calls, name) {
  if (name === "latency_ms") return calls.reduce((a, c) => a + (c.latency_ms || 0), 0);
  if (name === "tokens") return calls.reduce((a, c) => a + (c.in_tok || 0) + (c.out_tok || 0), 0);
  if (name === "cost") { const v = calls.filter(c => c.cost != null); return v.length ? v.reduce((a, c) => a + c.cost, 0) : null; }
  return null;
}
// 任务类型：首条用户消息的启发式分类（用于慢和贵的分桶基线；粗分类，仅作参考维度）
function taskTypeOf(s) {
  const u = s.messages.find(m => m.role === "user" && !(m.results || []).length && stripInjected(m.text));
  const t = stripInjected((u || {}).text || "").toLowerCase();
  if (!t) return "其他";
  if (/修复|修一下|fix|bug|报错|错误|失败|崩溃|回归|调试|debug/.test(t)) return "修复";
  if (/实现|新增|添加|开发|加一个|写一个|支持|implement|feature|add |create |support /.test(t)) return "开发";
  if (/解释|为什么|什么意思|怎么(么)?(工作|实现|用)|如何|什么是|explain|why |how does|understand|阅读|梳理|分析|调研|评估|compare|review/.test(t)) return "理解/调研";
  if (/文档|注释|readme|说明|翻译|docs? |comment|translate/.test(t)) return "文档";
  return "其他";
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; };

function slowCostly(rule, sessions) {
  const p = rule.params, out = [], groups = new Map();
  for (const s of sessions) {
    const units = p.unit === "session" ? [[s, null, metric(s.calls, p.metric)]] : s.calls.map((c, ci) => [s, ci, metric([c], p.metric)]);
    for (const [s_, ci, v] of units) {
      if (v == null) continue;
      const g = p.group_by === "all" ? "all" : p.group_by === "agent" ? s_.agent : p.group_by === "task_type" ? taskTypeOf(s_) : (ci != null ? s_.calls[ci].model : s_.models[s_.models.length - 1] || "");
      if (!groups.has(g)) groups.set(g, []); groups.get(g).push([s_, ci, v]);
    }
  }
  const unit = { latency_ms: "ms", tokens: "token", cost: "$" }[p.metric], label = { latency_ms: "耗时", tokens: "token", cost: "花费" }[p.metric];
  const fmt = (x) => p.metric === "cost" ? `$${x.toFixed(4)}` : `${Math.round(x).toLocaleString()} ${unit}`;
  for (const [g, items] of groups) {
    if (items.length < p.min_samples) continue;
    const med = median(items.map(x => x[2]));
    if (med <= 0) continue;
    for (const [s, ci, v] of items) if (v >= med * p.multiplier)
      out.push(hit(rule, s, ci != null ? firstMsgOfCall(s, ci) : null, `${ci != null ? "调用" : "会话"}${label} ${fmt(v)}，是 ${g} 中位数 ${fmt(med)} 的 ${(v / med).toFixed(1)} 倍`, { value: v, median: med, call_override: ci }));
  }
  return out;
}

function sessionStats(s) {
  const ev = s._events || [];
  const fails = ev.filter(e => e.error);
  const sigs = new Set(fails.map(e => e.errSig || e.resHash));
  const verifyRe = new RegExp(VERIFY_CMD_RE_STR, "i");
  const fv = ev.find(e => e.kind === "shell" && e.cmd && verifyRe.test(e.cmd));
  let corrections = 0;
  for (const [, t] of userMsgs(s)) { const low = t.toLowerCase(); if (CORRECTION_KEYWORDS.some(k => low.includes(k))) corrections++; }
  const wall = Math.max(0, s.end - s.start), active = s.calls.reduce((a, c) => a + (c.latency_ms || 0), 0);
  return { calls: s.calls.length, failed_calls: s.calls.filter(c => c.ok === false).length, tool_calls: ev.length,
    tool_errors: fails.length, edits: ev.filter(e => e.kind === "edit").length,
    user_msgs: [...userMsgs(s)].length, max_input_tokens: Math.max(0, ...s.calls.map(c => c.in_tok || 0)),
    total_tokens: metric(s.calls, "tokens"), latency_ms: metric(s.calls, "latency_ms"),
    // P2 会话质量指标：无新签名失败占比 / 人工纠偏次数 / 首次验证结果 / 时间构成（活跃=网关调用，间隙=用户思考与本地处理）
    repeat_fail_ratio: fails.length ? +((fails.length - sigs.size) / fails.length).toFixed(2) : 0,
    corrections, first_verify_pass: fv ? !fv.error : null,
    wall_ms: wall, active_ms: active, idle_ms: Math.max(0, wall - active), task_type: taskTypeOf(s) };
}

// sessions: buildSessions() 的结果（或快照里的精简会话）；cfg: validateRules().cfg
function detect(sessions, cfg) {
  const ctx = new Ctx(cfg.settings);
  for (const s of sessions) { features(s, ctx); s.stats = sessionStats(s); }
  const byId = new Map(sessions.map(s => [s.id, s]));
  let hits = [];
  for (const rule of cfg.rules) {
    if (rule.enabled === false) continue;
    try {
      if (rule.type === "slow_costly") hits.push(...slowCostly(rule, sessions));
      else for (const s of sessions) hits.push(...IMPL[rule.type](rule, s));
    } catch (e) {
      hits.push({ rule: rule.id, rule_name: rule.name, type: "rule_error", severity: "low", session: "", agent: "", model: "", msg: null, call: null, ts: 0, evidence: `规则执行出错：${e.message}` });
    }
  }
  for (const h of hits) {
    if (h.call_override != null) {
      h.call = h.call_override;
      const s = byId.get(h.session);
      if (s && s.calls[h.call]) h.model = s.calls[h.call].model || h.model;
    }
    delete h.call_override;
  }
  for (const s of sessions) delete s._events;
  return hits.sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// 汇总：按规则 / agent / 模型 / 严重级别计数
function summarize(hits, sessions) {
  const count = (key) => { const m = {}; for (const h of hits) if (h[key]) m[h[key]] = (m[h[key]] || 0) + 1; return Object.entries(m).sort((a, b) => b[1] - a[1]); };
  return { sessions: sessions.length, calls: sessions.reduce((a, s) => a + s.calls.length, 0), hits: hits.length,
    sessions_with_hits: new Set(hits.map(h => h.session).filter(Boolean)).size,
    by_rule: count("rule_name"), by_agent: count("agent"), by_model: count("model"), by_severity: count("severity") };
}

// ---------- 问题片段聚合：把同一会话内时间相近、互相关联的信号合并成一次问题（确定性规则，不做根因推断） ----------
// 信号(Signal) ≠ 问题(Issue) ≠ 根因(RootCause)：一个 issue 由多个信号支撑；root_cause 只给假设分类，status 固定为 hypothesis。
const REWORK_TYPES = new Set(["no_progress_loop", "repeated_work", "regression_rework", "edit_churn", "rewrite", "cmd_repeat_fail", "tool_error_retry", "done_without_evidence"]);
function issueTitle(types, rules) {
  const has = (t) => types.has(t);
  if (has("no_progress_loop")) return has("edit_churn") || has("tool_error_retry") ? "反复修改/重试，始终是同一个错误" : "同一错误反复尝试无进展";
  if (has("regression_rework")) return "修改引入回归：先前通过的验证失败";
  if (has("requirement_drift")) return has("user_correction") ? "需求理解偏差引发返工" : "需求偏离：约束违反/重复纠偏";
  if (has("done_without_evidence")) return "完成声明缺验证证据";
  if (has("repeated_work") && (has("cmd_repeat_fail") || has("tool_error_retry"))) return "重复执行与反复失败交织";
  if (has("repeated_work") && has("edit_churn")) return "反复编辑与回退（重复劳动）";
  if (has("repeated_work")) return "重复劳动";
  if (has("user_correction") && (has("rewrite") || has("edit_churn"))) return "人工纠偏后返工";
  return rules.slice(0, 2).join(" + ");
}
function rootCauseGuess(types) {
  const has = (t) => types.has(t);
  if (has("no_progress_loop") || has("cmd_repeat_fail")) return "insufficient_diagnosis";
  if (has("done_without_evidence")) return "insufficient_verification";
  if (has("requirement_drift") || has("user_correction") || has("premature_done")) return "requirement_misunderstanding";
  if (has("repeated_work") || has("edit_churn") || has("rewrite")) return "implementation_churn";
  if (has("regression_rework")) return "missing_impact_analysis";
  return "unknown";
}
function groupIssues(hits, sessions, opts = {}) {
  const window = opts.window_msgs ?? 12;
  const bySess = new Map();
  for (const h of hits) {
    if (!h.session || h.type === "rule_error") continue;
    if (!bySess.has(h.session)) bySess.set(h.session, []);
    bySess.get(h.session).push(h);
  }
  const sessById = new Map(sessions.map(s => [s.id, s]));
  const issues = [];
  for (const [sid, hs] of bySess) {
    hs.sort((a, b) => (a.msg ?? 1e9) - (b.msg ?? 1e9) || (a.ts || 0) - (b.ts || 0));
    const clusters = [];
    let cur = null;
    for (const h of hs) {
      if (h.msg == null) {   // 会话级信号（threshold / slow_costly）挂到最后一个片段
        if (cur) cur.hits.push(h);
        else { cur = { hits: [h], min: null, max: null }; clusters.push(cur); }
        continue;
      }
      if (cur && cur.max != null && h.msg - cur.max <= window) { cur.hits.push(h); cur.max = Math.max(cur.max, h.msg); }
      else { cur = { hits: [h], min: h.msg, max: h.msg }; clusters.push(cur); }
    }
    clusters.forEach((c, n) => {
      const sess = sessById.get(sid);
      const types = new Set(c.hits.map(h => h.type));
      const sevRank = { high: 3, medium: 2, low: 1 };
      const severity = c.hits.reduce((a, h) => ((sevRank[h.severity] || 0) > (sevRank[a] || 0) ? h.severity : a), "low");
      const rules = [...new Set(c.hits.map(h => h.rule_name))];
      const tsList = c.hits.map(h => h.ts).filter(x => x > 0);
      const reworkOps = c.hits.reduce((a, h) => a + (REWORK_TYPES.has(h.type) ? (h.count || 1) : 0), 0);
      const tokens = c.hits.reduce((a, h) => a + (h.tokens_in_window || 0), 0);
      const recovered = c.hits.some(h => h.recovered === true);
      issues.push({
        id: `issue-${sid}-${n + 1}`, session: sid, agent: (sess || {}).agent || c.hits[0].agent || "",
        title: issueTitle(types, rules), severity,
        confidence: Math.min(0.95, +(0.5 + 0.12 * Math.max(0, types.size - 1) + (c.hits.length >= 3 ? 0.1 : 0)).toFixed(2)),
        rules, msg_from: c.min, msg_to: c.max,
        start_ts: tsList.length ? Math.min(...tsList) : 0,
        evidence: c.hits.map(h => ({ rule: h.rule_name, msg: h.msg, text: h.evidence })),
        impact: { rework_operations: reworkOps || null, tokens_in_window: tokens || null, recovered: c.hits.some(h => "recovered" in h) ? recovered : null },
        root_cause: { category: rootCauseGuess(types), status: "hypothesis" },
      });
    });
  }
  const sevRank = { high: 3, medium: 2, low: 1 };
  return issues.sort((a, b) => (sevRank[b.severity] || 0) - (sevRank[a.severity] || 0) || (b.impact.rework_operations || 0) - (a.impact.rework_operations || 0) || (b.start_ts || 0) - (a.start_ts || 0));
}

const DEFAULTS = {
  captureOrigins: ["local", "gateway-key"],
  ignoreAgents: [],
  snapshotDays: 3,
  snapshotMaxKB: 600,
  publishSeconds: 90,
  retainDays: 30,
  maxTextChars: 20000,
  outputDir: "magpie-stuck",
  gatewayTimeoutMs: 1000,
};

function formatLocal(ts) {
  if (!ts) return "—";
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function dayOf(ts) { const d = new Date(ts), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }

// magpie-stuck 页面：运行在 Magpie App 的插件沙箱 iframe 里（只允许脚本，CSP 禁止 fetch）。
// 数据只经 bridge：magpie.options.get() 读宿主写入的 options._status 快照，
// 规则存在 options.rules，用 magpie.options.set() 保存。规则检测在页面里实时跑。

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

})();
