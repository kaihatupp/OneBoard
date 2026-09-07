# OneBoard PWA アイコン生成スクリプト
# icons/ に PNG を4枚作る:
#   icon-192.png / icon-512.png            … purpose "any"(角丸・背景透過)
#   icon-192-maskable.png / icon-512-maskable.png … purpose "maskable"(全面塗り + セーフゾーン内に絵柄)
# 絵柄は generate-icon.ps1(icon.ico 用)と同じ「青地 + カレンダー」。
# 使い方: PowerShell で  .\generate-pwa-icons.ps1

Add-Type -AssemblyName System.Drawing

$BLUE = [System.Drawing.Color]::FromArgb(37, 99, 235)
$NAVY = [System.Drawing.Color]::FromArgb(30, 64, 175)
$DOT = [System.Drawing.Color]::FromArgb(203, 213, 225)

function New-RoundedRect([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $p.AddArc($x, $y, $d, $d, 180, 90)
  $p.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $p.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $p.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $p.CloseFigure()
  return $p
}

# 256x256 座標系でカレンダーの「本体・リング・ドット」だけを描く(背景は呼び出し側)。
function Draw-Glyph([System.Drawing.Graphics]$g) {
  $body = New-RoundedRect 52 66 152 138 18
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $body)

  $g.SetClip($body)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush $NAVY), 52, 66, 152, 34)
  $g.ResetClip()

  $ring = New-Object System.Drawing.SolidBrush $NAVY
  $g.FillPath($ring, (New-RoundedRect 92 52 14 30 6))
  $g.FillPath($ring, (New-RoundedRect 150 52 14 30 6))

  $dot = New-Object System.Drawing.SolidBrush $DOT
  $today = New-Object System.Drawing.SolidBrush $BLUE
  for ($row = 0; $row -lt 3; $row++) {
    for ($col = 0; $col -lt 4; $col++) {
      $dx = 70 + $col * 30
      $dy = 116 + $row * 28
      if ($row -eq 1 -and $col -eq 2) { $g.FillEllipse($today, $dx, $dy, 17, 17) }
      else { $g.FillEllipse($dot, $dx, $dy, 14, 14) }
    }
  }
}

# 1枚描く。$maskable=$true なら全面を青で塗り、絵柄をセーフゾーン内へ縮小配置。
function New-Icon([int]$size, [bool]$maskable) {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)

  $scale = $size / 256.0
  if ($maskable) {
    # 全面を青。絵柄は中央 82% に縮めてセーフゾーン(内側80%の円)へ収める。
    $g.FillRectangle((New-Object System.Drawing.SolidBrush $BLUE), 0, 0, $size, $size)
    $inner = 0.82
    $off = $size * (1 - $inner) / 2
    $g.TranslateTransform([single]$off, [single]$off)
    $g.ScaleTransform([single]($scale * $inner), [single]($scale * $inner))
    Draw-Glyph $g
  } else {
    # 角丸の青地 + 絵柄(icon.ico と同じ構図)。
    $g.ScaleTransform([single]$scale, [single]$scale)
    $g.FillPath((New-Object System.Drawing.SolidBrush $BLUE), (New-RoundedRect 8 8 240 240 44))
    Draw-Glyph $g
  }
  $g.Dispose()
  return $bmp
}

$dir = Join-Path $PSScriptRoot 'icons'
if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }

$targets = @(
  @{ File = 'icon-192.png'; Size = 192; Mask = $false },
  @{ File = 'icon-512.png'; Size = 512; Mask = $false },
  @{ File = 'icon-192-maskable.png'; Size = 192; Mask = $true },
  @{ File = 'icon-512-maskable.png'; Size = 512; Mask = $true }
)

foreach ($t in $targets) {
  $bmp = New-Icon $t.Size $t.Mask
  $path = Join-Path $dir $t.File
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  Write-Host "作成しました: icons/$($t.File)  ($($t.Size)x$($t.Size))"
}
