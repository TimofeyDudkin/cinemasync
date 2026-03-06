// ═══════════════════════════════════════════
//  CinemaSync — сервер до 8 участников
// ═══════════════════════════════════════════

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT          = process.env.PORT || 3000;
const PING_INTERVAL = 25000;
const ROOM_TTL      = 10 * 60 * 1000;
const MAX_PEERS     = 8;

const rooms = {};
// rooms[id] = {
//   peers: { [peerId]: { ws, name, color, isHost } },
//   hostId: string | null,
//   hostSecret: string | null,
//   state: any,
//   expireTimer: null
// }

const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url.split('?')[0];
  const fullPath = path.join(__dirname, 'public', filePath);
  fs.readFile(fullPath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (e, d) => {
        if (e) { res.writeHead(404); res.end('Not found'); return; }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(d);
      });
      return;
    }
    const types = { '.html':'text/html', '.js':'application/javascript', '.css':'text/css', '.png':'image/png', '.ico':'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getOrCreateRoom(id) {
  if (!rooms[id]) rooms[id] = { peers: {}, hostId: null, hostSecret: null, state: null, expireTimer: null };
  if (rooms[id].expireTimer) { clearTimeout(rooms[id].expireTimer); rooms[id].expireTimer = null; }
  return rooms[id];
}

function scheduleRoomExpiry(id) {
  const room = rooms[id];
  if (!room) return;
  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = setTimeout(() => {
    if (Object.keys(room.peers).length === 0) {
      delete rooms[id];
      console.log(`[~] Room ${id} expired`);
    }
  }, ROOM_TTL);
}

// Отправить всем в комнате, кроме excluded peerId
function broadcast(roomId, data, excludePeerId) {
  const room = rooms[roomId];
  if (!room) return;
  Object.entries(room.peers).forEach(([pid, p]) => {
    if (pid !== excludePeerId) send(p.ws, data);
  });
}

// Список пиров для отправки новому участнику
function peerList(room, excludeId) {
  return Object.entries(room.peers)
    .filter(([id]) => id !== excludeId)
    .map(([id, p]) => ({ id, name: p.name, color: p.color, isHost: p.isHost }));
}

wss.on('connection', (ws) => {
  ws._roomId  = null;
  ws._peerId  = null;
  ws._alive   = true;

  ws._pingTimer = setInterval(() => {
    if (!ws._alive) { ws.terminate(); return; }
    ws._alive = false;
    ws.ping();
  }, PING_INTERVAL);
  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── СОЗДАТЬ КОМНАТУ (стать хостом) ──────────────────────────
      case 'create': {
        const id     = (msg.roomId || '').toUpperCase();
        const secret = msg.secret || '';
        const name   = msg.name   || 'Хост';
        const color  = msg.color  || '#60a5fa';
        const room   = getOrCreateRoom(id);

        if (room.hostSecret && room.hostSecret !== secret) {
          send(ws, { type: 'error', msg: 'Комната уже занята' }); return;
        }

        // Если уже был хост — выгоняем
        if (room.hostId && room.peers[room.hostId] && room.peers[room.hostId].ws !== ws) {
          try { room.peers[room.hostId].ws.terminate(); } catch(e) {}
          delete room.peers[room.hostId];
        }

        const peerId = msg.peerId || `h_${Math.random().toString(36).slice(2,8)}`;
        room.hostSecret = secret || room.hostSecret || Math.random().toString(36).slice(2);
        room.hostId     = peerId;
        room.peers[peerId] = { ws, name, color, isHost: true };
        ws._roomId = id; ws._peerId = peerId;

        send(ws, { type: 'created', roomId: id, peerId, secret: room.hostSecret, state: room.state, peers: peerList(room, peerId) });

        // Оповестить всех остальных о новом хосте
        broadcast(id, { type: 'peer-joined', id: peerId, name, color, isHost: true }, peerId);
        console.log(`[+] Room ${id}: host "${name}" (${peerId})`);
        break;
      }

      // ── ВОЙТИ В КОМНАТУ ──────────────────────────────────────────
      case 'join': {
        const id    = (msg.roomId || '').toUpperCase();
        const name  = msg.name  || 'Участник';
        const color = msg.color || '#a78bfa';
        const room  = getOrCreateRoom(id);

        // Переподключение хоста по секрету
        if (msg.secret && room.hostSecret && msg.secret === room.hostSecret) {
          const peerId = msg.peerId || room.hostId || `h_${Math.random().toString(36).slice(2,8)}`;
          if (room.hostId && room.peers[room.hostId] && room.peers[room.hostId].ws !== ws) {
            try { room.peers[room.hostId].ws.terminate(); } catch(e) {}
            delete room.peers[room.hostId];
          }
          room.hostId = peerId;
          room.peers[peerId] = { ws, name, color, isHost: true };
          ws._roomId = id; ws._peerId = peerId;
          send(ws, { type: 'created', roomId: id, peerId, secret: room.hostSecret, state: room.state, reclaimed: true, peers: peerList(room, peerId) });
          broadcast(id, { type: 'peer-joined', id: peerId, name, color, isHost: true }, peerId);
          console.log(`[+] Room ${id}: host reclaimed by "${name}"`);
          return;
        }

        // Комната переполнена
        if (Object.keys(room.peers).length >= MAX_PEERS) {
          send(ws, { type: 'error', msg: `Комната заполнена (макс. ${MAX_PEERS})` }); return;
        }

        // Нет хоста — ждём
        if (!room.hostId || !room.peers[room.hostId] || room.peers[room.hostId].ws.readyState !== 1) {
          // Ставим временную запись, чтобы не потерять гостя
          const peerId = msg.peerId || `g_${Math.random().toString(36).slice(2,8)}`;
          room.peers[peerId] = { ws, name, color, isHost: false };
          ws._roomId = id; ws._peerId = peerId;
          send(ws, { type: 'waiting-for-host', roomId: id, peerId });
          console.log(`[~] Room ${id}: "${name}" waiting for host`);
          return;
        }

        const peerId = msg.peerId || `g_${Math.random().toString(36).slice(2,8)}`;
        room.peers[peerId] = { ws, name, color, isHost: false };
        ws._roomId = id; ws._peerId = peerId;

        // Новому гостю — список всех текущих пиров + состояние комнаты
        send(ws, { type: 'joined', roomId: id, peerId, state: room.state, peers: peerList(room, peerId) });

        // Всем остальным — новый пир
        broadcast(id, { type: 'peer-joined', id: peerId, name, color, isHost: false }, peerId);

        console.log(`[+] Room ${id}: "${name}" joined (${peerId}), total: ${Object.keys(room.peers).length}`);
        break;
      }

      // ── СОХРАНИТЬ СОСТОЯНИЕ ВИДЕО ────────────────────────────────
      case 'save-state': {
        const room = rooms[ws._roomId];
        if (room && room.hostId === ws._peerId) room.state = msg.state;
        break;
      }

      // ── WebRTC СИГНАЛИНГ (адресный) ──────────────────────────────
      // Клиент указывает msg.to = peerId получателя
      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms[ws._roomId]; if (!room) return;
        const target = room.peers[msg.to];
        if (target) send(target.ws, { ...msg, from: ws._peerId });
        break;
      }

      // ── СИНХРОНИЗАЦИЯ ВИДЕО (от хоста всем / relay) ─────────────
      case 'sync': {
        const room = rooms[ws._roomId]; if (!room) return;
        // Только хост может слать sync
        if (ws._peerId === room.hostId) {
          broadcast(ws._roomId, { type: 'sync', payload: msg.payload }, ws._peerId);
        }
        break;
      }

      // ── ЧАТ (от любого — всем остальным) ────────────────────────
      case 'chat': {
        const room = rooms[ws._roomId]; if (!room) return;
        broadcast(ws._roomId, { type: 'chat', text: msg.text, name: msg.name, color: msg.color, from: ws._peerId }, ws._peerId);
        break;
      }

      // ── РЕАКЦИЯ (от любого — всем остальным) ────────────────────
      case 'react': {
        const room = rooms[ws._roomId]; if (!room) return;
        broadcast(ws._roomId, { type: 'react', e: msg.e }, ws._peerId);
        break;
      }

      // ── RELAY-MODE (фоллбэк без WebRTC) ─────────────────────────
      case 'relay-mode': {
        const room = rooms[ws._roomId]; if (!room) return;
        const target = room.peers[msg.to];
        if (target) send(target.ws, { ...msg, from: ws._peerId });
        console.log(`[~] Room ${ws._roomId} relay-mode`);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ws._pingTimer);
    const id     = ws._roomId;
    const peerId = ws._peerId;
    if (!id || !rooms[id] || !peerId) return;
    const room = rooms[id];

    const wasHost = room.hostId === peerId;
    delete room.peers[peerId];

    if (wasHost) {
      room.hostId = null;
      // Назначаем нового хоста — первый оставшийся пир
      const remaining = Object.keys(room.peers);
      if (remaining.length > 0) {
        const newHostId = remaining[0];
        room.hostId = newHostId;
        room.peers[newHostId].isHost = true;
        // Говорим новому хосту
        send(room.peers[newHostId].ws, { type: 'you-are-host', secret: room.hostSecret });
        // Говорим всем остальным
        broadcast(id, { type: 'new-host', id: newHostId }, newHostId);
        console.log(`[~] Room ${id}: new host "${room.peers[newHostId].name}"`);
      }
    }

    // Оповестить всех об уходе
    broadcast(id, { type: 'peer-left', id: peerId });

    if (Object.keys(room.peers).length === 0) scheduleRoomExpiry(id);
    console.log(`[-] Room ${id}: "${peerId}" left, total: ${Object.keys(room.peers).length}`);
  });

  ws.on('error', (e) => console.warn('WS error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CinemaSync on :${PORT}`);
  console.log(`   Max peers: ${MAX_PEERS}, Reconnect window: ${ROOM_TTL/1000}s\n`);
});
