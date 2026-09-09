"""文档问答 agent CLI。

用法:
  uv run main.py                     # 交互模式
  uv run main.py -q "你的问题"        # 单次提问
"""

import argparse
import sys
from pathlib import Path

from docqa.agent import DocAgent

DEFAULT_DOCS = Path(__file__).parent / "docs"


def main():
    parser = argparse.ArgumentParser(description="基于文档库的问答 agent")
    parser.add_argument("-q", "--question", help="单次提问；不传则进入交互模式")
    parser.add_argument("--docs", type=Path, default=DEFAULT_DOCS, help="文档库目录（默认 ./docs）")
    parser.add_argument("--quiet", action="store_true", help="不打印工具调用过程")
    args = parser.parse_args()

    agent = DocAgent(args.docs, verbose=not args.quiet)

    if args.question:
        print(agent.ask(args.question))
        return

    print(f"文档问答 agent（文档库: {args.docs.resolve()}），输入问题开始，exit 退出。")
    while True:
        try:
            question = input("\n你> ").strip()
        except (EOFError, KeyboardInterrupt):
            break
        if not question or question.lower() in ("exit", "quit", "q"):
            break
        try:
            print(f"\nagent> {agent.ask(question)}")
        except Exception as e:
            print(f"出错: {e}", file=sys.stderr)


if __name__ == "__main__":
    main()
