"""文档问答 agent：唯一的工具是 read（只能访问文档库目录）。

流程：用户提问 → LLM 决定调用 read 查看目录/文件 → 拿到文档内容后 → 生成最终回答。
"""

from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv
from openai import OpenAI

from .read_tool import ReadTool

MAX_TURNS = 10  # 最多工具调用轮数，防止死循环

READ_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "read",
        "description": "读取文档库内容。path 传目录（如 '/' 或 '子目录'）返回文件清单；传文件路径返回内容（xlsx/pdf 自动转成文本），带行号。大文件可用 offset/limit 分页读取。",
        "parameters": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "相对文档库根目录的路径，如 '/'、'报表.xlsx'、'子目录/文件.pdf'",
                },
                "offset": {"type": "integer", "description": "起始行号，默认 1"},
                "limit": {"type": "integer", "description": "最多返回行数，默认 800"},
            },
            "required": ["path"],
        },
    },
}

SYSTEM_PROMPT = """你是一个文档问答助手。文档库位于一个受限目录中，你只有一个工具 read：
- read({"path": "/"}) 列出文档库根目录的文件清单；read({"path": "子目录"}) 列出子目录。
- read({"path": "文件名"}) 读取文件内容。xlsx/pdf 会自动转成带行号的文本；大文件用 offset/limit 分页。
- 你只能访问文档库内的文件，无法访问其他任何位置。

回答规则：
1. 先查看目录清单，根据文件名和用户问题判断需要读哪些文件，再逐个读取。
2. 回答必须基于文档内容，引用依据时注明来源文件（及工作表/页码）。文档中没有的信息就明确说明"文档中未提及"，不要编造。
3. 找到足够信息后直接给出最终回答，不要复述工具输出原文。用中文回答。"""


def make_client() -> OpenAI:
    load_dotenv()
    api_key = os.getenv("LLM_API_KEY")
    if not api_key:
        raise RuntimeError("缺少 LLM_API_KEY，请在 .env 中配置（参考 .env.example）")
    return OpenAI(
        api_key=api_key,
        base_url=os.getenv("LLM_BASE_URL", "https://open.bigmodel.cn/api/paas/v4"),
    )


class DocAgent:
    def __init__(self, docs_root: Path, verbose: bool = True):
        self.client = make_client()
        self.model = os.getenv("LLM_MODEL", "glm-4-flash")
        self.tool = ReadTool(docs_root)
        self.verbose = verbose
        self.messages: list[dict] = []

    def _log(self, text: str):
        if self.verbose:
            print(text)

    def ask(self, question: str) -> str:
        self.messages = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": question},
        ]
        for _ in range(MAX_TURNS):
            resp = self.client.chat.completions.create(
                model=self.model,
                messages=self.messages,
                tools=[READ_TOOL_SCHEMA],
            )
            msg = resp.choices[0].message
            self.messages.append(msg.model_dump(exclude_none=True))

            if not msg.tool_calls:
                return msg.content or "(空回复)"

            for tc in msg.tool_calls:
                args = _parse_args(tc.function.arguments)
                self._log(f"→ 调用 read: {args}")
                try:
                    result = self.tool.read(**args)
                except Exception as e:  # 工具内部错误也回传给模型自行调整
                    result = f"错误: {e}"
                self._log(f"← 返回 {len(result)} 字符")
                self.messages.append(
                    {"role": "tool", "tool_call_id": tc.id, "content": result}
                )
        return "(达到最大工具调用轮数，仍未得到最终答案)"


def _parse_args(raw: str | None) -> dict:
    import json

    if not raw:
        return {}
    args = json.loads(raw)
    # 只保留 read 支持的参数
    return {k: args[k] for k in ("path", "offset", "limit") if k in args}
