import { bridgeHistory, bridgePassword, bridgeReady, bridgeSession, bridgeStatus, configureBridge, expectBridgeEcho,
  onBridgeMessage, reconnectBridge } from './event-bridge.js';
import { comparableMessages, createCoverage, findDuplicate, normalize } from './recent-chat.js';

const recentForwardsKey = 'lscRecentForwards';
const maximumDuplicateWindow = 60 * 60 * 1000;
const connectionUrl = chrome.runtime.getURL('connection.html');
const connectionOrigin = new URL(connectionUrl).origin;
const dashboardHosts = new Set(['chat.laplace.live', 'laplace.chat']);
const batchLifetime = 60000;
const observationWindow = 300;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let batch;
let nextPostAt = 0;
let pending = Promise.resolve();
let bridgeStartup;

async function startLocalBridge() {
  const host = `com.laplace_sc_relay.${chrome.runtime.id}`;
  const result = await chrome.runtime.sendNativeMessage(host, { action: 'start' }).catch((error) => {
    if (/not found|access.*forbidden/iu.test(error.message)) {
      throw new Error('未找到本机启动器。请从当前安装目录重新运行 Install-SC-Relay.cmd（Edge 使用 -Browser Edge）。');
    }
    throw new Error('无法调用本机启动器。请重新运行 Install-SC-Relay.cmd。');
  });
  if (!result?.ok || !Number.isInteger(result.port) || result.port < 1 || result.port > 65535) {
    throw new Error('启动本机桥接失败。请运行 Start-SC-Event-Bridge.cmd 查看错误。');
  }
  if (bridgeStatus().port === result.port) reconnectBridge();
  return result.port;
}

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
    .map(({ text, time }) => ({ text: normalize(text), time }));
  return [...bridgeHistory(room, seconds), ...forwards];
}

onBridgeMessage((event) => {
  const current = batch;
  if (!current?.coverage || event.room !== current.room || bridgeSession() !== current.session ||
      event.time < current.started - 3000) return;
  current.coverage.observe({ ...event, time: event.receivedAt }, current.next + Number(Boolean(current.echo)));
  if (current.coverage.covered) current.echo?.cover();
  if (current.threshold < 100 && !current.next && !current.echo) current.newMessages.push(event);
});

function validPart(text) {
  return typeof text === 'string' && text.length <= 80 && text.trim() && !/[\x00-\x1f\x7f]/u.test(text);
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
    if (message.type === 'lsc:bridge-start') {
      bridgeStartup ??= startLocalBridge().finally(() => { bridgeStartup = undefined; });
      const startedPort = await bridgeStartup;
      return { bridge: bridgeStatus(url.searchParams.get('room')), startedPort };
    }
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
    const { source, parts, prefix, suffix, threshold } = message;
    if (typeof source !== 'string' || !source.trim() || source.length > 4096 ||
        !Array.isArray(parts) || parts.length > 4096 || !parts.every(validPart) ||
        typeof prefix !== 'string' || typeof suffix !== 'string' || prefix.length + suffix.length > 80 ||
        !Number.isInteger(threshold) || threshold < 1 || threshold > 100) throw new Error('弹幕正文或转发设置无效。');
    await bridgeReady;
    const started = Date.now();
    const session = bridgeSession();
    const force = message.force === true;
    const match = comparableMessages(source, parts, prefix, suffix);
    const coverage = force ? null : createCoverage(match, Math.max(10000, message.interval * 2 + 2000));
    let decision;
    if (coverage) {
      const messages = await recentActivity(room, message.duplicateWindow);
      const now = Date.now();
      for (const event of messages.sort((a, b) => a.time - b.time)) {
        coverage.observe({ ...event, time: Math.min(event.time, now) });
        if (coverage.covered) break;
      }
      if (coverage.covered) decision = { state: 'covered' };
      else {
        const score = findDuplicate(messages, match.variants, threshold);
        if (score !== null) decision = { state: 'suspected', score };
      }
    }
    batch = { id: crypto.randomUUID(), room, tabId: sender.tab.id, documentId: sender.documentId,
      interval: message.interval, next: 0, activeAt: Date.now(), source, parts, match, started, session, coverage,
      threshold, newMessages: [] };
    return { batchId: batch.id, decision };
  }

  if (!ownsBatch(message, sender) || batch.room !== room) {
    throw new Error('本次发送会话已结束，请核对已发送的弹幕后再试。');
  }
  const current = batch;
  if (message.type === 'lsc:dashboard-echo' && current.echo && message.index === current.next) {
    const echo = current.echo;
    const outcome = await echo.wait(message.submittedAt);
    if (batch !== current || current.echo !== echo) throw new Error('发送会话已结束，请核对公屏。');
    if (outcome === 'covered' || current.coverage?.covered) return { state: 'covered' };
    if (outcome === 'disconnected') throw new Error('Event Bridge 已断开，本段发送结果未确认。请核对公屏后再试。');
    if (outcome !== 'confirmed') throw new Error('Event Bridge 未收到本段回执。请核对公屏和桥接连接后再试。');
    current.activeAt = Date.now();
    current.next++;
    current.echo = undefined;
    if (current.next === current.parts.length) {
      await rememberForward(room, current.source).catch(() => {});
    }
    return { state: 'confirmed' };
  }
  if (message.type !== 'lsc:part' || current.echo || message.index !== current.next || current.next >= current.parts.length) {
    throw new Error('弹幕正文或分段顺序无效。');
  }

  const firstCheck = !current.next && current.coverage ? current.activeAt + observationWindow : 0;
  const delay = Math.max(firstCheck, nextPostAt) - Date.now();
  if (delay > 0) await wait(delay);
  if (current.coverage?.suspicion(Date.now(), current.next) && !current.coverage.covered) await wait(observationWindow);
  if (batch !== current) throw new Error('发送会话已结束。');
  if (current.coverage?.covered) return { state: 'covered' };
  const suspicion = current.coverage?.suspicion(Date.now(), current.next);
  if (suspicion) return { state: 'suspected', reason: suspicion };
  if (!current.next && current.newMessages.length) {
    const score = findDuplicate(current.newMessages, current.match.variants, current.threshold);
    if (score !== null) return { state: 'suspected', score };
    current.newMessages = [];
  }
  if (current.session === null || bridgeSession() !== current.session) {
    throw new Error('Event Bridge 未连续连接，本段未提交。请检查连接后再试。');
  }
  current.echo = expectBridgeEcho(room, current.parts[current.next]);
  current.activeAt = Date.now();
  nextPostAt = current.activeAt + current.interval;
  return { state: 'send' };
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('lsc:')) return false;
  const startingBridge = message.type === 'lsc:bridge-start';
  const result = startingBridge ? handle(message, sender) : pending.then(() => handle(message, sender));
  // Bridge startup and echo waits must not block status requests or batch cancellation.
  if (!startingBridge && message.type !== 'lsc:dashboard-echo') pending = result.catch(() => {});
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
