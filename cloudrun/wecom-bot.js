/**
 * 企业微信智能机器人测试通道（独立进程入口，与业务通道 server.js 完全隔离）。
 *
 * 用途：拉企微内部群，HR @机器人提问，围观评审 AI 回答效果。
 * 启动：项目根 `powershell -File wecom-bot.ps1`（或手动设置 WECOM_BOT_ID/WECOM_BOT_SECRET
 *       后 `node cloudrun/wecom-bot.js`）。
 * 凭证：企业微信管理后台 → 协作 → 机器人 → 创建「智能机器人」后获取 BotID/Secret。
 * 网络：仅出站 wss://openws.work.weixin.qq.com:443，无需公网入站/回调/域名。
 * 隔离：本文件与 @wecom/aibot-node-sdk 不进业务部署包（package.json 未声明该依赖，
 *       本地以 npm install --no-save 方式安装）；启停不影响公众号服务。
 *
 * 复用业务核心：core/agent（molex 文档库问答）、core/guard（频控）。
 */

require("./envload"); // 加载 .env（AI 标识等），凭证以环境变量优先

const WECOM_BOT_ID = (process.env.WECOM_BOT_ID || "").trim();
const WECOM_BOT_SECRET = (process.env.WECOM_BOT_SECRET || "").trim();

if (!WECOM_BOT_ID || !WECOM_BOT_SECRET) {
  console.error("缺少 WECOM_BOT_ID / WECOM_BOT_SECRET（企业微信管理后台创建智能机器人后获取），测试通道未启动。");
  process.exit(1);
}

// SDK 仅测试通道使用，延迟加载（业务部署环境无此包，顶部 require 会导致业务启动失败）
const AiBot = require("@wecom/aibot-node-sdk");
const { generateReqId } = AiBot;

const { runAgent } = require("./core/agent");
const { rateLimit } = require("./core/guard");
const { isHandoffRequest, applyHandoff, HANDOFF_REPLY } = require("./core/handoff");

const LABEL = (process.env.AI_LABEL || "【AI回复】").trim();
const DISCLAIMER = (process.env.AI_DISCLAIMER || "（内容由 AI 生成，具体招聘岗位及安排以官方最新发布为准）").trim();

const seenMsg = new Set(); // msgid 去重（长连接重推场景）
const busyUsers = new Set(); // 处理中标志，key = 发送者 userid

const wsClient = new AiBot.WSClient({
  botId: WECOM_BOT_ID,
  secret: WECOM_BOT_SECRET,
  maxReconnectAttempts: -1, // 常驻：断线无限重连（指数退避，30s 上限）
});

wsClient.on("authenticated", () => console.log("[wecom-bot] 认证成功，测试通道就绪（@机器人提问即可）"));
wsClient.on("reconnecting", (n) => console.warn(`[wecom-bot] 第 ${n} 次重连…`));
wsClient.on("error", (e) => console.error("[wecom-bot] 连接错误:", e.message));

// 进入单聊会话 → 欢迎语（须 5 秒内回复）
wsClient.on("event.enter_chat", (frame) => {
  wsClient.replyWelcome(frame, {
    msgtype: "text",
    text: { content: "您好！我是招聘智能小助手（测试版），直接提问即可体验 AI 回答，回答仅供参考。" },
  }).catch((e) => console.error("[wecom-bot] 欢迎语失败:", e.message));
});

// 文本消息 → 流式 AI 回答
wsClient.on("message.text", (frame) => {
  const body = frame.body || {};
  const userid = body.from && body.from.userid;
  const raw = (body.text && body.text.content || "").trim();
  if (!userid || !raw) return;

  if (seenMsg.has(body.msgid)) return;
  seenMsg.add(body.msgid);
  if (seenMsg.size > 5000) seenMsg.clear(); // 兜底清理

  // 群聊 @机器人 时 content 可能带 "@机器人名 " 前缀，去掉后作为问题
  const question = raw.replace(/^@\S+\s*/, "").trim();
  if (!question) return;

  // 转人工诉求：未接入人工客服，直接回电话指引，不调用 agent（不占提问额度）
  if (isHandoffRequest(question)) {
    return replyText(frame, HANDOFF_REPLY);
  }
  if (busyUsers.has(userid)) {
    return replyText(frame, "上一个问题还在回答中，请稍候。");
  }
  const limited = rateLimit(userid);
  if (!limited.ok) {
    return replyText(frame, limited.message);
  }
  busyUsers.add(userid);
  answerTask(frame, userid, question);
});

function replyText(frame, content) {
  wsClient.reply(frame, { msgtype: "text", text: { content } })
    .catch((e) => console.error("[wecom-bot] 回复失败:", e.message));
}

/** 流式回答：企微流式消息为整条替换式，累积全量后按块节流刷新（块级增量效果）。 */
function answerTask(frame, userid, question) {
  const streamId = generateReqId("stream");
  const FLUSH_MS = 800;    // 最小刷新间隔
  const FLUSH_CHARS = 24;  // 距上次刷新的最小新增字符数
  let full = "";           // 累积全量内容（含 AI 标识）
  let lastLen = 0;         // 上次已刷新的内容长度
  let lastFlush = 0;       // 上次刷新时间
  let pending = null;      // 兜底定时器（保证末尾增量最终刷出）

  const flush = (finish) => {
    lastFlush = Date.now();
    lastLen = full.length;
    return wsClient.replyStream(frame, streamId, full, finish).catch(() => {});
  };

  wsClient.replyStream(frame, streamId, "正在为您查询，请稍候…", false).catch(() => {});

  runAgent(question, userid, {
    onDelta: (piece) => {
      if (!piece) return;
      if (!full) full = LABEL; // 首块携带 AI 标识
      full += piece;
      const now = Date.now();
      if (now - lastFlush >= FLUSH_MS && full.length - lastLen >= FLUSH_CHARS) {
        flush(false);
      } else if (!pending) {
        pending = setTimeout(() => {
          pending = null;
          if (full.length > lastLen) flush(false);
        }, FLUSH_MS);
      }
    },
  })
    .then((answer) => {
      if (pending) { clearTimeout(pending); pending = null; }
      const tail = (applyHandoff(answer) || "（未能生成回答，请换个问法试试）") + "\n" + DISCLAIMER;
      full = LABEL + tail; // 以最终完整答案为准
      return flush(true);
    })
    .catch((e) => {
      console.error("[wecom-bot] 回答失败:", e.message);
      full = `${LABEL}系统繁忙，请稍后再试。`;
      return flush(true);
    })
    .finally(() => busyUsers.delete(userid));
}

wsClient.connect();
console.log("[wecom-bot] 启动中…（出站 wss 长连接）");

process.on("SIGINT", () => {
  console.log("\n[wecom-bot] 断开连接，退出。");
  wsClient.disconnect();
  process.exit(0);
});
