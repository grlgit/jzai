/**
 * 见智 CoWorker - Electron 主进程
 * 路线3: Windows 原生应用
 *
 * 功能:
 * - 生命周期管理
 * - 托盘图标
 * - 拉起/守护 gateway 子进程
 * - 激活流程 (token / jzai:// 深链)
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, protocol, shell, session } = require('electron');
const path = require('path');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');

// ===== 加载日志(落盘到 %LOCALAPPDATA%/JZAI-CoWorker/logs/) =====
// 解决便携版双击运行 console 输出丢失、"无界面无法观察"的问题。
// 所有 console.log/error/warn 同步写入日志文件,并保留原控制台输出。
const LOG_DIR = path.join(process.env.LOCALAPPDATA || process.env.APPDATA || os.homedir(), 'JZAI-CoWorker', 'logs');
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) { /* 忽略 */ }
const LOG_FILE = path.join(LOG_DIR, `main-${new Date().toISOString().slice(0, 10)}.log`);
function appendLog(level, args) {
  try {
    const msg = args.map(a => {
      if (a instanceof Error) return a.stack || a.message;
      if (typeof a === 'object') { try { return JSON.stringify(a); } catch (_) { return String(a); } }
      return String(a);
    }).join(' ');
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} [${level}] ${msg}\n`);
  } catch (_) { /* 忽略 */ }
}
const _consoleLog = console.log.bind(console);
const _consoleError = console.error.bind(console);
const _consoleWarn = console.warn.bind(console);
console.log = (...a) => { appendLog('log', a); _consoleLog(...a); };
console.error = (...a) => { appendLog('error', a); _consoleError(...a); };
console.warn = (...a) => { appendLog('warn', a); _consoleWarn(...a); };
process.on('uncaughtException', (e) => console.error('[main] uncaughtException:', e));
process.on('unhandledRejection', (r) => console.error('[main] unhandledRejection:', r));

// ===== 性能追踪系统 =====
// 用于分析启动延迟，记录关键阶段的时间戳
const perfMetrics = {
  startTime: Date.now(),
  phases: {},

  mark(phase) {
    const now = Date.now();
    const elapsed = now - this.startTime;
    this.phases[phase] = now;
    console.log(`[PERF] ${phase}: +${elapsed}ms`);

    // 如果耗时过长，发出警告
    if (elapsed > 3000) {
      console.warn(`[PERF] ${phase} 耗时过长: ${elapsed}ms`);
    }

    return elapsed;
  },

  measure(from, to) {
    const fromTime = this.phases[from];
    const toTime = this.phases[to];
    if (fromTime && toTime) {
      const duration = toTime - fromTime;
      console.log(`[PERF] ${from} -> ${to}: ${duration}ms`);
      return duration;
    }
    return null;
  },

  summary() {
    console.log('[PERF] ===== 性能总结 =====');
    console.log(`[PERF] 总启动时间: ${Date.now() - this.startTime}ms`);

    const sortedPhases = Object.entries(this.phases)
      .sort((a, b) => a[1] - b[1]);

    let prevTime = this.startTime;
    for (const [phase, time] of sortedPhases) {
      const duration = time - prevTime;
      console.log(`[PERF] ${phase}: +${duration}ms (累计: ${time - this.startTime}ms)`);
      prevTime = time;
    }
  }
};

// 记录启动开始
perfMetrics.mark('app-start');
console.log(`[main] === 启动 === electron=${process.versions.electron} node=${process.versions.node} arch=${process.arch} platform=${process.platform} cwd=${process.cwd()}`);
console.log(`[main] 日志文件: ${LOG_FILE}`);

// 状态管理
let mainWindow = null;
let tray = null;
let gatewayProcess = null;
const isDev = process.argv.includes('--dev');

// Gateway 认证 token（本地生成，每次 Gateway 重启时更新）
let currentGatewayToken = null;

// OpenClaw gateway 配置
const GATEWAY_PORT = 18789;
const GATEWAY_URL = `http://127.0.0.1:${GATEWAY_PORT}`;

// ===== 日志功能 =====

// Track renderer readiness state
let rendererReady = false;

/**
 * 发送日志到渲染进程 (仅当渲染进程已就绪)
 */
function sendLog(message, type = 'info') {
  // 只有在渲染进程就绪后才发送，避免循环依赖
  if (rendererReady && mainWindow && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    try {
      mainWindow.webContents.send('log-message', { message, type });
    } catch (e) {
      // IPC发送失败时忽略，不影响主进程日志
    }
  }
}

/**
 * 包装 console.log 以自动发送到渲染进程
 */
const originalLog = console.log;
const originalError = console.error;
const originalWarn = console.warn;

console.log = (...args) => {
  originalLog(...args);
  sendLog(args.join(' '), 'info');
};

console.error = (...args) => {
  originalError(...args);
  sendLog(args.join(' '), 'error');
};

console.warn = (...args) => {
  originalWarn(...args);
  sendLog(args.join(' '), 'warn');
};

// 配置目录
const getUserDataPath = () => {
  // Electron app.getPath('userData') 在开发/生产环境有不同位置
  return app.getPath('userData');
};

const getOpenClawConfigPath = () => {
  // OpenClaw 使用 ~/.openclaw 目录
  const homeDir = app.getPath('home');
  return path.join(homeDir, '.openclaw');
};

const getOpenClawJsonPath = () => {
  return path.join(getOpenClawConfigPath(), 'openclaw.json');
};

const getExtensionsPath = () => {
  return path.join(getOpenClawConfigPath(), 'extensions');
};

// Token 配置文件路径（用于自动激活）
const getTokenConfigPath = () => {
  const homeDir = app.getPath('home');
  return path.join(homeDir, 'jzai-config.json');
};

// 持久化 token 路径（激活后保存，用于 API 认证）
const getPersistentTokenPath = () => {
  const openclawDir = getOpenClawConfigPath();
  return path.join(openclawDir, 'jianzhi-token.json');
};

/**
 * 读取持久化 token
 * 旧版本可能把用户 JWT(eyJ...) 当作 CoWorker 凭证写入；JWT 2h 过期且 Gateway 已拒绝。
 * 检测到 JWT 时视为无效，触发重新激活流程。
 */
function readPersistentToken() {
  const tokenPath = getPersistentTokenPath();
  try {
    if (fs.existsSync(tokenPath)) {
      const content = fs.readFileSync(tokenPath, 'utf-8');
      const data = JSON.parse(content);
      if (data.token && typeof data.token === 'string' && data.token.startsWith('eyJ')) {
        console.warn('[Persistent Token] 发现旧版用户 JWT 凭据，已失效，需要重新激活');
        return null;
      }
      return data;
    }
  } catch (error) {
    console.error('[Persistent Token] 读取失败:', error);
  }
  return null;
}

/**
 * 判断一个字符串是否为旧版用户 JWT（eyJ...）。
 * CoWorker API Key 必须以 jw_ 开头；eyJ 开头的 token 已废弃且会过期。
 */
function isLegacyJwtToken(token) {
  return !!token && typeof token === 'string' && token.startsWith('eyJ');
}

/**
 * 清理过期/无效的本地凭据。
 * 如果持久化 token 是旧版用户 JWT，则同时删除 token 文件和 openclaw.json，
 * 强制进入重新激活流程，避免 stale JWT 导致 Gateway 拒绝连接。
 */
function cleanupStaleCredentials() {
  const tokenPath = getPersistentTokenPath();
  const configPath = getOpenClawJsonPath();
  let hasStaleJwt = false;

  try {
    if (fs.existsSync(tokenPath)) {
      const data = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      if (isLegacyJwtToken(data.token)) {
        hasStaleJwt = true;
        fs.unlinkSync(tokenPath);
        console.log('[Cleanup] 已删除过期 JWT 凭据文件:', tokenPath);
      }
    }
  } catch (error) {
    console.warn('[Cleanup] 检查凭据文件失败:', error.message);
  }

  // token 文件缺失/无效时，残留的 openclaw.json 同样会误导启动流程，一并清理。
  // 即使 token 文件有效，若 openclaw.json 里仍嵌着过期 JWT，也必须删除，否则 bridge
  // 会从 pluginConfig 读到 JWT 而被主台拒绝。
  const tokenValid = !hasStaleJwt && fs.existsSync(tokenPath);
  let configHasJwt = false;
  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const cfgToken = cfg?.models?.providers?.['jianzhi-proxy']?.apiKey
        || cfg?.plugins?.entries?.['jianzhi-bridge']?.config?.token;
      if (isLegacyJwtToken(cfgToken)) configHasJwt = true;
      const mcpAuth = cfg?.mcp?.servers?.['jianzhi-kb']?.headers?.Authorization;
      if (isLegacyJwtToken(typeof mcpAuth === 'string' ? mcpAuth.replace(/^Bearer\s+/i, '') : undefined)) {
        configHasJwt = true;
      }
    } catch { /* 解析失败会在下面统一处理 */ }
  }

  if ((!tokenValid || configHasJwt) && fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const cfgToken = cfg?.models?.providers?.['jianzhi-proxy']?.apiKey
        || cfg?.plugins?.entries?.['jianzhi-bridge']?.config?.token;
      const mcpAuth = cfg?.mcp?.servers?.['jianzhi-kb']?.headers?.Authorization;
      const mcpToken = typeof mcpAuth === 'string' ? mcpAuth.replace(/^Bearer\s+/i, '') : undefined;
      if (isLegacyJwtToken(cfgToken) || isLegacyJwtToken(mcpToken) || !tokenValid) {
        fs.unlinkSync(configPath);
        console.log('[Cleanup] 已删除过期/孤立配置 openclaw.json:', configPath);
      }
    } catch (error) {
      // 解析失败也删除，避免坏配置阻止激活
      try { fs.unlinkSync(configPath); } catch {}
      console.log('[Cleanup] 已删除无法解析的 openclaw.json:', configPath);
    }
  }

  return hasStaleJwt;
}

/**
 * 保存持久化 token
 */
function savePersistentToken(token, mainUrl, coworkerId, assignmentId) {
  const tokenPath = getPersistentTokenPath();
  try {
    fs.mkdirSync(getOpenClawConfigPath(), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ token, mainUrl, coworkerId, assignmentId }, null, 2));
    console.log('[Persistent Token] Token 已保存到:', tokenPath);
  } catch (error) {
    console.error('[Persistent Token] 保存失败:', error);
  }
}

// ===== Gateway 认证 token =====
// 独立文件：savePersistentToken 会整体覆盖 jianzhi-token.json，不能混放
const getGatewayTokenPath = () => {
  return path.join(getOpenClawConfigPath(), 'jianzhi-gateway-token.json');
};

/**
 * 读取（或首次生成）Gateway 认证 token。
 * 必须跨启动稳定，否则 webview 中 Control UI 持久化的凭据会全部失效。
 */
function loadOrCreateGatewayToken() {
  const tokenPath = getGatewayTokenPath();
  try {
    if (fs.existsSync(tokenPath)) {
      const saved = JSON.parse(fs.readFileSync(tokenPath, 'utf-8'));
      if (saved && typeof saved.token === 'string' && saved.token.length >= 32) {
        return saved.token;
      }
    }
  } catch (error) {
    console.error('[Gateway Token] 读取失败，将重新生成:', error.message);
  }

  const token = require('crypto').randomBytes(32).toString('hex');
  try {
    fs.mkdirSync(getOpenClawConfigPath(), { recursive: true });
    fs.writeFileSync(tokenPath, JSON.stringify({ token }, null, 2), { mode: 0o600 });
    console.log('[Gateway Token] 已生成并持久化到:', tokenPath);
  } catch (error) {
    // 落盘失败时仍返回 token，本次启动可用，下次会再生成一个新的
    console.error('[Gateway Token] 持久化失败，本次使用临时 token:', error.message);
  }

  // token 是新的，webview 里 Control UI 存下的旧 gateway/device 凭据必然失效。
  // 旧版本每次启动都换 token，升级后必须清一次，否则会持续 device_token_mismatch。
  clearGatewayWebStorage();
  return token;
}

/** 清理 webview 中 gateway origin 的存储凭据（localStorage / IndexedDB 等）。 */
function clearGatewayWebStorage() {
  try {
    session.defaultSession
      .clearStorageData({ origin: GATEWAY_URL })
      .then(() => console.log('[Gateway Token] 已清理 webview 中的旧凭据'))
      .catch(err => console.warn('[Gateway Token] 清理旧凭据失败:', err.message));
  } catch (error) {
    console.warn('[Gateway Token] 清理旧凭据失败:', error.message);
  }
}

/**
 * 校正 openclaw.json 中的凭据与 gateway token。
 * 服务端下发的配置可能仍包含已过期 JWT；openclaw.json 里也可能残留旧 gateway.auth.token。
 * 在 Gateway 启动前统一替换，并刷新 meta.lastTouchedAt，避免 OpenClaw 触发自动恢复。
 */
function sanitizeOpenClawConfig(gatewayToken, persistentToken) {
  if (!gatewayToken || !persistentToken) return;
  const configPath = getOpenClawJsonPath();
  if (!fs.existsSync(configPath)) return;

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const cfg = JSON.parse(raw);
    let changed = false;

    // 替换模型 provider 中的 JWT
    const providerKey = cfg?.models?.providers?.['jianzhi-proxy']?.apiKey;
    if (isLegacyJwtToken(providerKey)) {
      cfg.models.providers['jianzhi-proxy'].apiKey = persistentToken;
      changed = true;
      console.log('[Gateway Config] 已替换 jianzhi-proxy apiKey 中的过期 JWT');
    }

    // 替换 MCP Authorization 头中的 JWT
    const mcpAuth = cfg?.mcp?.servers?.['jianzhi-kb']?.headers?.Authorization;
    if (typeof mcpAuth === 'string') {
      const mcpToken = mcpAuth.replace(/^Bearer\s+/i, '');
      if (isLegacyJwtToken(mcpToken)) {
        cfg.mcp.servers['jianzhi-kb'].headers.Authorization = `Bearer ${persistentToken}`;
        changed = true;
        console.log('[Gateway Config] 已替换 jianzhi-kb Authorization 中的过期 JWT');
      }
    }

    // 替换 bridge 插件配置中的 JWT
    const bridgeToken = cfg?.plugins?.entries?.['jianzhi-bridge']?.config?.token;
    if (isLegacyJwtToken(bridgeToken)) {
      cfg.plugins.entries['jianzhi-bridge'].config.token = persistentToken;
      changed = true;
      console.log('[Gateway Config] 已替换 jianzhi-bridge token 中的过期 JWT');
    }

    // 同步 gateway.auth.token，防止与 Control UI URL fragment 不一致
    if (cfg.gateway?.auth?.token !== gatewayToken) {
      if (!cfg.gateway) cfg.gateway = {};
      cfg.gateway.auth = { mode: 'token', token: gatewayToken };
      changed = true;
      console.log('[Gateway Config] 已同步 gateway.auth.token');
    }

    if (changed) {
      if (!cfg.meta) cfg.meta = {};
      cfg.meta.lastTouchedAt = new Date().toISOString();
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), 'utf-8');
      console.log('[Gateway Config] openclaw.json 已校正并刷新 meta');
    }
  } catch (error) {
    console.warn('[Gateway Config] 校正 openclaw.json 失败:', error.message);
  }
}

// ===== 首次引导（onboarding）状态 =====
// 独立文件：savePersistentToken 会整体覆盖 jianzhi-token.json，不能把引导状态放进去
const getOnboardingStatePath = () => {
  return path.join(getOpenClawConfigPath(), 'jianzhi-onboarding.json');
};

const DEFAULT_ONBOARDING = { completed: false, step: 0, skipped: [], profileCompleted: false };

function readOnboardingCache() {
  try {
    const statePath = getOnboardingStatePath();
    if (fs.existsSync(statePath)) {
      return { ...DEFAULT_ONBOARDING, ...JSON.parse(fs.readFileSync(statePath, 'utf-8')) };
    }
  } catch (error) {
    console.error('[Onboarding] 本地缓存读取失败:', error.message);
  }
  return null;
}

function writeOnboardingCache(patch) {
  const merged = { ...DEFAULT_ONBOARDING, ...(readOnboardingCache() || {}), ...patch };
  try {
    fs.mkdirSync(getOpenClawConfigPath(), { recursive: true });
    fs.writeFileSync(getOnboardingStatePath(), JSON.stringify(merged, null, 2));
  } catch (error) {
    console.error('[Onboarding] 本地缓存写入失败:', error.message);
  }
  return merged;
}

async function fetchServerOnboarding(mainUrl, assignmentId) {
  if (!mainUrl || !assignmentId) return null;
  try {
    const axios = require('axios');
    const res = await axios.get(`${mainUrl}/api/cw/assignment/${assignmentId}/onboarding`, { timeout: 8000 });
    return { ...DEFAULT_ONBOARDING, ...(res.data && res.data.onboarding ? res.data.onboarding : {}) };
  } catch (error) {
    console.warn('[Onboarding] 服务端状态拉取失败，回退本地缓存:', error.message);
    return null;
  }
}

async function pushServerOnboarding(mainUrl, assignmentId, patch) {
  if (!mainUrl || !assignmentId) return null;
  try {
    const axios = require('axios');
    const res = await axios.post(`${mainUrl}/api/cw/assignment/${assignmentId}/onboarding`, patch, { timeout: 8000 });
    return { ...DEFAULT_ONBOARDING, ...(res.data && res.data.onboarding ? res.data.onboarding : {}) };
  } catch (error) {
    console.warn('[Onboarding] 服务端状态写入失败，仅保留本地缓存:', error.message);
    return null;
  }
}

function needWechatBindFrom(state) {
  if (!state) return true;
  const skipped = Array.isArray(state.skipped) ? state.skipped : [];
  return !(state.completed || skipped.includes('wechat') || skipped.includes('all'));
}

/**
 * 初始化判定的唯一来源
 * 服务端可达时以服务端为准并刷新缓存；不可达时用本地缓存，二者皆无才视为待绑定
 */
async function resolveInitState() {
  const persistentToken = readPersistentToken();
  const hasToken = !!(persistentToken && persistentToken.token);
  const hasOpenClawJson = fs.existsSync(getOpenClawJsonPath());

  if (!hasToken || !hasOpenClawJson) {
    console.log('[InitState] 需要激活 hasToken:', hasToken, 'hasOpenClawJson:', hasOpenClawJson);
    return { needEnroll: true, needWechatBind: false, coworkerId: null, assignmentId: null };
  }

  const serverState = await fetchServerOnboarding(persistentToken.mainUrl, persistentToken.assignmentId);
  if (serverState) writeOnboardingCache(serverState);
  const state = serverState || readOnboardingCache();

  const initState = {
    needEnroll: false,
    needWechatBind: needWechatBindFrom(state),
    coworkerId: persistentToken.coworkerId || null,
    assignmentId: persistentToken.assignmentId || null,
    onboarding: state || DEFAULT_ONBOARDING,
    serverReachable: !!serverState,
  };
  console.log('[InitState]', JSON.stringify(initState));
  return initState;
}

/**
 * 记录微信绑定结果（主进程侧落状态，不依赖渲染进程存活）
 * 跳过/超时/失败只标记 skipped，不标记 completed，管理端待办列表仍可看到
 */
async function recordWechatState(bound) {
  const persistentToken = readPersistentToken() || {};
  const patch = bound ? { completed: true, step: 2 } : { step: 1, skipped: ['wechat'] };
  writeOnboardingCache(patch);
  await pushServerOnboarding(persistentToken.mainUrl, persistentToken.assignmentId, patch);
  console.log('[Onboarding] 微信绑定状态已记录:', bound ? 'bound' : 'skipped');
}

// ===== 自动激活逻辑 =====

/**
 * 检查是否存在 token 配置文件
 */
function hasTokenConfig() {
  const configPath = getTokenConfigPath();
  return fs.existsSync(configPath);
}

/**
 * 读取 token 配置文件
 */
function readTokenConfig() {
  const configPath = getTokenConfigPath();
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return JSON.parse(content);
  } catch (error) {
    console.error('[Token Config] 读取失败:', error);
    return null;
  }
}

/**
 * 删除 token 配置文件（激活成功后清理）
 */
function deleteTokenConfig() {
  const configPath = getTokenConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
      console.log('[Token Config] 配置文件已删除');
    }
  } catch (error) {
    console.error('[Token Config] 删除失败:', error);
  }
}

/**
 * 解析并校验工作目录
 * 显式指定的目录不可用时直接报错；未指定时才退到临时目录
 */
function resolveWorkDir(workDir) {
  const explicit = !!workDir;
  let finalWorkDir = workDir || path.join(app.getPath('documents'), 'JZAI-Workspace');

  try {
    fs.mkdirSync(finalWorkDir, { recursive: true });
  } catch (err) {
    if (explicit) throw new Error(`工作目录无法创建: ${finalWorkDir}`);
    console.warn('[Enroll] 默认工作目录创建失败，使用临时目录:', err.message);
    finalWorkDir = path.join(os.tmpdir(), 'jzai-workspace');
    fs.mkdirSync(finalWorkDir, { recursive: true });
  }

  try {
    const testFilePath = path.join(finalWorkDir, '.jzai-write-test');
    fs.writeFileSync(testFilePath, 'test');
    fs.unlinkSync(testFilePath);
  } catch (err) {
    throw new Error(`工作目录不可写: ${finalWorkDir}`);
  }

  console.log('[Enroll] 工作目录:', finalWorkDir);
  return finalWorkDir;
}

/**
 * 把人格指令写入 workspace 根目录的 SOUL.md。
 * 新版 OpenClaw 移除了 agents.defaults.systemPromptOverride —— 写入未知键会让整份配置
 * 校验失败（gateway exit 78），因此人格只能走 SOUL.md 这条通道。
 * 管理台是人格的唯一来源，故覆盖写入（先备份），否则控制台改了人设永远到不了已激活的客户端。
 */
function writeSoulFile(workDir, soul) {
  const content = typeof soul === 'string' ? soul.trim() : '';
  if (!content) {
    console.log('[Soul] 未下发人格指令，跳过 SOUL.md');
    return;
  }
  try {
    const soulPath = path.join(workDir, 'SOUL.md');
    if (fs.existsSync(soulPath) && fs.readFileSync(soulPath, 'utf-8') === content) {
      console.log('[Soul] SOUL.md 无变化');
      return;
    }
    fs.mkdirSync(workDir, { recursive: true });
    if (fs.existsSync(soulPath)) {
      try { fs.copyFileSync(soulPath, soulPath + '.backup'); } catch { /* 备份失败不阻断 */ }
    }
    fs.writeFileSync(soulPath, content, 'utf-8');
    console.log(`[Soul] 人格已写入 ${soulPath} (${content.length} 字符)`);
  } catch (e) {
    console.error('[Soul] SOUL.md 写入失败:', e.message);
  }
}

/**
 * 激活的唯一实现：自动激活与手动激活共用
 */
async function applyEnrollment({ token, mainUrl, workDir }) {
  const axios = require('axios');
  const response = await axios.get(`${mainUrl}/api/coworkers/enroll`, {
    params: { token },
    timeout: 30000,
  });

  const { config, coworkerId, assignmentId, token: enrollToken } = response.data;
  const effectiveMainUrl = mainUrl || response.data.mainUrl || '';

  if (!enrollToken || (typeof enrollToken === 'string' && enrollToken.startsWith('eyJ'))) {
    console.error('[Enroll] 服务器返回了无效凭据，期望 jw_ 格式的 CoWorker API Key');
    throw new Error('服务器返回了无效凭据，请检查 AI 员工分配状态');
  }

  const openclawDir = getOpenClawConfigPath();
  const configPath = getOpenClawJsonPath();
  fs.mkdirSync(openclawDir, { recursive: true });

  let parsedConfig;
  try {
    parsedConfig = JSON.parse(config);
    if (typeof parsedConfig !== 'object' || parsedConfig === null) {
      throw new Error('配置不是有效的对象');
    }
  } catch (e) {
    console.error('[Enroll] 配置验证失败:', e.message);
    throw new Error('服务器返回的配置格式无效');
  }
  if (config.length < 100) {
    console.warn(`[Enroll] 警告: 配置内容过小 (${config.length} 字节)，可能不完整`);
  }
  console.log(`[Enroll] 配置大小: ${config.length} 字节，顶级键:`, Object.keys(parsedConfig).join(', '));

  const finalWorkDir = resolveWorkDir(workDir);

  if (fs.existsSync(configPath)) {
    try {
      fs.copyFileSync(configPath, configPath + '.backup');
      console.log('[Enroll] 已备份原配置');
    } catch (e) {
      console.warn('[Enroll] 备份失败:', e.message);
    }
  }

  // OpenClaw 配置验证不接受 ${VAR} 格式，需要替换为实际值
  let configString = JSON.stringify(parsedConfig, null, 2);
  const replacements = {
    JIANZHI_MAIN_URL: effectiveMainUrl,
    JIANZHI_CW_TOKEN: enrollToken || '',
  };
  for (const [key, value] of Object.entries(replacements)) {
    if (!value) {
      console.warn(`[Enroll] 警告: ${key} 值为空，跳过替换`);
      continue;
    }
    const pattern = new RegExp(`\\$\\{${key}\\}`, 'g');
    const replaceCount = (configString.match(pattern) || []).length;
    if (replaceCount > 0) {
      configString = configString.replace(pattern, value);
      console.log(`[Enroll] 已替换 ${key} 占位符 ${replaceCount} 次`);
    }
  }

  // 服务端下发的是面向容器的 /workspace，Windows 原生需改为真实路径
  try {
    const configObj = JSON.parse(configString);
    if (configObj.agents && configObj.agents.defaults) {
      configObj.agents.defaults.workspace = finalWorkDir;
      console.log('[Enroll] 工作目录已注入配置:', finalWorkDir);
    }
    configString = JSON.stringify(configObj, null, 2);
  } catch (e) {
    console.warn('[Enroll] 工作目录注入失败:', e.message);
  }

  const residual = configString.match(/\$\{[^}]+\}/g);
  if (residual) {
    console.warn('[Enroll] 配置中仍有占位符:', [...new Set(residual)]);
  }

  fs.writeFileSync(configPath, configString);
  console.log('[Enroll] 配置已写入');

  writeSoulFile(finalWorkDir, response.data.soul);

  savePersistentToken(enrollToken, effectiveMainUrl, coworkerId, assignmentId);

  const resourcesPath = process.resourcesPath || path.join(__dirname, '..', 'resources');
  const extensionsDir = getExtensionsPath();
  fs.mkdirSync(extensionsDir, { recursive: true });

  const sourceBridge = path.join(resourcesPath, 'extensions', 'jianzhi-bridge');
  const targetBridge = path.join(extensionsDir, 'jianzhi-bridge');
  if (fs.existsSync(sourceBridge)) {
    fs.mkdirSync(targetBridge, { recursive: true });
    copyDirRecursive(sourceBridge, targetBridge);
    console.log('[Enroll] jianzhi-bridge 插件已复制');
  } else {
    console.warn('[Enroll] jianzhi-bridge 源码不存在:', sourceBridge);
  }

  installWeChatPlugin(extensionsDir).catch(err => {
    console.warn('[Enroll] 微信插件安装失败:', err.message);
  });

  return { coworkerId, assignmentId, workDir: finalWorkDir };
}

/**
 * 执行自动激活
 */
async function autoActivate() {
  const tokenConfig = readTokenConfig();
  if (!tokenConfig || !tokenConfig.token) {
    console.log('[Auto Activate] 无有效 token 配置');
    return false;
  }

  console.log('[Auto Activate] 开始自动激活...');
  console.log('[Auto Activate] Token:', tokenConfig.token.substring(0, 6) + '...');
  console.log('[Auto Activate] MainUrl:', tokenConfig.mainUrl);

  try {
    const { coworkerId, assignmentId } = await applyEnrollment({
      token: tokenConfig.token,
      mainUrl: tokenConfig.mainUrl,
      workDir: tokenConfig.workDir,
    });

    deleteTokenConfig();

    console.log('[Auto Activate] 激活成功! CoWorker:', coworkerId, 'Assignment:', assignmentId);

    if (mainWindow) {
      mainWindow.webContents.send('activation-success', { coworkerId, assignmentId });
    }

    return true;
  } catch (error) {
    console.error('[Auto Activate] 失败:', error.message);

    if (mainWindow) {
      mainWindow.webContents.send('activation-error', { error: error.message });
    }

    return false;
  }
}

// ===== 协议注册 (jzai:// 深链) =====

const PROTOCOL_SCHEME = 'jzai';

function registerProtocol() {
  if (process.defaultSession) {
    protocol.registerHttpProtocol(PROTOCOL_SCHEME, (request) => {
      // 解析 deep link: jzai://enroll?token=XXXX
      const url = new URL(request.url);
      if (url.hostname === 'enroll') {
        const token = url.searchParams.get('token');
        if (token && mainWindow) {
          mainWindow.webContents.send('enroll-token', { token });
        }
      }
    });
  }
}

// ===== Gateway 子进程管理 =====

/**
 * 解析 node 可执行文件：优先随包分发的运行时，其次系统 PATH
 */
function resolveNodeBinary() {
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.resourcesPath || '', 'runtime', 'win-x64', 'node.exe'),
        path.join(__dirname, 'resources', 'runtime', 'win-x64', 'node.exe'),
      ]
    : [];

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      console.log('[Gateway] 使用内置 Node 运行时:', candidate);
      return candidate;
    }
  }

  console.log('[Gateway] 未找到内置 Node 运行时，回退系统 PATH');
  return 'node';
}

function startGateway() {
  perfMetrics.mark('start-gateway');
  console.log('[Gateway] 启动 Gateway');

  if (gatewayProcess) {
    console.log('[Gateway] 已经在运行');
    return;
  }

  let openclawDir = null;  // 声明变量，避免 ReferenceError

  // 检查配置是否存在
  const configPath = getOpenClawJsonPath();
  if (!fs.existsSync(configPath)) {
    console.log('[Gateway] 配置不存在，等待激活...');
    perfMetrics.mark('gateway-need-activation');
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', { status: 'need-activation' });
    }
    return;
  }

  // 查找 OpenClaw 运行时
  // 优先级: resources/openclaw > cwd/openclaw
  console.log('[Gateway] ===== OpenClaw 路径查找 =====');
  console.log('[Gateway] process.resourcesPath:', process.resourcesPath);
  console.log('[Gateway] __dirname:', __dirname);
  console.log('[Gateway] process.cwd():', process.cwd());

  const openclawPaths = [
    path.join(process.resourcesPath || '', 'openclaw'),
    path.join(__dirname, '..', 'openclaw'),
    path.join(process.resourcesPath || '', 'app', 'openclaw'),  // 备选路径
  ];

  console.log('[Gateway] 搜索路径:');
  openclawPaths.forEach((p, i) => {
    const exists = fs.existsSync(p);
    console.log(`  [${i}] ${p} - ${exists ? '存在' : '不存在'}`);
    if (exists && !openclawDir) {
      openclawDir = p;
    }
  });

  // 原有循环逻辑作为备用
  for (const p of openclawPaths) {
    if (fs.existsSync(p) && !openclawDir) {
      openclawDir = p;
      break;
    }
  }

  if (!openclawDir) {
    console.error('[Gateway] 未找到 OpenClaw 运行时');
    console.error('[Gateway] 尝试的路径均不存在');
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', { status: 'error', message: '未找到 OpenClaw 运行时' });
    }
    return;
  }

  console.log('[Gateway] 找到 OpenClaw:', openclawDir);

  // 验证关键文件存在
  const openclawBin = path.join(openclawDir, 'openclaw.mjs');
  const distPath = path.join(openclawDir, 'dist');
  const entryJs = path.join(distPath, 'entry.js');

  if (!fs.existsSync(openclawBin)) {
    console.error('[Gateway] 错误: openclaw.mjs 不存在');
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', { status: 'error', message: 'OpenClaw 主程序缺失' });
    }
    return;
  }

  console.log('[Gateway] 验证: openclaw.mjs 存在');
  if (fs.existsSync(entryJs)) {
    console.log('[Gateway] 验证: dist/entry.js 存在');
  } else {
    console.warn('[Gateway] 警告: dist/entry.js 不存在（OpenClaw 可能不完整）');
  }

  console.log(`[Gateway] 启动: ${openclawBin}`);

  // 读取持久化 token 用于 API 认证
  const persistentToken = readPersistentToken();
  const gatewayEnv = { ...process.env };

  // jianzhi-bridge 插件使用的环境变量（如果有持久化 token）
  if (persistentToken && persistentToken.token) {
    gatewayEnv.JIANZHI_CW_TOKEN = persistentToken.token;
    gatewayEnv.JIANZHI_MAIN_URL = persistentToken.mainUrl;
    gatewayEnv.JIANZHI_COWORKER_ID = persistentToken.coworkerId;
    console.log('[Gateway] 使用持久化 token 设置 jianzhi-bridge 环境变量');
  }

  // Gateway 认证 token：必须跨启动保持稳定。
  // webview partition 会持久化 Control UI 存下的 gateway token 与 device token，
  // 每次启动换新 token 会让上一次的凭据全部失效（token_mismatch / device_token_mismatch）。
  currentGatewayToken = loadOrCreateGatewayToken();
  gatewayEnv.OPENCLAW_GATEWAY_TOKEN = currentGatewayToken;
  console.log('[Gateway] 使用认证 token (长度:', currentGatewayToken.length, ')');

  // 校正磁盘上 openclaw.json 的凭据：服务端下发/旧版本残留可能仍含过期 JWT，
  // gateway.auth.token 也可能与当前 token 不一致，必须在 Gateway 读取前修复。
  sanitizeOpenClawConfig(currentGatewayToken, persistentToken?.token);

  // 不再把 gateway.auth 写入 openclaw.json：
  // 1. Gateway 会优先读取 OPENCLAW_GATEWAY_TOKEN env；
  // 2. Control UI 从 URL fragment 取 currentGatewayToken，两者同源；
  // 3. 写入 config 会触发 OpenClaw 的 missing-meta-vs-last-good 自动恢复，
  //    把 gateway.auth.token 恢复成旧备份里的 token，反而导致 token_mismatch。

  // 启动 gateway 子进程
  const nodeBinary = resolveNodeBinary();
  gatewayProcess = spawn(nodeBinary, [openclawBin, 'gateway', 'run'], {
    cwd: openclawDir,
    stdio: 'pipe',
    env: gatewayEnv,
  });

  // 用于跟踪Gateway是否已发送ready信号
  let gatewayReadySent = false;
  let readyProbeTimer = null;
  let readyDeadline = 0;
  let spawnErrorSent = false;

  const stopReadyProbe = () => {
    if (readyProbeTimer) {
      clearTimeout(readyProbeTimer);
      readyProbeTimer = null;
    }
  };

  const emitRunning = (source) => {
    if (gatewayReadySent) return;
    gatewayReadySent = true;
    stopReadyProbe();
    console.log(`[Gateway] ${source} → 发送 running`);
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', { status: 'running' });
    }
  };

  // TCP 探测：只有真正 accept 到 GATEWAY_PORT 才算 running。
  // 不再用固定超时后备谎报——冷启在客户机上可能超过 2 分钟，谎报会导致 renderer
  // 抢先加载 UI 触发 ERR_CONNECTION_REFUSED，最后停在空白页。
  const PROBE_INTERVAL = 2000;
  const PROBE_TOTAL_MS = 5 * 60 * 1000;
  const probeGatewayReady = () => {
    if (gatewayReadySent) return;
    if (!gatewayProcess || gatewayProcess.killed) return;
    if (Date.now() > readyDeadline) {
      console.error('[Gateway] 5 分钟内未监听端口，放弃等待');
      if (mainWindow) {
        mainWindow.webContents.send('gateway-status', {
          status: 'error',
          reason: 'READY_TIMEOUT',
          message: `Gateway 启动超过 5 分钟仍未监听 ${GATEWAY_PORT} 端口，请查看日志`,
        });
      }
      return;
    }
    const net = require('net');
    const socket = net.createConnection({ host: '127.0.0.1', port: GATEWAY_PORT, timeout: 1500 });
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* ignore */ }
      if (ok) {
        emitRunning('TCP 探测已连通');
      } else {
        readyProbeTimer = setTimeout(probeGatewayReady, PROBE_INTERVAL);
      }
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.once('timeout', () => done(false));
  };

  gatewayProcess.on('error', (err) => {
    console.error('[Gateway] 子进程启动失败:', err.message);
    gatewayProcess = null;
    spawnErrorSent = true;

    stopReadyProbe();

    const runtimeMissing = err.code === 'ENOENT';
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', {
        status: 'error',
        reason: runtimeMissing ? 'RUNTIME_MISSING' : 'SPAWN_FAILED',
        message: runtimeMissing
          ? `未找到 Node 运行时（${nodeBinary}），请安装 Node.js 或使用完整安装包`
          : `运行时启动失败: ${err.message}`,
      });
    }
  });

  // bridge 凭据被主台拒绝时是终局错误：重连再多次也不会恢复，
  // 用户只会看到"人格不生效"这类间接症状，必须显式提示重新激活。
  const detectCredentialFailure = (chunk) => {
    if (!chunk.includes('CREDENTIAL_FAILURE')) return;
    console.error('[Gateway] bridge 凭据失效，需重新激活');
    if (mainWindow) {
      mainWindow.webContents.send('gateway-status', {
        status: 'error',
        reason: 'CREDENTIAL_INVALID',
        message: '主台拒绝了本机凭据（已失效或被吊销），请重新激活 AI 员工',
      });
    }
  };

  gatewayProcess.stdout.on('data', (data) => {
    console.log(`[Gateway stdout] ${data}`);
    if (data.includes('[gateway] ready')) {
      emitRunning('stdout 检测到 ready');
    }
    detectCredentialFailure(String(data));
  });

  gatewayProcess.stderr.on('data', (data) => {
    console.error(`[Gateway stderr] ${data}`);
    if (data.includes('[gateway] ready')) {
      emitRunning('stderr 检测到 ready');
    }
    detectCredentialFailure(String(data));
  });

  gatewayProcess.on('close', (code) => {
    console.log(`[Gateway] 进程退出，code: ${code}`);
    gatewayProcess = null;

    stopReadyProbe();

    if (mainWindow && !spawnErrorSent) {
      mainWindow.webContents.send('gateway-status', { status: 'stopped', code });
    }
  });

  if (mainWindow) {
    mainWindow.webContents.send('gateway-status', { status: 'starting' });
  }

  // 启动 TCP 探测；stdout 命中 ready 信号会更早触发 emitRunning。
  readyDeadline = Date.now() + PROBE_TOTAL_MS;
  readyProbeTimer = setTimeout(probeGatewayReady, PROBE_INTERVAL);
}

function stopGateway() {
  if (gatewayProcess && !gatewayProcess.killed) {
    console.log('[Gateway] 停止进程 PID:', gatewayProcess.pid);
    try {
      // 先尝试优雅关闭
      gatewayProcess.kill('SIGTERM');

      // 等待一小段时间后强制关闭
      const forceKill = setTimeout(() => {
        if (gatewayProcess && !gatewayProcess.killed) {
          console.warn('[Gateway] 进程未响应SIGTERM，强制关闭');
          try {
            gatewayProcess.kill('SIGKILL');
          } catch (e) {
            // 进程可能已经退出
          }
        }
      }, 2000);

      // 监听进程退出
      gatewayProcess.once('exit', () => {
        clearTimeout(forceKill);
        console.log('[Gateway] 进程已退出');
      });
    } catch (e) {
      console.error('[Gateway] 停止进程失败:', e);
    }
  }
  // 立即清除引用，避免残留
  gatewayProcess = null;
}

// ===== 托盘 =====

let trayEnabled = false; // 跟踪托盘是否成功创建

function createTray() {
  const trayIcon = path.join(__dirname, 'assets', 'tray-icon.png');

  // 尝试使用现有的图标文件作为托盘图标
  const fallbackIcon = path.join(__dirname, 'assets', 'icon.png');

  let iconToUse = trayIcon;
  if (!fs.existsSync(trayIcon)) {
    if (fs.existsSync(fallbackIcon)) {
      iconToUse = fallbackIcon;
      console.warn('[Tray] tray-icon.png 不存在，使用 icon.png 作为替代');
    } else {
      console.error('[Tray] 找不到托盘图标文件，托盘功能将禁用');
      console.error('[Tray] 关闭窗口将直接退出应用');
      return;
    }
  }

  try {
    tray = new Tray(iconToUse);
    trayEnabled = true;
    console.log('[Tray] 托盘创建成功');

    const contextMenu = Menu.buildFromTemplate([
      { label: '显示窗口', click: () => mainWindow?.show() },
      { label: '状态: 运行中', enabled: false },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() },
    ]);

    tray.setToolTip('见智 CoWorker');
    tray.setContextMenu(contextMenu);

    tray.on('click', () => {
      if (mainWindow) {
        if (mainWindow.isVisible()) {
          mainWindow.hide();
        } else {
          mainWindow.show();
        }
      }
    });
  } catch (e) {
    console.error('[Tray] 创建失败:', e.message);
    console.error('[Tray] 关闭窗口将直接退出应用');
    trayEnabled = false;
  }
}

// ===== 窗口管理 =====

function createWindow() {
  perfMetrics.mark('create-window-start');
  console.log(`[main] createWindow 开始: __dirname=${__dirname} resourcesPath=${process.resourcesPath}`);
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 700,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      webviewTag: true,
    },
    icon: path.join(__dirname, 'assets', 'icon.png'),
  });

  // 加载品牌壳页面 (P1: 简化版，直接显示 webview)
  const htmlPath = path.join(__dirname, 'renderer', 'index.html');
  console.log(`[main] loadFile: ${htmlPath} exists=${fs.existsSync(htmlPath)}`);
  perfMetrics.mark('load-file-start');
  mainWindow.loadFile(htmlPath);

  // 渲染进程加载诊断:加载失败/渲染错误/崩溃全部落盘,便于"无界面"时定位
  mainWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[renderer] did-fail-load code=${code} desc=${desc} url=${url}`);
    perfMetrics.mark('load-fail');
  });
  mainWindow.webContents.on('did-finish-load', () => {
    perfMetrics.mark('load-finish');
    console.log('[renderer] did-finish-load 页面加载完成');
    rendererReady = true; // 标记渲染进程就绪，可以发送IPC消息
  });

  // 添加超时检测：如果10秒内页面仍未加载完成，记录警告
  const loadTimeout = setTimeout(() => {
    if (!rendererReady) {
      console.error('[RENDERER-TIMEOUT] 页面加载超过10秒未完成！');
      console.error('[RENDERER-TIMEOUT] 可能原因：渲染进程崩溃、JavaScript错误或资源加载失败');
      perfMetrics.summary();
      // 尝试打开DevTools进行调试
      if (mainWindow && !mainWindow.webContents.isDestroyed()) {
        console.log('[RENDERER-TIMEOUT] 尝试打开DevTools...');
        mainWindow.webContents.openDevTools();
      }
    }
  }, 10000);

  mainWindow.webContents.on('did-finish-load', () => {
    clearTimeout(loadTimeout);
  });

  // Note: Disabled console-message listener to avoid infinite loop
  // The renderer console logs are already captured in the log file
  // mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
  //   console.log(`[renderer:lvl${level}] ${message} (${sourceId}:${line})`);
  // });
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[renderer] render-process-gone', details);
    console.error('[renderer] 崩溃原因:', JSON.stringify(details));
    rendererReady = false;

    // 如果渲染进程崩溃，尝试重启窗口
    console.error('[renderer] 渲染进程崩溃，5秒后尝试重启窗口...');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        console.log('[renderer] 重新加载页面...');
        mainWindow.reload();
      } else {
        console.log('[renderer] 窗口已销毁，创建新窗口...');
        createWindow();
      }
    }, 5000);
  });
  mainWindow.webContents.on('unresponsive', () => console.error('[renderer] unresponsive'));
  mainWindow.webContents.on('responsive', () => console.log('[renderer] responsive'));

  // 添加进程信息日志，帮助诊断多进程问题
  console.log('[PROCESS] 主进程 PID:', process.pid);
  console.log('[PROCESS] Electron 版本:', process.versions.electron);
  console.log('[PROCESS] Node 版本:', process.versions.node);
  console.log('[PROCESS] Chrome 版本:', process.versions.chrome);
  console.log('[PROCESS] 平台:', process.platform, '架构:', process.arch);

  // 开发模式打开 DevTools
  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  // 临时调试：发布版本也打开 DevTools (按 F12 或 Ctrl+Shift+I)
  mainWindow.webContents.on('devtools-opened', () => {
    console.log('[main] DevTools opened');
  });
  // 全局快捷键打开 DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.key === 'F12' || (input.control && input.shift && input.key === 'I')) {
      mainWindow.webContents.toggleDevTools();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 关闭窗口 = 退出应用：before-quit 会同步停掉 gateway/openclaw，
  // 避免"隐藏到托盘 → 用户以为退出实则后台仍在跑"，也避免多次装包叠出多个 gateway。
  mainWindow.on('close', () => {
    console.log('[Window] 窗口关闭，退出应用');
    app.quit();
  });

  // 等待窗口加载完成后启动 gateway
  mainWindow.webContents.on('did-finish-load', () => {
    perfMetrics.mark('window-ready');
    perfMetrics.measure('window-creation', 'create-window-start', 'window-ready');
    perfMetrics.measure('app-to-ready', 'app-start', 'window-ready');

    // 检查是否需要激活
    const configPath = getOpenClawJsonPath();
    const needsActivation = !fs.existsSync(configPath);

    if (needsActivation) {
      perfMetrics.mark('activation-need');
      console.log('[PERF] 需要激活');
      mainWindow.webContents.send('gateway-status', { status: 'need-activation' });
    } else {
      perfMetrics.mark('gateway-start-request');
      // 每次启动都刷新打包插件，OTA 装完的修复才能真正落到 ~/.openclaw/extensions
      refreshBundledExtensions();
      console.log('[PERF] 启动 Gateway');
      startGateway();
    }
  });
}

// ===== IPC 事件处理 =====

// 激活处理: renderer 发送 token，主进程调用 enroll API
ipcMain.handle('enroll', async (event, { token, mainUrl, workDir }) => {
  try {
    const { coworkerId, assignmentId } = await applyEnrollment({ token, mainUrl, workDir });

    // 激活成功后确保 Gateway 正在运行（已在运行则不重启）
    setTimeout(() => {
      if (!gatewayProcess) {
        console.log('[Enroll] Gateway 未运行，启动 Gateway');
        startGateway();
      } else {
        console.log('[Enroll] Gateway 已在运行，发送 running 状态');
        if (mainWindow) {
          mainWindow.webContents.send('gateway-status', { status: 'running' });
        }
      }
    }, 500);

    return { success: true, coworkerId, assignmentId };
  } catch (error) {
    console.error('[Enroll] 失败:', error.message);
    return { success: false, error: error.message };
  }
});

// 设置 mainUrl (用于 enroll 调用)
ipcMain.handle('set-main-url', async (event, { mainUrl }) => {
  // TODO: 持久化 mainUrl
  return { success: true };
});

// 退出应用
ipcMain.handle('quit-app', () => {
  app.quit();
});

// 辅助: 递归复制目录
function copyDirRecursive(src, dest) {
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(destPath, { recursive: true });
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

/**
 * 无条件刷新打包内自带的插件到 ~/.openclaw/extensions。
 * enroll() 只在首次激活时复制一次，OTA 装了新客户端也不会更新用户目录下的老插件；
 * 因此每次启动都要用打包版本覆盖，才能让 plugin.js 的修复真正生效。
 * 只处理 jianzhi-bridge —— 微信插件走自己的安装/守护流程。
 */
function refreshBundledExtensions() {
  try {
    const resourcesPath = process.resourcesPath || path.join(__dirname, '..', 'resources');
    const source = path.join(resourcesPath, 'extensions', 'jianzhi-bridge');
    if (!fs.existsSync(source)) {
      console.warn('[Extensions] 打包资源中缺少 jianzhi-bridge，跳过刷新:', source);
      return;
    }
    const extensionsDir = getExtensionsPath();
    fs.mkdirSync(extensionsDir, { recursive: true });
    const target = path.join(extensionsDir, 'jianzhi-bridge');

    // 用 plugin.js 的 mtime + size 做便宜的差异判定
    const srcPluginJs = path.join(source, 'plugin.js');
    const tgtPluginJs = path.join(target, 'plugin.js');
    let needCopy = true;
    if (fs.existsSync(srcPluginJs) && fs.existsSync(tgtPluginJs)) {
      const s = fs.statSync(srcPluginJs);
      const t = fs.statSync(tgtPluginJs);
      if (s.size === t.size && Math.abs(s.mtimeMs - t.mtimeMs) < 1000) {
        needCopy = false;
      }
    }
    if (!needCopy) {
      console.log('[Extensions] jianzhi-bridge 已是最新，跳过刷新');
      return;
    }
    fs.mkdirSync(target, { recursive: true });
    copyDirRecursive(source, target);
    // 对齐 mtime，便于下次判定
    if (fs.existsSync(srcPluginJs) && fs.existsSync(tgtPluginJs)) {
      const s = fs.statSync(srcPluginJs);
      fs.utimesSync(tgtPluginJs, s.atime, s.mtime);
    }
    console.log('[Extensions] jianzhi-bridge 已刷新到最新版本');
  } catch (err) {
    console.error('[Extensions] 刷新 jianzhi-bridge 失败:', err.message);
  }
}

// ===== 微信插件安装 =====

/**
 * 安装微信插件
 * 使用 npx 安装 @tencent-weixin/openclaw-weixin
 */
async function installWeChatPlugin(extensionsDir) {
  const wechatDir = path.join(extensionsDir, 'openclaw-weixin');

  // 检查是否已安装
  if (fs.existsSync(wechatDir) && fs.existsSync(path.join(wechatDir, 'package.json'))) {
    console.log('[WeChat] 微信插件已安装，跳过');
    return true;
  }

  // 优先：从打包资源复制（零网络、零 cmd 权限，绕开便携版 spawnSync cmd.exe EACCES）
  const bundledDir = path.join(
    process.resourcesPath || path.join(__dirname, '..', 'resources'),
    'extensions',
    'openclaw-weixin',
  );
  if (fs.existsSync(bundledDir) && fs.existsSync(path.join(bundledDir, 'package.json'))) {
    try {
      fs.mkdirSync(wechatDir, { recursive: true });
      copyDirRecursive(bundledDir, wechatDir);
      console.log('[WeChat] 微信插件已从打包资源复制');
      return true;
    } catch (copyError) {
      console.warn('[WeChat] 从打包资源复制失败，回退运行时安装:', copyError.message);
    }
  } else {
    console.warn('[WeChat] 打包资源未预装 openclaw-weixin，回退运行时安装');
  }

  // Fallback：npx / npm（需 cmd.exe 权限与公网，便携版常因 EACCES 失败）
  console.log('[WeChat] 安装微信插件(npx)...');

  try {
    const { execSync } = require('child_process');
    fs.mkdirSync(wechatDir, { recursive: true });

    // 使用 npx 安装微信插件
    execSync('npx -y @tencent-weixin/openclaw-weixin-cli install', {
      cwd: extensionsDir,
      stdio: 'pipe',
    });

    console.log('[WeChat] 微信插件安装成功');
    return true;
  } catch (error) {
    console.error('[WeChat] 微信插件安装失败:', error.message);

    // 尝试使用 npm 安装
    try {
      const { execSync } = require('child_process');
      execSync('npm install @tencent-weixin/openclaw-weixin --save --no-fund --no-audit', {
        cwd: wechatDir,
        stdio: 'pipe',
      });
      console.log('[WeChat] 微信插件 npm 安装成功');
      return true;
    } catch (npmError) {
      console.error('[WeChat] 微信插件 npm 安装也失败:', npmError.message);
      return false;
    }
  }
}

// ===== 微信登录 =====

let wechatLoginProcess = null;

/**
 * 执行微信登录（显示二维码）
 * 通过 spawn 执行 openclaw channels login 命令
 */
ipcMain.handle('wechat-login', async (event) => {
  // 检查 Gateway 是否运行
  if (!gatewayProcess || gatewayProcess.killed) {
    console.error('[WeChat Login] Gateway 未运行');
    return { success: false, error: 'Gateway 未运行，请先完成激活' };
  }

  // 查找 OpenClaw 运行时
  const openclawPaths = [
    path.join(process.resourcesPath || '', 'openclaw'),
    path.join(__dirname, '..', 'openclaw'),
  ];

  let openclawDir = null;
  for (const p of openclawPaths) {
    if (fs.existsSync(p)) {
      openclawDir = p;
      break;
    }
  }

  if (!openclawDir) {
    console.error('[WeChat Login] 未找到 OpenClaw 运行时');
    return { success: false, error: '未找到 OpenClaw 运行时' };
  }

  const openclawBin = path.join(openclawDir, 'openclaw.mjs');

  // 检查微信插件是否安装
  const wechatDir = path.join(getExtensionsPath(), 'openclaw-weixin');
  if (!fs.existsSync(wechatDir)) {
    console.warn('[WeChat Login] 微信插件未安装，尝试安装...');
    const installed = await installWeChatPlugin(getExtensionsPath());
    if (!installed) {
      return { success: false, error: '微信插件安装失败' };
    }
  }

  console.log('[WeChat Login] 启动微信登录流程...');

  // 启动登录进程
  try {
    const { spawn } = require('child_process');

    wechatLoginProcess = spawn(resolveNodeBinary(), [openclawBin, 'channels', 'login', '--channel', 'openclaw-weixin'], {
      cwd: openclawDir,
      stdio: 'pipe',
      env: { ...process.env, JIANZHI_CW_TOKEN: readPersistentToken()?.token || '' },
    });

    let loginSuccess = false;
    let qrCodeData = '';
    let qrCodeSent = false;

    // 捕获输出
    wechatLoginProcess.stdout.on('data', (data) => {
      const output = data.toString();
      console.log('[WeChat Login]', output);

      // 检查是否包含二维码链接（通常是 https://open.weixin.qq.com/... 或类似的链接）
      const urlMatch = output.match(/https:\/\/[^\s一-龥]+/gi);
      if (urlMatch && urlMatch.length > 0) {
        for (const url of urlMatch) {
          if (url.includes('weixin') || url.includes('wx')) {
            console.log('[WeChat Login] 发现二维码链接:', url);
            qrCodeData = url;

            // 发送二维码链接到渲染进程（在渲染进程中使用 CDN 生成二维码）
            if (!qrCodeSent) {
              qrCodeSent = true;
              console.log('[WeChat Login] 发送二维码链接到渲染进程');
              if (mainWindow && mainWindow.webContents) {
                mainWindow.webContents.send('wechat-login-qrcode', { qrUrl: url });
              }
            }
            break;
          }
        }
      }

      // 检查登录成功标识
      if (output.toLowerCase().includes('success') || output.toLowerCase().includes('登录成功') || output.includes('已登录')) {
        loginSuccess = true;
      }
    });

    wechatLoginProcess.stderr.on('data', (data) => {
      console.error('[WeChat Login stderr]', data.toString());
      // 不再发送错误输出到渲染进程，保持界面干净
    });

    wechatLoginProcess.on('close', (code) => {
      console.log(`[WeChat Login] 进程退出，code: ${code}`);
      wechatLoginProcess = null;

      const bound = loginSuccess || code === 0;
      // 主进程侧先落状态，不依赖渲染进程存活
      recordWechatState(bound).catch(err => {
        console.warn('[WeChat Login] 状态记录失败:', err.message);
      });

      if (mainWindow && mainWindow.webContents) {
        if (bound) {
          mainWindow.webContents.send('wechat-login-success', {});
        } else {
          mainWindow.webContents.send('wechat-login-error', { error: '登录未完成或超时' });
        }
      }
    });

    // 设置超时（5分钟）
    setTimeout(() => {
      if (wechatLoginProcess && !wechatLoginProcess.killed) {
        console.log('[WeChat Login] 超时，终止进程');
        wechatLoginProcess.kill();
        wechatLoginProcess = null;

        recordWechatState(false).catch(err => {
          console.warn('[WeChat Login] 状态记录失败:', err.message);
        });

        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('wechat-login-timeout', {});
        }
      }
    }, 5 * 60 * 1000);

    return { success: true };
  } catch (error) {
    console.error('[WeChat Login] 启动失败:', error.message);
    return { success: false, error: error.message };
  }
});

/**
 * 取消微信登录
 */
ipcMain.handle('wechat-login-cancel', async () => {
  const hadProcess = wechatLoginProcess && !wechatLoginProcess.killed;
  if (hadProcess) {
    console.log('[WeChat Login] 用户取消登录');
    wechatLoginProcess.kill();
    wechatLoginProcess = null;
  }
  // 无论是否有进程在跑都记录跳过，否则下次启动会重复引导
  // 本地缓存是同步写入的，服务端推送不阻塞界面
  recordWechatState(false).catch(err => {
    console.warn('[WeChat Login] 状态记录失败:', err.message);
  });
  return { success: true };
});

// IPC: 获取当前 Gateway token（用于 Control UI 自动认证）
// 返回本次启动生成的 Gateway 认证 token
ipcMain.handle('get-gateway-token', async () => {
  const persistentToken = readPersistentToken();
  console.log(`[Gateway Token] get-gateway-token invoked, currentGatewayToken exists=${!!currentGatewayToken}, length=${currentGatewayToken?.length || 0}`);
  return {
    token: currentGatewayToken || null,
    coworkerId: persistentToken?.coworkerId || null,
  };
});

// IPC: 初始化判定的唯一入口
ipcMain.handle('get-init-state', async () => {
  return resolveInitState();
});

// IPC: 手动补记微信绑定状态
ipcMain.handle('set-wechat-state', async (event, { bound }) => {
  await recordWechatState(!!bound);
  return { success: true };
});

// IPC: 重启 Gateway（诊断页重试）
ipcMain.handle('restart-gateway', async () => {
  console.log('[Gateway] 收到重启请求');
  stopGateway();
  await new Promise((resolve) => setTimeout(resolve, 500));
  startGateway();
  return { success: true };
});

// IPC: 导出日志到用户选择的位置（renderer 可传入自己的内存日志）
ipcMain.handle('export-logs', async (event, rendererLogs = []) => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showSaveDialog({
      defaultPath: `jzai-logs-${new Date().toISOString().slice(0, 10)}.txt`,
      filters: [{ name: '日志文件', extensions: ['txt', 'log'] }],
      title: '导出诊断日志',
    });
    if (result.canceled) return { success: false, error: '用户取消' };

    // 收集相关文件
    const lines = [];
    lines.push(`=== JZAI 诊断日志导出 ${new Date().toISOString()} ===`);
    lines.push(`electron=${process.versions.electron} node=${process.versions.node} platform=${process.platform} arch=${process.arch}`);
    lines.push(`LOG_FILE: ${LOG_FILE}`);

    if (Array.isArray(rendererLogs) && rendererLogs.length > 0) {
      lines.push('\n=== 渲染进程日志（UI）===');
      for (const log of rendererLogs) {
        const ts = log.timestamp || '';
        const type = log.type || 'info';
        lines.push(`[${type.toUpperCase()}] ${ts} ${log.message || ''}`);
      }
    }

    if (fs.existsSync(LOG_FILE)) {
      lines.push('\n=== 主进程日志 ===');
      lines.push(fs.readFileSync(LOG_FILE, 'utf-8'));
    } else {
      lines.push('\n[无主进程日志文件]');
    }

    // 收集配置文件快照（脱敏）
    try {
      const cfgPath = getOpenClawJsonPath();
      if (fs.existsSync(cfgPath)) {
        const raw = fs.readFileSync(cfgPath, 'utf-8');
        const cfg = JSON.parse(raw);
        const masked = JSON.parse(JSON.stringify(cfg));
        const mask = (obj) => {
          if (!obj || typeof obj !== 'object') return;
          for (const k of Object.keys(obj)) {
            if ((k === 'apiKey' || k === 'token') && typeof obj[k] === 'string') {
              obj[k] = obj[k].slice(0, 8) + '***';
            } else if (typeof obj[k] === 'object') {
              mask(obj[k]);
            }
          }
        };
        mask(masked);
        lines.push('\n=== openclaw.json 快照（脱敏）===');
        lines.push(JSON.stringify(masked, null, 2));
      } else {
        lines.push('\n[openclaw.json 不存在]');
      }
    } catch (e) {
      lines.push('\n[openclaw.json 读取失败: ' + e.message + ']');
    }

    // 收集持久化 token 快照（脱敏）
    try {
      const tkPath = getPersistentTokenPath();
      if (fs.existsSync(tkPath)) {
        const raw = fs.readFileSync(tkPath, 'utf-8');
        const tk = JSON.parse(raw);
        if (tk.token) tk.token = tk.token.slice(0, 8) + '***';
        lines.push('\n=== jianzhi-token.json 快照（脱敏）===');
        lines.push(JSON.stringify(tk, null, 2));
      } else {
        lines.push('\n[jianzhi-token.json 不存在]');
      }
    } catch (e) {
      lines.push('\n[jianzhi-token.json 读取失败: ' + e.message + ']');
    }

    // 收集 bridge 插件版本信息
    try {
      const resourcesPath = process.resourcesPath || path.join(__dirname, '..', 'resources');
      const pluginJsPath = path.join(resourcesPath, 'extensions', 'jianzhi-bridge', 'plugin.js');
      const extPluginJsPath = path.join(getExtensionsPath(), 'jianzhi-bridge', 'plugin.js');
      lines.push('\n=== jianzhi-bridge 插件 ===');
      lines.push(`bundled plugin.js exists=${fs.existsSync(pluginJsPath)}`);
      if (fs.existsSync(pluginJsPath)) {
        const s = fs.statSync(pluginJsPath);
        lines.push(`bundled plugin.js size=${s.size} mtime=${s.mtime.toISOString()}`);
      }
      lines.push(`installed plugin.js exists=${fs.existsSync(extPluginJsPath)}`);
      if (fs.existsSync(extPluginJsPath)) {
        const s = fs.statSync(extPluginJsPath);
        lines.push(`installed plugin.js size=${s.size} mtime=${s.mtime.toISOString()}`);
      }
    } catch (e) {
      lines.push('\n[插件信息读取失败: ' + e.message + ']');
    }

    fs.writeFileSync(result.filePath, lines.join('\n'), 'utf-8');
    console.log('[Logs] 已导出到:', result.filePath);
    return { success: true, path: result.filePath };
  } catch (error) {
    console.error('[Logs] 导出失败:', error);
    return { success: false, error: error.message };
  }
});

// IPC: 选择工作目录（Windows原生对话框）
ipcMain.handle('select-workdir', async () => {
  try {
    const { dialog } = require('electron');
    const result = await dialog.showOpenDialog({
      properties: ['openDirectory'],
      title: '选择工作目录',
      buttonLabel: '选择此目录',
      message: '选择AI员工将用于读写文件的工作目录',
    });

    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: '用户取消选择' };
    }

    const selectedPath = result.filePaths[0];

    // 验证路径：确保目录存在且可写
    try {
      const testFilePath = path.join(selectedPath, '.jzai-write-test');
      fs.writeFileSync(testFilePath, 'test');
      fs.unlinkSync(testFilePath);
    } catch (err) {
      return { success: false, error: `目录不可写: ${err.message}` };
    }

    console.log('[select-workdir] 用户选择目录:', selectedPath);
    return { success: true, path: selectedPath };
  } catch (err) {
    console.error('[select-workdir] 错误:', err);
    return { success: false, error: err.message };
  }
});

// ===== 应用生命周期 =====

app.whenReady().then(() => {
  perfMetrics.mark('when-ready');
  console.log('[main] whenReady fired');
  perfMetrics.measure('startup-to-ready', 'app-start', 'when-ready');
  cleanupStaleCredentials();

  // 启动快照：把本地关键文件状态一次性落盘，便于客户环境远程诊断
  try {
    const cfgPath = getOpenClawJsonPath();
    const tkPath = getPersistentTokenPath();
    const gwPath = getGatewayTokenPath();
    console.log('[StartupSnapshot] openclaw.json exists=', fs.existsSync(cfgPath));
    console.log('[StartupSnapshot] jianzhi-token.json exists=', fs.existsSync(tkPath));
    console.log('[StartupSnapshot] jianzhi-gateway-token.json exists=', fs.existsSync(gwPath));
    if (fs.existsSync(cfgPath)) {
      const raw = fs.readFileSync(cfgPath, 'utf-8');
      const cfg = JSON.parse(raw);
      console.log('[StartupSnapshot] openclaw.json top-level keys=', Object.keys(cfg).join(','));
      console.log('[StartupSnapshot] openclaw.json tools.allow count=', cfg.tools?.allow?.length);
      console.log('[StartupSnapshot] openclaw.json workspace=', cfg.agents?.defaults?.workspace);
      const apiKey = cfg.models?.providers?.['jianzhi-proxy']?.apiKey;
      const bridgeToken = cfg.plugins?.entries?.['jianzhi-bridge']?.config?.token;
      console.log('[StartupSnapshot] jianzhi-proxy apiKey prefix=', typeof apiKey === 'string' ? apiKey.slice(0, 10) + '...' : 'missing');
      console.log('[StartupSnapshot] jianzhi-bridge token prefix=', typeof bridgeToken === 'string' ? bridgeToken.slice(0, 10) + '...' : 'missing');
    }
    if (fs.existsSync(tkPath)) {
      const tk = JSON.parse(fs.readFileSync(tkPath, 'utf-8'));
      console.log('[StartupSnapshot] persistent token prefix=', tk.token ? tk.token.slice(0, 10) + '...' : 'missing');
      console.log('[StartupSnapshot] persistent coworkerId=', tk.coworkerId);
      console.log('[StartupSnapshot] persistent assignmentId=', tk.assignmentId);
      console.log('[StartupSnapshot] persistent mainUrl=', tk.mainUrl);
    }
  } catch (e) {
    console.error('[StartupSnapshot] 快照失败:', e.message);
  }

  registerProtocol();
  createWindow();
  createTray();

  // 检查并执行自动激活
  if (hasTokenConfig()) {
    console.log('[Startup] 发现 token 配置，执行自动激活...');
    // 延迟执行，确保窗口已创建
    setTimeout(() => {
      autoActivate().then(success => {
        if (success) {
          // 激活成功，启动 gateway
          setTimeout(() => {
            if (fs.existsSync(getOpenClawJsonPath())) {
              startGateway();
            }
          }, 1000);
        }
      });
    }, 2000);
  }

  // macOS: dock 点击显示窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });

  // 处理 deep link (Windows)
  app.on('second-instance', (e, cmdLine) => {
    for (const arg of cmdLine) {
      if (arg.startsWith(`${PROTOCOL_SCHEME}://`)) {
        const url = new URL(arg);
        if (url.hostname === 'enroll' && mainWindow) {
          const token = url.searchParams.get('token');
          mainWindow.webContents.send('enroll-token', { token });
        }
      }
    }
  });
});

app.on('window-all-closed', () => {
  // macOS: 保持运行
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let quitting = false;
app.on('before-quit', (event) => {
  if (quitting) return;
  quitting = true;
  app.isQuitting = true;
  console.log('[APP] before-quit - 清理资源');

  const pending = gatewayProcess && !gatewayProcess.killed ? gatewayProcess : null;
  stopGateway();

  // 清理微信登录进程
  if (typeof wechatLoginProcess !== 'undefined' && wechatLoginProcess) {
    console.log('[APP] 清理微信登录进程');
    try {
      wechatLoginProcess.kill();
    } catch (e) {
      console.error('[APP] 清理微信登录进程失败:', e);
    }
  }

  // 等 gateway 真正退出后再让 app 退，避免遗留孤儿进程占用 18789 端口。
  if (pending) {
    event.preventDefault();
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      console.log('[APP] gateway 已退出，继续 app.quit()');
      app.quit();
    };
    pending.once('exit', finish);
    // 最多再等 3 秒；stopGateway 内部 2s 后已 SIGKILL。
    setTimeout(finish, 3000);
  }
});

// 单实例锁 (可通过 --multi-instance 参数禁用，用于调试)
// 注意：此代码必须在 app.whenReady() 之后执行，否则会导致 app.quit() 无效
console.log('[SINGLE-INSTANCE] ===== 开始单实例锁检查 =====');
const allowMultiInstance = process.argv.includes('--multi-instance');
console.log('[SINGLE-INSTANCE] 检查 --multi-instance 参数:', allowMultiInstance);
if (allowMultiInstance) {
  console.warn('[SINGLE-INSTANCE] --multi-instance 参数已设置，允许多实例运行');
}

const gotLock = allowMultiInstance ? true : app.requestSingleInstanceLock();
console.log('[SINGLE-INSTANCE] app.requestSingleInstanceLock() 返回:', gotLock);

if (!gotLock) {
  console.error('[SINGLE-INSTANCE] 检测到已有实例运行，此实例将退出');
  console.error('[SINGLE-INSTANCE] 可能原因：');
  console.error('[SINGLE-INSTANCE] 1. 前一次运行的进程未正常退出（僵尸进程）');
  console.error('[SINGLE-INSTANCE] 2. 用户重复双击了exe文件');
  console.error('[SINGLE-INSTANCE] 3. 任务管理器中有残留的 JZAI-CoWorker 进程');
  console.error('[SINGLE-INSTANCE] 解决方案：请检查任务管理器并结束所有相关进程');
  console.error('[SINGLE-INSTANCE] 调试：如需绕过单实例锁，使用 --multi-instance 参数');
  console.error('[SINGLE-INSTANCE] 调用 app.quit()...');
  app.quit();
  console.error('[SINGLE-INSTANCE] app.quit() 已调用');
} else {
  console.log('[SINGLE-INSTANCE] 单实例锁获取成功，这是主实例');
  app.on('second-instance', () => {
    console.log('[SINGLE-INSTANCE] 收到第二个实例启动请求');
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
