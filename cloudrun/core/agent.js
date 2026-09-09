/** 轻量 agent：DeepSeek 直连 tool-calling 循环 + read 工具（读镜像内 docs/ 文档库）。 */

const fs = require("node:fs");
const path = require("node:path");
const { fetch2 } = require("../net");
const { buildMessages, estimateTokens, truncateByTokens, TOOL_RESERVE } = require("./session");

// 文档库在仓库根的 cloudrun/docs（本文件已移入 core/ 子目录，故取上级）
const DOCS_BASE = path.join(__dirname, "..", "docs");
// 知识库开关：.env ACTIVE_KB = guanglian | molex（只能同时访问其中一个库）
const ACTIVE_KB = (process.env.ACTIVE_KB || "guanglian").replace(/[^a-z]/g, "") || "guanglian";
const DOCS_ROOT = path.join(DOCS_BASE, ACTIVE_KB);
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-v4-flash";
const API_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";
const MAX_TURNS = 8;
const MAX_INPUT_LEN = 500;
// 思考强度：默认 low（客服问答不需要深推理，降低延迟与成本）
const REASONING_EFFORT = (process.env.DEEPSEEK_REASONING_EFFORT || "low").toLowerCase();

const SYSTEM_PROMPT = `你是公司客服助手。你有一个内部工具 read 用于查询资料（该工具对用户不可见，回复中禁止提及它和任何资料来源）。
read 用法：
- read({"path":"/"}) 列出资料清单；read({"path":"文件名"}) 读取内容（大文件用 offset/limit 分页）。

回答规则：
1. 先查后答：收到问题立即用 read 查资料，查到就直接给出完整答案（含线路、时间等关键信息）。禁止为确认需求而反问，禁止连续追问。
2. 问题宽泛时（如只问"班车"），不要空泛反问，而是在一条回复里直接给出资料概览（有哪些线路/类别），并提示用户回复具体站点或线路名即可查详情。
3. 用户补充信息后，结合上下文直接给出最终答案，不再重复确认。
4. 回答要短：默认 2-5 句话，直接给出答案，不铺垫、不复述问题。
5. 结尾禁止任何确认式提问或客套语（如"请问您需要的是这个信息吗""还有其他可以帮您的吗"），答完即止。
6. 禁止提及"文档""资料""来源""根据xx文件"等字样，直接陈述结论。
7. 资料中没有的信息，回复："这个问题我暂时没有相关信息，您可以回复转人工咨询人工客服"。
8. 严格禁止输出任何代码、命令、程序片段或技术细节；用户问此类问题，礼貌说明暂不提供此类内容。
9. 禁止使用任何 Markdown 语法：不用 #、*、-、表格、代码块、引用符。多个要点用"1. 2. 3."纯文本序号。
10. 用中文回复。`;

const READ_TOOL = {
  type: "function",
  function: {
    name: "read",
    description: "读取文档库。path 为目录时返回文件清单；为文件时返回内容（带行号，可分页）。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对文档库的路径，如 '/' 或 '文件.xlsx'" },
        offset: { type: "integer", description: "起始行号，默认 1" },
        limit: { type: "integer", description: "最多返回行数，默认 300" },
      },
      required: ["path"],
    },
  },
};

// ---------- read 工具（Node 版，等价于 docqa/read_tool.py） ----------
const MAX_CELL = 120;
const PDF_LIMIT_ROWS = 400;

function safeResolve(p) {
  if (["", "/", ".", "./"].includes(p)) return DOCS_ROOT;
  const norm = p.replace(/\\/g, "/");
  if (path.isAbsolute(norm) || norm.split("/").includes("..")) {
    throw new Error(`非法路径: ${p}`);
  }
  const resolved = path.resolve(DOCS_ROOT, norm);
  if (resolved !== DOCS_ROOT && !resolved.startsWith(DOCS_ROOT + path.sep)) {
    throw new Error(`越权访问: ${p}`);
  }
  return resolved;
}

function xlsxToMarkdown(buf) {
  const XLSX = require("xlsx");
  const wb = XLSX.read(buf, { type: "buffer" });
  const parts = [];
  for (const name of wb.SheetNames) {
    parts.push(`## 工作表: ${name}\n`);
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    const clean = rows
      .map((r) => r.map((c) => String(c).replace(/\n/g, " ").replace(/\|/g, "\\|").slice(0, MAX_CELL)))
      .filter((r) => r.some((c) => c.trim() !== ""));
    if (!clean.length) { parts.push("(空表)\n"); continue; }
    const width = Math.max(...clean.map((r) => r.length));
    const norm = clean.map((r) => { const c = r.slice(); while (c.length < width) c.push(""); return c; });
    norm.forEach((r, i) => {
      parts.push("| " + r.join(" | ") + " |");
      if (i === 0) parts.push("|" + " --- |".repeat(width));
    });
    parts.push("");
  }
  return parts.join("\n");
}

async function pdfToText(buf) {
  let pdf;
  try { pdf = require("pdf-parse"); } catch { return "(缺少 pdf 解析组件)"; }
  const data = await pdf(buf);
  const pages = String(data.text || "").split(/\f/); // pdf-parse 用换页符分页
  const lines = [];
  pages.forEach((p, i) => {
    lines.push(`## 第 ${i + 1} 页`);
    lines.push(p.trim() || "(无文本)");
    lines.push("");
    if (lines.length > PDF_LIMIT_ROWS) return;
  });
  return lines.join("\n");
}

function paginate(text, pathStr, offset, limit) {
  const lines = text.split("\n");
  const total = lines.length;
  offset = Math.max(1, offset);
  limit = Math.max(1, Math.min(limit, 2000));
  const chunk = lines.slice(offset - 1, offset - 1 + limit);
  if (!chunk.length) return `${pathStr}: 行 ${offset} 超出范围（共 ${total} 行）。`;
  const width = String(offset + chunk.length).length;
  const out = [`${pathStr}（共 ${total} 行，显示 ${offset}-${offset + chunk.length - 1}）`];
  chunk.forEach((l, i) => out.push(`${String(offset + i).padStart(width)}→${l.slice(0, 2000)}`));
  if (offset - 1 + limit < total) out.push(`...（还有更多行，用 offset=${offset + limit} 继续）`);
  return out.join("\n");
}

function readTool(params) {
  const p = String(params.path || "/");
  const offset = Number(params.offset) || 1;
  const limit = Number(params.limit) || 300;
  const target = safeResolve(p);
  if (fs.statSync(target).isDirectory()) {
    const entries = fs.readdirSync(target, { withFileTypes: true })
      .filter((e) => e.name !== ".keep")
      .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    if (!entries.length) return "（当前知识库暂未收录任何资料）";
    const lines = [`目录 ${p} 内容（${entries.length} 项）:`, "类型 | 大小 | 名称"];
    for (const e of entries) {
      const rel = path.relative(DOCS_ROOT, path.join(target, e.name)).replace(/\\/g, "/");
      lines.push(e.isDirectory()
        ? `目录 | - | ${rel}/`
        : `文件 | ${fs.statSync(path.join(target, e.name)).size}B | ${rel}`);
    }
    lines.push("提示: 对文件名调用 read 即可读取内容。");
    return lines.join("\n");
  }
  if (!fs.existsSync(target)) return `错误: 文件不存在: ${p}。可先用 read 查看目录清单。`;
  const ext = path.extname(target).toLowerCase();
  let text;
  if ([".md", ".markdown", ".txt"].includes(ext)) text = fs.readFileSync(target, "utf-8");
  else if ([".xlsx", ".xlsm"].includes(ext)) text = xlsxToMarkdown(fs.readFileSync(target));
  else if (ext === ".pdf") text = "(PDF 需异步解析)"; // 同步占位，readAsync 处理
  else return `错误: 不支持的格式 ${ext}（支持 md/txt/xlsx/pdf）`;
  return paginate(text, p, offset, limit);
}

async function readToolAsync(params) {
  const p = String(params.path || "/");
  const offset = Number(params.offset) || 1;
  const limit = Number(params.limit) || 300;
  let target;
  try { target = safeResolve(p); } catch (e) { return `错误: ${e.message}`; }
  if (!fs.existsSync(target)) {
    if (target === DOCS_ROOT) return "（当前知识库暂未收录任何资料）";
    return `错误: 文件不存在: ${p}。可先用 read 查看目录清单。`;
  }
  const stat = fs.statSync(target);
  if (stat.isDirectory()) return readTool({ path: p });
  const ext = path.extname(target).toLowerCase();
  let text;
  try {
    if ([".md", ".markdown", ".txt"].includes(ext)) text = fs.readFileSync(target, "utf-8");
    else if ([".xlsx", ".xlsm"].includes(ext)) text = xlsxToMarkdown(fs.readFileSync(target));
    else if (ext === ".pdf") text = await pdfToText(fs.readFileSync(target));
    else return `错误: 不支持的格式 ${ext}`;
  } catch (e) { return `错误: 解析失败 ${e.message}`; }
  return paginate(text, p, offset, limit);
}

// ---------- DeepSeek 对话（统一流式：SSE 逐段接收，tool_calls 增量聚合） ----------
// 所有渠道共用本流式实现。callContainer 不支持 SSE 透传的渠道（H5）由渠道层聚合为
// 完整答案；需要逐字消费的渠道通过 opts.onDelta(piece, full) 订阅增量。
async function chat(messages, useTools, onDelta) {
  const res = await fetch2(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      reasoning_effort: REASONING_EFFORT,
      stream: true,
      ...(useTools ? { tools: [READ_TOOL] } : {}),
    }),
  });
  if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);

  let content = "";
  const toolCalls = []; // 按 index 聚合分片：{ id, type, function: { name, arguments } }
  let buf = "";
  for await (const chunk of res.body) {
    buf += Buffer.from(chunk).toString("utf-8");
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") { buf = ""; break; }
      let ev;
      try { ev = JSON.parse(payload); } catch { continue; }
      const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
      if (!delta) continue;
      if (delta.content) {
        content += delta.content;
        if (onDelta) onDelta(delta.content, content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const i = tc.index || 0;
          if (!toolCalls[i]) toolCalls[i] = { id: "", type: "function", function: { name: "", arguments: "" } };
          if (tc.id) toolCalls[i].id = tc.id;
          if (tc.function && tc.function.name) toolCalls[i].function.name += tc.function.name;
          if (tc.function && tc.function.arguments) toolCalls[i].function.arguments += tc.function.arguments;
        }
      }
    }
  }

  const msg = { role: "assistant", content };
  const calls = toolCalls.filter(Boolean);
  if (calls.length) msg.tool_calls = calls;
  return msg;
}

async function runAgent(question, openid, opts = {}) {
  if (!process.env.DEEPSEEK_API_KEY) throw new Error("未配置 DEEPSEEK_API_KEY");
  question = String(question || "").slice(0, MAX_INPUT_LEN);
  // 拼接历史上下文（system + 历史 + 新问题，按 30 条/128k token 预算裁剪）
  const messages = buildMessages(openid, SYSTEM_PROMPT, question);
  let toolTokens = 0;
  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await chat(messages, true, opts.onDelta);
    if (msg.tool_calls && msg.tool_calls.length) {
      messages.push(msg);
      for (const tc of msg.tool_calls) {
        let params = {};
        try { params = JSON.parse(tc.function.arguments || "{}"); } catch {}
        console.log(`[agent][${openid}] read(${JSON.stringify(params)})`);
        let result = await readToolAsync(params);
        // 工具结果 token 预算：防止本轮读入超大内容把输入撑爆 128k
        if (toolTokens + estimateTokens(result) > TOOL_RESERVE) {
          result = truncateByTokens(result, TOOL_RESERVE - toolTokens) || "（文档内容过长，仅能部分读取，请基于已有信息回答）";
        }
        toolTokens += estimateTokens(result);
        messages.push({ role: "tool", tool_call_id: tc.id, content: result });
      }
      continue;
    }
    return (msg.content || "").trim() || "（未能生成回答，请换个问法试试）";
  }
  return "问题较复杂，未能处理完，请尝试拆成多个小问题提问。";
}

module.exports = { runAgent, readToolAsync, ACTIVE_KB };
