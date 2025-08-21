// Minimal WebSocket signaling server for local dev
// Rooms: { roomId -> { viewerSocket?, phoneSocket? } }

import { WebSocketServer } from 'ws';
import { promises as fs } from 'fs';
import path from 'path';

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

/** @type {Map<string, { viewer?: WebSocket, phone?: WebSocket }>} */
const rooms = new Map();

function getOrCreateRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, {});
  return rooms.get(roomId);
}

function otherRole(role) {
  return role === 'viewer' ? 'phone' : 'viewer';
}

function send(ws, obj) {
  try { ws && ws.readyState === ws.OPEN && ws.send(JSON.stringify(obj)); } catch (_) {}
}

wss.on('connection', (ws) => {
  let roomId = null;
  let role = null; // 'viewer' | 'phone'

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(String(data)); } catch {
      return;
    }

    const { type } = msg;
    if (type === 'create') {
      roomId = String(msg.room || '').trim();
      if (!roomId) return;
      const room = getOrCreateRoom(roomId);
      room.viewer = ws;
      role = 'viewer';
      console.log(`[viewer] created room ${roomId}`);
      send(ws, { type: 'created', room: roomId });
      return;
    }
    if (type === 'join') {
      roomId = String(msg.room || '').trim();
      if (!roomId) return;
      const room = getOrCreateRoom(roomId);
      room.phone = ws;
      role = 'phone';
      console.log(`[phone] joined room ${roomId}`);
      send(ws, { type: 'joined', room: roomId });
      if (room.viewer) send(room.viewer, { type: 'peer_joined', room: roomId });
      return;
    }

    // Metrics: append sample to metrics.json in project root
    if (type === 'metrics') {
      (async () => {
        try {
          const root = process.cwd();
          const outPath = path.join(root, 'metrics.json');
          const entry = {
            timestamp: new Date().toISOString(),
            bitrate: msg.bitrate ?? 0,
            fps: msg.fps ?? 0,
            latencyMs: msg.latencyMs ?? 0,
            room: msg.room,
            role: msg.role
          };
          let arr = [];
          try {
            const prev = await fs.readFile(outPath, 'utf8');
            arr = JSON.parse(prev);
            if (!Array.isArray(arr)) arr = [];
          } catch (_) { /* file may not exist */ }
          arr.push(entry);
          await fs.writeFile(outPath, JSON.stringify(arr, null, 2));
        } catch (e) {
          // ignore FS errors in local dev
        }
      })();
      return;
    }

    // Relay offer/answer/ice to the opposite role in the room
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    const peer = room[otherRole(role)];
    if (!peer) return;
    if (type === 'offer' || type === 'answer' || type === 'ice') {
      send(peer, msg);
    }
  });

  ws.on('close', () => {
    if (!roomId) return;
    const room = rooms.get(roomId);
    if (!room) return;
    if (role === 'viewer' && room.viewer === ws) room.viewer = undefined;
    if (role === 'phone' && room.phone === ws) room.phone = undefined;
    const peer = room[otherRole(role)];
    if (peer) send(peer, { type: 'peer_left', room: roomId, role });
    if (!room.viewer && !room.phone) rooms.delete(roomId);
    console.log(`[${role}] left room ${roomId}`);
  });
});

console.log(`Signaling server listening on ws://localhost:${PORT}`);


