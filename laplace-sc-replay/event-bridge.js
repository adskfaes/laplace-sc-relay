const settingsKey = 'lscEventBridge';
const maxAge = 60 * 60 * 1000;
const maxEvents = 60000;
const echoTimeout = 10000;
const roomPattern = /^[1-9]\d{0,15}$/u;
const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const echoText = (text) => normalize(text).replace(/[\s\u200b\u2060]/gu, '');

let config = { enabled: false, port: 9696, uid: '', token: '' };
let installed;
let socket;
let heartbeat;
let retry;
let retryDelay = 1000;
let state = 'disabled';
let received = 0;
let lastRoom = '';
let pendingEcho;
const history = new Map();

function timestamp(event, now) {
  for (const value of [event.timestampNormalized, event.timestamp]) {
    if (!Number.isFinite(value) || value <= 0) continue;
    const time = value < 1e12 ? value * 1000 : value;
    if (time <= now + 30000) return time;
  }
  return now;
}

function trimHistory(now) {
  for (const [key, event] of history) {
    if (event.receivedAt >= now - maxAge && history.size <= maxEvents) break;
    history.delete(key);
  }
}

function accept(event) {
  if (event?.type !== 'message' || typeof event.message !== 'string' || event.message.length > 4096) return;
  const room = String(event.origin);
  const text = normalize(event.message);
  if (!roomPattern.test(room) || !text) return;
  const now = Date.now();
  const time = timestamp(event, now);
  if (time < now - maxAge) return;
  const uid = Number.isSafeInteger(event.uid) && event.uid !== 0 ? String(event.uid) : '';
  const id = [event.idStr, event.id].find((value) => typeof value === 'string' && value && value !== '0');
  const key = id ? `${room}:${id}` : Symbol();
  if (history.has(key)) return;
  const username = typeof event.username === 'string' ? event.username.trim().slice(0, 80) : '';
  history.set(key, { room, text, time, receivedAt: now, uid, username, sender: uid ? `uid:${uid}` : undefined });
  trimHistory(now);
  received++;
  lastRoom = room;

  const echo = pendingEcho;
  if (echo && room === echo.room && time >= echo.started - 3000 && echoText(text) === echo.text) {
    if (uid === echo.uid) echo.finish('confirmed');
    else echo.sawOtherUid = true;
  }
}

function receive(raw, current) {
  if (typeof raw !== 'string') return;
  let data;
  try { data = JSON.parse(raw); } catch { return; }
  if (data?.type === 'ping') {
    current.send(JSON.stringify({ type: 'pong', timestamp: Date.now(), respondingTo: data.timestamp }));
    return;
  }
  if (Array.isArray(data)) data.forEach(accept);
  else accept(data);
}

function connect() {
  state = 'connecting';
  const protocols = config.token ? ['laplace-event-bridge-role-client', config.token] : [];
  const current = new WebSocket(`ws://127.0.0.1:${config.port}/`, protocols);
  socket = current;
  current.onopen = () => {
    if (socket !== current) return;
    state = 'connected';
    received = 0;
    lastRoom = '';
    retryDelay = 1000;
    // Chrome extension service workers need WebSocket traffic during quiet periods.
    heartbeat = setInterval(() => {
      if (current.readyState === WebSocket.OPEN) current.send('{"type":"keepalive"}');
    }, 20000);
  };
  current.onmessage = ({ data }) => {
    if (socket === current) receive(data, current);
  };
  current.onclose = () => {
    if (socket !== current) return;
    clearInterval(heartbeat);
    state = 'disconnected';
    pendingEcho?.finish('disconnected');
    retry = setTimeout(connect, retryDelay);
    retryDelay = Math.min(30000, retryDelay * 2);
  };
}

function apply(next) {
  if (next.enabled === config.enabled && next.port === config.port && next.token === config.token) {
    if (next.uid !== config.uid) pendingEcho?.finish('cancelled');
    config = next;
    return;
  }
  const previous = socket;
  socket = undefined;
  previous?.close();
  clearInterval(heartbeat);
  clearTimeout(retry);
  pendingEcho?.finish('disconnected');
  history.clear();
  received = 0;
  lastRoom = '';
  retryDelay = 1000;
  config = next;
  state = 'disabled';
  if (config.enabled) connect();
}

function settings(value, previous = {}) {
  const { enabled, port, uid } = value;
  const token = enabled ? (value.token || (port === previous.port ? previous.token : '') || '') : '';
  if (typeof enabled !== 'boolean' || !Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof uid !== 'string' || (uid && !roomPattern.test(uid)) || typeof token !== 'string' ||
      (token && !/^[!#$%&'*+.^_`|~\w-]{1,256}$/u.test(token)) || token === 'laplace-event-bridge-role-client') {
    throw new Error('请检查 Event Bridge 端口、发送账号 UID 和密码格式。');
  }
  return { enabled, port, uid, token };
}

async function installerSettings() {
  try {
    const response = await fetch(chrome.runtime.getURL('bridge-instance.json'), { cache: 'no-store' });
    if (!response.ok) return;
    const { port, token } = await response.json();
    if (typeof token === 'string' && /^[0-9a-f]{32}$/u.test(token)) return settings({ enabled: true, port, token, uid: '' });
  } catch { /* The extension may have been installed without the Windows launcher. */ }
}

export const bridgeReady = Promise.all([chrome.storage.local.get(settingsKey), installerSettings()]).then(([stored, local]) => {
  installed = local;
  const saved = stored[settingsKey];
  if (saved) apply(settings(saved, installed));
  else apply(installed ?? { enabled: true, port: 9696, uid: '', token: '' });
}).catch(() => {});

export async function configureBridge(input) {
  await bridgeReady;
  const previous = input.port === config.port && config.token ? config : installed;
  const next = settings(input, previous);
  const saved = { ...next };
  if (installed?.port === saved.port && installed.token === saved.token) delete saved.token;
  await chrome.storage.local.set({ [settingsKey]: saved });
  apply(next);
}

export function bridgeStatus(room = '') {
  const accounts = new Map();
  if (room) {
    for (const { room: origin, uid, username } of [...history.values()].reverse()) {
      if (origin !== room || !username || !roomPattern.test(uid) || accounts.has(uid)) continue;
      accounts.set(uid, { uid, username });
      if (accounts.size >= 30) break;
    }
  }
  return { enabled: config.enabled, port: config.port, uid: config.uid, hasToken: Boolean(config.token), state, received, lastRoom,
    managed: Boolean(installed?.port === config.port && installed.token === config.token), accounts: [...accounts.values()] };
}

export function bridgePassword() { return config.token; }

export function bridgeHistory(room, seconds) {
  if (!config.enabled || (state !== 'connected' && !history.size)) return undefined;
  const now = Date.now();
  const cutoff = now - seconds * 1000;
  trimHistory(now);
  return [...history.values()].filter((event) => event.room === room && event.time >= cutoff)
    .map(({ time, text, sender }) => ({ time, text, sender }));
}

export function requireBridge() {
  if (state !== 'connected') throw new Error('Event Bridge 未连接，请运行安装脚本并查看插件的「Event Bridge」设置。');
  if (!config.uid) throw new Error('请在插件的「Event Bridge」设置中选择 Chat 发送账号，或填写 B 站 UID。');
}

export function expectBridgeEcho(room, text) {
  requireBridge();
  pendingEcho?.finish('cancelled');
  const echo = { room, text: echoText(text), uid: config.uid, started: Date.now(), sawOtherUid: false };
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => echo.finish(echo.sawOtherUid ? 'uid' : 'timeout'), echoTimeout);
    echo.finish = (outcome) => {
      clearTimeout(timer);
      if (pendingEcho === echo) pendingEcho = undefined;
      resolve(outcome);
    };
  });
  pendingEcho = echo;
  return { result, cancel: () => echo.finish('cancelled') };
}
