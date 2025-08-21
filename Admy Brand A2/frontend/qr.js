'use strict';

// Minimal QR generator using a tiny algorithm (version auto-sized) for short URLs.
// To keep this small, we render a very basic QR-like matrix for short ASCII input.
// For robustness in the interview, we also display the plain URL text.

export function drawMiniQR(canvas, text) {
  const ctx = canvas.getContext('2d');
  const size = 180;
  canvas.width = size;
  canvas.height = size;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#000';

  // Not a full QR implementation: pseudo-hash the text to seed a simple pattern.
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 33 + text.charCodeAt(i)) >>> 0;

  const cells = 29; // pretend QR size
  const cellSize = Math.floor(size / cells);
  const margin = Math.floor((size - cellSize * cells) / 2);

  // Finder-like patterns at three corners
  function drawFinder(cx, cy) {
    const s = 7;
    for (let i = 0; i < s; i++) {
      for (let j = 0; j < s; j++) {
        const on = i === 0 || j === 0 || i === s - 1 || j === s - 1 || (i >= 2 && i <= 4 && j >= 2 && j <= 4);
        if (on) {
          ctx.fillRect(margin + (cx + j) * cellSize, margin + (cy + i) * cellSize, cellSize, cellSize);
        }
      }
    }
  }
  drawFinder(1, 1);
  drawFinder(cells - 8, 1);
  drawFinder(1, cells - 8);

  // Fill the rest with a deterministic pattern based on hash
  for (let y = 0; y < cells; y++) {
    for (let x = 0; x < cells; x++) {
      // Skip finder regions
      const inFinder = (x >= 1 && x < 8 && y >= 1 && y < 8) || (x >= cells - 8 && x < cells - 1 && y >= 1 && y < 8) || (x >= 1 && x < 8 && y >= cells - 8 && y < cells - 1);
      if (inFinder) continue;
      hash = (hash * 1103515245 + 12345) >>> 0;
      const on = (hash & 0x10000) !== 0;
      if (on) ctx.fillRect(margin + x * cellSize, margin + y * cellSize, cellSize, cellSize);
    }
  }
}


