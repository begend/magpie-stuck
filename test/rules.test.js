import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, validateRules, buildSessions, detect, summarize, normalizeRequest, parseReply, usageOf, scrub, RULE_TYPES } from "../page/core.js";
import { simulate, U, A, R } from "./sim.js";

const cfg = () => validateRules(defaultRules()).cfg;
const run = (calls, c = cfg()) => detect(buildSessions(calls), c);
const ids = (hits) => new Set(hits.map((h) => h.rule));

test("默认规则：15 条，全部通过校验", () => {
  const d = defaultRules();
  assert.equal(d.rules.length, 15);
  const { errors } = validateRules(d);
  assert.deepEqual(errors, []);
  for (const r of d.rules) assert.ok(RULE_TYPES[r.type]);
});

test("校验：坏正则、未知类型、重复 id、非数字", () => {
  const d = defaultRules();
  d.rules[0].params.tool_regex = "([";
  d.rules[1].params.min_failures = "abc";
  d.rules.push({ id: "tool-error-retry", type: "tool_error_retry" });
  d.rules.push({ id: "x", type: "nope" });
  const { errors } = validateRules(d);
  assert.ok(errors.some((e) => e.includes("正则无效")));
  assert.ok(errors.some((e) => e.includes("要填数字")));
  assert.ok(errors.some((e) => e.includes("重复")));
  assert.ok(errors.some((e) => e.includes("类型未知")));
});

test("工具调用失败重试 + 测试反复失败", () => {
  const turns = [{ add: [U("修一下测试")] }];
  for (let i = 0; i < 3; i++) turns.push({ add: [A("", [`t${i}`, "Bash", { command: "npm test -- foo" }]), R(`t${i}`, "FAIL src/a.test.js\nTests: 2 failed, 3 passed\nexit code 1")] });
  const hits = run(simulate("claude", turns));
  assert.ok(ids(hits).has("tool-error-retry"));
  assert.ok(ids(hits).has("cmd-repeat-fail"));
});

test("打转：同一区域反复编辑", () => {
  const turns = [{ add: [U("改 foo")] }];
  const vers = ["return a + b;", "return a - b;", "return a * b;", "return a / b;"];
  for (let i = 0; i < 3; i++) turns.push({ add: [A("", [`e${i}`, "Edit", { file_path: "/p/x.js", old_string: "function f(a, b) {\n  " + vers[i], new_string: "function f(a, b) {\n  " + vers[i + 1] }]), R(`e${i}`, "ok")] });
  const hits = run(simulate("claude", turns));
  const h = hits.find((x) => x.rule === "edit-churn");
  assert.ok(h, "edit-churn 命中");
  assert.equal(h.file, "/p/x.js");
});

test("推翻：一次删除大量行 + 话术", () => {
  const old = Array.from({ length: 80 }, (_, i) => `line ${i} of old impl`).join("\n");
  const hits = run(simulate("claude", [{ add: [U("实现 x")] },
    { add: [A("这样不行，换个思路，重写这个模块", ["w1", "Edit", { file_path: "/p/y.py", old_string: old, new_string: "pass" }]), R("w1", "ok")] }]));
  const rw = hits.filter((h) => h.rule === "rewrite");
  assert.ok(rw.some((h) => h.deleted === 80));
  assert.ok(rw.some((h) => h.keyword));
});

test("盲目探索：连续 8 轮只读", () => {
  const turns = [{ add: [U("找一下 bug")] }];
  for (let i = 0; i < 9; i++) turns.push({ add: [A("", [`r${i}`, i % 2 ? "Read" : "Bash", i % 2 ? { file_path: `/p/${i}` } : { command: `grep -rn foo src/${i}` }]), R(`r${i}`, "...")] });
  assert.ok(ids(run(simulate("claude", turns))).has("blind-explore"));
});

test("上下文膨胀 + 历史被裁剪", () => {
  const calls = simulate("claude", [{ add: [U("a")], in_tok: 20000 }, { add: [A("x"), U("b")], in_tok: 90000 }]);
  calls.push({ ...calls[1], ts: calls[1].ts + 9000, offset: 0, nmsgs: 1, msgs: [{ role: "user", text: "This session is being continued from a previous conversation", h: "zz" }] });
  const hits = run(calls).filter((h) => h.rule === "context-bloat");
  assert.ok(hits.some((h) => h.evidence.includes("涨到")));
  assert.ok(hits.some((h) => h.evidence.includes("裁剪")));
  assert.ok(hits.some((h) => h.evidence.includes("压缩提示")));
});

test("人工纠偏 + 模型切换（无代码会话不判完成声明）", () => {
  const hits = run(simulate("claude", [
    { add: [U("修复登录")], model: "opus" },
    { add: [A("已修复，登录现在正常了。"), U("不对，还是报错 500")], model: "opus" },
    { add: [A("我看看")], model: "sonnet" },
  ]));
  const s = ids(hits);
  assert.ok(s.has("user-correction"));
  assert.ok(!s.has("done-without-evidence"), "无代码修改的会话不判完成声明");
  assert.ok(s.has("model-switch"));
});

test("慢和贵：耗时 / token 远高于中位数", () => {
  let calls = [];
  for (let i = 0; i < 6; i++) calls = calls.concat(simulate("codex", [{ add: [U("任务 " + i)], latency_ms: i === 5 ? 60000 : 3000, in_tok: i === 5 ? 200000 : 5000 }], { session: "s" + i, t0: Date.parse("2026-10-28T10:00:00+08:00") + i * 100000 }));
  const hits = run(calls);
  assert.ok(hits.some((h) => h.rule === "slow-costly"));
  assert.ok(hits.some((h) => h.rule === "slow-costly-cost"));
});

test("停用规则 / 改阈值即时生效，自定义关键词规则", () => {
  const turns = [{ add: [U("修测试")] }];
  for (let i = 0; i < 3; i++) turns.push({ add: [A("", [`t${i}`, "Bash", { command: "pytest" }]), R(`t${i}`, "1 failed")] });
  const calls = simulate("claude", turns);
  const c = cfg();
  c.rules.find((r) => r.id === "cmd-repeat-fail").enabled = false;
  c.rules.find((r) => r.id === "tool-error-retry").params.min_consecutive = 4;
  c.rules.push({ id: "kw", name: "提到测试", type: "keyword", severity: "low", params: { roles: ["user"], keywords: ["修测试"] } });
  const v = validateRules(c);
  assert.deepEqual(v.errors, []);
  const s = ids(run(calls, v.cfg));
  assert.ok(!s.has("cmd-repeat-fail") && !s.has("tool-error-retry"));
  assert.ok(s.has("kw"));
});

test("OpenAI chat / responses 形状归一化，回复与 usage 解析", () => {
  const chat = normalizeRequest({ model: "gpt", messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" },
    { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "shell", arguments: '{"command":["bash","-lc","make test"]}' } }] },
    { role: "tool", tool_call_id: "c1", content: "error: build failed" }] }, "chat");
  assert.equal(chat.messages.length, 4);
  assert.equal(chat.messages[2].calls[0].args.command[2], "make test");
  const resp = normalizeRequest({ model: "gpt-5", instructions: "x", input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "go" }] },
    { type: "function_call", call_id: "f1", name: "exec_command", arguments: '{"cmd":"ls"}' }, { type: "function_call_output", call_id: "f1", output: "a b" }] }, "responses");
  assert.deepEqual(resp.messages.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal(parseReply({ choices: [{ message: { role: "assistant", content: "done" } }] }).text, "done");
  assert.equal(parseReply({ content: [{ type: "text", text: "ok" }, { type: "tool_use", id: "x", name: "Bash", input: { command: "ls" } }] }).calls[0].name, "Bash");
  assert.equal(parseReply({ output: [{ type: "message", content: [{ type: "output_text", text: "yo" }] }] }).text, "yo");
  assert.deepEqual(usageOf({ usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 5 } }), { in_tok: 100, out_tok: 5, cache_read: 90 });
  assert.deepEqual(usageOf({ usage: { prompt_tokens: 7, completion_tokens: 3 } }), { in_tok: 7, out_tok: 3, cache_read: 0 });
});

test("脱敏", () => {
  assert.equal(scrub("key sk-abcdefghijklmnopqrstuvwxyz123 ok"), "key [已脱敏] ok");
});

test("summarize 计数", () => {
  const hits = run(simulate("claude", [{ add: [U("a")] }, { add: [A("已完成"), U("不对")] }]));
  const s = summarize(hits, buildSessions(simulate("claude", [{ add: [U("a")] }])));
  assert.ok(s.by_rule.length >= 1 && s.hits === hits.length);
});
