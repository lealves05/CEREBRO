@echo off
title LORLER Cerebro - publicar em cerebro.lorler.com.br
net session >nul 2>&1
if %errorlevel% neq 0 (
  echo Pedindo permissao de administrador para instalar a Central como servico do Windows...
  powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\cerebro-online.ps1" -Modo Permanente
pause
