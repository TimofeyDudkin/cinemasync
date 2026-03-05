// ═══════════════════════════════════════════
//  CinemaSync — сигнальный сервер + раздача файлов
//  Node.js, без зависимостей кроме 'ws'
// ═══════════════════════════════════════════

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;

// ── Комнаты: { roomId: { host: ws, guest: ws } }
const rooms = {};

// ── HTTP сервер — раздаём index.html и статику
const httpServer = http.createServer((req, res) => {
  let filePath = req.url === '/' ? '/index.html' : req.url;
  // Убираем query string
  filePath = filePath.split('?')[0];
  const fullPath = path.join(__dirname, 'public', filePath);

  fs.readFile(fullPath, (err, data) => {
    if (err) {
      // Для SPA — любой 404 отдаём index.html
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

// ── WebSocket сервер
const wss = new WebSocketServer({ server: httpServer });

function send(ws, data) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  ws._roomId = null;
  ws._role   = null; // 'host' | 'guest'

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Хост создаёт комнату
      case 'create': {
        const id = msg.roomId.toUpperCase();
        if (!rooms[id]) rooms[id] = { host: null, guest: null };
        rooms[id].host = ws;
        ws._roomId = id;
        ws._role   = 'host';
        send(ws, { type: 'created', roomId: id });
        console.log(`[+] Room ${id} created`);
        break;
      }

      // ── Гость входит в комнату
      case 'join': {
        const id = msg.roomId.toUpperCase();
        if (!rooms[id] || !rooms[id].host) {
          send(ws, { type: 'error', msg: 'Комната не найдена или хост отключился' });
          return;
        }
        rooms[id].guest = ws;
        ws._roomId = id;
        ws._role   = 'guest';
        // Сообщаем хосту что гость подключился — хост пришлёт offer
        send(rooms[id].host, { type: 'guest-joined' });
        send(ws, { type: 'joined', roomId: id });
        console.log(`[+] Guest joined room ${id}`);
        break;
      }

      // ── WebRTC сигналинг: offer / answer / ice
      case 'offer':
      case 'answer':
      case 'ice': {
        const room = rooms[ws._roomId];
        if (!room) return;
        const target = ws._role === 'host' ? room.guest : room.host;
        send(target, msg);
        break;
      }

      // ── Синхронизация видео + чат + реакции (пробрасываем партнёру)
      case 'sync': {
        const room = rooms[ws._roomId];
        if (!room) return;
        const target = ws._role === 'host' ? room.guest : room.host;
        send(target, msg);
        break;
      }
    }
  });

  ws.on('close', () => {
    const id = ws._roomId;
    if (!id || !rooms[id]) return;
    const room = rooms[id];
    // Уведомляем партнёра
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
  console.log(`   Открыть: http://localhost:${PORT}\n`);
});
