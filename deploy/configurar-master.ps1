# Libera a Área Master para o Cérebro LORLER.
# A senha do administrador "cerebro" é gerada AQUI no seu PC, gravada só no .env e no SQL que você cola no Supabase.
# Ninguém mais (nem o assistente) vê essa senha.
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$root = Split-Path -Parent $PSScriptRoot
$envFile = Join-Path $root '.env'
$masterUrl = 'https://master.lorler.com.br'
$sqlEditor = 'https://supabase.com/dashboard/project/yfclulrxwwugfaboaqmr/sql/new'

function Set-EnvValue($key, $value) {
  $lines = @(); if (Test-Path $envFile) { $lines = Get-Content $envFile -Encoding UTF8 }
  $found = $false
  $lines = $lines | ForEach-Object { if ($_ -match "^$([regex]::Escape($key))=") { $found = $true; "$key=$value" } else { $_ } }
  if (-not $found) { $lines += "$key=$value" }
  [IO.File]::WriteAllLines($envFile, $lines, (New-Object Text.UTF8Encoding($false)))
}

Write-Host ''
Write-Host '=== LORLER · Liberar a Área Master para o Cérebro ===' -ForegroundColor Cyan

# 1) Senha forte aleatória (sem aspas, barras ou caracteres que atrapalhem o SQL/.env)
$alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789'.ToCharArray()
$senha = ''
if (Test-Path $envFile) { $l = Get-Content $envFile -Encoding UTF8 | Where-Object { $_ -match '^LORLER_SECRET_MASTER_PASSWORD=(.{12,})$' } | Select-Object -First 1; if ($l) { $senha = ($l -split '=', 2)[1].Trim() } }
if ($senha -and $senha -notmatch '^[A-Za-z0-9]+$') { $senha = '' }   # só reaproveita senha gerada por este script
if (-not $senha) {
  $bytes = New-Object byte[] 28; [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  $senha = -join ($bytes | ForEach-Object { $alpha[$_ % $alpha.Length] })
  Write-Host '[ok] Senha nova gerada.' -ForegroundColor Green
} else { Write-Host '[ok] Reaproveitando a senha já gravada no .env.' -ForegroundColor Green }

# 2) .env do cérebro
Set-EnvValue 'LORLER_MASTER_URL' $masterUrl
Set-EnvValue 'LORLER_MASTER_USERNAME' 'cerebro'
Set-EnvValue 'LORLER_SECRET_MASTER_PASSWORD' $senha
Write-Host '[ok] .env atualizado (usuário cerebro + senha nova).' -ForegroundColor Green

# 3) SQL para o Supabase (cria ou atualiza o administrador dedicado, sem MFA, ativo)
$sql = @"
-- Central de Decisões LORLER: administrador dedicado da Área Master
update platform_admins set password_hash = extensions.crypt('$senha', extensions.gen_salt('bf', 10)),
  active = true, must_change_password = false, mfa_enabled = false, password_changed_at = now()
where username = 'cerebro';
insert into platform_admins (username, name, password_hash, role, active, must_change_password)
select 'cerebro', 'Central de Decisões LORLER', extensions.crypt('$senha', extensions.gen_salt('bf', 10)), 'SUPER_ADMIN', true, false
where not exists (select 1 from platform_admins where username = 'cerebro');
select username, active, must_change_password, mfa_enabled from platform_admins where username = 'cerebro';
"@
Set-Clipboard -Value $sql
$sqlFile = Join-Path $root 'data\master-admin.sql'
[IO.File]::WriteAllText($sqlFile, $sql, (New-Object Text.UTF8Encoding($false)))
Write-Host ''
Write-Host "(O mesmo SQL também está em $sqlFile — será apagado no final.)" -ForegroundColor DarkGray
Write-Host 'O comando SQL foi COPIADO para a área de transferência.' -ForegroundColor Yellow
Write-Host 'Vou abrir o SQL Editor do Supabase (projeto ORBI):'
Write-Host '  1. Clique na área de texto e aperte Ctrl+V'
Write-Host '  2. Clique em RUN (ou Ctrl+Enter)'
Write-Host '  3. Confira que aparece: cerebro | true | false | false'
Start-Process $sqlEditor
Write-Host ''
Read-Host 'Depois de rodar o SQL, volte aqui e aperte ENTER'
Set-Clipboard -Value ' '   # limpa a senha da área de transferência
Remove-Item $sqlFile -ErrorAction SilentlyContinue

# 4) Teste de login direto no Master (até 3 tentativas: dá tempo de rodar o SQL)
$ok = $false
for ($tent = 1; $tent -le 3 -and -not $ok; $tent++) {
Write-Host 'Testando o login do cérebro na Área Master...'
try {
  $body = @{ username = 'cerebro'; password = $senha } | ConvertTo-Json
  $r = Invoke-RestMethod -Method Post -Uri "$masterUrl/api/master/auth/login" -Body $body -ContentType 'application/json' -TimeoutSec 30
  if ($r.token) { $ok = $true; Write-Host '[ok] Login aceito pela Área Master.' -ForegroundColor Green }
  elseif ($r.mfa_required) { Write-Host '[!] O Master pediu MFA para o usuário cerebro. Rode o SQL de novo (ele desliga o MFA desse usuário).' -ForegroundColor Red }
  else { Write-Host '[!] Resposta inesperada do Master.' -ForegroundColor Red }
} catch {
  Write-Host "[!] Falha no login: $($_.Exception.Message)" -ForegroundColor Red
  Write-Host '    O usuário cerebro ainda não existe ou a senha não confere: rode o SQL no Supabase (Ctrl+V -> Run).'
  if ($tent -lt 3) { Set-Clipboard -Value $sql; Read-Host 'SQL copiado de novo. Depois de clicar em RUN no Supabase, aperte ENTER para testar outra vez' }
}
}

Set-Clipboard -Value ' '

# 5) Reinicia o cérebro para ler o .env novo
Write-Host 'Reiniciando o Cérebro...'
try {
  Stop-ScheduledTask -TaskName 'LORLER Cerebro' -ErrorAction SilentlyContinue
  Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'src[\\/]server\.js' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep 2
  Start-ScheduledTask -TaskName 'LORLER Cerebro'
  $up = $false
  for ($i = 0; $i -lt 30; $i++) { Start-Sleep 1; try { if ((Invoke-WebRequest 'http://127.0.0.1:3700/healthz' -UseBasicParsing -TimeoutSec 3).StatusCode -eq 200) { $up = $true; break } } catch {} }
  if ($up) { Write-Host '[ok] Cérebro reiniciado.' -ForegroundColor Green } else { Write-Host '[!] O cérebro não respondeu. Rode PUBLICAR-CEREBRO.bat como administrador.' -ForegroundColor Red }
} catch { Write-Host "[!] Não consegui reiniciar a tarefa: $($_.Exception.Message). Rode PUBLICAR-CEREBRO.bat como administrador." -ForegroundColor Red }

Write-Host ''
if ($ok) { Write-Host 'Pronto! Abra https://cerebro.lorler.com.br — o painel passa a mostrar ÁREA MASTER · AO VIVO.' -ForegroundColor Cyan }
Write-Host 'Para revogar: update platform_admins set active = false where username = ''cerebro'';'
Read-Host 'ENTER para fechar'
