/**
 * Nebula Chat — Discord-like realtime chat server
 * Zero dependencies: Node 18+ only (http, fs, crypto).
 * Features: text channels, realtime messages (SSE), reactions, typing,
 * voice channel presence + WebRTC signaling relay, JSON persistence.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */
let db = {
  seq: 1000,
  channels: [],
  messages: {},        // channelId -> [msg]
  voice: {},           // channelId -> [{id, name, muted}]
  reactionsSeq: 0,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

const now = () => Date.now();
const MIN = 60 * 1000;

function seed() {
  const general = { id: 'c-general', name: 'общий', type: 'text', topic: 'Главный канал — общаемся обо всём' };
  const news = { id: 'c-news', name: 'анонсы', type: 'text', topic: 'Новости сервера' };
  const memes = { id: 'c-memes', name: 'мемы', type: 'text', topic: 'Смешное сюда' };
  const help = { id: 'c-help', name: 'помощь', type: 'text', topic: 'Задай вопрос — поможем' };
  const voice1 = { id: 'v-general', name: 'Общий голосовой', type: 'voice' };
  const voice2 = { id: 'v-gaming', name: 'Игровая комната', type: 'voice' };

  db.channels = [general, news, memes, help, voice1, voice2];
  db.messages = {
    'c-general': [
      m('c-general', { id: 'u-bot', name: 'Nebula' }, 'Добро пожаловать в **Nebula**! 🌌\nЭто демо-сервер: пиши сообщения, создавай каналы, ставь реакции и заходи в голосовые комнаты.\nКоманды бота: `!help`, `!roll`, `!ping`', now() - 62 * MIN, { bot: true }),
      m('c-general', { id: 'u-alisa', name: 'Алиса' }, 'Привет всем 👋', now() - 51 * MIN),
      m('c-general', { id: 'u-max', name: 'Максим' }, 'о, новый сервер? выглядит огонь 🔥', now() - 48 * MIN),
      m('c-general', { id: 'u-nikita', name: 'Nikita' }, 'кто в голосовой?', now() - 40 * MIN),
      m('c-general', { id: 'u-alisa', name: 'Алиса' }, 'го через 5 минут, я как раз кофе налью', now() - 39 * MIN),
      m('c-general', { id: 'u-sonya', name: 'Sonya' }, 'у меня микрофон сломался, буду просто слушать 🎧', now() - 33 * MIN),
      m('c-general', { id: 'u-kirill', name: 'Кирилл' }, 'нашёл идеальный мем, закинул в <#c-memes> 😂', now() - 12 * MIN),
    ],
    'c-news': [
      m('c-news', { id: 'u-bot', name: 'Nebula' }, 'Здесь будут анонсы обновлений сервера ✨', now() - 3 * 24 * 60 * MIN, { bot: true }),
    ],
    'c-memes': [
      m('c-memes', { id: 'u-kirill', name: 'Кирилл' }, 'когда починил баг и не знаешь почему оно работает', now() - 26 * MIN),
      m('c-memes', { id: 'u-alisa', name: 'Алиса' }, 'классика 😹', now() - 24 * MIN),
    ],
    'c-help': [
      m('c-help', { id: 'u-bot', name: 'Nebula' }, 'Напиши `!help` в любом канале, чтобы увидеть команды бота.', now() - 2 * 24 * 60 * MIN, { bot: true }),
    ],
  };
  save();
}

function m(channel, user, text, ts, extra = {}) {
  return Object.assign({
    id: 'm-' + (++db.seq),
    channel,
    author: user.id,
    authorName: user.name,
    text,
    ts,
    reactions: {},
  }, extra);
}

function load() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.channels) && parsed.channels.length) {
      db = Object.assign(db, parsed);
      return;
    }
  } catch (_) { /* no file — seed */ }
  seed();
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error('save failed', e.message); }
  }, 300);
}

function nextId(prefix) { return prefix + (++db.seq); }

/* ------------------------------------------------------------------ */
/* SSE clients                                                          */
/* ------------------------------------------------------------------ */
const clients = new Set(); // {res, id, name}

function sseWrite(res, obj) {
  try { res.write('data: ' + JSON.stringify(obj) + '\n\n'); } catch (_) {}
}

function broadcast(obj, filter) {
  for (const c of clients) {
    if (filter && !filter(c)) continue;
    sseWrite(c.res, obj);
  }
}

function presenceSnapshot() {
  const seen = new Map();
  for (const c of clients) {
    if (c.id) seen.set(c.id, c.name);
  }
  const online = [...seen.entries()].map(([id, name]) => ({ id, name }));
  return { type: 'presence', online, count: online.length };
}

function broadcastPresence() { broadcast(presenceSnapshot()); }

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */
function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  });
  res.end(body);
}

function readBody(req, cb) {
  let raw = '';
  let size = 0;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > 1024 * 512) { req.destroy(); return; }
    raw += chunk;
  });
  req.on('end', () => {
    try {
      cb(null, raw ? JSON.parse(raw) : {});
    } catch (e) {
      cb(e);
    }
  });
}

function sanitizeName(name) {
  return String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 32) || 'Гость';
}

function channelName(name) {
  return String(name || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-zа-яё0-9-_]/gi, '').slice(0, 32);
}

/* ------------------------------------------------------------------ */
/* Bot                                                                  */
/* ------------------------------------------------------------------ */
function botReply(channelId, text) {
  const cmd = text.trim().toLowerCase();
  let reply = null;
  if (cmd === '!help') {
    reply = '**Команды Nebula**\n`!help` — это сообщение\n`!roll` — случайное число от 1 до 100\n`!ping` — проверить, что бот жив\n\nКстати, каналы можно создавать кнопкой **+** рядом с категорией.';
  } else if (cmd === '!roll' || cmd === '!roll ') {
    reply = '🎲 Выпало: **' + (1 + Math.floor(Math.random() * 100)) + '**';
  } else if (cmd === '!ping') {
    reply = '🏓 Понг! Бот на связи.';
  }
  if (!reply) return;

  setTimeout(() => {
    const user = { id: 'u-bot', name: 'Nebula' };
    const msg = m(channelId, user, reply, now(), { bot: true });
    (db.messages[channelId] = db.messages[channelId] || []).push(msg);
    save();
    broadcast({ type: 'message', message: msg });
  }, 700);
}

/* ------------------------------------------------------------------ */
/* Voice state                                                          */
/* ------------------------------------------------------------------ */
function voiceList(channelId) {
  return db.voice[channelId] || [];
}

function leaveVoice(id) {
  for (const ch of Object.keys(db.voice)) {
    const list = db.voice[ch];
    const idx = list.findIndex((p) => p.id === id);
    if (idx !== -1) {
      const [removed] = list.splice(idx, 1);
      broadcast({ type: 'voice-leave', channel: ch, user: removed });
    }
    if (!list.length) delete db.voice[ch];
  }
}

/* ------------------------------------------------------------------ */
/* HTTP server                                                          */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = decodeURIComponent(url.pathname);

  /* ---- CORS preflight (keeps preview embeds working) ---- */
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
    });
    return res.end();
  }

  /* ---- SSE ---- */
  if (pathname === '/api/events') {
    const id = String(url.searchParams.get('id') || '');
    const name = sanitizeName(url.searchParams.get('name') || 'Гость');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*',
    });
    res.write('retry: 3000\n\n');
    const client = { res, id, name };
    clients.add(client);
    sseWrite(res, presenceSnapshot());
    broadcastPresence();
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 25000);
    req.on('close', () => {
      clearInterval(ping);
      clients.delete(client);
      leaveVoice(client.id);
      broadcastPresence();
    });
    return;
  }

  /* ---- API ---- */
  if (pathname.startsWith('/api/')) {
    if (req.method === 'GET' && pathname === '/api/state') {
      return sendJSON(res, 200, {
        channels: db.channels,
        messages: db.messages,
        voice: db.voice,
      });
    }

    if (req.method === 'GET' && pathname === '/api/messages') {
      const channel = url.searchParams.get('channel');
      return sendJSON(res, 200, { messages: db.messages[channel] || [] });
    }

    if (req.method === 'POST' && pathname === '/api/messages') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const channelId = String(body.channel || '');
        const user = { id: String(body.userId || ''), name: sanitizeName(body.userName) };
        const text = String(body.text || '').slice(0, 2000).trim();
        if (!channelId || !text || !user.id) return sendJSON(res, 400, { error: 'invalid' });
        if (!db.messages[channelId]) db.messages[channelId] = [];

        const msg = m(channelId, user, text, now());
        db.messages[channelId].push(msg);
        // keep channel history bounded
        if (db.messages[channelId].length > 300) db.messages[channelId].splice(0, db.messages[channelId].length - 300);
        save();
        broadcast({ type: 'message', message: msg });
        if (text.startsWith('!')) botReply(channelId, text);
        sendJSON(res, 200, { ok: true, message: msg });
      });
    }

    const delMatch = pathname.match(/^\/api\/messages\/([^/]+)$/);
    if (req.method === 'DELETE' && delMatch) {
      const id = delMatch[1];
      for (const ch of Object.keys(db.messages)) {
        const idx = db.messages[ch].findIndex((x) => x.id === id);
        if (idx !== -1) {
          db.messages[ch].splice(idx, 1);
          save();
          broadcast({ type: 'message-delete', id, channel: ch });
          return sendJSON(res, 200, { ok: true });
        }
      }
      return sendJSON(res, 404, { error: 'not found' });
    }

    if (req.method === 'POST' && pathname === '/api/react') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const { id, emoji, userId } = body;
        if (!id || !emoji || !userId) return sendJSON(res, 400, { error: 'invalid' });
        for (const ch of Object.keys(db.messages)) {
          const msg = db.messages[ch].find((x) => x.id === id);
          if (msg) {
            msg.reactions = msg.reactions || {};
            const list = msg.reactions[emoji] || [];
            const idx = list.indexOf(userId);
            if (idx === -1) list.push(userId); else list.splice(idx, 1);
            if (list.length) msg.reactions[emoji] = list; else delete msg.reactions[emoji];
            save();
            broadcast({ type: 'reaction', id, channel: ch, reactions: msg.reactions });
            return sendJSON(res, 200, { ok: true, reactions: msg.reactions });
          }
        }
        sendJSON(res, 404, { error: 'not found' });
      });
    }

    if (req.method === 'POST' && pathname === '/api/typing') {
      return readBody(req, (err, body) => {
        if (err) return;
        const { channel, userId, userName } = body;
        if (!channel || !userId) return sendJSON(res, 400, { error: 'invalid' });
        broadcast({ type: 'typing', channel, userId, userName: sanitizeName(userName), ts: now() });
        sendJSON(res, 200, { ok: true });
      });
    }

    if (req.method === 'POST' && pathname === '/api/channels') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const name = channelName(body.name);
        if (!name) return sendJSON(res, 400, { error: 'bad name' });
        const channel = { id: nextId('c-'), name, type: 'text', topic: 'Новый канал' };
        db.channels.push(channel);
        db.messages[channel.id] = [];
        save();
        broadcast({ type: 'channel-create', channel });
        sendJSON(res, 200, { ok: true, channel });
      });
    }

    /* ---- Voice / WebRTC signaling ---- */
    if (req.method === 'POST' && pathname === '/api/voice/join') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const { channel, id, name } = body;
        if (!channel || !id) return sendJSON(res, 400, { error: 'invalid' });
        const list = (db.voice[channel] = db.voice[channel] || []);
        const peers = list.filter((p) => p.id !== id);
        if (!list.some((p) => p.id === id)) list.push({ id, name: sanitizeName(name), muted: false, sharing: false });
        const me = list.find((p) => p.id === id);
        broadcast({ type: 'voice-join', channel, user: me, peers });
        sendJSON(res, 200, { ok: true, peers });
      });
    }

    if (req.method === 'POST' && pathname === '/api/voice/leave') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        leaveVoice(body.id);
        save();
        sendJSON(res, 200, { ok: true });
      });
    }

    if (req.method === 'POST' && pathname === '/api/voice/mute') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const { channel, id, muted } = body;
        const list = db.voice[channel] || [];
        const p = list.find((x) => x.id === id);
        if (p) { p.muted = !!muted; broadcast({ type: 'voice-mute', channel, id, muted: p.muted }); }
        sendJSON(res, 200, { ok: true });
      });
    }

    if (req.method === 'POST' && pathname === '/api/voice/share') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const { channel, id, sharing } = body;
        const list = db.voice[channel] || [];
        const p = list.find((x) => x.id === id);
        if (p) p.sharing = !!sharing;
        broadcast({ type: 'voice-share', channel, id, sharing: !!sharing });
        save();
        sendJSON(res, 200, { ok: true });
      });
    }

    if (req.method === 'POST' && pathname === '/api/voice/signal') {
      return readBody(req, (err, body) => {
        if (err) return sendJSON(res, 400, { error: 'bad json' });
        const { channel, from, to, data } = body;
        if (!to) return sendJSON(res, 400, { error: 'invalid' });
        broadcast({ type: 'signal', channel, from, to, data }, (c) => c.id === to);
        sendJSON(res, 200, { ok: true });
      });
    }

    return sendJSON(res, 404, { error: 'not found' });
  }

  /* ---- Static files ---- */
  let filePath = pathname === '/' ? '/index.html' : pathname;
  filePath = path.normalize(filePath).replace(/^(\.\.[/\\])+/, '');
  const abs = path.join(PUBLIC_DIR, filePath);
  if (!abs.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('Forbidden');
  }
  fs.readFile(abs, (err, data) => {
    if (err) {
      // SPA-ish fallback
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, html) => {
        if (e2) { res.writeHead(404); return res.end('Not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(html);
      });
      return;
    }
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    });
    res.end(data);
  });
});

load();
server.listen(PORT, '0.0.0.0', () => {
  console.log('Nebula Chat running on http://0.0.0.0:' + PORT);
});
