#!/usr/bin/env python3
"""
微信公众号文章抓取工具：把 mp.weixin.qq.com 文章保存为 Markdown，供文档问答 agent 检索。
是 tools/wechat-fetch.js（Node 版）的等效实现——本机无 Node 环境，用 uv 运行：
  uv run --no-project python tools/wechat-fetch.py <微信文章URL或已下载的html文件> [输出目录或输出文件路径]

说明:
- WebFetch/纯接口会被微信拦截，这里用浏览器 UA 直接请求（文章是服务端渲染，可直接拿到正文）。
- 正文取自 js_content 容器，转换为 Markdown（保留标题/加粗/列表/引用）。
  技术路线：不抓取图片——文档库面向 LLM 检索，图片链接是噪音（2026-09 定）。
- 输出路径为目录时，文件名取文章标题（原样保留中文）；为 .md 文件路径时按指定名写入
  （cloudrun/docs 下的文档必须用 ASCII 文件名，否则 Docker 构建失败）。
"""

import html as html_mod
import json
import os
import re
import sys
import urllib.request

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")

# 保证中文输出不因管道编码报错（Windows 下 print 到管道默认 GBK）
sys.stdout.reconfigure(encoding="utf-8")
sys.stderr.reconfigure(encoding="utf-8")

ENTITY_MAP = {
    "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"',
    "&apos;": "'", "&mdash;": "—", "&ndash;": "–", "&hellip;": "…",
    "&ldquo;": "\u201c", "&rdquo;": "\u201d", "&lsquo;": "\u2018",
    "&rsquo;": "\u2019", "&middot;": "·", "&times;": "×",
}


def decode_entities(s: str) -> str:
    def num(m):
        return chr(int(m.group(1)))
    def hexnum(m):
        return chr(int(m.group(1), 16))
    s = re.sub(r"&#(\d+);", num, s)
    s = re.sub(r"&#x([0-9a-fA-F]+);", hexnum, s)
    s = re.sub(r"&[a-zA-Z]+;", lambda m: ENTITY_MAP.get(m.group(0).lower(), m.group(0)), s)
    return s


def extract(page: str):
    m = (re.search(r'<h1[^>]*id="activity-name"[^>]*>([\s\S]*?)</h1>', page)
         or re.search(r'<meta property="og:title" content="([^"]*)"', page))
    if not m:
        raise RuntimeError("未找到文章标题（可能被微信风控拦截，返回了验证页）")
    title = decode_entities(re.sub(r"<[^>]+>", "", m.group(1))).strip()

    m = (re.search(r'<span[^>]*id="js_name"[^>]*>([\s\S]*?)</span>', page)
         or re.search(r'<meta property="og:article:author" content="([^"]*)"', page))
    author = decode_entities(re.sub(r"<[^>]+>", "", m.group(1))).strip() if m else ""

    idx = page.find('id="js_content"')
    if idx < 0:
        raise RuntimeError("未找到正文容器 js_content")
    div_start = page.rfind("<div", 0, idx)
    gt = page.find(">", div_start)

    # 按 div 嵌套深度找配对的 </div>
    depth, pos, end = 1, gt + 1, -1
    for o in re.finditer(r"<div\b", page[gt + 1:]):
        open_idx = gt + 1 + o.start()
        close_idx = page.find("</div>", pos)
        if close_idx < 0:
            raise RuntimeError("正文容器未闭合")
        if open_idx < close_idx:
            depth += 1
            pos = o.end()
        else:
            depth -= 1
            pos = close_idx + 6
            if depth == 0:
                end = close_idx
                break
    if end < 0:
        raise RuntimeError("正文容器未闭合")
    return title, author, page[gt + 1:end]


def html_to_md(h: str) -> str:
    s = h
    s = re.sub(r"<img\b[^>]*>", "", s, flags=re.I)  # 技术路线：不带图片
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = re.sub(r"<(strong|b)\b[^>]*>([\s\S]*?)</\1>", r"**\2**", s, flags=re.I)
    s = re.sub(r"<(em|i)\b[^>]*>([\s\S]*?)</\1>", r"*\2*", s, flags=re.I)
    s = re.sub(r"<h([1-6])\b[^>]*>([\s\S]*?)</h\1>",
               lambda m: f"\n\n{'#' * int(m.group(1))} {m.group(2).strip()}\n\n", s, flags=re.I)
    s = re.sub(r"<li\b[^>]*>([\s\S]*?)</li>", r"- \1\n", s, flags=re.I)
    s = re.sub(r"</?(ul|ol)\b[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"<blockquote\b[^>]*>", "\n> ", s, flags=re.I)
    s = re.sub(r"</blockquote>", "\n", s, flags=re.I)
    s = re.sub(r"<(p|section|div|tr)\b[^>]*>", "\n", s, flags=re.I)
    s = re.sub(r"</(p|section|div|tr|li)>", "\n", s, flags=re.I)
    s = re.sub(r"<[^>]+>", "", s)
    s = decode_entities(s)
    s = re.sub(r"[\u200b\u200c\u200d\ufeff]", "", s)
    s = "\n".join(re.sub(r"[ \t\u00a0]+", " ", line).rstrip() for line in s.split("\n"))
    s = re.sub(r"\n{3,}", "\n\n", s).strip()
    return s


def main():
    args = sys.argv[1:]
    if not args:
        print("用法: uv run --no-project python tools/wechat-fetch.py <微信文章URL或html文件> [输出目录或输出文件路径]",
            file=sys.stderr)
        sys.exit(1)
    source = args[0]
    out = args[1] if len(args) > 1 else "docs"

    if re.match(r"^https?://", source, re.I):
        req = urllib.request.Request(source, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=30) as resp:
            page = resp.read().decode("utf-8", errors="replace")
    else:
        page = open(source, encoding="utf-8").read()
        source = "(本地文件)"

    title, author, content_html = extract(page)
    md = html_to_md(content_html)

    if out.lower().endswith(".md") or (os.path.splitext(out)[1] and not os.path.isdir(out)):
        file = out
        os.makedirs(os.path.dirname(os.path.abspath(file)), exist_ok=True)
    else:
        safe = re.sub(r'[\\/:*?"<>|\r\n]', "", title)[:60].strip()
        file = os.path.join(out, f"{safe}.md")
        os.makedirs(out, exist_ok=True)

    head = f"# {title}\n\n> 来源：微信公众号 {author}\n> 原文链接：{source}\n\n"
    with open(file, "w", encoding="utf-8") as f:
        f.write(head + md + "\n")
    print(json.dumps({"title": title, "author": author, "chars": len(md), "file": file}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"抓取失败: {e}", file=sys.stderr)
        sys.exit(1)
