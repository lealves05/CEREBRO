# Central de Decisões LORLER — colocar online a partir deste PC (Cloudflare Tunnel)
#   -Modo Rapido     : endereço temporário https://xxxx.trycloudflare.com (sem conta, ideal para testar já)
#   -Modo Permanente : https://cerebro.lorler.com.br (túnel nomeado na sua conta Cloudflare + inicialização automática)
param([ValidateSet('Rapido','Permanente')][string]$Modo = 'Rapido', [string]$Hostname = 'cerebro.lorler.com.br')

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
trap {
  $msg = $_.Exception.Message
  Write-Host ""; Write-Host "  [ERRO] $msg" -ForegroundColor Red
  try { Add-Content -Path (Join-Path (Split-Path -Parent $PSScriptRoot) 'data\publicar.log') -Value ("[{0}] ERRO: {1}`n{2}" -f (Get-Date -Format s), $msg, $_.ScriptStackTrace) } catch {}
  Write-Host "  Detalhes gravados em data\publicar.log" -ForegroundColor Yellow
  exit 1
}
$Root = Split-Path -Parent $PSScriptRoot
Set-Location $Root
$Port = 3700
$DataDir = Join-Path $Root 'data'
New-Item -ItemType Directory -Force -Path $DataDir | Out-Null
$Log = Join-Path $DataDir 'server.log'

function Titulo($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }

# Executa o cloudflared sem que as mensagens de log (stderr) virem erro fatal no PowerShell 5.1
function Invoke-Cf([string[]]$CfArgs) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { $out = & $script:cf @CfArgs 2>&1 | ForEach-Object { "$_" }; $code = $LASTEXITCODE }
  finally { $ErrorActionPreference = $old }
  $text = ($out -join "`n")
  Add-Content -Path (Join-Path $DataDir 'publicar.log') -Value ("[{0}] cloudflared {1} (saida {2})`n{3}" -f (Get-Date -Format s), ($CfArgs -join ' '), $code, $text)
  return [pscustomobject]@{ Code = $code; Text = $text }
}

function Set-EnvValue([string]$Key, [string]$Value, [switch]$OnlyIfEmpty) {
  $envFile = Join-Path $Root '.env'
  $lines = @(Get-Content $envFile -Encoding UTF8)
  $idx = -1
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i] -match "^\s*$([regex]::Escape($Key))\s*=") { $idx = $i; break } }
  if ($idx -ge 0) {
    $cur = ($lines[$idx] -split '=', 2)[1].Trim()
    if ($OnlyIfEmpty -and $cur) { return }
    $lines[$idx] = "$Key=$Value"
  } else { $lines += "$Key=$Value" }
  [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
}

# 1) Node.js
Titulo 'Verificando Node.js'
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { throw 'Node.js não encontrado. Instale a versão 22 ou superior (https://nodejs.org) e rode de novo.' }
$v = (& node -v).TrimStart('v').Split('.')
if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 13)) { throw "Node $(& node -v) é antigo. Instale 22.13+." }
Ok "Node $(& node -v)"

# 2) Configuração de produção (.env) — não altera chaves de IA ou credenciais já preenchidas
Titulo 'Configurando .env para acesso pela internet'
if (-not (Test-Path (Join-Path $Root '.env'))) { Copy-Item (Join-Path $Root '.env.example') (Join-Path $Root '.env'); Ok '.env criado a partir do exemplo' }
Set-EnvValue 'LORLER_ENV' 'production'
Set-EnvValue 'HOST' '127.0.0.1'
Set-EnvValue 'PORT' "$Port"
Set-EnvValue 'LORLER_COOKIE_SECURE' 'true'
Set-EnvValue 'LORLER_TRUST_PROXY' 'true'
Set-EnvValue 'LORLER_DEMO_MODE' 'true' -OnlyIfEmpty
if ($Modo -eq 'Permanente') {
  Set-EnvValue 'LORLER_PUBLIC_URL' "https://$Hostname"
  Set-EnvValue 'INSTAGRAM_REDIRECT_URI' "https://$Hostname/api/social/instagram/callback" -OnlyIfEmpty
}
Ok 'Ambiente de produção, cookies seguros e IP real via Cloudflare'

# 3) cloudflared
Titulo 'Verificando cloudflared'
$script:cf = $null
$cf = (Get-Command cloudflared -ErrorAction SilentlyContinue).Source
if (-not $cf) {
  foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p; break } }
}
if (-not $cf) {
  Aviso 'Instalando cloudflared (winget)...'
  winget install --id Cloudflare.cloudflared -e --accept-source-agreements --accept-package-agreements | Out-Host
  foreach ($p in @("$env:ProgramFiles\cloudflared\cloudflared.exe", "${env:ProgramFiles(x86)}\cloudflared\cloudflared.exe", "$env:LOCALAPPDATA\Microsoft\WinGet\Links\cloudflared.exe")) { if (Test-Path $p) { $cf = $p; break } }
  if (-not $cf) { throw 'cloudflared não foi encontrado após a instalação. Feche e abra o terminal e rode de novo.' }
}
$script:cf = $cf
Ok "cloudflared: $cf"

# 4) Servidor da Central como tarefa agendada (inicia no logon e reinicia se cair)
Titulo 'Iniciando a Central de Decisões'
$nodeExe = $node.Source
$taskName = 'LORLER Cerebro'
$cmd = "/c cd /d `"$Root`" && `"$nodeExe`" --disable-warning=ExperimentalWarning src\server.js >> `"$Log`" 2>&1"
$action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument $cmd -WorkingDirectory $Root
# Tarefas independentes da janela e da sessão: conta do usuário em modo S4U (sem guardar senha), iniciando com o Windows.
# Exige o .bat executado como administrador (o PUBLICAR-CEREBRO.bat pede a elevação). Sem isso, cai no modo "ao entrar no Windows".
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if ($isAdmin) {
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType S4U -RunLevel Limited
} else {
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $principal = New-ScheduledTaskPrincipal -UserId ([Security.Principal.WindowsIdentity]::GetCurrent().Name) -LogonType Interactive -RunLevel Limited
  Aviso 'Sem permissão de administrador: a Central vai iniciar quando você entrar no Windows (não feche esta janela à força).'
}
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Seconds 0)
Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Central de Decisões LORLER (cérebro multiagente)' -Force | Out-Null
Start-ScheduledTask -TaskName $taskName
$up = $false
for ($i = 0; $i -lt 30; $i++) { Start-Sleep -Seconds 1; try { if ((Invoke-WebRequest "http://127.0.0.1:$Port/healthz" -UseBasicParsing -TimeoutSec 2).Content -eq 'ok') { $up = $true; break } } catch {} }
if (-not $up) { Get-Content $Log -Tail 30 | Out-Host; throw 'O servidor não respondeu. Veja o log acima (data\server.log).' }
Ok "Rodando em http://127.0.0.1:$Port (tarefa agendada '$taskName')"
$token = (Select-String -Path $Log -Pattern 'CÓDIGO DE INSTALAÇÃO: (\S+)' -AllMatches | Select-Object -Last 1)
if ($token) {
  $setup = (Invoke-RestMethod "http://127.0.0.1:$Port/api/setup/status").needs_setup
  if ($setup) { Write-Host ""; Write-Host "  CÓDIGO DE INSTALAÇÃO (primeiro owner): $($token.Matches[0].Groups[1].Value)" -ForegroundColor Magenta }
}

# 5) Túnel
if ($Modo -eq 'Rapido') {
  Titulo 'Abrindo endereço temporário (trycloudflare)'
  Aviso 'Este endereço muda a cada execução e fica no ar enquanto esta janela estiver aberta.'
  $tlog = Join-Path $DataDir 'tunnel-rapido.log'
  if (Test-Path $tlog) { Remove-Item $tlog -Force }
  $proc = Start-Process -FilePath $cf -ArgumentList @('tunnel', '--no-autoupdate', '--url', "http://127.0.0.1:$Port") -RedirectStandardError $tlog -PassThru -WindowStyle Hidden
  $url = $null
  for ($i = 0; $i -lt 40 -and -not $url; $i++) { Start-Sleep -Seconds 1; if (Test-Path $tlog) { $m = Select-String -Path $tlog -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com' | Select-Object -First 1; if ($m) { $url = $m.Matches[0].Value } } }
  if (-not $url) { Get-Content $tlog -Tail 20 | Out-Host; throw 'Não foi possível abrir o túnel temporário.' }
  Set-Content -Path (Join-Path $DataDir 'url-publica.txt') -Value $url
  Write-Host ""; Write-Host "  ONLINE: $url" -ForegroundColor Green
  Start-Process $url
  Write-Host "  Pressione Ctrl+C ou feche esta janela para tirar do ar (a Central continua rodando localmente)."
  Wait-Process -Id $proc.Id
  exit 0
}

Titulo "Publicando em https://$Hostname"
try {
  $ns = (Resolve-DnsName lorler.com.br -Type NS -Server 1.1.1.1 -ErrorAction Stop | Where-Object { $_.NameHost }).NameHost -join ', '
  if ($ns -notmatch 'cloudflare') { Aviso "O domínio ainda usa os servidores DNS: $ns. Troque no Registro.br para brit.ns.cloudflare.com e ken.ns.cloudflare.com — o endereço só abre depois disso (o túnel fica pronto agora)." } else { Ok 'Domínio lorler.com.br já está na Cloudflare' }
} catch { Aviso 'Não consegui consultar o DNS agora; continuando.' }

$cfDir = Join-Path $env:USERPROFILE '.cloudflared'
$certFile = Join-Path $cfDir 'cert.pem'
if (-not (Test-Path $certFile)) {
  Aviso 'Abrindo o navegador: entre na Cloudflare, clique em lorler.com.br e confirme em Authorize. Aguardando até 5 minutos...'
  $llog = Join-Path $DataDir 'cloudflared-login.log'
  Remove-Item "$llog*" -Force -ErrorAction SilentlyContinue
  $lp = Start-Process -FilePath $cf -ArgumentList @('tunnel', 'login') -RedirectStandardError $llog -RedirectStandardOutput "$llog.out" -PassThru -WindowStyle Hidden
  $opened = $false
  for ($i = 0; $i -lt 300 -and -not (Test-Path $certFile); $i++) {
    Start-Sleep -Seconds 1
    if (-not $opened) {
      $m = Get-Content "$llog", "$llog.out" -ErrorAction SilentlyContinue | Select-String -Pattern 'https://dash\.cloudflare\.com/argotunnel\S+' | Select-Object -First 1
      if ($m) { $url = $m.Matches[0].Value; Start-Process $url; $opened = $true; Write-Host "  Se o navegador não abriu, copie este endereço:`n  $url" }
    }
    if ($lp.HasExited -and -not (Test-Path $certFile)) { break }
  }
  if (-not $lp.HasExited) { Stop-Process -Id $lp.Id -Force -ErrorAction SilentlyContinue }
  if (-not (Test-Path $certFile)) { Get-Content $llog -Tail 15 -ErrorAction SilentlyContinue | Out-Host; throw 'A autorização da Cloudflare não chegou a este PC. Rode o PUBLICAR-CEREBRO.bat de novo e clique em Authorize na página que abrir.' }
}
Ok 'Conta Cloudflare autorizada'
$tunnelName = 'lorler-cerebro'
function Get-Tunnel {
  $r = Invoke-Cf @('tunnel', 'list', '--output', 'json')
  # A saída mistura o JSON (stdout) com avisos do cloudflared em JSON de uma linha (stderr): pega só a lista [ ... ]
  $lines = $r.Text -split "`r?`n"
  $start = -1; $end = -1
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($start -lt 0 -and $lines[$i] -match '^\[') { $start = $i; if ($lines[$i] -match '^\[.*\]\s*$') { $end = $i; break } ; continue }
    if ($start -ge 0 -and $lines[$i] -match '^\]\s*$') { $end = $i; break }
  }
  if ($start -ge 0 -and $end -ge 0) {
    $json = ($lines[$start..$end] -join "`n")
    try { $hit = (ConvertFrom-Json $json) | Where-Object { $_.name -eq $tunnelName } | Select-Object -First 1; if ($hit) { return $hit } } catch {}
  }
  # Plano B: extrai o id direto do texto ("id": "...", "name": "lorler-cerebro")
  $m = [regex]::Match($r.Text, '"id"\s*:\s*"([0-9a-f-]{36})"\s*,\s*"name"\s*:\s*"' + [regex]::Escape($tunnelName) + '"')
  if ($m.Success) { return [pscustomobject]@{ id = $m.Groups[1].Value; name = $tunnelName } }
  return $null
}
$t = Get-Tunnel
if (-not $t) {
  $r = Invoke-Cf @('tunnel', 'create', $tunnelName)
  Write-Host $r.Text
  $t = Get-Tunnel
}
if (-not $t) { throw "Falha ao criar ou localizar o túnel '$tunnelName'. Detalhes em data\publicar.log" }
Ok "Túnel $tunnelName ($($t.id))"
$credFile = Join-Path $cfDir "$($t.id).json"
if (-not (Test-Path $credFile)) {
  throw "O túnel '$tunnelName' existe na Cloudflare, mas o arquivo de credenciais não está neste PC ($credFile). Apague o túnel em Zero Trust › Networks › Tunnels (ou rode: cloudflared tunnel delete $tunnelName) e execute de novo."
}
$r = Invoke-Cf @('tunnel', 'route', 'dns', '--overwrite-dns', $tunnelName, $Hostname)
if ($r.Code -ne 0 -and $r.Text -notmatch 'already') { Write-Host $r.Text; throw "Falha ao criar o DNS $Hostname. Detalhes em data\publicar.log" }
Ok "DNS $Hostname → túnel"
$cfg = Join-Path $Root 'deploy\cloudflared.yml'
$tlog = Join-Path $DataDir 'tunnel.log'
$yml = "tunnel: $($t.id)`r`ncredentials-file: $credFile`r`nlogfile: $tlog`r`nloglevel: info`r`nno-autoupdate: true`r`n# http2 (TCP 443) passa em qualquer rede, inclusive as que bloqueiam UDP/QUIC`r`nprotocol: http2`r`nretries: 10`r`ngrace-period: 30s`r`ningress:`r`n  - hostname: $Hostname`r`n    service: http://127.0.0.1:$Port`r`n  - service: http_status:404`r`n"
[IO.File]::WriteAllText($cfg, $yml, (New-Object Text.UTF8Encoding($false)))   # sem BOM: o cloudflared não lê YAML com BOM
$r = Invoke-Cf @('tunnel', '--config', $cfg, 'ingress', 'validate')
if ($r.Code -ne 0) { Write-Host $r.Text; throw 'Configuração do túnel inválida. Detalhes em data\publicar.log' }
Ok 'Configuração do túnel válida'
$tTask = 'LORLER Cerebro Tunnel'
Stop-ScheduledTask -TaskName $tTask -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='cloudflared.exe'" | Where-Object { $_.CommandLine -match 'lorler-cerebro|cloudflared\.yml' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
$tAction = New-ScheduledTaskAction -Execute $cf -Argument "tunnel --config `"$cfg`" run $tunnelName" -WorkingDirectory $Root
Register-ScheduledTask -TaskName $tTask -Action $tAction -Trigger $trigger -Principal $principal -Settings $settings -Description 'Túnel Cloudflare da Central de Decisões LORLER' -Force | Out-Null
if (Test-Path $tlog) { try { Move-Item $tlog "$tlog.anterior" -Force } catch { Clear-Content $tlog -ErrorAction SilentlyContinue } }   # só conta conexões desta execução
Start-ScheduledTask -TaskName $tTask
# Confirma que o túnel conectou na Cloudflare
$connected = $false
for ($i = 0; $i -lt 20 -and -not $connected; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Path $tlog) { if (Select-String -Path $tlog -Pattern 'Registered tunnel connection' -Quiet) { $connected = $true } }
}
if (-not $connected) {
  Aviso 'A tarefa agendada não conectou o túnel; iniciando o túnel diretamente (mantenha esta janela aberta)...'
  Start-Process -FilePath $cf -ArgumentList @('tunnel', '--config', $cfg, 'run', $tunnelName) -WindowStyle Hidden | Out-Null
  for ($i = 0; $i -lt 20 -and -not $connected; $i++) {
    Start-Sleep -Seconds 2
    if (Test-Path $tlog) { if (Select-String -Path $tlog -Pattern 'Registered tunnel connection' -Quiet) { $connected = $true } }
  }
}
if (-not $connected) {
  if (Test-Path $tlog) { Get-Content $tlog -Tail 20 | Out-Host }
  throw 'O túnel não conseguiu conectar na Cloudflare. Veja data\tunnel.log'
}
Ok "Túnel conectado (tarefa agendada '$tTask', inicia junto com o Windows)"

# 6) Vigia: a cada 5 minutos confere o servidor e o endereço público e reinicia o que tiver caído
$wTask = 'LORLER Cerebro Vigia'
$wScript = Join-Path $Root 'deploy\vigia.ps1'
$wAction = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$wScript`" -Hostname $Hostname -Port $Port" -WorkingDirectory $Root
$wTrigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(2) -RepetitionInterval (New-TimeSpan -Minutes 5)
$wSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 4)
try {
  Register-ScheduledTask -TaskName $wTask -Action $wAction -Trigger @($wTrigger, $trigger) -Principal $principal -Settings $wSettings -Description 'Vigia da Central de Decisões LORLER: reinicia servidor/túnel se caírem' -Force | Out-Null
  Ok "Vigia ativo (tarefa '$wTask', a cada 5 minutos)"
} catch { Aviso "Não consegui criar o vigia: $($_.Exception.Message)" }
$online = $false
for ($i = 0; $i -lt 12 -and -not $online; $i++) {
  Start-Sleep -Seconds 5
  try { if ((Invoke-WebRequest "https://$Hostname/healthz" -UseBasicParsing -TimeoutSec 10).Content -eq 'ok') { $online = $true } } catch {}
}
if ($online) { Ok "ONLINE: https://$Hostname"; Start-Process "https://$Hostname" }
else { Aviso "https://$Hostname ainda não respondeu (o DNS pode levar alguns minutos para propagar). O túnel e as tarefas estão ativos; tente abrir o endereço daqui a pouco." }
Write-Host ""
Write-Host "Pronto. A Central inicia sozinha quando você entra no Windows. Para parar: PARAR-CEREBRO.bat" -ForegroundColor Cyan
