/* ============================================================
   Nebula Chat — client
   ============================================================ */
'use strict';

/* ---------------- safe storage (sandboxed iframes may block LS) ---------------- */
const store = (() => {
  const mem = {};
  return {
    get(k) { try { return localStorage.getItem(k); } catch (_) { return mem[k] ?? null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (_) { mem[k] = v; } },
  };
})();

/* ---------------- identity ---------------- */
function uuid() {
  try { return crypto.randomUUID(); } catch (_) {
    return 'u-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
  }
}

const me = {
  id: store.get('nebula_id') || uuid(),
  name: store.get('nebula_name') || '',
  tag: '',
};
store.set('nebula_id', me.id);

function hashInt(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
  return Math.abs(h);
}
me.tag = '#' + String(hashInt(me.id) % 10000).padStart(4, '0');

/* ---------------- seed members (demo) ---------------- */
const SEED_MEMBERS = [
  { id: 'u-bot', name: 'Nebula', role: 'bot', status: 'online', activity: 'Демо-бот' },
  { id: 'u-nikita', name: 'Nikita', role: 'admin', status: 'online', activity: 'Смотрит Nebula' },
  { id: 'u-max', name: 'Максим', role: 'mod', status: 'online', activity: 'Играет в Minecraft' },
  { id: 'u-alisa', name: 'Алиса', role: 'member', status: 'online', activity: 'Слушает lo-fi' },
  { id: 'u-kirill', name: 'Кирилл', role: 'member', status: 'dnd', activity: 'Печатает код' },
  { id: 'u-sonya', name: 'Sonya', role: 'member', status: 'idle', activity: 'Отошла' },
  { id: 'u-vlad', name: 'Влад', role: 'member', status: 'offline', activity: '' },
];
const SEED_MAP = new Map(SEED_MEMBERS.map((m) => [m.id, m]));

/* ---------------- state ---------------- */
const state = {
  channels: [],
  messages: {},       // channel -> []
  voice: {},          // channel -> [{id,name,muted}]
  online: [],         // real connected users
  current: null,
  unread: {},
  search: '',
  typing: new Map(),  // userId -> {name, ts}
};

/* ---------------- elements ---------------- */
const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  login: $('loginScreen'),
  loginForm: $('loginForm'),
  loginName: $('loginName'),
  channelsScroll: $('channelsScroll'),
  messages: $('messages'),
  chatName: $('chatName'),
  chatTopic: $('chatTopic'),
  composer: $('composerInput'),
  sendBtn: $('sendBtn'),
  emojiBtn: $('emojiBtn'),
  emojiPicker: $('emojiPicker'),
  typing: $('typingBar'),
  members: $('membersPanel'),
  membersToggle: $('membersToggle'),
  myAvatar: $('myAvatar'),
  myInitial: $('myInitial'),
  myName: $('myName'),
  myTag: $('myTag'),
  voicePanel: $('voicePanel'),
  voiceStatusSub: $('voiceStatusSub'),
  voiceToggleMic: $('voiceToggleMic'),
  voiceToggleDeaf: $('voiceToggleDeaf'),
  voiceDisconnect: $('voiceDisconnect'),
  modalOverlay: $('modalOverlay'),
  modalForm: $('modalForm'),
  modalTitle: $('modalTitle'),
  modalSub: $('modalSub'),
  modalLabel: $('modalLabel'),
  modalInput: $('modalInput'),
  modalHash: $('modalHash'),
  modalSubmit: $('modalSubmit'),
  modalCancel: $('modalCancel'),
  toasts: $('toasts'),
  searchBtn: $('searchBtn'),
  searchBox: $('searchBox'),
  searchInput: $('searchInput'),
  remoteAudios: $('remoteAudios'),
  screenStage: $('screenStage'),
  voiceToggleShare: $('voiceToggleShare'),
};

/* ---------------- utils ---------------- */
const escapeHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
const msgTime = (ts) => timeFmt.format(new Date(ts));

function dayKey(ts) { const d = new Date(ts); return d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate(); }

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Сегодня';
  if (dayKey(ts) === dayKey(yest.getTime())) return 'Вчера';
  return dateFmt.format(d);
}

function avatarColor(id) {
  if (id === 'u-bot') return 'linear-gradient(135deg,#5865f2,#9b59f2)';
  const h = hashInt(id) % 360;
  return `linear-gradient(135deg, hsl(${h} 62% 56%), hsl(${(h + 40) % 360} 62% 44%))`;
}

function avatarHtml(id, name, size) {
  const initial = escapeHtml((name || '?').trim().charAt(0).toUpperCase() || '?');
  const cls = size === 32 ? 'avatar avatar-32' : size === 24 ? 'avatar avatar-24' : 'avatar avatar-40';
  const dot = size === 40 ? '' : '';
  return `<div class="${cls}" style="background:${avatarColor(id)}"><span class="avatar-initial">${initial}</span>${dot}</div>`;
}

function roleOf(member) {
  if (!member) return 'member';
  return member.role || 'member';
}

function memberById(id) {
  return SEED_MAP.get(id) || state.online.find((u) => u.id === id) || null;
}

/* ---------------- markdown-lite ---------------- */
function formatText(text) {
  const codes = [];
  let s = escapeHtml(text);

  s = s.replace(/```([\s\S]*?)```/g, (_, c) => {
    codes.push('<code class="code-block">' + c.replace(/^\n+|\n+$/g, '') + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push('<code>' + c + '</code>');
    return '\u0000' + (codes.length - 1) + '\u0000';
  });

  s = s.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1<i>$2</i>');
  s = s.replace(/~~([^~]+)~~/g, '<s>$1</s>');

  /* http links */
  s = s.replace(/https?:\/\/[^\s<]+/g, (url) =>
    `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);

  /* channel links <#id> */
  s = s.replace(/&lt;#([\w-]+)&gt;/g, (_, id) => {
    const ch = state.channels.find((c) => c.id === id);
    return ch ? `<span class="channel-link" data-channel="${ch.id}">#${escapeHtml(ch.name)}</span>` : '#' + id;
  });

  /* mentions */
  s = s.replace(/(^|[\s(])@([\p{L}\p{N}_.-]{1,32})/gu, (all, pre, name) => {
    if (name === 'everyone' || name === 'here') return `${pre}<span class="mention">@${name}</span>`;
    const known = [...SEED_MEMBERS, ...state.online].some((u) => u.name.toLowerCase() === name.toLowerCase());
    return known ? `${pre}<span class="mention">@${name}</span>` : all;
  });

  s = s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[+i]);
  return s;
}

const EMOJI_ONLY = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|\uFE0F|\u200D|\s){1,12}$/u;
function isEmojiOnly(text) {
  const t = text.trim();
  if (!t) return false;
  try { return EMOJI_ONLY.test(t) && /\p{Extended_Pictographic}/u.test(t); } catch (_) { return false; }
}

/* ---------------- toasts ---------------- */
function toast(msg, ms = 3200) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = msg;
  els.toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add('out');
    setTimeout(() => el.remove(), 220);
  }, ms);
}

/* ---------------- API ---------------- */
async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

async function apiGet(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

/* ============================================================
   RENDER: channels
   ============================================================ */
function hashIcon() {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M9.2 3.1a1 1 0 0 1 1.1.9l.5 4h3.4l-.4-3.6a1 1 0 1 1 2-.2l.4 3.8h2.2a1 1 0 1 1 0 2h-2l.5 4h2.2a1 1 0 1 1 0 2H16.6l.4 3.6a1 1 0 0 1-2 .2l-.4-3.8h-3.4l.4 3.6a1 1 0 0 1-2 .2l-.4-3.8H7.2a1 1 0 1 1 0-2h2l-.5-4H6.5a1 1 0 1 1 0-2h2l-.4-3.8a1 1 0 0 1 .9-1.1.9.9 0 0 1 .2 0zM11.3 10l-.5 4h3.4l.5-4z"/></svg>';
}
function speakerIcon() {
  return '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 5 6 9H3v6h3l5 4z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/></svg>';
}
function plusIcon() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
}
function chevronIcon() {
  return '<svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor"><path d="m5 8 7 7 7-7z"/></svg>';
}
function screenIcon() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>';
}
function micOffIcon() {
  return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 2l20 20"/><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10a7 7 0 0 0 11 5.6"/><path d="M12 17v4"/></svg>';
}

function renderChannels() {
  const textChannels = state.channels.filter((c) => c.type === 'text');
  const voiceChannels = state.channels.filter((c) => c.type === 'voice');

  let html = '';

  html += `<div class="category">
    <span class="category-name">Текстовые каналы</span>
    <button class="category-add" data-action="new-channel" title="Создать канал">${plusIcon()}</button>
  </div>`;

  for (const ch of textChannels) {
    const unread = state.unread[ch.id] || 0;
    html += `<div class="channel ${state.current === ch.id ? 'active' : ''} ${unread ? 'unread' : ''}" data-channel="${ch.id}">
      ${hashIcon()}
      <span class="channel-label">${escapeHtml(ch.name)}</span>
      ${unread ? `<span class="channel-badge">${unread > 9 ? '9+' : unread}</span>` : ''}
    </div>`;
  }

  html += `<div class="category">
    <span class="category-name">Голосовые каналы</span>
    <button class="category-add" data-action="new-voice" title="Создать канал">${plusIcon()}</button>
  </div>`;

  for (const ch of voiceChannels) {
    const connected = rtc.current === ch.id;
    html += `<div class="channel ${connected ? 'active' : ''}" data-voice="${ch.id}" title="${connected ? 'Нажмите, чтобы отключиться' : 'Подключиться к голосовому каналу'}">
      ${speakerIcon()}
      <span class="channel-label">${escapeHtml(ch.name)}</span>
    </div>`;

    const members = state.voice[ch.id] || [];
    if (members.length) {
      html += '<div class="voice-members">';
      for (const p of members) {
        html += `<div class="voice-member">
          ${avatarHtml(p.id, p.name, 24)}
          <span class="vm-name" style="color:${p.id === me.id ? '#fff' : ''}">${escapeHtml(p.name)}${p.id === me.id ? ' (вы)' : ''}</span>
          <span class="vm-icons">
            ${p.sharing ? `<span class="sharing-ic" title="Демонстрирует экран">${screenIcon()}</span>` : ''}
            ${p.muted ? `<span class="muted-ic" title="Микрофон выключен">${micOffIcon()}</span>` : ''}
          </span>
        </div>`;
      }
      html += '</div>';
    }
  }

  els.channelsScroll.innerHTML = html;
}

/* ============================================================
   RENDER: messages
   ============================================================ */
function channelById(id) { return state.channels.find((c) => c.id === id); }

function messageHtml(msg, prev, opts) {
  const isMine = msg.author === me.id;
  const member = memberById(msg.author);
  const role = msg.bot ? 'bot' : roleOf(member);
  const roleClass = role === 'admin' ? 'admin' : role === 'mod' ? 'mod' : '';
  const name = msg.authorName || (member && member.name) || 'Гость';

  const grouped = prev &&
    prev.author === msg.author &&
    msg.ts - prev.ts < 5 * 60 * 1000 &&
    dayKey(prev.ts) === dayKey(msg.ts) &&
    !opts?.searching;

  const ts = msgTime(msg.ts);
  const fullDate = new Date(msg.ts).toLocaleString('ru-RU');

  const toolbar = `<div class="msg-toolbar">
    <button data-react="😂" title="Смешно">😂</button>
    <button data-react="❤️" title="Нравится">❤️</button>
    <button data-react="👍" title="Согласен">👍</button>
    ${isMine ? '<button data-del="' + msg.id + '" class="danger" title="Удалить">' + trashIcon() + '</button>' : ''}
  </div>`;

  const reactions = msg.reactions && Object.keys(msg.reactions).length
    ? `<div class="reactions">${Object.entries(msg.reactions).map(([emoji, users]) => {
        const mine = users.includes(me.id);
        return `<span class="reaction ${mine ? 'mine' : ''}" data-react-msg="${msg.id}" data-emoji="${escapeHtml(emoji)}" title="${escapeHtml(users.map((uid) => (memberById(uid)?.name) || 'Кто-то').join(', '))}">
          <span>${escapeHtml(emoji)}</span><span class="reaction-count">${users.length}</span>
        </span>`;
      }).join('')}</div>`
    : '';

  const botTag = msg.bot ? `<span class="msg-bot-tag">${checkIcon()} БОТ</span>` : '';
  const big = isEmojiOnly(msg.text) ? ' big-emoji' : '';

  if (grouped) {
    return `<div class="msg grouped compact" data-msg="${msg.id}">
      ${toolbar}
      <div class="msg-hover-time">${ts}</div>
      <div class="msg-avatar-spacer"></div>
      <div class="msg-body">
        <div class="msg-text${big}">${formatText(msg.text)}</div>
        ${reactions}
      </div>
    </div>`;
  }

  return `<div class="msg" data-msg="${msg.id}">
    ${toolbar}
    <div class="msg-avatar">${avatarHtml(msg.author, name, 40)}</div>
    <div class="msg-body">
      <div class="msg-head">
        <span class="msg-author ${roleClass}">${escapeHtml(name)}</span>
        ${botTag}
        <span class="msg-time" title="${escapeHtml(fullDate)}">${dayLabel(msg.ts) === 'Сегодня' ? 'сегодня в ' : ''}${ts}</span>
      </div>
      <div class="msg-text${big}">${formatText(msg.text)}</div>
      ${reactions}
    </div>
  </div>`;
}

function trashIcon() {
  return '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/></svg>';
}
function checkIcon() {
  return '<svg viewBox="0 0 24 24" width="10" height="10" fill="currentColor"><path d="m9 16.2-3.5-3.5L4 14.2l5 5 11-11-1.5-1.5z"/></svg>';
}

function renderMessages(forceBottom = false) {
  const ch = channelById(state.current);
  if (!ch) return;

  const box = els.messages;
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;

  let list = (state.messages[ch.id] || []).slice();
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter((m) => m.text.toLowerCase().includes(q) || (m.authorName || '').toLowerCase().includes(q));

  let html = '';

  if (!q) {
    html += `<div class="channel-intro">
      <div class="channel-intro-icon"><svg viewBox="0 0 24 24" width="44" height="44" fill="currentColor"><path d="M9.2 3.1a1 1 0 0 1 1.1.9l.5 4h3.4l-.4-3.6a1 1 0 1 1 2-.2l.4 3.8h2.2a1 1 0 1 1 0 2h-2l.5 4h2.2a1 1 0 1 1 0 2H16.6l.4 3.6a1 1 0 0 1-2 .2l-.4-3.8h-3.4l.4 3.6a1 1 0 0 1-2 .2l-.4-3.8H7.2a1 1 0 1 1 0-2h2l-.5-4H6.5a1 1 0 1 1 0-2h2l-.4-3.8a1 1 0 0 1 .9-1.1.9.9 0 0 1 .2 0zM11.3 10l-.5 4h3.4l.5-4z"/></svg></div>
      <h2>Добро пожаловать в #${escapeHtml(ch.name)}!</h2>
      <p>Это начало канала #${escapeHtml(ch.name)}. ${escapeHtml(ch.topic || '')}</p>
      <div class="intro-divider"></div>
    </div>`;
  } else {
    html += `<div class="channel-intro"><h2>Поиск</h2><p>Результаты по запросу «${escapeHtml(state.search)}»: ${list.length}</p><div class="intro-divider"></div></div>`;
  }

  if (!list.length) {
    html += `<div class="date-divider"><span>${q ? 'Ничего не найдено' : 'Пока пусто — напиши первым!'}</span></div>`;
  }

  let prev = null;
  let prevDay = null;
  for (const msg of list) {
    const dk = dayKey(msg.ts);
    if (prevDay !== dk) {
      html += `<div class="date-divider"><span>${dayLabel(msg.ts)}</span></div>`;
      prev = null;
    }
    html += messageHtml(msg, prev, { searching: !!q });
    prev = msg;
    prevDay = dk;
  }

  box.innerHTML = html;
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

/* ============================================================
   RENDER: members
   ============================================================ */
function renderMembers() {
  const online = [];
  const offline = [];

  /* hide fictional demo members when a real user with the same name is online */
  const realNames = new Set(state.online.map((u) => u.name.trim().toLowerCase()));
  const seeds = SEED_MEMBERS.filter((m) => m.id === 'u-bot' || !realNames.has(m.name.toLowerCase()));

  for (const m of seeds) {
    (m.status === 'offline' ? offline : online).push(m);
  }
  for (const u of state.online) {
    if (SEED_MAP.has(u.id)) continue;
    online.push({ id: u.id, name: u.name, role: 'member', status: 'online', isReal: true });
  }

  const order = { admin: 0, mod: 1, bot: 2, member: 3 };
  online.sort((a, b) => (order[a.role] ?? 3) - (order[b.role] ?? 3));

  const memberHtml = (m, isOffline) => {
    const isMe = m.id === me.id;
    const roleClass = m.role === 'admin' ? 'admin' : m.role === 'mod' ? 'mod' : '';
    const status = m.status || 'online';
    return `<div class="member ${isOffline ? 'offline' : ''}" title="${escapeHtml(m.name)}">
      <div class="avatar avatar-32" style="background:${avatarColor(m.id)}">
        <span class="avatar-initial">${escapeHtml(m.name.charAt(0).toUpperCase())}</span>
        <span class="status-dot ${status}"></span>
      </div>
      <div class="member-meta">
        <div class="member-name ${roleClass}">${escapeHtml(m.name)}${isMe ? ' <span class="you-tag">ВЫ</span>' : ''}${m.role === 'bot' ? ` <span class="msg-bot-tag">${checkIcon()} БОТ</span>` : ''}</div>
        <div class="member-sub">${escapeHtml(m.activity || m.tag || (isOffline ? 'Не в сети' : 'В сети'))}</div>
      </div>
    </div>`;
  };

  let html = '';
  html += `<div class="members-group-title">В сети — ${online.length}</div>`;
  for (const m of online) html += memberHtml(m, false);
  if (offline.length) {
    html += `<div class="members-group-title">Не в сети — ${offline.length}</div>`;
    for (const m of offline) html += memberHtml(m, true);
  }
  els.members.innerHTML = html;
}

/* ============================================================
   RENDER: typing
   ============================================================ */
function renderTyping() {
  const nowTs = Date.now();
  const names = [];
  for (const [uid, info] of state.typing) {
    if (nowTs - info.ts > 4000) state.typing.delete(uid);
    else if (uid !== me.id) names.push(info.name);
  }
  if (!names.length) { els.typing.innerHTML = ''; return; }
  const label = names.length === 1
    ? `${escapeHtml(names[0])} печатает`
    : `${names.slice(0, 2).map(escapeHtml).join(' и ')} печатают`;
  els.typing.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span>${label}…</span>`;
}

/* ============================================================
   Channels / navigation
   ============================================================ */
function openChannel(id, opts = {}) {
  const ch = channelById(id);
  if (!ch || ch.type !== 'text') return;
  state.current = id;
  state.unread[id] = 0;
  state.search = '';
  els.searchInput.value = '';
  els.chatName.textContent = ch.name;
  els.chatTopic.textContent = ch.topic || '';
  els.composer.placeholder = 'Написать в #' + ch.name;
  renderChannels();
  renderMessages(true);
  if (!opts.silent) els.composer.focus();
  updateTitle();
}

function updateTitle() {
  const total = Object.values(state.unread).reduce((a, b) => a + b, 0);
  document.title = total ? `(${total}) Nebula` : 'Nebula — общайся со своей стаей';
}

/* ============================================================
   Realtime
   ============================================================ */
let es = null;

function connect() {
  if (es) es.close();
  es = new EventSource('/api/events?id=' + encodeURIComponent(me.id) + '&name=' + encodeURIComponent(me.name));

  es.onopen = () => {
    refreshState().catch(() => {});
  };
  es.onerror = () => {
    /* EventSource reconnects automatically */
  };
  es.onmessage = (e) => {
    let ev;
    try { ev = JSON.parse(e.data); } catch (_) { return; }
    handleEvent(ev);
  };
}

async function refreshState() {
  const data = await apiGet('/api/state');
  state.channels = data.channels || [];
  state.messages = data.messages || {};
  state.voice = data.voice || {};
  if (!state.current) {
    const first = state.channels.find((c) => c.type === 'text');
    if (first) openChannel(first.id, { silent: true });
  }
  renderChannels();
  renderMembers();
  if (state.current) renderMessages(false);
}

function handleEvent(ev) {
  switch (ev.type) {
    case 'presence':
      state.online = ev.online || [];
      renderMembers();
      break;

    case 'message': {
      const msg = ev.message;
      if (!state.messages[msg.channel]) state.messages[msg.channel] = [];
      if (!state.messages[msg.channel].some((m) => m.id === msg.id)) {
        state.messages[msg.channel].push(msg);
      }
      if (msg.channel === state.current) {
        renderMessages(false);
      } else if (msg.author !== me.id) {
        state.unread[msg.channel] = (state.unread[msg.channel] || 0) + 1;
        renderChannels();
        updateTitle();
      }
      break;
    }

    case 'message-delete': {
      const arr = state.messages[ev.channel] || [];
      const idx = arr.findIndex((m) => m.id === ev.id);
      if (idx !== -1) arr.splice(idx, 1);
      if (ev.channel === state.current) renderMessages(false);
      break;
    }

    case 'reaction': {
      const arr = state.messages[ev.channel] || [];
      const msg = arr.find((m) => m.id === ev.id);
      if (msg) {
        msg.reactions = ev.reactions;
        if (ev.channel === state.current) renderMessages(false);
      }
      break;
    }

    case 'typing':
      state.typing.set(ev.userId, { name: ev.userName, ts: ev.ts });
      renderTyping();
      break;

    case 'channel-create':
      if (!state.channels.some((c) => c.id === ev.channel.id)) {
        state.channels.push(ev.channel);
        state.messages[ev.channel.id] = state.messages[ev.channel.id] || [];
        renderChannels();
      }
      break;

    case 'voice-join': {
      const list = (state.voice[ev.channel] = state.voice[ev.channel] || []);
      if (!list.some((p) => p.id === ev.user.id)) {
        list.push({ id: ev.user.id, name: ev.user.name, muted: !!ev.user.muted, sharing: !!ev.user.sharing });
      } else {
        const p = list.find((x) => x.id === ev.user.id);
        p.muted = !!ev.user.muted;
        p.sharing = !!ev.user.sharing;
      }
      renderChannels();

      if (rtc.current === ev.channel && ev.user.id !== me.id) {
        toast(`${ev.user.name} присоединился к голосовому каналу`);
        /* если у вошедшего уже включён показ экрана — покажем карточку */
        if (ev.user.sharing) showScreenCard(ev.user.id, ev.user.name, null);
        /* догоняем нового участника своим экраном, если делимся (без дублей) */
        if (rtc.screenStream) {
          const pc = rtc.pcs.get(ev.user.id);
          if (pc) {
            const senders = pc.getSenders().map((s) => s.track);
            rtc.screenStream.getTracks().forEach((t) => {
              if (!senders.includes(t)) { try { pc.addTrack(t, rtc.screenStream); } catch (_) {} }
            });
          }
        }
      }
      break;
    }

    case 'voice-leave': {
      const list = state.voice[ev.channel] || [];
      state.voice[ev.channel] = list.filter((p) => p.id !== ev.user.id);
      renderChannels();
      if (rtc.current === ev.channel && ev.user.id !== me.id) dropPeer(ev.user.id);
      break;
    }

    case 'voice-share': {
      const list = state.voice[ev.channel] || [];
      const p = list.find((x) => x.id === ev.id);
      if (p) p.sharing = ev.sharing;
      renderChannels();
      if (!ev.sharing) removeScreenCard(ev.id);
      else if (rtc.current === ev.channel && ev.id !== me.id) {
        showScreenCard(ev.id, peerName(ev.id), null); /* карточка «подключается…» */
      }
      break;
    }

    case 'voice-mute': {
      const list = state.voice[ev.channel] || [];
      const p = list.find((x) => x.id === ev.id);
      if (p) p.muted = ev.muted;
      renderChannels();
      break;
    }

    case 'signal':
      if (ev.to === me.id) onSignal(ev).catch(() => {});
      break;
  }
}

/* ============================================================
   Voice (WebRTC mesh)
   ============================================================ */
const rtc = {
  pcs: new Map(),
  stream: null,
  current: null,
  muted: false,
  deafened: false,
  screenStream: null,   // локальная трансляция экрана
  sharing: false,
};

const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
  ],
};

function peerName(id) {
  const list = state.voice[rtc.current] || [];
  const p = list.find((x) => x.id === id);
  if (p) return p.name;
  const m = memberById(id);
  return (m && m.name) || 'Участник';
}

/* --- perfect negotiation: позволяет добавлять экран на лету --- */
function addLocalTracks(pc) {
  if (rtc.stream) {
    rtc.stream.getTracks().forEach((t) => pc.addTrack(t, rtc.stream));
  } else {
    pc.addTransceiver('audio', { direction: 'recvonly' });
  }
  if (rtc.screenStream) {
    rtc.screenStream.getTracks().forEach((t) => pc.addTrack(t, rtc.screenStream));
  }
}

function newPC(peerId) {
  const pc = new RTCPeerConnection(ICE);
  pc.polite = me.id < peerId;      // детерминированные роли, чтобы не было «glare»
  pc.makingOffer = false;
  pc.ignoreOffer = false;
  rtc.pcs.set(peerId, pc);

  pc.onicecandidate = (e) => {
    if (e.candidate) postSignal(peerId, { candidate: e.candidate }).catch(() => {});
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0] || new MediaStream([e.track]);
    if (e.track.kind === 'video') {
      showScreenCard(peerId, peerName(peerId), stream);
      e.track.onended = () => removeScreenCard(peerId);
    } else {
      attachRemoteAudio(peerId, stream);
    }
  };

  /* любое изменение треков (включили/выключили экран) → новая offer/answer */
  pc.onnegotiationneeded = async () => {
    if (!rtc.current || !pc.connectionState) return;
    try {
      pc.makingOffer = true;
      await pc.setLocalDescription();
      await postSignal(peerId, { sdp: pc.localDescription });
    } catch (err) {
      console.warn('negotiation failed', err);
    } finally {
      pc.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed'].includes(pc.connectionState)) dropPeer(peerId);
  };

  addLocalTracks(pc);
  return pc;
}

function attachRemoteAudio(peerId, stream) {
  const key = 'audio-' + peerId + '-' + String(stream.id).replace(/[^a-zA-Z0-9_-]/g, '');
  let audio = document.getElementById(key);
  if (!audio) {
    audio = document.createElement('audio');
    audio.id = key;
    audio.dataset.peer = peerId;
    audio.autoplay = true;
    els.remoteAudios.appendChild(audio);
  }
  if (audio.srcObject !== stream) {
    audio.srcObject = stream;
    audio.muted = rtc.deafened;
    audio.play().catch(() => {});
  }
}

function dropPeer(peerId) {
  const pc = rtc.pcs.get(peerId);
  if (pc) { try { pc.close(); } catch (_) {} rtc.pcs.delete(peerId); }
  els.remoteAudios.querySelectorAll('audio[data-peer="' + CSS.escape(String(peerId)) + '"]').forEach((a) => a.remove());
  removeScreenCard(peerId);
}

function postSignal(to, data) {
  return api('/api/voice/signal', { channel: rtc.current, from: me.id, to, data });
}

async function onSignal(ev) {
  if (!rtc.current) return;
  const from = ev.from;
  const data = ev.data || {};

  let pc = rtc.pcs.get(from);
  if (!pc) pc = newPC(from);

  if (data.sdp) {
    const offerCollision = data.sdp.type === 'offer' && (pc.makingOffer || pc.signalingState !== 'stable');
    pc.ignoreOffer = !pc.polite && offerCollision;
    if (pc.ignoreOffer) return;

    await pc.setRemoteDescription(data.sdp);
    if (data.sdp.type === 'offer') {
      await pc.setLocalDescription();
      await postSignal(from, { sdp: pc.localDescription });
    }
  } else if (data.candidate) {
    try {
      await pc.addIceCandidate(data.candidate);
    } catch (err) {
      if (!pc.ignoreOffer) console.warn('ice candidate failed', err);
    }
  }
}

/* ============================ Демонстрация экрана ============================ */

function screenCardId(peerId) {
  return 'screen-card-' + String(peerId).replace(/[^a-zA-Z0-9_-]/g, '');
}

function showScreenCard(peerId, name, stream) {
  const stage = els.screenStage;
  let card = document.getElementById(screenCardId(peerId));

  if (!card) {
    card = document.createElement('div');
    card.className = 'screen-card';
    card.id = screenCardId(peerId);
    card.innerHTML = `
      <div class="screen-card-head">
        <span class="live-dot"></span>
        <span class="screen-title"></span>
        <span class="screen-actions">
          <button type="button" data-screen-full title="На весь экран" aria-label="На весь экран">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M16 3h3a2 2 0 0 1 2 2v3"/><path d="M8 21H5a2 2 0 0 1-2-2v-3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
          </button>
          <button type="button" data-screen-hide title="Скрыть" aria-label="Скрыть">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>
          </button>
        </span>
      </div>
      <video autoplay playsinline></video>
      <div class="screen-waiting">Подключение к трансляции…</div>`;
    stage.appendChild(card);
    stage.classList.remove('hidden');

    card.querySelector('[data-screen-full]').addEventListener('click', () => {
      const video = card.querySelector('video');
      if (document.fullscreenElement) document.exitFullscreen();
      else if (video.requestFullscreen) video.requestFullscreen().catch(() => {});
    });
    card.querySelector('[data-screen-hide]').addEventListener('click', () => {
      card.classList.add('hidden-card');
      updateScreenStage();
    });
  }

  card.classList.remove('hidden-card');
  card.querySelector('.screen-title').textContent = (peerId === me.id ? 'Вы' : name) + ' — демонстрация экрана';

  const video = card.querySelector('video');
  video.muted = peerId === me.id || rtc.deafened;
  if (stream && video.srcObject !== stream) {
    video.srcObject = stream;
    card.classList.add('has-stream');
    video.play().catch(() => {});
  }
  updateScreenStage();
}

function removeScreenCard(peerId) {
  const card = document.getElementById(screenCardId(peerId));
  if (!card) return;
  const video = card.querySelector('video');
  if (video) video.srcObject = null;
  card.remove();
  updateScreenStage();
}

function updateScreenStage() {
  const stage = els.screenStage;
  const cards = [...stage.querySelectorAll('.screen-card')];
  const visible = cards.filter((c) => !c.classList.contains('hidden-card'));
  stage.classList.toggle('hidden', visible.length === 0);
  /* при переполнении показываем только последние 2 карточки */
  visible.forEach((c, idx) => {
    c.classList.toggle('oldest', idx < visible.length - 2);
  });
}

async function startScreenShare() {
  if (!rtc.current) {
    toast('Сначала подключитесь к голосовому каналу');
    return;
  }
  if (rtc.screenStream) return;

  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 30, max: 60 } },
      audio: true,
    });
  } catch (err) {
    const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
    toast(
      denied
        ? 'Доступ к экрану не выдан. Если сайт открыт внутри предпросмотра — открой его в отдельной вкладке браузера и попробуй снова.'
        : 'Браузер не смог начать демонстрацию экрана: ' + (err && err.message ? err.message : 'неизвестная ошибка'),
      6000
    );
    return;
  }

  rtc.screenStream = stream;
  rtc.sharing = true;

  /* добавляем видеотрек во все активные соединения — они пересогласуются сами */
  for (const [, pc] of rtc.pcs) {
    stream.getTracks().forEach((t) => {
      try { pc.addTrack(t, stream); } catch (_) {}
    });
  }

  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    videoTrack.addEventListener('ended', () => stopScreenShare());
  }

  showScreenCard(me.id, me.name, stream);
  updateVoicePanel();
  renderChannels();

  try { await api('/api/voice/share', { channel: rtc.current, id: me.id, sharing: true }); } catch (_) {}
  toast('Демонстрация экрана началась');
}

async function stopScreenShare(notifyServer = true) {
  if (!rtc.screenStream) return;
  const channel = rtc.current;
  const stream = rtc.screenStream;

  for (const [, pc] of rtc.pcs) {
    pc.getSenders().forEach((sender) => {
      if (sender.track && stream.getTracks().includes(sender.track)) {
        try { pc.removeTrack(sender); } catch (_) {}
      }
    });
  }

  stream.getTracks().forEach((t) => { try { t.stop(); } catch (_) {} });
  rtc.screenStream = null;
  rtc.sharing = false;
  removeScreenCard(me.id);
  updateVoicePanel();
  renderChannels();

  if (notifyServer && channel) {
    try { await api('/api/voice/share', { channel, id: me.id, sharing: false }); } catch (_) {}
  }
}

function updateVoicePanel() {
  if (rtc.current) {
    const ch = channelById(rtc.current);
    els.voicePanel.classList.remove('hidden');
    els.voiceStatusSub.textContent = 'Nebula / ' + (ch ? ch.name : '');
  } else {
    els.voicePanel.classList.add('hidden');
  }
  els.voiceToggleMic.classList.toggle('off', rtc.muted);
  els.voiceToggleMic.querySelector('.ic-mic').classList.toggle('hidden', rtc.muted);
  els.voiceToggleMic.querySelector('.ic-mic-off').classList.toggle('hidden', !rtc.muted);
  els.voiceToggleDeaf.classList.toggle('off', rtc.deafened);
  els.voiceToggleDeaf.querySelector('.ic-deaf').classList.toggle('hidden', rtc.deafened);
  els.voiceToggleDeaf.querySelector('.ic-deaf-off').classList.toggle('hidden', !rtc.deafened);
  if (els.voiceToggleShare) {
    els.voiceToggleShare.classList.toggle('active-share', !!rtc.screenStream);
    const title = rtc.screenStream ? 'Остановить демонстрацию экрана' : 'Демонстрация экрана';
    els.voiceToggleShare.title = title;
    els.voiceToggleShare.setAttribute('aria-label', title);
  }
}

async function joinVoice(channelId) {
  if (rtc.current === channelId) { await leaveVoice(); return; }
  if (rtc.current) await leaveVoice();

  let stream = null;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (err) {
    toast('Микрофон недоступен — подключились в режиме прослушивания. Разрешите микрофон или откройте сайт в отдельной вкладке.', 5200);
  }

  rtc.stream = stream;
  rtc.current = channelId;
  rtc.muted = false;
  rtc.deafened = false;

  let res;
  try {
    res = await api('/api/voice/join', { channel: channelId, id: me.id, name: me.name });
  } catch (e) {
    toast('Не удалось подключиться к голосовому каналу');
    rtc.current = null;
    if (stream) stream.getTracks().forEach((t) => t.stop());
    rtc.stream = null;
    updateVoicePanel();
    return;
  }

  /* создаём соединение с каждым участником — переговоры стартуют автоматически */
  for (const peer of res.peers || []) {
    if (peer.id === me.id) continue;
    if (!rtc.pcs.has(peer.id)) newPC(peer.id);
  }

  updateVoicePanel();
  renderChannels();
}

async function leaveVoice() {
  if (!rtc.current) return;
  const ch = rtc.current;

  await stopScreenShare(true);

  rtc.current = null;
  for (const id of [...rtc.pcs.keys()]) dropPeer(id);
  if (rtc.stream) { rtc.stream.getTracks().forEach((t) => t.stop()); rtc.stream = null; }
  els.remoteAudios.innerHTML = '';
  els.screenStage.innerHTML = '';
  els.screenStage.classList.add('hidden');
  rtc.muted = false;
  rtc.deafened = false;
  updateVoicePanel();
  try { await api('/api/voice/leave', { id: me.id, channel: ch }); } catch (_) {}
  renderChannels();
}

async function toggleMic() {
  if (!rtc.current) {
    toast('Сначала подключитесь к голосовому каналу');
    return;
  }
  if (!rtc.stream) {
    toast('Микрофон недоступен. Разрешите доступ в браузере.');
    return;
  }
  rtc.muted = !rtc.muted;
  rtc.stream.getAudioTracks().forEach((t) => { t.enabled = !rtc.muted; });
  updateVoicePanel();
  try { await api('/api/voice/mute', { channel: rtc.current, id: me.id, muted: rtc.muted }); } catch (_) {}
}

function toggleDeaf() {
  if (!rtc.current) { toast('Сначала подключитесь к голосовому каналу'); return; }
  rtc.deafened = !rtc.deafened;
  els.remoteAudios.querySelectorAll('audio').forEach((a) => { a.muted = rtc.deafened; });
  els.screenStage.querySelectorAll('video').forEach((v) => {
    if (v.closest('.screen-card') && v.closest('.screen-card').id !== screenCardId(me.id)) v.muted = rtc.deafened;
  });
  updateVoicePanel();
}

/* ============================================================
   Composer
   ============================================================ */
function autoGrow() {
  const ta = els.composer;
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, Math.floor(window.innerHeight * 0.38)) + 'px';
}

let lastTyping = 0;
function notifyTyping() {
  if (!state.current) return;
  const nowTs = Date.now();
  if (nowTs - lastTyping < 1600) return;
  lastTyping = nowTs;
  api('/api/typing', { channel: state.current, userId: me.id, userName: me.name }).catch(() => {});
}

async function sendMessage() {
  const text = els.composer.value.trim();
  if (!text || !state.current) return;
  els.composer.value = '';
  autoGrow();
  els.sendBtn.classList.add('hidden');
  try {
    await api('/api/messages', {
      channel: state.current,
      userId: me.id,
      userName: me.name,
      text,
    });
  } catch (e) {
    toast('Сообщение не отправлено — сервер недоступен');
  }
  els.composer.focus();
}

/* emoji picker */
const EMOJIS = ['😀','😁','😂','🤣','😊','😍','😘','😎','🤔','😅','😉','🙃','😴','😭','😤','😡','🥳','🤯','🥺','😱',
  '👍','👎','👏','🙏','🤝','💪','🫶','👀','🔥','💯','✨','⚡','🎉','🎊','❤️','🧡','💛','💚','💙','💜',
  '🖤','🤍','💔','💬','🌌','🚀','🪐','⭐','🌙','🎮','🎧','🎵','☕','🍕','🍿','🐱','🐶','🦊','🌸','🌈'];

function buildEmojiPicker() {
  els.emojiPicker.innerHTML = EMOJIS.map((e) => `<button type="button" data-emoji="${e}">${e}</button>`).join('');
}

/* ============================================================
   Modal
   ============================================================ */
let modalState = { onSubmit: null };

function openModal({ title, sub, label, placeholder, value = '', hash = '#', submitText = 'Создать', onSubmit }) {
  els.modalTitle.textContent = title;
  els.modalSub.textContent = sub;
  els.modalLabel.textContent = label;
  els.modalInput.placeholder = placeholder || '';
  els.modalInput.value = value;
  els.modalHash.textContent = hash;
  els.modalHash.style.display = hash ? '' : 'none';
  els.modalSubmit.textContent = submitText;
  modalState.onSubmit = onSubmit;
  els.modalOverlay.classList.remove('hidden');
  setTimeout(() => els.modalInput.focus(), 50);
}

function closeModal() {
  els.modalOverlay.classList.add('hidden');
  modalState.onSubmit = null;
}

/* ============================================================
   Wiring
   ============================================================ */
function wire() {
  /* login */
  els.loginForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const name = els.loginName.value.trim();
    if (name.length < 2) {
      els.loginName.classList.add('invalid');
      els.loginName.focus();
      return;
    }
    els.loginName.classList.remove('invalid');
    me.name = name;
    store.set('nebula_name', name);
    enterApp();
  });
  els.loginName.addEventListener('input', () => els.loginName.classList.remove('invalid'));

  /* channels */
  els.channelsScroll.addEventListener('click', (e) => {
    const add = e.target.closest('[data-action]');
    if (add) {
      const type = add.dataset.action === 'new-voice' ? 'voice' : 'text';
      openModal({
        title: type === 'voice' ? 'Создать голосовой канал' : 'Создать текстовый канал',
        sub: type === 'voice'
          ? 'Голосовые каналы — чтобы болтать голосом.'
          : 'Текстовые каналы — для сообщений, мемов и споров о тако.',
        label: 'Название канала',
        placeholder: type === 'voice' ? 'Новый голосовой' : 'новый-канал',
        hash: type === 'voice' ? '' : '#',
        onSubmit: async (value) => {
          if (type === 'voice') {
            toast('Голосовые каналы создаются в полной версии — в демо их две 🙂');
            closeModal();
            return;
          }
          try {
            const res = await api('/api/channels', { name: value });
            closeModal();
            if (res.channel) openChannel(res.channel.id);
          } catch (_) { toast('Не удалось создать канал'); }
        },
      });
      return;
    }

    const voice = e.target.closest('[data-voice]');
    if (voice) { joinVoice(voice.dataset.voice); return; }

    const ch = e.target.closest('[data-channel]');
    if (ch) openChannel(ch.dataset.channel);
  });

  /* messages delegation */
  els.messages.addEventListener('click', (e) => {
    const reactBtn = e.target.closest('[data-react]');
    if (reactBtn) {
      const msgEl = reactBtn.closest('[data-msg]');
      if (msgEl) toggleReaction(msgEl.dataset.msg, reactBtn.dataset.react);
      return;
    }

    const reaction = e.target.closest('[data-react-msg]');
    if (reaction) {
      toggleReaction(reaction.dataset.reactMsg, reaction.dataset.emoji);
      return;
    }

    const del = e.target.closest('[data-del]');
    if (del) {
      fetch('/api/messages/' + del.dataset.del, { method: 'DELETE' }).catch(() => {});
      return;
    }

    const chLink = e.target.closest('.channel-link');
    if (chLink) { openChannel(chLink.dataset.channel); return; }
  });

  /* composer */
  els.composer.addEventListener('input', () => {
    autoGrow();
    els.sendBtn.classList.toggle('hidden', !els.composer.value.trim());
    notifyTyping();
  });
  els.composer.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });
  els.sendBtn.addEventListener('click', sendMessage);

  /* emoji picker */
  buildEmojiPicker();
  els.emojiBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const hidden = els.emojiPicker.classList.toggle('hidden');
    els.emojiBtn.classList.toggle('active', !hidden);
  });
  els.emojiPicker.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-emoji]');
    if (!btn) return;
    const emoji = btn.dataset.emoji;
    const ta = els.composer;
    const start = ta.selectionStart ?? ta.value.length;
    const end = ta.selectionEnd ?? ta.value.length;
    ta.value = ta.value.slice(0, start) + emoji + ta.value.slice(end);
    ta.selectionStart = ta.selectionEnd = start + emoji.length;
    ta.focus();
    autoGrow();
    els.sendBtn.classList.remove('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!els.emojiPicker.contains(e.target) && e.target !== els.emojiBtn) {
      els.emojiPicker.classList.add('hidden');
      els.emojiBtn.classList.remove('active');
    }
  });

  /* members toggle */
  els.membersToggle.addEventListener('click', () => {
    const collapsed = els.members.classList.toggle('collapsed');
    els.membersToggle.classList.toggle('active', !collapsed);
  });

  /* search */
  els.searchBtn.addEventListener('click', () => {
    const box = els.searchBox.classList.toggle('hidden');
    if (!box) els.searchInput.focus();
  });
  els.searchInput.addEventListener('input', () => {
    state.search = els.searchInput.value;
    renderMessages(false);
  });
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.searchInput.value = '';
      state.search = '';
      els.searchBox.classList.add('hidden');
      renderMessages(true);
    }
  });

  /* voice */
  els.voiceToggleMic.addEventListener('click', toggleMic);
  els.voiceToggleShare.addEventListener('click', () => {
    if (!rtc.current) {
      toast('Сначала подключитесь к голосовому каналу');
      return;
    }
    if (rtc.screenStream) stopScreenShare();
    else startScreenShare();
  });
  els.voiceToggleDeaf.addEventListener('click', toggleDeaf);
  els.voiceDisconnect.addEventListener('click', leaveVoice);

  /* modal */
  els.modalCancel.addEventListener('click', closeModal);
  els.modalOverlay.addEventListener('click', (e) => {
    if (e.target === els.modalOverlay) closeModal();
  });
  els.modalForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const value = els.modalInput.value.trim();
    if (!value) { els.modalInput.focus(); return; }
    if (modalState.onSubmit) modalState.onSubmit(value);
  });

  /* misc buttons */
  const stub = (msg) => () => toast(msg);
  $('addServerBtn').addEventListener('click', stub('Создание серверов доступно в полной версии Nebula'));
  $('attachBtn').addEventListener('click', stub('Вложения появятся в следующей версии'));
  $('panelSettings').addEventListener('click', stub('Настройки профиля — скоро'));
  $('panelMic').addEventListener('click', () => {
    const on = $('panelMic').classList.toggle('muted');
    $('panelMic').style.color = on ? 'var(--red)' : '';
    toast(on ? 'Микрофон выключен' : 'Микрофон включён');
  });
  const openDrawer = () => {
    document.querySelector('.sidebar').classList.add('open');
    $('sidebarBackdrop').classList.add('show');
  };
  const closeDrawer = () => {
    document.querySelector('.sidebar').classList.remove('open');
    $('sidebarBackdrop').classList.remove('show');
  };
  $('mobileMenuBtn').addEventListener('click', openDrawer);
  $('sidebarBackdrop').addEventListener('click', closeDrawer);
  els.channelsScroll.addEventListener('click', (e) => {
    const ch = e.target.closest('[data-channel]');
    const voice = e.target.closest('[data-voice]');
    const add = e.target.closest('[data-action]');
    if ((ch || voice) && window.innerWidth <= 640) setTimeout(closeDrawer, 120);
    if (add && window.innerWidth <= 640) closeDrawer();
  });

  $('panelSound').addEventListener('click', () => {
    const off = $('panelSound').classList.toggle('muted');
    $('panelSound').style.color = off ? 'var(--red)' : '';
    toast(off ? 'Звук выключен' : 'Звук включён');
  });

  /* unload */
  window.addEventListener('beforeunload', () => {
    if (rtc.current) {
      try {
        navigator.sendBeacon('/api/voice/leave',
          new Blob([JSON.stringify({ id: me.id })], { type: 'text/plain' }));
      } catch (_) {}
    }
  });

  setInterval(renderTyping, 700);
}

async function toggleReaction(msgId, emoji) {
  try {
    await api('/api/react', { id: msgId, emoji, userId: me.id });
  } catch (_) {
    toast('Не удалось поставить реакцию');
  }
}

/* ============================================================
   Enter app
   ============================================================ */
function enterApp() {
  els.login.classList.add('hidden');
  els.app.classList.remove('hidden');

  els.myInitial.textContent = me.name.charAt(0).toUpperCase();
  els.myAvatar.style.background = avatarColor(me.id);
  els.myName.textContent = me.name;
  els.myTag.textContent = me.tag;

  connect();
  refreshState().catch(() => toast('Не удалось загрузить состояние сервера'));
}

/* boot */
wire();
if (me.name) {
  enterApp();
} else {
  setTimeout(() => els.loginName.focus(), 100);
}
