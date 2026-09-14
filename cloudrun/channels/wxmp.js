/**
 * 公众号渠道（云托管消息推送·XML）：双模式，由 AGENT_MODE（core/guard.js 解析）切换。
 * - CheckContainerPath 配置检测 → 回 success
 * - 关注事件（subscribe）→ 被动回复欢迎语 + 经客服接口发送欢迎图（两种模式均保留）
 * - 文本私信：
 *   - agent 模式（AGENT_MODE=on）→ 每用户 AI 开关（默认关，data/ai-users.json 持久化）：
 *     蓝字菜单（weixin://bizmsgmenu，欢迎语/引导语内嵌）或手动发送"开启AI问答/关闭AI问答"切换；
 *     开启后秒回"正在查询"（规避微信 5 秒被动回复超时），异步跑 agent，
 *     完成后经客服消息接口（custom/send）推送答案；
 *     转人工诉求（消息命中关键词或 agent 输出兜底话术）自动关闭该用户 AI 并回电话指引
 *   - 停用模式（默认）→ 静默回 success，不调用 agent
 * - 客服消息/typing 走云托管内网 api.weixin.qq.com 免 access_token
 *   （需在云托管控制台开启"开放接口服务"，并配置 custom/send、custom/typing 权限）
 */

const { runAgent } = require("../core/agent");
const { rateLimit, AGENT_ENABLED } = require("../core/guard");
const { isHandoffRequest, applyHandoff, HANDOFF_REPLY } = require("../core/handoff");
const { fetch2 } = require("../net");

const fs = require("node:fs");
const path = require("node:path");

const WX_API = process.env.WX_API_BASE || "http://api.weixin.qq.com";
const TYPING_RENEW_MS = 10e3;   // "输入中"状态约 15s 过期，每 10s 续发
const ANSWER_MAX_BYTES = 2000;  // 客服消息 text 上限 2048 字节（UTF-8），留余量

// —— 蓝字菜单（weixin://bizmsgmenu）：点击后微信客户端以用户身份发送 msgmenucontent 文本 ——
const AI_ON_CMD = "开启AI问答";
const AI_OFF_CMD = "关闭AI问答";
const SAMPLE_QUESTIONS = ["上下班有班车吗", "技术员的要求与薪资", "吃饭有补贴吗"];
const SAMPLE_LABELS = { "上下班有班车吗": "上下班有班车吗？", "技术员的要求与薪资": "技术员的要求与薪资", "吃饭有补贴吗": "吃饭有补贴吗？" };
const menuLink = (content, label) =>
  `<a href="weixin://bizmsgmenu?msgmenucontent=${content}&msgmenuid=1">${label}</a>`;

function aiIntroText() {
  return "本号已接入 AI 问答，点击 " + menuLink(AI_ON_CMD, "开启 AI 问答") +
    " 后即可咨询招聘岗位相关问题；也可直接点击下方问题体验（点击后自动开启）：\n" +
    SAMPLE_QUESTIONS.map((q) => menuLink(q, SAMPLE_LABELS[q])).join("\n");
}

function aiGuideText() {
  return "AI 问答尚未开启。点击 " + menuLink(AI_ON_CMD, "开启 AI 问答") +
    " 后即可咨询招聘岗位相关问题，或直接点击下方问题体验：\n" +
    SAMPLE_QUESTIONS.map((q) => menuLink(q, SAMPLE_LABELS[q])).join("\n");
}

// —— 每用户 AI 开关（默认关）：data/ai-users.json 持久化，重启不丢 ——
const AI_USERS_FILE = path.join(__dirname, "..", "data", "ai-users.json");
let aiUsers = new Set();
try { aiUsers = new Set(JSON.parse(fs.readFileSync(AI_USERS_FILE, "utf8"))); } catch { /* 首次启动无文件 */ }
function saveAiUsers() {
  try {
    fs.mkdirSync(path.dirname(AI_USERS_FILE), { recursive: true });
    fs.writeFileSync(AI_USERS_FILE, JSON.stringify([...aiUsers]), "utf8");
  } catch (e) { console.error("[wxmp] AI 开关持久化失败:", e.message); }
}

// —— 关注欢迎图：docs/molex/reply-pic/welcome-reply.png 上传为永久素材后以图片回复 ——
const WELCOME_PIC = path.join(__dirname, "..", "docs", "molex", "reply-pic", "welcome-reply.png");
const MEDIA_CACHE_FILE = path.join(__dirname, "..", ".welcome_media_id"); // 容器内缓存，避免重复上传
let welcomeMediaId = (process.env.WELCOME_MEDIA_ID || "").trim();

/** 上传欢迎图为永久素材（云托管内网免 token），成功后缓存 media_id。 */
async function uploadWelcomeMedia() {
  if (!fs.existsSync(WELCOME_PIC)) return "";
  try {
    const form = new FormData();
    form.append("media", new Blob([fs.readFileSync(WELCOME_PIC)], { type: "image/png" }), "welcome-reply.png");
    const res = await fetch2(`${WX_API}/cgi-bin/material/add_material?type=image`, { method: "POST", body: form });
    const j = JSON.parse(await res.text());
    if (j.media_id) {
      welcomeMediaId = j.media_id;
      try { fs.writeFileSync(MEDIA_CACHE_FILE, welcomeMediaId); } catch { /* 容器层缓存失败不致命 */ }
      console.log("[wxmp] 欢迎图已上传素材库 media_id:", welcomeMediaId);
      return welcomeMediaId;
    }
    console.error("[wxmp] 欢迎图上传失败:", JSON.stringify(j).slice(0, 200));
  } catch (e) {
    console.error("[wxmp] 欢迎图上传异常:", e.message);
  }
  return "";
}

// 预热：启动时无 media_id（env/缓存均无）则后台上传，首个关注者即可收到图片
if (!welcomeMediaId && fs.existsSync(WELCOME_PIC)) {
  try { welcomeMediaId = fs.readFileSync(MEDIA_CACHE_FILE, "utf8").trim(); } catch { /* 无缓存 */ }
  if (!welcomeMediaId) uploadWelcomeMedia();
}

// MsgId 去重（微信 5 秒超时会重推同一消息）与处理中标志（防并发重复查询）——仅 agent 模式使用
const seenMsg = new Map();   // MsgId → 时间戳
const pending = new Set();   // 正在回答中的 openid
setInterval(() => {
  const cutoff = Date.now() - 300e3;
  for (const [k, t] of seenMsg) if (t < cutoff) seenMsg.delete(k);
}, 60e3).unref();

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
    BizMsgMenuId: pick("bizmsgmenuid"), // 蓝字菜单（bizmsgmenu）点击后推送附带此字段，普通手动输入没有
  };
}

function decodeXml(s) {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
          .replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

function textReply(to, from, content) {
  // CDATA 内只需防出现 ]]>；并过滤 XML 非法控制字符
  const safe = String(content).replace(/\]\]>/g, "]]&gt;")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
  return `<xml><ToUserName><![CDATA[${to}]]></ToUserName><FromUserName><![CDATA[${from}]]></FromUserName>` +
    `<CreateTime>${Math.floor(Date.now() / 1000)}</CreateTime>` +
    `<MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${safe}]]></Content></xml>`;
}

/** 按字节上限截断（多字节字符从尾部逐字回退，保证不切半个字符）。 */
function clipByBytes(s, max) {
  let str = String(s);
  if (Buffer.byteLength(str, "utf8") <= max) return str;
  let n = str.length;
  while (n > 0 && Buffer.byteLength(str.slice(0, n) + "…", "utf8") > max) n--;
  return str.slice(0, n) + "…";
}

/** 客服消息接口（云托管内网免 token）。仅记日志，不向上抛。 */
async function sendKf(openid, payload) {
  try {
    const res = await fetch2(`${WX_API}/cgi-bin/message/custom/send`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ touser: openid, ...payload }),
    });
    const body = await res.text();
    if (!res.ok || /"errcode":\s*[1-9]/.test(body)) {
      console.error("[wxmp] 客服消息发送失败:", body.slice(0, 200));
    }
  } catch (e) {
    console.error("[wxmp] 客服消息异常:", e.message);
  }
}

/** 客服"输入中"指示：每 10s 续发 Typing，回答完成后 Cancel。 */
function startTyping(openid) {
  const cmd = (command) => fetch2(`${WX_API}/cgi-bin/message/custom/typing`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ touser: openid, command }),
  }).catch(() => {});
  cmd("Typing");
  const timer = setInterval(() => cmd("Typing"), TYPING_RENEW_MS);
  return () => { clearInterval(timer); cmd("CancelTyping"); };
}

/** 异步回答任务：跑 agent → 客服消息推送答案（带 AI 标识与免责声明）。 */
function answerTask(openid, question) {
  const stopTyping = startTyping(openid);
  const label = (process.env.AI_LABEL || "【AI回复】").trim();
  const disclaimer = (process.env.AI_DISCLAIMER || "（内容由 AI 生成，具体招聘岗位及安排以官方最新发布为准）").trim();
  runAgent(question, openid)
    .then((answer) => {
      const replaced = applyHandoff(answer);
      if (replaced !== answer) {
        // agent 输出了转人工兜底话术 → 同步关闭该用户 AI，后续消息不再进入 agent
        aiUsers.delete(openid);
        saveAiUsers();
      }
      const content = clipByBytes(`${label}${replaced || "（未能生成回答，请换个问法试试）"}\n${disclaimer}`, ANSWER_MAX_BYTES);
      return sendKf(openid, { msgtype: "text", text: { content } });
    })
    .catch((e) => {
      console.error("[wxmp] 回答失败:", e.message);
      return sendKf(openid, { msgtype: "text", text: { content: `${label}系统繁忙，请稍后再试。` } });
    })
    .finally(() => { stopTyping(); pending.delete(openid); });
}

/**
 * 处理公众号消息推送（rawBody 为原始请求体）。
 * 返回 { contentType, body } 供 server.js 直接写出（须在 5 秒内返回）。
 */
function handleWxmp(rawBody) {
  const raw = String(rawBody || "");

  // 云托管控制台配置检测（JSON 的 action 字段或 XML 原文均可命中）
  if (/CheckContainerPath/.test(raw)) {
    return { contentType: "text/plain", body: "success" };
  }

  const msg = parseXml(raw);
  const from = msg.FromUserName;

  // 关注事件 → 被动回复仅能带一条消息：欢迎语走被动回复（先到），欢迎图经客服接口紧随其后；
  // agent 模式再追加一条 AI 问答介绍（含蓝字菜单；关注动作客服额度 3 条/1 分钟，共 2 条够用）
  if (msg.MsgType === "event" && msg.Event === "subscribe") {
    const welcome = process.env.WX_WELCOME_TEXT || "欢迎关注molex珠海光联招聘";
    if (welcomeMediaId) {
      sendKf(from, { msgtype: "image", image: { media_id: welcomeMediaId } });
    } else if (fs.existsSync(WELCOME_PIC)) {
      uploadWelcomeMedia(); // 素材上传中，下次关注生效
    }
    if (AGENT_ENABLED) {
      sendKf(from, { msgtype: "text", text: { content: aiIntroText() } });
    }
    return { contentType: "application/xml", body: textReply(from, msg.ToUserName, welcome) };
  }

  // 文本私信 → agent 模式走 AI 问答（每用户开关，默认关，蓝字开启）；停用模式静默回 success
  if (msg.MsgType === "text" && from && msg.Content && AGENT_ENABLED) {
    if (msg.MsgId) {
      if (seenMsg.has(msg.MsgId)) return { contentType: "text/plain", body: "success" };
      seenMsg.set(msg.MsgId, Date.now());
    }
    const content = msg.Content.trim();

    // 开关命令（蓝字或手动输入）：即时被动回复确认，不计限流
    if (content === AI_ON_CMD || content === AI_OFF_CMD) {
      const on = content === AI_ON_CMD;
      if (on) aiUsers.add(from); else aiUsers.delete(from);
      saveAiUsers();
      const tip = on
        ? `已开启 AI 问答，直接发送问题即可。\n不需要时可随时点 ${menuLink(AI_OFF_CMD, "关闭 AI 问答")}。`
        : `已关闭 AI 问答。需要时再点 ${menuLink(AI_ON_CMD, "开启 AI 问答")}。`;
      return { contentType: "application/xml", body: textReply(from, msg.ToUserName, tip) };
    }

    // 蓝字菜单点击（XML 带 bizmsgmenuid）：未开启视为使用意图，自动开启后照常处理
    // （关闭命令在上方开关分支已先行返回，不会走到这里）
    if (msg.BizMsgMenuId && !aiUsers.has(from)) {
      aiUsers.add(from);
      saveAiUsers();
    }

    // 手动输入样本问题：同样视为使用意图
    if (SAMPLE_QUESTIONS.includes(content) && !aiUsers.has(from)) {
      aiUsers.add(from);
      saveAiUsers();
    }

    // 转人工诉求：未接入人工客服，直接回电话指引，不调用 agent（不占提问额度）；
    // 同时自动关闭该用户 AI 问答（提出转人工即视为不想继续与 AI 交互）
    if (isHandoffRequest(content)) {
      if (aiUsers.has(from)) {
        aiUsers.delete(from);
        saveAiUsers();
      }
      return { contentType: "application/xml", body: textReply(from, msg.ToUserName, HANDOFF_REPLY) };
    }

    // 未开启 AI：回复引导（内嵌蓝字菜单），不调用 agent
    if (!aiUsers.has(from)) {
      return { contentType: "application/xml", body: textReply(from, msg.ToUserName, aiGuideText()) };
    }

    if (pending.has(from)) {
      return { contentType: "application/xml", body: textReply(from, msg.ToUserName, "上一个问题还在回答中，请稍候。") };
    }
    const limited = rateLimit(from);
    if (!limited.ok) {
      return { contentType: "application/xml", body: textReply(from, msg.ToUserName, limited.message) };
    }
    pending.add(from);
    answerTask(from, content);
    return { contentType: "application/xml", body: textReply(from, msg.ToUserName, "正在为您查询，请稍候…") };
  }

  // 其他消息/事件：一律回 success
  return { contentType: "text/plain", body: "success" };
}

module.exports = { handleWxmp, parseXml, decodeXml, textReply };
