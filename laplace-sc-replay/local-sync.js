import { BilibiliSessionError, captureBrowserAccount, verifyCookies } from './bilibili.js';
import { formatToken, LoginSyncClient, parseToken } from './vendor/login-sync/index.js';

const localHost = 'http://127.0.0.1:18188';
const stateKey = 'lscLocalAccounts';
const hex = (bytes) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
const decodeHex = (value) => Uint8Array.from(value.match(/../gu), (byte) => Number.parseInt(byte, 16));
const signal = () => AbortSignal.timeout(6500);

async function configuration() {
  try {
    const response = await fetch(chrome.runtime.getURL('local-instance.json'), { cache: 'no-store' });
    if (response.ok) return await response.json();
  } catch { /* The local installer has not provisioned this extension directory. */ }
  throw new Error('本机 Login Sync 尚未安装。请运行「Install-SC-Relay.cmd」后重新加载扩展。');
}

async function service() {
  const { requestKey } = await configuration();
  const send = (url, init) => fetch(url, { ...init, cache: 'no-store', credentials: 'omit', redirect: 'error' });
  const headers = { 'X-LSC-Install': requestKey };
  try {
    const response = await send(`${localHost}/health`, { headers, signal: signal() });
    if (response.ok && (await response.json()).service === 'laplace-sc-login-sync') {
      return new LoginSyncClient({ baseURL: localHost, authKey: requestKey, headers, fetch: send });
    }
  } catch { /* Show a single service status for missing and unreachable servers. */ }
  throw new Error('无法连接本机 Login Sync。请运行「Install-SC-Relay.cmd」启动服务。');
}

async function openToken(token) {
  let credentials;
  try {
    credentials = parseToken(token);
    if (credentials.uuid.length > 128) throw new Error();
  } catch {
    throw new Error('请填入完整的本机 Login Sync 身份密钥。');
  }
  const client = await service();
  try {
    const { payload } = await client.pull(credentials, { signal: signal() });
    return { credentials, payload };
  } catch (error) {
    if (error.code === 'not_found') throw new Error('本机未找到此密钥的同步记录，请用对应 B 站账号重新生成密钥。');
    if (error.code === 'bad_credentials') throw new Error('身份密钥无法解密这份记录，请检查是否填写完整。');
    throw new Error('未能从本机 Login Sync 读取凭据，请检查本机服务后重试。');
  }
}

async function storageKey() {
  const { storageKey } = await configuration();
  return crypto.subtle.importKey('raw', decodeHex(storageKey), 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealToken(token) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await storageKey(), new TextEncoder().encode(token));
  return { iv: hex(iv), encrypted: hex(new Uint8Array(encrypted)) };
}

async function unsealToken(record) {
  try {
    const opened = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decodeHex(record.iv) },
      await storageKey(), decodeHex(record.encrypted));
    return new TextDecoder().decode(opened);
  } catch {
    throw new Error('无法打开保存的本机身份密钥。请保留原安装配置，或重新生成并记录密钥。');
  }
}

async function state() {
  return (await chrome.storage.local.get(stateKey))[stateKey] || { records: [], activeId: null };
}

function saveState(value) {
  return chrome.storage.local.set({ [stateKey]: value });
}

function savedRecord(current, id) {
  const record = current.records.find((item) => item.id === id);
  if (!record) throw new Error('请选择一条已记录的本机账号密钥。');
  return record;
}

function readAccount(payload) {
  return verifyCookies(Object.values(payload.cookie_data).flat());
}

async function writeSnapshot(client, payload, credentials) {
  try {
    await client.push(payload, credentials, { version: 2, signal: signal() });
  } catch {
    throw new Error('未能写入本机 Login Sync，请检查本机服务后重试。');
  }
}

export async function generateLocalKey(tabId) {
  const client = await service();
  const { account, payload } = await captureBrowserAccount(tabId);
  const credentials = { uuid: hex(crypto.getRandomValues(new Uint8Array(16))), password: hex(crypto.getRandomValues(new Uint8Array(32))) };
  await writeSnapshot(client, payload, credentials);
  return { token: formatToken(credentials), name: account.name };
}

export async function recordLocalKey(token) {
  const { credentials, payload } = await openToken(token);
  const { uid, name } = await readAccount(payload);
  const current = await state();
  const record = { mode: 'local', id: credentials.uuid, uid, name, ...await sealToken(formatToken(credentials)) };
  const records = [...current.records.filter((item) => item.id !== record.id), record];
  await saveState({ records, activeId: record.id });
  return record;
}

export async function listLocalAccounts() {
  return (await state()).records;
}

export async function currentLocalAccount() {
  const { records, activeId } = await state();
  return records.find((record) => record.id === activeId);
}

export async function loadLocalAccount(record) {
  const { payload } = await openToken(await unsealToken(record));
  let account;
  try {
    account = await readAccount(payload);
  } catch (error) {
    if (!(error instanceof BilibiliSessionError)) throw error;
    throw new Error(`${error.message} 然后在「发送账号」点击「更新会话」。`);
  }
  if (record.uid !== account.uid) throw new Error('此密钥对应的 B 站 UID 已变化，请重新核对并记录密钥。');
  return account;
}

export async function checkLocalAccount(id) {
  return loadLocalAccount(savedRecord(await state(), id));
}

export async function refreshLocalAccount(id, tabId) {
  const record = savedRecord(await state(), id);
  const client = await service();
  const credentials = parseToken(await unsealToken(record));
  const { account, payload } = await captureBrowserAccount(tabId);
  if (record.uid !== account.uid) {
    throw new Error(`当前窗口登录的是 UID ${account.uid}，选中的是 UID ${record.uid}。请登录选中的账号后再更新。`);
  }
  await writeSnapshot(client, payload, credentials);
  return record;
}

export async function activateLocalAccount(id) {
  const current = await state();
  const record = savedRecord(current, id);
  await loadLocalAccount(record);
  await saveState({ ...current, activeId: id });
  return record;
}

export async function clearActiveLocalAccount() {
  const current = await state();
  if (current.activeId) await saveState({ ...current, activeId: null });
}

export async function removeLocalAccount(id) {
  const current = await state();
  const record = savedRecord(current, id);
  const client = await service();
  const credentials = parseToken(await unsealToken(record));
  try {
    await client.remove(credentials, { signal: signal() });
  } catch (error) {
    if (error.code !== 'not_found') throw new Error('本机同步记录未能删除，请检查服务后重试。');
  }
  await saveState({ records: current.records.filter((item) => item.id !== id),
    activeId: current.activeId === id ? null : current.activeId });
}
