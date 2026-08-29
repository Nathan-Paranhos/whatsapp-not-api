@echo off
setlocal
cd /d "%~dp0"
title whatsapp-not-api

if not exist "node_modules\express" (
  echo Primeira execucao: instalando o sistema...
  call npm run setup:windows
  if errorlevel 1 goto :erro
)

echo.
echo Abra http://127.0.0.1:3333 no navegador.
echo Para encerrar com seguranca, pressione Ctrl+C uma vez.
echo.
call npm start
goto :fim

:erro
echo.
echo Nao foi possivel instalar. Confira se o Node 24 esta instalado.
pause

:fim
endlocal

