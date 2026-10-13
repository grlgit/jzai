'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { confirmDialog } from '@/components/AppDialog';
import { useI18n } from '@/i18n';
import { useShortcuts } from '@/hooks/useShortcuts';
import DashboardPanel from '@/components/DashboardPanel';
import { useSidebar } from '@/hooks/useSidebar';
import { useMessageDisplay } from '@/hooks/useMessageDisplay';
import OemConsolePanel from '@/components/OemConsolePanel';
import DevMcpCard from '@/components/DevMcpCard';
import { useAuth } from '@/hooks/useAuth';
import UserManagePanel from '@/components/UserManagePanel';

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

const CLOUD_PROVIDERS = [
  { id: 'deepseek', name: 'DeepSeek' },
  { id: 'openai', name: 'OpenAI' },
  { id: 'anthropic', name: 'Anthropic' },
  { id: 'silicon-flow', name: 'SiliconFlow (硅基流动)' },
  { id: 'moonshot', name: 'Moonshot (月之暗面)' },
  { id: 'qwen', name: 'Qwen (通义千问)' },
];

interface DiscoveredModel {
  id: string; name: string; provider: string; type: string;
  size?: string; parameterSize?: string;
}

function getToken() { return localStorage.getItem('jz_token') || ''; }

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

export default function SettingsPanel() {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = useState<'model' | 'toolMgmt' | 'general' | 'credentials' | 'analytics' | 'oem' | 'users'>('model');
  // Note: 'credentials' tab is hidden from the tab bar but still rendered for backward compatibility
  const [toolsSubTab, setToolsSubTab] = useState<'builtin' | 'custom' | 'mcp' | 'email'>('builtin');
  const [generalSubTab, setGeneralSubTab] = useState<'msgDisplay' | 'license' | 'system' | 'shortcuts'>('msgDisplay');
  const [oemSubTab, setOemSubTab] = useState<'devMcp' | 'oem'>('devMcp');

  // Credentials
  const [credSystems, setCredSystems] = useState<Record<string, Record<string, string>>>({});
  const [credLoading, setCredLoading] = useState(false);

  const loadCredentials = useCallback(async () => {
    setCredLoading(true);
    try {
      const userId = JSON.parse(atob(getToken().split('.')[1])).sub;
      const res = await fetch(`${MAIN_URL}/api/skills/credentials/list?userId=${userId}`, { headers: authHeaders() });
      setCredSystems(await res.json());
    } catch {}
    setCredLoading(false);
  }, []);

  const saveCred = async (systemName: string, creds: Record<string, string>) => {
    const userId = JSON.parse(atob(getToken().split('.')[1])).sub;
    await fetch(`${MAIN_URL}/api/skills/credentials/save`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ userId, systemName, credentials: creds }),
    });
    loadCredentials();
  };

  const deleteCred = async (systemName: string) => {
    const userId = JSON.parse(atob(getToken().split('.')[1])).sub;
    await fetch(`${MAIN_URL}/api/skills/credentials/${systemName}?userId=${userId}`, {
      method: 'DELETE', headers: authHeaders(),
    });
    loadCredentials();
  };
  const { global: msgGlobal, saveGlobal: saveMsgGlobal } = useMessageDisplay();
  const [saving, setSaving] = useState(false);
  const token = getToken();
  const { user: authUser } = useAuth();
  const canManageUsers = (() => {
    if (!authUser) return false;
    const perms = typeof authUser.role === 'string' ? [] : (authUser.role?.permissions ?? []);
    return perms.includes('cfg:users') || perms.includes('sys:admin');
  })();
  const isSysAdmin = (() => {
    if (!authUser) return false;
    const perms = typeof authUser.role === 'string' ? [] : (authUser.role?.permissions ?? []);
    return perms.includes('sys:admin');
  })();
  const { shortcuts, save: saveShortcuts, reset: resetShortcuts } = useShortcuts(token);
  const { panels: sidebarPanels } = useSidebar(token);
  const [editItems, setEditItems] = useState<typeof shortcuts | null>(null);
  const [addingUrl, setAddingUrl] = useState(false);
  const [sysConfig, setSysConfig] = useState<Record<string, any> | null>(null);
  const [sysConfigDraft, setSysConfigDraft] = useState<string>('');
  const [sysMsg, setSysMsg] = useState('');
  const [newName, setNewName] = useState('');
  const [newIcon, setNewIcon] = useState('🔗');
  const [newTarget, setNewTarget] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  // 移动访问地址
  const [mobileUrl, setMobileUrl] = useState('');
  const [mobileUrlConfigured, setMobileUrlConfigured] = useState(false);
  const [mobileUrlDraft, setMobileUrlDraft] = useState<string | null>(null);
  const [mobileMsg, setMobileMsg] = useState('');

  useEffect(() => {
    if (!token) return;
    fetch(`${MAIN_URL}/api/mobile-access`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (data?.url) { setMobileUrl(data.url); setMobileUrlConfigured(!!data.configured); }
      })
      .catch(() => {});
  }, [token]);

  const saveMobileUrl = async () => {
    if (mobileUrlDraft === null) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/mobile-access`, {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: mobileUrlDraft.trim() }),
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.message || '保存失败');
      setMobileMsg('已保存');
      setMobileUrlDraft(null);
      const r2 = await fetch(`${MAIN_URL}/api/mobile-access`, { headers: { 'Authorization': `Bearer ${token}` } });
      const d2 = await r2.json();
      if (d2?.url) { setMobileUrl(d2.url); setMobileUrlConfigured(!!d2.configured); }
    } catch (e: any) {
      setMobileMsg(e.message);
    }
    setTimeout(() => setMobileMsg(''), 4000);
  };

  // License / Edition
  const [licenseInfo, setLicenseInfo] = useState<any>(null);
  const [creditsInfo, setCreditsInfo] = useState<any>(null);
  const [renewMonths, setRenewMonths] = useState(12);
  const [renewing, setRenewing] = useState(false);
  const [renewMsg, setRenewMsg] = useState('');
  const [syncing, setSyncing] = useState(false);

  // Local
  const [localEndpoint, setLocalEndpoint] = useState('http://localhost:11434');
  const [localModel, setLocalModel] = useState('');
  const [localModels, setLocalModels] = useState<DiscoveredModel[]>([]);
  const [localStatus, setLocalStatus] = useState<'online' | 'offline' | 'loading' | 'idle'>('idle');

  // Cloud
  const [cloudSource, setCloudSource] = useState<'self' | 'official'>('self');
  const [cloudProvider, setCloudProvider] = useState('deepseek');
  const [cloudApiKey, setCloudApiKey] = useState('');
  const [cloudModel, setCloudModel] = useState('');
  const [visionModel, setVisionModel] = useState('');
  const [cloudModels, setCloudModels] = useState<DiscoveredModel[]>([]);
  const [cloudStatus, setCloudStatus] = useState<'online' | 'offline' | 'loading' | 'idle'>('idle');

  // Built-in tools
  const [builtinTools, setBuiltinTools] = useState<any[]>([]);
  const [builtinLoading, setBuiltinLoading] = useState(false);

  const loadBuiltinTools = useCallback(async () => {
    setBuiltinLoading(true);
    try {
      const res = await fetch(`${MAIN_URL}/api/agents/tool-catalog`, { headers: authHeaders() });
      setBuiltinTools(await res.json());
    } catch { /* ignore */ }
    setBuiltinLoading(false);
  }, []);

  // Tool / MCP registries (separate APIs)
  const [customTools, setCustomTools] = useState<any[]>([]);
  const [mcpServers, setMcpServers] = useState<any[]>([]);
  const [connectorsLoading, setConnectorsLoading] = useState(false);
  const [selectedConnector, setSelectedConnector] = useState<any>(null);
  const [permDraft, setPermDraft] = useState<{ allowedRoles: string[]; allowedUsers: string[] }>({ allowedRoles: [], allowedUsers: [] });

  const loadConnectors = useCallback(async () => {
    setConnectorsLoading(true);
    try {
      const [toolsRes, mcpRes] = await Promise.all([
        fetch(`${MAIN_URL}/api/tools`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/mcp`, { headers: authHeaders() }),
      ]);
      setCustomTools(await toolsRes.json());
      setMcpServers(await mcpRes.json());
    } catch { /* ignore */ }
    setConnectorsLoading(false);
  }, []);

  const toggleTool = async (name: string, enabled: boolean) => {
    await fetch(`${MAIN_URL}/api/tools/${name}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ enabled }),
    });
    setCustomTools(prev => prev.map(c => c.name === name ? { ...c, enabled } : c));
  };

  const toggleMcp = async (name: string, enabled: boolean) => {
    await fetch(`${MAIN_URL}/api/mcp/${name}`, {
      method: 'PATCH', headers: authHeaders(),
      body: JSON.stringify({ enabled }),
    });
    setMcpServers(prev => prev.map(c => c.name === name ? { ...c, enabled } : c));
  };

  const savePermissions = async (type: string, name: string) => {
    const endpoint = type === 'tool' ? 'tools' : 'mcp';
    await fetch(`${MAIN_URL}/api/${endpoint}/${name}/permissions`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify(permDraft),
    });
    const update = (c: any) => c.name === name ? { ...c, permissions: { ...permDraft } } : c;
    if (type === 'tool') setCustomTools(prev => prev.map(update));
    else setMcpServers(prev => prev.map(update));
    setSelectedConnector(null);
  };

  const reloadMcp = async () => {
    await fetch(`${MAIN_URL}/api/mcp/reload`, { method: 'POST', headers: authHeaders() });
    await loadConnectors();
  };

  // MCP manifest viewer & register
  const [viewingManifest, setViewingManifest] = useState<{ name: string; yaml: string } | null>(null);
  const [showRegister, setShowRegister] = useState(false);
  const [registerYaml, setRegisterYaml] = useState('');
  const [registerMsg, setRegisterMsg] = useState('');
  const [registerDragOver, setRegisterDragOver] = useState(false);

  const viewManifest = async (name: string) => {
    try {
      const res = await fetch(`${MAIN_URL}/api/mcp/${name}/manifest`, { headers: authHeaders() });
      const data = await res.json();
      if (data.manifest) setViewingManifest({ name, yaml: data.manifest });
    } catch { /* ignore */ }
  };

  const registerMcp = async () => {
    setRegisterMsg('');
    try {
      const res = await fetch(`${MAIN_URL}/api/mcp/register`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ manifest: registerYaml }),
      });
      const data = await res.json();
      if (data.success) {
        setRegisterMsg(`${t('common.saved')}: ${data.name}`);
        setRegisterYaml('');
        setShowRegister(false);
        await loadConnectors();
      } else {
        setRegisterMsg(data.error || t('common.saveFailed'));
      }
    } catch { setRegisterMsg(t('common.saveFailed')); }
    setTimeout(() => setRegisterMsg(''), 4000);
  };

  // Budget
  const [budgetLimit, setBudgetLimit] = useState(500);
  const [budgetSpent, setBudgetSpent] = useState(0);
  const [overLimitAction, setOverLimitAction] = useState('local_only');

  // Load config + edition info from backend on mount
  useEffect(() => {
    fetch(`${MAIN_URL}/api/models/config`, { headers: authHeaders() })
      .then(r => r.json())
      .then(cfg => {
        if (cfg.localEndpoint) setLocalEndpoint(cfg.localEndpoint);
        if (cfg.localModel) setLocalModel(cfg.localModel);
        if (cfg.cloudProvider) setCloudProvider(cfg.cloudProvider);
        if (cfg.cloudModel) setCloudModel(cfg.cloudModel);
        if (cfg.visionModel !== undefined) setVisionModel(cfg.visionModel);
        if (cfg.cloudSource) setCloudSource(cfg.cloudSource === 'claude-local' ? 'official' : cfg.cloudSource);
        if (cfg.budgetLimit) setBudgetLimit(cfg.budgetLimit);
        if (cfg.budgetSpent !== undefined) setBudgetSpent(cfg.budgetSpent);
        if (cfg.overLimitAction) setOverLimitAction(cfg.overLimitAction);
        // Show masked key as placeholder, don't overwrite with mask
        if (cfg.hasCloudKey) {
          setCloudApiKey(''); // Keep empty - user sees placeholder
          setCloudStatus('online');
        }
      })
      .catch(() => {});
    // Load edition + update info early (needed for feature gates + version display)
    Promise.all([
      fetch(`${MAIN_URL}/api/edition`, { headers: authHeaders() }).then(r => r.json()),
      fetch(`${MAIN_URL}/api/update/current`, { headers: authHeaders() }).then(r => r.json()).catch(() => null),
    ]).then(([edition, updateInfo]) => {
      setLicenseInfo({
        ...edition,
        currentVersion: updateInfo?.version?.version || edition?.currentVersion || 'unknown',
        _updateInfo: updateInfo?.update || { available: false },
      });
    }).catch(() => {});
  }, []);

  // Discover local models
  const discoverLocal = useCallback(async () => {
    setLocalStatus('loading');
    try {
      const res = await fetch(`${MAIN_URL}/api/models/discover?provider=ollama&endpoint=${encodeURIComponent(localEndpoint)}`, { headers: authHeaders() });
      const models: DiscoveredModel[] = await res.json();
      setLocalModels(models);
      setLocalStatus(models.length > 0 ? 'online' : 'offline');
      if (models.length > 0 && !localModel) setLocalModel(models[0].id);
    } catch {
      setLocalStatus('offline');
      setLocalModels([]);
    }
  }, [localEndpoint, localModel]);

  // Discover cloud models
  const discoverCloud = useCallback(async () => {
    if (!cloudApiKey) { setCloudStatus('offline'); return; }
    setCloudStatus('loading');
    try {
      const res = await fetch(`${MAIN_URL}/api/models/discover?provider=${cloudProvider}&apiKey=${encodeURIComponent(cloudApiKey)}`, { headers: authHeaders() });
      const models: DiscoveredModel[] = await res.json();
      setCloudModels(models);
      setCloudStatus(models.length > 0 ? 'online' : 'offline');
      if (models.length > 0 && !cloudModel) setCloudModel(models[0].id);
    } catch {
      setCloudStatus('offline');
      setCloudModels([]);
    }
  }, [cloudProvider, cloudApiKey, cloudModel]);

  const handleProviderChange = (p: string) => {
    setCloudProvider(p);
    setCloudModels([]);
    setCloudModel('');
    setCloudStatus('idle');
  };

  // Save config to backend
  const saveConfig = async () => {
    setSaving(true);
    setSaveMsg('');
    try {
      const payload: any = {
        localEndpoint,
        localModel,
        cloudProvider,
        cloudModel,
        visionModel,
        cloudSource,
        budgetLimit,
        overLimitAction,
      };
      // Only send API key if user entered a new one (not empty placeholder)
      if (cloudApiKey) {
        payload.cloudApiKey = cloudApiKey;
      }
      const res = await fetch(`${MAIN_URL}/api/models/config`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      if (data.success) {
        setSaveMsg('✅ ' + t('settings.configSaved'));
      } else {
        setSaveMsg('❌ ' + t('common.saveFailed'));
      }
    } catch {
      setSaveMsg('❌ ' + t('common.saveFailed'));
    }
    setSaving(false);
    setTimeout(() => setSaveMsg(''), 4000);
  };

  const budgetPercent = budgetLimit > 0 ? Math.round((budgetSpent / budgetLimit) * 100) : 0;

  const statusDot = (s: string) => {
    if (s === 'online') return <span className="text-green-500 text-xs">{t('settings.connected')}</span>;
    if (s === 'offline') return <span className="text-red-500 text-xs">● 未连接</span>;
    if (s === 'loading') return <span className="text-amber-500 text-xs animate-pulse">● 检测中...</span>;
    return <span className="text-gray-400 text-xs">{t('settings.notDetected')}</span>;
  };

  return (
    <div className="p-6 overflow-y-auto h-full">
      <div className="flex gap-2 mb-6">
        {([['model', t('settings.models')], ['toolMgmt', '工具管理'], ['credentials', '系统凭证'], ['analytics', '运营分析'], ['oem', '三方扩展'], ['users', '用户与组织'], ['general', '系统通用']] as const).filter(([tab]) => tab !== 'credentials' && (tab !== 'users' || canManageUsers)).map(([tab, label]) => (
          <button key={tab} onClick={() => {
            setActiveTab(tab);
            if (tab === 'toolMgmt') {
              if (builtinTools.length === 0) loadBuiltinTools();
              if (mcpServers.length === 0) loadConnectors();
            }
            if (tab === 'general') {
              if (!licenseInfo) {
                Promise.all([
                  fetch(`${MAIN_URL}/api/edition`, { headers: authHeaders() }).then(r => r.json()),
                  fetch(`${MAIN_URL}/api/edition/credits`, { headers: authHeaders() }).then(r => r.json()),
                ]).then(([edition, credits]) => {
                  setLicenseInfo(edition);
                  setCreditsInfo(credits);
                }).catch(() => {});
              }
              if (!sysConfig) {
                fetch(`${MAIN_URL}/api/system-config`, { headers: { 'Authorization': `Bearer ${token}` } })
                  .then(r => r.json())
                  .then(data => { setSysConfig(data); setSysConfigDraft(JSON.stringify(data, null, 2)); })
                  .catch(() => setSysMsg(t('common.saveFailed')));
              }
            }
            if (tab === 'credentials') loadCredentials();
          }}
            className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-all ${activeTab === tab ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'model' && (
        <div className="space-y-4">
          {/* Local Model */}
          <div className="border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-3">{t('settings.localModel')}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('settings.ollamaUrl')}</label>
                <div className="flex gap-2">
                  <input type="text" value={localEndpoint} onChange={e => setLocalEndpoint(e.target.value)}
                    className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" />
                  <button onClick={discoverLocal} disabled={localStatus === 'loading'}
                    className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 whitespace-nowrap disabled:opacity-50">
                    {t('settings.detectConnection')}
                  </button>
                </div>
              </div>
              {localModels.length > 0 && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('settings.availableModels', { n: localModels.length })}</label>
                  <select value={localModel} onChange={e => setLocalModel(e.target.value)}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                    {localModels.map(m => (
                      <option key={m.id} value={m.id}>{m.id}{m.size ? ` (${m.size})` : ''}</option>
                    ))}
                  </select>
                </div>
              )}
              {localModels.length === 0 && localModel && (
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('settings.modelManual')}</label>
                  <input type="text" value={localModel} onChange={e => setLocalModel(e.target.value)}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="qwen3:4b" />
                </div>
              )}
              <div className="flex items-center gap-2">
                {statusDot(localStatus)}
                {localModel && <span className="text-xs text-gray-400">{t('settings.current', { model: localModel })}</span>}
              </div>
            </div>
          </div>

          {/* Cloud Model */}
          <div className="border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-3">{t('settings.cloudModel')}</h3>
            <div className="space-y-3">
              {/* Cloud Source Selector — official proxy or self-purchased key (all editions) */}
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('settings.cloudSource')}</label>
                <div className="flex gap-2">
                  <button onClick={() => setCloudSource('official')}
                    className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${cloudSource === 'official' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    ☁️ {t('settings.cloudSourceOfficial')}
                    <span className="block text-[10px] text-gray-400 mt-0.5 font-normal">{t('settings.cloudSourceOfficialDesc')}</span>
                  </button>
                  <button onClick={() => setCloudSource('self')}
                    className={`flex-1 px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${cloudSource === 'self' ? 'border-indigo-500 bg-indigo-50 text-indigo-700' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                    🔑 {t('settings.cloudSourceSelf')}
                    <span className="block text-[10px] text-gray-400 mt-0.5 font-normal">{t('settings.cloudSourceSelfDesc')}</span>
                  </button>
                </div>
              </div>

              {cloudSource === 'official' ? (
                <div className="bg-indigo-50 rounded-lg px-4 py-3 text-xs text-indigo-700 border border-indigo-100">
                  <div className="font-medium mb-1">{t('settings.officialEnabled')}</div>
                  <div className="text-indigo-500">{t('settings.officialEnabledDesc')}</div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t('settings.provider')}</label>
                    <select value={cloudProvider} onChange={e => handleProviderChange(e.target.value)}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                      {CLOUD_PROVIDERS.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">{t('settings.apiKey')}</label>
                    <div className="flex gap-2">
                      <input type="password" value={cloudApiKey} onChange={e => setCloudApiKey(e.target.value)}
                        className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500"
                        placeholder={cloudStatus === 'online' ? t('settings.apiKeyHint') : 'sk-...'} />
                      <button onClick={discoverCloud} disabled={!cloudApiKey || cloudStatus === 'loading'}
                        className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 whitespace-nowrap disabled:opacity-50">
                        {t('settings.detectConnection')}
                      </button>
                    </div>
                  </div>
                  {cloudModels.length > 0 && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('settings.availableModels', { n: cloudModels.length })}</label>
                      <select value={cloudModel} onChange={e => setCloudModel(e.target.value)}
                        className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                        {cloudModels.map(m => <option key={m.id} value={m.id}>{m.id}</option>)}
                      </select>
                    </div>
                  )}
                  {cloudModels.length === 0 && cloudModel && (
                    <div>
                      <label className="block text-xs text-gray-500 mb-1">{t('settings.modelManual')}</label>
                      <input type="text" value={cloudModel} onChange={e => setCloudModel(e.target.value)}
                        className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" />
                    </div>
                  )}
                  <div>
                    <label className="block text-xs text-gray-500 mb-1">
                      视觉模型
                      <span className="ml-1 text-gray-400 font-normal">（用于图纸识别，为空时使用对话模型）</span>
                    </label>
                    <input
                      type="text"
                      value={visionModel}
                      onChange={e => setVisionModel(e.target.value)}
                      className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500"
                      placeholder="deepseek-v4-flash-vision-exp"
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    {statusDot(cloudStatus)}
                    {cloudModel && <span className="text-xs text-gray-400">{t('settings.current', { model: cloudModel })}</span>}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Budget */}
          <div className="border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-3">{t('settings.budget')}</h3>
            <div className="space-y-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('settings.budgetLimit')}</label>
                <input type="number" value={budgetLimit} onChange={e => setBudgetLimit(Number(e.target.value))}
                  className="w-40 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" />
              </div>
              <div>
                <div className="text-xs text-gray-400 mb-1">{t('settings.budgetCurrent', { spent: budgetSpent.toFixed(2), percent: budgetPercent })}</div>
                <div className="h-1.5 bg-gray-100 rounded-full w-64">
                  <div className="h-full bg-indigo-600 rounded-full transition-all" style={{ width: `${Math.min(budgetPercent, 100)}%` }} />
                </div>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">{t('settings.overLimitAction')}</label>
                <select value={overLimitAction} onChange={e => setOverLimitAction(e.target.value)}
                  className="w-48 px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                  <option value="local_only">{t('settings.localOnly')}</option>
                  <option value="warn">{t('settings.warnAllow')}</option>
                  <option value="block">{t('settings.stopService')}</option>
                </select>
              </div>
            </div>
          </div>

          {/* Save button */}
          <div className="flex items-center gap-3">
            <button onClick={saveConfig} disabled={saving}
              className="px-6 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {saving ? t('common.saving') : t('settings.saveConfig')}
            </button>
            {saveMsg && <span className="text-sm">{saveMsg}</span>}
          </div>
        </div>
      )}

      {activeTab === 'toolMgmt' && (
        <div className="space-y-4">
          {/* Sub-tabs: 内置工具 / 自定义工具 / MCP 服务 */}
          {(() => {
            const builtinCount = builtinTools.reduce((n: number, cat: any) => n + cat.tools.filter((t: any) => t.builtin !== false).length, 0);
            return (
            <div className="flex border-b border-gray-200">
              {([
                ['builtin', '内置工具', builtinCount],
                ['custom', '自定义工具', customTools.length],
                ['mcp', 'MCP 服务', mcpServers.length],
                ['email', '邮件', 0],
              ] as const).map(([key, label, count]) => (
                <button key={key} onClick={() => setToolsSubTab(key)}
                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${toolsSubTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                  {label} {count > 0 && <span className="ml-1 text-[10px] bg-gray-100 text-gray-500 px-1.5 rounded-full">{count}</span>}
                </button>
              ))}
            </div>
            );
          })()}

          {toolsSubTab === 'builtin' && (
            <div className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">{t('settings.builtinTools')}</h3>
                <button onClick={loadBuiltinTools} disabled={builtinLoading}
                  className="px-3 py-1 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  {builtinLoading ? t('common.loading') : t('common.refresh')}
                </button>
              </div>
              <p className="text-xs text-gray-400 mb-4">{t('settings.builtinToolsDesc')}</p>

              {builtinTools.map((cat: any) => {
                const onlyBuiltin = cat.tools.filter((t: any) => t.builtin !== false);
                if (onlyBuiltin.length === 0) return null;
                return (
                <div key={cat.category} className="mb-4">
                  <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5 px-1">{cat.category}</div>
                  <div className="space-y-1">
                    {onlyBuiltin.map((tool: any) => (
                      <div key={tool.name} className="flex items-center gap-3 px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/50">
                        <code className="text-xs font-mono text-indigo-600 bg-indigo-50 px-1.5 py-0.5 rounded shrink-0">{tool.name}</code>
                        <span className="text-sm text-gray-600 flex-1 truncate">{tool.description}</span>
                        <span className="text-green-500 text-xs shrink-0">{t('common.enabled')}</span>
                      </div>
                    ))}
                  </div>
                </div>
                );
              })}

              {builtinTools.length === 0 && !builtinLoading && (
                <div className="text-sm text-gray-400 text-center py-8">{t('common.loading')}</div>
              )}
            </div>
          )}

          {toolsSubTab === 'custom' && (
            <div className="border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-3">{t('settings.customTools')}</h3>
              {customTools.length > 0 ? (
                <div className="space-y-2">
                  {customTools.map(c => (
                    <div key={c.name} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${c.enabled !== false ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                      <code className="text-xs font-mono text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded shrink-0">{c.name}</code>
                      {c.sourceApp && (
                        <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-indigo-50 text-indigo-600 shrink-0" title={`来自应用 ${c.sourceApp.appId}`}>
                          {c.sourceApp.name}
                        </span>
                      )}
                      <span className="text-sm text-gray-600 flex-1 truncate">{c.description}</span>
                      <span className="text-xs text-gray-400">{t('common.params', { n: c.paramCount })}</span>
                      {!c.sourceApp && (
                        <>
                          <button onClick={() => {
                            window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                              detail: { actionType: 'switch_agent', actionData: { target: 'connector_master' } },
                            }));
                            setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                              detail: { content: `请帮我编辑 Tool "${c.name}"。\n描述: ${c.description || '无'}` },
                            })), 600);
                          }} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="编辑">✏️</button>
                          <button onClick={() => toggleTool(c.name, !c.enabled)}
                            className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${c.enabled !== false ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                            <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${c.enabled !== false ? 'left-[18px]' : 'left-0.5'}`} />
                          </button>
                        </>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-sm text-gray-400 text-center py-8">暂无自定义工具，可通过「连接大师」创建</div>
              )}
            </div>
          )}

          {toolsSubTab === 'mcp' && (
          <div className="space-y-4">
          <div className="border border-gray-200 rounded-lg p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">{t('settings.mcpTitle')}</h3>
              <div className="flex gap-2">
                <button onClick={() => setShowRegister(true)}
                  className="px-3 py-1 text-xs border border-emerald-200 text-emerald-600 rounded-lg hover:bg-emerald-50">
                  {t('settings.mcpRegister')}
                </button>
                <button onClick={reloadMcp} disabled={connectorsLoading}
                  className="px-3 py-1 text-xs border border-indigo-200 text-indigo-600 rounded-lg hover:bg-indigo-50 disabled:opacity-50">
                  {t('settings.mcpHotReload')}
                </button>
                <button onClick={loadConnectors} disabled={connectorsLoading}
                  className="px-3 py-1 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  {t('common.refresh')}
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-400 mb-4">
              {t('settings.mcpDesc')} <a href="https://modelcontextprotocol.io/docs/develop" target="_blank" className="text-indigo-500 hover:underline">{t('settings.mcpStandard')}</a>
              {t('settings.mcpDescSuffix')}
            </p>

            {/* Built-in KB MCP */}
            <div className="mb-4">
              <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5 px-1">{t('settings.mcpBuiltin')}</div>
              <div className="flex items-center gap-3 px-3 py-2.5 rounded-lg border border-emerald-100 bg-emerald-50/30">
                <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-100 text-emerald-700">MCP</span>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium">{t('settings.mcpKb')}</div>
                  <div className="text-xs text-gray-400">{t('settings.mcpKbDesc')}</div>
                </div>
                <span className="text-green-500 text-xs">{t('settings.connected')}</span>
              </div>
            </div>

            {/* Registered MCP servers */}
            <div className="text-xs font-medium text-gray-500 uppercase tracking-wider mb-1.5 px-1">{t('settings.mcpRegistered')}</div>
            {mcpServers.length === 0 ? (
              <div className="text-sm text-gray-400 text-center py-6 border border-dashed border-gray-200 rounded-lg">
                {t('settings.mcpEmpty')}
              </div>
            ) : (
              <div className="space-y-2">
                {mcpServers.map(c => (
                  <div key={c.name} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${c.enabled !== false ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                    <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-50 text-emerald-600">MCP</span>
                    <SettingsMcpPhase phase={c.status?.phase} />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{c.name}</div>
                      <div className="text-xs text-gray-400 truncate">{c.description} ({t('settings.mcpTools', { n: c.toolCount || 0, names: c.tools?.join(', ') })})</div>
                    </div>
                    <button onClick={() => {
                      window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                        detail: { actionType: 'switch_agent', actionData: { target: 'connector_master' } },
                      }));
                      setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                        detail: { content: `请帮我编辑 MCP Server "${c.name}"。\n描述: ${c.description || '无'}\n工具: ${c.tools?.join(', ') || '无'}` },
                      })), 600);
                    }} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="编辑">✏️</button>
                    <button onClick={() => viewManifest(c.name)}
                      className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="查看配置">📄</button>
                    <button onClick={() => { setSelectedConnector({ ...c, type: 'mcp' }); setPermDraft(c.permissions || { allowedRoles: [], allowedUsers: [] }); }}
                      className="text-xs text-gray-400 hover:text-indigo-600 shrink-0" title="权限设置">🔐</button>
                    <button onClick={async () => {
                      if (!(await confirmDialog(`确认删除 MCP "${c.name}"？文件将移入回收站。`, { danger: true }))) return;
                      await fetch(`${MAIN_URL}/api/mcp/${c.name}`, { method: 'DELETE', headers: authHeaders() });
                      loadConnectors();
                    }} className="text-xs text-gray-400 hover:text-red-500 shrink-0" title="删除">🗑️</button>
                    <button onClick={() => toggleMcp(c.name, !c.enabled)}
                      className={`relative w-9 h-5 rounded-full transition-colors shrink-0 ${c.enabled !== false ? 'bg-indigo-600' : 'bg-gray-300'}`}>
                      <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${c.enabled !== false ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </div>
                ))}
              </div>
            )}

            {/* Recycle Bin */}
            <McpRecycleBin onRestore={loadConnectors} />
          </div>

          {/* Permission editor */}
          {selectedConnector && (
            <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30">
              <h4 className="text-sm font-semibold mb-3">{t('settings.permTitle', { name: selectedConnector.name })}</h4>
              <div className="space-y-3">
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('settings.permRoles')}</label>
                  <div className="flex gap-2">
                    {['admin', 'member'].map(role => (
                      <label key={role} className="flex items-center gap-1.5 text-sm cursor-pointer">
                        <input type="checkbox" checked={permDraft.allowedRoles?.includes(role) || false}
                          onChange={e => {
                            const roles = permDraft.allowedRoles || [];
                            setPermDraft({ ...permDraft, allowedRoles: e.target.checked ? [...roles, role] : roles.filter(r => r !== role) });
                          }}
                          className="rounded border-gray-300" />
                        {role === 'admin' ? t('settings.permAdmin') : t('settings.permUser')}
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs text-gray-500 mb-1">{t('settings.permUsers')}</label>
                  <input type="text" value={(permDraft.allowedUsers || []).join(', ')}
                    onChange={e => setPermDraft({ ...permDraft, allowedUsers: e.target.value.split(',').map(s => s.trim()).filter(Boolean) })}
                    className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500"
                    placeholder="user_id_1, user_id_2" />
                </div>
                <div className="flex gap-2">
                  <button onClick={() => savePermissions(selectedConnector.type, selectedConnector.name)}
                    className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700">{t('settings.permSave')}</button>
                  <button onClick={() => setSelectedConnector(null)}
                    className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-700">{t('common.cancel')}</button>
                </div>
              </div>
            </div>
          )}

          {/* Manifest viewer */}
          {viewingManifest && (
            <div className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <h4 className="text-sm font-semibold">{t('settings.manifestTitle', { name: viewingManifest.name })}</h4>
                <button onClick={() => setViewingManifest(null)} className="text-xs text-gray-400 hover:text-gray-600">{t('common.close')}</button>
              </div>
              <pre className="bg-gray-50 border border-gray-100 rounded-lg p-3 text-xs font-mono whitespace-pre-wrap overflow-auto max-h-64">{viewingManifest.yaml}</pre>
            </div>
          )}

          {/* Register MCP */}
          {showRegister && (
            <div
              className={`border-2 rounded-lg p-4 transition-colors ${registerDragOver ? 'border-emerald-400 bg-emerald-50/40' : 'border-emerald-200 bg-emerald-50/20'}`}
              onDragOver={e => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setRegisterDragOver(true); }}
              onDragLeave={() => setRegisterDragOver(false)}
              onDrop={e => {
                e.preventDefault();
                setRegisterDragOver(false);
                const file = e.dataTransfer.files[0];
                if (file) {
                  const reader = new FileReader();
                  reader.onload = () => { if (typeof reader.result === 'string') setRegisterYaml(reader.result); };
                  reader.readAsText(file);
                }
              }}
            >
              <h4 className="text-sm font-semibold mb-2">{t('settings.registerMcp')}</h4>
              <p className="text-xs text-gray-400 mb-3">
                {t('settings.registerMcpDesc')} <a href="https://modelcontextprotocol.io/docs/develop" target="_blank" className="text-indigo-500 hover:underline">{t('settings.mcpStandard')}</a>。
              </p>
              {!registerYaml && (
                <div className="flex flex-col items-center justify-center py-6 mb-3 border-2 border-dashed border-gray-200 rounded-lg text-gray-400 pointer-events-none">
                  <svg className="size-8 mb-2 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m6.75 12l-3-3m0 0l-3 3m3-3v6m-1.5-15H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z" /></svg>
                  <span className="text-xs">{t('settings.registerMcpDrop')}</span>
                </div>
              )}
              <textarea
                value={registerYaml}
                onChange={e => setRegisterYaml(e.target.value)}
                rows={registerYaml ? 10 : 4}
                className="w-full font-mono text-xs border border-gray-200 rounded-lg p-3 outline-none focus:border-emerald-500 resize-y mb-3"
                placeholder={`mcp:\n  name: my-mcp-server\n  system: 示例系统\n  description: 示例 MCP Server\n  tools:\n    - name: example_tool\n      description: 示例工具\n      inputSchema:\n        type: object\n        properties:\n          query:\n            type: string`}
              />
              <div className="flex items-center gap-3">
                <button onClick={registerMcp} disabled={!registerYaml.trim()}
                  className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50">{t('settings.registerSubmit')}</button>
                <button onClick={() => { setShowRegister(false); setRegisterYaml(''); }}
                  className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-700">{t('common.cancel')}</button>
                {registerMsg && <span className="text-sm">{registerMsg}</span>}
              </div>
            </div>
          )}
        </div>
          )}

          {toolsSubTab === 'email' && <EmailSettingsTab />}

        </div>
      )}

      {activeTab === 'general' && (
        <div>
          {/* Sub-tabs: 消息显示 / 版本授权 / 系统配置 */}
          <div className="flex border-b border-gray-200 mb-4">
            <button onClick={() => setGeneralSubTab('msgDisplay')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${generalSubTab === 'msgDisplay' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
              消息显示
            </button>
            <button onClick={() => setGeneralSubTab('license')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${generalSubTab === 'license' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
              版本授权
            </button>
            <button onClick={() => setGeneralSubTab('system')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${generalSubTab === 'system' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
              系统配置
            </button>
            <button onClick={() => setGeneralSubTab('shortcuts')}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${generalSubTab === 'shortcuts' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
              {t('settings.shortcuts')}
            </button>
          </div>

      {generalSubTab === 'shortcuts' && (() => {
        const items = editItems || shortcuts;
        const availablePanels = sidebarPanels.filter(p => !p.isBuiltin && !items.some(s => s.id === p.id));

        const removeItem = (id: string) => setEditItems(items.filter(s => s.id !== id));
        const moveItem = (idx: number, dir: -1 | 1) => {
          const t = idx + dir;
          if (t < 0 || t >= items.length) return;
          const next = [...items];
          [next[idx], next[t]] = [next[t], next[idx]];
          setEditItems(next.map((s, i) => ({ ...s, sortOrder: i })));
        };
        const addPanel = (panelId: string) => {
          const p = sidebarPanels.find(p => p.id === panelId);
          if (!p) return;
          setEditItems([...items, { id: panelId, name: p.name, icon: p.icon, type: 'panel' as const, target: panelId, sortOrder: items.length }]);
        };
        const addUrl = () => {
          if (!newName || !newTarget) return;
          setEditItems([...items, { id: `url_${Date.now()}`, name: newName, icon: newIcon, type: 'url' as const, target: newTarget, sortOrder: items.length }]);
          setNewName(''); setNewIcon('🔗'); setNewTarget(''); setAddingUrl(false);
        };
        const handleSave = async () => {
          if (editItems) { await saveShortcuts(editItems); setEditItems(null); }
        };

        return (
          <div className="space-y-4">
            <div className="border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-3">{t('settings.shortcuts')}</h3>
              <p className="text-xs text-gray-400 mb-4">{t('settings.shortcutsDesc')}</p>

              <div className="space-y-1 mb-4">
                {items.map((s, idx) => (
                  <div key={s.id} className="flex items-center gap-2 px-3 py-2 rounded-lg border border-gray-100 bg-gray-50/50">
                    <span className="text-lg">{s.icon}</span>
                    <span className="text-sm flex-1">{s.name}</span>
                    <span className="text-xs text-gray-400 font-mono truncate max-w-[200px]">{s.type === 'panel' ? t('shortcut.panel', { target: s.target }) : s.target}</span>
                    <span className={`text-[9px] px-1.5 py-0.5 rounded ${s.type === 'panel' ? 'bg-indigo-50 text-indigo-500' : 'bg-green-50 text-green-600'}`}>
                      {s.type === 'panel' ? t('shortcut.internal') : t('shortcut.external')}
                    </span>
                    <button onClick={() => moveItem(idx, -1)} disabled={idx === 0} className="text-xs text-gray-400 disabled:opacity-20">▲</button>
                    <button onClick={() => moveItem(idx, 1)} disabled={idx === items.length - 1} className="text-xs text-gray-400 disabled:opacity-20">▼</button>
                    <button onClick={() => removeItem(s.id)} className="text-xs text-red-400 hover:text-red-600">{t('common.delete')}</button>
                  </div>
                ))}
                {items.length === 0 && <div className="text-sm text-gray-400 text-center py-4">{t('shortcut.empty')}</div>}
              </div>

              {/* Add panel */}
              {availablePanels.length > 0 && (
                <div className="mb-3">
                  <div className="text-xs text-gray-500 mb-1">{t('shortcut.selectPanel')}</div>
                  <div className="flex flex-wrap gap-1">
                    {availablePanels.map(p => (
                      <button key={p.id} onClick={() => addPanel(p.id)}
                        className="flex items-center gap-1 px-2 py-1 text-xs border border-gray-200 rounded hover:bg-indigo-50 hover:border-indigo-300">
                        <span>{p.icon}</span> {p.name}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Add URL */}
              {!addingUrl ? (
                <button onClick={() => setAddingUrl(true)} className="px-3 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50">{t('shortcut.addLink')}</button>
              ) : (
                <div className="border border-gray-200 rounded-lg p-3 space-y-2">
                  <div className="flex gap-2">
                    <input value={newIcon} onChange={e => setNewIcon(e.target.value)} className="w-10 text-center border border-gray-200 rounded px-1 py-1 text-sm" />
                    <input value={newName} onChange={e => setNewName(e.target.value)} className="flex-1 border border-gray-200 rounded px-2 py-1 text-sm" placeholder={t('common.name')} />
                  </div>
                  <input value={newTarget} onChange={e => setNewTarget(e.target.value)} className="w-full border border-gray-200 rounded px-2 py-1 text-sm" placeholder={t('shortcut.urlPlaceholder')} />
                  <div className="flex gap-2">
                    <button onClick={() => setAddingUrl(false)} className="text-xs text-gray-400">{t('common.cancel')}</button>
                    <button onClick={addUrl} disabled={!newName || !newTarget} className="text-xs px-3 py-1 bg-indigo-600 text-white rounded disabled:opacity-50">{t('shortcut.add')}</button>
                  </div>
                </div>
              )}
            </div>

            {/* Save / Reset */}
            <div className="flex items-center gap-3">
              <button onClick={handleSave} disabled={!editItems}
                className="px-6 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">{t('common.save')}</button>
              <button onClick={async () => { await resetShortcuts(); setEditItems(null); }}
                className="text-xs text-gray-400 hover:text-gray-600">{t('common.reset')}</button>
            </div>

            {/* 移动访问地址 */}
            <div className="border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-1">移动访问地址</h3>
              <p className="text-xs text-gray-400 mb-3">手机扫码或浏览器通过该地址访问时，始终进入手机模式。留空则默认取当前服务器 IP + 部署路径。</p>
              <div className="flex items-center gap-2">
                <input
                  value={mobileUrlDraft ?? (mobileUrlConfigured ? mobileUrl : '')}
                  onChange={e => setMobileUrlDraft(e.target.value)}
                  disabled={!isSysAdmin}
                  placeholder={mobileUrlConfigured ? 'https://…' : (mobileUrl ? `默认：${mobileUrl}` : '自动探测中…')}
                  className="flex-1 border border-gray-200 rounded px-2 py-1.5 text-sm font-mono disabled:bg-gray-50 disabled:text-gray-500"
                />
                {isSysAdmin && (
                  <button onClick={saveMobileUrl} disabled={mobileUrlDraft === null}
                    className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">{t('common.save')}</button>
                )}
              </div>
              <div className="flex items-center gap-2 mt-2">
                {!mobileUrlConfigured && mobileUrl && (
                  <span className="text-[11px] text-gray-400">当前未配置，生效默认值：<span className="font-mono">{mobileUrl}</span></span>
                )}
                {mobileMsg && <span className="text-[11px] text-indigo-600">{mobileMsg}</span>}
              </div>
            </div>
          </div>
        );
      })()}

      {generalSubTab === 'msgDisplay' && (
        <div className="p-6">
          <h3 className="text-base font-semibold mb-1">{t('msgDisplay.title')}</h3>
          <p className="text-xs text-gray-400 mb-4">{t('msgDisplay.desc')}</p>
          <div className="space-y-3">
            {(['toolProcess', 'toolResult', 'sourceRef', 'modelUsage'] as const).map(key => (
              <label key={key} className="flex items-start gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer">
                <input type="checkbox" checked={msgGlobal[key]} onChange={() => saveMsgGlobal({ [key]: !msgGlobal[key] })}
                  className="mt-0.5 rounded border-gray-300 text-indigo-600" />
                <div>
                  <div className="text-sm font-medium">{t(`msgDisplay.${key}`)}</div>
                  <div className="text-[11px] text-gray-400">{t(`msgDisplay.${key}Desc`)}</div>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      {generalSubTab === 'license' && licenseInfo && (() => {
        const handleRenew = async () => {
          setRenewing(true);
          setRenewMsg('');
          try {
            const resp = await fetch(`${MAIN_URL}/api/edition/renew`, {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({ licenseDurationMonths: renewMonths }),
            });
            const data = await resp.json();
            if (data.success) {
              setLicenseInfo((prev: any) => ({ ...prev, ...data.edition }));
              setRenewMsg('续期成功');
            } else {
              setRenewMsg(data.error || '续期失败');
            }
          } catch {
            setRenewMsg('网络错误，请稍后重试');
          }
          setRenewing(false);
          setTimeout(() => setRenewMsg(''), 4000);
        };

        const handleSync = async () => {
          setSyncing(true);
          setRenewMsg('');
          try {
            // Call renew to pull latest license from website
            const resp = await fetch(`${MAIN_URL}/api/edition/renew`, {
              method: 'POST',
              headers: authHeaders(),
              body: JSON.stringify({}),
            });
            const data = await resp.json();
            if (data.success) {
              // Merge edition data, preserve currentVersion and _updateInfo
              setLicenseInfo((prev: any) => ({ ...prev, ...data.edition }));
              setRenewMsg('同步成功');
            } else {
              setRenewMsg(data.error || '同步失败');
            }
          } catch {
            setRenewMsg('网络错误');
          }
          setSyncing(false);
          setTimeout(() => setRenewMsg(''), 4000);
        };

        const daysRemaining = licenseInfo.licenseDaysRemaining;
        const showRenew = !licenseInfo.licenseNeverExpires && (
          licenseInfo.licenseExpired || (daysRemaining !== null && daysRemaining <= 30)
        );

        return (
          <div className="space-y-4">
            {/* Software version + update check */}
            <VersionUpdateCard
              currentVersion={licenseInfo.currentVersion || 'unknown'}
              updateInfo={licenseInfo._updateInfo}
              baseUrl={MAIN_URL}
              authHeaders={authHeaders()}
              onCheck={async () => {
                const resp = await fetch(`${MAIN_URL}/api/update/check`, { headers: authHeaders() });
                const data = await resp.json();
                setLicenseInfo((prev: any) => ({ ...prev, _updateInfo: data.available ? data : { available: false } }));
                return data;
              }}
              onApply={async () => {
                const resp = await fetch(`${MAIN_URL}/api/update/apply`, { method: 'POST', headers: authHeaders() });
                return resp.json();
              }}
            />

            {/* Edition info */}
            <div className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold">版本信息</h3>
                <button onClick={handleSync} disabled={syncing}
                  className="px-3 py-1 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
                  {syncing ? '同步中...' : '立即同步'}
                </button>
              </div>
              <div className="grid grid-cols-2 gap-y-2.5 text-sm">
                <span className="text-gray-500">当前版本</span>
                <span className="font-medium">
                  {licenseInfo.editionLabel}
                  <span className={`ml-2 text-xs px-1.5 py-0.5 rounded ${
                    licenseInfo.edition === 'professional' ? 'bg-indigo-50 text-indigo-600' : 'bg-gray-100 text-gray-500'
                  }`}>{licenseInfo.edition}</span>
                </span>
                <span className="text-gray-500">企业名称</span>
                <span>{licenseInfo.companyName || '-'}</span>
                <span className="text-gray-500">联系电话</span>
                <span>{licenseInfo.contactPhone || '-'}</span>
                <span className="text-gray-500">安装实例</span>
                <span className="font-mono text-xs text-gray-400 truncate" title={licenseInfo.installationId}>
                  {licenseInfo.installationId ? licenseInfo.installationId.slice(0, 16) + '...' : '-'}
                </span>
                <span className="text-gray-500">注册状态</span>
                <span>{licenseInfo.registered
                  ? <span className="text-green-600">已注册</span>
                  : <span className="text-amber-500">未注册</span>}
                </span>
              </div>
            </div>

            {/* License validity */}
            <div className={`border rounded-lg p-4 ${
              licenseInfo.licenseExpired ? 'border-red-200 bg-red-50/30' :
              (daysRemaining !== null && daysRemaining <= 30) ? 'border-amber-200 bg-amber-50/30' : 'border-gray-200'
            }`}>
              <h3 className="text-sm font-semibold mb-3">授权有效期</h3>
              <div className="grid grid-cols-2 gap-y-2.5 text-sm">
                <span className="text-gray-500">签发时间</span>
                <span>{licenseInfo.licenseIssuedAt ? new Date(licenseInfo.licenseIssuedAt).toLocaleDateString('zh-CN') : '-'}</span>
                <span className="text-gray-500">到期时间</span>
                <span>{licenseInfo.licenseNeverExpires
                  ? <span className="text-green-600">永不过期</span>
                  : licenseInfo.licenseExpiresAt ? new Date(licenseInfo.licenseExpiresAt).toLocaleDateString('zh-CN') : '-'}</span>
                <span className="text-gray-500">剩余天数</span>
                <span>{licenseInfo.licenseNeverExpires
                  ? <span className="text-green-600">--</span>
                  : licenseInfo.licenseExpired
                    ? <span className="text-red-600 font-medium">已过期</span>
                    : <span className={daysRemaining !== null && daysRemaining <= 30 ? 'text-amber-600 font-medium' : ''}>
                        {daysRemaining} 天
                      </span>}</span>
                <span className="text-gray-500">上次同步</span>
                <span className="text-gray-400 text-xs">
                  {licenseInfo.lastSync ? new Date(licenseInfo.lastSync).toLocaleString('zh-CN') : '从未'}
                </span>
              </div>
              {showRenew && (
                <div className="mt-4 pt-3 border-t border-gray-100">
                  <div className="flex items-center gap-3">
                    <select value={renewMonths} onChange={e => setRenewMonths(Number(e.target.value))}
                      className="px-3 py-1.5 border border-gray-200 rounded-lg text-sm">
                      <option value={3}>续期3个月</option>
                      <option value={6}>续期6个月</option>
                      <option value={12}>续期1年</option>
                    </select>
                    <button onClick={handleRenew} disabled={renewing}
                      className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">
                      {renewing ? '续期中...' : '立即续期'}
                    </button>
                  </div>
                  {renewMsg && <p className={`text-xs mt-2 ${renewMsg === '续期成功' ? 'text-green-600' : 'text-gray-500'}`}>{renewMsg}</p>}
                </div>
              )}
            </div>

            {/* Credits (community only) */}
            {creditsInfo?.isCommunity && (
              <div className="border border-gray-200 rounded-lg p-4">
                <h3 className="text-sm font-semibold mb-3">积分余额</h3>
                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-2xl font-bold text-indigo-600">{creditsInfo.creditsBalance}</span>
                    <span className="text-sm text-gray-400 ml-1">积分</span>
                  </div>
                  <a href={`${licenseInfo.websiteUrl}/topup`} target="_blank" rel="noopener noreferrer"
                    className="px-4 py-1.5 border border-indigo-200 text-indigo-600 text-sm rounded-lg hover:bg-indigo-50">
                    去充值
                  </a>
                </div>
              </div>
            )}

            {/* Feature gates */}
            <div className="border border-gray-200 rounded-lg p-4">
              <h3 className="text-sm font-semibold mb-3">功能权限</h3>
              <div className="space-y-2 text-sm">
                {([
                  ['AI员工上限', licenseInfo.features.maxCoWorkers === 999 ? '无限制' : `${licenseInfo.features.maxCoWorkers} 个`],
                  ['云端模型直连', licenseInfo.features.cloudModelDirect],
                  ['模型配置自定义', licenseInfo.features.modelConfigEditable],
                  ['自定义角色', licenseInfo.features.customRoles],
                  ['MCP服务器', licenseInfo.features.mcpServers],
                ] as Array<[string, boolean | string]>).map(([label, value]) => (
                  <div key={label as string} className="flex items-center justify-between">
                    <span className="text-gray-500">{label}</span>
                    {typeof value === 'boolean'
                      ? value
                        ? <span className="text-green-600 text-xs">已启用</span>
                        : <span className="text-gray-300 text-xs">未开放</span>
                      : <span>{value}</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        );
      })()}

      {generalSubTab === 'system' && (
        <div className="space-y-4">
          <div className="border border-gray-200 rounded-lg p-4">
            <h3 className="text-sm font-semibold mb-1">{t('settings.systemDesc')}</h3>
            <p className="text-xs text-gray-400 mb-4">{t('settings.systemDescSub')}</p>
            <textarea
              value={sysConfigDraft}
              onChange={e => setSysConfigDraft(e.target.value)}
              rows={10}
              className="w-full font-mono text-sm border border-gray-200 rounded-lg p-3 outline-none focus:border-indigo-500 resize-y"
              placeholder={t('common.loading')}
            />
          </div>
          <div className="flex items-center gap-3">
            <button onClick={async () => {
              try {
                const parsed = JSON.parse(sysConfigDraft);
                const resp = await fetch(`${MAIN_URL}/api/system-config`, {
                  method: 'PUT',
                  headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
                  body: JSON.stringify(parsed),
                });
                const data = await resp.json();
                setSysConfig(parsed);
                setSysMsg(data.message || t('common.saved'));
              } catch (e: any) {
                setSysMsg(`${t('common.saveFailed')}: ${e.message}`);
              }
              setTimeout(() => setSysMsg(''), 4000);
            }}
              className="px-6 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700">{t('settings.saveConfig')}</button>
            <button onClick={() => { if (sysConfig) setSysConfigDraft(JSON.stringify(sysConfig, null, 2)); }}
              className="text-xs text-gray-400 hover:text-gray-600">{t('settings.revert')}</button>
            {sysMsg && <span className="text-sm">{sysMsg}</span>}
          </div>
        </div>
      )}


        </div>
      )}

      {activeTab === 'credentials' && (
        <div className="space-y-4">
          <div className="text-xs text-gray-500">配置第三方系统的登录凭证，MCP 连接时自动使用对应凭证登录（按用户隔离）。</div>
          {Object.entries(credSystems).map(([system, creds]) => (
            <div key={system} className="border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-semibold text-gray-800">{system}</span>
                <button onClick={() => deleteCred(system)} className="text-xs text-red-400 hover:text-red-600">删除</button>
              </div>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {Object.entries(creds).map(([k, v]) => (
                  <div key={k}>
                    <span className="text-gray-400">{k}: </span>
                    <span className="text-gray-600">{k.toLowerCase().includes('password') || k.toLowerCase().includes('secret') || k.toLowerCase().includes('token') ? '••••••' : v}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
          {Object.keys(credSystems).length === 0 && !credLoading && (
            <div className="text-center text-gray-400 text-sm py-4">暂无已配置的凭证</div>
          )}
          <SettingsCredentialAdd onSave={(system, creds) => { saveCred(system, creds); }} />
        </div>
      )}

      {activeTab === 'analytics' && (
        <div className="-mx-6 -mb-6 h-[calc(100%-2rem)]">
          <DashboardPanel />
        </div>
      )}


      {activeTab === 'oem' && (
        <div className="-mx-6 -mb-6 h-[calc(100%-2rem)] overflow-y-auto">
          <div className="px-6 pt-4">
            {/* Sub-tabs: 开发 MCP / OEM 接入（参考"系统通用"页签布局） */}
            <div className="flex border-b border-gray-200 mb-4">
              <button onClick={() => setOemSubTab('devMcp')}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${oemSubTab === 'devMcp' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                开发 MCP
              </button>
              <button onClick={() => setOemSubTab('oem')}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${oemSubTab === 'oem' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                OEM 接入
              </button>
            </div>
            {oemSubTab === 'devMcp' && <DevMcpCard />}
          </div>
          {oemSubTab === 'oem' && <OemConsolePanel />}
        </div>
      )}

      {activeTab === 'users' && (
        <div className="h-full" data-testid="user-table-wrapper">
          <UserManagePanel embedded />
        </div>
      )}

    </div>
  );
}

/* ─── Settings Credential Add (dynamic key-value) ─── */

function SettingsCredentialAdd({ onSave }: { onSave: (system: string, creds: Record<string, string>) => void }) {
  const [system, setSystem] = useState('');
  const [fields, setFields] = useState<{ key: string; value: string }[]>([{ key: '', value: '' }]);

  const addRow = () => setFields(prev => [...prev, { key: '', value: '' }]);
  const removeRow = (i: number) => setFields(prev => prev.filter((_, idx) => idx !== i));
  const updateRow = (i: number, patch: { key?: string; value?: string }) => {
    setFields(prev => prev.map((r, idx) => idx === i ? { ...r, ...patch } : r));
  };

  const handleSave = () => {
    if (!system) return;
    const creds: Record<string, string> = {};
    for (const f of fields) {
      if (f.key && f.value) creds[f.key] = f.value;
    }
    if (Object.keys(creds).length === 0) return;
    onSave(system, creds);
    setSystem('');
    setFields([{ key: '', value: '' }]);
  };

  return (
    <div className="border border-dashed border-gray-300 rounded-lg p-4 space-y-2">
      <div className="text-xs font-medium text-gray-500">添加系统凭证</div>
      <input className="w-full px-2 py-1.5 text-xs border border-gray-200 rounded" placeholder="系统名称 (如 erp、openai)" value={system} onChange={e => setSystem(e.target.value)} />
      {fields.map((f, i) => (
        <div key={i} className="flex gap-2">
          <input className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded" placeholder="字段名 (如 api_key)" value={f.key} onChange={e => updateRow(i, { key: e.target.value })} />
          <input className="flex-1 px-2 py-1.5 text-xs border border-gray-200 rounded"
            type={f.key.toLowerCase().includes('password') || f.key.toLowerCase().includes('secret') || f.key.toLowerCase().includes('key') || f.key.toLowerCase().includes('token') ? 'password' : 'text'}
            placeholder="值" value={f.value} onChange={e => updateRow(i, { value: e.target.value })} />
          {fields.length > 1 && <button onClick={() => removeRow(i)} className="text-xs text-gray-300 hover:text-red-400">✕</button>}
        </div>
      ))}
      <div className="flex gap-2">
        <button onClick={addRow} className="text-xs text-indigo-500 hover:text-indigo-700">+ 添加字段</button>
        <div className="flex-1" />
        <button onClick={handleSave} disabled={!system || fields.every(f => !f.key || !f.value)}
          className="px-3 py-1 text-xs bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-40">保存</button>
      </div>
    </div>
  );
}

/* ─── MCP Phase Badge ─── */

function SettingsMcpPhase({ phase }: { phase?: string }) {
  if (phase === 'building') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-600 border border-amber-200">构建中</span>;
  if (phase === 'unconfigured') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-orange-50 text-orange-500 border border-orange-200">未配置</span>;
  if (phase === 'available') return <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-green-50 text-green-600 border border-green-200">可用</span>;
  return null;
}

/* ─── MCP Recycle Bin Component ─── */

function McpRecycleBin({ onRestore }: { onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getMainUrl()}/api/mcp/deleted`, {
        headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && localStorage.getItem('jz_token') ? { 'Authorization': `Bearer ${localStorage.getItem('jz_token')}` } : {}) },
      });
      setItems(await res.json());
    } catch {}
    setLoading(false);
  };

  const restore = async (dirName: string) => {
    await fetch(`${getMainUrl()}/api/mcp/deleted/${dirName}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && localStorage.getItem('jz_token') ? { 'Authorization': `Bearer ${localStorage.getItem('jz_token')}` } : {}) },
    });
    load();
    onRestore();
  };

  const purge = async (dirName: string) => {
    if (!(await confirmDialog('永久删除？此操作不可恢复。', { danger: true }))) return;
    await fetch(`${getMainUrl()}/api/mcp/deleted/${dirName}`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...(typeof window !== 'undefined' && localStorage.getItem('jz_token') ? { 'Authorization': `Bearer ${localStorage.getItem('jz_token')}` } : {}) },
    });
    load();
  };

  return (
    <div className="mt-4">
      <button onClick={() => { setOpen(!open); if (!open) load(); }}
        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
        🗑️ 回收站 {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-2 border border-dashed border-gray-200 rounded-lg p-3">
          {loading && <div className="text-xs text-gray-400 animate-pulse">加载中...</div>}
          {!loading && items.length === 0 && <div className="text-xs text-gray-400 text-center py-2">回收站为空</div>}
          {items.map((item: any) => (
            <div key={item.dirName} className="flex items-center gap-3 py-2 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-gray-600 truncate">{item.manifest?.name || item.originalName}</div>
                <div className="text-[11px] text-gray-400">
                  {item.manifest?.description || ''} · 删除于 {new Date(item.deletedAt).toLocaleString('zh-CN')}
                  {item.manifest?.toolCount ? ` · ${item.manifest.toolCount} 个工具` : ''}
                </div>
              </div>
              <button onClick={() => restore(item.dirName)}
                className="px-2 py-0.5 text-xs text-emerald-600 border border-emerald-200 rounded hover:bg-emerald-50">恢复</button>
              <button onClick={() => purge(item.dirName)}
                className="px-2 py-0.5 text-xs text-red-400 border border-red-200 rounded hover:bg-red-50">永久删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ─── Email Server Templates ─── */

const EMAIL_SERVER_TEMPLATES = [
  { label: '网易163', name: '网易163', smtp_host: 'smtp.163.com', smtp_port: 465, smtp_encryption: 'ssl', imap_host: 'imap.163.com', imap_port: 993, imap_encryption: 'ssl' },
  { label: 'Gmail', name: 'Gmail', smtp_host: 'smtp.gmail.com', smtp_port: 587, smtp_encryption: 'tls', imap_host: 'imap.gmail.com', imap_port: 993, imap_encryption: 'ssl' },
  { label: 'QQ邮箱', name: 'QQ邮箱', smtp_host: 'smtp.qq.com', smtp_port: 465, smtp_encryption: 'ssl', imap_host: 'imap.qq.com', imap_port: 993, imap_encryption: 'ssl' },
  { label: '腾讯企业邮', name: '腾讯企业邮', smtp_host: 'smtp.exmail.qq.com', smtp_port: 465, smtp_encryption: 'ssl', imap_host: 'imap.exmail.qq.com', imap_port: 993, imap_encryption: 'ssl' },
  { label: '网易企业邮', name: '网易企业邮', smtp_host: 'smtp.ym.163.com', smtp_port: 465, smtp_encryption: 'ssl', imap_host: 'imap.ym.163.com', imap_port: 993, imap_encryption: 'ssl' },
  { label: 'Outlook', name: 'Outlook', smtp_host: 'smtp.office365.com', smtp_port: 587, smtp_encryption: 'tls', imap_host: 'outlook.office365.com', imap_port: 993, imap_encryption: 'ssl' },
];

/* ─── Email Settings Tab (Admin: Server Management) ─── */

const EMPTY_SERVER_FORM = { name: '', smtp_host: '', smtp_port: 465, smtp_encryption: 'ssl', imap_host: '', imap_port: 993, imap_encryption: 'ssl', enabled: true };

function EmailSettingsTab() {
  const [servers, setServers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [form, setForm] = useState({ ...EMPTY_SERVER_FORM });
  const [testMsg, setTestMsg] = useState<Record<string, string>>({});
  const [saveMsg, setSaveMsg] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`${getMainUrl()}/api/email/servers`, { headers: authHeaders() });
      setServers(await res.json());
    } catch {}
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const applyTemplate = (idx: number) => {
    const t = EMAIL_SERVER_TEMPLATES[idx];
    if (!t) return;
    setForm({ ...EMPTY_SERVER_FORM, name: t.name, smtp_host: t.smtp_host, smtp_port: t.smtp_port, smtp_encryption: t.smtp_encryption, imap_host: t.imap_host, imap_port: t.imap_port, imap_encryption: t.imap_encryption });
  };

  const handleSave = async () => {
    setSaveMsg('');
    try {
      const url = editId ? `${getMainUrl()}/api/email/servers/${editId}` : `${getMainUrl()}/api/email/servers`;
      const method = editId ? 'PUT' : 'POST';
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(form) });
      if (res.ok) {
        setShowForm(false); setEditId(null); setForm({ ...EMPTY_SERVER_FORM }); load();
      } else {
        const data = await res.json();
        setSaveMsg(data.message || '保存失败');
      }
    } catch { setSaveMsg('保存失败'); }
  };

  const handleDelete = async (id: string) => {
    if (!(await confirmDialog('确认删除此服务器配置？', { danger: true }))) return;
    await fetch(`${getMainUrl()}/api/email/servers/${id}`, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  const handleTest = async (id: string) => {
    setTestMsg(prev => ({ ...prev, [id]: '测试中...' }));
    try {
      const res = await fetch(`${getMainUrl()}/api/email/servers/${id}/test`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      setTestMsg(prev => ({ ...prev, [id]: data.success ? `✅ ${data.message}` : `❌ ${data.message}` }));
    } catch { setTestMsg(prev => ({ ...prev, [id]: '❌ 测试失败' })); }
    setTimeout(() => setTestMsg(prev => { const n = { ...prev }; delete n[id]; return n; }), 5000);
  };

  const startEdit = (s: any) => {
    setEditId(s.id);
    setForm({ name: s.name, smtp_host: s.smtp_host, smtp_port: s.smtp_port, smtp_encryption: s.smtp_encryption, imap_host: s.imap_host, imap_port: s.imap_port, imap_encryption: s.imap_encryption, enabled: s.enabled });
    setShowForm(true);
  };

  return (
    <div className="space-y-4">
      <div className="border border-gray-200 rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold">邮件服务器配置</h3>
          <button onClick={() => { setEditId(null); setForm({ ...EMPTY_SERVER_FORM }); setShowForm(true); }}
            className="px-3 py-1 text-xs border border-indigo-200 text-indigo-600 rounded-lg hover:bg-indigo-50">
            + 添加服务器
          </button>
        </div>
        <p className="text-xs text-gray-400 mb-4">每个服务器同时包含 SMTP（发送）和 IMAP（收取）配置，用户可在头像菜单「我的邮箱」中选择使用。</p>

        {loading ? (
          <div className="text-sm text-gray-400 text-center py-8 animate-pulse">加载中...</div>
        ) : servers.length === 0 ? (
          <div className="text-sm text-gray-400 text-center py-8 border border-dashed border-gray-200 rounded-lg">暂未配置邮件服务器，点击上方按钮添加</div>
        ) : (
          <div className="space-y-2">
            {servers.map((s: any) => (
              <div key={s.id} className={`flex items-center gap-3 px-3 py-2.5 rounded-lg border ${s.enabled ? 'border-gray-200' : 'border-gray-100 opacity-60'}`}>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium truncate">{s.name}</div>
                  <div className="text-xs text-gray-400">
                    {s.smtp_host && <span>SMTP: {s.smtp_host}:{s.smtp_port}</span>}
                    {s.smtp_host && s.imap_host && <span> · </span>}
                    {s.imap_host && <span>IMAP: {s.imap_host}:{s.imap_port}</span>}
                  </div>
                </div>
                {testMsg[s.id] && <span className="text-xs shrink-0">{testMsg[s.id]}</span>}
                <button onClick={() => handleTest(s.id)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0">测试</button>
                <button onClick={() => startEdit(s)} className="text-xs text-gray-400 hover:text-indigo-600 shrink-0">编辑</button>
                <button onClick={() => handleDelete(s.id)} className="text-xs text-gray-400 hover:text-red-500 shrink-0">删除</button>
              </div>
            ))}
          </div>
        )}
      </div>

      {showForm && (
        <div className="border border-indigo-200 rounded-lg p-4 bg-indigo-50/30">
          <h4 className="text-sm font-semibold mb-3">{editId ? '编辑服务器' : '添加服务器'}</h4>

          {!editId && (
            <div className="mb-4">
              <label className="block text-xs text-gray-500 mb-1">从模板创建</label>
              <select onChange={e => applyTemplate(Number(e.target.value))} defaultValue=""
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                <option value="" disabled>选择常用邮箱模板...</option>
                {EMAIL_SERVER_TEMPLATES.map((t, i) => <option key={i} value={i}>{t.label}</option>)}
              </select>
            </div>
          )}

          <div className="mb-3">
            <label className="block text-xs text-gray-500 mb-1">名称</label>
            <input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })}
              className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="如：公司邮箱" />
          </div>

          <div className="text-xs font-medium text-gray-500 mb-2">SMTP 发送</div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">服务器地址</label>
              <input value={form.smtp_host} onChange={e => setForm({ ...form, smtp_host: e.target.value })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="smtp.example.com" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">端口</label>
              <input type="number" value={form.smtp_port} onChange={e => setForm({ ...form, smtp_port: Number(e.target.value) })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">加密</label>
              <select value={form.smtp_encryption} onChange={e => setForm({ ...form, smtp_encryption: e.target.value })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                <option value="ssl">SSL</option><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">无</option>
              </select>
            </div>
          </div>

          <div className="text-xs font-medium text-gray-500 mb-2">IMAP 收取</div>
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div>
              <label className="block text-xs text-gray-400 mb-1">服务器地址</label>
              <input value={form.imap_host} onChange={e => setForm({ ...form, imap_host: e.target.value })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder="imap.example.com" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">端口</label>
              <input type="number" value={form.imap_port} onChange={e => setForm({ ...form, imap_port: Number(e.target.value) })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" />
            </div>
            <div>
              <label className="block text-xs text-gray-400 mb-1">加密</label>
              <select value={form.imap_encryption} onChange={e => setForm({ ...form, imap_encryption: e.target.value })}
                className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                <option value="ssl">SSL</option><option value="tls">TLS</option><option value="starttls">STARTTLS</option><option value="none">无</option>
              </select>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <button onClick={handleSave} disabled={!form.name}
              className="px-4 py-1.5 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-700 disabled:opacity-50">
              {editId ? '保存修改' : '添加'}
            </button>
            <button onClick={() => { setShowForm(false); setEditId(null); setSaveMsg(''); }}
              className="px-4 py-1.5 text-sm text-gray-500 hover:text-gray-700">取消</button>
            {saveMsg && <span className="text-sm text-red-500">{saveMsg}</span>}
          </div>
        </div>
      )}
    </div>
  );
}
/* ─── Version Update Card ─── */

function VersionUpdateCard({ currentVersion, updateInfo, baseUrl, authHeaders: headers, onCheck, onApply }: {
  currentVersion: string;
  updateInfo: any;
  baseUrl: string;
  authHeaders: Record<string, string>;
  onCheck: () => Promise<any>;
  onApply: () => Promise<any>;
}) {
  const [checking, setChecking] = useState(false);
  const [checkMsg, setCheckMsg] = useState('');
  const [updating, setUpdating] = useState(false);
  const [progress, setProgress] = useState<any>(null);
  const [updateError, setUpdateError] = useState('');
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = () => {
    if (pollingRef.current) { clearInterval(pollingRef.current); pollingRef.current = null; }
  };

  const handleCheck = async () => {
    setChecking(true);
    setCheckMsg('');
    try {
      const data = await onCheck();
      setCheckMsg(data.available ? `发现新版本 ${data.version}` : '✅ 已是最新版本');
    } catch {
      setCheckMsg('❌ 检查失败，请稍后重试');
    }
    setChecking(false);
    setTimeout(() => setCheckMsg(''), 6000);
  };

  const handleApply = async () => {
    setUpdating(true);
    setUpdateError('');
    setProgress(null);

    try {
      const data = await onApply();
      if (!data.started) {
        setUpdateError(data.error || '启动更新失败');
        setUpdating(false);
        return;
      }

      // Poll progress
      pollingRef.current = setInterval(async () => {
        try {
          const resp = await fetch(`${baseUrl}/api/update/status`, { headers });
          const p = await resp.json();
          setProgress(p);

          if (p.phase === 'restarting') {
            stopPolling();
            setTimeout(() => window.location.reload(), 5000);
          }
          if (p.phase === 'error') {
            stopPolling();
            setUpdateError(p.error || '更新失败');
          }
        } catch {
          // Server may be restarting — try reload
          stopPolling();
          setTimeout(() => window.location.reload(), 5000);
        }
      }, 1000);
    } catch {
      setUpdateError('网络错误，更新失败');
    }
  };

  // Cleanup polling on unmount
  useEffect(() => () => stopPolling(), []);

  const formatBytes = (b: number) => b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${(b / 1024).toFixed(0)} KB`;

  const phaseLabel: Record<string, string> = {
    downloading: '正在下载', backup: '正在备份', installing: '正在安装', restarting: '正在重启', done: '完成', error: '失败',
  };

  const phaseSteps = [
    { key: 'downloading', label: '下载更新包' },
    { key: 'installing', label: '安装更新' },
    { key: 'restarting', label: '重启服务' },
  ];
  const phaseOrder = ['downloading', 'installing', 'restarting'];

  // 计算本次实际下载体积：能走增量则按补丁体积，否则全量（kb 恒全量）
  const downloadPlan = (() => {
    const u: any = updateInfo;
    if (!u) return { size: 0, isDelta: false };
    const comps = u.components || {};
    const d = u.delta;
    const useDelta = d && d.base === currentVersion;
    if (!useDelta) return { size: u.totalSize || 0, isDelta: false };
    let size = 0;
    for (const c of ['main', 'web']) {
      if (d[c]?.file) size += d[c].size || 0;          // 走补丁
      else if (comps[c]?.size) size += comps[c].size;  // 该组件无补丁 → 全量兜底
    }
    if (comps.kb?.size) size += comps.kb.size;          // kb 恒全量
    return { size, isDelta: true };
  })();

  const stepStatus = (stepKey: string): 'done' | 'active' | 'pending' | 'error' => {
    if (!progress) return 'pending';
    const cur = phaseOrder.indexOf(progress.phase);
    const step = phaseOrder.indexOf(stepKey);
    if (progress.phase === 'error') {
      return step < cur ? 'done' : step === cur ? 'error' : 'pending';
    }
    return step < cur ? 'done' : step === cur ? 'active' : 'pending';
  };

  const stepIcon = (s: string) => s === 'done' ? '✅' : s === 'active' ? '⏳' : s === 'error' ? '❌' : '○';

  return (
    <div className="border border-gray-200 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">📦 软件版本</h3>
        <div className="flex items-center gap-2">
          {checkMsg && (
            <span className={`text-xs ${checkMsg.includes('✅') ? 'text-green-600' : checkMsg.includes('❌') ? 'text-red-500' : 'text-indigo-600'}`}>
              {checkMsg}
            </span>
          )}
          <button onClick={handleCheck} disabled={checking || updating}
            className="px-3 py-1 text-xs border border-gray-200 rounded-lg hover:bg-gray-50 disabled:opacity-50">
            {checking ? '检查中...' : '检查更新'}
          </button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-y-2 text-sm">
        <span className="text-gray-500">当前版本</span>
        <span className="font-medium font-mono">{currentVersion}</span>
      </div>

      {/* Update available */}
      {updateInfo?.available && !updating && (
        <div className="mt-3 bg-indigo-50 rounded-lg px-4 py-3 border border-indigo-100">
          <div className="text-sm font-medium text-indigo-700 mb-1">🆕 发现新版本 {updateInfo.version}</div>
          <div className="text-xs text-indigo-600 mb-2">
            发布时间: {new Date(updateInfo.releaseDate).toLocaleDateString('zh-CN')}
            {downloadPlan.size ? (
              downloadPlan.isDelta
                ? ` · 增量补丁 ${formatBytes(downloadPlan.size)}${updateInfo.totalSize && updateInfo.totalSize > downloadPlan.size ? `（全量 ${formatBytes(updateInfo.totalSize)}）` : ''}`
                : ` · ${formatBytes(downloadPlan.size)}`
            ) : ''}
            {updateInfo.gitCommit ? ` · ${String(updateInfo.gitCommit).slice(0, 9)}` : ''}
          </div>
          {updateInfo.releaseNotes && <div className="text-xs text-indigo-500 mb-3 whitespace-pre-wrap">{updateInfo.releaseNotes}</div>}
          <div className="flex items-center gap-3">
            <button onClick={handleApply} className="px-4 py-1.5 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg">立即更新</button>
            <span className="text-[10px] text-indigo-400">更新过程中服务将短暂不可用</span>
          </div>
        </div>
      )}

      {/* Update progress */}
      {updating && (
        <div className="mt-3 bg-gray-50 rounded-lg px-4 py-4 border border-gray-200">
          <div className="text-sm font-medium text-gray-700 mb-3">🔄 正在更新到 {updateInfo?.version}</div>

          {/* Download progress bar */}
          {progress?.phase === 'downloading' && (
            <div className="mb-3">
              <div className="flex items-center justify-between text-xs text-gray-500 mb-1">
                <span>下载 {progress.currentComponent}...</span>
                <span>{formatBytes(progress.downloadedBytes)} / {formatBytes(progress.totalBytes)} ({progress.percent}%)</span>
              </div>
              <div className="h-2 bg-gray-200 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-500 rounded-full transition-all duration-300" style={{ width: `${progress.percent}%` }} />
              </div>
              {/* Per-component detail */}
              <div className="flex gap-3 mt-1.5">
                {Object.entries(progress.components || {}).map(([name, c]: [string, any]) => (
                  <span key={name} className={`text-[10px] ${c.done ? 'text-green-500' : name === progress.currentComponent ? 'text-indigo-500 font-medium' : 'text-gray-400'}`}>
                    {c.done ? '✅' : name === progress.currentComponent ? '⏳' : '○'} {name} {c.done ? formatBytes(c.totalBytes) : `${formatBytes(c.downloadedBytes)}/${formatBytes(c.totalBytes)}`}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Step list */}
          <div className="space-y-1.5 mb-3">
            {phaseSteps.map(({ key, label }) => {
              const s = stepStatus(key);
              return (
                <div key={key} className="flex items-center gap-2 text-xs">
                  <span className="w-4 text-center">{stepIcon(s)}</span>
                  <span className={s === 'active' ? 'text-indigo-600 font-medium' : s === 'done' ? 'text-gray-400' : s === 'error' ? 'text-red-500' : 'text-gray-400'}>
                    {label}
                  </span>
                  {s === 'active' && key !== 'downloading' && <span className="text-indigo-400 animate-pulse">...</span>}
                </div>
              );
            })}
          </div>

          {progress?.phase === 'restarting' && (
            <div className="text-xs text-green-600 bg-green-50 rounded px-3 py-2 border border-green-100">
              ✅ 更新完成，页面将自动刷新...
            </div>
          )}
          {updateError && (
            <div className="text-xs text-red-600 bg-red-50 rounded px-3 py-2 border border-red-100">
              {updateError}
              <button onClick={() => { setUpdating(false); setUpdateError(''); stopPolling(); }}
                className="ml-2 text-red-400 hover:text-red-600 underline">关闭</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
