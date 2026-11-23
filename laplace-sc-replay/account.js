const form = document.querySelector('#binding');
const mode = document.querySelector('#mode');
const store = document.querySelector('#store');
const sessionsButton = document.querySelector('#sessions');
const generate = document.querySelector('#generate');
const localToken = document.querySelector('#local-token');
const toggleKey = document.querySelector('#toggle-key');
const saved = document.querySelector('#saved');
const useSaved = document.querySelector('#use-saved');
const checkSaved = document.querySelector('#check-saved');
const refreshSaved = document.querySelector('#refresh-saved');
const removeSaved = document.querySelector('#remove-saved');
const token = document.querySelector('#token');
const auth = document.querySelector('#auth');
const verify = document.querySelector('#verify');
const forget = document.querySelector('#forget');
const accountLabel = document.querySelector('#account');
const status = document.querySelector('#status');
let account;
let granted = false;
let busy = true;

function setAccount(value) {
  account = value;
  accountLabel.textContent = account ? `${account.name}（UID ${account.uid}）` : '当前会话未绑定发送账号';
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.dataset.error = String(error);
  status.hidden = !message;
}

function render() {
  const local = mode.value === 'local';
  const browsing = mode.value === 'browser';
  const syncing = mode.value === 'sync';
  document.querySelector('#local-settings').hidden = !local;
  document.querySelector('#browser-settings').hidden = !browsing;
  document.querySelector('#sync-settings').hidden = !syncing;
  mode.disabled = busy;
  store.disabled = busy || !granted || store.options.length < 2;
  sessionsButton.disabled = busy;
  sessionsButton.textContent = granted ? '刷新会话' : '读取浏览器会话';
  token.required = syncing;
  token.disabled = busy || !syncing;
  auth.disabled = busy || !syncing;
  localToken.required = local;
  localToken.disabled = busy || !local;
  toggleKey.disabled = busy || !localToken.value;
  generate.disabled = busy;
  saved.disabled = busy || saved.options.length < 2;
  useSaved.disabled = busy || !saved.value || (account?.mode === 'local' && account.id === saved.value);
  checkSaved.disabled = busy || !saved.value;
  refreshSaved.disabled = busy || !saved.value;
  removeSaved.disabled = busy || !saved.value;
  verify.textContent = local ? '验证并记录' : '验证并绑定';
  verify.disabled = busy || (browsing && !store.value) || (local && !localToken.value.trim());
  forget.disabled = busy || !account;
}

async function request(type, data) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有返回结果。');
  return result;
}

async function refreshSessions() {
  const current = store.value || account?.storeId || '';
  const result = await request('lsc:sessions');
  granted = result.granted;
  store.replaceChildren(new Option('请选择', ''), ...result.sessions.map(({ id, label }) => new Option(label, id)));
  if (result.sessions.some(({ id }) => id === current)) store.value = current;
  if (granted && !result.sessions.length) setStatus('当前没有可用的浏览器会话。');
}

function maskKey(masked) {
  localToken.type = masked ? 'password' : 'text';
  toggleKey.textContent = masked ? '显示' : '隐藏';
  toggleKey.setAttribute('aria-pressed', String(!masked));
}

function setLocalAccounts(result) {
  const selected = result.account?.mode === 'local' ? result.account.id : saved.value;
  saved.replaceChildren(new Option(result.accounts.length ? '请选择账号' : '暂无记录', ''),
    ...result.accounts.map(({ id, uid, name }) => new Option(`${name}（UID ${uid}）`, id)));
  if (result.accounts.some(({ id }) => id === selected)) saved.value = selected;
  setAccount(result.account);
}

async function refreshLocalAccounts() {
  setLocalAccounts(await request('lsc:local-accounts'));
}

function notifyAccountChanged() {
  parent.postMessage({ type: 'lsc:account-changed' }, '*');
}

async function update(action) {
  busy = true;
  render();
  try {
    await action();
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    busy = false;
    render();
  }
}

mode.addEventListener('change', () => {
  setStatus('');
  token.value = '';
  auth.value = '';
  localToken.value = '';
  maskKey(true);
  if (mode.value === 'browser') void update(refreshSessions);
  else if (mode.value === 'local') void update(refreshLocalAccounts);
  else render();
});
store.addEventListener('change', render);
saved.addEventListener('change', render);
localToken.addEventListener('input', render);

toggleKey.addEventListener('click', (event) => {
  if (event.isTrusted) maskKey(localToken.type !== 'password');
});

generate.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  void update(async () => {
    setStatus('正在核对当前登录的 B 站账号…');
    if (!await chrome.permissions.request({ permissions: ['cookies'] })) {
      throw new Error('生成密钥前需授权读取 B 站会话。');
    }
    const result = await request('lsc:local-generate');
    maskKey(true);
    localToken.value = result.token;
    setStatus(`已为 ${result.name} 填入密钥。点击「验证并记录」后即可使用。`);
  });
});

checkSaved.addEventListener('click', (event) => {
  if (!event.isTrusted || !saved.value) return;
  void update(async () => {
    setStatus('正在检查保存的会话…');
    const result = await request('lsc:local-check', { id: saved.value });
    setStatus(`${result.name}（UID ${result.uid}）的会话有效。`);
  });
});

refreshSaved.addEventListener('click', (event) => {
  if (!event.isTrusted || !saved.value) return;
  void update(async () => {
    setStatus('正在核对当前登录的账号并更新会话…');
    if (!await chrome.permissions.request({ permissions: ['cookies'] })) {
      throw new Error('更新会话前需授权读取 B 站登录会话。');
    }
    const result = await request('lsc:local-refresh', { id: saved.value });
    setStatus(`已更新 ${result.name}（UID ${result.uid}）的会话。`);
  });
});

for (const [button, type, message] of [
  [useSaved, 'lsc:local-use', '已切换发送账号。'],
  [removeSaved, 'lsc:local-remove', '已删除选中的本机记录。']
]) {
  button.addEventListener('click', (event) => {
    if (!event.isTrusted || !saved.value) return;
    void update(async () => {
      setStatus('');
      setLocalAccounts(await request(type, { id: saved.value }));
      setStatus(message);
      notifyAccountChanged();
    });
  });
}

sessionsButton.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  void update(async () => {
    setStatus('');
    if (!granted && !await chrome.permissions.request({ permissions: ['cookies'] })) {
      setStatus('读取会话需要浏览器授权。', true);
      return;
    }
    await refreshSessions();
  });
});

form.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!event.isTrusted || busy) return;
  if (mode.value === 'local') {
    void update(async () => {
      setStatus('正在验证本机身份密钥…');
      setLocalAccounts(await request('lsc:local-record', { token: localToken.value }));
      localToken.value = '';
      maskKey(true);
      setStatus('已记录密钥并设为发送账号。');
      notifyAccountChanged();
    });
    return;
  }
  const source = mode.value === 'browser' ? { mode: 'browser', storeId: store.value } :
    { mode: 'sync', token: token.value, authKey: auth.value.trim() || undefined };
  void update(async () => {
    setStatus('正在验证 B 站账号…');
    const result = await request('lsc:bind', source);
    token.value = '';
    auth.value = '';
    setAccount(result.account);
    setStatus('验证成功。');
    notifyAccountChanged();
  });
});

forget.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  void update(async () => {
    await request('lsc:forget');
    token.value = '';
    auth.value = '';
    localToken.value = '';
    maskKey(true);
    setAccount(null);
    setStatus('已解除绑定。');
    notifyAccountChanged();
  });
});

new ResizeObserver(([item]) => {
  parent.postMessage({ type: 'lsc:account-size', height: item.borderBoxSize[0].blockSize }, '*');
}).observe(document.querySelector('main'));

void update(async () => {
  setAccount((await request('lsc:account')).account);
  mode.value = account?.mode || 'local';
  if (mode.value === 'browser') await refreshSessions();
  if (mode.value === 'local') await refreshLocalAccounts();
});
