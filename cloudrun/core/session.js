/**
 * 会话历史管理（内存版）。
 *
 * 微信公众号消息推送是无状态 HTTP 回调，需自行以 openid 为 key 维护多轮上下文：
 * 每轮把「system + 历史 user/assistant 消息 + 新问题」拼进 messages 传给模型。
 *
 * 约束：
 * - 每用户最多保留 30 条消息（user + assistant 合计，超出裁掉最旧的）
 * - 拼接后的输入（不含本轮工具结果）估算 token ≤ 128k，为工具结果预留 TOOL_RESERVE
 * - SESSION_TTL_MIN 分钟无互动自动清空（默认 30 分钟）
 * - 仅存最终问答对，不存工具调用/结果与 reasoning，避免 token 膨胀
 * - 云托管实例数固定为 1，内存存储即生效；实例重启后历史清空（可接受）
 */

const MAX_MESSAGES = 30;          // 每用户最长对话记录条数
const MAX_INPUT_TOKENS = 128000;  // 最大输入 token 预算（含 system + 历史 + 新问题）
const TOOL_RESERVE = 32000;       // 为本轮工具结果预留的 token 预算
const SESSION_TTL_MS = (Number(process.env.SESSION_TTL_MIN) || 30) * 60e3;

// openid → { msgs: [{role, content}], ts: 最后活跃时间 }
const sessions = new Map();

// 周期清理过期会话
setInterval(() => {
  const now = Date.now();
  for (const [k, s] of sessions) if (now - s.ts > SESSION_TTL_MS) sessions.delete(k);
}, 600e3).unref();

/**
 * 粗略估算文本 token 数（保守偏高，防超出模型上下文）：
 * CJK（中文等）约 0.7 token/字，ASCII 约 0.3 token/字符，另加少量消息开销。
 */
function estimateTokens(text) {
  let cjk = 0, other = 0;
  for (const ch of String(text)) (ch.codePointAt(0) > 0x2e80 ? cjk++ : other++);
  return Math.ceil(cjk * 0.7 + other * 0.3) + 8;
}

/** 按估算 token 数截断文本（超长工具结果兜底用）。 */
function truncateByTokens(text, maxTokens) {
  text = String(text);
  if (maxTokens <= 0) return "";
  if (estimateTokens(text) <= maxTokens) return text;
  let n = Math.floor(maxTokens * 1.2); // 保守初值，再逐步收紧
  while (n > 0 && estimateTokens(text.slice(0, n)) > maxTokens) n = Math.floor(n * 0.9);
  return text.slice(0, n) + "\n…(内容过长已截断)";
}

function getSession(openid) {
  let s = sessions.get(openid);
  if (!s || Date.now() - s.ts > SESSION_TTL_MS) {
    s = { msgs: [], ts: Date.now() };
    sessions.set(openid, s);
  }
  return s;
}

/** 取某用户历史消息（副本，仅 user/assistant）。 */
function getHistory(openid) {
  return getSession(openid).msgs.slice();
}

/**
 * 拼接本轮请求的 messages：system + 历史上下文（按 token 预算从新到旧保留）+ 新问题。
 * 保证 user/assistant 严格交替且以 user 开头。
 */
function buildMessages(openid, systemPrompt, question) {
  const s = getSession(openid);
  const budget = MAX_INPUT_TOKENS - estimateTokens(systemPrompt) - estimateTokens(question) - TOOL_RESERVE;
  const picked = [];
  let used = 0;
  for (let i = s.msgs.length - 1; i >= 0; i--) {
    const t = estimateTokens(s.msgs[i].content) + 4;
    if (used + t > budget) break;
    picked.unshift(s.msgs[i]);
    used += t;
  }
  while (picked.length && picked[0].role !== "user") picked.shift(); // 保证交替合法
  if (picked.length < s.msgs.length) {
    console.log(`[session][${openid}] 按 token 预算截断历史：保留 ${picked.length}/${s.msgs.length} 条`);
  }
  return [
    { role: "system", content: systemPrompt },
    ...picked,
    { role: "user", content: question },
  ];
}

/** 一轮问答成功后写入历史（user + assistant 成对追加），超限裁掉最旧的。 */
function appendHistory(openid, userContent, assistantContent) {
  const s = getSession(openid);
  s.msgs.push(
    { role: "user", content: String(userContent) },
    { role: "assistant", content: String(assistantContent) },
  );
  if (s.msgs.length > MAX_MESSAGES) s.msgs = s.msgs.slice(-MAX_MESSAGES);
  s.ts = Date.now();
}

/** 清空某用户会话（如转人工时）。 */
function clearSession(openid) {
  sessions.delete(openid);
}

module.exports = {
  estimateTokens,
  truncateByTokens,
  getHistory,
  buildMessages,
  appendHistory,
  clearSession,
  TOOL_RESERVE,
};
