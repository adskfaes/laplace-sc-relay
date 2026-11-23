import { listBrowserSessions, loadAccount, postDanmaku, resolveRoom } from './bilibili.js';
import { activateLocalAccount, checkLocalAccount, clearActiveLocalAccount, currentLocalAccount, generateLocalKey,
  listLocalAccounts, loadLocalAccount, recordLocalKey, refreshLocalAccount, removeLocalAccount } from './local-sync.js';

const accountKey = 'lscSenderAccount';
const recentForwardsKey = 'lscRecentForwards';
const maximumDuplicateWindow = 60 * 60 * 1000;
const accountUrl = chrome.runtime.getURL('account.html');
const dashboardHosts = new Set(['chat.laplace.live', 'laplace.chat']);
const batchLifetime = 60000;
let batch;
let nextPostAt = 0;
let pending = Promise.resolve();

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
  return (await chrome.storage.session.get(accountKey))[accountKey] || await currentLocalAccount();
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

function ownsBatch(message, sender) {
  return batch && batch.id === message.batchId &&
    batch.tabId === sender.tab.id && batch.documentId === sender.documentId;
}

async function handle(message, sender) {
  const isAccountPage = sender.url === accountUrl && sender.origin === new URL(accountUrl).origin;
  const room = dashboardRoom(sender);
  if (sender.id !== chrome.runtime.id || (!isAccountPage && !room)) throw new Error('无法确认扩展请求的来源。');

  if (message.type === 'lsc:account') return { account: visibleAccount(await getAccount()) };
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
      if (batch?.mode === 'local' && batch.accountId === message.id) batch = undefined;
      return { account: visibleAccount(await getAccount()), accounts: (await listLocalAccounts()).map(visibleAccount) };
    }
    batch = undefined;
    await chrome.storage.session.remove(accountKey);
    return { account: visibleAccount(await getAccount()), accounts: (await listLocalAccounts()).map(visibleAccount) };
  }

  if (isAccountPage && message.type === 'lsc:bind') {
    let source;
    if (message.mode === 'browser' && typeof message.storeId === 'string' && message.storeId.length <= 64) {
      source = { mode: 'browser', storeId: message.storeId };
    } else if (message.mode === 'sync' && typeof message.token === 'string' && message.token.length <= 1024 &&
        (message.authKey === undefined || (typeof message.authKey === 'string' && message.authKey.length <= 1024))) {
      source = { mode: 'sync', token: message.token, authKey: message.authKey || undefined };
    } else {
      throw new Error('请选择有效的发送会话，或填写 Login Sync 密钥。');
    }
    const account = await loadAccount(source);
    batch = undefined;
    const binding = { ...source, uid: account.uid, name: account.name };
    await clearActiveLocalAccount();
    await chrome.storage.session.set({ [accountKey]: binding });
    return { account: visibleAccount(binding) };
  }

  if (isAccountPage && message.type === 'lsc:forget') {
    await chrome.storage.session.remove(accountKey);
    await clearActiveLocalAccount();
    batch = undefined;
    return {};
  }

  if (message.type === 'lsc:finish' && room) {
    if (ownsBatch(message, sender)) batch = undefined;
    return {};
  }
  if (!room || room !== message.room) throw new Error('发送请求与当前直播间房号不一致。');
  if (message.type === 'lsc:recent') {
    return { forwards: (await recentForwards()).filter((record) => record.room === room) };
  }
  if (batch && Date.now() - batch.activeAt > batchLifetime) batch = undefined;

  if (message.type === 'lsc:start') {
    if (batch) throw new Error('已有一条 SC 正在转发，请稍后再试。');
    const stored = await getAccount();
    if (!stored) throw new Error('请先在 SC 栏齿轮的「发送账号」中绑定要发弹幕的账号。');
    if (!Number.isInteger(message.interval) || message.interval < 1200 || message.interval > 10000) {
      throw new Error('分段间隔无效，请重新保存设置。');
    }
    const account = await (stored.mode === 'local' ? loadLocalAccount(stored) : loadAccount(stored));
    if (account.uid !== stored.uid) throw new Error('发送会话中的 B 站账号已变更，请在账号设置中重新绑定确认。');
    const canonical = await resolveRoom(account, room);
    const source = typeof message.source === 'string' && message.source.length <= 4096 ? message.source : undefined;
    const total = Number.isInteger(message.total) && message.total > 0 ? message.total : undefined;
    const forwards = (await recentForwards()).filter((record) => record.room === room);
    batch = { id: crypto.randomUUID(), room, canonical, account, mode: stored.mode, accountId: stored.id, tabId: sender.tab.id,
      documentId: sender.documentId, interval: message.interval, next: 0, activeAt: Date.now(), source, total };
    return { batchId: batch.id, account: visibleAccount({ ...stored, name: account.name }), room: canonical, forwards };
  }

  if (message.type !== 'lsc:part' || !ownsBatch(message, sender) || batch.room !== room) {
    throw new Error('本次发送会话已结束，请核对已发送的弹幕后再试。');
  }
  if (message.index !== batch.next || typeof message.text !== 'string' || !message.text.trim() ||
      message.text.length > 80 || /[\x00-\x1f\x7f]/u.test(message.text)) {
    throw new Error('弹幕正文或分段顺序无效。');
  }

  const current = batch;
  const delay = nextPostAt - Date.now();
  if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
  if (batch !== current) throw new Error('发送会话已结束。');
  nextPostAt = Date.now() + current.interval;
  try {
    await postDanmaku(current.account, current.canonical, message.text);
    current.activeAt = Date.now();
    current.next++;
    if (current.source && current.next === current.total) {
      await rememberForward(room, current.source).catch(() => {});
    }
    return {};
  } catch (error) {
    batch = undefined;
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
  if (batch?.tabId === tabId) batch = undefined;
});

chrome.permissions.onRemoved.addListener(({ permissions }) => {
  if (permissions?.includes('cookies') && batch?.mode === 'browser') batch = undefined;
});
