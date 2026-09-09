/**
 * docqa web 后端（零依赖，Node 内置模块）。
 *
 * - 静态托管 web/ 前端页面
 * - 每个浏览器会话（sessionId）托管一个 pi --mode rpc 子进程
 * - POST /api/chat：把用户问题发给 pi，事件（流式文本/思考/工具调用）转成 SSE 推给前端
 * - POST /api/abort、DELETE /api/session/:id
 *
 * 注意：pi RPC 用严格 JSONL（仅按 \n 分帧），不能使用 readline（会按 U+2028/U+2029 切分）。
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const WEB_DIR = path.join(__dirname);
const NODE_DIR =
  process.env.DOCQA_NODE_DIR ||
  "C:\\Users\\boyanx1\\.local\\share\\nodejs\\node-v22.19.0-win-x64";
const PI_CLI = path.join(
  NODE_DIR,
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
  "bundle",
  "cli.js",
);
const NODE_EXE = path.join(NODE_DIR, "node.exe");
const PORT = Number(process.env.PORT || 3123);

// ---- pi 子进程参数：与 docqa.ps1 保持一致（仅自定义 read 工具） ----
const PI_ARGS = [
  "--mode", "rpc",
  "--no-session",
  "--no-builtin-tools",
  "-e", path.join(ROOT, "pi-agent", "extensions", "doc-read.ts"),
];

function piEnv() {
  return {
    ...process.env,
    DOCQA_DOCS_ROOT: process.env.DOCQA_DOCS_ROOT || path.join(ROOT, "docs"),
    DOCQA_PYTHON:
      process.env.DOCQA_PYTHON ||
      "C:\\Users\\boyanx1\\.local\\share\\docqa-venv\\Scripts\\python.exe",
  };
}

// ---------- 会话（pi 子进程）管理 ----------
/** @type {Map<string, {proc:import('node:child_process').ChildProcess, buf:string,
 *   listeners:Set<(obj:any)=>void>, busy:boolean, closing:boolean}>} */
const sessions = new Map();

function broadcast(sess, obj) {
  for (const fn of sess.listeners) fn(obj);
}

function spawnSession(id) {
  const proc = spawn(NODE_EXE, [PI_CLI, ...PI_ARGS], {
    cwd: ROOT,
    env: piEnv(),
    windowsHide: true,
  });
  const sess = { proc, buf: "", listeners: new Set(), busy: false, closing: false };
  sessions.set(id, sess);

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk) => {
    sess.buf += chunk;
    let idx;
    while ((idx = sess.buf.indexOf("\n")) >= 0) {
      const line = sess.buf.slice(0, idx).replace(/\r$/, "");
      sess.buf = sess.buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        continue; // 非 JSON 行忽略
      }
      forwardEvent(sess, obj);
    }
  });

  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (chunk) => {
    // pi 的日志/错误走 stderr，收集起来便于排查
    if (!sess.stderrTail) sess.stderrTail = "";
    sess.stderrTail = (sess.stderrTail + chunk).slice(-4000);
  });

  proc.on("close", (code) => {
    if (!sess.closing) {
      broadcast(sess, {
        t: "error",
        message: `pi 进程退出（code=${code}）${sess.stderrTail ? "：" + lastLine(sess.stderrTail) : ""}`,
      });
    }
    for (const fn of sess.listeners) sess.listeners.delete(fn);
    sessions.delete(id);
  });
  return sess;
}

function lastLine(s) {
  const lines = s.trim().split("\n");
  return lines[lines.length - 1].slice(0, 500);
}

/** 把 pi RPC 事件筛选翻译成前端 SSE 事件 */
function forwardEvent(sess, obj) {
  switch (obj.type) {
    case "response":
      // 命令回执（prompt/abort 等）由命令发起处按 id 处理，这里统一广播
      broadcast(sess, { t: "response", command: obj.command, success: obj.success, id: obj.id, error: obj.error });
      return;
    case "tool_execution_start":
      broadcast(sess, {
        t: "tool_start",
        toolCallId: obj.toolCallId,
        name: obj.toolName,
        args: obj.args,
      });
      return;
    case "tool_execution_end":
      broadcast(sess, { t: "tool_end", toolCallId: obj.toolCallId, isError: !!obj.isError });
      return;
    case "message_update": {
      const ev = obj.assistantMessageEvent || {};
      if (ev.type === "text_delta") broadcast(sess, { t: "delta", delta: ev.delta || "" });
      else if (ev.type === "thinking_delta") broadcast(sess, { t: "think", delta: ev.delta || "" });
      return;
    }
    case "message_end": {
      const msg = obj.message || {};
      if (msg.role === "assistant") {
        if (msg.stopReason === "error") {
          broadcast(sess, { t: "error", message: `模型调用失败：${msg.errorMessage || "未知错误"}` });
          return;
        }
        const text = (msg.content || [])
          .filter((c) => c.type === "text")
          .map((c) => c.text)
          .join("");
        const thinking = (msg.content || [])
          .filter((c) => c.type === "thinking")
          .map((c) => c.thinking)
          .join("");
        broadcast(sess, { t: "message_end", role: msg.role, text, thinking });
      }
      return;
    }
    case "agent_end":
      // willRetry=true 表示 pi 将自动重试，会话还没结束
      if (obj.willRetry) return;
      sess.busy = false;
      broadcast(sess, { t: "done" });
      return;
    case "agent_start":
      sess.busy = true;
      return;
    default:
      return; // 其余事件前端不需要
  }
}

// ---------- HTTP ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > 1024 * 1024) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sseStart(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  const timer = setInterval(() => res.write(": ping\n\n"), 15000);
  return () => clearInterval(timer);
}

async function handleChat(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || "{}");
  } catch {
    return sendJson(res, 400, { error: "invalid json" });
  }
  const sessionId = String(body.sessionId || "");
  const message = String(body.message || "").trim();
  if (!/^[a-zA-Z0-9-]{6,64}$/.test(sessionId) || !message) {
    return sendJson(res, 400, { error: "需要 sessionId 和 message" });
  }

  const sess = sessions.get(sessionId) || spawnSession(sessionId);
  if (sess.busy) return sendJson(res, 409, { error: "该会话正在回答中，请稍候" });

  const stopPing = sseStart(res);
  const listener = (obj) => {
    try {
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (obj.t === "done") {
        cleanup();
        res.end();
      }
    } catch {
      /* 连接断开 */
    }
  };
  const cleanup = () => {
    stopPing();
    sess.listeners.delete(listener);
  };
  sess.listeners.add(listener);
  req.on("close", cleanup);

  const reqId = `req-${Date.now()}`;
  const onResp = (obj) => {
    if (obj.t === "response" && obj.id === reqId) {
      sess.listeners.delete(onResp);
      if (obj.success === false) {
        sess.busy = false;
        listener({ t: "error", message: `pi 拒绝了该请求：${obj.error || "未知原因"}` });
        res.end();
      }
    }
  };
  sess.listeners.add(onResp);
  sess.proc.stdin.write(JSON.stringify({ id: reqId, type: "prompt", message }) + "\n");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === "POST" && p === "/api/chat") return handleChat(req, res);

  if (req.method === "POST" && p === "/api/abort") {
    const body = JSON.parse((await readBody(req)) || "{}");
    const sess = sessions.get(String(body.sessionId || ""));
    if (sess) sess.proc.stdin.write(JSON.stringify({ type: "abort" }) + "\n");
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "DELETE" && p.startsWith("/api/session/")) {
    const id = p.slice("/api/session/".length);
    const sess = sessions.get(id);
    if (sess) {
      sess.closing = true;
      sess.proc.kill();
      sessions.delete(id);
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "GET" && (p === "/" || p === "/index.html")) {
    res.writeHead(200, { "Content-Type": MIME[".html"] });
    return res.end(fs.readFileSync(path.join(WEB_DIR, "index.html")));
  }
  if (req.method === "GET") {
    const file = path.join(WEB_DIR, path.normalize(p).replace(/^([.\\/]+)+/, ""));
    if (file.startsWith(WEB_DIR) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
      return res.end(fs.readFileSync(file));
    }
    return sendJson(res, 404, { error: "not found" });
  }
  sendJson(res, 404, { error: "not found" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`docqa web 已启动: http://localhost:${PORT}`);
  console.log(`pi cli: ${PI_CLI}`);
});
