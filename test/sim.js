// 测试辅助：模拟宿主的存储流程（归一化 → 精简 → 增量），生成调用记录
import crypto from "node:crypto";
import { normalizeRequest, parseReply, compactMessage } from "../page/core.js";

const sha = (s) => crypto.createHash("sha1").update(s).digest("hex").slice(0, 16);
export const U = (text) => ({ role: "user", content: text });
export const A = (text, ...tools) => ({ role: "assistant", content: [...(text ? [{ type: "text", text }] : []), ...tools.map(([id, name, input]) => ({ type: "tool_use", id, name, input }))] });
export const R = (id, text, is_error = false) => ({ role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error }] });

// turns: [{ add: [anthropic messages], model?, in_tok?, latency_ms?, reply? }]
export function simulate(agent, turns, { t0 = Date.parse("2026-10-28T10:00:00+08:00"), protocol = "anthropic", session = "s" } = {}) {
  const full = [], hs = [], calls = [];
  let t = t0;
  for (const turn of turns) {
    full.push(...turn.add);
    const body = protocol === "anthropic" ? { model: turn.model || "m1", system: "sys", max_tokens: 1000, messages: full } : { model: turn.model || "m1", messages: full };
    const norm = normalizeRequest(body, protocol);
    const msgs = norm.messages.map((m) => ({ ...compactMessage(m, { user: 20000, assistant: 20000, result: 10000, cmd: 2000 }), h: sha(JSON.stringify(m)) }));
    let lcp = 0;
    while (lcp < hs.length && lcp < msgs.length && hs[lcp] === msgs[lcp].h) lcp++;
    hs.length = lcp; for (const m of msgs.slice(lcp)) hs.push(m.h);
    const reply = turn.reply ? compactMessage(parseReply(turn.reply, protocol)) : null;
    calls.push({ ts: t, agent, session: `${agent}-${session}`, model: turn.model || "m1", ok: turn.ok !== false, latency_ms: turn.latency_ms ?? 2000,
      in_tok: turn.in_tok ?? 1000, out_tok: turn.out_tok ?? 100, offset: lcp, nmsgs: msgs.length, msgs: msgs.slice(lcp), reply });
    t += (turn.latency_ms ?? 2000) + 1000;
  }
  return calls;
}
