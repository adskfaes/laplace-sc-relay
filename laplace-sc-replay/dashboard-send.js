(() => {
  'use strict';

  const inputSelector = 'input#bilibili-message-sender';
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function senderInput() {
    return document.querySelector(inputSelector);
  }

  function inputLimit() {
    const limit = senderInput()?.maxLength;
    return limit >= 0 ? limit : Infinity;
  }

  function updateInput(input, value) {
    setValue.call(input, value);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true }));
  }

  function availableInput() {
    const input = senderInput();
    if (!input?.form || input.matches(':disabled, [readonly], [aria-disabled="true"]') ||
        !input.getClientRects().length || getComputedStyle(input).visibility !== 'visible') {
      throw new Error('当前控制台的弹幕发送框不可用，请先开启 LAPLACE Chat 原生弹幕发送。');
    }
    if (input.value !== '') throw new Error('原生弹幕框中有内容，请先处理草稿后再试。');
    return input;
  }

  async function send(text, confirm, checkRoom) {
    checkRoom();
    const input = availableInput();
    const { form } = input;
    if (text.length > inputLimit()) {
      throw new Error(`Chat 原生输入框最多接收 ${input.maxLength} 字符，本段未提交。`);
    }
    let userEdited = false;
    function trackEdit(event) {
      if (event.isTrusted) userEdited = true;
    }
    input.addEventListener('input', trackEdit);
    try {
      updateInput(input, text);
      await wait(0);
      checkRoom();
      if (userEdited || senderInput() !== input || input.form !== form || input.value !== text || !form.checkValidity()) {
        throw new Error('原生发送框内容或状态已改变，本段未提交。');
      }

      const submitter = [...form.elements].find((element) => element.type === 'submit' && !element.matches(':disabled'));
      // Notify the page's submit handler without falling through to an HTML navigation.
      form.dispatchEvent(new SubmitEvent('submit', { bubbles: true, cancelable: true, submitter }));
      await confirm();
      checkRoom();
    } finally {
      input.removeEventListener('input', trackEdit);
      if (!userEdited && senderInput() === input && input.value === text) updateInput(input, '');
    }
  }

  globalThis.LaplaceScDashboardSend = { availableInput, inputLimit, send };
})();
