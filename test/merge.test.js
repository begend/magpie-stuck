// 合并去重、日期工具、clipMsg 修复、历史导入器（Claude Code / Codex 夹具）
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { mergeCalls, shiftDay, sessionKey, clipMsg } from "../page/core.js";
import { importAll, importedOverview } from "../scripts/import-history.mjs";
import { simulate, U } from "./sim.js";

const sha1 = (s) => crypto.createHash("sha1").update(s).digest("hex");

test("mergeCalls：同一会话以捕获为准，其他会话照常并入", () => {
  const captured = simulate("claude", [{ add: [U("hello")] }]);            // session = claude-s
  const same = simulate("claude", [{ add: [U("hello")] }, { add: [{ role: "assistant", content: "x" }] }]);
  const other = simulate("codex", [{ add: [U("world")] }], { session: "t" });
  assert.equal(mergeCalls(captured, same).length, captured.length, "同会话的导入整段跳过");
  const merged = mergeCalls(captured, other);
  assert.equal(merged.length, captured.length + other.length);
  assert.ok([...merged].sort((a, b) => a.ts - b.ts).every((c, i, a2) => i === 0 || a2[i - 1].ts <= c.ts), "合并后按时间有序");
  // 会话头哈希相同也去重
  captured[0].session_header = "hdr-1";
  const hdrDup = other.map((c) => ({ ...c, session: "unrelated", session_header: "hdr-1" }));
  assert.equal(mergeCalls(captured, hdrDup).length, captured.length);
  // 导入记录内部：同一会话的多条增量记录必须全部保留（不能误判成重复）
  const multi = simulate("codex", [{ add: [U("a")] }, { add: [{ role: "assistant", content: "b" }] }], { session: "m" });
  assert.equal(multi.length, 2);
  assert.equal(mergeCalls([], multi).length, 2, "同会话增量记录全保留");
});

test("shiftDay / sessionKey", () => {
  assert.equal(shiftDay("2026-10-29", -1), "2026-10-28");
  assert.equal(shiftDay("2026-10-01", -1), "2026-09-30");
  assert.equal(shiftDay("2026-12-31", 1), "2027-01-01");
  const k = sessionKey("claude", "uuid-1", [{ role: "user", text: "hi" }], sha1);
  assert.equal(k, sessionKey("claude", "uuid-1", [{ role: "user", text: "hi" }], sha1));
  assert.notEqual(k, sessionKey("claude", "uuid-2", [{ role: "user", text: "hi" }], sha1));
  assert.match(k, /^claude-[0-9a-f]{10}$/);
});

test("clipMsg：超长工具参数降级为 _truncated，不再丢整条记录", () => {
  const m = { role: "assistant", text: "ok",
    calls: [{ id: "w1", name: "Write", args: { file_path: "/p/big.js", content: "x".repeat(30000) } }], results: [] };
  const c = clipMsg(m, 20000);
  assert.ok(c.calls[0].args._truncated, "截断参数降级为 _truncated");
  assert.doesNotThrow(() => JSON.stringify(c));
  // 未超长的对象参数保持对象形状
  const small = clipMsg({ ...m, calls: [{ id: "w", name: "Edit", args: { old_string: "a", new_string: "b" } }] }, 20000);
  assert.equal(small.calls[0].args.old_string, "a");
  // 字符串参数照常截断+脱敏
  const str = clipMsg({ role: "assistant", text: "", calls: [{ id: "s", name: "patch", args: "sk-abcdefghijklmnopqrstuvwx " + "y".repeat(30000) }], results: [] }, 100);
  assert.ok(String(str.calls[0].args).includes("[已脱敏]") && String(str.calls[0].args).length < 200);
});

// ---------- 导入器夹具 ----------
function writeClaudeFixture(dir, uuid) {
  const pd = path.join(dir, "-Users-jack-proj");
  fs.mkdirSync(pd, { recursive: true });
  const entries = [
    { type: "user", uuid: "u1", parentUuid: null, timestamp: "2026-10-28T02:00:00Z", cwd: "/Users/jack/proj", message: { role: "user", content: "修一下测试" } },
    { type: "assistant", uuid: "a1", parentUuid: "u1", timestamp: "2026-10-28T02:00:10Z", cwd: "/Users/jack/proj",
      message: { role: "assistant", model: "m1", content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 1000, cache_read_input_tokens: 200, output_tokens: 50 } } },
    { type: "user", uuid: "u2", parentUuid: "a1", timestamp: "2026-10-28T02:00:20Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "FAIL\nexit code 1", is_error: true }] } },
    { type: "assistant", uuid: "a2", parentUuid: "u2", timestamp: "2026-10-28T02:00:30Z",
      message: { role: "assistant", model: "m1", content: [{ type: "text", text: "我看看" }], usage: { input_tokens: 3000, output_tokens: 30 } } },
    { type: "file-history-snapshot", messageId: "x" },   // 应被忽略的条目类型
  ];
  fs.writeFileSync(path.join(pd, `${uuid}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}
function writeCodexFixture(dir, uuid) {
  const pd = path.join(dir, "2026", "10", "27");
  fs.mkdirSync(pd, { recursive: true });
  const entries = [
    { timestamp: "2026-10-27T02:00:00Z", type: "session_meta", payload: { session_id: uuid, id: uuid, cwd: "/Users/jack/cproj" } },
    { timestamp: "2026-10-27T02:00:01Z", type: "turn_context", payload: { model: "gpt-6" } },
    { timestamp: "2026-10-27T02:00:02Z", type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "跑下构建" }] } },
    { timestamp: "2026-10-27T02:00:03Z", type: "response_item", payload: { type: "function_call", call_id: "c1", name: "shell", arguments: JSON.stringify({ command: ["bash", "-lc", "make test"] }) } },
    { timestamp: "2026-10-27T02:00:04Z", type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 500, cached_input_tokens: 100, output_tokens: 40 } } } },
    { timestamp: "2026-10-27T02:00:05Z", type: "response_item", payload: { type: "function_call_output", call_id: "c1", output: "error: build failed" } },
    { timestamp: "2026-10-27T02:00:06Z", type: "compacted", payload: {} },
    { timestamp: "2026-10-27T02:00:07Z", type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "继续修" }] } },
  ];
  fs.writeFileSync(path.join(pd, `rollout-2026-10-27T10-00-00-${uuid}.jsonl`), entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
}

test("导入器：夹具转换、落盘、usage 补齐、捕获优先去重、manifest 幂等", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-stuck-import-"));
  const cfgDir = path.join(tmp, "cfg"), claudeDir = path.join(tmp, "claude"), codexDir = path.join(tmp, "codex");
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "plugins.json"), JSON.stringify({ plugins: [] }));
  const cUuid = "b4494e7b-1111-2222-3333-444455556666", xUuid = "01a1582b-aaaa-bbbb-cccc-ddddeeeeffff";
  writeClaudeFixture(claudeDir, cUuid);
  writeCodexFixture(codexDir, xUuid);
  // Magpie usage.jsonl：给 codex 会话补真实耗时/状态（时间与调用对齐在 2 万毫秒窗口内）
  fs.writeFileSync(path.join(cfgDir, "usage.jsonl"), JSON.stringify({ t: "2026-10-27T02:00:03.500Z", agent: "codex", session: xUuid, ms: 4200, status: 200, in: 480, out: 42, cache_read: 100, cache_write: 0, served: "gpt-6-mini", provider: "nibroute" }) + "\n");

  const env = { cfgDir, claudeDir, codexDir, log: () => {} };
  const s1 = importAll(env);
  assert.equal(s1.imported, 2, "两个会话都导入");
  assert.ok(s1.records >= 4, `记录数 ${s1.records}`);
  assert.equal(Object.keys(s1.days).length, 2, "落在两个日期（按时区）");

  // claude 记录形状与 usage 自带 token
  const cLines = fs.readFileSync(path.join(cfgDir, "magpie-stuck/imported/2026-10-28.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(cLines[0].agent, "claude");
  assert.equal(cLines[0].origin, "imported");
  assert.equal(cLines[0].session_header, sha1(cUuid).slice(0, 12), "会话头 = uuid 哈希（与网关记录同算法）");
  assert.equal(cLines[0].session, `claude-${sessionKey("claude", cUuid, [{ role: "user", text: "修一下测试" }], sha1).split("-")[1]}`);
  assert.equal(cLines[0].in_tok, 1200, "input+cache_read");
  assert.equal(cLines[0].msgs[1].calls[0].cmd, "npm test", "工具调用在 assistant 消息上");

  // codex 记录：usage.jsonl 补耗时/状态/实际模型；compacted → 第二条 offset 归 0（历史被裁剪）
  const xLines = fs.readFileSync(path.join(cfgDir, "magpie-stuck/imported/2026-10-27.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(xLines.length, 2);
  assert.equal(xLines[0].latency_ms, 4200, "usage.jsonl 补真实耗时");
  assert.equal(xLines[0].ok, true);
  assert.equal(xLines[0].served, "gpt-6-mini");
  assert.equal(xLines[1].offset, 0, "压缩后 offset 归 0");
  assert.equal(xLines[1].msgs[0].text, "继续修");
  assert.equal(xLines[0].in_tok, 600, "500 输入 + 100 缓存（token_count 事件）");

  // 概览能跑规则
  const ov = importedOverview(cfgDir);
  assert.ok(ov.calls >= 4 && ov.sessions === 2, "概览统计");

  // 再跑一次：manifest 命中，全部跳过
  const s2 = importAll(env);
  assert.equal(s2.imported, 0);
  assert.equal(s2.skippedManifest, 2);

  // 捕获优先：写入带相同会话头的捕获记录后重置 manifest → 整会话跳过
  fs.rmSync(path.join(cfgDir, "magpie-stuck/imported"), { recursive: true, force: true });
  fs.mkdirSync(path.join(cfgDir, "magpie-stuck/calls"), { recursive: true });
  fs.writeFileSync(path.join(cfgDir, "magpie-stuck/calls/2026-10-28.jsonl"),
    JSON.stringify({ ts: 1, agent: "claude", session: "claude-live", session_header: sha1(cUuid).slice(0, 12), msgs: [], offset: 0 }) + "\n");
  const s3 = importAll(env);
  assert.equal(s3.imported, 1, "只有 codex 导入");
  assert.equal(s3.skippedDup, 1, "claude 会话被捕获去重");
  assert.ok(!fs.existsSync(path.join(cfgDir, "magpie-stuck/imported/2026-10-28.jsonl")), "被跳过的会话不落盘");
  fs.rmSync(tmp, { recursive: true, force: true });
});
