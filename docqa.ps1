# 文档问答 agent 启动脚本
# 用法:
#   .\docqa.ps1                          # 交互模式
#   .\docqa.ps1 -p "你的问题"            # 单次提问
#   .\docqa.ps1 -c                       # 继续上次会话

# 1) Node/pi 与 Python 环境路径
$env:PATH = "C:\Users\boyanx1\AppData\Roaming\npm;C:\Users\boyanx1\.local\share\nodejs\node-v22.19.0-win-x64;$env:PATH"
$env:DOCQA_PYTHON = "C:\Users\boyanx1\.local\share\docqa-venv\Scripts\python.exe"
$env:DOCQA_DOCS_ROOT = Join-Path $PSScriptRoot "docs"

# 2) 仅保留自定义 read 工具（禁用 read/bash/edit/write 等全部内置工具）
pi --no-builtin-tools -e (Join-Path $PSScriptRoot "pi-agent\extensions\doc-read.ts") @args
