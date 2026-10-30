// magpie-stuck 共享核心：协议归一化、会话精简、声明式卡点规则引擎。
// 没有 Node/Bun 依赖：stuck.hooks.js（Bun 宿主）和 page/（App 内沙箱页面）共用。
// 规则是 JSON（type + params），不执行任意代码。

// ---------- 全局设置（工具分类、错误识别） ----------
export const DEFAULT_SETTINGS = {
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

export const SEVERITIES = ["low", "medium", "high"];
export const SEVERITY_LABEL = { low: "低", medium: "中", high: "高" };

// 跨规则共享的启发式常量：验证命令、人工纠偏关键词（会话指标与新规则共用同一套）
export const VERIFY_CMD_RE_STR = "test|pytest|jest|vitest|go |cargo|mvn|gradle|make|npm|pnpm|yarn|tsc|lint|build";
export const CORRECTION_KEYWORDS = ["不对", "重来", "不是这个意思", "你又", "还是不行", "错了", "不是这样", "别改", "我说的是", "没让你", "搞错", "还是报错", "又错", "that's wrong", "not what i", "you broke", "still failing", "still not"];

const P = (key, label, kind, def, help = "") => ({ key, label, kind, default: def, help });
export const RULE_TYPES = {
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

export const clone = (x) => JSON.parse(JSON.stringify(x));
function mk(id, type, name, severity, params = {}) {
  const d = {};
  for (const p of RULE_TYPES[type].params) d[p.key] = clone(p.default);
  return { id, name, type, enabled: true, severity, params: { ...d, ...params }, description: RULE_TYPES[type].desc };
}

export function defaultRules() {
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
export function validateRules(input) {
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
export function textOf(c) {
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
export function parseArgs(a) {
  if (typeof a === "string") { try { return JSON.parse(a); } catch { return a; } }
  return a ?? {};
}
const msg = (role, text = "", calls = [], results = []) => ({ role, text: text || "", calls, results });

export function detectProtocol(body) {
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

export function anthropicMsgs(body) {
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

export function normalizeRequest(body, protocol) {
  const p = NORMALIZERS[protocol] ? protocol : detectProtocol(body);
  return { protocol: p, messages: NORMALIZERS[p] ? NORMALIZERS[p](body) : [], ntools: Array.isArray(body?.tools) ? body.tools.length : 0 };
}

// onResponse 拿到的是 Magpie 拼好的整段回复（流式也拼成该协议的非流式形状）
export function parseReply(reply, protocol) {
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

export function usageOf(reply) {
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
export const scrub = (s) => typeof s === "string" ? s.replace(SECRET_RE, "[已脱敏]") : s;
export function stripInjected(t) {
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
export const readPathOf = (a) => { a = a || {}; return String(a.file_path || a.path || a.target_file || a.filePath || a.filename || a.url || a.query || a.pattern || ""); };
const sigLines = (t) => [...new Set(String(t || "").split("\n").map(l => l.trim()).filter(l => l.length > 3).map(h32))].slice(0, 400);
const nLines = (t) => t ? String(t).split("\n").length : 0;

const head = (t, n) => { t = String(t || ""); return t.length > n ? t.slice(0, n) + "…" : t; };
// 结果文本保留首尾（错误码、"N failed" 常在末尾）
const headTail = (t, n) => { t = String(t || ""); return t.length > 2 * n ? t.slice(0, n) + "\n…\n" + t.slice(-n) : t; };

// 按长度截断消息（先脱敏）。工具参数是对象时：序列化→脱敏截断→重新解析；
// 截断破坏了 JSON 就降级为 {_truncated}，绝不能让单条大参数丢掉整条记录。
export function clipMsg(m, n) {
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
export function compactMessage(m, lim = { user: 1200, assistant: 600, result: 500, cmd: 400 }) {
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
export function sessionKey(agent, sessHeader, msgs, sha) {
  const u = msgs.find((m) => m.role === "user" && stripInjected(m.text)) || msgs.find((m) => m.role === "system");
  const base = stripInjected(u?.text || "").slice(0, 2000);
  return `${agent || "unknown"}-${sha(`${agent}\0${sessHeader}\0${base}`).slice(0, 10)}`;
}

// 合并捕获记录与导入记录：会话级去重只针对「捕获 vs 导入」（捕获优先，避免同一会话重复计数）；
// 导入记录之间不去重——同一会话的多条增量记录（offset 切片）必须全部保留。
export function mergeCalls(captured, imported) {
  const ids = new Set(), hdrs = new Set();
  for (const c of captured) { if (c.session) ids.add(c.session); if (c.session_header) hdrs.add(c.session_header); }
  const out = captured.slice();
  for (const c of imported || []) {
    if ((c.session && ids.has(c.session)) || (c.session_header && hdrs.has(c.session_header))) continue;
    out.push(c);
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export function shiftDay(day, n) { return dayOf(Date.parse(`${day}T12:00:00`) + n * 86400000); }

export function buildSessions(calls) {
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
export class Ctx {
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

export function features(sess, ctx) {
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
export function taskTypeOf(s) {
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

export function sessionStats(s) {
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
export function detect(sessions, cfg) {
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
export function summarize(hits, sessions) {
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
export function groupIssues(hits, sessions, opts = {}) {
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

export const DEFAULTS = {
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

export function formatLocal(ts) {
  if (!ts) return "—";
  const d = new Date(ts), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
export function dayOf(ts) { const d = new Date(ts), p = (n) => String(n).padStart(2, "0"); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; }
