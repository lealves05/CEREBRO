@echo off
chcp 65001 >nul
title LORLER Cerebro - publicar na nuvem (Cloudflare)
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Pedindo permissao de administrador para desativar o cerebro do PC no final...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js nao encontrado. Instale a versao 22.13 ou superior em https://nodejs.org & pause & exit /b 1)

echo.
echo == Backup antes de publicar ==
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "TS=%%i"
set "BK=%~dp0..\BACKUP-Sistemas\Cerebro-antes-nuvem-%TS%"
robocopy "%~dp0." "%BK%" /E /XD node_modules .wrangler /NFL /NDL /NJH /NJS /NP >nul
echo   [ok] Copia em %BK%

node --disable-warning=ExperimentalWarning scripts\nuvem.js publicar
echo.
pause
