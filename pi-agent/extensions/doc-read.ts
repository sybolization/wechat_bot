/**
 * docqa read 扩展：为 pi 注册唯一的工具 read（受限文档库版）。
 *
 * - 内置工具全部禁用（配合 pi --no-builtin-tools 使用）。
 * - read 通过 Python 子进程实现（docqa.cli），路径安全与 xlsx/pdf→文本
 *   转换都在 Python 侧（docqa/read_tool.py + converter.py）完成。
 * - 环境变量：DOCQA_DOCS_ROOT（文档库目录）、DOCQA_PYTHON（解释器路径）。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import path from "node:path";

export default function (pi: ExtensionAPI) {
  const docsRoot = path.resolve(
    process.env.DOCQA_DOCS_ROOT ?? path.join(process.cwd(), "docs"),
  );
  const python = process.env.DOCQA_PYTHON ?? "python";

  pi.registerTool({
    name: "read",
    label: "Read（文档库）",
    description:
      "读取文档库内容。path 传目录（如 '/' 或 '子目录'）返回文件清单；" +
      "传文件路径返回内容（md/txt 原文，xlsx/pdf 自动转成带行号的文本）。" +
      "只能访问文档库内文件；大文件用 offset/limit 分页读取。",
    parameters: Type.Object({
      path: Type.String({
        description: "相对文档库根目录的路径，如 '/'、'班车.xlsx'、'子目录/报告.pdf'",
      }),
      offset: Type.Optional(
        Type.Number({ description: "起始行号，默认 1" }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "最多返回行数，默认 800，最大 2000" }),
      ),
    }),

    async execute(_toolCallId, params) {
      const args = [
        "-m",
        "docqa.cli",
        String(params.path),
        "--offset",
        String(params.offset ?? 1),
        "--limit",
        String(params.limit ?? 800),
      ];
      const res = spawnSync(python, args, {
        cwd: path.dirname(docsRoot), // 确保能 import 到 docqa 包
        env: { ...process.env, DOCQA_DOCS_ROOT: docsRoot },
        encoding: "utf-8",
        windowsHide: true,
      });
      let text = (res.stdout ?? "").trim();
      const err = (res.stderr ?? "").trim();
      if (!text && err) text = err;
      if (!text) text = "(read 无输出)";
      return {
        content: [{ type: "text", text }],
        details: {},
      };
    },
  });
}
