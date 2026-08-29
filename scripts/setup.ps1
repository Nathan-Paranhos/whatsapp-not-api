$ErrorActionPreference = 'Stop'

$projectRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
Set-Location -LiteralPath $projectRoot

$nodeCommand = Get-Command node.exe -ErrorAction Stop
$npmCommand = Get-Command npm -ErrorAction Stop
$nodeMajor = & $nodeCommand.Source -p "Number(process.versions.node.split('.')[0])"
if ([int]$nodeMajor -lt 24) {
  throw "Node.js 24 ou superior e necessario. Versao encontrada: $(& $nodeCommand.Source --version)"
}

Write-Host 'Instalando dependencias do painel...'
& $npmCommand.Source install --ignore-scripts
if ($LASTEXITCODE -ne 0) { throw 'A instalacao dos pacotes falhou.' }

$puppeteerInstaller = Join-Path $projectRoot 'node_modules\puppeteer\install.mjs'
if (-not (Test-Path -LiteralPath $puppeteerInstaller)) {
  throw 'O instalador do navegador interno nao foi encontrado.'
}

Write-Host 'Instalando o navegador interno usado pelo WhatsApp Web...'
& $nodeCommand.Source $puppeteerInstaller
if ($LASTEXITCODE -ne 0) { throw 'A instalacao do navegador interno falhou.' }

Write-Host ''
Write-Host 'Tudo pronto. Execute npm start para abrir o painel.' -ForegroundColor Green
