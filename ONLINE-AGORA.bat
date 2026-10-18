@echo off
title LORLER Cerebro - online agora (endereco temporario)
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "deploy\cerebro-online.ps1" -Modo Rapido
pause
