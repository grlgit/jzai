/**
 * 见智 CoWorker - 渲染进程逻辑
 */

const { ipcRenderer } = require('electron');

// ===== 性能追踪系统 =====
// 用于分析渲染进程启动延迟
const rendererPerf = {
  startTime: Date.now(),
  phases: {},

  mark(phase) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    this.phases[phase] = now;
    console.log(`[RENDERER-PERF] ${phase}: +${elapsed}ms`);

    // 如果耗时过长，发出警告
    if (elapsed > 2000) {
      console.warn(`[RENDERER-PERF] ${phase} 耗时过长: ${elapsed}ms`);
    }

    return elapsed;
  },

  measure(from, to) {
    const fromTime = this.phases[from];
    const toTime = this.phases[to];
    if (fromTime && toTime) {
      const duration = toTime - fromTime;
      console.log(`[RENDERER-PERF] ${from} -> ${to}: ${duration}ms`);
      return duration;
    }
    return null;
  },

  summary() {
    console.log('[RENDERER-PERF] ===== 渲染进程性能总结 =====');
    console.log(`[RENDERER-PERF] 总加载时间: ${Date.now() - this.startTime}ms`);

    const sortedPhases = Object.entries(this.phases)
      .sort((a, b) => a[1] - b[1]);

    let prevTime = this.startTime;
    for (const [phase, time] of sortedPhases) {
      const duration = time - prevTime;
      console.log(`[RENDERER-PERF] ${phase}: +${duration}ms (累计: ${time - this.startTime}ms)`);
      prevTime = time;
    }
  }
};

// 记录渲染进程启动开始
rendererPerf.mark('renderer-start');
console.log('[RENDERER] 渲染进程启动');

// DOM 元素引用 (延迟初始化)
let activationCard, webviewContainer, gatewayWebview;
let bootCard, bootTitle, bootMessage, bootDetail, bootHint;
let diagnosticCard, diagnosticMessage, diagnosticDetail;
let diagnosticRetryBtn, diagnosticLogBtn, diagnosticExportBtn, diagnosticReactivateBtn;
let logExport;
let wechatBindEntry;
let mainUrlInput, tokenInput, workDirInput, selectWorkDirBtn, activateBtn, errorMessage, loading;
let statusDot, statusText, logPanel, logContent, logToggle, logClear, logClose;
let wechatLoginCard, wechatLoginBtn, wechatCancelBtn, wechatOutput, wechatQrCode;

// 全局错误捕获
window.addEventListener('error', (event) => {
  console.error('[RENDERER-ERROR]', event.error);
  const errorMsg = `[错误] ${event.error?.message || event.message}`;
  console.log(errorMsg);
  // 尝试显示错误在页面上
  try {
    const errorDiv = document.createElement('div');
    errorDiv.style.cssText = 'position:fixed;top:10px;left:10px;right:10px;background:red;color:white;padding:10px;font-family:sans-serif;z-index:9999;';
    errorDiv.textContent = errorMsg;
    document.body.appendChild(errorDiv);
  } catch (e) {}
});

window.addEventListener('unhandledrejection', (event) => {
  console.error('[RENDERER-PROMISE-ERROR]', event.reason);
  const errorMsg = `[Promise错误] ${event.reason?.message || event.reason}`;
  console.log(errorMsg);
});

// 初始化DOM元素引用
function initDOMElements() {
  rendererPerf.mark('dom-init-start');
  console.log('[RENDERER] 初始化DOM元素');

  activationCard = document.getElementById('activationCard');
  bootCard = document.getElementById('bootCard');
  bootTitle = document.getElementById('bootTitle');
  bootMessage = document.getElementById('bootMessage');
  bootDetail = document.getElementById('bootDetail');
  bootHint = document.getElementById('bootHint');
  diagnosticCard = document.getElementById('diagnosticCard');
  diagnosticMessage = document.getElementById('diagnosticMessage');
  diagnosticDetail = document.getElementById('diagnosticDetail');
  diagnosticRetryBtn = document.getElementById('diagnosticRetryBtn');
  diagnosticLogBtn = document.getElementById('diagnosticLogBtn');
  diagnosticExportBtn = document.getElementById('diagnosticExportBtn');
  diagnosticReactivateBtn = document.getElementById('diagnosticReactivateBtn');
  logExport = document.getElementById('logExport');
  wechatBindEntry = document.getElementById('wechatBindEntry');
  webviewContainer = document.getElementById('webviewContainer');
  gatewayWebview = document.getElementById('gatewayWebview');
  mainUrlInput = document.getElementById('mainUrl');
  tokenInput = document.getElementById('token');
  workDirInput = document.getElementById('workDir');
  selectWorkDirBtn = document.getElementById('selectWorkDirBtn');
  activateBtn = document.getElementById('activateBtn');
  errorMessage = document.getElementById('errorMessage');
  loading = document.getElementById('loading');
  statusDot = document.getElementById('statusDot');
  statusText = document.getElementById('statusText');
  logPanel = document.getElementById('logPanel');
  logContent = document.getElementById('logContent');
  logToggle = document.getElementById('logToggle');
  logClear = document.getElementById('logClear');
  logClose = document.getElementById('logClose');

  // 微信登录相关元素
  wechatLoginCard = document.getElementById('wechatLoginCard');
  wechatLoginBtn = document.getElementById('wechatLoginBtn');
  wechatCancelBtn = document.getElementById('wechatCancelBtn');
  wechatOutput = document.getElementById('wechatOutput');
  wechatQrCode = document.getElementById('wechatQrCode');

  console.log('[RENDERER] DOM元素初始化完成');
  rendererPerf.mark('dom-init-complete');

  // bootCard 是默认可见卡片，计时从页面加载即开始
  startBootTicker();
}

// 配置
const GATEWAY_URL = 'http://127.0.0.1:18789';
const DEFAULT_MAIN_URL = 'http://localhost:8899'; // 默认服务端地址

// 状态
let isActivated = false;
// 初始化判定结果（由主进程 get-init-state 提供，localStorage 不再参与判定）
let initState = { needEnroll: true, needWechatBind: false };
// 激活后自动触发微信登录的去重标志(仅自动弹一次二维码,避免 Gateway 重连 running 时重复触发)
let wechatLoginAutoStarted = false;
let mainUrl = '';
let logs = [];
// 启动等待计时（gateway 最慢会走到 60s ready 兜底，需要给用户可见进度）
const BOOT_HINT_AFTER_MS = 10000;
let bootTicker = null;
let bootStartedAt = 0;

// ===== 日志功能 =====

function addLog(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const logEntry = {
    timestamp,
    message,
    type
  };
  logs.push(logEntry);

  // 限制日志数量
  if (logs.length > 500) {
    logs = logs.slice(-500);
  }

  // 更新显示
  renderLogs();

  // 同时输出到控制台
  console.log(`[${type.toUpperCase()}] ${timestamp} - ${message}`);
}

function renderLogs() {
  if (!logContent) return; // DOM未就绪时跳过

  logContent.innerHTML = logs.map(log => {
    const className = `log-entry ${log.type}`;
    return `<div class="${className}">[${log.timestamp}] ${log.message}</div>`;
  }).join('');

  // 自动滚动到底部
  logContent.scrollTop = logContent.scrollHeight;
}

function clearLogs() {
  logs = [];
  renderLogs();
  addLog('日志已清空', 'info');
}

// 设置日志面板事件监听
function setupLogPanelListeners() {
  if (!logToggle || !logClose || !logClear) return;

  // 日志面板切换
  logToggle.addEventListener('click', () => {
    logPanel.classList.toggle('show');
  });

  logClose.addEventListener('click', () => {
    logPanel.classList.remove('show');
  });

  logClear.addEventListener('click', () => {
    clearLogs();
  });

  // 添加日志面板拖动调整大小功能
  const resizeHandle = document.getElementById('logResizeHandle');
  if (resizeHandle && logPanel) {
    let isResizing = false;
    let startY = 0;
    let startHeight = 0;

    resizeHandle.addEventListener('mousedown', (e) => {
      isResizing = true;
      startY = e.clientY;
      startHeight = logPanel.offsetHeight;
      e.preventDefault();
      document.body.style.userSelect = 'none';
      const webview = document.getElementById('gatewayWebview');
      if (webview) webview.style.pointerEvents = 'none';
    });

    document.addEventListener('mousemove', (e) => {
      if (!isResizing) return;

      const deltaY = startY - e.clientY;
      const newHeight = Math.max(100, Math.min(window.innerHeight * 0.8, startHeight + deltaY));
      logPanel.style.height = newHeight + 'px';
    });

    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      document.body.style.userSelect = '';
      const webview = document.getElementById('gatewayWebview');
      if (webview) webview.style.pointerEvents = '';
    });
  }
}

// 设置所有事件监听器（必须在 DOM 元素初始化后调用）
function setupEventListeners() {
  console.log('[RENDERER] 设置事件监听器');

  // 工作目录选择按钮
  if (selectWorkDirBtn) {
    selectWorkDirBtn.addEventListener('click', async () => {
      console.log('[WORKDIR] 选择工作目录按钮点击');
      try {
        const result = await ipcRenderer.invoke('select-workdir');
        if (result.success && result.path) {
          workDirInput.value = result.path;
          addLog(`工作目录已选择: ${result.path}`, 'info');
          localStorage.setItem('jzai-workdir', result.path);
        } else if (result.error) {
          addLog(`选择工作目录失败: ${result.error}`, 'error');
        }
      } catch (error) {
        addLog(`选择工作目录异常: ${error.message}`, 'error');
        console.error('[WORKDIR] 错误:', error);
      }
    });
  }

  // 激活按钮
  if (activateBtn) {
    activateBtn.addEventListener('click', async () => {
      console.log('[ACTIVATE] 激活按钮点击');
      const token = tokenInput.value.trim();
      const url = mainUrlInput.value.trim();
      const workDir = workDirInput.value.trim();

      if (!token) {
        showError('请输入激活码');
        return;
      }

      if (!url) {
        showError('请输入服务器地址');
        return;
      }

      // 保存 mainUrl
      mainUrl = url;
      localStorage.setItem('jzai-main-url', url);

      // 保存工作目录（如果已选择）
      if (workDir) {
        localStorage.setItem('jzai-workdir', workDir);
      }

      // 显示加载状态
      activateBtn.disabled = true;
      loading.classList.add('show');
      hideError();

      try {
        addLog('开始激活...', 'info');
        console.log('[ACTIVATE] 调用主进程 enroll, token:', token.substring(0, 4) + '***');

        // 调用主进程的 enroll 方法（包含工作目录）
        const result = await ipcRenderer.invoke('enroll', { token, mainUrl: url, workDir });
        console.log('[ACTIVATE] enroll 返回:', result);

        if (result.success) {
          // 激活成功
          addLog(`激活成功: CoWorker ID = ${result.coworkerId}`, 'success');
          console.log('[Enroll] 成功:', result);
          isActivated = true;
          localStorage.setItem('jzai-coworker-id', result.coworkerId || '');
          // 新激活的员工需要走微信绑定；等主进程发送 running 后触发
          initState = {
            needEnroll: false,
            needWechatBind: true,
            coworkerId: result.coworkerId,
            assignmentId: result.assignmentId,
            onboarding: { completed: false, step: 0, skipped: [], profileCompleted: false },
            serverReachable: true,
          };
          addLog('正在启动 Gateway...', 'info');
          resetBootTimer();
          showBoot('正在启动', '激活完成，正在启动运行时…');
        } else {
          addLog(`激活失败: ${result.error || '未知错误'}`, 'error');
          showError(result.error || '激活失败，请检查激活码是否正确');
        }
      } catch (error) {
        addLog(`激活异常: ${error.message}`, 'error');
        console.error('[Enroll] 错误:', error);
        showError('激活失败: ' + error.message);
      } finally {
        activateBtn.disabled = false;
        loading.classList.remove('show');
      }
    });
    console.log('[RENDERER] 激活按钮监听器已设置');
  } else {
    console.warn('[RENDERER] activateBtn 不存在，跳过监听器设置');
  }

  // 微信登录按钮
  if (wechatLoginBtn) {
    wechatLoginBtn.addEventListener('click', async () => {
      wechatLoginBtn.disabled = true;
      wechatCancelBtn.disabled = true;

      // 清空二维码容器并显示加载状态
      const qrWrapper = document.getElementById('wechatQrCodeWrapper');
      if (qrWrapper) {
        qrWrapper.innerHTML = '<div class="wechat-qrcode-loading">正在生成二维码...</div>';
      }

      // 清空输出区域
      if (wechatOutput) {
        wechatOutput.innerHTML = '';
      }

      addLog('启动微信登录...', 'info');

      try {
        const result = await ipcRenderer.invoke('wechat-login');
        if (!result.success) {
          addLog(`微信登录启动失败: ${result.error}`, 'error');
          if (qrWrapper) {
            qrWrapper.innerHTML = `<div style="color:#ef4444;">启动失败: ${result.error}</div>`;
          }
          wechatLoginBtn.disabled = false;
          wechatCancelBtn.disabled = false;
        }
      } catch (error) {
        addLog(`微信登录异常: ${error.message}`, 'error');
        if (qrWrapper) {
          qrWrapper.innerHTML = `<div style="color:#ef4444;">启动异常: ${error.message}</div>`;
        }
        wechatLoginBtn.disabled = false;
        wechatCancelBtn.disabled = false;
      }
    });
  }

  // 取消微信登录
  if (wechatCancelBtn) {
    wechatCancelBtn.addEventListener('click', async () => {
      addLog('跳过微信绑定', 'info');
      // 主进程会把状态记为 skipped，此处同步内存视图避免本次会话重复引导
      await ipcRenderer.invoke('wechat-login-cancel');
      initState.needWechatBind = false;
      hideWeChatLogin();
      await showGateway();
    });
  }

  // 手动绑定微信入口
  if (wechatBindEntry) {
    wechatBindEntry.addEventListener('click', async () => {
      addLog('手动发起微信绑定', 'info');
      showWeChatLogin();
      if (wechatLoginBtn) wechatLoginBtn.disabled = true;
      if (wechatCancelBtn) wechatCancelBtn.disabled = true;
      const qrWrapper = document.getElementById('wechatQrCodeWrapper');
      if (qrWrapper) {
        qrWrapper.innerHTML = '<div class="wechat-qrcode-loading">正在生成二维码...</div>';
      }
      const result = await ipcRenderer.invoke('wechat-login');
      if (!result || !result.success) {
        const reason = result?.error || '未知错误';
        addLog(`微信登录启动失败: ${reason}`, 'error');
        if (qrWrapper) {
          qrWrapper.innerHTML = '';
          const failed = document.createElement('div');
          failed.style.color = '#ef4444';
          failed.textContent = `启动失败: ${reason}`;
          qrWrapper.appendChild(failed);
        }
        if (wechatLoginBtn) wechatLoginBtn.disabled = false;
        if (wechatCancelBtn) wechatCancelBtn.disabled = false;
      }
    });
  }

  // 诊断页：重试启动
  if (diagnosticRetryBtn) {
    diagnosticRetryBtn.addEventListener('click', async () => {
      diagnosticRetryBtn.disabled = true;
      addLog('重试启动 Gateway', 'info');
      resetBootTimer();
      showBoot('正在重试', '正在重新启动运行时…');
      try {
        await ipcRenderer.invoke('restart-gateway');
      } catch (error) {
        addLog(`重启失败: ${error.message}`, 'error');
        showDiagnostic('重启失败', error.message);
      } finally {
        diagnosticRetryBtn.disabled = false;
      }
    });
  }

  // 诊断页：查看日志
  if (diagnosticLogBtn) {
    diagnosticLogBtn.addEventListener('click', () => {
      if (logPanel) logPanel.classList.add('show');
    });
  }

  // 日志面板 / 诊断页：导出日志
  async function exportLogs() {
    try {
      addLog('正在导出诊断日志...', 'info');
      // 把渲染进程内存中的日志一并传给主进程导出
      const result = await ipcRenderer.invoke('export-logs', logs);
      if (result.success) {
        addLog(`诊断日志已导出: ${result.path}`, 'success');
      } else {
        addLog(`导出日志失败: ${result.error}`, 'error');
      }
    } catch (error) {
      addLog(`导出日志异常: ${error.message}`, 'error');
      console.error('[Logs] 导出异常:', error);
    }
  }

  if (logExport) {
    logExport.addEventListener('click', exportLogs);
  }

  if (diagnosticExportBtn) {
    diagnosticExportBtn.addEventListener('click', exportLogs);
  }

  // 诊断页：重新激活
  if (diagnosticReactivateBtn) {
    diagnosticReactivateBtn.addEventListener('click', () => {
      addLog('用户选择重新激活', 'info');
      showActivation();
    });
  }
}

// 监听来自主进程的日志
ipcRenderer.on('log-message', (event, { message, type = 'info' }) => {
  addLog(message, type);
});

// 初始化日志（延迟到DOM就绪后）
// addLog('见智 CoWorker 启动', 'info'); // 移到init()中

// ===== 初始化 =====

function init() {
  rendererPerf.mark('init-start');
  console.log('[RENDERER] 初始化开始');

  // 初始化DOM元素
  initDOMElements();

  // 验证关键元素存在
  if (!activationCard || !mainUrlInput || !tokenInput || !activateBtn) {
    console.error('[RENDERER] 关键DOM元素缺失！');
    console.error('[RENDERER] activationCard:', activationCard);
    console.error('[RENDERER] mainUrlInput:', mainUrlInput);
    console.error('[RENDERER] tokenInput:', tokenInput);
    console.error('[RENDERER] activateBtn:', activateBtn);
    return;
  }

  // 读取保存的 mainUrl
  const savedMainUrl = localStorage.getItem('jzai-main-url');
  if (savedMainUrl) {
    mainUrl = savedMainUrl;
    mainUrlInput.value = savedMainUrl;
    addLog(`已保存的服务端地址: ${savedMainUrl}`, 'info');
  } else {
    // 使用默认服务端地址
    mainUrl = DEFAULT_MAIN_URL;
    mainUrlInput.value = DEFAULT_MAIN_URL;
    addLog(`使用默认服务端地址: ${DEFAULT_MAIN_URL}`, 'info');
  }

  // 读取保存的工作目录
  const savedWorkDir = localStorage.getItem('jzai-workdir');
  if (savedWorkDir && workDirInput) {
    workDirInput.value = savedWorkDir;
    addLog(`已保存的工作目录: ${savedWorkDir}`, 'info');
  }

  // 设置日志面板事件监听
  setupLogPanelListeners();

  // 设置所有事件监听器
  setupEventListeners();

  // 初始化日志（现在DOM已就绪）
  addLog('见智 CoWorker 启动', 'info');

  // 检查是否已激活
  rendererPerf.mark('check-activation-start');
  checkActivationStatus();
  rendererPerf.mark('init-complete');
  rendererPerf.measure('init-duration', 'init-start', 'init-complete');
}

// 等待DOM加载完成后再初始化
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[RENDERER] DOMContentLoaded');
    try {
      init();
    } catch (error) {
      console.error('[RENDERER] 初始化失败:', error);
      rendererPerf.mark('init-error');
      // 显示错误信息
      document.body.innerHTML = `
        <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#1e3a8a;color:white;font-family:sans-serif;">
          <div style="text-align:center;">
            <h2>初始化失败</h2>
            <p>${error.message}</p>
            <p style="font-size:12px;opacity:0.7;">请查看日志文件了解详情</p>
          </div>
        </div>
      `;
    }
  });
} else {
  // DOM已经加载完成
  console.log('[RENDERER] DOM已就绪');
  try {
    init();
  } catch (error) {
    console.error('[RENDERER] 初始化失败:', error);
    rendererPerf.mark('init-error');
    document.body.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#1e3a8a;color:white;font-family:sans-serif;">
        <div style="text-align:center;">
          <h2>初始化失败</h2>
          <p>${error.message}</p>
          <p style="font-size:12px;opacity:0.7;">请查看日志文件了解详情</p>
        </div>
      </div>
    `;
  }
}

// ===== Gateway 状态处理 =====

async function checkActivationStatus() {
  try {
    const state = await ipcRenderer.invoke('get-init-state');
    console.log('[Init State]', state);
    initState = state || { needEnroll: true, needWechatBind: false };

    if (initState.needEnroll) {
      addLog('未检测到激活信息，请先激活', 'info');
      showActivation();
      return;
    }

    isActivated = true;
    localStorage.setItem('jzai-coworker-id', initState.coworkerId || '');

    if (!initState.serverReachable) {
      addLog('服务端不可达，使用本地缓存的引导状态', 'warn');
    }

    // 立即切到过渡态，等待 Gateway ready
    addLog('检测到已激活状态，正在启动运行时', 'info');
    showBoot('正在启动', '正在加载见智 CoWorker 运行时…');

    // get-init-state 期间可能已经收到 running，补跑一次避免停在过渡态
    if (lastGatewayStatus) {
      handleGatewayStatus(lastGatewayStatus);
    }
  } catch (error) {
    console.error('[Init State] 检查失败:', error);
    addLog('检查初始化状态失败，显示激活界面', 'warn');
    showActivation();
  }
}

// 最近一次 Gateway 状态，用于 initState 就绪后补跑
let lastGatewayStatus = null;

// 监听来自主进程的消息
ipcRenderer.on('gateway-status', (event, data) => {
  lastGatewayStatus = data;
  handleGatewayStatus(data);
});

function handleGatewayStatus(data) {
  rendererPerf.mark(`gateway-status-${data.status}`);
  addLog(`Gateway 状态: ${data.status}`, 'info');
  console.log('[Gateway Status]', data);

  switch (data.status) {
    case 'need-activation':
      rendererPerf.mark('show-activation-start');
      showActivation();
      break;
    case 'starting':
      updateStatus('connecting');
      addLog('Gateway 正在启动...', 'info');
      if (isActivated) showBoot('正在启动', '运行时启动中…');
      break;
    case 'running':
      updateStatus('online');
      addLog('Gateway 运行中', 'success');
      if (isActivated) {
        if (initState.needWechatBind) {
          // 需要绑定微信：显示登录界面并自动触发二维码（仅一次）
          showWeChatLogin();
          if (!wechatLoginAutoStarted) {
            wechatLoginAutoStarted = true;
            if (wechatLoginBtn) wechatLoginBtn.disabled = true;
            if (wechatCancelBtn) wechatCancelBtn.disabled = true;
            addLog('启动微信登录...', 'info');
            ipcRenderer.invoke('wechat-login').then(r => {
              if (!r || !r.success) {
                addLog(`微信登录启动失败: ${r?.error || '未知错误'}`, 'error');
                if (wechatLoginBtn) wechatLoginBtn.disabled = false;
                if (wechatCancelBtn) wechatCancelBtn.disabled = false;
              }
            }).catch(e => {
              addLog(`微信登录异常: ${e.message}`, 'error');
              if (wechatLoginBtn) wechatLoginBtn.disabled = false;
              if (wechatCancelBtn) wechatCancelBtn.disabled = false;
            });
          }
        } else {
          addLog('引导已完成，直接进入 Gateway UI', 'info');
          setTimeout(async () => {
            await showGateway({ delay: 1000 });
          }, 500);
        }
      }
      break;
    case 'stopped':
      updateStatus('offline');
      addLog('Gateway 已停止', 'warn');
      showDiagnostic(
        '运行时已退出',
        `Gateway 进程退出${data.code !== undefined ? `（code: ${data.code}）` : ''}，可点击重试启动`,
      );
      break;
    case 'error':
      updateStatus('offline');
      addLog(`错误: ${data.message || '启动失败'}`, 'error');
      showDiagnostic(
        data.reason === 'RUNTIME_MISSING' ? '缺少 Node 运行时'
          : data.reason === 'CREDENTIAL_INVALID' ? '凭据已失效，请重新激活'
          : '运行时启动失败',
        data.message || '启动失败',
      );
      break;
  }
}

// 监听 enroll token (来自 deep link)
ipcRenderer.on('enroll-token', (event, { token }) => {
  console.log('[Enroll] 收到 deep link token:', token);
  tokenInput.value = token;
  // 自动触发激活
  if (mainUrl) {
    activateBtn.click();
  }
});

// ===== 微信登录处理 =====

// 监听微信登录输出
ipcRenderer.on('wechat-login-output', (event, { output, isError }) => {
  if (wechatOutput) {
    const line = document.createElement('div');
    line.className = isError ? 'wechat-output-error' : 'wechat-output-line';
    line.textContent = output;
    wechatOutput.appendChild(line);
    wechatOutput.scrollTop = wechatOutput.scrollHeight;

    // 检查是否包含二维码提示（根据微信插件的输出格式）
    if (output.toLowerCase().includes('qr') || output.includes('二维码') || output.includes('scan')) {
      addLog('微信登录：请扫描二维码', 'info');
    }
  }
});

// 监听微信登录成功
ipcRenderer.on('wechat-login-success', (event) => {
  addLog('微信登录成功', 'success');
  // 状态已由主进程写入 onboarding（服务端 + 本地缓存），此处只同步内存视图
  initState.needWechatBind = false;
  initState.onboarding = { ...(initState.onboarding || {}), completed: true };
  if (wechatBindEntry) wechatBindEntry.style.display = 'none';
  if (wechatOutput) {
    const line = document.createElement('div');
    line.className = 'wechat-output-success';
    line.textContent = '✓ 登录成功！';
    wechatOutput.appendChild(line);
  }

  // 延迟后显示 Gateway UI
  setTimeout(async () => {
    hideWeChatLogin();
    await showGateway();
  }, 1500);
});

// 监听微信登录二维码
ipcRenderer.on('wechat-login-qrcode', (event, { qrUrl }) => {
  console.log('[RENDERER] 收到二维码链接:', qrUrl);
  // 获取二维码容器
  const qrWrapper = document.getElementById('wechatQrCodeWrapper');
  if (qrWrapper) {
    // 清空容器
    qrWrapper.innerHTML = '';

    // 创建二维码容器
    const qrContainer = document.createElement('div');
    qrContainer.className = 'wechat-qrcode-container';

    // 创建二维码图片元素
    const qrImg = document.createElement('img');
    qrImg.className = 'wechat-qrcode-image';
    qrImg.alt = '微信登录二维码';

    // 使用 API 生成二维码（使用公共 API）
    // 使用多个 API 提供商作为备选
    const qrApis = [
      `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`,
      `https://qrhost.com/?text=${encodeURIComponent(qrUrl)}&size=200`
    ];

    qrImg.src = qrApis[0];
    qrImg.onerror = () => {
      // 第一个 API 失败，尝试第二个
      qrImg.src = qrApis[1];
    };

    // 创建提示文字
    const qrHint = document.createElement('div');
    qrHint.className = 'wechat-qrcode-hint';
    qrHint.textContent = '请使用微信扫描上方二维码完成登录';

    qrContainer.appendChild(qrImg);
    qrContainer.appendChild(qrHint);
    qrWrapper.appendChild(qrContainer);
  }
});

// 监听微信登录错误
ipcRenderer.on('wechat-login-error', (event, { error }) => {
  addLog(`微信登录失败: ${error}`, 'error');
  addLog('已记为跳过，下次启动不再自动引导，可稍后从头部「绑定微信」重试', 'info');
  if (wechatOutput) {
    const line = document.createElement('div');
    line.className = 'wechat-output-error';
    line.textContent = `✗ 登录失败: ${error}`;
    wechatOutput.appendChild(line);
  }
  wechatCancelBtn.disabled = false;
  wechatLoginBtn.disabled = false;
});

// 监听微信登录超时
ipcRenderer.on('wechat-login-timeout', (event) => {
  addLog('微信登录超时', 'warn');
  addLog('已记为跳过，下次启动不再自动引导，可稍后从头部「绑定微信」重试', 'info');
  if (wechatOutput) {
    const line = document.createElement('div');
    line.className = 'wechat-output-warn';
    line.textContent = '⚠ 登录超时（5分钟）';
    wechatOutput.appendChild(line);
  }
  wechatCancelBtn.disabled = false;
  wechatLoginBtn.disabled = false;
});

// ===== UI 更新 =====

function hideAllCards() {
  if (bootCard) bootCard.style.display = 'none';
  if (diagnosticCard) diagnosticCard.style.display = 'none';
  if (activationCard) activationCard.style.display = 'none';
  if (wechatLoginCard) wechatLoginCard.style.display = 'none';
  webviewContainer.classList.remove('show');
  stopBootTicker();
}

function renderBootElapsed() {
  const seconds = Math.floor((Date.now() - bootStartedAt) / 1000);
  if (bootDetail) {
    bootDetail.textContent = seconds > 0 ? `请稍候（已等待 ${seconds} 秒）` : '请稍候';
  }
  if (bootHint && Date.now() - bootStartedAt >= BOOT_HINT_AFTER_MS) {
    bootHint.classList.add('show');
  }
}

function startBootTicker() {
  if (!bootStartedAt) bootStartedAt = Date.now();
  if (!bootTicker) bootTicker = setInterval(renderBootElapsed, 1000);
  renderBootElapsed();
}

function stopBootTicker() {
  if (bootTicker) {
    clearInterval(bootTicker);
    bootTicker = null;
  }
  if (bootHint) bootHint.classList.remove('show');
}

// 开始一次全新的启动计时（激活完成、手动重试等）
function resetBootTimer() {
  stopBootTicker();
  bootStartedAt = 0;
}

function showBoot(message, detail) {
  hideAllCards();
  if (bootCard) bootCard.style.display = 'block';
  if (bootTitle && message) bootTitle.textContent = message;
  if (bootMessage && detail) bootMessage.textContent = detail;
  startBootTicker();
  updateStatus('connecting');
}

function showDiagnostic(message, detail) {
  hideAllCards();
  if (diagnosticCard) diagnosticCard.style.display = 'block';
  if (diagnosticMessage) diagnosticMessage.textContent = message || '运行时未能正常启动';
  if (diagnosticDetail) diagnosticDetail.textContent = detail || '';
  updateStatus('offline');
}

function showActivation() {
  rendererPerf.mark('activation-visible');
  console.log('[RENDERER] 激活界面显示');
  rendererPerf.measure('time-to-activation', 'renderer-start', 'activation-visible');

  hideAllCards();
  activationCard.style.display = 'block';
  updateStatus('offline');
  // 隐藏错误消息，确保用户看到干净的激活界面
  hideError();
}

function showWeChatLogin() {
  hideAllCards();
  if (wechatLoginCard) {
    wechatLoginCard.style.display = 'block';
  }
  updateStatus('connecting');
  addLog('请完成微信登录以继续', 'info');
}

function hideWeChatLogin() {
  if (wechatLoginCard) {
    wechatLoginCard.style.display = 'none';
  }
}

// 全局重试状态跟踪
let gatewayRetryCount = 0;
const MAX_GATEWAY_RETRIES = 30;
const RETRY_DELAY = 3000; // 3秒

async function showGateway(options = { delay: 0 }) {
  // 如果指定了延迟，等待Gateway完全启动
  if (options.delay > 0) {
    addLog(`等待 ${options.delay}ms 后加载 Gateway UI...`, 'info');
    await new Promise(resolve => setTimeout(resolve, options.delay));
  }

  hideAllCards();
  webviewContainer.classList.add('show');
  addLog('正在加载 Gateway UI...', 'info');

  // 跳过过微信绑定的用户，在头部提供手动补绑入口
  if (wechatBindEntry) {
    const bound = !!(initState.onboarding && initState.onboarding.completed);
    wechatBindEntry.style.display = bound ? 'none' : 'flex';
  }

  // 重新获取 webview 元素引用
  const actualWebview = document.getElementById('gatewayWebview');
  if (!actualWebview) {
    addLog('错误: 找不到 webview 元素', 'error');
    showDiagnostic('界面加载失败', '内部错误：找不到 webview 元素');
    return;
  }

  // 获取 Gateway token 用于自动认证
  let gatewayUrl = GATEWAY_URL;
  try {
    const tokenInfo = await ipcRenderer.invoke('get-gateway-token');
    if (tokenInfo && tokenInfo.token) {
      // 使用 URL fragment 传递 token（推荐方式，避免服务器日志）
      gatewayUrl = `${GATEWAY_URL}/#token=${encodeURIComponent(tokenInfo.token)}`;
      addLog('Gateway token 已获取，将用于自动认证', 'info');
    }
  } catch (err) {
    console.warn('[Gateway] 获取 token 失败:', err);
    addLog('获取 Gateway token 失败，可能需要手动输入', 'warn');
  }

  // 重置重试计数（如果是首次调用）
  if (options.delay > 0) {
    gatewayRetryCount = 0;
  }

  // 加载 gateway control-ui
  addLog(`加载 URL: ${GATEWAY_URL}`, 'info');
  actualWebview.src = gatewayUrl;

  // 监听 webview 加载（调试埋点：记录每一次导航，不只是首次）
  actualWebview.addEventListener('did-start-loading', () => {
    addLog('Gateway UI 开始加载...', 'info');
    console.log('[Webview] did-start-loading');
  });

  actualWebview.addEventListener('did-stop-loading', () => {
    const url = actualWebview.getURL();
    addLog(`Gateway UI 停止加载: ${url || 'about:blank'}`, url ? 'info' : 'warn');
    console.log('[Webview] did-stop-loading url=', url);
  });

  actualWebview.addEventListener('did-finish-load', () => {
    addLog('Gateway UI 加载完成', 'success');
    console.log('[Webview] did-finish-load');
    updateStatus('online');
    gatewayRetryCount = 0;
  });

  actualWebview.addEventListener('did-fail-load', (event) => {
    addLog(`Gateway UI 加载失败: errorCode=${event.errorCode} errorDescription=${event.errorDescription} validatedURL=${event.validatedURL}`, 'error');
    console.error('[Webview] did-fail-load:', event);
    updateStatus('offline');

    if (event.errorDescription === 'ERR_CONNECTION_REFUSED' || event.errorDescription === 'ERR_ABORTED') {
      if (gatewayRetryCount < MAX_GATEWAY_RETRIES) {
        gatewayRetryCount++;
        addLog(`Gateway 可能还在启动中，${RETRY_DELAY/1000}秒后进行第 ${gatewayRetryCount}/${MAX_GATEWAY_RETRIES} 次重试...`, 'info');
        setTimeout(() => {
          addLog(`重试连接 Gateway UI (${gatewayRetryCount}/${MAX_GATEWAY_RETRIES})...`, 'info');
          actualWebview.src = gatewayUrl;
        }, RETRY_DELAY);
        return;
      } else {
        addLog(`重试 ${MAX_GATEWAY_RETRIES} 次后仍失败，Gateway可能未正常启动`, 'error');
      }
    }

    showError('Gateway UI 加载失败，请检查 Gateway 是否正常运行');
  });

  actualWebview.addEventListener('did-navigate', (event) => {
    addLog(`Gateway UI 导航到: ${event.url}`, 'info');
    console.log('[Webview] did-navigate:', event.url);
  });

  actualWebview.addEventListener('did-navigate-in-page', (event) => {
    addLog(`Gateway UI 页内导航: ${event.url}`, 'info');
    console.log('[Webview] did-navigate-in-page:', event.url);
  });

  actualWebview.addEventListener('page-title-updated', (event) => {
    addLog(`Gateway UI 标题更新: ${event.title}`, 'info');
    console.log('[Webview] page-title-updated:', event.title);
  });

  actualWebview.addEventListener('console-message', (event) => {
    const level = event.level === 0 ? 'debug' : event.level === 1 ? 'log' : event.level === 2 ? 'warn' : 'error';
    const text = `[Gateway UI console ${level}] ${event.message} (${event.sourceId}:${event.line})`;
    addLog(text, level === 'error' ? 'error' : 'info');
    console.log('[Webview console]', text);
  });

  actualWebview.addEventListener('new-window', (event) => {
    addLog(`Gateway UI 请求新窗口: ${event.url}`, 'warn');
    console.log('[Webview] new-window:', event.url);
    event.preventDefault();
  });

  actualWebview.addEventListener('crashed', () => {
    addLog('Gateway UI 渲染进程崩溃', 'error');
    console.error('[Webview] crashed');
  });

  actualWebview.addEventListener('gpu-crashed', () => {
    addLog('Gateway UI GPU 进程崩溃', 'error');
    console.error('[Webview] gpu-crashed');
  });

  actualWebview.addEventListener('plugin-crashed', () => {
    addLog('Gateway UI 插件崩溃', 'error');
    console.error('[Webview] plugin-crashed');
  });

  // 设置超时检查（10秒后还没加载完成则认为失败）
  setTimeout(() => {
    const url = actualWebview.getURL();
    if (!url || url === 'about:blank') {
      addLog('Gateway UI 加载超时', 'error');
      showError('Gateway UI 加载超时，请查看日志');
    }
  }, 10000);
}

function updateStatus(status) {
  switch (status) {
    case 'online':
      statusDot.classList.remove('offline');
      statusText.textContent = '运行中';
      break;
    case 'connecting':
      statusDot.classList.add('offline');
      statusDot.style.background = '#f59e0b';
      statusText.textContent = '连接中...';
      break;
    case 'offline':
    default:
      statusDot.classList.add('offline');
      statusDot.style.background = '#ef4444';
      statusText.textContent = '未连接';
      break;
  }
}

function showError(message) {
  errorMessage.textContent = message;
  errorMessage.classList.add('show');
}

function hideError() {
  errorMessage.classList.remove('show');
}

// ===== 初始化完成 =====
// init() 已在 DOMContentLoaded 中调用，无需在此重复调用
