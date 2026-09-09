/**
 * 公众号渠道（云托管消息推送·XML）：仅承担入口职责，不跑 LLM（对话核心已迁移至 H5 问答页）。
 * - CheckContainerPath 配置检测 → 回 success
 * - 文本私信 / 关注事件（subscribe）→ 被动 XML 回复引导文案（含 H5 链接，秒级返回，规避 5 秒限制）
 * - 其他消息/事件 → 回 success
 * 被动回复即时无状态，无需 MsgId 去重/频控/客服消息接口。
 */

// 微信公众号消息为扁平结构，正则解析足够
function parseXml(xml) {
  const pick = (tag) => {
    const m = xml.match(new RegExp(`<${tag}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return m ? decodeXml(m[1].trim()) : "";
  };
  return {
    ToUserName: pick("ToUserName"),
    FromUserName: pick("FromUserName"),
    MsgType: pick("MsgType"),
    Content: pick("Content"),
    MsgId: pick("MsgId"),
    Event: pick("Event"),
  };
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function textReply(to, from, content) {
  return `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content></xml>`;
}

/** 引导文案：WEBUI_URL 未配置时 {url} 替换为空串并 trim（文案尾部不带死链接）。 */
function guideText() {
  const tpl = process.env.WX_GUIDE_TEXT || "您好！我是招聘智能小助手，请点击链接进入智能问答页面：{url}";
  return tpl.replace("{url}", (process.env.WEBUI_URL || "").trim()).trim();
}

/**
 * 处理公众号消息推送（rawBody 为原始请求体）。
 * 返回 { contentType, body } 供 server.js 直接写出。
 */
function handleWxmp(rawBody) {
  const raw = String(rawBody || "");

  // 云托管控制台配置检测（JSON 的 action 字段或 XML 原文均可命中）
  if (/CheckContainerPath/.test(raw)) {
    return { contentType: "text/plain", body: "success" };
  }

  const msg = parseXml(raw);
  // 文本私信 或 关注事件 → 被动回复引导文案（To=粉丝，From=公众号）
  const isText = msg.MsgType === "text" && msg.FromUserName && msg.Content;
  const isSubscribe = msg.MsgType === "event" && msg.Event === "subscribe";
  if (isText || isSubscribe) {
    return { contentType: "application/xml", body: textReply(msg.FromUserName, msg.ToUserName, guideText()) };
  }

  // 其他消息/事件：一律回 success
  return { contentType: "text/plain", body: "success" };
}

module.exports = { handleWxmp, parseXml, decodeXml, textReply };
