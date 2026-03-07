// ═══════════════════════════════════════════
//  CinemaSync — сервер, все участники равны
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
// rooms[id] = { peers: { [peerId]: { ws, name, color } }, state, expireTimer }

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
    const types = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function broadcast(roomId, data, excludeId) {
  const room = rooms[roomId];
  if (!room) return;
  Object.entries(room.peers).forEach(([pid, p]) => {
    if (pid !== excludeId) send(p.ws, data);
  });
}

function getOrCreateRoom(id) {
  if (!rooms[id]) rooms[id] = { peers: {}, state: null, expireTimer: null };
  if (rooms[id].expireTimer) { clearTimeout(rooms[id].expireTimer); rooms[id].expireTimer = null; }
  return rooms[id];
}

function scheduleExpiry(id) {
  const room = rooms[id];
  if (!room) return;
  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = setTimeout(() => {
    if (Object.keys(room.peers).length === 0) { delete rooms[id]; console.log(`[~] Room ${id} expired`); }
  }, ROOM_TTL);
}

wss.on('connection', (ws) => {
  ws._roomId = null;
  ws._peerId = null;
  ws._alive  = true;

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

      case 'join': {
        const id    = (msg.roomId || '').toUpperCase();
        const name  = msg.name  || 'Участник';
        const color = msg.color || '#60a5fa';
        const room  = getOrCreateRoom(id);

        if (Object.keys(room.peers).length >= MAX_PEERS) {
          send(ws, { type: 'error', msg: `Комната заполнена (макс. ${MAX_PEERS})` });
          return;
        }

        const peerId = msg.peerId || `p_${Math.random().toString(36).slice(2,9)}`;

        // Переподключение: тот же peerId — закрываем старый сокет
        if (room.peers[peerId]) {
          try { room.peers[peerId].ws.terminate(); } catch(e) {}
        }

        room.peers[peerId] = { ws, name, color };
        ws._roomId = id;
        ws._peerId = peerId;

        // Отправляем список всех остальных + сохранённое состояние видео
        const others = Object.entries(room.peers)
          .filter(([pid]) => pid !== peerId)
          .map(([pid, p]) => ({ id: pid, name: p.name, color: p.color }));

        send(ws, { type: 'joined', roomId: id, peerId, peers: others, state: room.state });

        // Оповещаем остальных
        broadcast(id, { type: 'peer-joined', id: peerId, name, color }, peerId);

        console.log(`[+] Room ${id}: "${name}" (${peerId}), total: ${Object.keys(room.peers).length}`);
        break;
      }

      case 'save-state': {
        const room = rooms[ws._roomId];
        if (room) room.state = msg.state;
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms[ws._roomId]; if (!room) return;
        const target = room.peers[msg.to];
        if (target) send(target.ws, { ...msg, from: ws._peerId });
        break;
      }

      case 'sync': {
        const room = rooms[ws._roomId]; if (!room) return;
        broadcast(ws._roomId, { type: 'sync', payload: msg.payload }, ws._peerId);
        break;
      }

      case 'chat': {
        const room = rooms[ws._roomId]; if (!room) return;
        broadcast(ws._roomId, { type: 'chat', text: msg.text, name: msg.name, color: msg.color }, ws._peerId);
        break;
      }

      case 'react': {
        const room = rooms[ws._roomId]; if (!room) return;
        broadcast(ws._roomId, { type: 'react', e: msg.e }, ws._peerId);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ws._pingTimer);
    const id = ws._roomId, peerId = ws._peerId;
    if (!id || !rooms[id] || !peerId) return;
    const room = rooms[id];
    delete room.peers[peerId];
    broadcast(id, { type: 'peer-left', id: peerId });
    if (Object.keys(room.peers).length === 0) scheduleExpiry(id);
    console.log(`[-] Room ${id}: "${peerId}" left, total: ${Object.keys(room.peers).length}`);
  });

  ws.on('error', (e) => console.warn('WS error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CinemaSync on :${PORT}`);
  console.log(`   Max peers: ${MAX_PEERS}, Room TTL: ${ROOM_TTL/1000}s\n`);
});
