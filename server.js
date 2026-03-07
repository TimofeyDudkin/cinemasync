// ═══════════════════════════════════════════
//  CinemaSync — сервер с поддержкой переподключения
// ═══════════════════════════════════════════

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT          = process.env.PORT || 3000;
const PING_INTERVAL = 25000;
const ROOM_TTL      = 10 * 60 * 1000; // комната живёт 10 минут после ухода хоста

const rooms = {};
// rooms[id] = { host: ws|null, guest: ws|null, hostSecret: str, state: {...}, expireTimer: null }

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
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

function getOrCreateRoom(id) {
  if (!rooms[id]) rooms[id] = { host: null, guest: null, hostSecret: null, state: null, expireTimer: null };
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
    if (!room.host && !room.guest) {
      delete rooms[id];
      console.log(`[~] Room ${id} expired`);
    }
  }, ROOM_TTL);
}

wss.on('connection', (ws) => {
  ws._roomId = null;
  ws._role   = null;
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

      case 'create': {
        const id = msg.roomId.toUpperCase();
        const secret = msg.secret || '';
        const room = getOrCreateRoom(id);

        // Если комната уже существует и у неё есть секрет — проверяем
        if (room.hostSecret && room.hostSecret !== secret) {
          send(ws, { type: 'error', msg: 'Комната уже занята' });
          return;
        }

        // Закрываем старое соединение хоста если есть
        if (room.host && room.host !== ws) {
          try { room.host.terminate(); } catch(e) {}
        }

        room.host = ws;
        room.hostSecret = secret || room.hostSecret || Math.random().toString(36).slice(2);
        ws._roomId = id; ws._role = 'host';

        send(ws, { type: 'created', roomId: id, state: room.state, secret: room.hostSecret });

        if (room.guest && room.guest.readyState === 1) {
          send(room.guest, { type: 'host-reconnected' });
          send(ws, { type: 'guest-joined' });
        }
        console.log(`[+] Room ${id} host connected`);
        break;
      }

      case 'join': {
        const id = msg.roomId.toUpperCase();
        const room = getOrCreateRoom(id);

        // Попытка переподключиться как хост с секретом
        if (msg.secret && room.hostSecret && msg.secret === room.hostSecret) {
          if (room.host && room.host !== ws) {
            try { room.host.terminate(); } catch(e) {}
          }
          room.host = ws;
          ws._roomId = id; ws._role = 'host';
          send(ws, { type: 'created', roomId: id, state: room.state, secret: room.hostSecret, reclaimed: true });
          if (room.guest && room.guest.readyState === 1) {
            send(room.guest, { type: 'host-reconnected' });
            send(ws, { type: 'guest-joined' });
          }
          console.log(`[+] Room ${id}: host reclaimed`);
          return;
        }

        if (!room.host || room.host.readyState !== 1) {
          room.guest = ws;
          ws._roomId = id; ws._role = 'guest';
          send(ws, { type: 'waiting-for-host', roomId: id });
          console.log(`[~] Room ${id}: guest waiting for host`);
          return;
        }

        // Закрываем старого гостя
        if (room.guest && room.guest !== ws && room.guest.readyState === 1) {
          try { room.guest.terminate(); } catch(e) {}
        }

        room.guest = ws;
        ws._roomId = id; ws._role = 'guest';
        send(room.host, { type: 'guest-joined' });
        send(ws, { type: 'joined', roomId: id, state: room.state });
        console.log(`[+] Room ${id}: guest joined`);
        break;
      }

      case 'save-state': {
        const room = rooms[ws._roomId];
        if (room && ws._role === 'host') room.state = msg.state;
        break;
      }

      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms[ws._roomId]; if (!room) return;
        const target = ws._role === 'host' ? room.guest : room.host;
        send(target, msg);
        break;
      }

      case 'sync':
      case 'relay-mode': {
        const room = rooms[ws._roomId]; if (!room) return;
        const target = ws._role === 'host' ? room.guest : room.host;
        send(target, msg);
        if (msg.type === 'relay-mode') console.log(`[~] Room ${ws._roomId} -> relay mode`);
        break;
      }
    }
  });

  ws.on('close', () => {
    clearInterval(ws._pingTimer);
    const id = ws._roomId;
    if (!id || !rooms[id]) return;
    const room = rooms[id];

    if (ws._role === 'host') {
      room.host = null;
      if (room.guest && room.guest.readyState === 1) {
        send(room.guest, { type: 'host-disconnected' });
      }
      scheduleRoomExpiry(id);
      console.log(`[-] Room ${id}: host disconnected (room preserved ${ROOM_TTL/1000}s)`);
    } else {
      room.guest = null;
      if (room.host && room.host.readyState === 1) {
        send(room.host, { type: 'peer-left' });
      }
      scheduleRoomExpiry(id);
      console.log(`[-] Room ${id}: guest disconnected`);
    }
  });

  ws.on('error', (e) => console.warn('WS error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CinemaSync on :${PORT}`);
  console.log(`   Reconnect window: ${ROOM_TTL/1000}s\n`);
});
