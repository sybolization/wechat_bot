# 打包企微机器人测试通道专用 zip（独立云托管服务，不与业务包 docqa-cloudrun-<KB>.zip 混装）。
# 部署：微信云托管新建「非 Web 服务」（仅前台进程，实例数 1），上传本 zip。
# 说明：本通道仅测试用；wecom-bot.js 出站长连接企微，agent 在云端出站调 DeepSeek（绕开公司网络拦截）。
# 用法: powershell -File tools\pack-wecombot.ps1 -KB molex   （默认 molex）

param([string]$KB = "molex")

$ErrorActionPreference = "Stop"
if (@("guanglian", "molex") -notcontains $KB) {
    throw "未知知识库: $KB（可选 guanglian | molex）"
}
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "cloudrun"
$stage = Join-Path $env:TEMP "wecombot-upload"

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# 测试通道仅需：入口 + core + 网络层 + env 加载 + 文档库（无 server.js/identity/webapi/webui）
Copy-Item (Join-Path $src "wecom-bot.js") $stage
Copy-Item (Join-Path $src "envload.js") $stage
Copy-Item (Join-Path $src "net.js") $stage
Copy-Item (Join-Path $src ".env") $stage
Copy-Item (Join-Path $src "core") (Join-Path $stage "core") -Recurse
Copy-Item (Join-Path $src "docs\$KB") (Join-Path $stage "docs") -Recurse
Get-ChildItem $stage -Recurse -Force -Filter ".keep" | Remove-Item -Force

# package.json：业务依赖（xlsx/pdf-parse/undici）+ 测试专用 SDK（写入 dependencies，
# 云端镜像按此安装；本地业务包仍用 pack-cloudrun.ps1 的白名单，不受影响）
$pkg = Get-Content (Join-Path $src "package.json") -Raw | ConvertFrom-Json
$pkg.dependencies | Add-Member -NotePropertyName "@wecom/aibot-node-sdk" -NotePropertyValue "^1.0.7" -Force
$pkg | ConvertTo-Json -Depth 10 | Set-Content (Join-Path $stage "package.json") -Encoding UTF8

# staged .env：ACTIVE_KB 改写为当前库（UTF-8 无 BOM，与 pack-cloudrun.ps1 同策略）
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$envText = [System.IO.File]::ReadAllText((Join-Path $src ".env"), $utf8NoBom)
$envText = $envText -replace "(?m)^ACTIVE_KB=.*$", "ACTIVE_KB=$KB"
[System.IO.File]::WriteAllText((Join-Path $stage ".env"), $envText, $utf8NoBom)

# 打 zip
Set-Location $stage
$zipPath = Join-Path $root "wecombot-cloudrun-$KB.zip"
tar.exe -a -cf $zipPath --exclude node_modules .
Set-Location $root

Write-Host "打包完成: $zipPath"
