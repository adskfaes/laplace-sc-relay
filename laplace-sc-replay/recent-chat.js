(() => {
  'use strict';

  const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

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

  globalThis.LaplaceScRecentChat = { findDuplicate };
})();
