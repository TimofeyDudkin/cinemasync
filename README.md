# 🎬 CinemaSync — Установка на сервер

## Что внутри
```
cinemasync/
  server.js        ← Node.js сервер (WebSocket + раздача файлов)
  package.json
  public/
    index.html     ← Весь фронтенд (один файл)
```

## Требования
- Node.js 16+ 
- npm

---

## Установка на VPS (рекомендуется)

```bash
# 1. Скопируйте папку на сервер (через FTP, scp или git)
scp -r cinemasync/ user@ВАШ_СЕРВЕР:/home/user/

# 2. Зайдите на сервер и установите зависимости
cd cinemasync
npm install

# 3. Запустите
node server.js
# Сервер запустится на порту 3000
```

### Запуск через pm2 (чтобы работал постоянно)
```bash
npm install -g pm2
pm2 start server.js --name cinemasync
pm2 save
pm2 startup
```

### Nginx proxy (для HTTPS и домена)
```nginx
server {
    listen 80;
    server_name ВАШ_ДОМЕН.ru;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        # Важно для WebSocket!
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
    }
}
```

После этого получите SSL через Let's Encrypt:
```bash
certbot --nginx -d ВАШ_ДОМЕН.ru
```

---

## Установка на Render.com (бесплатно, просто)

1. Создайте аккаунт на render.com
2. New → Web Service
3. Загрузите код (через GitHub или ZIP)
4. Build Command: `npm install`
5. Start Command: `node server.js`
6. Готово! Render даст HTTPS-домен автоматически

---

## Установка на Railway.app

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

---

## Переменные окружения
```
PORT=3000   # порт (Render/Railway задают автоматически)
```

---

## Как это работает

```
Пользователь A (хост)          Сервер           Пользователь B (гость)
       │                          │                       │
       │── WS: create room ──────>│                       │
       │<── created ─────────────│                       │
       │                          │<── WS: join room ─────│
       │<── guest-joined ────────│── joined ────────────>│
       │                          │                       │
       │── WebRTC offer ─────────>│──────────────────────>│
       │<── WebRTC answer ───────│<──────────────────────│
       │── ICE candidates ───────>│──────────────────────>│
       │<── ICE candidates ──────│<──────────────────────│
       │                          │                       │
       │◄══════════ P2P WebRTC (видео + данные) ══════════►│
       │                          │                       │
  (сервер больше не нужен для медиа — всё P2P!)
```
