#!/usr/bin/env node
// 命令行导出一段日期范围的卡点（合并捕获 + 导入的历史会话，mergeCalls 会话级去重）。
// 用法：node scripts/export-range.mjs YYYY-MM-DD YYYY-MM-DD [--out file.json] [--csv]
// 端点闭区间；最多 62 天。数据目录：MAGPIE_STUCK_CONFIG_DIR 或 $XDG_CONFIG_HOME/magpie 或 ~/.config/magpie 下的 magpie-stuck/
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { buildSessions, detect, summarize, validateRules, defaultRules, shiftDay, mergeCalls, formatLocal, SEVERITY_LABEL } from "../page/core.js";

const args = process.argv.slice(2);
const days = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a)).sort();
if (days.length < 2) { console.error("用法：node scripts/export-range.mjs YYYY-MM-DD YYYY-MM-DD [--out file.json] [--csv]"); process.exit(1); }
const [from, to] = [days[0], days[days.length - 1]];
const CFG_DIR = process.env.MAGPIE_STUCK_CONFIG_DIR || path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "magpie");
let opt = {};
try {
  const pj = JSON.parse(fs.readFileSync(path.join(CFG_DIR, "plugins.json"), "utf8"));
  const mine = (pj.plugins ?? []).find((p) => typeof p?.spec === "string" && p.spec.toLowerCase().includes("magpie-stuck"));
  opt = mine?.options || {};
} catch {}
const dir = path.isAbsolute(opt.outputDir || "") ? opt.outputDir : path.join(CFG_DIR, opt.outputDir || "magpie-stuck");
const readJsonl = (sub, day) => {
  const out = [];
  try {
    for (const line of fs.readFileSync(path.join(dir, sub, `${day}.jsonl`), "utf8").split("\n")) {
      if (line.trim()) try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {}
  return out;
};
const calls = [];
for (let d = from, i = 0; d <= to && i < 62; d = shiftDay(d, 1), i++) calls.push(...mergeCalls(readJsonl("calls", d), readJsonl("imported", d)));
if (!calls.length) { console.error(`${from} ~ ${to} 没有数据：${dir}/calls 或 imported`); process.exit(1); }
const v = validateRules(opt.rules && Array.isArray(opt.rules.rules) ? opt.rules : defaultRules());
if (v.errors.length) console.error("规则有错误，改用默认规则：" + v.errors.join("；"));
const rules = v.errors.length ? validateRules(defaultRules()).cfg : v.cfg;
const sessions = buildSessions(calls);
const hits = detect(sessions, rules);
const summary = summarize(hits, sessions);
let text;
if (args.includes("--csv")) {
  const q = (s) => `"${String(s ?? "").replace(/"/g, '""')}"`;
  text = "\ufeff" + ["时间,级别,规则,Agent,模型,会话,证据", ...hits.map((h) => [formatLocal(h.ts), SEVERITY_LABEL[h.severity], h.rule_name, h.agent, h.model, h.session, h.evidence].map(q).join(","))].join("\n");
} else text = JSON.stringify({ from, to, exportedAt: Date.now(), rules, summary, hits, sessions, calls }, null, 1);
const outIdx = args.indexOf("--out");
const out = outIdx >= 0 ? args[outIdx + 1] : path.join(dir, "exports", `magpie-stuck-${from}_to_${to}.${args.includes("--csv") ? "csv" : "json"}`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, text, { mode: 0o600 });
console.log(`${from} ~ ${to}: ${summary.sessions} 个会话 / ${summary.calls} 次调用 / ${summary.hits} 个卡点 → ${out}`);
for (const [name, n] of summary.by_rule) console.log(`  ${name}: ${n}`);
