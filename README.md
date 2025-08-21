Title
Admy Brand – Realtime Camera + WebRTC + In‑browser AI (WASM)

Overview
- Mobile‑first demo that:
  - Captures camera (laptop/phone) and draws an overlay.
  - Streams phone camera → laptop via WebRTC.
  - Runs in‑browser AI:
    - Laptop‑only page (index.html): MediaPipe Tasks Vision FaceDetector (green boxes).
    - WebRTC viewer (viewer.html): ONNXRuntime‑Web (WASM) multi‑object detector (SSD‑Mobilenet).
  - Shows live status + metrics (FPS, latency, kbps) and saves metrics.json.

Key Features
- Camera: rear‑preferred, iOS‑friendly (playsinline, muted).
- Overlay: `<canvas>` perfectly aligned; clears when no detections.
- FaceDetector flow (index.html): fast, no model download.
- WASM Detector flow (viewer.html): SSD‑Mobilenet on 320×240 frames with frame‑thinning; ~12 FPS target.
- WebRTC: phone.html → viewer.html using local WS signaling; Google STUN.
- Metrics: periodic WebRTC stats via WS; appended to metrics.json (server side).
- Switch camera: laptop page shows a button to toggle front/rear, preserves detection.

Tech Stack
- Frontend: HTML/CSS/JS (no frameworks).
- Media APIs: getUserMedia, Canvas 2D, requestVideoFrameCallback (fallback to rAF).
- AI:
  - Face: @mediapipe/tasks-vision FaceDetector (ES module; BlazeFace short‑range TFLite on GCS).
  - Objects: onnxruntime‑web (WASM) + SSD‑MobilenetV1‑12 ONNX.
- WebRTC: RTCPeerConnection + DataChannel; minimal WS signaling (ws).
- Node: server/signaling.js (ws) appends metrics to metrics.json.
- Static hosting: python -m http.server.

Repo Structure
- frontend/
  - index.html, style.css, app.js (laptop camera + FaceDetector + Switch Camera)
  - phone.html (sender), viewer.html (receiver + WASM detector + HUD)
  - webrtc.js (WS connect, RTCPeerConnection, metrics sender)
  - qr.js (tiny QR renderer)
  - wasm_detector.js (onnxruntime-web wrapper: init/enqueue/start/stop/metrics)
  - models/ (place mobilenet_ssd.onnx here)
- server/
  - signaling.js (WS signaling + metrics append)
  - package.json (scripts)
- bench/
  - run_bench.sh (manual bench instructions)

How It Works (Flows)
1) Laptop‑only FaceDetector (index.html)
- getUserMedia → <video> + <canvas>
- MediaPipe Tasks Vision FaceDetector detects faces each frame.
- `resizeCanvasToVideo()` keeps overlay aligned; status shows camera label + face count.
- “Switch Camera” stops current tracks, restarts with exact deviceId, mirrors front only.

2) Phone → Viewer WebRTC (phone.html + viewer.html)
- Viewer opens a room via WS signaling (ws://<host>:8080) and shows a QR (http://<host>:3000/phone.html?room=ID).
- Phone joins room, sends 1 video track and a DataChannel “telemetry” with {frame_id, capture_ts}.
- Viewer receives remote video; WASM detector:
  - Captures the latest frame (frame‑thinning) at ~12 FPS (320×240).
  - Runs SSD‑Mobilenet (WASM), postprocesses normalized boxes.
  - Draws green boxes on the overlay; updates HUD (FPS, p50/p95 latency, kbps).
- Every 2s viewer/phone send WebRTC stats via WS with type “metrics”; server appends to metrics.json.

Setup
- Prereqs: Node 18+, Python 3, Chrome/Edge (desktop), Chrome (Android).
- Model: download SSD‑MobilenetV1‑12 (“ssd‑12.onnx”) from ONNX Model Zoo (validated/vision/object_detection/ssd/model).
  - Save as: frontend/models/mobilenet_ssd.onnx.

Run (Laptop‑only FaceDetector)
- Terminal:
  - cd "Admy Brand A2/frontend"
  - python -m http.server 3000
- Open http://localhost:3000
- Grant camera. You should see live video + green face boxes.

Run (Phone → Viewer WebRTC + WASM detector)
- Terminal A (signaling):
  - cd "Admy Brand A2/server"
  - npm i
  - npm start
- Terminal B (frontend server):
  - cd "Admy Brand A2/frontend"
  - python -m http.server 3000
- Laptop: http://<LAN-IP>:3000/viewer.html (find IP via ipconfig → IPv4)
- Phone (same Wi‑Fi; mobile data OFF; Chrome):
  - Scan the QR or open the join URL printed on viewer.
- Expect: remote video on viewer + green boxes tracking objects; HUD updates.

Metrics
- HUD (viewer): Objects/Faces | FPS | Lat (p50/p95) | Up/Down kbps.
- “Start Metrics (30s)” → “Save metrics.json” (client‑side summary).
- Server appends samples every 2s to project‑root metrics.json:
  - { timestamp, bitrate, fps, latencyMs }

Ngrok (Optional HTTPS, e.g., iPhone)
- ngrok config add-authtoken <TOKEN>
- ngrok http 3000
- ngrok http 8080
- Open viewer via the 3000 HTTPS URL.
- Signaling options:
  - Keep WS on LAN (fast). Ensure Node (8080) allowed in Windows Firewall Private; the viewer will dial ws://<LAN-IP>:8080.
  - Or adapt `webrtc.js` to accept a `?wsHost=` param and dial `wss://<ngrok-host-8080>`.

Configuration Knobs
- wasm_detector.js:
  - CONFIG.TARGET_FPS (default 12)
  - CONFIG.INPUT_WIDTH/HEIGHT (default 320×240)
  - CONFIG.SCORE_THRESHOLD (default 0.4)
  - Adaptive FPS lowers to ≥6 if inference time exceeds budget.
- app.js:
  - Mobile thresholds, mirroring, resolution (mobile 640×480 by default for stability).

Troubleshooting
- 404 /viewer.html, /phone.html: static server isn’t in frontend/; serve from frontend.
- QR unscannable: open viewer with LAN IP; not localhost; phone on same Wi‑Fi; mobile data OFF.
- No WS: allow Node (8080) in Windows Firewall; viewer Network must show ws://<LAN-IP>:8080.
- Model missing: open http://<LAN-IP>:3000/models/mobilenet_ssd.onnx directly (must download; not 404); then hard‑refresh with DevTools → Network → Disable cache.
- Android TypeError in phone: fallback uses `{ video: true }` constraints.
- iPhone over LAN: camera may require HTTPS; use ngrok HTTPS or test with Android Chrome.
