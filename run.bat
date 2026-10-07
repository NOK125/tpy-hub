@echo off
chcp 65001 >nul
cd /d "%~dp0"
py server.py --open || python server.py --open
pause
