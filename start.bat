@echo off
cd /d %~dp0
echo tick_clone: http://127.0.0.1:8765  (Ctrl+C to stop)
python -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765
pause
