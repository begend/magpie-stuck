// 在 node:vm 里跑 page/app.bundle.js，用假的 bridge 与 DOM，检查页面渲染与保存规则
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildSessions } from "../page/core.js";
import { simulate, U, A, R } from "./sim.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = fs.readFileSync(path.join(root, "page/app.bundle.js"), "utf8");

function fakeDom() {
  const els = {};
  const mk = (id) => ({ id, innerHTML: "", textContent: "", value: "", classList: { toggle() {}, add() {}, remove() {} }, scrollIntoView() {} });
  const listeners = {};
  return { els, listeners, document: {
    getElementById: (id) => (els[id] ||= mk(id)),
    querySelectorAll: () => [], querySelector: () => null,
    addEventListener: (t, f) => { listeners[t] = f; },
    createElement: () => ({ click() {}, remove() {} }), body: { appendChild() {} },
  } };
}

function snapshot() {
  const turns = [{ add: [U("修一下测试")] }];
  for (let i = 0; i < 3; i++) turns.push({ add: [A("", [`t${i}`, "Bash", { command: "npm test" }]), R(`t${i}`, "2 failed\nexit code 1")] });
  const calls = simulate("claude", turns, { t0: Date.now() - 60000 });
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  const day = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return { updatedAt: Date.now(), stats: { captured: 4 }, bytes: 1000, days: [{ day, calls: calls.length, sessions: buildSessions(calls) }] };
}

test("页面：看板/会话/规则/导出 渲染，保存规则去掉 _status", async () => {
  const { els, listeners, document } = fakeDom();
  let saved = null;
  const opts = { publishSeconds: 90, _status: snapshot() };
  const magpie = { ready: Promise.resolve(), options: { get: async () => JSON.parse(JSON.stringify(saved || opts)), set: async (o) => { saved = o; } } };
  const ctx = { window: { magpie }, magpie, document, setInterval: () => 0, setTimeout, console, URL, Blob, confirm: () => true,
    fetch: () => { throw new Error("CSP: 页面里不能 fetch"); } };
  vm.createContext(ctx);
  vm.runInContext(bundle, ctx);
  await new Promise((r) => setTimeout(r, 50));
  assert.match(els.dash.innerHTML, /卡点明细/);
  assert.match(els.dash.innerHTML, /工具调用失败重试/);
  assert.match(els.dash.innerHTML, /测试\/编译反复失败/);
  const click = async (dataset, extra = {}) => { const el = { dataset, ...extra }; await listeners.click({ target: { closest: () => el } }); };
  await click({ tab: "sess" });
  assert.match(els.sess.innerHTML, /修一下测试/);
  assert.match(els.sess.innerHTML, /npm test/);
  await click({ tab: "rules" });
  assert.match(els.rules.innerHTML, /保存规则/);
  assert.equal((els.rules.innerHTML.match(/class="rule /g) || []).length, 15);
  // 停用一条规则 → 预览 → 保存
  await click({ act: "enable", rule: "0" }, { checked: false });
  await click({ act: "preview" });
  assert.match(els.rules.innerHTML, /预览/);
  await click({ act: "save" });
  assert.ok(saved, "调用了 options.set");
  assert.equal(saved._status, undefined, "保存时不带快照");
  assert.equal(saved.publishSeconds, 90);
  assert.equal(saved.rules.rules[0].enabled, false);
  await click({ tab: "export" });
  assert.match(els.export.innerHTML, /下载 JSON/);
  assert.match(els.export.innerHTML, /tool-error-retry/);
});
