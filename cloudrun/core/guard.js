/** 频控与每日配额（内存版，单实例部署时使用；配合云托管最大实例数=1）。 */

const HOURLY_LIMIT = 5;      // 单人每小时提问数
const DAILY_LIMIT = 20;      // 单人每日提问数
const GLOBAL_DAILY_LIMIT = 300; // 全局每日提问总数（成本护栏）

const users = new Map();     // openid → { hourStart, hourCount, dayStart, dayCount }
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
  if (!u) { u = { hourStart: now, hourCount: 0, dayStart: today, dayCount: 0 }; users.set(openid, u); }
  if (now - u.hourStart > 3600e3) { u.hourStart = now; u.hourCount = 0; }
  if (u.dayStart !== today) { u.dayStart = today; u.dayCount = 0; }
  if (++u.hourCount > HOURLY_LIMIT) {
    return { ok: false, message: "提问太频繁啦，请一小时后再试。" };
  }
  if (++u.dayCount > DAILY_LIMIT) {
    return { ok: false, message: "您今天的咨询次数已达上限，欢迎明天继续。" };
  }
  return { ok: true };
}

module.exports = { rateLimit };
