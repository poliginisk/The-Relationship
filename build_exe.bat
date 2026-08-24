@echo off
cd /d "%~dp0"
title Build The Relationship

echo Instalando dependencias...
py -m pip install -r requirements.txt pyinstaller
if errorlevel 1 (
    echo.
    echo Falha ao instalar dependencias.
    pause
    exit /b 1
)

echo.
echo Criando The Relationship.exe...
py -m PyInstaller ^
  --noconfirm ^
  --clean ^
  --onefile ^
  --windowed ^
  --name "The Relationship" ^
  --collect-all edge_tts ^
  --add-data "web;web" ^
  app.py

if errorlevel 1 (
    echo.
    echo Falha ao gerar o EXE.
    pause
    exit /b 1
)

echo.
echo Pronto!
echo O executavel esta em:
echo dist\The Relationship.exe
echo.
pause
