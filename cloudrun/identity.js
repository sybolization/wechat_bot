/**
 * 用户身份解析（渠道无关，webapi 渠道使用）：
 * - 微信 callContainer 内网请求携带 x-wx-openid 头（可信来源）→ 以 openid 为身份
 * - 其余（本地调试/公网直连）→ 以请求 IP 兜底为身份，走同一套 guard 限流
 */

function identify(req) {
  const openid = req.headers["x-wx-openid"];
  if (openid) return { id: String(openid), source: "wx" };
  // 云托管透传的真实 IP（可能为逗号分隔列表，取第一个），否则用 socket 地址
  const fwd = String(req.headers["x-wx-forwarded-for"] || "").split(",")[0].trim();
  const ip = fwd || (req.socket && req.socket.remoteAddress) || "unknown";
  return { id: "ip:" + ip, source: "fallback" };
}

module.exports = { identify };
