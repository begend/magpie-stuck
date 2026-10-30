// P2 检测器：完成声明缺验证 / 需求偏离 + 会话质量指标 + 任务类型分桶
import test from "node:test";
import assert from "node:assert/strict";
import { defaultRules, validateRules, buildSessions, detect, sessionStats, features, Ctx } from "../page/core.js";
import { simulate, U, A, R } from "./sim.js";

const cfg = () => validateRules(defaultRules()).cfg;
const run = (calls, c = cfg()) => detect(buildSessions(calls), c);
const ids = (hits) => new Set(hits.map((h) => h.rule));
const EDIT = { file_path: "/p/z.js", old_string: "const a = 1;\nconst b = 2;", new_string: "const a = 2;\nconst b = 2;" };

test("done_without_evidence：无验证/验证失败后宣布完成命中；已验证、受阻、纯问答不命中", () => {
  const noVerify = simulate("claude", [
    { add: [U("改一下")] },
    { add: [A("", ["e1", "Edit", EDIT]), R("e1", "ok")] },
    { add: [A("已经完成，搞定。")] },
  ]);
  const h1 = run(noVerify).find((h) => h.rule === "done-without-evidence");
  assert.ok(h1, "无验证命中");
  assert.equal(h1.status, "implemented");

  const failed = simulate("claude", [
    { add: [U("改一下")] },
    { add: [A("", ["e1", "Edit", EDIT]), R("e1", "ok")] },
    { add: [A("", ["c1", "Bash", { command: "npm test" }]), R("c1", "FAIL x\nexit code 1", true)] },
    { add: [A("已修复，全部通过。")] },
  ]);
  const h2 = run(failed).find((h) => h.rule === "done-without-evidence");
  assert.ok(h2, "验证失败仍宣布完成命中");
  assert.equal(h2.status, "failed_verify", "状态 = failed_verify");

  const verified = simulate("claude", [
    { add: [U("改一下")] },
    { add: [A("", ["e1", "Edit", EDIT]), R("e1", "ok")] },
    { add: [A("", ["c1", "Bash", { command: "npm test" }]), R("c1", "Tests: 5 passed")] },
    { add: [A("已完成。")] },
  ]);
  assert.ok(!ids(run(verified)).has("done-without-evidence"), "验证通过后宣布完成不报");

  const blocked = simulate("claude", [
    { add: [U("改一下")] },
    { add: [A("", ["e1", "Edit", EDIT]), R("e1", "ok")] },
    { add: [A("做不完，环境无法访问。")] },
  ]);
  assert.ok(!ids(run(blocked)).has("done-without-evidence"), "说明受阻不报");

  const chat = simulate("claude", [{ add: [U("解释下 x")] }, { add: [A("讲解完成。")] }]);
  assert.ok(!ids(run(chat)).has("done-without-evidence"), "无代码会话不报");
});

test("requirement_drift：约束违反 + 重复纠偏命中；范围漂移默认关", () => {
  const drift = simulate("claude", [
    { add: [U("只分析，不要改代码")] },
    { add: [A("", ["e1", "Edit", EDIT]), R("e1", "ok")] },
    { add: [U("我说的是别动文件")] },
  ]);
  const hits = run(drift).filter((h) => h.rule === "requirement-drift");
  const cv = hits.find((h) => h.kind === "constraint_violation");
  assert.ok(cv, "约束违反命中");
  assert.match(cv.evidence, /只分析/);

  const repeat = simulate("claude", [
    { add: [U("修一下")] },
    { add: [A("我看看")] },
    { add: [U("不对，不是这样")] },
    { add: [A("再改改")] },
    { add: [U("还是不对")] },
  ]);
  const rc = run(repeat).find((h) => h.rule === "requirement-drift" && h.kind === "repeat_correction");
  assert.ok(rc, "重复纠偏命中");
  assert.ok(rc.count >= 2);

  assert.ok(!hits.some((h) => h.kind === "scope_drift"), "范围漂移默认不检测");
});

test("sessionStats：重复失败率 / 首验 / 纠偏 / 时间构成 / 任务类型", () => {
  const calls = simulate("claude", [
    { add: [U("修复登录 bug")], latency_ms: 5000 },
    { add: [A("", ["c1", "Bash", { command: "npm test" }]), R("c1", "FAIL x\nexit code 1", true)], latency_ms: 4000 },
    { add: [A("", ["c2", "Bash", { command: "npm test" }]), R("c2", "FAIL x\nexit code 1", true)], latency_ms: 3000 },
    { add: [U("还是不对")], latency_ms: 2000 },
  ], { t0: Date.parse("2026-10-28T10:00:00+08:00") });
  const s = buildSessions(calls)[0];
  features(s, new Ctx(cfg().settings));
  const st = sessionStats(s);
  assert.equal(st.repeat_fail_ratio, 0.5, "两次失败同一签名 = 50% 重复");
  assert.equal(st.first_verify_pass, false, "首次验证失败");
  assert.equal(st.corrections, 1, "纠偏 1 次");
  assert.equal(st.task_type, "修复");
  assert.ok(st.wall_ms > 0 && st.idle_ms > 0, "时间构成");
  assert.equal(st.wall_ms, st.active_ms + st.idle_ms, "墙钟 = 活跃 + 间隙");
});

test("slow_costly：按任务类型分桶比较", () => {
  let calls = [];
  const t0 = Date.parse("2026-10-28T10:00:00+08:00");
  for (let i = 0; i < 6; i++)
    calls = calls.concat(simulate("claude", [{ add: [U("修复问题 " + i)], latency_ms: i === 5 ? 60000 : 3000, in_tok: 5000 }],
      { session: "s" + i, t0: t0 + i * 100000 }));
  const hits = run(calls).filter((h) => h.rule === "slow-costly");
  assert.ok(hits.length >= 1, "慢会话命中");
  assert.match(hits[0].evidence, /修复/, `分组是任务类型：${hits[0].evidence}`);
});

test("tool_error_retry：参数完全相同的重试标记为盲试", () => {
  const calls = simulate("claude", [{ add: [U("跑下")] }].concat([0, 1, 2].map((i) =>
    ({ add: [A("", [`t${i}`, "Bash", { command: "make" }]), R(`t${i}`, "boom", true)] }))));
  const h = run(calls).find((x) => x.rule === "tool-error-retry");
  assert.ok(h, "命中");
  assert.equal(h.blind, true, "标记盲试");
  assert.match(h.evidence, /盲试/);
});

test("command_repeat_fail：同根因（同错误签名）跨命令失败链", () => {
  const calls = simulate("claude", [{ add: [U("修构建")] },
    { add: [A("", ["c1", "Bash", { command: "npm run build" }]), R("c1", "Module not found: ./x", true)] },
    { add: [A("", ["c2", "Bash", { command: "yarn build" }]), R("c2", "Module not found: ./x", true)] },
  ]);
  const h = run(calls).find((x) => x.rule === "cmd-repeat-fail");
  assert.ok(h, "同错误跨命令命中");
  assert.match(h.evidence, /同一错误出现在 2 条命令/);
});
