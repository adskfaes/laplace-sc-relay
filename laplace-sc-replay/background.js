import { bridgeHistory, bridgePassword, bridgeReady, bridgeStatus, configureBridge, expectBridgeEcho } from './event-bridge.js';

const recentForwardsKey = 'lscRecentForwards';
const maximumDuplicateWindow = 60 * 60 * 1000;
const connectionUrl = chrome.runtime.getURL('connection.html');
const connectionOrigin = new URL(connectionUrl).origin;
const dashboardHosts = new Set(['chat.laplace.live', 'laplace.chat']);
const batchLifetime = 60000;
let batch;
let nextPostAt = 0;
let pending = Promise.resolve();

function dropBatch() {
  batch?.echo?.cancel();
  batch = undefined;
}

function dashboardRoom(sender) {
  if (sender.frameId !== 0 || !sender.tab?.id || !sender.documentId) return null;
  const url = new URL(sender.url);
  if (url.protocol !== 'https:' || !dashboardHosts.has(url.hostname)) return null;
  return url.pathname.match(/^\/dashboard\/([1-9]\d{0,15})\/?$/u)?.[1] ?? null;
}

async function recentForwards() {
  const { [recentForwardsKey]: records = [] } = await chrome.storage.session.get(recentForwardsKey);
  const cutoff = Date.now() - maximumDuplicateWindow;
  return records.filter((record) => record.time >= cutoff);
}

async function rememberForward(room, text) {
  const records = await recentForwards();
  const other = records.filter((record) => record.room !== room || record.text !== text);
  await chrome.storage.session.set({ [recentForwardsKey]: [...other.slice(-511), { room, text, time: Date.now() }] });
}

async function recentActivity(room, window) {
  const seconds = Number.isInteger(window) && window >= 1 && window <= 3600 ? window : 60;
  const cutoff = Date.now() - seconds * 1000;
  const forwards = (await recentForwards()).filter((record) => record.room === room && record.time >= cutoff)
    .map(({ text, time }) => ({ text: text.normalize('NFC').replace(/\s+/gu, ' ').trim(), time }));
  return [...bridgeHistory(room, seconds), ...forwards];
}

function ownsBatch(message, sender) {
  return batch && batch.id === message.batchId &&
    batch.tabId === sender.tab.id && batch.documentId === sender.documentId;
}

async function handle(message, sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) throw new Error('无法确认扩展请求的来源。');
  const url = new URL(sender.url);
  if (sender.origin === connectionOrigin && `${url.origin}${url.pathname}` === connectionUrl) {
    await bridgeReady;
    if (message.type === 'lsc:bridge-password') return { password: bridgePassword() };
    if (message.type === 'lsc:bridge-save') await configureBridge(message);
    if (message.type === 'lsc:bridge-save' || message.type === 'lsc:bridge-status') {
      return { bridge: bridgeStatus(url.searchParams.get('room')) };
    }
  }

  const room = dashboardRoom(sender);
  if (!room) throw new Error('无法确认扩展请求的来源。');
  if (message.type === 'lsc:bridge-watch') {
    await bridgeReady;
    return {};
  }
  if (message.type === 'lsc:finish') {
    if (ownsBatch(message, sender)) dropBatch();
    return {};
  }
  if (room !== message.room) throw new Error('发送请求与当前直播间房号不一致。');
  if (batch && Date.now() - batch.activeAt > batchLifetime) dropBatch();

  if (message.type === 'lsc:start') {
    if (batch) throw new Error('已有一条 SC 正在转发，请稍后再试。');
    if (!Number.isInteger(message.interval) || message.interval < 1200 || message.interval > 10000) {
      throw new Error('分段间隔无效，请重新保存设置。');
    }
    const source = typeof message.source === 'string' && message.source.length <= 4096 ? message.source : undefined;
    const total = Number.isInteger(message.total) && message.total > 0 ? message.total : 0;
    await bridgeReady;
    const messages = message.force === true ? [] : await recentActivity(room, message.duplicateWindow);
    batch = { id: crypto.randomUUID(), room, tabId: sender.tab.id, documentId: sender.documentId,
      interval: message.interval, next: 0, activeAt: Date.now(), source, total };
    return { batchId: batch.id, messages };
  }

  if (!ownsBatch(message, sender) || batch.room !== room) {
    throw new Error('本次发送会话已结束，请核对已发送的弹幕后再试。');
  }
  const current = batch;
  if (message.type === 'lsc:dashboard-echo' && current.echo && message.index === current.next) {
    const echo = current.echo;
    const outcome = await echo.wait(message.submittedAt);
    if (batch !== current || current.echo !== echo) throw new Error('发送会话已结束，请核对公屏。');
    if (outcome === 'disconnected') throw new Error('Event Bridge 已断开，本段发送结果未确认。请核对公屏后再试。');
    if (outcome !== 'confirmed') throw new Error('Event Bridge 未收到本段回执。请核对公屏和桥接连接后再试。');
    current.activeAt = Date.now();
    current.next++;
    current.echo = undefined;
    if (current.source && current.next === current.total) {
      await rememberForward(room, current.source).catch(() => {});
    }
    return {};
  }
  if (message.type !== 'lsc:part' || current.echo || message.index !== current.next || current.next >= current.total ||
      typeof message.text !== 'string' || !message.text.trim() || message.text.length > 80 || /[\x00-\x1f\x7f]/u.test(message.text)) {
    throw new Error('弹幕正文或分段顺序无效。');
  }

  const delay = nextPostAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (batch !== current) throw new Error('发送会话已结束。');
  current.echo = expectBridgeEcho(room, message.text);
  current.activeAt = Date.now();
  nextPostAt = current.activeAt + current.interval;
  return {};
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('lsc:')) return false;
  const result = pending.then(() => handle(message, sender));
  // Waiting for an event must not block connection settings or batch cancellation.
  if (message.type !== 'lsc:dashboard-echo') pending = result.catch(() => {});
  void result.then((data) => reply({ ok: true, ...data }), (error) => {
    const message = error?.message || '';
    reply({ ok: false, error: /[\u3400-\u9fff]/u.test(message) ? message : '请求失败，请检查 Chat 和 Event Bridge 的连接。' });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (batch?.tabId === tabId) dropBatch();
});

chrome.runtime.onStartup.addListener(() => { void bridgeReady; });
