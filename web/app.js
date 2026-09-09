/* DocQA 前端逻辑：会话管理（localStorage）+ SSE 流式渲染 */
"use strict";

const $ = (sel) => document.querySelector(sel);
const messagesEl = $("#messages");
const inputEl = $("#input");
const btnSend = $("#btnSend");
const btnNew = $("#btnNew");
const sessionListEl = $("#sessionList");
const chatTitleEl = $("#chatTitle");
const statusEl = $("#statusDot");
const welcomeEl = $("#welcome");

const LS_KEY = "docqa.sessions.v1";
const HAS_MARKED =
  typeof window.marked === "object" && window.marked !== null &&
  typeof window.marked.parse === "function";
if (HAS_MARKED) {
  marked.setOptions({ gfm: true, breaks: true });
}

// ---------- 状态 ----------
let sessions = loadSessions();          // [{id,title,created,messages:[]}]
let currentId = localStorage.getItem("docqa.current") || null;
let streaming = false;                  // 是否正在回答
let aborting = false;

function loadSessions() {
  try {
    return JSON.parse(localStorage.getItem(LS_KEY)) || [];
  } catch {
    return [];
  }
}
function saveSessions() {
  localStorage.setItem(LS_KEY, JSON.stringify(sessions));
  localStorage.setItem("docqa.current", currentId || "");
}
const cur = () => sessions.find((s) => s.id === currentId);

// ---------- 会话管理 ----------
function newSession() {
  const s = { id: crypto.randomUUID(), title: "新对话", created: Date.now(), messages: [] };
  sessions.unshift(s);
  currentId = s.id;
  saveSessions();
  renderAll();
  inputEl.focus();
}
function switchSession(id) {
  currentId = id;
  saveSessions();
  renderAll();
}
async function deleteSession(id) {
  sessions = sessions.filter((s) => s.id !== id);
  if (currentId === id) {
    try {
      await fetch(`/api/session/${id}`, { method: "DELETE" });
    } catch {}
    currentId = sessions[0]?.id || null;
  }
  saveSessions();
  renderAll();
}

function renderSessionList() {
  sessionListEl.innerHTML = "";
  for (const s of sessions) {
    const item = document.createElement("div");
    item.className = "session-item" + (s.id === currentId ? " active" : "");
    const label = document.createElement("span");
    label.textContent = s.title === "新对话" ? "新对话" : s.title;
    label.style.cssText = "flex:1;overflow:hidden;text-overflow:ellipsis";
    const del = document.createElement("button");
    del.className = "del";
    del.textContent = "✕";
    del.title = "删除对话";
    del.onclick = (e) => {
      e.stopPropagation();
      deleteSession(s.id);
    };
    item.append(label, del);
    item.onclick = () => switchSession(s.id);
    sessionListEl.appendChild(item);
  }
}

// ---------- 消息渲染 ----------
function renderAll() {
  renderSessionList();
  const s = cur();
  chatTitleEl.textContent = s ? (s.title === "新对话" ? "新对话" : s.title) : "新对话";
  messagesEl.innerHTML = "";
  welcomeEl.style.display = s && s.messages.length ? "none" : "";
  messagesEl.appendChild(welcomeEl);
  if (s) for (const m of s.messages) appendMessage(m, false);
  scrollBottom(true);
}

function appendMessage(m, animate) {
  const wrap = document.createElement("div");
  if (m.role === "user") {
    wrap.className = "msg msg-user";
    const b = document.createElement("div");
    b.className = "bubble";
    b.textContent = m.content;
    wrap.appendChild(b);
  } else {
    wrap.className = "msg msg-assistant";
    wrap.innerHTML = `
      <div class="assistant-body">
        <details class="thinking" ${m.thinking ? "" : "hidden"}>
          <summary>思考过程</summary>
          <div class="think-body"></div>
        </details>
        <div class="tools"></div>
        <div class="md"></div>
      </div>`;
    const thinkBody = wrap.querySelector(".think-body");
    thinkBody.textContent = m.thinking || "";
    renderTools(wrap.querySelector(".tools"), m.tools || []);
    renderMarkdown(wrap.querySelector(".md"), m.content || "", animate && streaming);
  }
  messagesEl.appendChild(wrap);
  return wrap;
}

function renderTools(container, tools) {
  container.innerHTML = "";
  for (const t of tools) {
    container.appendChild(toolChip(t));
  }
}

function toolChip(t) {
  const el = document.createElement("span");
  el.className = "tool-chip" + (t.done ? " done" : "") + (t.failed ? " failed" : "");
  const spin = document.createElement("span");
  spin.className = "spinner";
  const name = document.createElement("span");
  name.className = "t-name";
  name.textContent = t.name;
  const arg = document.createElement("span");
  arg.className = "t-arg";
  arg.textContent = t.argText || "";
  el.append(spin, name, arg);
  if (t.done) {
    const mark = document.createElement("span");
    mark.textContent = t.failed ? "✕" : "✓";
    el.appendChild(mark);
  }
  return el;
}

function renderMarkdown(el, text, withCursor) {
  if (HAS_MARKED) {
    // 先转义原始 HTML，防止注入；markdown 语法仍正常渲染
    const safe = normalizeTables(
      text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"),
    );
    el.innerHTML = marked.parse(safe) + (withCursor ? '<span class="cursor"></span>' : "");
  } else {
    el.textContent = text;
    if (withCursor) el.appendChild(Object.assign(document.createElement("span"), { className: "cursor" }));
  }
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
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < 120;
  if (force || nearBottom) messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ---------- 发送与流式 ----------
function refreshSendBtn() {
  // 回答中按钮是"停止"（可用）；空闲时有文字才可发送
  btnSend.disabled = streaming ? false : !inputEl.value.trim();
}

function setBusy(busy) {
  streaming = busy;
  btnSend.classList.toggle("stop", busy);
  refreshSendBtn();
  $("#iconSend").style.display = busy ? "none" : "";
  $("#iconStop").style.display = busy ? "" : "none";
  statusEl.className = "status" + (busy ? " busy" : "");
  statusEl.innerHTML = busy ? "<i></i>正在检索文档…" : "<i></i>就绪";
}

async function send(text) {
  if (!sessions.length || !cur()) newSession();
  const s = cur();
  s.messages.push({ role: "user", content: text });
  if (s.title === "新对话") {
    s.title = text.slice(0, 18) + (text.length > 18 ? "…" : "");
    chatTitleEl.textContent = s.title;
  }
  const assistantMsg = { role: "assistant", content: "", thinking: "", tools: [] };
  s.messages.push(assistantMsg);
  saveSessions();
  welcomeEl.style.display = "none";
  appendMessage({ role: "user", content: text }, false);
  const node = appendMessage(assistantMsg, true);
  scrollBottom(true);
  setBusy(true);

  const thinkBody = node.querySelector(".think-body");
  const detailsEl = node.querySelector("details.thinking");
  const mdEl = node.querySelector(".md");
  const toolsEl = node.querySelector(".tools");
  const toolChips = new Map();

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: s.id, message: text }),
    });
    if (!res.ok || !res.body) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    let renderTimer = null;
    const throttledRender = () => {
      if (renderTimer) return;
      renderTimer = setTimeout(() => {
        renderTimer = null;
        renderMarkdown(mdEl, assistantMsg.content, true);
        scrollBottom();
      }, 60);
    };

    let sseDone = false;
    while (!sseDone) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue;
          let ev;
          try {
            ev = JSON.parse(line.slice(5).trim());
          } catch {
            continue;
          }
          switch (ev.t) {
            case "think":
              assistantMsg.thinking += ev.delta || "";
              detailsEl.hidden = false;
              thinkBody.textContent = assistantMsg.thinking;
              thinkBody.scrollTop = thinkBody.scrollHeight;
              break;
            case "delta":
              assistantMsg.content += ev.delta || "";
              throttledRender();
              break;
            case "tool_start": {
              const argText =
                ev.args && typeof ev.args.path === "string"
                  ? ev.args.path + (ev.args.offset > 1 ? ` (从第 ${ev.args.offset} 行)` : "")
                  : JSON.stringify(ev.args || {});
              const t = { name: ev.name || "read", argText, done: false, failed: false };
              assistantMsg.tools.push(t);
              const chip = toolChip(t);
              toolChips.set(ev.toolCallId, { t, chip });
              toolsEl.appendChild(chip);
              scrollBottom();
              break;
            }
            case "tool_end": {
              const rec = toolChips.get(ev.toolCallId);
              if (rec) {
                rec.t.done = true;
                rec.t.failed = !!ev.isError;
                const fresh = toolChip(rec.t);
                rec.chip.replaceWith(fresh);
                toolChips.set(ev.toolCallId, { t: rec.t, chip: fresh });
              }
              break;
            }
            case "error":
              assistantMsg.content += (assistantMsg.content ? "\n\n" : "") + `> ⚠️ ${ev.message}`;
              renderMarkdown(mdEl, assistantMsg.content, false);
              statusEl.className = "status error";
              break;
            case "done":
              sseDone = true;
              // 取消挂起的节流渲染，避免它把光标又加回来
              if (renderTimer) {
                clearTimeout(renderTimer);
                renderTimer = null;
              }
              renderMarkdown(mdEl, assistantMsg.content, false);
              break;
          }
        }
      }
    }
    renderMarkdown(mdEl, assistantMsg.content, false);
  } catch (e) {
    assistantMsg.content += (assistantMsg.content ? "\n\n" : "") + `> ⚠️ 请求失败：${e.message}`;
    renderMarkdown(mdEl, assistantMsg.content, false);
  } finally {
    setBusy(false);
    aborting = false;
    saveSessions();
    renderSessionList();
    inputEl.focus();
  }
}

// ---------- 事件绑定 ----------
btnSend.onclick = () => {
  if (streaming) {
    aborting = true;
    const s = cur();
    if (s) fetch("/api/abort", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: s.id }),
    }).catch(() => {});
  } else {
    const text = inputEl.value.trim();
    if (text) {
      inputEl.value = "";
      autoResize();
      send(text);
    }
  }
};
inputEl.addEventListener("input", () => {
  autoResize();
  refreshSendBtn();
});
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!streaming && inputEl.value.trim()) btnSend.click();
  }
});
btnNew.onclick = newSession;
$("#btnSidebar").onclick = () => $("#sidebar").classList.toggle("hidden");
welcomeEl.addEventListener("click", (e) => {
  if (e.target.classList.contains("chip")) {
    inputEl.value = e.target.textContent;
    autoResize();
    refreshSendBtn();
    inputEl.focus();
  }
});

function autoResize() {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}

// ---------- 启动 ----------
if (!sessions.length) newSession();
else if (!cur()) currentId = sessions[0].id;
renderAll();
inputEl.focus();
