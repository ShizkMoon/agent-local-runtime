@echo off
rem aica workbench v0 启动器：node 桥接服务 + Edge --app 无框窗口
setlocal
set "NODE=C:\Program Files\nodejs\node.exe"
set "SERVER=%~dp0server.ts"
set "PORT=%WB_PORT%"
if "%PORT%"=="" set "PORT=4399"
set "EDGE1=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
set "EDGE2=C:\Program Files\Microsoft\Edge\Application\msedge.exe"

rem 已在监听则直接开窗口（重复启动安全）
netstat -ano | findstr /r "127\.0\.0\.1:%PORT% .*LISTENING" >nul 2>&1
if errorlevel 1 (
  start "aica-wb-server" /min "%NODE%" "%SERVER%"
  rem 等端口就绪（最多 ~10s）
  for /l %%i in (1,1,40) do (
    timeout /t 1 /nobreak >nul
    netstat -ano | findstr /r "127\.0\.0\.1:%PORT% .*LISTENING" >nul 2>&1 && goto :open
  )
)

:open
if exist "%EDGE1%" (start "aica" "%EDGE1%" --app=http://127.0.0.1:%PORT%) else (
  if exist "%EDGE2%" (start "aica" "%EDGE2%" --app=http://127.0.0.1:%PORT%) else (
    rem Edge 缺失：回退默认浏览器
    start "" http://127.0.0.1:%PORT%
  )
)
endlocal
