@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 node，请先安装 Node.js 22+
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [错误] 依赖未安装，请先在当前目录执行: npm install
  pause
  exit /b 1
)

if not exist "config\config.yaml" (
  if not exist "config\config.example.yaml" (
    echo [错误] 缺少 config\config.yaml 和 config\config.example.yaml
    pause
    exit /b 1
  )
  copy /y "config\config.example.yaml" "config\config.yaml" >nul
  echo [提示] 已从示例生成 config\config.yaml
  echo        admin.token 留空时会打印临时口令，可按需修改后重新运行
  pause
  exit /b 0
)

netstat -ano | findstr ":8787" | findstr "LISTENING" >nul 2>nul
if not errorlevel 1 (
  echo [提示] 127.0.0.1:8787 已有服务在监听，Code2Api 可能已经启动
  echo        管理面板: http://127.0.0.1:8787/admin
  exit /b 0
)

echo [构建] 编译 TypeScript...
call npm run build
if errorlevel 1 (
  echo [错误] 构建失败，已终止
  pause
  exit /b 1
)

echo [启动] Code2Api  http://127.0.0.1:8787/admin
node --disable-warning=ExperimentalWarning dist\index.js
set "code=%errorlevel%"
if not "%code%"=="0" (
  echo [退出] 进程异常结束，退出码 %code%
  pause
)
exit /b %code%
