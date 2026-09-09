/**
 * 微信云托管服务入口（零框架，Node 原生 http）—— 精简 HTTP 路由。
 *
 * 职责仅路由，业务在各层：
 * - core/        领域核心（agent / session / guard / qa-log），渠道无关
 * - channels/    渠道适配（webapi：H5 问答 API；wxmp：公众号消息推送引导入口）
 * - webui/       H5 静态页面
 * - identity.js  用户身份解析
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
require("./envload"); // 先加载 .env，再初始化其他模块

const { createWebApi } = require("./channels/webapi");
const { handleWxmp } = require("./channels/wxmp");
const { ACTIVE_KB } = require("./core/agent");

const PORT = Number(process.env.PORT || 80);
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const WEBUI_ROOT = path.join(__dirname, "webui");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

const handleWebApi = createWebApi();

// ---------- 路由 ----------
function route(req, res, raw) {
  const urlPath = safeUrlPath(req.url);
  if (urlPath === null) return notFound(res);

  if (req.method === "GET") {
    if (urlPath === "/healthz") {
      res.writeHead(200);
      return res.end("ok");
    }
    if (urlPath === "/api" || urlPath.startsWith("/api/")) return handleWebApi(req, res, raw);
    return serveStatic(res, urlPath);
  }

  if (req.method === "POST") {
    if (urlPath === "/api" || urlPath.startsWith("/api/")) return handleWebApi(req, res, raw);
    // 公众号消息推送配置在根路径：XML 消息体，或云托管 CheckContainerPath 探测
    if (raw.includes("<xml>") || raw.includes("CheckContainerPath")) {
      const out = handleWxmp(raw);
      res.writeHead(200, { "Content-Type": out.contentType });
      return res.end(out.body);
    }
    return notFound(res);
  }

  notFound(res);
}

// ---------- 静态文件（webui/） ----------
function serveStatic(res, urlPath) {
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const target = path.normalize(path.join(WEBUI_ROOT, rel));
  // 规范化后必须仍在 webui/ 内，防目录穿越
  if (target !== WEBUI_ROOT && !target.startsWith(WEBUI_ROOT + path.sep)) return notFound(res);
  fs.readFile(target, (err, data) => {
    if (err) return notFound(res); // 文件不存在 → 404
    res.writeHead(200, { "Content-Type": MIME[path.extname(target).toLowerCase()] || "application/octet-stream" });
    res.end(data);
  });
}

function safeUrlPath(u) {
  try { return decodeURIComponent(String(u || "/").split("?")[0]); } catch { return null; }
}

function notFound(res) {
  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
}

// ---------- HTTP 服务 ----------
const server = http.createServer((req, res) => {
  let chunks = [];
  req.on("data", (c) => {
    chunks.push(c);
    if (chunks.reduce((n, c) => n + c.length, 0) > 256 * 1024) req.destroy(); // 请求体上限 256KB
  });
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf-8");
    try {
      route(req, res, raw);
    } catch (e) {
      console.error("请求处理异常:", e.message);
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Internal Server Error");
    }
  });
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`服务已启动，端口 ${PORT}，模型 ${MODEL}，知识库 ${ACTIVE_KB}`));
