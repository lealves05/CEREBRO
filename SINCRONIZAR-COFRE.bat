@echo off
chcp 65001 >nul
title LORLER - Cofre do Cerebro (Obsidian)
cd /d "%~dp0"
set "COFRE=%~dp0..\Cofre-Cerebro"
set "NODE=node"
where node >nul 2>nul || (if exist "%~dp0..\node-v24.20.0-win-x64\node.exe" set "NODE=%~dp0..\node-v24.20.0-win-x64\node.exe")
echo.
echo  Sincronizando o cofre do Cerebro com a pasta:
echo  %COFRE%
echo.
"%NODE%" scripts\cofre-sync.js --dir "%COFRE%"
if errorlevel 1 (echo. & echo Falhou. Confira o token e a internet. & pause & exit /b 1)
REM Obsidian: instala se faltar (winget) e abre o cofre
set "OBS=%LOCALAPPDATA%\Programs\Obsidian\Obsidian.exe"
if not exist "%OBS%" (
  echo.
  echo  O Obsidian nao esta instalado. Instalando pelo winget...
  winget install -e --id Obsidian.Obsidian --accept-source-agreements --accept-package-agreements
)
start "" "obsidian://open?path=%COFRE%"
echo.
echo  Pronto. No Obsidian: "Abrir pasta como cofre" e escolha a pasta acima (so na primeira vez).
echo  Quer deixar sincronizando sozinho? Deixe esta janela aberta.
choice /c SN /m "Manter sincronizando a cada 60 segundos"
if errorlevel 2 exit /b 0
"%NODE%" scripts\cofre-sync.js --dir "%COFRE%" --watch
