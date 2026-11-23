(() => {
  'use strict';

  const rowSelector = '.event--message, [data-event-type="message"]';
  const panelSelector = '#message-panel, #danmaku-panel, [data-panel="message"], [data-panel-id="message"], .panel-list--message';
  const viewportSelector = '[data-virtuoso-scroller], [data-scroll-area-viewport], [data-radix-scroll-area-viewport], [data-overlayscrollbars-viewport]';
  const timeSelector = 'time, .timestamp, .event-time, .event-timestamp, [data-timestamp], [data-time]';
  const positionSelector = '[data-index], [data-item-index]';
  const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

  function parseTime(value, now) {
    const text = value?.trim();
    if (!text) return undefined;
    if (/^\d{10}$/u.test(text)) return Number(text) * 1000;
    if (/^\d{13}$/u.test(text)) return Number(text);
    if (/^\d{4}[-/]\d{1,2}[-/]\d{1,2}[T ]\d{1,2}:\d{2}/u.test(text)) {
      const time = Date.parse(text);
      if (Number.isFinite(time)) return time;
    }
    if (/^(?:刚刚|剛剛|just now)$/iu.test(text)) return now;
    const relative = text.match(/^(\d+)\s*(秒|分钟|分鐘|小时|小時|天)前$/u) ||
      text.match(/^(\d+)\s*(seconds?|minutes?|hours?|days?)\s+ago$/iu);
    if (!relative) return undefined;
    const unit = relative[2].toLowerCase();
    const seconds = /^(?:秒|second)/u.test(unit) ? 1 : /^(?:分钟|分鐘|minute)/u.test(unit) ? 60 :
      /^(?:小时|小時|hour)/u.test(unit) ? 3600 : 86400;
    return now - Number(relative[1]) * seconds * 1000;
  }

  function timestampOf(row, now) {
    const candidates = [row.dataset.timestamp, row.dataset.time, row.title];
    for (const node of row.querySelectorAll(timeSelector)) {
      candidates.push(node.getAttribute('datetime'), node.dataset.timestamp, node.dataset.time, node.title, node.textContent);
    }
    for (const candidate of candidates) {
      const time = parseTime(candidate, now);
      if (time !== undefined) return time;
    }
    return undefined;
  }

  function timelineRows(root) {
    return [...root.querySelectorAll(rowSelector)].filter((row) =>
      !row.closest('[role="dialog"], [role="menu"], [data-lsc-ui]'));
  }

  function chatList() {
    const panel = document.querySelector(panelSelector);
    const first = timelineRows(panel || document)[0];
    const viewport = first?.closest(viewportSelector) || panel?.querySelector(viewportSelector);
    if (viewport) return viewport;
    for (let node = first?.parentElement; node && node !== document.body; node = node.parentElement) {
      if (/^(?:auto|scroll)$/u.test(getComputedStyle(node).overflowY)) return node;
    }
    return panel || first?.closest('.panel-list--card') || first?.parentElement || null;
  }

  function positionOf(row, list) {
    const indexed = row.closest(positionSelector);
    if (!indexed || !list.contains(indexed)) return undefined;
    const value = indexed.dataset.index ?? indexed.dataset.itemIndex;
    return /^-?\d+$/u.test(value) ? Number(value) : undefined;
  }

  function createRecentChat(readBody) {
    const history = new Map();
    const samples = new WeakMap();
    let room;
    let previousList;
    let previousTail;
    let previousAtEnd = false;

    function sample(row, list) {
      const id = row.dataset.eventId || row.id;
      const name = row.querySelector('.username-text') || row.querySelector('.username, [data-username]');
      const username = row.dataset.username || name?.dataset.username || name?.textContent;
      const uid = row.dataset.uid || row.querySelector('[data-uid]')?.dataset.uid;
      const sender = uid ? `uid:${uid}` : username?.trim();
      const body = row.querySelector('.message-text') || row.querySelector('.message, [data-event-message]');
      const visibleText = body?.textContent;
      const position = positionOf(row, list);
      const previous = samples.get(row);
      if (previous && previous.id === id && previous.body === body && previous.visibleText === visibleText &&
          previous.sender === sender && previous.position === position) return previous;
      const record = { room, id, sender, body, visibleText, position, text: normalize(readBody(row)), seen: false };
      samples.set(row, record);
      return record;
    }

    function observe(roomId, seconds) {
      if (room !== roomId) {
        history.clear();
        room = roomId;
        previousList = null;
        previousTail = null;
        previousAtEnd = false;
      }
      if (!roomId) return;

      const now = Date.now();
      const cutoff = now - seconds * 1000;
      for (const [key, item] of history) {
        if (item.time < cutoff) history.delete(key);
      }

      const list = chatList();
      const rows = list ? timelineRows(list) : [];
      const atEnd = Boolean(list && list.scrollHeight - list.clientHeight - list.scrollTop <= 48);
      const canObserveAppend = list && list === previousList && previousAtEnd;
      const items = rows.map((row) => sample(row, list));
      let liveStart = items.length;
      if (canObserveAppend && previousTail) {
        const anchor = items.findLastIndex((item) => item === previousTail ||
          (item.id && item.id === previousTail.id && item.text === previousTail.text && item.sender === previousTail.sender));
        if (anchor >= 0) liveStart = anchor + 1;
        else if (atEnd && previousTail.position !== undefined) {
          const firstNew = items.findIndex((item) => item.position > previousTail.position);
          if (firstNew >= 0 && items.slice(firstNew).every((item) => item.position > previousTail.position)) liveStart = firstNew;
        }
      } else if (canObserveAppend && atEnd && items.length === 1) {
        liveStart = 0;
      }

      for (let index = 0; index < items.length; index++) {
        const item = items[index];
        if (item.room !== roomId || !item.text) continue;
        if (item.time === undefined) {
          const published = timestampOf(rows[index], now);
          if (published !== undefined) {
            item.time = published;
            item.key = item.id ? JSON.stringify([item.id, item.sender, item.text]) :
              JSON.stringify([published, item.sender, item.text]);
          } else if (!item.seen && index >= liveStart) {
            item.time = now;
            item.key = item.id ? JSON.stringify([item.id, item.sender, item.text]) : item;
          }
        }
        item.seen = true;
        if (item.time === undefined || item.time < cutoff || item.time > now) continue;
        if (!history.has(item.key)) history.set(item.key, { time: item.time, text: item.text, sender: item.sender });
      }
      previousList = list;
      previousTail = items.at(-1);
      previousAtEnd = atEnd;
    }

    function recent(roomId, seconds, forwards = []) {
      observe(roomId, seconds);
      const cutoff = Date.now() - seconds * 1000;
      return [...history.values(), ...forwards.filter(({ time }) => time >= cutoff)
        .map(({ time, text }) => ({ time, text: normalize(text) }))];
    }

    return { observe, recent };
  }

  function editDistance(left, right) {
    let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
    let current = new Array(previous.length);
    for (let row = 1; row <= left.length; row++) {
      current[0] = row;
      for (let column = 1; column <= right.length; column++) {
        const substitution = Number(left[row - 1] !== right[column - 1]);
        current[column] = Math.min(previous[column] + 1, current[column - 1] + 1, previous[column - 1] + substitution);
      }
      [previous, current] = [current, previous];
    }
    return previous[right.length];
  }

  function findDuplicate(messages, variants, threshold) {
    const characters = new Map();
    let best = null;
    let ordered;

    function tokens(text) {
      if (!characters.has(text)) characters.set(text, Array.from(segmenter.segment(text), ({ segment }) => segment));
      return characters.get(text);
    }

    function compare(expected, actual) {
      if (expected.every((part, index) => part === actual[index])) {
        best = 100;
        return;
      }
      const minimum = best ?? threshold;
      if (minimum === 100) return;

      let length = 0;
      let lengthDifference = 0;
      const pairs = [];
      for (let index = 0; index < expected.length; index++) {
        const left = tokens(expected[index]);
        const right = tokens(actual[index]);
        length += Math.max(left.length, right.length);
        lengthDifference += Math.abs(left.length - right.length);
        if (left !== right) pairs.push([left, right]);
      }
      const budget = (100 - minimum) * length;
      if (100 * lengthDifference > budget) return;

      let edits = 0;
      for (const [left, right] of pairs) {
        edits += editDistance(left, right);
        if ((100 * (length - edits)) / length < minimum) return;
      }
      best = (100 * (length - edits)) / length;
    }

    for (const parts of variants) {
      const expected = parts.map(normalize);
      if (expected.length === 1) {
        if (!expected[0]) continue;
        for (const { text } of messages) {
          compare(expected, [text]);
          if (best === 100) return best;
        }
        continue;
      }

      ordered ??= [...messages].sort((a, b) => a.time - b.time);
      const bySender = new Map();
      for (const { sender, text } of ordered) {
        if (!sender) continue;
        if (!bySender.has(sender)) bySender.set(sender, []);
        const latest = bySender.get(sender);
        latest.push(text);
        if (latest.length > expected.length) latest.shift();
        if (latest.length !== expected.length) continue;
        compare(expected, latest);
        if (best === 100) return best;
      }
    }
    return best;
  }

  globalThis.LaplaceScRecentChat = { createRecentChat, findDuplicate };
})();
