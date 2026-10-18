# Vigia da Central de Decisões LORLER — roda a cada 5 minutos (tarefa agendada "LORLER Cerebro Vigia").
# 1) servidor local não responde -> reinicia a tarefa do servidor
# 2) endereço público não responde 2 vezes seguidas (com o servidor ok) -> reinicia a tarefa do túnel
param([string]$Hostname = 'cerebro.lorler.com.br', [int]$Port = 3700)
$ErrorActionPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$data = Join-Path $root 'data'; $log = Join-Path $data 'vigia.log'; $state = Join-Path $data 'vigia.estado'
function Log($m) { Add-Content -Path $log -Value "[$(Get-Date -Format s)] $m"; if ((Get-Item $log).Length -gt 512KB) { Move-Item $log "$log.old" -Force } }
function Ok($url) { try { return ((Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 15).Content -eq 'ok') } catch { return $false } }

if (-not (Ok "http://127.0.0.1:$Port/healthz")) {
  Log 'servidor local sem resposta: reiniciando a tarefa LORLER Cerebro'
  Stop-ScheduledTask -TaskName 'LORLER Cerebro'
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep 2; Start-ScheduledTask -TaskName 'LORLER Cerebro'
  exit
}
if (Ok "https://$Hostname/healthz") { if (Test-Path $state) { Remove-Item $state -Force; Log 'endereço público voltou a responder' }; exit }
$falhas = 1; if (Test-Path $state) { $falhas = [int](Get-Content $state) + 1 }
Set-Content $state $falhas
Log "endereço público sem resposta ($falhas)"
if ($falhas -ge 2) {
  Log 'reiniciando a tarefa LORLER Cerebro Tunnel'
  Stop-ScheduledTask -TaskName 'LORLER Cerebro Tunnel'
  Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'lorler-cerebro|cloudflared\.yml' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
  Start-Sleep 2; Start-ScheduledTask -TaskName 'LORLER Cerebro Tunnel'
  Set-Content $state 0
}
