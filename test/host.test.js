// 在真实 Bun 里加载 stuck.hooks.js（和 Magpie 插件宿主一样），喂几次调用，检查落盘与快照
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const hasBun = spawnSync("bun", ["--version"]).status === 0;

test("hooks：记录调用、跳过 remote、发布快照、导出", { skip: !hasBun && "没有 bun" }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "magpie-stuck-"));
  fs.writeFileSync(path.join(dir, "plugins.json"), JSON.stringify({ plugins: [{ spec: root, options: { publishSeconds: 0, keepMe: 1 } }] }));
  const script = `
    const h = await import(${JSON.stringify(path.join(root, "stuck.hooks.js"))});
    const msgs = [{ role: "user", content: "修一下测试 sk-abcdefghijklmnopqrstuvwx1234" }];
    for (let i = 0; i < 4; i++) {
      const ctx = { origin: "local", protocol: "anthropic", model: "m1", agent: "claude", session: "S1", state: {} };
      ctx.request = { model: "m1", system: "x", max_tokens: 10, messages: JSON.parse(JSON.stringify(msgs)) };
      await h.onRequest(ctx.request, ctx);
      const reply = { model: "m1", content: [{ type: "tool_use", id: "t" + i, name: "Bash", input: { command: "npm test" } }], usage: { input_tokens: 100, output_tokens: 5 } };
      ctx.success = true;
      await h.onResponse(reply, ctx);
      msgs.push({ role: "assistant", content: reply.content }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t" + i, content: "Tests: 1 failed\\nexit code 1", is_error: true }] });
    }
    await h.onResponse(null, { origin: "remote", request: { messages: [] }, state: {} });
    await new Promise((r) => setTimeout(r, 2600));
    console.log(h.exportDay(new Date().toLocaleDateString("sv")));
    process.exit(0);`;
  const r = spawnSync("bun", ["-e", script], { env: { ...process.env, MAGPIE_STUCK_CONFIG_DIR: dir }, encoding: "utf8", timeout: 20000 });
  assert.equal(r.status, 0, r.stderr);
  const day = fs.readdirSync(path.join(dir, "magpie-stuck/calls"))[0];
  const lines = fs.readFileSync(path.join(dir, "magpie-stuck/calls", day), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 4, "remote 调用被跳过");
  assert.equal(lines[1].offset, 2, "增量存储");
  const raw = fs.readFileSync(path.join(dir, "magpie-stuck/calls", day), "utf8");
  assert.ok(!raw.includes("sk-abcdefghijklmnopqrstuvwx1234") && raw.includes("[已脱敏]"));
  assert.equal((fs.statSync(path.join(dir, "magpie-stuck/calls", day)).mode & 0o777).toString(8), "600");
  const pj = JSON.parse(fs.readFileSync(path.join(dir, "plugins.json"), "utf8"));
  const o = pj.plugins[0].options;
  assert.equal(o.keepMe, 1, "保留用户 options");
  assert.equal(o._status.days[0].sessions.length, 1);
  assert.ok(o._status.days[0].hostHits >= 2);
  const exp = JSON.parse(fs.readFileSync(r.stdout.trim(), "utf8"));
  assert.ok(exp.hits.some((h) => h.rule === "tool-error-retry"));
  fs.rmSync(dir, { recursive: true, force: true });
});
