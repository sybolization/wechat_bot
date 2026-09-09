"""受限 read 工具：agent 唯一可用的工具，只能访问文档库目录（docs/）。

- 传目录路径 → 返回目录下的文件清单（供 agent 发现文档）。
- 传文件路径 → 自动把 xlsx/pdf 转成文本后返回，带行号，支持 offset/limit 分段读取。
- 路径安全：解析后必须位于文档库根目录之内，防止目录穿越/越权访问。
"""

from __future__ import annotations

from pathlib import Path, PurePosixPath

from .converter import to_markdown

DEFAULT_LIMIT = 800  # 默认单次最多返回行数，防止一次性撑爆上下文
MAX_LINE_LEN = 2000  # 单行超长截断


class ReadTool:
    def __init__(self, docs_root: Path):
        self.root = docs_root.resolve()
        if not self.root.is_dir():
            raise NotADirectoryError(f"文档库目录不存在: {self.root}")

    # ---------- 路径安全 ----------
    def _resolve(self, path: str) -> Path:
        if path in ("", "/", ".", "./", ".\\"):
            return self.root
        p = PurePosixPath(path.replace("\\", "/"))
        if p.is_absolute() or ".." in p.parts:
            # 只允许相对文档库根目录的路径
            raise PermissionError(f"非法路径: {path}（只能使用相对文档库的路径，如 '报表.xlsx' 或 '子目录/文件.pdf'）")
        resolved = (self.root / p).resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise PermissionError(f"越权访问: {path}（超出文档库范围）")
        return resolved

    # ---------- 工具入口 ----------
    def read(self, path: str, offset: int = 1, limit: int = DEFAULT_LIMIT) -> str:
        target = self._resolve(path)
        if target.is_dir():
            return self._list_dir(target, path)
        if not target.is_file():
            return f"错误: 文件不存在: {path}。可先用 read 查看目录获取文件清单。"
        try:
            text = to_markdown(target)
        except Exception as e:
            return f"错误: 读取/转换失败: {e}"
        return self._paginate(text, path, offset, limit)

    # ---------- 目录清单 ----------
    def _list_dir(self, d: Path, display: str) -> str:
        entries = sorted(d.iterdir(), key=lambda x: (x.is_file(), x.name.lower()))
        if not entries:
            return f"目录 {display} 为空。"
        lines = [f"目录 {display} 内容（{len(entries)} 项）:", "类型 | 大小 | 名称"]
        for e in entries:
            rel = e.relative_to(self.root).as_posix()
            if e.is_dir():
                lines.append(f"目录 | - | {rel}/")
            else:
                lines.append(f"文件 | {e.stat().st_size}B | {rel}")
        lines.append("")
        lines.append("提示: 对文件名调用 read 即可读取内容；xlsx/pdf 会自动转成文本。")
        return "\n".join(lines)

    # ---------- 分页 + 行号（cat -n 风格） ----------
    @staticmethod
    def _paginate(text: str, path: str, offset: int, limit: int) -> str:
        lines = text.splitlines()
        total = len(lines)
        offset = max(1, int(offset))
        limit = max(1, min(int(limit), 2000))
        chunk = lines[offset - 1 : offset - 1 + limit]
        if not chunk:
            return f"{path}: 行 {offset} 超出范围（共 {total} 行）。"
        width = len(str(offset + len(chunk) - 1))
        out = [f"{path}（共 {total} 行，当前显示 {offset}-{offset + len(chunk) - 1}）"]
        for i, line in enumerate(chunk, start=offset):
            line = line if len(line) <= MAX_LINE_LEN else line[:MAX_LINE_LEN] + "…"
            out.append(f"{str(i).rjust(width)}→{line}")
        if offset - 1 + limit < total:
            out.append(f"...（还有更多行，用 offset={offset + limit} 继续读取）")
        return "\n".join(out)
