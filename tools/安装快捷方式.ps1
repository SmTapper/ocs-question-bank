$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root 'icon.ico'
$batPath = Join-Path $root '启动服务.bat'

if (-not (Test-Path $batPath)) {
    Write-Host "  找不到 启动服务.bat，请确认本脚本位于项目的 tools 目录下。" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "  正在生成图标..." -ForegroundColor Cyan

Add-Type -AssemblyName System.Drawing

$size = 256
$bmp = New-Object System.Drawing.Bitmap($size, $size)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
$g.Clear([System.Drawing.Color]::Transparent)

$shape = New-Object System.Drawing.Drawing2D.GraphicsPath
$r = 56
$shape.AddArc(0, 0, $r * 2, $r * 2, 180, 90)
$shape.AddArc($size - $r * 2, 0, $r * 2, $r * 2, 270, 90)
$shape.AddArc($size - $r * 2, $size - $r * 2, $r * 2, $r * 2, 0, 90)
$shape.AddArc(0, $size - $r * 2, $r * 2, $r * 2, 90, 90)
$shape.CloseFigure()

$brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.Point(0, 0)),
    (New-Object System.Drawing.Point($size, $size)),
    [System.Drawing.Color]::FromArgb(255, 77, 124, 254),
    [System.Drawing.Color]::FromArgb(255, 123, 92, 255)
)
$g.FillPath($brush, $shape)

$font = New-Object System.Drawing.Font('Segoe UI', 156, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fmt = New-Object System.Drawing.StringFormat
$fmt.Alignment = [System.Drawing.StringAlignment]::Center
$fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
$rect = New-Object System.Drawing.RectangleF(0, -8, $size, $size)
$g.DrawString('Q', $font, [System.Drawing.Brushes]::White, $rect, $fmt)

$ms = New-Object System.IO.MemoryStream
$bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
$png = $ms.ToArray()
$ms.Close()
$g.Dispose()
$bmp.Dispose()

$fs = [System.IO.File]::Create($iconPath)
$bw = New-Object System.IO.BinaryWriter($fs)
$bw.Write([UInt16]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]1)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([Byte]0)
$bw.Write([UInt16]1)
$bw.Write([UInt16]32)
$bw.Write([UInt32]$png.Length)
$bw.Write([UInt32]22)
$bw.Write($png)
$bw.Close()
$fs.Close()

Write-Host "  图标已生成：$iconPath" -ForegroundColor Green

Write-Host "  正在创建桌面快捷方式..." -ForegroundColor Cyan
$desktop = [Environment]::GetFolderPath('Desktop')
$lnkPath = Join-Path $desktop 'OCS 本地 AI 题库.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnkPath)
$sc.TargetPath = $batPath
$sc.WorkingDirectory = $root
$sc.IconLocation = "$iconPath,0"
$sc.Description = 'OCS 本地 AI 题库：双击启动，关闭窗口即停止'
$sc.WindowStyle = 1
$sc.Save()

Write-Host ""
Write-Host "  完成！桌面上已生成「OCS 本地 AI 题库」图标。" -ForegroundColor Green
Write-Host "  双击图标启动服务，关闭弹出的黑色窗口即停止服务。" -ForegroundColor Gray
Write-Host ""
