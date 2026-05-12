#!/bin/bash
# 台股小牛助理 — 開機自動啟動腳本
cd /Users/piyatat726/stock-bull-assistant

# 關閉舊的伺服器和隧道
lsof -ti:5566 | xargs kill 2>/dev/null
pkill -f "ngrok" 2>/dev/null
sleep 1

# 防止 Mac 進入睡眠（只要伺服器在跑就不會睡）
caffeinate -s -w $$ &

# 啟動伺服器（server.py 內部會自動啟動 ngrok）
exec /usr/bin/python3 /Users/piyatat726/stock-bull-assistant/server.py
