# 企业微信智能机器人测试通道启动脚本（独立于业务服务，不打进云托管部署包）。
# 凭证来源：企业微信管理后台 → 协作 → 机器人 → 创建「智能机器人」后获取 BotID/Secret。
# 用法: powershell -File wecom-bot.ps1 [-BotId xxx] [-Secret xxx]

param(
    [string]$BotId = "",
    [string]$Secret = ""
)

$ErrorActionPreference = "Stop"

if (-not $env:DEEPSEEK_API_KEY) {
    # 与 webqa.ps1 同策略：从用户环境变量读取
    $env:DEEPSEEK_API_KEY = [Environment]::GetEnvironmentVariable("DEEPSEEK_API_KEY", "User")
}
if (-not $env:DEEPSEEK_API_KEY) {
    Write-Host "缺少 DEEPSEEK_API_KEY（用户环境变量或当前会话）" -ForegroundColor Red
    exit 1
}

# 测试知识库固定走 molex（与当前业务一致）；如需切换改这里
$env:ACTIVE_KB = "molex"

if (-not $BotId)   { $BotId   = Read-Host "请输入企微智能机器人 BotID" }
if (-not $Secret)  { $Secret  = Read-Host "请输入 Secret" }
$env:WECOM_BOT_ID = $BotId.Trim()
$env:WECOM_BOT_SECRET = $Secret.Trim()

Write-Host "启动企微机器人测试通道（出站 wss://openws.work.weixin.qq.com，需网络放行）..."
node "$PSScriptRoot\cloudrun\wecom-bot.js"
