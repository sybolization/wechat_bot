"""read 工具命令行入口，供 pi 扩展调用。

用法: python -m docqa.cli <path> [--offset N] [--limit M]
环境变量 DOCQA_DOCS_ROOT 指定文档库目录（默认 ./docs）。
"""

import argparse
import os
import sys
from pathlib import Path

from .read_tool import ReadTool


def main() -> int:
    # stdout 被管道接管时 Windows 默认用 GBK 写入，而调用方（Node 扩展）按 UTF-8 解码，
    # 必须显式统一为 UTF-8，否则中文文件名会变乱码
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")

    parser = argparse.ArgumentParser(description="受限文档库 read 工具")
    parser.add_argument("path", help="相对文档库的路径，目录返回清单，文件返回内容")
    parser.add_argument("--offset", type=int, default=1, help="起始行号")
    parser.add_argument("--limit", type=int, default=800, help="最多返回行数")
    args = parser.parse_args()

    root = Path(os.environ.get("DOCQA_DOCS_ROOT", "docs"))
    tool = ReadTool(root)
    try:
        # 参数输出到 stdout，未捕获异常退避到 stderr
        print(tool.read(args.path, offset=args.offset, limit=args.limit))
    except Exception as e:
        print(f"错误: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
