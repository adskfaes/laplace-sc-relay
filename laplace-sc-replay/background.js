import { listBrowserSessions, loadAccount, postDanmaku, resolveRoom } from './bilibili.js';
import { activateLocalAccount, checkLocalAccount, clearActiveLocalAccount, currentLocalAccount, generateLocalKey,
  listLocalAccounts, loadLocalAccount, recordLocalKey, refreshLocalAccount, removeLocalAccount } from './local-sync.js';
import { bridgeHistory, bridgePassword, bridgeReady, bridgeStatus, configureBridge, expectBridgeEcho, requireBridge } from './event-bridge.js';

const accountKey = 'lscSenderAccount';
const recentForwardsKey = 'lscRecentForwards';
const maximumDuplicateWindow = 60 * 60 * 1000;
const accountUrl = chrome.runtime.getURL('account.html');
const accountOrigin = new URL(accountUrl).origin;
const dashboardHosts = new Set(['chat.laplace.live', 'laplace.chat']);
const dashboardAccount = { mode: 'dashboard', name: 'LAPLACE Chat 当前账号' };
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
  try {
    const url = new URL(sender.url);
    if (url.protocol === 'https:' && dashboardHosts.has(url.hostname)) {
      return url.pathname.match(/^\/dashboard\/([1-9]\d{0,15})\/?$/u)?.[1] ?? null;
    }
  } catch { /* No document URL. */ }
  return null;
}

function visibleAccount(account) {
  if (!account) return null;
  const { mode } = account;
  return { uid: account.uid, name: account.name, mode,
    ...(mode === 'browser' ? { storeId: account.storeId } : {}),
    ...(mode === 'local' ? { id: account.id } : {}) };
}

async function getAccount() {
  return (await chrome.storage.session.get(accountKey))[accountKey] || await currentLocalAccount() || dashboardAccount;
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

async function confirmPart(current) {
  current.activeAt = Date.now();
  current.next++;
  current.echo = undefined;
  if (current.source && current.next === current.total) {
    await rememberForward(current.room, current.source).catch(() => {});
  }
}

async function recentActivity(room, window, canonical = room) {
  const seconds = Number.isInteger(window) && window >= 1 && window <= 3600 ? window : 60;
  await bridgeReady;
  const cutoff = Date.now() - seconds * 1000;
  const forwards = (await recentForwards()).filter((record) => record.room === room && record.time >= cutoff)
    .map(({ text, time }) => ({ text: text.normalize('NFC').replace(/\s+/gu, ' ').trim(), time }));
  return { forwards, messages: bridgeHistory(canonical, seconds) };
}

function ownsBatch(message, sender) {
  return batch && batch.id === message.batchId &&
    batch.tabId === sender.tab.id && batch.documentId === sender.documentId;
}

async function handle(message, sender) {
  const settingsUrl = sender.origin === accountOrigin && sender.url ? new URL(sender.url) : null;
  const isAccountPage = Boolean(settingsUrl && `${settingsUrl.origin}${settingsUrl.pathname}` === accountUrl);
  const settingsRoom = isAccountPage ? settingsUrl.searchParams.get('room') : null;
  const room = dashboardRoom(sender);
  if (sender.id !== chrome.runtime.id || (!isAccountPage && !room)) throw new Error('无法确认扩展请求的来源。');

  if (message.type === 'lsc:account') {
    const account = visibleAccount(await getAccount());
    await bridgeReady;
    const bridge = bridgeStatus();
    return { account, needsBridgeSetup: account.mode === 'dashboard' && (!bridge.uid || bridge.state !== 'connected') };
  }
  if (message.type === 'lsc:bridge-watch' && room) {
    await bridgeReady;
    return { bridgeOnly: (await getAccount()).mode === 'dashboard' && bridgeStatus().enabled };
  }
  if (isAccountPage && message.type === 'lsc:bridge-status') {
    await bridgeReady;
    return { bridge: bridgeStatus(settingsRoom) };
  }
  if (isAccountPage && message.type === 'lsc:bridge-password') {
    await bridgeReady;
    return { password: bridgePassword() };
  }
  if (isAccountPage && message.type === 'lsc:bridge-save') {
    await configureBridge(message);
    if (batch?.mode === 'dashboard') dropBatch();
    return { bridge: bridgeStatus(settingsRoom) };
  }
  if (isAccountPage && message.type === 'lsc:sessions') return listBrowserSessions();
  if (isAccountPage && message.type === 'lsc:local-accounts') {
    return { accounts: (await listLocalAccounts()).map(visibleAccount), account: visibleAccount(await getAccount()) };
  }
  if (isAccountPage && message.type === 'lsc:local-generate') return generateLocalKey(sender.tab?.id);
  if (isAccountPage && message.type === 'lsc:local-check') {
    const { uid, name } = await checkLocalAccount(message.id);
    return { uid, name };
  }
  if (isAccountPage && message.type === 'lsc:local-refresh') {
    const { uid, name } = await refreshLocalAccount(message.id, sender.tab?.id);
    return { uid, name };
  }
  if (isAccountPage && ['lsc:local-record', 'lsc:local-use', 'lsc:local-remove'].includes(message.type)) {
    if (message.type === 'lsc:local-record') {
      if (typeof message.token !== 'string' || message.token.length > 1024) throw new Error('本机身份密钥无效。');
      await recordLocalKey(message.token);
    } else if (message.type === 'lsc:local-use') {
      await activateLocalAccount(message.id);
    } else {
      await removeLocalAccount(message.id);
      if (batch?.mode === 'local' && batch.accountId === message.id) dropBatch();
      return { account: visibleAccount(await getAccount()), accounts: (await listLocalAccounts()).map(visibleAccount) };
    }
    dropBatch();
    await chrome.storage.session.remove(accountKey);
    return { account: visibleAccount(await getAccount()), accounts: (await listLocalAccounts()).map(visibleAccount) };
  }

  if (isAccountPage && message.type === 'lsc:bind') {
    let source;
    if (message.mode === 'dashboard') {
      source = dashboardAccount;
    } else if (message.mode === 'browser' && typeof message.storeId === 'string' && message.storeId.length <= 64) {
      source = { mode: 'browser', storeId: message.storeId };
    } else if (message.mode === 'sync' && typeof message.token === 'string' && message.token.length <= 1024 &&
        (message.authKey === undefined || (typeof message.authKey === 'string' && message.authKey.length <= 1024))) {
      source = { mode: 'sync', token: message.token, authKey: message.authKey || undefined };
    } else {
      throw new Error('请选择有效的发送会话，或填写 Login Sync 密钥。');
    }
    const account = source.mode === 'dashboard' ? source : await loadAccount(source);
    dropBatch();
    const binding = { ...source, uid: account.uid, name: account.name };
    await clearActiveLocalAccount();
    await chrome.storage.session.set({ [accountKey]: binding });
    return { account: visibleAccount(binding) };
  }

  if (isAccountPage && message.type === 'lsc:forget') {
    await chrome.storage.session.remove(accountKey);
    await clearActiveLocalAccount();
    dropBatch();
    return { account: visibleAccount(await getAccount()) };
  }

  if (message.type === 'lsc:finish' && room) {
    if (ownsBatch(message, sender)) dropBatch();
    return {};
  }
  if (!room || room !== message.room) throw new Error('发送请求与当前直播间房号不一致。');
  if (message.type === 'lsc:recent') {
    return { ...await recentActivity(room, message.duplicateWindow), mode: (await getAccount())?.mode ?? null };
  }
  if (batch && Date.now() - batch.activeAt > batchLifetime) dropBatch();

  if (message.type === 'lsc:start') {
    if (batch) throw new Error('已有一条 SC 正在转发，请稍后再试。');
    const stored = await getAccount();
    if (message.expectedMode !== undefined && message.expectedMode !== stored.mode) {
      throw new Error('发送账号来源已变更，请确认后再试。');
    }
    if (!Number.isInteger(message.interval) || message.interval < 1200 || message.interval > 10000) {
      throw new Error('分段间隔无效，请重新保存设置。');
    }
    let account = stored;
    let canonical = room;
    if (stored.mode === 'dashboard') {
      await bridgeReady;
      requireBridge();
    } else {
      account = await (stored.mode === 'local' ? loadLocalAccount(stored) : loadAccount(stored));
      if (account.uid !== stored.uid) throw new Error('发送会话中的 B 站账号已变更，请在账号设置中重新绑定确认。');
      canonical = await resolveRoom(account, room);
    }
    const source = typeof message.source === 'string' && message.source.length <= 4096 ? message.source : undefined;
    const total = Number.isInteger(message.total) && message.total > 0 ? message.total : undefined;
    const recent = await recentActivity(room, message.duplicateWindow, canonical);
    batch = { id: crypto.randomUUID(), room, canonical, account, mode: stored.mode, accountId: stored.id, tabId: sender.tab.id,
      documentId: sender.documentId, interval: message.interval, next: 0, activeAt: Date.now(), source, total };
    return { batchId: batch.id, account: visibleAccount({ ...stored, name: account.name }), room: canonical, ...recent };
  }

  if (!ownsBatch(message, sender) || batch.room !== room) {
    throw new Error('本次发送会话已结束，请核对已发送的弹幕后再试。');
  }
  if (message.type === 'lsc:dashboard-echo' && batch.echo && message.index === batch.next) {
    const current = batch;
    const outcome = await current.echo.result;
    if (batch !== current) throw new Error('发送会话已结束，请核对公屏。');
    if (outcome === 'uid') throw new Error('Event Bridge 收到同文弹幕，但发送者 UID 不符。请核对 Chat 发送账号和弹幕连接方式。');
    if (outcome === 'disconnected') throw new Error('Event Bridge 已断开，本段发送结果未确认。请核对公屏后再试。');
    if (outcome !== 'confirmed') throw new Error('Event Bridge 未收到本段回执。请核对公屏和桥接事件后再试。');
    await confirmPart(current);
    return {};
  }
  if (message.type !== 'lsc:part' || batch.echo || message.index !== batch.next ||
      (batch.total && batch.next >= batch.total) || typeof message.text !== 'string' || !message.text.trim() ||
      message.text.length > 80 || /[\x00-\x1f\x7f]/u.test(message.text)) {
    throw new Error('弹幕正文或分段顺序无效。');
  }

  const current = batch;
  const delay = nextPostAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (batch !== current) throw new Error('发送会话已结束。');
  nextPostAt = Date.now() + current.interval;
  if (current.mode === 'dashboard') {
    current.echo = expectBridgeEcho(current.canonical, message.text);
    current.activeAt = Date.now();
    return {};
  }
  try {
    await postDanmaku(current.account, current.canonical, message.text);
    await confirmPart(current);
    return {};
  } catch (error) {
    dropBatch();
    throw error;
  }
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (typeof message?.type !== 'string' || !message.type.startsWith('lsc:')) return false;
  const result = pending.then(() => handle(message, sender));
  pending = result.catch(() => {});
  void result.then((data) => reply({ ok: true, ...data }), (error) => {
    const text = error?.message || '';
    const safe = /[\u3400-\u9fff]/u.test(text) ? text : '请求失败，请检查网络和账号设置。';
    reply({ ok: false, error: safe });
  });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (batch?.tabId === tabId) dropBatch();
});

chrome.permissions.onRemoved.addListener(({ permissions }) => {
  if (permissions?.includes('cookies') && batch?.mode === 'browser') dropBatch();
});

chrome.runtime.onStartup.addListener(() => { void bridgeReady; });
