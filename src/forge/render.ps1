# Renders synthetic label images from Squint label specs with the System.Drawing built into Windows.
# Every name, patient, pharmacy and number here is fake. Output: one 1024x768 PNG per spec.
param(
  [Parameter(Mandatory = $true)][string]$SpecsFile,
  [Parameter(Mandatory = $true)][string]$OutDir
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

# Windows PowerShell 5.1 returns a JSON array as one object, so unwrap it explicitly.
$parsed = ConvertFrom-Json -InputObject (Get-Content -Raw -Encoding UTF8 -Path $SpecsFile)
$specs = @($parsed)
if ($specs.Count -eq 1 -and $specs[0] -is [System.Array]) { $specs = $specs[0] }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$W = 1024; $H = 768
$ink = [System.Drawing.Color]::FromArgb(25, 25, 30)

function Fmt-Num($v) { if ([math]::Floor($v) -eq $v) { '{0:0}' -f $v } else { [string]$v } }
function Fmt-Date($iso, $style) {
  $d = [datetime]::ParseExact($iso, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
  switch ($style) {
    'us' { $d.ToString('MM/dd/yyyy', [Globalization.CultureInfo]::InvariantCulture) }
    'iso' { $d.ToString('yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture) }
    'text' { $d.ToString('dd MMM yyyy', [Globalization.CultureInfo]::InvariantCulture).ToUpper() }
  }
}
function Font($size, $bold) {
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  New-Object System.Drawing.Font('Arial', [single]$size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}
function Text($g, $s, $size, $bold, $x, $y, $w, $h, $color) {
  if (-not $color) { $color = $ink }
  $f = Font $size $bold
  $b = New-Object System.Drawing.SolidBrush($color)
  $g.DrawString([string]$s, $f, $b, (New-Object System.Drawing.RectangleF([single]$x, [single]$y, [single]$w, [single]$h)))
  $b.Dispose(); $f.Dispose()
}
function Box($g, $x, $y, $w, $h, $color) {
  $b = New-Object System.Drawing.SolidBrush($color); $g.FillRectangle($b, $x, $y, $w, $h); $b.Dispose()
}

foreach ($s in $specs) {
  $bmp = New-Object System.Drawing.Bitmap($W, $H)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias

  if ($s.kind -eq 'rx') {
    # Prescription bottle label: amber bottle edges, white paper label.
    $g.Clear([System.Drawing.Color]::FromArgb(176, 98, 30))
    Box $g 60 70 904 628 ([System.Drawing.Color]::FromArgb(252, 252, 248))
    Box $g 60 70 904 70 ([System.Drawing.Color]::FromArgb(30, 70, 140))
    Text $g 'SQUINT TEST PHARMACY  -  12 Example Way  -  (555) 010-0199' 24 $true 84 88 860 40 ([System.Drawing.Color]::White)
    Text $g ('Rx# 70{0}   Dr. A. Placeholder' -f ([math]::Abs($s.id.GetHashCode()) % 100000)) 22 $false 84 156 860 30
    Text $g 'PATIENT: PAT TESTPERSON' 24 $true 84 190 860 34
    Text $g ('{0} {1} {2}' -f $s.name.ToUpper(), (Fmt-Num $s.strength.value), $s.strength.unit) 58 $true 84 240 860 76
    Text $g ($s.form.Substring(0,1).ToUpper() + $s.form.Substring(1) + 's') 26 $false 84 318 860 34
    Text $g $s.directions 34 $false 84 370 860 100
    Text $g 'QTY: 30    REFILLS: 2' 24 $false 84 488 860 34
    Text $g ('Discard after: ' + (Fmt-Date $s.expiry 'us')) 30 $true 84 532 860 40
    Text $g 'SYNTHETIC TEST LABEL - NOT A REAL PRESCRIPTION' 18 $false 84 640 860 30 ([System.Drawing.Color]::FromArgb(120, 120, 120))
  }
  elseif ($s.kind -eq 'otc') {
    # Over-the-counter box front with a Drug Facts panel.
    $g.Clear([System.Drawing.Color]::FromArgb(236, 240, 246))
    Box $g 0 0 $W 150 ([System.Drawing.Color]::FromArgb(200, 30, 45))
    Text $g 'HELIX CARE' 30 $true 48 22 600 40 ([System.Drawing.Color]::White)
    Text $g ('{0} Tablets' -f $s.name) 56 $true 48 66 940 76 ([System.Drawing.Color]::White)
    Text $g ('{0} {1} per {2}' -f (Fmt-Num $s.strength.value), $s.strength.unit, $s.form) 44 $true 48 176 940 60
    Box $g 48 270 928 360 ([System.Drawing.Color]::White)
    Text $g 'Drug Facts' 34 $true 72 286 880 44
    Text $g ('Active ingredient: {0} {1} {2}' -f $s.name, (Fmt-Num $s.strength.value), $s.strength.unit) 26 $false 72 340 880 36
    Text $g ('Directions: ' + $s.directions) 30 $false 72 392 880 90
    Text $g 'Do not exceed the stated dose. Keep out of reach of children.' 22 $false 72 500 880 60
    Text $g ('EXP ' + (Fmt-Date $s.expiry 'iso')) 32 $true 48 660 600 44
    Text $g 'SYNTHETIC TEST PACKAGE' 18 $false 700 672 300 30 ([System.Drawing.Color]::FromArgb(120, 120, 120))
  }
  else {
    # Food package back panel with an allergen statement.
    $g.Clear([System.Drawing.Color]::FromArgb(250, 244, 228))
    Text $g $s.name 56 $true 48 36 940 76
    Text $g 'Net Wt 8 oz (227 g)' 24 $false 48 116 600 34
    $ingredients = @('rice flour', 'sunflower oil', 'cane sugar', 'sea salt') + @($s.allergens)
    Text $g ('INGREDIENTS: ' + (($ingredients | ForEach-Object { $_.ToUpper() }) -join ', ') + '.') 26 $false 48 176 928 130
    $contains = if (@($s.allergens).Count -gt 0) { (@($s.allergens) | ForEach-Object { $_.ToUpper() }) -join ', ' } else { 'NONE OF THE MAJOR ALLERGENS' }
    Box $g 40 330 944 70 ([System.Drawing.Color]::FromArgb(255, 255, 255))
    Text $g ('CONTAINS: ' + $contains + '.') 34 $true 56 344 912 60
    if (@($s.may_contain).Count -gt 0) {
      Text $g ('MAY CONTAIN: ' + ((@($s.may_contain) | ForEach-Object { $_.ToUpper() }) -join ', ') + '.') 28 $true 56 420 912 44
    }
    Text $g ('BEST BY ' + (Fmt-Date $s.expiry 'text')) 34 $true 48 520 900 50
    Text $g 'Distributed by Squint Test Foods, Example City. Synthetic test package.' 20 $false 48 680 928 40 ([System.Drawing.Color]::FromArgb(120, 120, 120))
  }

  $out = Join-Path $OutDir ($s.id + '.png')
  $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $bmp.Dispose()
}
