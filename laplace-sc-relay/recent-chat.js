export const normalize = (text) => text.normalize('NFC').replace(/\s+/gu, ' ').trim();
export const compact = (text) => normalize(text).replace(/[\s\u200b\u2060]/gu, '');
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

export function findDuplicate(messages, variants, threshold) {
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

export function comparableMessages(source, parts, prefix, suffix) {
  const bare = parts.map((part) => part.slice(prefix.length, part.length - suffix.length));
  const whole = [source, prefix + normalize(source) + suffix];
  const variants = whole.map((text) => [text]);
  if (parts.length) variants.push(parts, bare);
  return { whole, parts, bare, variants };
}

export function createCoverage({ whole, parts, bare }, maxGap) {
  const completeTexts = new Set(whole.map(compact).filter(Boolean));
  const expected = parts.map((part, index) => new Set([compact(part), compact(bare[index])].filter(Boolean)));
  const distinctive = new Set();
  const matchedIds = new Set();
  let matched = 0;
  let lastMatch = 0;
  let lastDistinctive = -1;
  let covered = false;

  function observe({ id, text, time }, issued = 0) {
    if (covered) return;
    const value = compact(text);
    const isOnlyIssuedPart = issued > 0 && expected.length === 1 && expected[0].has(value);
    if (completeTexts.has(value) && !isOnlyIssuedPart) {
      covered = true;
      return;
    }
    if (!id || expected.length < 2) return;
    if (time - lastMatch > maxGap) {
      matched = 0;
      lastDistinctive = -1;
      distinctive.clear();
      matchedIds.clear();
    }
    if (matchedIds.has(id) || !expected[matched]?.has(value)) return;
    const body = compact(bare[matched]);
    const informative = body.match(/[\p{L}\p{N}\p{Extended_Pictographic}]/gu);
    if (informative?.length >= 4 && new Set(informative).size >= 3) {
      distinctive.add(body);
      lastDistinctive = matched;
    }
    matchedIds.add(id);
    lastMatch = time;
    matched++;
    if (matched === expected.length && matched > issued) covered = true;
  }

  return {
    observe,
    get covered() { return covered; },
    suspect(now, issued) {
      return now - lastMatch <= maxGap && distinctive.size >= 2 && lastDistinctive >= issued;
    }
  };
}
