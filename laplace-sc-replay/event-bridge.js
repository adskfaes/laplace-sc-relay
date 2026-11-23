const settingsKey = 'lscEventBridge';
const maxAge = 60 * 60 * 1000;
const maxEvents = 60000;
const echoTimeout = 10000;
const roomPattern = /^[1-9]\d{0,15}$/u;
const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
const echoText = (text) => normalize(text).replace(/[\s\u200b\u2060]/gu, '');

const defaultConnection = { port: 9696, token: '' };
let config = defaultConnection;
let installed;
let socket;
let heartbeat;
let retry;
let retryDelay = 1000;
let state = 'connecting';
const received = new Map();
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
  history.set(key, { room, text, time, receivedAt: now, sender: uid ? `uid:${uid}` : undefined });
  trimHistory(now);
  received.set(room, (received.get(room) ?? 0) + 1);

  const echo = pendingEcho;
  if (echo && room === echo.room && time >= echo.started - 3000 && echoText(text) === echo.text) {
    echo.receivedAt = performance.timeOrigin + performance.now();
    if (echo.receivedAt >= echo.submittedAt) echo.finish('confirmed');
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
    received.clear();
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
  if (socket && next.port === config.port && next.token === config.token && state !== 'disconnected') return;
  const previous = socket;
  socket = undefined;
  previous?.close();
  clearInterval(heartbeat);
  clearTimeout(retry);
  pendingEcho?.finish('disconnected');
  history.clear();
  received.clear();
  retryDelay = 1000;
  config = next;
  connect();
}

function settings(value, previous = {}) {
  const { port } = value;
  const token = value.token || (port === previous.port ? previous.token : '') || '';
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      typeof token !== 'string' ||
      (token && !/^[!#$%&'*+.^_`|~\w-]{1,256}$/u.test(token)) || token === 'laplace-event-bridge-role-client') {
    throw new Error('请检查 Event Bridge 端口和密码格式。');
  }
  return { port, token };
}

function storeConnection(connection) {
  const { port, token } = connection;
  const saved = installed?.port === port && installed.token === token ? { port } : connection;
  return chrome.storage.local.set({ [settingsKey]: saved });
}

async function installerSettings() {
  try {
    const response = await fetch(chrome.runtime.getURL('bridge-instance.json'), { cache: 'no-store' });
    if (!response.ok) return;
    const { port, token } = await response.json();
    if (typeof token === 'string' && /^[0-9a-f]{32}$/u.test(token)) return settings({ port, token });
  } catch { /* The extension may have been installed without the Windows launcher. */ }
}

export const bridgeReady = Promise.all([chrome.storage.local.get(settingsKey), installerSettings()]).then(async ([stored, local]) => {
  installed = local;
  const saved = stored[settingsKey];
  const next = saved && saved.enabled !== false ? settings(saved, installed) : installed ?? defaultConnection;
  apply(next);
  if (saved && (Object.hasOwn(saved, 'uid') || Object.hasOwn(saved, 'enabled'))) await storeConnection(next);
}).catch(() => { if (!socket) apply(installed ?? defaultConnection); });

export async function configureBridge(input) {
  await bridgeReady;
  const previous = input.port === config.port && config.token ? config : installed;
  const next = settings(input, previous);
  await storeConnection(next);
  apply(next);
}

export function bridgeStatus(room = '') {
  return { port: config.port, hasToken: Boolean(config.token), state, received: received.get(room) ?? 0 };
}

export function bridgePassword() { return config.token; }

export function bridgeHistory(room, seconds) {
  const now = Date.now();
  const cutoff = now - seconds * 1000;
  trimHistory(now);
  return [...history.values()].filter((event) => event.room === room && event.time >= cutoff)
    .map(({ time, text, sender }) => ({ time, text, sender }));
}

export function expectBridgeEcho(room, text) {
  if (state !== 'connected') throw new Error('Event Bridge 未连接，请启动本机桥接服务并检查 Chat 和插件的连接。');
  pendingEcho?.finish('cancelled');
  const echo = { room, text: echoText(text), started: Date.now(), submittedAt: Infinity, receivedAt: 0 };
  const result = new Promise((resolve) => {
    const timer = setTimeout(() => echo.finish('timeout'), echoTimeout);
    echo.finish = (outcome) => {
      clearTimeout(timer);
      if (pendingEcho === echo) pendingEcho = undefined;
      resolve(outcome);
    };
  });
  pendingEcho = echo;
  return {
    wait(submittedAt) {
      if (!Number.isFinite(submittedAt) || submittedAt < echo.started - 1000) throw new Error('无法确认 Chat 的提交时间。');
      echo.submittedAt = submittedAt;
      if (echo.receivedAt >= submittedAt) echo.finish('confirmed');
      return result;
    },
    cancel: () => echo.finish('cancelled')
  };
}
