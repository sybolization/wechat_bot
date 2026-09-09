# 打包微信云托管部署 zip。
# 技术要点：
# 1. 云端 Linux 构建要求文件名为 ASCII，中文文件名（GBK）会导致 Docker 构建上下文
#    传输失败（invalid UTF-8），因此打包时把文档重命名为 ASCII。
# 2. 双知识库目录：docs/guanglian（光联之家）、docs/molex（molex珠海光联招聘）。
#    运行时由 .env 的 ACTIVE_KB 控制服务只读取其中一个。
# 3. 文档隔离：一个包只含当前 -KB 对应库的文档；staged .env 的 ACTIVE_KB
#    会被改写为该库，本地 cloudrun/.env 不受影响。
# 用法: powershell -File tools\pack-cloudrun.ps1 -KB molex   （默认 guanglian）

param([string]$KB = "guanglian")

$ErrorActionPreference = "Stop"
if (@("guanglian", "molex") -notcontains $KB) {
    throw "未知知识库: $KB（可选 guanglian | molex）"
}
$root = Split-Path -Parent $PSScriptRoot
$src = Join-Path $root "cloudrun"
$stage = Join-Path $env:TEMP "docqa-upload"

Remove-Item -Recurse -Force $stage -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $stage | Out-Null

# 代码文件（根目录散文件）
foreach ($f in @("server.js", "identity.js", "net.js", "envload.js", "package.json", "Dockerfile", ".env")) {
    Copy-Item (Join-Path $src $f) $stage
}

# 分层目录：core（领域核心）/ channels（渠道适配）/ webui（H5 静态文件）整目录复制
foreach ($d in @("core", "channels", "webui")) {
    Copy-Item (Join-Path $src $d) (Join-Path $stage $d) -Recurse
}
# 复制后删除 .keep 占位（webui 可能尚无页面文件，用 .keep 保证目录存在）
Get-ChildItem $stage -Recurse -Force -Filter ".keep" | Remove-Item -Force

# 知识库一：光联之家（项目根 docs/ 的中文文档 → ASCII 重命名，重建到 cloudrun/docs/guanglian，
# 同时作为本地运行与打包阶段的统一来源）
$guanglian = Join-Path $src "docs\guanglian"
Remove-Item -Recurse -Force $guanglian -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force $guanglian | Out-Null
$map = @{
    "20260715光联倒班上班车线路.xlsx"                       = "bus-daoban-shangban-20260715.xlsx"
    "20260715光联倒班下班车线路.xlsx"                       = "bus-daoban-xiaban-20260715.xlsx"
    "20260715光联正常班线路.xlsx"                           = "bus-guanglian-zhengchang-20260715.xlsx"
    "20260715洪湾工厂班车线路.xlsx"                         = "bus-hongwan-factory-20260715.xlsx"
    "珠海光联招聘操作员、储备干部、技术员、班组长、质检欢迎推荐！.md" = "zhaopin-shezhao-guanglian.md"
    "2027莫仕珠海秋季校招  光联万物，智享未来！.md"               = "zhaopin-xiaozhao-2027-molex.md"
    "代理商招聘广告 1.xlsx"                                  = "zhaopin-dailishang.xlsx"
}
foreach ($k in $map.Keys) {
    Copy-Item (Join-Path $root "docs\$k") (Join-Path $guanglian $map[$k])
}

# 知识库二：molex（文档直接维护在 cloudrun/docs/molex，抓取时已用 ASCII 文件名）
$molexLocal = Join-Path $src "docs\molex"
New-Item -ItemType Directory -Force $molexLocal | Out-Null

# 部署 stage：只带当前 -KB 库的文档（文档隔离），排除 .keep 占位文件
$docsStage = Join-Path $stage "docs"
New-Item -ItemType Directory -Force $docsStage | Out-Null
Copy-Item (Join-Path $src "docs\$KB") (Join-Path $docsStage $KB) -Recurse
Get-ChildItem (Join-Path $docsStage $KB) -Force -Filter ".keep" -ErrorAction SilentlyContinue |
    Remove-Item -Force

# staged .env：ACTIVE_KB 改写为当前库（不动本地 cloudrun/.env）。
# 必须用 .NET 显式 UTF-8 读写：PS 5.1 的 Get-Content 默认按 GBK 解码会损坏中文值，
# Set-Content -Encoding UTF8 会写 BOM（envload.js 虽可容忍，但无 BOM 更稳）。
$envStage = Join-Path $stage ".env"
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$envText = [System.IO.File]::ReadAllText($envStage, $utf8NoBom)
$envText = $envText -replace "(?m)^ACTIVE_KB=.*$", "ACTIVE_KB=$KB"
[System.IO.File]::WriteAllText($envStage, $envText, $utf8NoBom)

# 打 zip（bsdtar，正斜杠 + ASCII 安全）；包名带知识库后缀以区分
Set-Location $stage
$zipPath = Join-Path $root "docqa-cloudrun-$KB.zip"
tar.exe -a -cf $zipPath --exclude node_modules .
Set-Location $root

Write-Host "打包完成: $zipPath"
