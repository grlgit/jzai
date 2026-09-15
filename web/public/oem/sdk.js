/**
 * 见智数据仪表 OEM 嵌入 SDK（W1）
 *
 * 用法（在第三方页面中）：
 *   <script src="https://<见智域名>/oem/sdk.js"></script>
 *   <script>
 *     JianzhiDashboard.embed('#container', {
 *       token,                       // 必填：宿主后端 /api/oem/token 换来的短时 token
 *       dashboardId,                 // 可选：直接定位某仪表盘
 *       theme: { primary: '1677ff' },// 可选：白标主色
 *       onReady: () => {},
 *       onResize: (h) => {},
 *       onTokenExpired: async () => await refetchToken(), // 返回新 token
 *       onEvent: (e) => {},
 *     });
 *   </script>
 *
 * app_secret 永不进浏览器：前端只持有短时 token。
 */
(function (global) {
  'use strict';
  var ENVELOPE = 'jianzhi-oem';

  // 从加载本脚本的 <script src> 推断见智 origin
  function inferOrigin() {
    try {
      var cur = document.currentScript && document.currentScript.src;
      if (cur) return new URL(cur).origin;
    } catch (e) {}
    return global.location.origin;
  }
  var ORIGIN = inferOrigin();

  function buildSrc(opts) {
    var q = new URLSearchParams();
    q.set('token', opts.token || '');
    q.set('view', opts.view === 'dashboard' ? 'dashboard' : 'full'); // full（对话+面板，默认）| dashboard（只读）
    if (opts.dashboardId) q.set('dashboardId', opts.dashboardId);
    if (opts.theme && opts.theme.primary) q.set('primary', String(opts.theme.primary).replace(/^#/, ''));
    return ORIGIN + '/embed/dashboard?' + q.toString();
  }

  function embed(target, opts) {
    opts = opts || {};
    var el = typeof target === 'string' ? document.querySelector(target) : target;
    if (!el) throw new Error('[JianzhiDashboard] 容器未找到: ' + target);
    if (!opts.token) throw new Error('[JianzhiDashboard] 缺少 token');

    var iframe = document.createElement('iframe');
    iframe.src = buildSrc(opts);
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.style.display = 'block';
    // full 视图是交互式整屏布局，给固定高度；dashboard 只读视图按内容自适应
    iframe.style.minHeight = (opts.minHeight || (opts.view === 'dashboard' ? 400 : 640)) + 'px';
    if (opts.view !== 'dashboard' && !opts.height) iframe.style.height = (opts.minHeight || 640) + 'px';
    iframe.setAttribute('allow', 'clipboard-write');
    el.innerHTML = '';
    el.appendChild(iframe);

    function send(type, payload) {
      iframe.contentWindow && iframe.contentWindow.postMessage(
        { source: ENVELOPE, type: type, payload: payload || {} }, ORIGIN);
    }

    function onMessage(e) {
      if (e.origin !== ORIGIN) return;             // 来源校验
      var msg = e.data;
      if (!msg || msg.source !== ENVELOPE) return;
      switch (msg.type) {
        case 'ready':
          opts.onReady && opts.onReady();
          break;
        case 'resize':
          if (msg.payload && msg.payload.height) {
            iframe.style.height = msg.payload.height + 'px';
            opts.onResize && opts.onResize(msg.payload.height);
          }
          break;
        case 'token-expired':
          if (opts.onTokenExpired) {
            Promise.resolve(opts.onTokenExpired()).then(function (newToken) {
              if (newToken) send('set-token', { token: newToken });
            });
          }
          break;
        case 'event':
          opts.onEvent && opts.onEvent(msg.payload);
          break;
      }
    }
    global.addEventListener('message', onMessage);

    // 控制句柄
    return {
      iframe: iframe,
      setToken: function (t) { send('set-token', { token: t }); },
      navigate: function (dashboardId) { send('navigate', { dashboardId: dashboardId }); },
      setTheme: function (theme) { send('set-theme', theme || {}); },
      destroy: function () {
        global.removeEventListener('message', onMessage);
        el.innerHTML = '';
      },
    };
  }

  global.JianzhiDashboard = { embed: embed, origin: ORIGIN };
})(window);
