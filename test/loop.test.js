// P1 检测器：重复劳动 / 无进展循环 / 回归返工 + 问题片段聚合
import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, validateRules, buildSessions, detect, groupIssues } from "../page/core.js";
import { simulate, U, A, R } from "./sim.js";

const cfg = () => validateRules(defaultRules()).cfg;
const run = (calls, c = cfg()) => detect(buildSessions(calls), c);
const ids = (hits) => new Set(hits.map((h) => h.rule));

test("no_progress_loop：同一错误反复失败命中；错误各不相同不命中；恢复被识别", () => {
  const base = [{ add: [U("修一下")] }];
  // 同一错误 ×3
  const same = simulate("claude", base.concat([0, 1, 2].map((i) =>
    ({ add: [A("", [`t${i}`, "Bash", { command: "make test" }]), R(`t${i}`, "TypeError: cannot read property x of undefined", true)] }))));
  const h1 = run(same).filter((h) => h.rule === "no-progress-loop");
  assert.equal(h1.length, 1, "恰好一次");
  assert.equal(h1[0].count, 3);
  assert.equal(h1[0].recovered, false, "未见恢复");
  assert.ok(h1[0].tokens_in_window > 0, "窗口消耗 token 已统计");

  // 三种不同的错误 → 有进展，不命中
  const errs = ["TypeError: undefined is not a function", "SyntaxError: unexpected token", "Error: connect ETIMEDOUT"];
  const varied = simulate("claude", base.concat(errs.map((t, i) =>
    ({ add: [A("", [`v${i}`, "Bash", { command: "make test" }]), R(`v${i}`, t, true)] }))));
  assert.ok(!ids(run(varied)).has("no-progress-loop"), "错误在演化 = 有进展");

  // 失败 ×3 后同名命令成功 → recovered
  const recd = simulate("claude", base.concat(
    [0, 1, 2].map((i) => ({ add: [A("", [`t${i}`, "Bash", { command: "make test" }]), R(`t${i}`, "TypeError: cannot read property x of undefined", true)] })),
    [{ add: [A("", ["ok1", "Bash", { command: "make test" }]), R("ok1", "all tests passed")] }]));
  const h3 = run(recd).find((h) => h.rule === "no-progress-loop");
  assert.equal(h3.recovered, true, "检测到恢复");
});

test("repeated_work：重复读取 / 重复执行命中，验证性重跑不命中", () => {
  const base = [{ add: [U("看看代码")] }];
  // 重复读取同一文件，内容不变
  const reads = simulate("claude", base.concat([0, 1, 2].map((i) =>
    ({ add: [A("", [`r${i}`, "Read", { file_path: "/p/a.js" }]), R(`r${i}`, "const x = 1;\nconst y = 2;\nconst z = 3;\n")] }))));
  const rh = run(reads).find((h) => h.rule === "repeated-work");
  assert.ok(rh, "重复读取命中");
  assert.match(rh.evidence, /读取 .* 3 次结果完全相同/);

  // 失败→修改→成功：验证性重跑不算重复执行，也不算回归
  const LONG_A = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\nfunction c() {\n  return 3;\n}";
  const LONG_B = "function a() {\n  return 10;\n}\nfunction b() {\n  return 2;\n}\nfunction c() {\n  return 3;\n}";
  const verify = simulate("claude", [
    { add: [U("修测试")] },
    { add: [A("", ["c1", "Bash", { command: "npm test" }]), R("c1", "FAIL a\nexit code 1", true)] },
    { add: [A("", ["e1", "Edit", { file_path: "/p/x.js", old_string: LONG_A, new_string: LONG_B }]), R("e1", "ok")] },
    { add: [A("", ["c2", "Bash", { command: "npm test" }]), R("c2", "all good\nTests: 3 passed")] },
  ]);
  const vIds = ids(run(verify));
  assert.ok(!vIds.has("repeated-work"), "验证性重跑不报");
  assert.ok(!vIds.has("regression-rework"), "失败→修复→通过不是回归");
});

test("repeated_work：改了又改回去（翻转）命中，普通迭代不命中", () => {
  const ST = "function f() {\n  return 1;\n}\nfunction g() {\n  return 2;\n}\nfunction h() {\n  return 3;\n}";
  const ALT = "function f() {\n  return 9;\n}\nfunction g() {\n  return 8;\n}\nfunction h() {\n  return 3;\n}";
  const OTHER = "function f() {\n  return 9;\n}\nfunction g() {\n  return 8;\n}\nfunction h() {\n  return 33;\n}";
  // A → B → C(小迭代) → A：回到最初状态
  const flip = simulate("claude", [
    { add: [U("调函数")] },
    { add: [A("", ["e1", "Edit", { file_path: "/p/f.js", old_string: ST, new_string: ALT }]), R("e1", "ok")] },
    { add: [A("", ["e2", "Edit", { file_path: "/p/f.js", old_string: ALT, new_string: OTHER }]), R("e2", "ok")] },
    { add: [A("", ["e3", "Edit", { file_path: "/p/f.js", old_string: OTHER, new_string: ST }]), R("e3", "ok")] },
  ]);
  const fh = run(flip).filter((h) => h.rule === "repeated-work");
  assert.ok(fh.some((h) => /改了又改回去/.test(h.evidence)), `翻转命中：${JSON.stringify(fh.map((h) => h.evidence))}`);

  // A → B → C 连续小步迭代（增量保留）不命中
  const iter = simulate("claude", [
    { add: [U("调函数")] },
    { add: [A("", ["e1", "Edit", { file_path: "/p/f.js", old_string: ST, new_string: ALT }]), R("e1", "ok")] },
    { add: [A("", ["e2", "Edit", { file_path: "/p/f.js", old_string: ALT, new_string: OTHER }]), R("e2", "ok")] },
  ]);
  assert.ok(!run(iter).some((h) => h.rule === "repeated-work" && /改了又改回去/.test(h.evidence)), "迭代不报翻转");
});

test("regression_rework：先通过、修改后失败 → 命中；之间无修改 → 不命中", () => {
  const base = [
    { add: [U("保持绿的测试")] },
    { add: [A("", ["p1", "Bash", { command: "npm test" }]), R("p1", "Tests: 5 passed")] },
  ];
  const withEdit = simulate("claude", base.concat([
    { add: [A("", ["e1", "Edit", { file_path: "/p/y.js", old_string: "const q = 1;\nconst w = 2;", new_string: "const q = 2;\nconst w = 2;" }]), R("e1", "ok")] },
    { add: [A("", ["f1", "Bash", { command: "npm test" }]), R("f1", "FAIL q\nexit code 1", true)] },
  ]));
  const h = run(withEdit).find((x) => x.rule === "regression-rework");
  assert.ok(h, "回归命中");
  assert.match(h.evidence, /先前通过/);

  // 失败→失败（之间无编辑）：不是回归
  const noEdit = simulate("claude", base.concat([
    { add: [A("", ["f1", "Bash", { command: "npm test" }]), R("f1", "FAIL q\nexit code 1", true)] },
  ]));
  assert.ok(!ids(run(noEdit)).has("regression-rework"), "无修改的失败不是回归");
});

test("groupIssues：相关信号聚成一个片段，带证据链/影响/根因假设", () => {
  const turns = [{ add: [U("修 make")] }];
  for (let i = 0; i < 3; i++)
    turns.push({ add: [A("", [`t${i}`, "Bash", { command: "make test" }]), R(`t${i}`, "TypeError: cannot read property x of undefined", true)] });
  const calls = simulate("claude", turns);
  const sessions = buildSessions(calls);
  const hits = detect(sessions, cfg());
  const issues = groupIssues(hits, sessions);
  assert.ok(issues.length >= 1, "聚合出问题");
  const top = issues[0];
  assert.ok(top.rules.length >= 2, `多个信号合并（实际 ${top.rules.length}）`);
  assert.equal(top.root_cause.status, "hypothesis");
  assert.equal(top.root_cause.category, "insufficient_diagnosis");
  assert.ok(top.impact.rework_operations >= 3, "返工操作计数");
  assert.ok(top.evidence.length >= 2, "证据链");
  assert.ok(top.confidence > 0.5, "置信度");
  assert.ok(top.msg_from != null && top.msg_to >= top.msg_from, "消息范围");
  // 时间上相距很远的命中不合并：构造另一个会话验证独立成片段
  assert.ok(issues.every((i) => i.id.startsWith("issue-claude-s-")), "issue id 稳定");
});
