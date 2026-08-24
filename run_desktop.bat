@echo off
cd /d "%~dp0"
title The Relationship

py -m pip install -r requirements.txt
if errorlevel 1 (
    echo.
    echo Nao foi possivel instalar as dependencias.
    pause
    exit /b 1
)

py app.py
if errorlevel 1 (
    echo.
    echo O programa terminou com erro.
    pause
)
