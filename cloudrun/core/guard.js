/** 频控与每日配额（内存版，单实例部署时使用；配合云托管最大实例数=1）。 */

const WINDOW_MS = 5 * 60e3;     // 滑动窗口：5 分钟
const WINDOW_LIMIT = 20;        // 单人每 5 分钟提问数
const GLOBAL_DAILY_LIMIT = 300; // 全局每日提问总数（成本护栏）

// Agent 模式开关：AGENT_MODE=on/1/true/yes 启用 AI 问答；off 或未设置时停用
// （公众号文本私信静默不回复，H5 /api/ask 返回停用提示），关注欢迎能力不受影响。
const AGENT_ENABLED = /^(1|true|on|yes)$/i.test(process.env.AGENT_MODE || "");

const users = new Map();     // openid → { winStart, winCount }
let globalDayStart = dayStart();
let globalCount = 0;

function dayStart() { return Math.floor(Date.now() / 86400e3); }

function rateLimit(openid) {
  const today = dayStart();
  if (globalDayStart !== today) { globalDayStart = today; globalCount = 0; }
  if (++globalCount > GLOBAL_DAILY_LIMIT) {
    return { ok: false, message: "今日咨询量已达上限，请明天再来。" };
  }
  const now = Date.now();
  let u = users.get(openid);
  if (!u) { u = { winStart: now, winCount: 0 }; users.set(openid, u); }
  if (now - u.winStart > WINDOW_MS) { u.winStart = now; u.winCount = 0; }
  if (++u.winCount > WINDOW_LIMIT) {
    return { ok: false, message: "提问太频繁啦，请五分钟后再试。" };
  }
  return { ok: true };
}

module.exports = { rateLimit, AGENT_ENABLED };
