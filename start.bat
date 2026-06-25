@echo off
title visitor-logger
cd /d "%~dp0"
node --env-file=.env server.js
pause
