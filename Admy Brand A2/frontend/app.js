'use strict';
import { FaceDetector, FilesetResolver } from 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/vision_bundle.js';

(function () {
  const statusEl = document.getElementById('status');
  const statusTextEl = document.getElementById('statusText');
  const switchBtn = document.getElementById('switchCamera');
  const videoEl = document.getElementById('video');
  const canvasEl = document.getElementById('overlay');
  const ctx = canvasEl.getContext('2d');

  let faceDetector = null;
  let rafId = null;
  let vfcHandle = null;
  let detectToken = 0;
  let videoDevices = [];
  let currentCameraIndex = -1;
  let currentStream = null;
  const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  function setStatus(message) {
    if (statusTextEl) statusTextEl.textContent = message;
  }

  function isMediaSupported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function resizeCanvasToVideo() {
    const w = videoEl.videoWidth || videoEl.clientWidth || 0;
    const h = videoEl.videoHeight || videoEl.clientHeight || 0;
    if (!w || !h) return;
    if (canvasEl.width !== w || canvasEl.height !== h) {
      canvasEl.width = w;
      canvasEl.height = h;
    }
    ctx.clearRect(0, 0, canvasEl.width, canvasEl.height);
  }

  function drawDetections(detections) {
    const w = canvasEl.width;
    const h = canvasEl.height;
    ctx.clearRect(0, 0, w, h);
    if (!detections || detections.length === 0) return;
    ctx.save();
    ctx.strokeStyle = '#00FF00';
    ctx.lineWidth = 2;
    for (const d of detections) {
      const bb = d.boundingBox;
      const x = Math.max(0, Math.floor(bb.originX));
      const y = Math.max(0, Math.floor(bb.originY));
      const bw = Math.floor(bb.width);
      const bh = Math.floor(bb.height);
      if (bw <= 0 || bh <= 0) continue;
      ctx.strokeRect(x, y, bw, bh);
      const label = 'face';
      const padX = 6, padY = 3;
      ctx.font = '13px system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif';
      const textW = Math.ceil(ctx.measureText(label).width);
      const textH = 16;
      const bgX = x;
      const bgY = Math.max(0, y - (textH + padY * 2) - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(bgX, bgY, textW + padX * 2, textH + padY * 2);
      ctx.fillStyle = '#00FF00';
      ctx.textBaseline = 'top';
      ctx.fillText(label, bgX + padX, bgY + padY);
    }
    ctx.restore();
  }

  function getActiveTrackLabel() {
    const stream = currentStream || (videoEl && videoEl.srcObject);
    if (stream && stream.getVideoTracks && stream.getVideoTracks()[0]) {
      const t = stream.getVideoTracks()[0];
      return t && t.label ? t.label : 'Active camera (label unavailable)';
    }
    return 'Active camera (label unavailable)';
  }

  function updateMirrorForCurrentCamera() {
    const label = (getActiveTrackLabel() || '').toLowerCase();
    const isFront = label.includes('front') || label.includes('user') || label.includes('facetime');
    const transform = isFront ? 'scaleX(-1)' : 'none';
    videoEl.style.transform = transform;
    canvasEl.style.transform = transform;
  }

  async function initTasksVision() {
    const fileset = await FilesetResolver.forVisionTasks(
      'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.0/wasm'
    );
    const detector = await FaceDetector.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/latest/blaze_face_short_range.tflite'
      },
      runningMode: 'VIDEO',
      minDetectionConfidence: isMobile ? 0.3 : 0.5,
      maxNumFaces: 5
    });
    return detector;
  }

  async function enumerateVideoInputs() {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      videoDevices = devices.filter((d) => d.kind === 'videoinput');
    } catch (_) {
      videoDevices = [];
    }
  }

  async function startWithDeviceId(deviceId) {
    // Stop previous stream
    if (currentStream) {
      try { currentStream.getTracks().forEach((t) => t.stop()); } catch (_) {}
      currentStream = null;
    }
    const constraints = {
      video: { deviceId: deviceId ? { exact: deviceId } : undefined, width: { ideal: isMobile ? 640 : 1280 }, height: { ideal: isMobile ? 480 : 720 } },
      audio: false
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    currentStream = stream;
    videoEl.srcObject = stream;
    await new Promise((res) => { if (videoEl.readyState >= 1) res(); else videoEl.onloadedmetadata = () => res(); });
    try { await videoEl.play(); } catch (_) {}
    resizeCanvasToVideo();
    updateMirrorForCurrentCamera();

    // Set currentCameraIndex based on provided deviceId
    if (deviceId && videoDevices.length) {
      const idx = videoDevices.findIndex((d) => d.deviceId === deviceId);
      if (idx >= 0) currentCameraIndex = idx;
    } else if (videoDevices.length) {
      // Try map track settings
      const st = stream.getVideoTracks()[0].getSettings();
      if (st && st.deviceId) {
        const idx2 = videoDevices.findIndex((d) => d.deviceId === st.deviceId);
        if (idx2 >= 0) currentCameraIndex = idx2;
      }
    }
  }

  function preferRearIndexOrFirst() {
    if (!videoDevices.length) return -1;
    const rearIdx = videoDevices.findIndex((d) => (d.label || '').toLowerCase().includes('back') || (d.label || '').toLowerCase().includes('rear'));
    return rearIdx >= 0 ? rearIdx : 0;
  }

  async function startCameraAndDetect() {
    if (!isMediaSupported()) {
      setStatus('Error: getUserMedia() unsupported.');
      return;
    }

    try {
      // Initialize detector first (once)
      if (!faceDetector) {
        faceDetector = await initTasksVision();
        if (!faceDetector) return;
      }

      // First try preferred facingMode to get permission; then enumerate devices
      if (!currentStream) {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: isMobile ? 640 : 1280 }, height: { ideal: isMobile ? 480 : 720 } }, audio: false });
        currentStream = tmp; videoEl.srcObject = tmp;
        await new Promise((res) => { if (videoEl.readyState >= 1) res(); else videoEl.onloadedmetadata = () => res(); });
        try { await videoEl.play(); } catch (_) {}
        resizeCanvasToVideo();
        updateMirrorForCurrentCamera();
      }

      // Enumerate devices (labels available after permission granted)
      await enumerateVideoInputs();
      if (videoDevices.length) {
        // Pick rear if possible, else first
        const idx = preferRearIndexOrFirst();
        currentCameraIndex = idx;
        await startWithDeviceId(videoDevices[idx].deviceId);
      }

      setStatus(`Camera: ${getActiveTrackLabel()} | Faces: 0`);
      startDetectionLoop();
    } catch (err) {
      console.error(err);
      setStatus('Camera error. Permissions or device unsupported.');
    }
  }

  function stopDetectionLoop() {
    if (rafId) { try { cancelAnimationFrame(rafId); } catch (_) {} rafId = null; }
    if (vfcHandle && typeof videoEl.cancelVideoFrameCallback === 'function') {
      try { videoEl.cancelVideoFrameCallback(vfcHandle); } catch (_) {}
      vfcHandle = null;
    }
    // invalidate any queued callbacks
    detectToken++;
  }

  function startDetectionLoop() {
    stopDetectionLoop();
    const myToken = ++detectToken;

    const onFrame = (ts) => {
      if (myToken !== detectToken) return; // stale callback
      if (!faceDetector) return;
      const nowMs = typeof ts === 'number' ? ts : performance.now();
      const result = faceDetector.detectForVideo(videoEl, nowMs);
      const detections = (result && result.detections) ? result.detections : [];
      drawDetections(detections);
      setStatus(`Camera: ${getActiveTrackLabel()} | Faces: ${detections.length}`);
      scheduleNext();
    };

    const scheduleNext = () => {
      if (myToken !== detectToken) return; // stale
      if (typeof videoEl.requestVideoFrameCallback === 'function') {
        vfcHandle = videoEl.requestVideoFrameCallback(onFrame);
      } else {
        rafId = requestAnimationFrame(() => onFrame(performance.now()));
      }
    };

    scheduleNext();
  }

  window.addEventListener('resize', resizeCanvasToVideo);
  window.addEventListener('orientationchange', resizeCanvasToVideo);
  window.addEventListener('DOMContentLoaded', startCameraAndDetect);
  window.resizeCanvasToVideo = resizeCanvasToVideo;

  // Camera switch handling
  async function handleSwitchCamera() {
    if (!videoDevices || videoDevices.length <= 1) return;
    if (switchBtn) switchBtn.disabled = true;
    try {
      const nextIdx = (currentCameraIndex + 1) % videoDevices.length;
      await startWithDeviceId(videoDevices[nextIdx].deviceId);
      currentCameraIndex = nextIdx;
      setStatus(`Camera: ${getActiveTrackLabel()} | Faces: 0`);
      startDetectionLoop();
    } catch (e) {
      console.error('Switch camera failed', e);
      setStatus('Switch camera failed.');
    } finally {
      if (switchBtn) switchBtn.disabled = false;
    }
  }

  if (switchBtn) switchBtn.addEventListener('click', handleSwitchCamera);
})();


