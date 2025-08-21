'use strict';

// Shared WebRTC helpers for phone and viewer pages (no frameworks)

let __ws = null;
let __room = null;
let __role = null;
let __metricsTimer = null;
let __lastBytesSent = 0;
let __lastTs = 0;

export function connectSignaling(roomId, role) {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const host = location.hostname; // use the page's host so phone can reach the laptop
  const ws = new WebSocket(`${proto}://${host}:8080`);
  let openResolve;
  const opened = new Promise((res) => (openResolve = res));

  ws.onopen = () => {
    __ws = ws; __room = roomId; __role = role;
    openResolve();
    if (role === 'viewer') ws.send(JSON.stringify({ type: 'create', room: roomId }));
    else if (role === 'phone') ws.send(JSON.stringify({ type: 'join', room: roomId }));
  };

  return { ws, opened };
}

export function createPeerConnection(onIce, onTrack, onConnectionStateChange) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }]
  });
  pc.onicecandidate = (e) => {
    if (e.candidate) onIce(e.candidate);
  };
  pc.ontrack = (e) => {
    if (e.streams && e.streams[0]) onTrack(e.streams[0]);
  };
  pc.onconnectionstatechange = () => {
    onConnectionStateChange && onConnectionStateChange(pc.connectionState);
    if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
      if (__metricsTimer) { clearInterval(__metricsTimer); __metricsTimer = null; }
    }
  };
  // start metrics collection automatically
  try { collectMetrics(pc); } catch (_) {}
  return pc;
}

export async function makeOffer(pc) {
  const offer = await pc.createOffer({ offerToReceiveVideo: true });
  await pc.setLocalDescription(offer);
  return offer;
}

export async function makeAnswer(pc, offer) {
  await pc.setRemoteDescription(offer);
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  return answer;
}

export function collectMetrics(peerConnection) {
  // Clear any previous interval
  if (__metricsTimer) { clearInterval(__metricsTimer); __metricsTimer = null; }
  __lastBytesSent = 0; __lastTs = 0;

  __metricsTimer = setInterval(async () => {
    if (!__ws || __ws.readyState !== __ws.OPEN) return;
    try {
      const stats = await peerConnection.getStats(null);
      let outbound = null;
      let remoteInbound = null;
      stats.forEach((s) => {
        if (!outbound && s.type === 'outbound-rtp' && s.kind === 'video' && !s.isRemote) outbound = s;
        if (!remoteInbound && s.type === 'remote-inbound-rtp' && s.kind === 'video') remoteInbound = s;
      });

      let fps = outbound && (outbound.framesPerSecond || outbound.framerateMean);
      if (!fps) fps = 0;

      const now = Date.now();
      let bitrateKbps = 0;
      if (outbound && typeof outbound.bitrateMean === 'number') {
        bitrateKbps = Math.round(outbound.bitrateMean / 1000);
      } else if (outbound && typeof outbound.bytesSent === 'number') {
        if (__lastTs && __lastBytesSent) {
          const deltaBytes = outbound.bytesSent - __lastBytesSent;
          const deltaMs = Math.max(1, now - __lastTs);
          bitrateKbps = Math.round((deltaBytes * 8) / deltaMs);
        }
        __lastBytesSent = outbound.bytesSent;
        __lastTs = now;
      }

      const latencyMs = remoteInbound && typeof remoteInbound.roundTripTime === 'number'
        ? Math.round(remoteInbound.roundTripTime * 1000)
        : 0;

      const payload = {
        type: 'metrics',
        room: __room,
        role: __role,
        timestamp: new Date().toISOString(),
        bitrate: bitrateKbps,
        fps: Math.round(fps),
        latencyMs
      };
      __ws.send(JSON.stringify(payload));
    } catch (_) { /* ignore */ }
  }, 2000);
}


