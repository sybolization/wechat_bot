/**
 * H5 问答页 API 渠道（/api/config、/api/ask、/api/reset）。
 * 前端经微信 callContainer 内网调用，同步 JSON 返回（非流式），单次处理控制在 15 秒内。
 * 复用 core 模块：runAgent / session / guard / qa-log；身份解析用顶层 identity.js。
 */

const { runAgent } = require("../core/agent");
const { appendHistory, clearSession } = require("../core/session");
const { rateLimit } = require("../core/guard");
const { qaLog } = require("../core/qa-log");
const { identify } = require("../identity");

const ASK_TIMEOUT_MS = 14000;      // 兜底超时（callContainer 前端侧上限 15 秒）
const MAX_QUESTION_LEN = 500;

// 严格模式：STRICT_WX_ONLY=1 时问答接口只接受 callContainer 内网链路（x-wx-openid 头），
// 公网直连一律 403 —— API 实质"仅微信内可用"，外人拿到 URL 只能看到静态页面。
// 本地调试设 STRICT_WX_ONLY=0 关闭（envload 不覆盖已存在的环境变量，命令行可覆盖）。
function strictWxOnly() {
  return /^(1|true|yes)$/i.test(process.env.STRICT_WX_ONLY || "");
}

// 快捷问题默认值（.env WEBUI_SUGGESTIONS 为 JSON 数组字符串，解析失败时容错回退）
const DEFAULT_SUGGESTIONS = ["班车路线有哪些", "公司介绍", "简历投递", "面试相关", "报到相关"];

function parseSuggestions() {
  try {
    const arr = JSON.parse(process.env.WEBUI_SUGGESTIONS || "");
    if (Array.isArray(arr) && arr.length) return arr.map(String);
  } catch { /* 容错：用默认列表 */ }
  return DEFAULT_SUGGESTIONS.slice();
}

function json(res, status, obj) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return {}; }
}

/** 处理一次提问：身份链路校验 → 参数校验 → 会话/频控 → agent（14 秒超时）→ 记录历史与问答日志。 */
async function handleAsk(req, res, raw) {
  const { id, source } = identify(req);
  if (strictWxOnly() && source !== "wx") {
    return json(res, 403, { error: { code: "forbidden", message: "请在微信内打开本页使用。" } });
  }
  const body = safeJson(raw);
  const question = typeof body.question === "string" ? body.question : "";
  if (!question || question.length > MAX_QUESTION_LEN) {
    return json(res, 400, { error: { code: "bad_request", message: "提问内容为空或超出长度限制。" } });
  }

  if (body.reset === true) clearSession(id); // 前端"新对话"开关

  const gate = rateLimit(id);
  if (!gate.ok) {
    return json(res, 429, { error: { code: "rate_limited", message: gate.message } }); // 不写历史
  }

  let timer;
  try {
    const answer = await Promise.race([
      runAgent(question, id), // 身份 id 作为会话键
      new Promise((_, rej) => {
        timer = setTimeout(() => {
          const e = new Error("timeout");
          e.code = "timeout";
          rej(e);
        }, ASK_TIMEOUT_MS);
      }),
    ]);
    json(res, 200, { answer });
    appendHistory(id, question, answer);
    qaLog(id, question, answer);
  } catch (e) {
    if (e && e.code === "timeout") {
      return json(res, 504, { error: { code: "timeout", message: "回答超时，请稍后重试或换个问法。" } }); // 不写历史
    }
    json(res, 500, { error: { code: "internal", message: "处理您的问题时出现异常，请稍后重试。" } });
    qaLog(id, question, `（处理失败：${e.message}）`, false);
  } finally {
    clearTimeout(timer);
  }
}

/** 工厂：返回挂载到 server.js 的渠道处理器（req, res, rawBody）。 */
function createWebApi() {
  // /api/config 配置（envload 已先行加载 .env，文案随知识库打包切换）
  const config = {
    title: process.env.WEBUI_TITLE || "智能问答",
    welcome: process.env.WEBUI_WELCOME || "您好，我是智能问答助手，请问有什么可以帮您？",
    suggestions: parseSuggestions(),
    placeholder: process.env.WEBUI_PLACEHOLDER || "试试问：有哪些班车线路",
    disclaimer: process.env.WEBUI_DISCLAIMER || "内容由 AI 生成，仅供参考",
    wx: {
      appid: process.env.WX_APPID || "",
      env: process.env.WX_CLOUDRUN_ENV || "",
      service: process.env.WX_SERVICE_NAME || "",
    },
  };

  return function handleWebApi(req, res, raw) {
    const path = (req.url || "").split("?")[0];
    if (req.method === "GET" && path === "/api/config") return json(res, 200, config);
    if (req.method === "POST" && path === "/api/ask") return handleAsk(req, res, raw);
    if (req.method === "POST" && path === "/api/reset") {
      const { id, source } = identify(req);
      if (strictWxOnly() && source !== "wx") {
        return json(res, 403, { error: { code: "forbidden", message: "请在微信内打开本页使用。" } });
      }
      clearSession(id);
      return json(res, 200, { ok: true });
    }
    json(res, 404, { error: { code: "not_found", message: "接口不存在。" } });
  };
}

module.exports = { createWebApi };
