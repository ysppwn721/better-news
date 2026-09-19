# 本机定时抓取并发布：抓取 -> 导出快照 -> 提交推送 -> GitHub Pages 自动更新
#
# 为什么必须在本地跑：
#   实测 GitHub Actions 的构建机（美国 eastus2）无法访问中北大学各站点，
#   49 个信源全部 fetch failed；学校站点只在中国大陆网络下可达。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File scripts\scrape-and-publish.ps1                        # 手动跑一次
#   powershell -ExecutionPolicy Bypass -File scripts\scrape-and-publish.ps1 -Register              # 注册计划任务（默认每 3 小时）
#   powershell -ExecutionPolicy Bypass -File scripts\scrape-and-publish.ps1 -Register -IntervalMinutes 60
#   powershell -ExecutionPolicy Bypass -File scripts\scrape-and-publish.ps1 -Unregister            # 取消计划任务

param(
    [switch]$Register,
    [switch]$Unregister,
    # 抓取间隔（分钟）。
    #
    # 为什么默认 180 而不是 60：本机曾经同时跑着两个抓取器（这个计划任务 +
    # 本地服务自带的每 30 分钟 node-cron），每小时把学校站点多打一遍，
    # 用户直接反馈「有个后台任务一直在抓取」。服务的定时抓取已关闭（BN_CRON=off），
    # 这里也放宽到 3 小时：网页版最久 3 小时旧，电脑上的后台活动降到 1/3。
    # 手机 App 是自己抓的，不受这个间隔影响。
    [int]$IntervalMinutes = 180,
    [switch]$SkipFetch,
    [switch]$NoPush
)

$ErrorActionPreference = 'Continue'
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root

$LogDir = Join-Path $Root 'data\logs'
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$LogFile = Join-Path $LogDir ("scrape-{0:yyyyMMdd}.log" -f (Get-Date))

function Write-Log($msg) {
    $line = "[{0:HH:mm:ss}] {1}" -f (Get-Date), $msg
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -Encoding utf8
}

<#
  运行原生命令并按退出码判断成败。

  为什么需要它：git 会把进度信息写到 stderr（例如 "To https://github.com/..."），
  PowerShell 在 $ErrorActionPreference='Stop' 下会把这类 stderr 当成致命错误中断脚本——
  本项目踩过这个坑：抓取与导出都成功，却在 push 处静默退出，数据始终没发出去。
  这里显式关闭该行为，只以 $LASTEXITCODE 为准。
#>
function Invoke-Cmd {
    param([string]$Exe, [string[]]$CmdArgs)
    $prev = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    # 显式指定 UTF-8：PowerShell 5.1 默认按系统 ANSI 代码页解码子进程输出，
    # 会把 Node 输出的中文变成乱码写进日志。
    $prevEnc = [Console]::OutputEncoding
    try {
        [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
        $out = & $Exe @CmdArgs 2>&1
        return @{ Code = $LASTEXITCODE; Output = @($out) }
    } finally {
        [Console]::OutputEncoding = $prevEnc
        $ErrorActionPreference = $prev
    }
}

<#
  清理上一次运行可能残留的 git 状态。

  快照（public/data/）每次整体重写，遗留的冲突标记会让后续 add/commit/push
  全部失败且报错不明显。因此每次运行前先归零。
#>
function Reset-GitState {
    if ((Test-Path (Join-Path $Root '.git\rebase-merge')) -or (Test-Path (Join-Path $Root '.git\rebase-apply'))) {
        Write-Log '检测到未完成的 rebase，正在中止...'
        Invoke-Cmd 'git' @('rebase', '--abort') | Out-Null
    }
    if (Test-Path (Join-Path $Root '.git\MERGE_HEAD')) {
        Write-Log '检测到未完成的 merge，正在中止...'
        Invoke-Cmd 'git' @('merge', '--abort') | Out-Null
    }
    Invoke-Cmd 'git' @('reset', '-q') | Out-Null
    Invoke-Cmd 'git' @('checkout', '-q', '--force', 'HEAD', '--', 'public/data') | Out-Null
}

$TaskName = 'BetterNews-Scrape'

# ---------------------------------------------------------------- 计划任务管理

if ($Unregister) {
    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Log "已取消计划任务: $TaskName"
    } else {
        Write-Log "计划任务不存在: $TaskName"
    }
    exit 0
}

if ($Register) {
    $ps = (Get-Command powershell.exe).Source
    $scriptPath = Join-Path $PSScriptRoot 'scrape-and-publish.ps1'
    $action = New-ScheduledTaskAction -Execute $ps -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$scriptPath`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes $IntervalMinutes)
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 20) -MultipleInstances IgnoreNew

    if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    }
    Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Scrape NUC notices and publish to GitHub Pages' | Out-Null

    Write-Log "已注册计划任务: $TaskName (每 $IntervalMinutes 分钟运行一次)"
    Write-Log "查看: Get-ScheduledTask -TaskName '$TaskName'"
    Write-Log "立即测试: Start-ScheduledTask -TaskName '$TaskName'"
    exit 0
}

# ---------------------------------------------------------------- 主流程

Write-Log '===== 开始抓取 ====='
$sw = [System.Diagnostics.Stopwatch]::StartNew()

Reset-GitState

if (-not $SkipFetch) {
    Write-Log '抓取校级 + 学院信源...'
    $r = Invoke-Cmd 'node' @('bin/bn.mjs', 'fetch', '--colleges')
    foreach ($line in $r.Output) {
        if ($line -match 'INF|ERR|WRN') { Write-Log ("  " + $line) }
    }
    if ($r.Code -ne 0) { Write-Log "抓取返回非零退出码 $($r.Code)（可能部分信源失败，继续后续流程）" }
} else {
    Write-Log '跳过抓取 (-SkipFetch)'
}

Write-Log '导出静态快照...'
$r = Invoke-Cmd 'node' @('scripts/export-static.mjs')
foreach ($line in $r.Output) { Write-Log ("  " + $line) }
if ($r.Code -ne 0) {
    Write-Log '导出失败，终止本次流程'
    exit 1
}

$indexPath = Join-Path $Root 'public\data\index.json'
$index = Get-Content $indexPath -Raw -Encoding utf8 | ConvertFrom-Json
Write-Log ("快照版本 {0}，共 {1} 条，最新通知 {2}" -f $index.version, $index.total, $index.latestAt)

if ($NoPush) {
    Write-Log '跳过推送 (-NoPush)'
    exit 0
}

# public/data 被 .git/info/exclude 排除，需强制加入
Invoke-Cmd 'git' @('add', '-f', 'public/data') | Out-Null
Invoke-Cmd 'git' @('add', '-A') | Out-Null

$staged = Invoke-Cmd 'git' @('diff', '--cached', '--name-only')
if (-not $staged.Output -or $staged.Output.Count -eq 0) {
    Write-Log '数据无变化，无需提交'
    exit 0
}
Write-Log ("暂存变更 {0} 个文件" -f $staged.Output.Count)

$msg = "chore(data): 更新通知快照（共 $($index.total) 条）"
$c = Invoke-Cmd 'git' @('-c', 'core.safecrlf=false', 'commit', '-q', '-m', $msg)
if ($c.Code -ne 0) {
    Write-Log "提交失败: $($c.Output -join ' ')"
    exit 1
}
Write-Log '已提交，开始推送...'

$pushed = $false
for ($i = 1; $i -le 3; $i++) {
    $p = Invoke-Cmd 'git' @('push', '-q')
    if ($p.Code -eq 0) { $pushed = $true; break }
    Write-Log "推送被拒（第 $i 次），同步远端后重试..."
    Invoke-Cmd 'git' @('fetch', '-q', 'origin') | Out-Null
    Invoke-Cmd 'git' @('rebase', '-q', '-X', 'theirs', 'origin/main') | Out-Null
    Start-Sleep -Seconds 3
}

if ($pushed) {
    Write-Log '已推送，GitHub Pages 将自动重新发布（约 1-2 分钟后线上可见）'
} else {
    Write-Log 'WARN: 连续 3 次推送失败，请检查网络或仓库权限'
}

$sw.Stop()
Write-Log ("===== 完成，耗时 {0:N1} 秒 =====" -f $sw.Elapsed.TotalSeconds)
