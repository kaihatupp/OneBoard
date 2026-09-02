# OneBoard アイコン生成スクリプト
# icon.ico(16/32/48/64/128/256 px の非圧縮 32bit ICO)を作成する。
# 使い方: PowerShell で  .\generate-icon.ps1

Add-Type -AssemblyName System.Drawing

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

# --- アートワークを 256x256 で1枚描く ---
function Draw-Master {
  $s = 256
  $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'
  $g.Clear([System.Drawing.Color]::Transparent)

  $bg = New-RoundedRect 8 8 240 240 44
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))), $bg)

  $body = New-RoundedRect 52 66 152 138 18
  $g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)), $body)

  $g.SetClip($body)
  $g.FillRectangle((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 64, 175))), 52, 66, 152, 34)
  $g.ResetClip()

  $ring = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(30, 64, 175))
  $g.FillPath($ring, (New-RoundedRect 92 52 14 30 6))
  $g.FillPath($ring, (New-RoundedRect 150 52 14 30 6))

  $dot = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(203, 213, 225))
  $today = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(37, 99, 235))
  for ($row = 0; $row -lt 3; $row++) {
    for ($col = 0; $col -lt 4; $col++) {
      $dx = 70 + $col * 30
      $dy = 116 + $row * 28
      if ($row -eq 1 -and $col -eq 2) { $g.FillEllipse($today, $dx, $dy, 17, 17) }
      else { $g.FillEllipse($dot, $dx, $dy, 14, 14) }
    }
  }
  $g.Dispose()
  return $bmp
}

$master = Draw-Master
$sizes = @(16, 32, 48, 64, 128, 256)

# --- 各サイズを非圧縮 DIB(BGRA + AND マスク)に変換 ---
$images = @()
foreach ($sz in $sizes) {
  $b = New-Object System.Drawing.Bitmap($sz, $sz, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.InterpolationMode = 'HighQualityBicubic'
  $g.PixelOffsetMode = 'HighQuality'
  $g.Clear([System.Drawing.Color]::Transparent)
  $g.DrawImage($master, (New-Object System.Drawing.Rectangle 0, 0, $sz, $sz))
  $g.Dispose()

  $maskRow = [int][Math]::Floor(($sz + 31) / 32) * 4
  $buf = New-Object System.Collections.Generic.List[Byte]
  # BITMAPINFOHEADER
  $buf.AddRange([BitConverter]::GetBytes([UInt32]40))
  $buf.AddRange([BitConverter]::GetBytes([Int32]$sz))
  $buf.AddRange([BitConverter]::GetBytes([Int32]($sz * 2)))
  $buf.AddRange([BitConverter]::GetBytes([UInt16]1))
  $buf.AddRange([BitConverter]::GetBytes([UInt16]32))
  $buf.AddRange([BitConverter]::GetBytes([UInt32]0))
  $buf.AddRange([BitConverter]::GetBytes([UInt32]($sz * $sz * 4)))
  $buf.AddRange((New-Object Byte[] 16))
  # 画素(BGRA, ボトムアップ)
  for ($y = $sz - 1; $y -ge 0; $y--) {
    for ($x = 0; $x -lt $sz; $x++) {
      $c = $b.GetPixel($x, $y)
      $buf.Add($c.B); $buf.Add($c.G); $buf.Add($c.R); $buf.Add($c.A)
    }
  }
  # AND マスク(全 0 = アルファで抜く)
  $buf.AddRange((New-Object Byte[] ($maskRow * $sz)))

  $images += ,([pscustomobject]@{ Size = $sz; Bytes = $buf.ToArray() })
  $b.Dispose()
}
$master.Dispose()

# --- ICO 組み立て ---
$icoPath = Join-Path $PSScriptRoot 'icon.ico'
$out = New-Object System.Collections.Generic.List[Byte]
$out.AddRange([BitConverter]::GetBytes([UInt16]0))
$out.AddRange([BitConverter]::GetBytes([UInt16]1))
$out.AddRange([BitConverter]::GetBytes([UInt16]$images.Count))

$offset = 6 + 16 * $images.Count
foreach ($img in $images) {
  $wb = if ($img.Size -ge 256) { 0 } else { $img.Size }
  $out.Add([Byte]$wb)
  $out.Add([Byte]$wb)
  $out.Add([Byte]0)
  $out.Add([Byte]0)
  $out.AddRange([BitConverter]::GetBytes([UInt16]1))
  $out.AddRange([BitConverter]::GetBytes([UInt16]32))
  $out.AddRange([BitConverter]::GetBytes([UInt32]$img.Bytes.Length))
  $out.AddRange([BitConverter]::GetBytes([UInt32]$offset))
  $offset += $img.Bytes.Length
}
foreach ($img in $images) { $out.AddRange($img.Bytes) }

[System.IO.File]::WriteAllBytes($icoPath, $out.ToArray())
Write-Host "作成しました: $icoPath ($($out.Count) bytes, $($images.Count) sizes)"
