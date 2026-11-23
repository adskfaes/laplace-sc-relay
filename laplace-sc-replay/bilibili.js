import { LoginSyncClient, parseToken } from './vendor/login-sync/index.js';
import { md5 } from './vendor/login-sync/md5.js';

const navEndpoint = 'https://api.bilibili.com/x/web-interface/nav';
const roomEndpoint = 'https://api.live.bilibili.com/room/v1/Room/room_init';
const sendEndpoint = 'https://api.live.bilibili.com/msg/send';
const liveOrigin = 'https://live.bilibili.com';
const cookieNames = new Set(['SESSDATA', 'bili_jct', 'DedeUserID', 'DedeUserID__ckMd5', 'buvid3',
  'buvid4', 'b_nut', 'b_lsid', 'sid']);
const ruleId = 1;
const requestTimeout = 12000;
const syncHost = 'https://login-sync.laplace.cn';

export class BilibiliSessionError extends Error {}

// An interoperable WBI query uses the same permutation as the web client.
const wbiOrder = [46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13];

function wbiQuery(images) {
  const img = images?.img_url?.match(/\/([a-f\d]{32})\.[^/?]+(?:\?.*)?$/iu)?.[1];
  const sub = images?.sub_url?.match(/\/([a-f\d]{32})\.[^/?]+(?:\?.*)?$/iu)?.[1];
  if (!img || !sub) return '';
  const key = img + sub;
  const mixin = wbiOrder.map((index) => key[index]).join('');
  const query = `web_location=444.8&wts=${Math.round(Date.now() / 1000)}`;
  const digest = md5(new TextEncoder().encode(query + mixin));
  const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `?${query}&w_rid=${signature}`;
}

function cookiesForUrl(cookies, url) {
  const { hostname, pathname } = new URL(url);
  const now = Date.now() / 1000;
  const matched = cookies.filter((cookie) => {
    const domain = typeof cookie.domain === 'string' ? cookie.domain.toLowerCase().replace(/^\./u, '') : '';
    const path = typeof cookie.path === 'string' ? cookie.path : '/';
    const isLive = cookie.expirationDate === undefined || cookie.expirationDate > now;
    const domainMatches = domain && (hostname === domain || (!cookie.hostOnly && hostname.endsWith(`.${domain}`)));
    const pathMatches = pathname === path || pathname.startsWith(path.endsWith('/') ? path : `${path}/`);
    return isLive && domainMatches && pathMatches && !cookie.partitionKey && cookieNames.has(cookie.name) &&
      typeof cookie.value === 'string' && /^[\x21-\x7e]+$/u.test(cookie.value) && !cookie.value.includes(';');
  }).sort((a, b) => (b.path?.length || 1) - (a.path?.length || 1) || Number(Boolean(b.hostOnly)) - Number(Boolean(a.hostOnly)));

  const selected = new Map();
  for (const cookie of matched) {
    if (!selected.has(cookie.name)) selected.set(cookie.name, cookie.value);
  }
  return selected;
}

function sessionHeader(cookies) {
  return Array.from(cookies, ([name, value]) => `${name}=${value}`).join('; ');
}

async function authenticatedRequest(url, cookies, options = {}, room) {
  if (!cookies.has('SESSDATA')) throw new Error('B 站登录会话不可用，请重新绑定发送账号。');
  const headers = [{ header: 'cookie', operation: 'set', value: sessionHeader(cookies) }];
  if (room) {
    headers.push(
      { header: 'origin', operation: 'set', value: liveOrigin },
      { header: 'referer', operation: 'set', value: `${liveOrigin}/${room}` }
    );
  }

  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId],
    addRules: [{
      id: ruleId,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: headers },
      condition: {
        urlFilter: `|${url}|`,
        isUrlFilterCaseSensitive: true,
        initiatorDomains: [chrome.runtime.id],
        resourceTypes: ['xmlhttprequest'],
        requestMethods: [options.method === 'POST' ? 'post' : 'get']
      }
    }]
  });
  try {
    return await fetch(url, { ...options, credentials: 'omit', redirect: 'error', cache: 'no-store',
      signal: AbortSignal.timeout(requestTimeout) });
  } finally {
    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId] });
  }
}

async function readJson(response) {
  if (!response.ok) throw new Error(`B 站返回 HTTP ${response.status}。`);
  const result = await response.json();
  if (typeof result?.code !== 'number') throw new Error('B 站返回了无法识别的结果。');
  return result;
}

function syncError(error) {
  const messages = {
    invalid_token: '请使用 Login Sync 的完整同步密钥。',
    bad_credentials: '密钥无法解密同步数据，请检查是否复制完整。',
    not_found: '同步服务上没有此密钥的数据，请先在 Login Sync 执行同步。',
    unauthorized: '同步服务器拒绝读取。请提供服务端读取授权，或改用已登录的 B 站会话。',
    unsupported_version: '此 Login Sync 数据版本需要更新扩展。',
    malformed: '同步数据格式无效，请在 Login Sync 重新同步。',
    network_error: '无法连接 Login Sync 同步服务器。'
  };
  if (error?.code === 'server_error' && error.status === 403) {
    return 'Login Sync 同步服务器拒绝访问（HTTP 403）。请检查 Login Sync 本身能否正常同步。';
  }
  return messages[error?.code] || (error?.status ? `Login Sync 同步服务器返回 HTTP ${error.status}。` :
    '未能读取 Login Sync 数据，请检查网络和同步状态。');
}

async function loadSyncedAccount(token, authKey) {
  let data;
  try {
    const syncClient = new LoginSyncClient({
      baseURL: syncHost,
      authKey,
      fetch: (url, init) => fetch(url, { ...init, cache: 'no-store', credentials: 'include', redirect: 'error' })
    });
    ({ payload: data } = await syncClient.pull(parseToken(token), { signal: AbortSignal.timeout(requestTimeout) }));
  } catch (error) {
    throw new Error(syncError(error));
  }
  const cookies = Object.values(data.cookie_data).flat();
  return verifyAccount(
    cookiesForUrl(cookies, navEndpoint),
    cookiesForUrl(cookies, sendEndpoint),
    cookiesForUrl(cookies, roomEndpoint),
    '同步数据缺少有效的 B 站会话，请用发送账号重新同步。'
  );
}

export async function listBrowserSessions() {
  const granted = await chrome.permissions.contains({ permissions: ['cookies'] });
  if (!granted) return { granted, sessions: [] };

  const stores = await chrome.cookies.getAllCookieStores();
  const sessions = await Promise.all(stores.map(async ({ id, tabIds }) => {
    const tab = tabIds.length > 0 ? await chrome.tabs.get(tabIds[0]).catch(() => null) : null;
    return { id, label: tab ? (tab.incognito ? '无痕窗口' : '普通窗口') : `浏览器会话 ${id}` };
  }));
  return { granted, sessions };
}

async function browserCookies(storeId, tabId) {
  if (!await chrome.permissions.contains({ permissions: ['cookies'] })) {
    throw new Error('请先授权扩展读取所选窗口的 B 站登录会话。');
  }
  const stores = await chrome.cookies.getAllCookieStores();
  const store = stores.find((store) => storeId === undefined ? store.tabIds.includes(tabId) : store.id === storeId);
  if (!store) {
    throw new Error('所选浏览器会话已关闭或不可用。请打开对应窗口后重新绑定。');
  }
  const cookies = new Map();
  for (const cookie of (await Promise.all([navEndpoint, sendEndpoint, roomEndpoint].flatMap((url) =>
    Array.from(cookieNames, (name) => chrome.cookies.get({ url, storeId: store.id, name })))))) {
    if (!cookie || cookie.partitionKey) continue;
    const key = JSON.stringify([cookie.name, cookie.domain, cookie.path]);
    const previous = cookies.get(key);
    if (previous && previous.value !== cookie.value) throw new Error('读取期间 B 站会话发生变化，请重新试一次。');
    cookies.set(key, cookie);
  }
  return [...cookies.values()];
}

export function verifyCookies(cookies) {
  return verifyAccount(cookiesForUrl(cookies, navEndpoint), cookiesForUrl(cookies, sendEndpoint),
    cookiesForUrl(cookies, roomEndpoint), '未找到完整的 B 站登录会话。请登录要使用的账号后重新生成或绑定。');
}

export async function captureBrowserAccount(tabId) {
  const cookies = await browserCookies(undefined, tabId);
  const account = await verifyCookies(cookies);
  return { account, payload: { cookie_data: { 'bilibili.com': cookies } } };
}

export async function loadAccount(source) {
  if (source.mode === 'browser') return verifyCookies(await browserCookies(source.storeId));
  return loadSyncedAccount(source.token, source.authKey);
}

async function verifyAccount(navCookies, liveCookies, roomCookies, missingSessionMessage) {
  if (!liveCookies.has('SESSDATA') || !liveCookies.has('bili_jct')) {
    throw new BilibiliSessionError(missingSessionMessage);
  }

  if (navCookies.get('SESSDATA') !== liveCookies.get('SESSDATA') || roomCookies.get('SESSDATA') !== liveCookies.get('SESSDATA')) {
    throw new Error('账号查询与直播接口的会话不一致，请重新登录或同步发送账号。');
  }
  const nav = await readJson(await authenticatedRequest(navEndpoint, navCookies));
  const uid = String(nav.data?.mid ?? '');
  if (nav.code === -101) {
    throw new BilibiliSessionError('B 站返回账号未登录（-101）。请重新登录要发送弹幕的账号。');
  }
  if (nav.code !== 0) {
    throw new Error(`B 站登录校验返回代码 ${nav.code}，请稍后重试。`);
  }
  if (nav.data?.isLogin === false) {
    throw new BilibiliSessionError('B 站返回未登录。请重新登录要发送弹幕的账号。');
  }
  if (nav.data?.isLogin !== true || !/^[1-9]\d*$/u.test(uid)) {
    throw new Error('B 站登录校验未返回有效的账号 UID，请稍后重试。');
  }
  if (liveCookies.has('DedeUserID') && liveCookies.get('DedeUserID') !== uid) {
    throw new Error('弹幕会话与 B 站返回的 UID 不一致，请重新登录或同步发送账号。');
  }
  return { uid, name: String(nav.data?.uname || uid).slice(0, 60), liveCookies, roomCookies, wbi: nav.data.wbi_img };
}

export async function resolveRoom(account, room) {
  const url = `${roomEndpoint}?id=${room}`;
  const response = await readJson(await authenticatedRequest(url, account.roomCookies));
  const canonical = String(response.data?.room_id ?? '');
  if (response.code !== 0 || !/^[1-9]\d*$/u.test(canonical)) throw new Error('B 站未能确认当前直播间房号。');
  return canonical;
}

export async function postDanmaku(account, room, text) {
  const csrf = account.liveCookies.get('bili_jct');
  const fields = {
    msg: text, roomid: room, csrf, csrf_token: csrf,
    bubble: '2', color: '16777215', mode: '1', room_type: '0', jumpfrom: '0',
    reply_mid: '0', reply_attr: '0', replay_dmid: '', statistics: '{"appId":100,"platform":5}',
    fontsize: '25', rnd: String(Math.floor(Date.now() / 1000))
  };
  const body = new FormData();
  for (const [name, value] of Object.entries(fields)) body.append(name, value);

  let result;
  try {
    const url = sendEndpoint + wbiQuery(account.wbi);
    result = await readJson(await authenticatedRequest(url, account.liveCookies, { method: 'POST', body }, room));
  } catch (error) {
    const reason = error?.message?.startsWith('B 站') ? `（${error.message.replace(/。$/u, '')}）` : '';
    throw new Error(`本段发送结果未确认${reason}。请在直播间核对后再试。`);
  }
  if (result.code === 0 && (result.message === 'f' || result.msg === 'f')) {
    throw new Error('这段弹幕被 B 站过滤，未确认对其他观众可见。');
  }
  const message = result.message || result.msg;
  if (result.code !== 0 || message) {
    const reason = String(message || `错误码 ${result.code}`).slice(0, 160);
    throw new Error(`B 站拒绝发送：${reason}`);
  }
}
