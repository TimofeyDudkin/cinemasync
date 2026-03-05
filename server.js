// ═══════════════════════════════════════════
//  CinemaSync — сигнальный сервер + relay fallback
// ═══════════════════════════════════════════

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PING_INTERVAL = 25000;

const rooms = {};

const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  filePath = filePath.split('?')[0];
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
    const ext = path.extname(filePath);
    const types = { '.html':'text/html','.js':'application/javascript','.css':'text/css','.png':'image/png','.ico':'image/x-icon' };
    res.writeHead(200, { 'Content-Type': types[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server: httpServer });

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
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
        if (!rooms[id]) rooms[id] = { host: null, guest: null };
        rooms[id].host = ws;
        ws._roomId = id; ws._role = 'host';
        send(ws, { type: 'created', roomId: id });
        console.log(`[+] Room ${id} created`);
        break;
      }
      case 'join': {
        const id = msg.roomId.toUpperCase();
        if (!rooms[id] || !rooms[id].host) {
          send(ws, { type: 'error', msg: 'Комната не найдена или хост отключился' });
          return;
        }
        rooms[id].guest = ws;
        ws._roomId = id; ws._role = 'guest';
        send(rooms[id].host, { type: 'guest-joined' });
        send(ws, { type: 'joined', roomId: id });
        console.log(`[+] Guest joined room ${id}`);
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
      // relay: пробрасываем sync-сообщения через сервер (fallback когда P2P не работает)
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
      send(room.guest, { type: 'peer-left' });
      delete rooms[id];
      console.log(`[-] Room ${id} closed (host left)`);
    } else {
      send(room.host, { type: 'peer-left' });
      room.guest = null;
      console.log(`[-] Guest left room ${id}`);
    }
  });

  ws.on('error', (e) => console.warn('WS error:', e.message));
});

httpServer.listen(PORT, () => {
  console.log(`\n🎬 CinemaSync запущен на порту ${PORT}`);
  console.log(`   http://localhost:${PORT}`);
  console.log(`   Relay fallback: ✓  Keepalive: ✓\n`);
});
