#!/usr/bin/env bash
set -euo pipefail

echo "Bench instructions:"
echo "1) Terminal A: cd server && npm i && npm start (WS signaling on :8080)."
echo "2) Terminal B: cd frontend && python -m http.server 3000."
echo "3) Open http://localhost:3000/viewer.html on laptop."
echo "4) Scan QR with phone -> grant camera."
echo "5) Click 'Start Metrics (30s)'; after it completes, click 'Save metrics.json'."


