@echo off
title LORLER - Central de Decisoes
cd /d "%~dp0"
if not exist .env copy .env.example .env >nul
echo Iniciando a Central de Decisoes LORLER...
start "" http://127.0.0.1:3700
npm start
pause
