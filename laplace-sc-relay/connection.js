const bridgeForm = document.querySelector('#bridge-form');
const bridgeStatus = document.querySelector('#bridge-status');
const bridgeStart = document.querySelector('#bridge-start');
const bridgeStartStatus = document.querySelector('#bridge-start-status');
const bridgeAddressPort = document.querySelector('#bridge-address-port');
const bridgePort = document.querySelector('#bridge-port');
const bridgeToken = document.querySelector('#bridge-token');
const bridgeCopy = document.querySelector('#bridge-copy');
const bridgeAdvanced = document.querySelector('#bridge-advanced');
const bridgeSave = document.querySelector('#bridge-save');
const copyStatus = document.querySelector('#copy-status');
let refreshing = false;
let starting = false;
let connected = false;

if (new URLSearchParams(location.search).get('chat') === 'ready') {
  document.querySelector('#chat-status').textContent = '已检测到原生发送框，将使用 Chat 当前账号。';
  document.querySelector('#chat-settings').hidden = true;
}

async function request(type, data) {
  const result = await chrome.runtime.sendMessage({ type, ...data });
  if (!result?.ok) throw new Error(result?.error || '扩展后台没有返回连接状态。');
  return result;
}

function showStatus(node, text, error = false) {
  node.textContent = text;
  node.dataset.error = String(error);
  node.hidden = false;
}

function renderBridge({ port, hasToken, state, received }, fill = false) {
  connected = state === 'connected';
  bridgeStart.disabled = starting || connected;
  if (connected) bridgeStartStatus.hidden = true;
  if (fill) {
    bridgePort.value = port;
    bridgeToken.value = '';
  }
  bridgeAddressPort.textContent = port;
  bridgeCopy.hidden = !hasToken;
  bridgeToken.placeholder = hasToken ? '留空保留当前密码' : '填写服务端密码（如有）';
  const messages = {
    connecting: '正在连接本机桥接…',
    disconnected: '本机桥接未连接。请启动服务，并核对端口和密码。',
    connected: received ? `桥接已连接 · 本房间收到 ${received.toLocaleString()} 条弹幕` :
      '桥接已连接 · 等待本房间弹幕。请确认 Chat 也已连接到桥接。'
  };
  showStatus(bridgeStatus, messages[state], state === 'disconnected');
}

async function refreshBridge(fill = false) {
  if (refreshing || (!fill && bridgeSave.disabled)) return;
  refreshing = true;
  try {
    const { bridge } = await request('lsc:bridge-status');
    if (fill || !bridgeSave.disabled) renderBridge(bridge, fill);
  } catch (error) {
    if (fill || !bridgeSave.disabled) showStatus(bridgeStatus, error.message, true);
  } finally {
    refreshing = false;
    if (fill) {
      bridgeSave.disabled = false;
      bridgeStart.disabled = starting || connected;
    }
  }
}

bridgeStart.addEventListener('click', async (event) => {
  if (!event.isTrusted || bridgeStart.disabled) return;
  starting = true;
  bridgeStart.disabled = true;
  showStatus(bridgeStartStatus, '正在启动本机桥接…');
  try {
    const granted = await chrome.permissions.request({ permissions: ['nativeMessaging'] });
    if (!granted) {
      showStatus(bridgeStartStatus, '浏览器未授权启动本机桥接。', true);
      return;
    }
    const { bridge, startedPort } = await request('lsc:bridge-start');
    renderBridge(bridge);
    if (!connected) {
      if (startedPort === bridge.port) showStatus(bridgeStartStatus, '本机桥接服务已启动。');
      else showStatus(bridgeStartStatus, `本机桥接已在端口 ${startedPort} 启动。插件当前使用端口 ${bridge.port}。`, true);
    }
  } catch (error) {
    showStatus(bridgeStartStatus, error.message, true);
  } finally {
    starting = false;
    bridgeStart.disabled = connected;
  }
});

bridgeForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!event.isTrusted || bridgeSave.disabled) return;
  bridgeSave.disabled = true;
  showStatus(bridgeStatus, '正在保存连接…');
  try {
    const { bridge } = await request('lsc:bridge-save', { port: bridgePort.valueAsNumber, token: bridgeToken.value.trim() });
    renderBridge(bridge, true);
  } catch (error) {
    showStatus(bridgeStatus, error.message, true);
  } finally {
    bridgeSave.disabled = false;
  }
});

bridgeCopy.addEventListener('click', async (event) => {
  if (!event.isTrusted) return;
  try {
    const { password } = await request('lsc:bridge-password');
    if (!password) return;
    try {
      await navigator.clipboard.writeText(password);
      showStatus(copyStatus, '密码已复制，可粘贴到 Chat 原生 Event Bridge 设置。');
    } catch {
      bridgeAdvanced.open = true;
      bridgeToken.type = 'text';
      bridgeToken.value = password;
      bridgeToken.focus();
      bridgeToken.select();
      showStatus(copyStatus, '已选中桥接密码，按 Ctrl+C 复制。');
    }
  } catch (error) {
    showStatus(copyStatus, error.message, true);
  }
});

bridgeToken.addEventListener('blur', () => { bridgeToken.type = 'password'; });

new ResizeObserver(([item]) => {
  parent.postMessage({ type: 'lsc:connection-size', height: item.borderBoxSize[0].blockSize }, '*');
}).observe(document.querySelector('main'));

void refreshBridge(true);
setInterval(refreshBridge, 2500);
