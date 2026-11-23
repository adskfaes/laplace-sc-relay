(() => {
  'use strict';

  const rowSelector = '.event--superchat, [data-event-type="superchat"]';
  const bodySelector = '.message-text, .message, [data-event-message]';
  const nativeReadSelector = '.read, [data-read="true"]';
  const regionSelector = '#superchat-panel, [data-panel="superchat"], [data-panel-id="superchat"]';
  const icons = {
    send: 'M22 2 9.5 14.5M22 2 15 22l-5.5-7.5L2 9l20-7Z',
    settings: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm-2-6h4l.6 2.7 1.7 1 2.7-.8 2 3.5-2 1.9v2.4l2 1.9-2 3.5-2.7-.8-1.7 1-.6 2.7h-4l-.6-2.7-1.7-1-2.7.8-2-3.5 2-1.9v-2.4l-2-1.9 2-3.5 2.7.8 1.7-1L10 2Z',
    close: 'm6 6 12 12M18 6 6 18',
    done: 'm5 12 4 4L19 6',
    waiting: 'M12 5v7l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
    error: 'M12 8v4m0 4h.01M10.2 4.8 2.7 18a1.4 1.4 0 0 0 1.2 2h16.2a1.4 1.4 0 0 0 1.2-2L13.8 4.8a2 2 0 0 0-3.6 0Z'
  };
  const { defaults, splitMessage } = globalThis.LaplaceScFormat;
  const dashboardSend = globalThis.LaplaceScDashboardSend;
  const buttonSelector = 'button, [role="button"]';
  const settingsKey = 'laplaceScRelay';
  const previousSettingsKey = 'laplaceScReplay';
  const noticeDuration = 6500;
  const sendLabel = '发送为普通弹幕';
  const coveredLabel = '已覆盖 · 公屏已有完整内容';
  let settings = { ...defaults };
  let sending = false;
  let toastTimer;
  let toastAnimation;
  let duplicateOverride;
  let scanTimer;
  const mountedRows = new Set();
  const pendingReads = new Map();
  const stoppedRows = new Map();
  const fallbackReads = new WeakMap();
  const route = () => location.pathname.match(/^\/dashboard\/([1-9]\d*)\/?$/u)?.[1];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function setIcon(button, icon, label) {
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', icons[icon]);
    svg.append(path);
    button.replaceChildren(svg);
    button.title = label;
    button.setAttribute('aria-label', label);
    button.dataset.lscState = icon;
  }

  function iconButton(icon, label, className = '') {
    const button = element('button', `lsc-icon ${className}`.trim());
    button.type = 'button';
    button.dataset.lscUi = '';
    setIcon(button, icon, label);
    button.addEventListener('dblclick', (event) => event.stopPropagation());
    return button;
  }

  const gear = iconButton('settings', 'SC 转发设置', 'lsc-gear');
  gear.setAttribute('aria-haspopup', 'dialog');
  const toolbar = element('span', 'lsc-toolbar');
  toolbar.dataset.lscUi = '';
  toolbar.append(gear);
  const toast = element('div', 'lsc-toast');
  toast.dataset.lscUi = '';
  toast.setAttribute('role', 'status');
  toast.hidden = true;
  document.body.append(toast);

  function takeDuplicateOverride() {
    const pending = duplicateOverride;
    duplicateOverride = undefined;
    pending?.row.classList.remove('lsc-duplicate-pending');
    return pending;
  }

  function dismissNotice() {
    clearTimeout(toastTimer);
    toastAnimation?.cancel();
    toastAnimation = undefined;
    toast.hidden = true;
    const pending = takeDuplicateOverride();
    if (pending?.covered) completeRow(pending.row, pending.button, pending.original, pending.status);
    else if (pending && isSameRow(pending.row, pending.original)) setIcon(pending.button, 'error', pending.status);
  }

  function announce(text, detail) {
    dismissNotice();
    toast.replaceChildren(text);
    toast.classList.toggle('lsc-toast-duplicate', Boolean(detail));
    if (detail) toast.append(element('span', 'lsc-toast-detail', detail));
    toast.hidden = false;
    if (detail && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
      toastAnimation = toast.animate([
        { opacity: 0 }, { opacity: 1, offset: .025 }, { opacity: 1, offset: .94 }, { opacity: 0 }
      ], { duration: noticeDuration, fill: 'both' });
    }
    toastTimer = setTimeout(dismissNotice, noticeDuration);
  }

  function messageElement(row) {
    return row.querySelector('.message-text') || row.querySelector(bodySelector);
  }

  function readBody(row) {
    const body = messageElement(row);
    if (!body) return '';
    const copy = body.cloneNode(true);
    for (const node of copy.querySelectorAll('[data-lsc-ui], script, style, [hidden]')) node.remove();
    for (const image of copy.querySelectorAll('img')) image.replaceWith(image.getAttribute('alt') || '');
    for (const line of copy.querySelectorAll('br')) line.replaceWith('\n');
    return copy.textContent.trim();
  }

  function eventKey(row, room) {
    const id = row.getAttribute('data-event-id') || row.getAttribute('data-superchat-id') || row.id;
    return id && JSON.stringify([room, id]);
  }

  function identifyRow(row, room, text) {
    return { key: eventKey(row, room), room, text, body: messageElement(row), header: row.querySelector('.top')?.textContent };
  }

  function isSameRow(row, original) {
    if (!row.isConnected || !row.matches(rowSelector) || route() !== original.room) return false;
    if (original.key) return eventKey(row, original.room) === original.key && readBody(row) === original.text;
    return messageElement(row) === original.body && row.querySelector('.top')?.textContent === original.header &&
      readBody(row) === original.text;
  }

  function markRead(row, original) {
    if (row.matches(nativeReadSelector)) return;
    const target = messageElement(row) || row;
    target.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true, view: window, detail: 2 }));

    // Show the result even when the dashboard ignores the generated double-click.
    if (isSameRow(row, original) && !row.matches(nativeReadSelector)) {
      fallbackReads.set(row, original);
      row.classList.add('lsc-forwarded');
    }
  }

  function showResult(button, icon, status) {
    setIcon(button, icon, status);
    const result = button.firstChild;
    setTimeout(() => {
      if (button.firstChild === result) setIcon(button, 'send', sendLabel);
    }, 4500);
  }

  function completeRow(row, button, original, status) {
    if (original.key) stoppedRows.delete(original.key);
    if (isSameRow(row, original)) {
      showResult(button, 'done', status);
      markRead(row, original);
      return;
    }
    setIcon(button, 'send', sendLabel);
    if (original.key) {
      pendingReads.set(original.key, original.text);
      scheduleScan();
    }
  }

  function showStopped(row, button, original, status) {
    if (original.key) stoppedRows.set(original.key, { text: original.text, status });
    if (isSameRow(row, original)) setIcon(button, 'error', status);
    else setIcon(button, 'send', sendLabel);
  }

  function showInterruption(row, button, original, decision, options, submitted, confirmed, total) {
    const covered = decision.state === 'covered';
    let status = covered ? coveredLabel : '疑似重复';
    if (decision.reason === 'first-part') status += ' · 公屏已出现首段';
    if (decision.reason === 'sequence') status += ' · 有人可能在继续转发';
    const progress = submitted ? `已确认 ${confirmed}/${total} 段` : '';
    const allowOverride = !submitted && options.allowDuplicateOverride && isSameRow(row, original);
    const detail = [decision.score !== undefined ? `相似度 ${Math.floor(decision.score)}%` : '', progress,
      allowOverride ? '双击纸飞机仍可转发' : ''].filter(Boolean).join(' · ');
    const stoppedStatus = [status, decision.score !== undefined ? `相似度 ${Math.floor(decision.score)}%` : '', progress]
      .filter(Boolean).join(' · ');
    announce(status, detail);
    if (!covered) showStopped(row, button, original, stoppedStatus);
    if (allowOverride) {
      duplicateOverride = { row, button, original, covered, status: stoppedStatus, expires: performance.now() + noticeDuration, started: false };
      row.classList.add('lsc-duplicate-pending');
      setIcon(button, 'send', '双击强制转发这条 SC');
    } else if (covered) completeRow(row, button, original, status);
  }

  function isVisible(node) {
    return Boolean(node?.getClientRects().length);
  }

  function mountInHeader(header) {
    if (toolbar.parentElement === header) return;
    const last = header.lastElementChild;
    if (last && (last.matches(buttonSelector) || last.querySelector(buttonSelector))) {
      last.before(toolbar);
    } else {
      header.append(toolbar);
    }
  }

  function placeSettings(firstRow) {
    const region = [...document.querySelectorAll(regionSelector)].find(isVisible);
    const header = region?.querySelector('header, [data-panel-header]') ||
      [...document.querySelectorAll('header, h2, h3, [role="heading"]')].find((node) =>
        isVisible(node) && /^(?:醒目留言(?:面板)?|Super\s?Chats?|SC)$/iu.test(node.textContent.trim()));
    if (header) {
      mountInHeader(header);
      return;
    }

    let list = firstRow?.closest('[data-virtuoso-scroller], [data-scroll-area-viewport], [data-radix-scroll-area-viewport]');
    for (let node = firstRow?.parentElement; !list && node && node !== document.body; node = node.parentElement) {
      if (/^(?:auto|scroll)$/u.test(getComputedStyle(node).overflowY)) list = node;
    }

    for (let node = list, depth = 0; node && node !== document.body && depth < 4; node = node.parentElement, depth++) {
      const previous = node.previousElementSibling;
      if (previous === toolbar) return;
      if (!isVisible(previous) || previous.querySelector(rowSelector)) continue;
      const bar = previous.getBoundingClientRect();
      const viewport = node.getBoundingClientRect();
      if (bar.height > 0 && bar.height <= 72 && Math.abs(bar.right - viewport.right) < 24 &&
          Math.abs(bar.bottom - viewport.top) < 24 && getComputedStyle(previous).display.includes('flex')) {
        mountInHeader(previous);
        return;
      }
    }

    if (list) {
      if (list.previousElementSibling !== toolbar) list.before(toolbar);
    } else if (region) {
      if (toolbar.parentElement !== region) region.prepend(toolbar);
    } else if (firstRow && !toolbar.isConnected) {
      firstRow.before(toolbar);
    } else if (!firstRow && !region) {
      toolbar.remove();
    }
  }

  function setSending(active) {
    sending = active;
    for (const row of mountedRows) {
      const button = row.querySelector('.lsc-send');
      if (button) button.disabled = active;
    }
    gear.disabled = active;
  }

  async function request(type, data) {
    let result;
    try {
      result = await chrome.runtime.sendMessage({ type, ...data });
    } catch {
      throw new Error('无法连接扩展后台，请刷新控制台后再试。');
    }
    if (!result?.ok) throw new Error(result?.error || '扩展后台没有返回结果。');
    return result;
  }

  async function sendRow(row, button, override) {
    if (sending || !row.matches(rowSelector) || (override && !isSameRow(row, override))) return;
    const room = route();
    if (!room) {
      announce('请打开单房间控制台后发送。');
      return;
    }

    const text = readBody(row);
    if (!text) return;
    const original = identifyRow(row, room, text);
    if (original.key) stoppedRows.delete(original.key);
    const options = settings;
    let sent = 0;
    let submitted = false;
    let awaitingReceipt = false;
    let batchId;
    let total;
    setSending(true);
    setIcon(button, 'waiting', '正在发送');

    function checkTarget() {
      if (route() !== room) throw new Error('控制台房间已变更，发送已停止。');
    }

    try {
      let parts = [];
      let formatError;
      try {
        parts = splitMessage(text, options, dashboardSend.inputLimit());
      } catch (error) {
        formatError = error;
      }
      total = parts.length;
      const batch = await request('lsc:start', { room, interval: options.interval, source: text, parts,
        prefix: options.prefix, suffix: options.suffix, threshold: options.duplicateThreshold,
        duplicateWindow: options.duplicateWindow, force: Boolean(override) });
      batchId = batch.batchId;
      checkTarget();
      if (batch.decision) {
        showInterruption(row, button, original, batch.decision, options, submitted, sent, total);
        return;
      }
      if (formatError) throw formatError;
      dashboardSend.availableInput();
      for (const part of parts) {
        if (sent > 0) await new Promise((resolve) => setTimeout(resolve, options.interval));
        checkTarget();
        setIcon(button, 'waiting', `提交前复查 ${sent + 1}/${total}`);
        const result = await dashboardSend.send(part, () => request('lsc:part', { room, batchId, index: sent }), (submittedAt) => {
          submitted = true;
          awaitingReceipt = true;
          setIcon(button, 'waiting', `等待 Event Bridge 回执 ${sent + 1}/${total}`);
          return request('lsc:dashboard-echo', { room, batchId, index: sent, submittedAt });
        }, checkTarget);
        awaitingReceipt = false;
        checkTarget();
        if (result.state !== 'confirmed') {
          showInterruption(row, button, original, result, options, submitted, sent, total);
          return;
        }
        sent++;
      }
      const status = `已确认 ${total} 条弹幕`;
      completeRow(row, button, original, status);
      announce(status);
    } catch (error) {
      const progress = sent > 0 ? `已确认 ${sent}/${total} 条。` : '';
      const status = `${awaitingReceipt ? '结果未知 · ' : ''}${progress}${error.message}`;
      showStopped(row, button, original, status);
      announce(status);
    } finally {
      if (batchId) await request('lsc:finish', { room, batchId }).catch(() => {});
      setSending(false);
    }
  }

  function scan() {
    scanTimer = null;
    const room = route();
    const pending = duplicateOverride;
    if (pending && (!isSameRow(pending.row, pending.original) || !pending.row.contains(pending.button))) dismissNotice();
    for (const row of mountedRows) {
      const fallback = fallbackReads.get(row);
      if (fallback && (row.matches(nativeReadSelector) || !isSameRow(row, fallback))) {
        fallbackReads.delete(row);
        row.classList.remove('lsc-forwarded');
      }
      if (!row.isConnected || !row.matches(rowSelector)) {
        row.querySelector('.lsc-send')?.remove();
        mountedRows.delete(row);
      }
    }

    const rows = [...document.querySelectorAll(rowSelector)];
    for (const row of rows) {
      const key = room && pendingReads.size ? eventKey(row, room) : null;
      const pendingText = pendingReads.get(key);
      if (pendingText && pendingText === readBody(row)) {
        pendingReads.delete(key);
        markRead(row, identifyRow(row, room, pendingText));
        if (!row.isConnected) continue;
      }
      if (row.querySelector('.lsc-send') || !row.querySelector(bodySelector)) continue;
      const button = iconButton('send', sendLabel, 'lsc-send');
      const stopped = room && stoppedRows.get(eventKey(row, room));
      if (stopped && !row.matches(nativeReadSelector) && readBody(row) === stopped.text) setIcon(button, 'error', stopped.status);
      const top = row.querySelector('.top');
      if (top) {
        if (getComputedStyle(top).position === 'static') top.classList.add('lsc-card-top');
        button.classList.add('lsc-corner');
        top.append(button);
      } else {
        row.append(button);
      }
      button.disabled = sending;
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (!event.isTrusted || sending || event.detail > 1) return;
        const pending = duplicateOverride;
        if (pending?.button === button && isSameRow(row, pending.original)) {
          if (event.detail === 1) pending.started = true;
          return;
        }
        if (pending) {
          const target = identifyRow(row, route(), readBody(row));
          dismissNotice();
          if (!isSameRow(row, target)) return;
        }
        void sendRow(row, button);
      });
      button.addEventListener('dblclick', (event) => {
        const pending = duplicateOverride;
        // The click that opened the notice cannot count toward the second gesture.
        if (!event.isTrusted || sending || pending?.button !== button || !pending.started ||
            performance.now() >= pending.expires || !isSameRow(row, pending.original)) return;
        takeDuplicateOverride();
        dismissNotice();
        void sendRow(row, button, pending.original);
      });
      mountedRows.add(row);
    }
    placeSettings(rows.find(isVisible));
  }

  function scheduleScan() {
    if (!scanTimer) scanTimer = setTimeout(scan, 180);
  }

  const dialog = element('dialog', 'lsc-dialog');
  dialog.dataset.lscUi = '';
  dialog.setAttribute('aria-label', 'SC 转发设置');
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    if (!dialog.open) dialog.replaceChildren();
  });

  const connectionUrl = chrome.runtime.getURL('connection.html');
  const connectionOrigin = new URL(connectionUrl).origin;

  window.addEventListener('message', (event) => {
    const frame = dialog.querySelector('.lsc-connection-frame');
    if (!frame || event.source !== frame.contentWindow || event.origin !== connectionOrigin) return;
    if (event.data?.type === 'lsc:connection-size' && Number.isFinite(event.data.height)) {
      frame.style.height = `${Math.min(600, Math.max(72, Math.ceil(event.data.height)))}px`;
    }
  });

  async function saveSettings(value) {
    await chrome.storage.local.set({ [settingsKey]: value });
    settings = value;
  }

  function showSettings() {
    const form = element('form', 'lsc-form');
    const title = element('header', 'lsc-dialog-header');
    const close = iconButton('close', '关闭设置');
    close.addEventListener('click', () => dialog.close());
    title.append(element('h2', '', 'SC 转发设置'), close);

    const frame = element('iframe', 'lsc-connection-frame');
    frame.title = 'Chat 和 Event Bridge 连接';
    frame.allow = 'clipboard-write';
    const url = new URL(connectionUrl);
    const room = route();
    if (room) url.searchParams.set('room', room);
    if (dashboardSend.hasInput()) url.searchParams.set('chat', 'ready');
    frame.src = url.href;

    function field(name, text, type, attributes = {}) {
      const label = element('label', 'lsc-field');
      const input = element('input');
      input.name = name;
      input.type = type;
      for (const [key, value] of Object.entries(attributes)) input.setAttribute(key, value);
      if (type === 'checkbox') input.checked = settings[name];
      else input.value = settings[name];
      label.append(element('span', '', text), input);
      form.append(label);
      return input;
    }

    const prefix = field('prefix', '前缀', 'text', { maxlength: 80, placeholder: '【' });
    const suffix = field('suffix', '后缀', 'text', { maxlength: 80, placeholder: '】' });
    const split = field('split', '长文自动分段', 'checkbox');
    const limit = field('limit', '单条长度', 'number', { min: 1, max: 80, required: '' });
    const interval = field('interval', '分段间隔（毫秒）', 'number', { min: 1200, max: 10000, step: 100, required: '' });
    const duplicateWindow = field('duplicateWindow', '查重时长（秒）', 'number', { min: 1, max: 3600, required: '' });
    const duplicateThreshold = field('duplicateThreshold', '查重相似度（%）', 'number', { min: 1, max: 100, required: '' });
    const allowDuplicateOverride = field('allowDuplicateOverride', '提示期间可双击强制发送', 'checkbox');
    const save = iconButton('done', '保存设置');
    save.type = 'submit';
    const footer = element('footer', 'lsc-dialog-footer');
    footer.append(save);
    form.append(footer);
    for (const input of [prefix, suffix, limit]) {
      input.addEventListener('input', () => limit.setCustomValidity(''));
    }
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const length = limit.valueAsNumber;
      if (prefix.value.length + suffix.value.length >= length) {
        limit.setCustomValidity('请缩短前后缀，或提高单条长度。');
        limit.reportValidity();
        return;
      }
      save.disabled = true;
      try {
        await saveSettings({ prefix: prefix.value, suffix: suffix.value, split: split.checked,
          limit: length, interval: interval.valueAsNumber, duplicateWindow: duplicateWindow.valueAsNumber,
          duplicateThreshold: duplicateThreshold.valueAsNumber, allowDuplicateOverride: allowDuplicateOverride.checked });
        dialog.close();
      } catch {
        announce('保存设置失败。');
      } finally {
        save.disabled = false;
      }
    });
    dialog.replaceChildren(title, frame, form);
    dialog.showModal();
  }

  gear.addEventListener('click', (event) => {
    event.stopPropagation();
    if (!event.isTrusted) return;
    dismissNotice();
    showSettings();
  });

  chrome.storage.local.get([settingsKey, previousSettingsKey]).then(async (stored) => {
    const saved = stored[settingsKey] ?? stored[previousSettingsKey];
    settings = { ...settings, ...saved };
    if (stored[settingsKey] === undefined && saved) await chrome.storage.local.set({ [settingsKey]: saved });
  }).catch(() => announce('读取 SC 转发设置失败。')).finally(() => {
    const observer = new MutationObserver(scheduleScan);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true,
      attributeFilter: ['class', 'hidden', 'aria-hidden', 'data-event-type', 'id', 'data-event-id', 'data-superchat-id', 'data-read',
        'data-index', 'data-item-index'] });
    scan();
  });
  if (route()) void request('lsc:bridge-watch').catch(() => {});
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[settingsKey]) {
      settings = { ...defaults, ...changes[settingsKey].newValue };
      if (!settings.allowDuplicateOverride && duplicateOverride) dismissNotice();
    }
  });
})();
