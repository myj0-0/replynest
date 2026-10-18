(function replyNestComposerBridge() {
  'use strict';

  var allowedOrigins = new Set([
    'https://console.replynest.cn',
    'http://localhost:3200',
  ]);
  var uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  var consoleOrigin = 'https://console.replynest.cn';
  var helpCenterUrl = 'https://docs.replynest.cn/';

  function replaceExactText(control, nextText) {
    var walker = document.createTreeWalker(control, NodeFilter.SHOW_TEXT);
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.trim()) {
        node.nodeValue = node.nodeValue.replace(node.nodeValue.trim(), nextText);
        return;
      }
    }
  }

  function refreshProductUi() {
    if (/chatwoot/i.test(document.title)) {
      document.title = document.title.replace(/chatwoot/gi, '答巢 ReplyNest');
    }
    var controls = document.querySelectorAll('a,button,[role="menuitem"]');
    controls.forEach(function (control) {
      var text = (control.textContent || '').trim();
      if (text === '注销' || text === 'Logout' || text === 'Sign out') {
        var chinese = text === '注销';
        control.setAttribute('data-replynest-console-return', 'true');
        control.removeAttribute('href');
        replaceExactText(control, chinese ? '返回答巢控制台' : 'Back to ReplyNest Console');
      } else if (text === '阅读文档' || text === '帮助中心' || text === 'Documentation' || text === 'Docs' || text === 'Help Center') {
        var zh = text === '阅读文档';
        control.setAttribute('data-replynest-help', 'true');
        replaceExactText(control, zh || text === '帮助中心' ? '答巢帮助文档' : 'ReplyNest Help Center');
      } else if (text === '更新日志' || text === 'Changelog' || text === 'Release notes') {
        var wrapper = control.parentElement;
        (wrapper && wrapper.children.length === 1 ? wrapper : control).style.display = 'none';
      } else if (text === 'Powered by Chatwoot') {
        control.setAttribute('data-replynest-home', 'true');
        replaceExactText(control, 'Powered by ReplyNest');
      }

      if (control.tagName === 'A') {
        var href = control.getAttribute('href') || '';
        if (/chatwoot\.com\/(docs|hc)/i.test(href)) control.setAttribute('data-replynest-help', 'true');
        if (/chatwoot\.com\/(changelog|blog\/tags\/changelog)/i.test(href)) control.style.display = 'none';
      }
    });

    if (window.location.pathname === '/app/login') {
      document.querySelectorAll('img[src*="replynest-brand-cn"]').forEach(function (logo) {
        if (logo.closest('a')) return;
        logo.setAttribute('role', 'link');
        logo.setAttribute('tabindex', '0');
        logo.setAttribute('data-replynest-home', 'true');
        logo.style.cursor = 'pointer';
      });
    }
  }

  var productUiRefreshPending = false;
  function scheduleProductUiRefresh() {
    if (productUiRefreshPending) return;
    productUiRefreshPending = true;
    window.requestAnimationFrame(function () {
      productUiRefreshPending = false;
      refreshProductUi();
    });
  }

  document.addEventListener('click', function (event) {
    var consoleLink = event.target.closest && event.target.closest('[data-replynest-console-return]');
    var helpLink = event.target.closest && event.target.closest('[data-replynest-help]');
    var homeLink = event.target.closest && event.target.closest('[data-replynest-home]');
    if (!consoleLink && !helpLink && !homeLink) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.location.assign(consoleLink ? consoleOrigin + '/' : helpLink ? helpCenterUrl : 'https://replynest.cn/');
  }, true);

  document.addEventListener('keydown', function (event) {
    if ((event.key === 'Enter' || event.key === ' ') && event.target.matches && event.target.matches('[data-replynest-home]')) {
      event.preventDefault();
      window.location.assign('https://replynest.cn/');
    }
  });

  new MutationObserver(scheduleProductUiRefresh).observe(document.documentElement, { childList: true, subtree: true });
  scheduleProductUiRefresh();

  function currentContext() {
    var match = window.location.pathname.match(/^\/app\/accounts\/(\d+)\/(?:[^/]+\/)*conversations\/(\d+)/);
    return match ? { accountId: Number(match[1]), conversationId: Number(match[2]) } : null;
  }

  function trustedFrame(source, origin) {
    return Array.from(document.querySelectorAll('iframe')).some(function (frame) {
      if (frame.contentWindow !== source || !frame.src) return false;
      try {
        var url = new URL(frame.src);
        return url.origin === origin && url.pathname === '/copilot/embed';
      } catch (_error) {
        return false;
      }
    });
  }

  function reply(source, origin, requestId, ok, error) {
    source.postMessage(JSON.stringify({
      event: 'replynest:composer:result',
      request_id: requestId,
      ok: ok,
      error: error || null,
    }), origin);
  }

  function replyEmbedSession(source, origin, requestId, ok, session, error) {
    source.postMessage(JSON.stringify({
      event: 'replynest:embed:session',
      request_id: requestId,
      ok: ok,
      data: session || null,
      error: error || null,
    }), origin);
  }

  function chatwootAuthData() {
    var cookie = document.cookie.split(';').map(function (item) { return item.trim(); })
      .find(function (item) { return item.indexOf('cw_d_session_info=') === 0; });
    if (!cookie) return null;
    try {
      var value = JSON.parse(decodeURIComponent(cookie.slice('cw_d_session_info='.length)));
      var fields = ['access-token', 'client', 'uid', 'expiry', 'token-type'];
      var result = {};
      fields.forEach(function (field) {
        if (typeof value[field] === 'string') result[field] = value[field];
      });
      return result['access-token'] && result.client && result.uid ? result : null;
    } catch (_error) {
      return null;
    }
  }

  function exchangeEmbedSession(source, origin, requestId, context) {
    var credentials = chatwootAuthData();
    if (!credentials) {
      replyEmbedSession(source, origin, requestId, false, null, 'chatwoot_session_missing');
      return;
    }
    var controller = new AbortController();
    var timeout = window.setTimeout(function () { controller.abort(); }, 10000);
    fetch(consoleOrigin + '/api/copilot/embed-session', {
      method: 'POST',
      mode: 'cors',
      cache: 'no-store',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account_id: context.accountId, credentials: credentials }),
      signal: controller.signal,
    }).then(function (response) {
      return response.json().then(function (body) { return { response: response, body: body }; });
    }).then(function (result) {
      var data = result.body && result.body.data;
      if (!result.response.ok || !data || !/^[a-f0-9]{64}$/i.test(String(data.token || ''))) {
        throw new Error(result.body && result.body.error && result.body.error.code || 'embed_session_failed');
      }
      replyEmbedSession(source, origin, requestId, true, {
        token: data.token,
        expires_in: Number(data.expires_in || 0),
      }, null);
    }).catch(function (error) {
      replyEmbedSession(source, origin, requestId, false, null, error && error.message || 'embed_session_failed');
    }).finally(function () {
      window.clearTimeout(timeout);
    });
  }

  function findMessagesTab() {
    return Array.from(document.querySelectorAll('.conversation-details-wrap a')).find(function (node) {
      var text = (node.textContent || '').trim();
      return text === '消息' || text === 'Messages';
    });
  }

  function waitForEditor(attempt) {
    var editor = document.querySelector('.reply-box .ProseMirror.ProseMirror-woot-style[contenteditable="true"]');
    if (editor) return Promise.resolve(editor);
    if (attempt >= 40) return Promise.reject(new Error('composer_not_found'));
    return new Promise(function (resolve) {
      window.setTimeout(resolve, 50);
    }).then(function () { return waitForEditor(attempt + 1); });
  }

  function replaceEditorText(editor, text) {
    editor.focus();
    var selection = window.getSelection();
    var range = document.createRange();
    range.selectNodeContents(editor);
    selection.removeAllRanges();
    selection.addRange(range);

    var inserted = false;
    try {
      var transfer = new DataTransfer();
      transfer.setData('text/plain', text);
      editor.dispatchEvent(new ClipboardEvent('paste', {
        bubbles: true,
        cancelable: true,
        clipboardData: transfer,
      }));
      inserted = (editor.textContent || '').trim().length > 0;
    } catch (_error) {
      inserted = false;
    }
    if (!inserted) {
      document.execCommand('insertText', false, text);
    }
    editor.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
    return (editor.textContent || '').trim().length > 0;
  }

  window.addEventListener('message', function (event) {
    if (!allowedOrigins.has(event.origin) || !trustedFrame(event.source, event.origin)) return;
    var data;
    try {
      data = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
    } catch (_error) {
      return;
    }
    if (!data) return;
    var payload = data.data || {};
    var requestId = String(data.request_id || '');
    var context = currentContext();
    if (data.event === 'replynest:embed:authenticate') {
      if (!requestId || !context || context.accountId !== Number(payload.account_id) || context.conversationId !== Number(payload.conversation_id)) {
        replyEmbedSession(event.source, event.origin, requestId, false, null, 'invalid_context');
        return;
      }
      exchangeEmbedSession(event.source, event.origin, requestId, context);
      return;
    }
    if (data.event !== 'replynest:composer:insert') return;
    var text = typeof payload.text === 'string' ? payload.text.trim() : '';
    if (!requestId || !context || !uuidPattern.test(String(payload.recommendation_id || '')) ||
        context.accountId !== Number(payload.account_id) || context.conversationId !== Number(payload.conversation_id) ||
        !text || text.length > 4000) {
      reply(event.source, event.origin, requestId, false, 'invalid_context');
      return;
    }

    var messagesTab = findMessagesTab();
    if (!messagesTab) {
      reply(event.source, event.origin, requestId, false, 'messages_tab_not_found');
      return;
    }
    messagesTab.click();
    waitForEditor(0).then(function (editor) {
      if (!replaceEditorText(editor, text)) throw new Error('composer_insert_failed');
      reply(event.source, event.origin, requestId, true, null);
    }).catch(function (error) {
      reply(event.source, event.origin, requestId, false, error && error.message ? error.message : 'composer_insert_failed');
    });
  });
})();
