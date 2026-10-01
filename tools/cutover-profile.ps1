<#
.SYNOPSIS
  Coupure du profil web vers le depot consolide dsh-boost. NE CHANGE RIEN sans -Apply.
.DESCRIPTION
  Fait en UNE passe ce que dsh-hmr relira d'un coup, parce qu'il surveille le package.json et le
  cordis.patch.yml du profil : tout editer en une fois, puis redemarrer.
    0. controle que pnpm resout (le shim nvm fait echouer toute installation sur cette machine)
    1. sauvegarde du package.json et du cordis.patch.yml du profil
    2. dependances : les cinq liens -> le seul agregateur @local/dsh-boost
    3. bundles : les cinq bundles -> l'agregateur (sinon chaque ligne monte DEUX fois :
       dsh-app-boot fait data.push(...insert) sans deduplication)
    4. /schedule : ajoute @deepseek-ai/dsh-experimental-schedule-bundle (sans lui, les outils
       schedule_* ont disparu du process vivant - mesure du 30/09)
    5. purge des trois entrees mortes du patch de profil (time-context, schedule, ui-schedule)
    6. jonctions : materialise node_modules\@local\dsh-boost vers C:\CodeSource\dsh-boost
    7. verification : dsh --profile web --dump-config, les six ids attendus, chacun une fois
.EXAMPLE
  pwsh -File cutover-profile.ps1            # montre ce qui serait fait
  pwsh -File cutover-profile.ps1 -Apply     # le fait, puis affiche la verification
#>
param(
  [switch]$Apply,
  [string]$Profile = 'web',
  [string]$DshHome = "$env:USERPROFILE\.dsh"
)

$ErrorActionPreference = 'Stop'
$prof = Join-Path $DshHome "profiles\$Profile"
$pkgPath = Join-Path $prof 'package.json'
$patchPath = Join-Path $prof 'cordis.patch.yml'
$agg = 'C:/CodeSource/dsh-boost'
$aggName = '@local/dsh-boost'
$five = @('@local/dsh-boost-mode','@local/dsh-boost-relay','@local/dsh-boost-status','@local/dsh-detached-jobs')
$deadIds = @('time-context','schedule','ui-schedule')

if (-not (Test-Path $pkgPath)) { throw "profil introuvable : $pkgPath" }
$man = Get-Content $pkgPath -Raw | ConvertFrom-Json

Write-Host '=== 0. pnpm ===' -ForegroundColor Cyan
$pnpm = (Get-Command pnpm -ErrorAction SilentlyContinue).Source
Write-Host "  pnpm du PATH : $pnpm"
if ($pnpm -and $pnpm -like '*nvm*') {
  Write-Host '  ATTENTION : c''est le shim nvm, il echoue. Mettre corepack en tete de PATH :' -ForegroundColor Yellow
  Write-Host '    $env:PATH = "C:\Program Files\nodejs\node_modules\corepack\shims;" + $env:PATH' -ForegroundColor Yellow
}

Write-Host '=== 1. sauvegarde ===' -ForegroundColor Cyan
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakPkg = "$pkgPath.$stamp.bak"
$bakPatch = "$patchPath.$stamp.bak"
Write-Host "  $bakPkg"
Write-Host "  $bakPatch"

$deps = @($man.dependencies.PSObject.Properties.Name)
$oldDeps = @{}
foreach ($prop in $man.dependencies.PSObject.Properties) { $oldDeps[$prop.Name] = $prop.Value }
$bundles = @($man.dsh.profile.bundles)
Write-Host '  AVANT :'
Write-Host ('    dependencies : ' + ($deps -join ', '))
Write-Host ('    bundles      : ' + ($bundles -join ', '))

$newDeps = @()
foreach ($d in $deps) { if ($five -notcontains $d) { $newDeps += $d } }
if ($newDeps -notcontains $aggName) { $newDeps += $aggName }
$newBundles = @()
foreach ($b in $bundles) { if ($five -notcontains $b) { $newBundles += $b } }
if ($newBundles -notcontains $aggName) { $newBundles += $aggName }
$sched = '@deepseek-ai/dsh-experimental-schedule-bundle'
if ($newBundles -notcontains $sched) { $newBundles += $sched }

Write-Host '  APRES :'
Write-Host '    dependencies :'
foreach ($d in $newDeps) {
  if ($d -eq $aggName) { Write-Host ('      ' + $d + ' -> link:' + $agg) }
  else { Write-Host ('      ' + $d + ' -> ' + $oldDeps[$d]) }
}
Write-Host ('    bundles      : ' + ($newBundles -join ', '))

$patchText = Get-Content $patchPath -Raw
$deadFound = @()
foreach ($id in $deadIds) { if ($patchText -match ('(?m)^- id: ' + [regex]::Escape($id) + '\s*$')) { $deadFound += $id } }
Write-Host ('  entrees mortes trouvees dans le patch : ' + (($deadFound -join ', ')))

if (-not $Apply) {
  Write-Host ''
  Write-Host 'MODE LECTURE SEULE - rien n''a ete modifie. Relancer avec -Apply pour appliquer.' -ForegroundColor Yellow
  exit 0
}

Write-Host '=== 2. jonction — AVANT toute ecriture ===' -ForegroundColor Cyan
# L'ordre est load-bearing : ecrire package.json declenche dsh-hmr, qui relit TOUTES les couches
# depuis le disque. Si la jonction de l'agregateur n'existe pas encore a cet instant, le
# rechargement monte un paquet introuvable.
$nm = Join-Path $prof 'node_modules\@local'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = Join-Path $nm 'dsh-boost'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target 'C:\CodeSource\dsh-boost' | Out-Null
Write-Host ('  ' + $link + ' -> C:\CodeSource\dsh-boost')

Write-Host '=== 3-6. application ===' -ForegroundColor Cyan
Copy-Item $pkgPath $bakPkg -Force
Copy-Item $patchPath $bakPatch -Force
$oldDeps = @{}
foreach ($prop in $man.dependencies.PSObject.Properties) { $oldDeps[$prop.Name] = $prop.Value }
$man.dependencies = [pscustomobject]@{}
foreach ($d in $newDeps) {
  if ($d -eq $aggName) { $val = "link:" + $agg } else { $val = $oldDeps[$d] }
  $man.dependencies | Add-Member -NotePropertyName $d -NotePropertyValue $val -Force
}
$man.dsh.profile.bundles = $newBundles
$json = $man | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($pkgPath, $json, (New-Object System.Text.UTF8Encoding($false)))
Write-Host '  package.json ecrit'

$lines = Get-Content $patchPath
$kept = @()
$i = 0
while ($i -lt $lines.Count) {
  $isDead = $false
  foreach ($id in $deadFound) { if ($lines[$i] -match ('^- id: ' + [regex]::Escape($id) + '\s*$')) { $isDead = $true } }
  if ($isDead) {
    $i++
    while ($i -lt $lines.Count -and $lines[$i] -match '^\s' -and $lines[$i] -notmatch '^- ') { $i++ }
  } else {
    $kept += $lines[$i]
    $i++
  }
}
[System.IO.File]::WriteAllLines($patchPath, $kept, (New-Object System.Text.UTF8Encoding($false)))
Write-Host ('  cordis.patch.yml ecrit (' + $lines.Count + ' -> ' + $kept.Count + ' lignes)')

Write-Host '=== 6. jonction ===' -ForegroundColor Cyan
$nm = Join-Path $prof 'node_modules\@local'
New-Item -ItemType Directory -Force -Path $nm | Out-Null
$link = Join-Path $nm 'dsh-boost'
if (Test-Path $link) { Remove-Item $link -Force -Recurse }
New-Item -ItemType Junction -Path $link -Target 'C:\CodeSource\dsh-boost' | Out-Null
Write-Host "  $link -> C:\CodeSource\dsh-boost"

Write-Host '=== 7. verification ===' -ForegroundColor Cyan
$out = & dsh --profile $Profile --dump-config 2>&1
$ids = @('preset-boost','boost-job-relay','boost-status-command','dsh-detached-jobs','dsh-guard-surrogate','dsh-boost-channel')
foreach ($id in $ids) {
  $n = ($out | Select-String -Pattern ('^- id: ' + [regex]::Escape($id) + '$') | Measure-Object).Count
  $color = 'Green'; if ($n -ne 1) { $color = 'Red' }
  Write-Host "  $id : $n" -ForegroundColor $color
}
$dead = $out | Select-String -Pattern 'not found'
if ($dead) { Write-Host '  avertissements restants :' -ForegroundColor Yellow; $dead | ForEach-Object { Write-Host ('    ' + $_.Line.Trim()) } }
else { Write-Host '  aucun avertissement de patch' -ForegroundColor Green }
Write-Host ''
Write-Host 'REDEMARRER le harnais pour que le process charge le nouveau montage.' -ForegroundColor Yellow