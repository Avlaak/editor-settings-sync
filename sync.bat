@echo off
node "%~dp0scripts\sync.js" %*
exit /b %ERRORLEVEL%
