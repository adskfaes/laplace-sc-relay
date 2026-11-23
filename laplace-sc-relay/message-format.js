(() => {
  'use strict';

  const defaults = {
    prefix: '【', suffix: '】', limit: 20, split: true, interval: 2000,
    duplicateWindow: 60, duplicateThreshold: 100, allowDuplicateOverride: true
  };
  const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
  const sentenceEnd = /[。！？!?；;…\n]/u;
  const clauseEnd = /[，、：,.:\s]/u;

  function splitMessage(text, options, inputLimit = Infinity) {
    const source = text.replace(/\r\n?/gu, '\n').replace(/[^\S\n]+/gu, ' ').trim();
    if (!source) throw new Error('这条 SC 没有可发送的正文。');

    const { prefix, suffix, split } = options;
    const limit = Math.min(options.limit, inputLimit);
    const capacity = limit - prefix.length - suffix.length;
    if (capacity < 1) throw new Error('前后缀已占满单条弹幕的长度。');
    const singleLine = source.replace(/\s+/gu, ' ');
    if (singleLine.length <= capacity) return [prefix + singleLine + suffix];
    if (!split) throw new Error('这条 SC 超出单条长度。可在设置中开启分段。');

    const units = Array.from(graphemes.segment(source), ({ segment }) => segment);
    const result = [];
    for (let start = 0; start < units.length;) {
      let end = start;
      let length = 0;
      let sentence = start;
      let clause = start;
      while (end < units.length && length + units[end].length <= capacity) {
        const unit = units[end++];
        length += unit.length;
        if (sentenceEnd.test(unit)) sentence = end;
        if (clauseEnd.test(unit)) clause = end;
      }

      if (end === start) throw new Error('单条可用长度无法容纳正文中的一个字符。');
      if (end < units.length) {
        const boundary = sentence > start ? sentence : clause;
        if (boundary > start) end = boundary;
      }
      const part = units.slice(start, end).join('').replace(/\s+/gu, ' ').trim();
      if (part) result.push(prefix + part + suffix);
      start = end;
      while (start < units.length && /^\s+$/u.test(units[start])) start++;
    }
    return result;
  }

  globalThis.LaplaceScFormat = { defaults, splitMessage };
})();
