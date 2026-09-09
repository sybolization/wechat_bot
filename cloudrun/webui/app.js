/* 招聘问答 H5 前端逻辑：callContainer / 同源 fetch 双链路 + 本地历史缓存 */
"use strict";

const $ = (sel) => document.querySelector(sel);

// ---------- DOM 引用 ----------
const titleEl = $("#title");
const btnNew = $("#btnNew");
const feedEl = $("#feed");
const welcomeEl = $("#welcome");
const welcomeTextEl = $("#welcomeText");
const sugCardEl = $("#sugCard");
const inputEl = $("#input");
const btnSend = $("#btnSend");
const disclaimerEl = $("#disclaimer");

// ---------- 常量与默认配置 ----------
const LS_KEY = "cloudrun.webui.history.v1";
const HISTORY_LIMIT = 50;
const REQUEST_TIMEOUT = 15000;

// /api/config 拉取失败时使用的内置默认文案（不阻塞页面）
const DEFAULT_CONFIG = {
  title: "招聘问答",
  welcome: "你好，我是招聘 AI 助手，关于岗位、薪资、工作地点等问题都可以直接提问。",
  suggestions: [
    "目前有哪些在招岗位？",
    "投递简历后多久会有反馈？",
    "公司的薪资福利怎么样？",
    "工作地点和办公环境如何？",
  ],
  placeholder: "请输入您的问题",
  disclaimer: "内容由 AI 生成，仅供参考",
  wx: { appid: "", env: "", service: "" },
};

// ---------- 状态 ----------
let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let transport = "fetch";     // "wx" | "fetch"
let busy = false;
let msgHistory = [];         // [{ role, content, error? }]

// 项目约定写法：检测 vendored marked 是否可用
const HAS_MARKED =
  typeof window.marked === "object" && window.marked !== null &&
  typeof window.marked.parse === "function";
if (HAS_MARKED) {
  marked.setOptions({ gfm: true, breaks: true });
}

// ---------- 配置拉取与渲染 ----------
async function loadConfig() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch("/api/config", { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (data && typeof data === "object") {
      cfg = {
        ...DEFAULT_CONFIG,
        ...data,
        wx: { ...DEFAULT_CONFIG.wx, ...(data.wx || {}) },
      };
    }
  } catch {
    // 拉取失败沿用内置默认文案，不阻塞页面
  }
}

function applyConfig() {
  document.title = cfg.title || DEFAULT_CONFIG.title;
  titleEl.textContent = cfg.title || DEFAULT_CONFIG.title;
  welcomeTextEl.textContent = cfg.welcome || DEFAULT_CONFIG.welcome;
  inputEl.placeholder = cfg.placeholder || DEFAULT_CONFIG.placeholder;
  disclaimerEl.textContent = cfg.disclaimer || DEFAULT_CONFIG.disclaimer;
  renderSuggestions();
}

function renderSuggestions() {
  sugCardEl.innerHTML = "";
  const list = Array.isArray(cfg.suggestions) ? cfg.suggestions : [];
  for (const text of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "sug-item";
    const label = document.createElement("span");
    label.textContent = text;
    const arr = document.createElement("span");
    arr.className = "arr";
    arr.textContent = "→";
    btn.append(label, arr);
    btn.addEventListener("click", () => send(text));
    sugCardEl.appendChild(btn);
  }
  sugCardEl.hidden = sugCardEl.childElementCount === 0;
}

// ---------- 传输层：callContainer / 同源 fetch ----------
function isInternalHost() {
  const h = location.hostname;
  if (!h) return true;
  if (h === "localhost" || h === "127.0.0.1") return true;
  // 形如 *.*.*.* 的 IPv4 主机名（含 192.168.* 等内网地址）一律视为本地调试
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return true;
  return false;
}

function shouldUseWx() {
  const wx = cfg.wx || {};
  return Boolean(
    wx.appid && wx.env && wx.service &&
    location.protocol === "https:" &&
    typeof window.mplogin === "function" &&
    !isInternalHost(),
  );
}

async function initTransport() {
  if (shouldUseWx()) {
    try {
      const result = await window.mplogin({
        scope: "snsapi_base",
        appid: cfg.wx.appid,
        envid: cfg.wx.env,
      });
      if (result && result.ret === 0 && result.cloud) {
        window.app = result.cloud;
        transport = "wx";
        return;
      }
    } catch {
      // 初始化失败时降级到同源 fetch
    }
  }
  transport = "fetch";
  showModeNotice();
}

function showModeNotice() {
  if (document.getElementById("modeNotice")) return;
  const notice = document.createElement("div");
  notice.id = "modeNotice";
  notice.className = "mode-notice";
  const text = document.createElement("span");
  text.textContent = "未接入微信身份，当前为受限体验模式";
  const close = document.createElement("button");
  close.type = "button";
  close.className = "mode-notice-close";
  close.textContent = "关闭";
  close.addEventListener("click", () => notice.remove());
  notice.append(text, close);
  welcomeEl.after(notice);   // 欢迎区下方
}

async function askRemote({ path, method = "POST", data }) {
  if (transport === "wx") return askViaWx(path, method, data);
  return askViaFetch(path, method, data);
}

// 微信云托管内网链路（自动携带 openid）
async function askViaWx(path, method, data) {
  let callres;
  try {
    callres = await window.app.callContainer({
      path,
      method,
      header: { "X-WX-SERVICE": cfg.wx.service },
      data,
      timeout: REQUEST_TIMEOUT,
    });
  } catch (e) {
    const raw = (e && (e.errMsg || e.message)) || String(e);
    const err = new Error(raw);
    if (/timeout|timed?\s*out/i.test(raw)) err.timeout = true;
    throw err;
  }
  // 兼容两种返回结构：{ data, statusCode, ... }（同 wx.request）或直接返回响应 body
  let statusCode = null;
  let body = callres;
  if (
    callres && typeof callres === "object" &&
    typeof callres.statusCode === "number" &&
    callres.data !== undefined
  ) {
    statusCode = callres.statusCode;
    body = callres.data;
  }
  if (statusCode !== null && (statusCode < 200 || statusCode >= 300)) {
    const msg = body && body.error && body.error.message;
    throw new Error(msg || "HTTP " + statusCode);
  }
  if (body && body.error) {
    throw new Error(body.error.message || "HTTP " + (statusCode || 500));
  }
  return body;
}

// 同源 fetch 链路（本地调试 / 降级，服务端以 IP 限流兜底）
async function askViaFetch(path, method, data) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
  let res;
  try {
    res = await fetch(path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data || {}),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      const err = new Error("请求超过 " + REQUEST_TIMEOUT / 1000 + " 秒未响应");
      err.timeout = true;
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && body.error && body.error.message;
    throw new Error(msg || "HTTP " + res.status);
  }
  if (body && body.error) {
    throw new Error(body.error.message || "HTTP " + res.status);
  }
  return body;
}

async function askReset() {
  await askRemote({ path: "/api/reset", method: "POST", data: {} });
}

// ---------- 消息渲染 ----------
function appendUserMsg(text) {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-user";
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  bubble.textContent = text;
  wrap.appendChild(bubble);
  feedEl.appendChild(wrap);
  return wrap;
}

function appendBotMsg() {
  const wrap = document.createElement("div");
  wrap.className = "msg msg-bot";
  const bubble = document.createElement("div");
  bubble.className = "bubble md";
  wrap.appendChild(bubble);
  feedEl.appendChild(wrap);
  return bubble;
}

function buildLoading() {
  const box = document.createElement("div");
  box.className = "loading";
  const dots = document.createElement("span");
  dots.className = "dots";
  for (let i = 0; i < 3; i++) dots.appendChild(document.createElement("i"));
  const label = document.createElement("span");
  label.textContent = "正在查询…";
  box.append(dots, label);
  return box;
}

function renderMarkdown(el, text) {
  if (HAS_MARKED) {
    // 先转义原始 HTML，防止注入；markdown 语法仍正常渲染
    const safe = normalizeTables(
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    el.innerHTML = marked.parse(safe);
  } else {
    el.textContent = text;
  }
}

function renderError(el, text) {
  el.innerHTML = "";
  const p = document.createElement("p");
  p.className = "err";
  p.textContent = text;
  el.appendChild(p);
}

// ---------- 打字机渲染（后端 agent 已流式聚合，callContainer 返回完整答案，前端模拟流式体验） ----------
function typeOutMarkdown(el, fullText, onDone) {
  const total = fullText.length;
  // 无 marked 或短文本直接一次渲染
  if (!HAS_MARKED || total <= 60) {
    renderMarkdown(el, fullText);
    onDone();
    return;
  }
  const FRAME_MS = 50;
  const frames = Math.max(6, Math.min(30, Math.ceil(total / 24))); // 总时长约 0.3s - 1.5s，长答案不至于拖沓
  const step = Math.ceil(total / frames);
  let pos = 0;
  const timer = setInterval(() => {
    pos = Math.min(total, pos + step);
    renderMarkdown(el, fullText.slice(0, pos));
    scrollBottom();
    if (pos >= total) {
      clearInterval(timer);
      renderMarkdown(el, fullText);
      onDone();
    }
  }, FRAME_MS);
}

/** 修复模型把表格表头写在前文同一行的情况（此时 marked 无法识别表格） */
function normalizeTables(src) {
  const isRow = (l) => /^\s*\|.*\|\s*$/.test(l);
  const isSep = (l) => l.includes("-") && l.includes("|") && /^[\s|:-]+$/.test(l);
  const lines = src.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (isSep(line) && out.length && !isRow(out[out.length - 1])) {
      const m = out[out.length - 1].match(/^(.*?)(\|.*\|)\s*$/);
      if (m) {
        out[out.length - 1] = m[1].trimEnd();
        out.push(m[2]);
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

function scrollBottom(force) {
  const nearBottom =
    feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 120;
  if (force || nearBottom) feedEl.scrollTop = feedEl.scrollHeight;
}

// ---------- 历史缓存（localStorage，上限 50 条） ----------
function loadHistory() {
  try {
    const arr = JSON.parse(localStorage.getItem(LS_KEY) || "[]");
    if (!Array.isArray(arr)) return [];
    return arr
      .filter((m) => m && (m.role === "user" || m.role === "assistant") &&
        typeof m.content === "string")
      .slice(-HISTORY_LIMIT);
  } catch {
    return [];
  }
}

function saveHistory() {
  try {
    if (msgHistory.length > HISTORY_LIMIT) msgHistory = msgHistory.slice(-HISTORY_LIMIT);
    localStorage.setItem(LS_KEY, JSON.stringify(msgHistory));
  } catch {
    // localStorage 不可用（如隐私模式）时静默跳过
  }
}

function restoreHistory() {
  if (!msgHistory.length) return;
  welcomeEl.hidden = true;
  for (const m of msgHistory) {
    if (m.role === "user") {
      appendUserMsg(m.content);
    } else {
      const bubble = appendBotMsg();
      if (m.error) renderError(bubble, m.content);
      else renderMarkdown(bubble, m.content);
    }
  }
  scrollBottom(true);
}

// ---------- 发送流程 ----------
function refreshSendBtn() {
  // 有文字才可发送；回答中一律禁用（文案不变）
  btnSend.disabled = busy || !inputEl.value.trim();
}

function setBusy(b) {
  busy = b;
  inputEl.disabled = b;
  btnNew.disabled = b;
  refreshSendBtn();
}

async function send(text) {
  text = (text || "").trim();
  if (!text || busy) return;
  setBusy(true);

  function finish() {
    saveHistory();
    setBusy(false);
    inputEl.focus();
    scrollBottom();
  }

  welcomeEl.hidden = true;
  msgHistory.push({ role: "user", content: text });
  appendUserMsg(text);
  const botBubble = appendBotMsg();
  botBubble.appendChild(buildLoading());   // 即时 loading 反馈
  scrollBottom(true);

  try {
    const body = await askRemote({
      path: "/api/ask",
      method: "POST",
      data: { question: text },
    });
    const answer = body && typeof body.answer === "string" ? body.answer : "";
    if (!answer) throw new Error("服务返回内容异常：answer 字段缺失");
    msgHistory.push({ role: "assistant", content: answer });
    // 统一流式体验：打字机逐字渲染，收尾（解锁输入等）在打字完成后执行
    typeOutMarkdown(botBubble, answer, finish);
    return;
  } catch (e) {
    const raw = e && e.message ? e.message : String(e);
    const tip = e && e.timeout
      ? "回答超时，请稍后重试或换个问法。（原始信息：" + raw + "）"
      : "回答生成失败：" + raw;
    msgHistory.push({ role: "assistant", content: tip, error: true });
    renderError(botBubble, tip);
  }
  finish();
}

// ---------- 新对话 ----------
async function newConversation() {
  if (busy) return;
  // 清空本地历史与消息，重新显示欢迎区（保留受限模式提示，如有）
  msgHistory = [];
  saveHistory();
  Array.from(feedEl.children).forEach((el) => {
    if (el !== welcomeEl && el.id !== "modeNotice") el.remove();
  });
  welcomeEl.hidden = false;
  renderSuggestions();
  inputEl.focus();
  // 重置服务端会话（失败静默，不影响本地清空）
  try {
    await askReset();
  } catch {}
}

// ---------- 事件绑定 ----------
function trySubmit() {
  const text = inputEl.value.trim();
  if (!text || busy) return;
  inputEl.value = "";
  autoResize();
  send(text);
}

btnSend.addEventListener("click", trySubmit);

inputEl.addEventListener("input", () => {
  autoResize();
  refreshSendBtn();
});

inputEl.addEventListener("keydown", (e) => {
  // Enter 发送、Shift+Enter 换行；isComposing 保护中文输入法
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    trySubmit();
  }
});

btnNew.addEventListener("click", () => { newConversation(); });

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 120) + "px";
}

// ---------- 启动 ----------
(async function bootstrap() {
  await loadConfig();
  applyConfig();
  msgHistory = loadHistory();
  restoreHistory();
  await initTransport();
  inputEl.focus();
})();
