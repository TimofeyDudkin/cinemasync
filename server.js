// ═══════════════════════════════════════════
//  CinemaSync — сервер без ролей (равноправные участники)
// ═══════════════════════════════════════════

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT          = process.env.PORT || 3000;
const PING_INTERVAL = 20000;
const ROOM_TTL      = 15 * 60 * 1000; // 15 минут

const rooms = {};

// ── HTTP
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
  if (ws && ws.readyState === 1) {
    try { ws.send(JSON.stringify(data)); } catch(e) {}
  }
}

function getRoom(id) {
  if (!rooms[id]) {
    rooms[id] = { peers: [], state: null, expireTimer: null };
  }
  if (rooms[id].expireTimer) {
    clearTimeout(rooms[id].expireTimer);
    rooms[id].expireTimer = null;
  }
  return rooms[id];
}

function scheduleRoomExpiry(id) {
  const room = rooms[id];
  if (!room) return;
  if (room.expireTimer) clearTimeout(room.expireTimer);
  room.expireTimer = setTimeout(() => {
    if (!room.peers || room.peers.length === 0) {
      delete rooms[id];
      console.log(`[~] Room ${id} expired`);
    }
  }, ROOM_TTL);
}

function getOther(room, ws) {
  return room.peers.find(p => p !== ws && p.readyState === 1) || null;
}

wss.on('connection', (ws, req) => {
  ws._roomId = null;
  ws._alive  = true;
  ws._ip     = req.socket.remoteAddress;

  ws._pingTimer = setInterval(() => {
    if (!ws._alive) {
      console.log(`[!] WS timeout in room ${ws._roomId}`);
      ws.terminate();
      return;
    }
    ws._alive = false;
    try { ws.ping(); } catch(e) {}
  }, PING_INTERVAL);

  ws.on('pong', () => { ws._alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'join': {
        const id = String(msg.roomId || '').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0, 12);
        if (!id) return;

        const room = getRoom(id);

        // Уже в комнате (переподключение)
        if (ws._roomId === id) return;

        // Убираем старый WS этого участника если был
        room.peers = room.peers.filter(p => p.readyState === 1 && p !== ws);

        if (room.peers.length >= 2) {
          send(ws, { type: 'room-full' });
          return;
        }

        room.peers.push(ws);
        ws._roomId = id;

        const other = getOther(room, ws);

        if (other) {
          // Оба в комнате — сообщаем обоим
          send(ws,    { type: 'joined',      roomId: id, state: room.state, initiator: false });
          send(other, { type: 'peer-joined', roomId: id });
          console.log(`[+] Room ${id}: second peer joined (${ws._ip}) — starting P2P`);
        } else {
          // Первый в комнате — ждёт второго
          send(ws, { type: 'waiting', roomId: id });
          console.log(`[+] Room ${id}: first peer waiting (${ws._ip})`);
        }
        break;
      }

      case 'save-state': {
        const room = rooms[ws._roomId];
        if (room && msg.state) room.state = msg.state;
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms[ws._roomId]; if (!room) return;
        const other = getOther(room, ws);
        send(other, msg);
        break;
      }

      case 'sync':
      case 'relay': {
        const room = rooms[ws._roomId]; if (!room) return;
        const other = getOther(room, ws);
        send(other, msg);
        break;
      }

      case 'relay-mode': {
        const room = rooms[ws._roomId]; if (!room) return;
        const other = getOther(room, ws);
        send(other, msg);
        console.log(`[~] Room ${ws._roomId} -> relay mode`);
        break;
      }

      case 'request-state': {
        const room = rooms[ws._roomId]; if (!room) return;
        const other = getOther(room, ws);
        send(other, { type: 'request-state' });
        break;
      }

      case 'state-response': {
        const room = rooms[ws._roomId]; if (!room) return;
        const other = getOther(room, ws);
        send(other, { type: 'state-response', state: msg.state });
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ws._pingTimer);
    const id = ws._roomId;
    if (!id || !rooms[id]) return;
    const room = rooms[id];

    room.peers = room.peers.filter(p => p !== ws);

    // Уведомляем оставшегося участника
    const other = room.peers.find(p => p.readyState === 1);
    if (other) {
      send(other, { type: 'peer-left' });
    }

    if (room.peers.length === 0) {
      scheduleRoomExpiry(id);
    }

    console.log(`[-] Room ${id}: peer disconnected (${ws._ip}), remaining: ${room.peers.length}`);
  });

  ws.on('error', (e) => console.warn('WS error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CinemaSync on :${PORT}`);
  console.log(`   Room TTL: ${ROOM_TTL/1000}s\n`);
});
