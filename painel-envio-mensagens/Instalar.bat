@echo off
title Instalador - Painel de Envio de Mensagens
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0instalador.ps1"
pause
