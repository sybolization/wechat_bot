# 文档问答 Web 界面启动脚本
# 用法: .\webqa.ps1   （自动打开浏览器 http://localhost:3123）

$env:PATH = "C:\Users\boyanx1\.local\share\nodejs\node-v22.19.0-win-x64;$env:PATH"
$env:DOCQA_PYTHON = "C:\Users\boyanx1\.local\share\docqa-venv\Scripts\python.exe"
$env:DOCQA_DOCS_ROOT = Join-Path $PSScriptRoot "docs"

# 若端口已被占用，先结束旧进程（防止 EADDRINUSE 竞态）
$old = Get-NetTCPConnection -LocalPort 3123 -State Listen -ErrorAction SilentlyContinue
if ($old) {
    foreach ($procId in ($old.OwningProcess | Select-Object -Unique)) {
        Write-Host "端口 3123 已被 PID $procId 占用，结束旧进程..."
        Stop-Process -Id $procId -Force -ErrorAction SilentlyContinue
    }
    # 等待端口释放
    for ($i = 0; $i -lt 20; $i++) {
        if (-not (Get-NetTCPConnection -LocalPort 3123 -State Listen -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 200
    }
}

# 若当前进程没有 DEEPSEEK_API_KEY，从用户环境变量读取（终端可能是在设置变量之前打开的）
if (-not $env:DEEPSEEK_API_KEY) {
    $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
}

Write-Host "启动文档问答 Web（DEEPSEEK_API_KEY 需在用户环境变量中）..."
Start-Process "http://localhost:3123"
node "$PSScriptRoot\web\server.js"
