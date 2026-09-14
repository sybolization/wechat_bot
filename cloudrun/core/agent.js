/** 轻量 agent：DeepSeek 直连 tool-calling 循环 + read 工具（读镜像内 docs/ 文档库）。 */

const fs = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const { fetch2 } = require("../net");
const { buildMessages, estimateTokens, truncateByTokens, TOOL_RESERVE } = require("./session");

// 文档库在仓库根的 cloudrun/docs（本文件已移入 core/ 子目录，故取上级）
const DOCS_BASE = path.join(__dirname, "..", "docs");
// 知识库开关：.env ACTIVE_KB = guanglian | molex（只能同时访问其中一个库）
const ACTIVE_KB = (process.env.ACTIVE_KB || "guanglian").replace(/[^a-z]/g, "") || "guanglian";
const DOCS_ROOT = path.join(DOCS_BASE, ACTIVE_KB);
const MODEL = process.env.DEEPSEEK_MODEL || "deepseek-flash";
// 主模型失效（如限时模型 expires-on-0910 过期、下架）时自动回退的备用模型
const FALLBACK_MODEL = "deepseek-flash";
let activeModel = MODEL;
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
4. 回答要短，直接给出答案，不铺垫、不复述问题。
5. 结尾禁止任何确认式提问或客套语（如"请问您需要的是这个信息吗""还有其他可以帮您的吗"），答完即止。
6. 禁止提及"文档""资料""来源""根据xx文件"等字样，直接陈述结论。
7. 资料中没有的信息，回复："这个问题我暂时没有相关信息，您可以回复转人工咨询人工客服"。
8. 严格禁止输出任何代码、命令、程序片段或技术细节；用户问此类问题，礼貌说明暂不提供此类内容。
9. 禁止使用任何 Markdown 语法：不用 #、*、-、表格、代码块、引用符。多个要点用"1. 2. 3."纯文本序号。
10. 用中文回复。
11. 涉及年龄、性别、婚姻生育、健康状况、疾病、犯罪记录/案底、宗教信仰、民族/籍贯等个人身份条件的录用问题（如"XX岁能入职吗""有案底能应聘吗"）：必须先调用 read({"path":"sensitive-guidelines/"}) 读取目录，再读对应分类指南（如 age.md、health.md、disease.md、criminal.md、religion.md、ethnicity.md），严格按指南中的"对外回复话术"回答；指南未覆盖时，统一回复"招聘条件以各岗位官方发布的任职要求为准，符合要求的求职者都欢迎投递"。禁止猜测、承诺或暗示任何隐性倾向，禁止透露公司内部流程（如咨询法务部、背景调查供应商）。本条优先于规则7（不走"暂无相关信息"话术）。
12. 部分资料仅适用于特定岗位/人群（如宿舍、餐补、薪资、作息等"操作员"待遇）。回答时须注明适用范围（如"操作员岗位……"），被问及其他岗位时如实说明暂无相关信息、以官方发布或与HR确认为准，不得把某一类岗位的待遇泛化为全公司统一标准。
13. 高频特殊问题（饭堂/食堂口味"好吃吗"、肺结核病史等）：先调用 read({"path":"special-qa/"}) 读取目录，再读其中 README 路由表，命中关键词即读对应文件并严格按其"对外回复话术"回答；与规则11敏感话题同时命中时，special-qa 的专门口径优先（如肺结核细则优先于 disease.md 通用话术）；未命中关键词的按其他规则处理。本条优先于规则7。
14. 禁止绝对化判断：没有从资料中确认的事实，不得说"没有要求""不限制""肯定不影响"等断言。资料未提及的招聘条件（如身高、体重、外形等），回答"未提及该条件"，并以"招聘条件以各岗位官方发布的任职要求为准，符合要求的求职者都欢迎投递"收尾。`;

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
      .filter((r) => r.some((c) => c.trim() !== ""))
      // 裁掉行尾空单元格：源表常有远超实际内容的 !ref 范围，不裁会逐行补齐出大量空列
      .map((r) => { const c = r.slice(); while (c.length && c[c.length - 1].trim() === "") c.pop(); return c; });
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
// 需要逐字消费的渠道通过 opts.onDelta(piece, full) 订阅增量。
async function chat(messages, useTools, onDelta) {
  // 发起请求；错误对象附上 status/body 供回退判断
  const request = (model) => fetch2(`${API_BASE}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      reasoning_effort: REASONING_EFFORT,
      stream: true,
      ...(useTools ? { tools: [READ_TOOL] } : {}),
    }),
  });
  let res;
  try {
    res = await request(activeModel);
    if (!res.ok) {
      const e = new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      e.status = res.status;
      throw e;
    }
  } catch (e) {
    // 模型不可用（如限时模型过期、下架）：自动路由回备用 flash 模型并记住，避免后续请求重复失败
    const modelUnavailable = e.status === 400 || e.status === 404 || /model/i.test(e.message || "");
    if (modelUnavailable && activeModel !== FALLBACK_MODEL) {
      console.warn(`[agent] 模型 ${activeModel} 不可用，自动回退到 ${FALLBACK_MODEL}`);
      activeModel = FALLBACK_MODEL;
      res = await request(activeModel);
      if (!res.ok) throw new Error(`DeepSeek HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    } else {
      throw e;
    }
  }

  let content = "";
  const toolCalls = []; // 按 index 聚合分片：{ id, type, function: { name, arguments } }
  let buf = "";
  // SSE 按行解析；StringDecoder 缓冲跨 chunk 截断的多字节 UTF-8 字符，避免答案出现乱码（U+FFFD）
  const decoder = new StringDecoder("utf-8");
  const handleLine = (line) => {
    if (!line.startsWith("data:")) return true;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") return false;
    let ev;
    try { ev = JSON.parse(payload); } catch { return true; }
    const delta = ev.choices && ev.choices[0] && ev.choices[0].delta;
    if (!delta) return true;
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
    return true;
  };
  const feed = (piece) => {
    buf += piece;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!handleLine(line)) { buf = ""; return; }
    }
  };
  for await (const chunk of res.body) feed(decoder.write(chunk));
  feed(decoder.end());

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
