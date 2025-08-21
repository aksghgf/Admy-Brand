'use strict';

// Lightweight in-browser object detector using onnxruntime-web (WASM)
// API:
// - await initDetector(modelPath)
// - enqueueFrame(imageBitmap, meta)
// - startProcessing(onResult)
// - stopProcessing()
// - getMetrics()
// Notes:
// - Model should be SSD-like producing detections [1,1,N,7] (image_id,label,score,xmin,ymin,xmax,ymax)
// - Place model at /models/mobilenet_ssd.onnx or use a stable CDN; e.g.
//   ONNX Zoo SSD MobileNet V1: https://github.com/onnx/models (vision/object_detection_segmentation/ssd)

export const CONFIG = {
  TARGET_FPS: 12,
  INPUT_WIDTH: 320,
  INPUT_HEIGHT: 240,
  SCORE_THRESHOLD: 0.4,
  MIN_FPS: 6
};

let session = null;
let latest = null; // { bitmap, meta }
let processing = false;
let timer = null;
let avgInferenceMs = 0;

// Metrics
const metric = {
  frames: 0,
  startTs: 0,
  latencies: []
};

function median(arr) { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); const m = Math.floor(s.length/2); return s.length%2?s[m]:(s[m-1]+s[m])/2; }
function p95(arr) { if (!arr.length) return 0; const s = [...arr].sort((a,b)=>a-b); return s[Math.floor(0.95*(s.length-1))]; }

function ensureOrtLoaded() {
  return new Promise((resolve, reject) => {
    if (globalThis.ort) return resolve();
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort.min.js';
    s.async = true;
    s.onload = () => globalThis.ort ? resolve() : reject(new Error('onnxruntime-web failed to load'));
    s.onerror = () => reject(new Error('Failed to load onnxruntime-web'));
    document.head.appendChild(s);
  });
}

export async function initDetector(modelPath) {
  await ensureOrtLoaded();
  session = await ort.InferenceSession.create(modelPath, { executionProviders: ['wasm'] });
  metric.frames = 0; metric.startTs = Date.now(); metric.latencies.length = 0;
}

export function enqueueFrame(imageBitmap, meta) {
  // Replace the slot; close previous bitmap to free memory
  if (latest && latest.bitmap && latest.bitmap.close) try { latest.bitmap.close(); } catch {}
  latest = { bitmap: imageBitmap, meta };
}

export function stopProcessing() {
  processing = false;
  if (timer) { clearTimeout(timer); timer = null; }
  if (latest && latest.bitmap && latest.bitmap.close) try { latest.bitmap.close(); } catch {}
  latest = null;
}

export function getMetrics() {
  const elapsedS = Math.max(0.001, (Date.now() - metric.startTs) / 1000);
  return {
    fps: metric.frames / elapsedS,
    median_latency_ms: median(metric.latencies),
    p95_latency_ms: p95(metric.latencies)
  };
}

function toTensorFromBitmap(bitmap, targetW, targetH) {
  // Draw with letterboxing to preserve aspect
  const canvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(targetW, targetH) : (() => { const c = document.createElement('canvas'); c.width = targetW; c.height = targetH; return c; })();
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, targetW, targetH);
  const scale = Math.min(targetW / bitmap.width, targetH / bitmap.height);
  const drawW = Math.round(bitmap.width * scale);
  const drawH = Math.round(bitmap.height * scale);
  const dx = Math.floor((targetW - drawW) / 2);
  const dy = Math.floor((targetH - drawH) / 2);
  ctx.drawImage(bitmap, dx, dy, drawW, drawH);

  const imgData = ctx.getImageData(0, 0, targetW, targetH);
  const { data } = imgData; // RGBA
  const chw = new Float32Array(3 * targetH * targetW);
  let p = 0;
  for (let y = 0; y < targetH; y++) {
    for (let x = 0; x < targetW; x++) {
      const i = (y * targetW + x) * 4;
      const r = data[i] / 255;
      const g = data[i + 1] / 255;
      const b = data[i + 2] / 255;
      chw[p] = r; // R
      chw[p + targetW * targetH] = g; // G
      chw[p + 2 * targetW * targetH] = b; // B
      p++;
    }
  }
  return new ort.Tensor('float32', chw, [1, 3, targetH, targetW]);
}

function postprocess(outputs, canvasW, canvasH, scoreThreshold) {
  // Support two shapes:
  // A) ONNX Model Zoo SSD-MobilenetV1-12: boxes [1, num_priors, 4] (ymin,xmin,ymax,xmax),
  //    scores [1, num_classes, num_priors]
  // B) Detection output [1,1,N,7] (image_id,label,score,xmin,ymin,xmax,ymax)
  const keys = Object.keys(outputs);
  const byName = (name) => keys.find(k => k.toLowerCase().includes(name));
  const dets = [];

  const boxesKey = byName('box');
  const scoresKey = byName('score');

  if (boxesKey && scoresKey) {
    const boxesT = outputs[boxesKey];
    const scoresT = outputs[scoresKey];
    const boxes = boxesT.data || boxesT;
    const scores = scoresT.data || scoresT;
    const [b0, numPriors, four] = boxesT.dims || boxesT.shape || [1, 0, 4];
    const [s0, numClasses, sPriors] = scoresT.dims || scoresT.shape || [1, 0, 0];
    const priors = Math.min(numPriors || 0, sPriors || 0);
    for (let i = 0; i < priors; i++) {
      // Find best non-background class (assume class 0 is background)
      let bestClass = 0; let bestScore = 0;
      for (let c = 1; c < numClasses; c++) {
        const sc = scores[c * (sPriors) + i];
        if (sc > bestScore) { bestScore = sc; bestClass = c; }
      }
      if (bestScore >= scoreThreshold) {
        const ymin = boxes[i * 4 + 0];
        const xmin = boxes[i * 4 + 1];
        const ymax = boxes[i * 4 + 2];
        const xmax = boxes[i * 4 + 3];
        dets.push({ label: String(bestClass), score: bestScore, xmin, ymin, xmax, ymax });
      }
    }
    return dets;
  }

  // Fallback: [1,1,N,7]
  const firstKey = keys[0];
  const out = outputs[firstKey];
  const data = out && (out.data || out);
  const dims = out && (out.dims || out.shape);
  if (dims && dims.length === 4 && dims[2] && dims[3] === 7 && data && data.length) {
    const N = dims[2];
    for (let i = 0; i < N; i++) {
      const base = i * 7;
      const label = data[base + 1];
      const score = data[base + 2];
      if (score < scoreThreshold) continue;
      const xmin = data[base + 3];
      const ymin = data[base + 4];
      const xmax = data[base + 5];
      const ymax = data[base + 6];
      dets.push({ label: String(label), score, xmin, ymin, xmax, ymax });
    }
  }
  return dets;
}

export function startProcessing(onResult) {
  if (!session) throw new Error('Detector not initialized');
  processing = true;
  metric.frames = 0; metric.startTs = Date.now(); metric.latencies.length = 0;

  const loop = async () => {
    if (!processing) return;
    const startLoop = performance.now();
    const slot = latest; latest = null; // take latest and clear slot
    if (slot && slot.bitmap) {
      const recvTs = Date.now();
      let resultJson = { frame_id: slot.meta && slot.meta.frame_id || 0, capture_ts: slot.meta && slot.meta.capture_ts || recvTs, recv_ts: recvTs, inference_ts: 0, detections: [] };
      try {
        const input = toTensorFromBitmap(slot.bitmap, CONFIG.INPUT_WIDTH, CONFIG.INPUT_HEIGHT);
        const inputName = session.inputNames ? session.inputNames[0] : 'input';
        const outputs = await session.run({ [inputName]: input });
        const dets = postprocess(outputs, CONFIG.INPUT_WIDTH, CONFIG.INPUT_HEIGHT, CONFIG.SCORE_THRESHOLD);
        resultJson.detections = dets;
      } catch (e) {
        // if inference fails, keep empty detections
      } finally {
        resultJson.inference_ts = Date.now();
        metric.frames++;
        metric.latencies.push(resultJson.inference_ts - resultJson.capture_ts);
        try { slot.bitmap.close(); } catch {}
      }
      onResult && onResult(resultJson);
    }

    // Adaptive FPS
    const elapsed = performance.now() - startLoop;
    avgInferenceMs = avgInferenceMs ? (avgInferenceMs * 0.8 + elapsed * 0.2) : elapsed;
    let targetFps = CONFIG.TARGET_FPS;
    const frameBudget = 1000 / targetFps;
    if (avgInferenceMs > frameBudget) {
      targetFps = Math.max(CONFIG.MIN_FPS, targetFps - 2);
    }
    const delay = Math.max(0, Math.round((1000 / targetFps) - elapsed));
    timer = setTimeout(loop, delay);
  };
  loop();
}


