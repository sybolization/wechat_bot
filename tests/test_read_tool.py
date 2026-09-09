"""read 工具冒烟测试（不依赖 LLM）。运行: python tests/test_read_tool.py"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from docqa.read_tool import ReadTool

root = Path(__file__).parent.parent / "docs"
tool = ReadTool(root)
fails = []


def check(name, fn, expect_ok=True):
    try:
        out = fn()
        ok = (not expect_ok) or ("错误" not in str(out)[:20])
    except Exception as e:
        out, ok = repr(e), not expect_ok
    status = "PASS" if ok else "FAIL"
    if not ok:
        fails.append(name)
    print(f"[{status}] {name}\n{(str(out)[:300])}\n")


check("读取目录清单", lambda: tool.read("/"))
check("读取 xlsx（自动转换）", lambda: tool.read("20260715光联正常班线路.xlsx", limit=15))
check("分页读取 offset=5", lambda: tool.read("20260715光联正常班线路.xlsx", offset=5, limit=3))
check("文件不存在（预期返回错误信息）", lambda: tool.read("不存在.md"), expect_ok=False)
check("拒绝绝对路径", lambda: tool.read("C:/Windows/win.ini"), expect_ok=False)
check("拒绝目录穿越", lambda: tool.read("../pyproject.toml"), expect_ok=False)
check("拒绝子目录穿越", lambda: tool.read("a/../../main.py"), expect_ok=False)

# pdf 转换测试：生成一个临时 pdf
import pymupdf

pdf_path = root / "_test_tmp.pdf"
doc = pymupdf.open()
page = doc.new_page()
page.insert_textbox((50, 50, 400, 120), "Hello DocQA\n这是第二行 PDF 文本 123", fontname="china-s", fontsize=11)
doc.save(pdf_path)
doc.close()
check("读取 pdf（自动转换）", lambda: tool.read("_test_tmp.pdf"))
pdf_path.unlink()

print("=" * 40)
print("全部通过" if not fails else f"失败项: {fails}")
sys.exit(1 if fails else 0)
