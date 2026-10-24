#!/bin/sh
# tick_clone を起動する（Mac・Linux 用）。止めるときは Ctrl+C。
cd "$(dirname "$0")" || exit 1
echo "tick_clone: http://127.0.0.1:8765  (Ctrl+C to stop)"
exec python3 -m uvicorn main:app --app-dir app --host 127.0.0.1 --port 8765
