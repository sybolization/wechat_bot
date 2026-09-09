#!/usr/bin/env node
/**
 * 微信公众号文章抓取工具：把 mp.weixin.qq.com 文章保存为 Markdown，供文档问答 agent 检索。
 *
 * 用法:
 *   node tools/wechat-fetch.js <微信文章URL或已下载的html文件> [输出目录，默认 ./docs]
 *
 * 说明:
 * - WebFetch/纯接口会被微信拦截，这里用浏览器 UA 直接请求（文章是服务端渲染，可直接拿到正文）。
 * - 正文取自 js_content 容器，转换为 Markdown（保留标题/加粗/列表/引用）。
 *   技术路线：不抓取图片——文档库面向 LLM 检索，图片链接是噪音（2026-09 定）。
 * - 后续如需让 agent 具备“访问链接”能力，可将本脚本注册为 pi 工具（当前未接入）。
 */

const fs = require("fs");
const path = require("path");

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

function decodeEntities(s) {
  const map = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&#39;": "'", "&apos;": "'", "&mdash;": "—", "&ndash;": "–",
    "&hellip;": "…", "&ldquo;": "\u201c", "&rdquo;": "\u201d",
    "&lsquo;": "\u2018", "&rsquo;": "\u2019", "&middot;": "·", "&times;": "×",
  };
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&[a-z]+;/gi, (m) => map[m.toLowerCase()] ?? m);
}

function extract(html) {
  let m = html.match(/<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)<\/h1>/)
        || html.match(/<meta property="og:title" content="([^"]*)"/);
  if (!m) throw new Error("未找到文章标题（可能被微信风控拦截，返回了验证页）");
  const title = decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim();

  m = html.match(/<span[^>]*id="js_name"[^>]*>([\s\S]*?)<\/span>/)
   || html.match(/<meta property="og:article:author" content="([^"]*)"/);
  const author = m ? decodeEntities(m[1].replace(/<[^>]+>/g, "")).trim() : "";

  const idIdx = html.indexOf('id="js_content"');
  if (idIdx < 0) throw new Error("未找到正文容器 js_content");
  const divStart = html.lastIndexOf("<div", idIdx);
  const gt = html.indexOf(">", divStart);

  // 按 div 嵌套深度找配对的 </div>
  const divOpen = /<div\b/g;
  divOpen.lastIndex = gt + 1;
  let depth = 1, pos = gt + 1, end = -1;
  while (depth > 0) {
    const o = divOpen.exec(html);
    const c = html.indexOf("</div>", pos);
    if (c < 0) throw new Error("正文容器未闭合");
    if (o && o.index < c) { depth++; pos = divOpen.lastIndex; }
    else { depth--; pos = c + 6; if (depth === 0) end = c; }
  }
  return { title, author, contentHtml: html.slice(gt + 1, end) };
}

function htmlToMd(h) {
  let s = h;
  s = s.replace(/<img\b[^>]*>/gi, ""); // 技术路线：不带图片
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, "**$2**");
  s = s.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, "*$2*");
  s = s.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, lv, t) => `\n\n${"#".repeat(+lv)} ${t.trim()}\n\n`);
  s = s.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, "- $1\n");
  s = s.replace(/<\/?(ul|ol)\b[^>]*>/gi, "\n");
  s = s.replace(/<blockquote\b[^>]*>/gi, "\n> ");
  s = s.replace(/<\/blockquote>/gi, "\n");
  s = s.replace(/<(p|section|div|tr)\b[^>]*>/gi, "\n");
  s = s.replace(/<\/(p|section|div|tr|li)>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  s = s.replace(/[\u200b\u200c\u200d\ufeff]/g, "");
  s = s.split("\n").map((l) => l.replace(/[ \t\u00a0]+/g, " ").trimEnd()).join("\n");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

async function main() {
  const [input, outDir = "docs"] = process.argv.slice(2);
  if (!input) {
    console.error("用法: node tools/wechat-fetch.js <微信文章URL或html文件> [输出目录]");
    process.exit(1);
  }
  let html, source = input;
  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input, { headers: { "User-Agent": UA } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    html = await res.text();
  } else {
    html = fs.readFileSync(input, "utf8");
    source = "(本地文件)";
  }
  const { title, author, contentHtml } = extract(html);
  const md = htmlToMd(contentHtml);
  const safe = title.replace(/[\\/:*?"<>|\r\n]/g, "").slice(0, 60).trim();
  const file = path.join(outDir, `${safe}.md`);
  const head = `# ${title}\n\n> 来源：微信公众号 ${author}\n> 原文链接：${source}\n\n`;
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(file, head + md + "\n", "utf8");
  console.log(JSON.stringify({ title, author, chars: md.length, file }));
}

main().catch((e) => { console.error("抓取失败:", e.message); process.exit(1); });
