@echo off
chcp 65001 >nul
title LORLER Cerebro - trazer os dados da nuvem (mudanca para a VPS)
cd /d "%~dp0"
where node >nul 2>&1 || (echo Node.js nao encontrado. Instale a versao 22.13 ou superior em https://nodejs.org & pause & exit /b 1)
echo.
echo  Este passo atualiza o cerebro na nuvem, baixa TODOS os dados para data\nuvem-export.json
echo  e deixa a nuvem SO LEITURA (nada mais e gravado la), para a VPS continuar de onde parou.
echo  Normalmente quem chama isto e o VPS-MENU, opcao C. Para desfazer: node scripts\nuvem.js descongelar
echo.
node --disable-warning=ExperimentalWarning scripts\nuvem.js trazer
echo.
pause
