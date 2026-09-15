'use client';

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';

import { getMainUrl } from '@/lib/env';
import { confirmDialog, alertSuccess, alertError } from '@/components/AppDialog';
const MAIN_URL = getMainUrl();

function getToken() { return localStorage.getItem('jz_token') || ''; }
function authHeaders() { return { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' }; }

interface CoWorkerCapabilities {
  builtin: string[];
  mcp: Array<{ serverId: string; serverName?: string; tools: string[] }>;
  skills: string[];
}

interface CoWorkerItem {
  id: string; name: string; description: string; avatarUrl: string;
  soul: string; modelLevel: string; tools: string[]; skills: string[];
  mcpServers?: string[]; capabilities?: CoWorkerCapabilities;
  workScope: string; status: string; createdAt: string; updatedAt: string;
  buildVersion?: number; configVersion?: number; lastBuildAt?: string;
  assignmentCount?: number; onlineCount?: number;
}

interface MyCoWorkerItem {
  id: string; coworkerId: string; userId: string; status: string;
  configVersion: number; lastSeen: string | null; createdAt: string;
  coworker: CoWorkerItem;
  downloadLinks?: {
    installer: { windows: string; macos: string };
    config: string;
    guide: string;
  };
}

interface UserItem { id: string; name: string; email: string; role: { id: string } }
interface Assignment { id: string; userId: string; userName?: string; userEmail?: string; status: string; lastSeen: string | null; configVersion: number; enrollToken?: string }

function getUserPerms(): string[] {
  try {
    const u = JSON.parse(localStorage.getItem('jz_user') || '{}');
    return u.role?.permissions || [];
  } catch { return []; }
}

function CoWorkerPanelAdmin() {
  const { t } = useI18n();

  const [coworkers, setCoworkers] = useState<CoWorkerItem[]>([]);
  const [selected, setSelected] = useState<CoWorkerItem | null>(null);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [showEditor, setShowEditor] = useState(false);
  const [editData, setEditData] = useState<Partial<CoWorkerItem>>({});
  const [users, setUsers] = useState<UserItem[]>([]);
  const [msg, setMsg] = useState('');
  const [configYaml, setConfigYaml] = useState('');
  const [saving, setSaving] = useState(false);
  const [building, setBuilding] = useState(false);
  const [buildResult, setBuildResult] = useState<{ downloadUrl?: string; files?: string[] } | null>(null);
  const [pmLoading, setPmLoading] = useState<string>('');     // 正在分析的 assignmentId
  const [pmReport, setPmReport] = useState<any | null>(null); // 会后分析报告（弹窗）
  const [winAppStatus, setWinAppStatus] = useState<{ available: boolean; version?: string; size?: number } | null>(null);
  const [winBuilding, setWinBuilding] = useState(false);      // Windows 安装器构建中
  const [winBuildProgress, setWinBuildProgress] = useState<any>(null); // Windows 构建进度

  // 左侧列表宽度（可拖拽分割线调整，持久化）。拖拽仅改变容器宽度，不改动列表项样式。
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return 288;
    const v = Number(localStorage.getItem('cw.leftWidth'));
    return v >= 220 && v <= 560 ? v : 288;
  });
  useEffect(() => { try { localStorage.setItem('cw.leftWidth', String(leftWidth)); } catch { /* ignore */ } }, [leftWidth]);
  const startLeftResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = leftWidth;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    const onMove = (ev: MouseEvent) => setLeftWidth(Math.min(560, Math.max(220, startW + ev.clientX - startX)));
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  };

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  // 会后分析：用 live 蒸馏工具规格对该分配的最近会话程序化打分
  const runPostMeeting = async (assignmentId: string) => {
    if (!selected) return;
    setPmLoading(assignmentId);
    try {
      const res = await fetch(`${MAIN_URL}/api/coworkers/${selected.id}/assignments/${assignmentId}/post-meeting`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ limit: 80 }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) { flash(data?.message || '会后分析失败'); return; }
      if (data?.skipped) { flash(data.reason || '暂无可套用的工具规格'); return; }
      setPmReport(data);
    } catch (e: any) {
      flash(e?.message || '会后分析失败');
    } finally {
      setPmLoading('');
    }
  };

  const load = useCallback(async () => {
    const res = await fetch(`${MAIN_URL}/api/coworkers`, { headers: authHeaders() });
    if (res.ok) setCoworkers(await res.json());
  }, []);

  // 加载 Windows app 状态
  useEffect(() => {
    fetch(`${MAIN_URL}/api/coworkers/app/win/status`, { headers: authHeaders() })
      .then(r => r.json())
      .then(setWinAppStatus)
      .catch(() => setWinAppStatus({ available: false }));
  }, []);

  useEffect(() => { load(); }, [load]);

  const loadDetail = async (id: string) => {
    const res = await fetch(`${MAIN_URL}/api/coworkers/${id}`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      setSelected(data);
      setAssignments(data.assignments || []);
    }
  };

  const loadUsers = async () => {
    const res = await fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() });
    if (res.ok) setUsers(await res.json());
  };

  const save = async () => {
    if (!editData.name?.trim()) { flash('名称不能为空'); return; }
    setSaving(true);
    try {
      const method = editData.id ? 'PUT' : 'POST';
      const url = editData.id ? `${MAIN_URL}/api/coworkers/${editData.id}` : `${MAIN_URL}/api/coworkers`;
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(editData) });
      if (res.ok) {
        const saved = await res.json().catch(() => ({}));
        const rejected: string[] = saved?.rejectedCapabilities || [];
        flash(rejected.length ? `已保存，但忽略了 ${rejected.length} 项无效能力: ${rejected.slice(0, 3).join(', ')}` : '已保存');
        const savedId = editData.id || saved?.id;
        setShowEditor(false); setEditData({});
        load();
        if (savedId) loadDetail(savedId);
      }
      else {
        const d = await res.json().catch(() => ({}));
        flash(`失败: ${d.message || res.status}`);
      }
    } finally { setSaving(false); }
  };

  const remove = async (id: string) => {
    if (!(await confirmDialog('确认删除？', { danger: true }))) return;
    const res = await fetch(`${MAIN_URL}/api/coworkers/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) { flash('删除失败'); return; }
    setSelected(null);
    load();
  };

  const publish = async (id: string) => {
    const res = await fetch(`${MAIN_URL}/api/coworkers/${id}/publish`, { method: 'POST', headers: authHeaders() });
    if (!res.ok) { flash('发布失败'); return; }
    flash('已发布');
    loadDetail(id);
    load();
  };

  const assign = async (userId: string) => {
    if (!selected) return;
    const res = await fetch(`${MAIN_URL}/api/coworkers/${selected.id}/assign`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ userId }),
    });
    if (res.ok) { flash('已分配'); loadDetail(selected.id); }
    else {
      const d = await res.json().catch(() => ({}));
      flash(d.message || '分配失败');
    }
  };

  const unassign = async (userId: string) => {
    if (!selected) return;
    const res = await fetch(`${MAIN_URL}/api/coworkers/${selected.id}/assign/${userId}`, { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) { flash('取消分配失败'); return; }
    loadDetail(selected.id);
  };

  const generateEnrollToken = async (assignmentId: string) => {
    if (!selected) return;
    const res = await fetch(`${MAIN_URL}/api/coworkers/assignments/${assignmentId}/enroll-token`, {
      method: 'POST', headers: authHeaders(),
    });
    if (res.ok) {
      const data = await res.json();
      flash(`激活码: ${data.token}`);
      loadDetail(selected.id); // 刷新列表显示 token
    } else {
      flash('生成激活码失败');
    }
  };

  const copyEnrollLink = (token: string) => {
    const link = `jzai://enroll?token=${token}`;
    navigator.clipboard.writeText(link);
    flash('已复制激活链接');
  };

  const viewConfig = async (id: string) => {
    const res = await fetch(`${MAIN_URL}/api/coworkers/${id}/config`, { headers: authHeaders() });
    if (res.ok) {
      const data = await res.json();
      setConfigYaml(data.yaml || '');
    }
  };

  const buildPackage = async (id: string) => {
    setBuilding(true);
    setBuildResult(null);
    try {
      const res = await fetch(`${MAIN_URL}/api/coworkers/${id}/build`, { method: 'POST', headers: authHeaders() });
      if (res.ok) {
        const data = await res.json();
        setBuildResult({ downloadUrl: `${MAIN_URL}/api/coworkers/${id}/build/download`, files: data.files });
        flash('构建成功');
        loadDetail(id); // Refresh build status
      } else {
        const d = await res.json().catch(() => ({}));
        flash(`构建失败: ${d.message || res.status}`);
      }
    } finally { setBuilding(false); }
  };

  // Windows 安装器构建
  const buildWinInstaller = async () => {
    setWinBuilding(true);
    setWinBuildProgress(null);
    try {
      const res = await fetch(`${MAIN_URL}/api/coworkers/build-win`, { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (data.started) {
        flash('Windows 安装器构建已启动');
        // 轮询构建进度
        pollWinBuildProgress();
      } else {
        flash(`构建启动失败: ${data.reason || '未知原因'}`);
      }
    } catch (err) {
      flash(`请求失败: ${err instanceof Error ? err.message : '网络错误'}`);
    } finally {
      // 不立即设置 setWinBuilding(false)，等待轮询完成
    }
  };

  const pollWinBuildProgress = async () => {
    const pollInterval = setInterval(async () => {
      try {
        const res = await fetch(`${MAIN_URL}/api/coworkers/build-win/status`, { headers: authHeaders() });
        if (res.ok) {
          const progress = await res.json();
          setWinBuildProgress(progress);

          if (!progress.running || progress.phase === 'done') {
            clearInterval(pollInterval);
            setWinBuilding(false);
            if (progress.phase === 'done') {
              flash('Windows 安装器构建完成');
              // 刷新状态
              setWinAppStatus(await fetch(`${MAIN_URL}/api/coworkers/app/win/status`, { headers: authHeaders() }).then(r => r.ok ? r.json() : null));
            } else if (progress.phase === 'error') {
              flash(`构建失败: ${progress.error || '未知错误'}`);
            }
          }
        }
      } catch (err) {
        clearInterval(pollInterval);
        setWinBuilding(false);
        flash('获取构建状态失败');
      }
    }, 3000); // 每3秒轮询一次
  };

  // 生成员工下载链接（带 token）
  const generateEmployeeDownloadLink = (assignmentId: string, enrollToken: string) => {
    if (!enrollToken) {
      return '# (需先生成激活码)';
    }
    return `${MAIN_URL}/api/coworkers/app/win/download?token=${enrollToken}`;
  };

  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100';

  return (
    <div className="h-full flex">
      {/* Left: List（宽度可拖拽调整；仅改变容器宽度，列表项样式不变） */}
      <div style={{ width: leftWidth }} className="shrink-0 border-r border-gray-200 flex flex-col bg-white">
        <div className="p-3 border-b border-gray-100 flex items-center justify-between">
          <span className="font-medium text-sm text-gray-800">CoWorker 管理</span>
          <button onClick={() => { setEditData({}); setShowEditor(true); }}
            className="px-2.5 py-1 bg-indigo-600 text-white text-xs rounded-lg hover:bg-indigo-700 transition-colors">+ 新建</button>
        </div>
        <div className="flex-1 overflow-auto">
          {coworkers.map(cw => (
            <div key={cw.id} onClick={() => { setSelected(cw); loadDetail(cw.id); setBuildResult(null); }}
              className={`p-3 border-b border-gray-100 cursor-pointer hover:bg-gray-50 transition-colors ${selected?.id === cw.id ? 'bg-indigo-50' : ''}`}>
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-xs font-bold shrink-0">
                  {cw.name.charAt(0)}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-gray-800 truncate">{cw.name}</div>
                  <div className="text-xs text-gray-400 flex items-center gap-1">
                    <span className={`w-1.5 h-1.5 rounded-full ${cw.status === 'published' ? 'bg-green-400' : 'bg-gray-300'}`} />
                    {cw.status === 'published' ? '已发布' : '草稿'}
                    {cw.onlineCount ? ` · ${cw.onlineCount} 在线` : ''}
                  </div>
                </div>
              </div>
            </div>
          ))}
          {coworkers.length === 0 && (
            <div className="p-6 text-center text-sm text-gray-400">暂无 CoWorker，点击"新建"创建</div>
          )}
        </div>
        <OpenClawSourceCard />
        <WindowsAppCard />
      </div>

      {/* 可拖拽分割线：拖动调整左侧列表宽度 */}
      <div onMouseDown={startLeftResize} title="拖拽调整列表宽度"
        className="w-1.5 shrink-0 cursor-col-resize bg-transparent hover:bg-indigo-300 active:bg-indigo-400 transition-colors" />

      {/* Right: Detail / Editor */}
      <div className="flex-1 overflow-auto bg-gray-50">
        {msg && <div className="absolute top-2 right-4 z-50 bg-gray-800 text-white px-3 py-1.5 rounded-lg text-sm shadow-lg">{msg}</div>}

        {pmReport && (
          <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={() => setPmReport(null)}>
            <div className="bg-white rounded-xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-auto" onClick={e => e.stopPropagation()}>
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-gray-100 sticky top-0 bg-white">
                <div>
                  <h3 className="text-base font-semibold text-gray-900">会后分析 · {pmReport.coworkerName}</h3>
                  <p className="text-xs text-gray-500 mt-0.5">
                    {pmReport.userName || pmReport.assignmentId} · 纳入 {pmReport.messageCount} 条消息 · 套用 {pmReport.specsApplied?.length || 0} 套规格
                  </p>
                </div>
                <div className="flex items-center gap-3">
                  {pmReport.overallScore != null && (
                    <div className="text-right">
                      <div className={`text-2xl font-bold ${pmReport.overallScore >= 80 ? 'text-emerald-600' : pmReport.overallScore >= 60 ? 'text-amber-500' : 'text-red-500'}`}>
                        {pmReport.overallScore}
                      </div>
                      <div className="text-[10px] text-gray-400 -mt-1">综合分</div>
                    </div>
                  )}
                  <button onClick={() => setPmReport(null)} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
                </div>
              </div>

              <div className="p-5 space-y-4 text-sm">
                {pmReport.report?.summary && (
                  <p className="text-gray-700 bg-gray-50 rounded-lg p-3 leading-relaxed">{pmReport.report.summary}</p>
                )}

                {(pmReport.report?.specs || []).map((s: any) => (
                  <div key={s.nodeId} className="border border-gray-200 rounded-lg p-3">
                    <div className="flex items-center gap-2 mb-2">
                      <span className="text-xs px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{s.kind}</span>
                      <span className="font-medium text-gray-800">{s.title}</span>
                      {s.topic && <span className="text-xs text-gray-400">· {s.topic}</span>}
                    </div>

                    {s.kind === 'scorecard' && (
                      <div className="space-y-1.5">
                        {(s.dimensions || []).map((d: any, i: number) => (
                          <div key={i}>
                            <div className="flex items-center justify-between">
                              <span className="text-gray-700">{d.name}</span>
                              <span className="text-gray-500">{d.score}/{d.max}</span>
                            </div>
                            <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                              <div className="h-full bg-emerald-400" style={{ width: `${d.max ? (d.score / d.max) * 100 : 0}%` }} />
                            </div>
                            {d.rationale && <p className="text-xs text-gray-400 mt-0.5">{d.rationale}</p>}
                          </div>
                        ))}
                      </div>
                    )}

                    {s.kind === 'checklist' && (
                      <ul className="space-y-1">
                        {(s.items || []).map((it: any, i: number) => (
                          <li key={i} className="flex items-start gap-1.5 text-gray-700">
                            <span className={it.covered ? 'text-emerald-500' : 'text-red-400'}>{it.covered ? '✓' : '✗'}</span>
                            <span>{it.item}{it.evidence && <span className="text-xs text-gray-400">　“{it.evidence}”</span>}</span>
                          </li>
                        ))}
                      </ul>
                    )}

                    {s.kind === 'script' && (
                      <ol className="space-y-1">
                        {(s.steps || []).map((st: any, i: number) => (
                          <li key={i} className="flex items-start gap-1.5 text-gray-700">
                            <span className={st.hit ? 'text-emerald-500' : 'text-red-400'}>{st.hit ? '✓' : '✗'}</span>
                            <span>{i + 1}. {st.step}{st.evidence && <span className="text-xs text-gray-400">　“{st.evidence}”</span>}</span>
                          </li>
                        ))}
                      </ol>
                    )}

                    {s.kind === 'form' && (
                      <ul className="space-y-1">
                        {(s.fields || []).map((f: any, i: number) => (
                          <li key={i} className="flex items-start gap-1.5 text-gray-700">
                            <span className={f.found ? 'text-emerald-500' : 'text-gray-300'}>{f.found ? '✓' : '○'}</span>
                            <span>{f.label}：<span className="text-gray-500">{f.value || '（未收集）'}</span></span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                ))}

                {(pmReport.report?.strengths?.length > 0 || pmReport.report?.gaps?.length > 0 || pmReport.report?.suggestions?.length > 0) && (
                  <div className="grid grid-cols-1 gap-2">
                    {pmReport.report?.strengths?.length > 0 && (
                      <div><div className="text-xs font-medium text-emerald-600 mb-1">做得好</div>
                        <ul className="list-disc list-inside text-gray-700 space-y-0.5">{pmReport.report.strengths.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
                    )}
                    {pmReport.report?.gaps?.length > 0 && (
                      <div><div className="text-xs font-medium text-red-500 mb-1">欠缺</div>
                        <ul className="list-disc list-inside text-gray-700 space-y-0.5">{pmReport.report.gaps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
                    )}
                    {pmReport.report?.suggestions?.length > 0 && (
                      <div><div className="text-xs font-medium text-indigo-600 mb-1">改进建议</div>
                        <ul className="list-disc list-inside text-gray-700 space-y-0.5">{pmReport.report.suggestions.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul></div>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {showEditor ? (
          <CoWorkerEditor data={editData} onChange={setEditData} onSave={save} onCancel={() => { setShowEditor(false); setEditData({}); }} />
        ) : selected ? (
          <div className="p-5 space-y-4 max-w-4xl">
            {/* Header */}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white text-lg font-bold">
                  {selected.name.charAt(0)}
                </div>
                <div>
                  <h2 className="text-lg font-semibold text-gray-900">{selected.name}</h2>
                  <p className="text-sm text-gray-500">{selected.description || '无描述'}</p>
                </div>
              </div>
              <div className="flex gap-2">
                <button onClick={() => { setEditData(selected); setShowEditor(true); }}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600 transition-colors">编辑</button>
                {selected.status === 'draft' && (
                  <button onClick={() => publish(selected.id)}
                    className="px-3 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors">发布</button>
                )}
                <button onClick={() => viewConfig(selected.id)}
                  className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600 transition-colors">查看配置</button>
                <button onClick={() => buildPackage(selected.id)} disabled={building}
                  className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
                  {building ? '构建中...' : (selected.buildVersion && selected.buildVersion > 0 && selected.buildVersion < (selected.configVersion || 1)) ? '重新构建' : (selected.buildVersion && selected.buildVersion > 0) ? '重新构建' : '构建部署包'}
                </button>
                {/* <button onClick={() => buildWinInstaller()} disabled={winBuilding}
                  className="px-3 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors">
                  {winBuilding ? (winBuildProgress?.message || '构建中...') : '构建 Windows 安装器'}
                </button> */}
                <button onClick={() => remove(selected.id)}
                  className="px-3 py-1.5 text-sm text-red-500 border border-red-200 rounded-lg hover:bg-red-50 transition-colors">删除</button>
              </div>
            </div>

            {/* Info Cards */}
            <div className="grid grid-cols-3 gap-3">
              <InfoCard label="模型级别" value={selected.modelLevel} />
              <InfoCard label="工具数" value={`${selected.tools?.length || 0} 个`} />
              <InfoCard label="状态" value={selected.status === 'published' ? '已发布' : '草稿'} />
            </div>

            {/* Build Status */}
            {(() => {
              const hasBuilt = (selected.buildVersion || 0) > 0;
              const needsRebuild = hasBuilt && (selected.buildVersion || 0) < (selected.configVersion || 1);
              const downloadUrl = `${MAIN_URL}/api/coworkers/${selected.id}/build/download?token=${getToken()}`;

              if (buildResult) {
                return (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                    <div className="flex items-center justify-between mb-2">
                      <h3 className="text-sm font-medium text-green-800">部署包已生成</h3>
                      <a href={`${buildResult.downloadUrl}?token=${getToken()}`} download
                        className="px-4 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
                        下载部署包
                      </a>
                    </div>
                    {buildResult.files && (
                      <div className="text-xs text-green-600 space-y-0.5">
                        {buildResult.files.map((f, i) => <div key={i}>📄 {f}</div>)}
                      </div>
                    )}
                    <p className="text-xs text-green-500 mt-2">被分配的员工也可以在"我的 CoWorker"页面直接下载。</p>
                  </div>
                );
              }

              if (hasBuilt && !needsRebuild) {
                return (
                  <div className="bg-green-50 border border-green-200 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-green-800 flex items-center gap-1.5">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                          已构建
                        </h3>
                        <p className="text-xs text-green-600 mt-0.5">
                          构建时间: {selected.lastBuildAt ? new Date(selected.lastBuildAt).toLocaleString('zh-CN') : '—'}
                        </p>
                      </div>
                      <a href={downloadUrl} download
                        className="px-4 py-1.5 text-sm bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
                        下载部署包
                      </a>
                    </div>
                  </div>
                );
              }

              if (needsRebuild) {
                return (
                  <div className="bg-amber-50 border border-amber-200 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-amber-800 flex items-center gap-1.5">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          配置已变更，需要重新构建
                        </h3>
                        <p className="text-xs text-amber-600 mt-0.5">
                          上次构建: {selected.lastBuildAt ? new Date(selected.lastBuildAt).toLocaleString('zh-CN') : '—'}
                          &nbsp;·&nbsp;当前仍可下载旧版本
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <a href={downloadUrl} download
                          className="px-3 py-1.5 text-xs text-amber-700 border border-amber-300 rounded-lg hover:bg-amber-100 transition-colors">
                          下载旧版
                        </a>
                        <button onClick={() => buildPackage(selected.id)} disabled={building}
                          className="px-3 py-1.5 text-sm bg-amber-600 text-white rounded-lg hover:bg-amber-700 disabled:opacity-50 transition-colors">
                          {building ? '构建中...' : '重新构建'}
                        </button>
                      </div>
                    </div>
                  </div>
                );
              }

              return null;
            })()}

            {/* Windows Build Status */}
            {(() => {
              if (winBuildProgress?.running) {
                return (
                  <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-blue-800 flex items-center gap-1.5">
                          <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                          Windows 安装器构建中
                        </h3>
                        <p className="text-xs text-blue-600 mt-0.5">{winBuildProgress.message}</p>
                      </div>
                    </div>
                  </div>
                );
              }

              if (winBuildProgress?.phase === 'done') {
                return (
                  <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-emerald-800 flex items-center gap-1.5">
                          <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" /></svg>
                          Windows 安装器已生成
                        </h3>
                        <p className="text-xs text-emerald-600 mt-0.5">
                          {winBuildProgress.message}
                        </p>
                      </div>
                      <a href={`${MAIN_URL}/api/coworkers/app/win/download?token=${getToken()}`} download
                        className="px-4 py-1.5 text-sm bg-emerald-600 text-white rounded-lg hover:bg-emerald-700 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M7 10l5 5m0 0l5-5m-5 5V3" /></svg>
                        下载安装器
                      </a>
                    </div>
                  </div>
                );
              }

              if (winBuildProgress?.phase === 'error') {
                return (
                  <div className="bg-red-50 border border-red-200 rounded-xl p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <h3 className="text-sm font-medium text-red-800 flex items-center gap-1.5">
                          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                          构建失败
                        </h3>
                        <p className="text-xs text-red-600 mt-0.5">{winBuildProgress.error}</p>
                      </div>
                      <button onClick={() => setWinBuildProgress(null)} className="text-xs text-red-500 hover:underline">关闭</button>
                    </div>
                  </div>
                );
              }

              return null;
            })()}

            {/* Soul */}
            {selected.soul && (
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <h3 className="text-sm font-medium mb-1.5 text-gray-500">人格设定</h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap leading-relaxed">{selected.soul.slice(0, 500)}{selected.soul.length > 500 ? '...' : ''}</p>
              </div>
            )}

            {/* Work Scope */}
            {selected.workScope && (
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <h3 className="text-sm font-medium mb-1.5 text-gray-500">工作范围</h3>
                <p className="text-sm text-gray-700 whitespace-pre-wrap">{selected.workScope}</p>
              </div>
            )}

            {/* Assignments */}
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-medium text-gray-500">分配员工 ({assignments.length})</h3>
                <div className="flex gap-2">
                  {winAppStatus?.available && (
                    <a href={`${MAIN_URL}/api/coworkers/app/win?token=${getToken()}`} download
                      className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700 transition-colors">
                      下载 Windows 客户端
                    </a>
                  )}
                  <button onClick={() => loadUsers()} className="text-xs text-indigo-600 hover:underline">+ 分配</button>
                </div>
              </div>
              {assignments.length > 0 ? (
                <div className="space-y-0">
                  {assignments.map(a => (
                    <div key={a.id} className="py-2 border-t border-gray-100 first:border-0">
                      <div className="flex items-center justify-between text-sm mb-1">
                        <div className="flex items-center gap-2">
                          <span className={`w-2 h-2 rounded-full ${a.lastSeen && Date.now() - new Date(a.lastSeen).getTime() < 90000 ? 'bg-green-400' : 'bg-gray-300'}`} />
                          <span className="text-gray-700">{a.userName || a.userEmail || a.userId}</span>
                        </div>
                        <div className="flex items-center gap-3">
                          <span className="text-xs text-gray-400">v{a.configVersion}</span>
                          <button onClick={() => unassign(a.userId)} className="text-xs text-red-500 hover:underline">移除</button>
                        </div>
                      </div>
                      {/* 激活码和操作 */}
                      <div className="flex items-center gap-2 ml-4 text-xs">
                        {a.enrollToken ? (
                          <>
                            <span className="text-gray-500">激活码:</span>
                            <code className="bg-gray-100 px-1.5 py-0.5 rounded text-gray-800 font-mono">{a.enrollToken}</code>
                            <button onClick={() => copyEnrollLink(a.enrollToken!)} className="text-indigo-600 hover:underline">复制链接</button>
                            <span className="text-gray-400">|</span>
                            <button onClick={() => runPostMeeting(a.id)} disabled={pmLoading === a.id}
                              className="text-emerald-600 hover:underline disabled:text-gray-300 disabled:no-underline">
                              {pmLoading === a.id ? '分析中…' : '会后分析'}
                            </button>
                          </>
                        ) : (
                          <button onClick={() => generateEnrollToken(a.id)} className="text-blue-600 hover:underline">
                            + 生成激活码
                          </button>
                        )}
                        {buildResult?.downloadUrl && (
                          <>
                            <span className="text-gray-400">|</span>
                            <a href={`${buildResult.downloadUrl}?token=${getToken()}`} download
                              className="text-indigo-500 hover:underline">Docker 包</a>
                          </>
                        )}
                        {a.enrollToken && winBuildProgress?.phase === 'done' && (
                          <>
                            <span className="text-gray-400">|</span>
                            <a href={`${MAIN_URL}/api/coworkers/app/win/download?token=${a.enrollToken}`} download
                              className="text-emerald-600 hover:underline">Windows 安装器</a>
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-gray-400">暂未分配员工</p>
              )}
              {users.length > 0 && (
                <div className="mt-3 border-t border-gray-100 pt-3">
                  <p className="text-xs text-gray-500 mb-1.5">选择员工分配：</p>
                  {users
                    .filter(u => !assignments.some(a => a.userId === u.id))
                    .map(u => (
                      <button key={u.id} onClick={() => assign(u.id)}
                        className="block w-full text-left px-2.5 py-1.5 text-sm hover:bg-indigo-50 rounded-lg transition-colors text-gray-700">
                        {u.name} ({u.email})
                      </button>
                    ))}
                  <button onClick={() => setUsers([])} className="text-xs text-gray-400 mt-1.5 hover:text-gray-600">关闭</button>
                </div>
              )}
            </div>

            {/* Config YAML */}
            {configYaml && (
              <div className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="text-sm font-medium text-gray-500">OpenClaw 配置预览</h3>
                  <button onClick={() => setConfigYaml('')} className="text-xs text-gray-400 hover:text-gray-600">关闭</button>
                </div>
                <pre className="text-xs bg-gray-900 text-green-300 p-3 rounded-lg overflow-auto max-h-60 font-mono">{configYaml}</pre>
              </div>
            )}

            {/* Analytics */}
            <CoWorkerAnalytics coworkerId={selected.id} />
          </div>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-400 text-sm">
            选择一个 CoWorker 查看详情，或创建新的
          </div>
        )}
      </div>
    </div>
  );
}

export default function CoWorkerPanel() {
  const perms = getUserPerms();
  const isAdmin = perms.includes('cw:manage') || perms.includes('cw:build') || perms.includes('sys:admin');
  if (!isAdmin) return <MyCoWorkerView />;
  return <CoWorkerPanelAdmin />;
}

// ===== Sub-components =====

function ProgressBar({ percent, message }: { percent: number; message?: string }) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between text-xs text-gray-600 mb-1">
        <span>{message || '处理中...'}</span>
        <span>{percent}%</span>
      </div>
      <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
        <div className="h-full bg-indigo-500 transition-all duration-300" style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function InfoCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-800 mt-0.5">{value}</div>
    </div>
  );
}

function CoWorkerEditor({
  data, onChange, onSave, onCancel,
}: {
  data: Partial<CoWorkerItem>;
  onChange: (d: Partial<CoWorkerItem>) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const set = (key: string, val: any) => onChange({ ...data, [key]: val });
  const inputClass = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm outline-none focus:border-indigo-400 focus:ring-1 focus:ring-indigo-100';

  return (
    <div className="p-5 space-y-4 max-w-2xl">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-gray-900">{data.id ? '编辑 CoWorker' : '新建 CoWorker'}</h2>
        <div className="flex gap-2">
          <button onClick={onCancel} className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600">取消</button>
          <button onClick={onSave} className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700">保存</button>
        </div>
      </div>

      <Field label="名称 *">
        <input value={data.name || ''} onChange={e => set('name', e.target.value)} className={inputClass} placeholder="如：销售助手、客服专员" />
      </Field>
      <Field label="描述">
        <input value={data.description || ''} onChange={e => set('description', e.target.value)} className={inputClass} placeholder="CoWorker 的职责说明" />
      </Field>
      <Field label="人格设定 (Soul)">
        <textarea value={data.soul || ''} onChange={e => set('soul', e.target.value)} className={`${inputClass} h-32 resize-y`} placeholder="定义角色、性格、沟通风格..." />
      </Field>
      <Field label="工作范围">
        <textarea value={data.workScope || ''} onChange={e => set('workScope', e.target.value)} className={`${inputClass} h-24 resize-y`} placeholder="描述工作内容、职责边界..." />
      </Field>
      <Field label="模型级别">
        <select value={data.modelLevel || 'default'} onChange={e => set('modelLevel', e.target.value)} className={inputClass}>
          <option value="default">默认</option>
          <option value="summary">摘要（轻量）</option>
          <option value="coding">编程（强推理）</option>
          <option value="reasoning">推理（复杂任务）</option>
        </select>
      </Field>
      <CapabilityAuthorization capabilities={data.capabilities} onChange={cap => set('capabilities', cap)} />
    </div>
  );
}

interface OpenClawStatus {
  installed: boolean;
  version: string | null;
  pinned: string;
  latest: string | null;
  compatible: boolean;
  bridgeInjected: boolean;
  hasPrev: boolean;
  progress: { running: boolean; phase: string; message?: string; error?: string; version?: string; downloadedBytes?: number; totalBytes?: number };
}

// Admin card: manage the OpenClaw source (download / upgrade / rollback). 见智 uses it as build
// material only — the runtime lives on users' machines.
function OpenClawSourceCard() {
  const [status, setStatus] = useState<OpenClawStatus | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${MAIN_URL}/api/coworkers/openclaw/status`, { headers: authHeaders() });
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll progress while an install is running.
  useEffect(() => {
    if (!status?.progress?.running) return;
    const t = setInterval(refresh, 2000);
    return () => clearInterval(t);
  }, [status?.progress?.running, refresh]);

  const install = async (version?: string) => {
    setBusy(true);
    try {
      await fetch(`${MAIN_URL}/api/coworkers/openclaw/install`, {
        method: 'POST', headers: authHeaders(), body: JSON.stringify({ version: version || undefined }),
      });
      await refresh();
    } finally { setBusy(false); }
  };

  const rollback = async () => {
    if (!(await confirmDialog('回滚到上一版本 OpenClaw？', { danger: true }))) return;
    setBusy(true);
    try {
      await fetch(`${MAIN_URL}/api/coworkers/openclaw/rollback`, { method: 'POST', headers: authHeaders() });
      await refresh();
    } finally { setBusy(false); }
  };

  if (!status) return null;
  const p = status.progress;
  const running = p?.running;

  return (
    <div className="border-t border-gray-100 p-3 text-xs bg-gray-50/60">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-gray-700">OpenClaw 源</span>
        <span className="text-gray-400">构建素材</span>
      </div>

      <div className="space-y-0.5 text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${status.installed ? (status.compatible ? 'bg-green-400' : 'bg-amber-400') : 'bg-gray-300'}`} />
          <span>{status.installed ? `已安装 ${status.version}` : '未安装'}</span>
          {status.installed && !status.compatible && <span className="text-amber-600">· 自检未过</span>}
        </div>
        {status.installed && !status.bridgeInjected && (
          <div className="text-amber-600">⚠ jianzhi-bridge 未注入</div>
        )}
        {status.latest && status.latest !== status.version && (
          <div className="text-indigo-600">可升级至 {status.latest}</div>
        )}
      </div>

      {running && (
        <div className="mt-2">
          {p.downloadedBytes !== undefined && p.totalBytes !== undefined && p.totalBytes > 0 ? (
            <ProgressBar
              percent={Math.round((p.downloadedBytes / p.totalBytes) * 100)}
              message={p.message || `${p.phase}中...`}
            />
          ) : (
            <div className="text-indigo-600">
              {p.phase} · {p.message || '处理中'}…
            </div>
          )}
        </div>
      )}
      {!running && p?.phase === 'error' && (
        <div className="mt-2 text-red-600 break-all">安装失败：{p.error}</div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        <button disabled={busy || running} onClick={() => install(status.latest || undefined)}
          className="px-2 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
          {status.installed ? '升级' : '下载安装'}
        </button>
        {status.hasPrev && (
          <button disabled={busy || running} onClick={rollback}
            className="px-2 py-1 border border-gray-300 text-gray-600 rounded-md hover:bg-gray-100 disabled:opacity-50">
            回滚
          </button>
        )}
        <button disabled={busy || running} onClick={refresh}
          className="px-2 py-1 border border-gray-300 text-gray-500 rounded-md hover:bg-gray-100 disabled:opacity-50">
          刷新
        </button>
      </div>
    </div>
  );
}

function WindowsAppCard() {
  const [status, setStatus] = useState<{ available: boolean; version?: string; size?: number } | null>(null);
  const [stats, setStats] = useState<{ total: number; uniqueUsers: number; byDay: Record<string, number> } | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState<{ running: boolean; phase: string; message?: string; version?: string; downloadedBytes?: number; totalBytes?: number; error?: string } | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch(`${MAIN_URL}/api/coworkers/app/win/status`, { headers: authHeaders() });
      if (r.ok) setStatus(await r.json());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  // Poll download progress while downloading
  useEffect(() => {
    if (!downloading) return;
    const t = setInterval(async () => {
      try {
        const r = await fetch(`${MAIN_URL}/api/coworkers/app/win/install/progress`, { headers: authHeaders() });
        if (r.ok) {
          const progress = await r.json();
          setDownloadProgress(progress);

          if (!progress.running || progress.phase === 'done' || progress.phase === 'error') {
            setDownloading(false);
            if (progress.phase === 'done') {
              await refresh(); // Refresh status after successful download
            }
          }
        }
      } catch { /* ignore */ }
    }, 2000);
    return () => clearInterval(t);
  }, [downloading]);

  const loadStats = async () => {
    try {
      const r = await fetch(`${MAIN_URL}/api/coworkers/app/win/stats?days=30`, { headers: authHeaders() });
      if (r.ok) setStats(await r.json());
    } catch { /* ignore */ }
  };

  useEffect(() => {
    if (showStats) loadStats();
  }, [showStats]);

  const upload = async () => {
    const fileInput = document.createElement('input');
    fileInput.type = 'file';
    fileInput.accept = '.exe';
    fileInput.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;

      setUploading(true);
      try {
        const formData = new FormData();
        formData.append('file', file);

        const r = await fetch(`${MAIN_URL}/api/coworkers/app/win/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${getToken()}` },
          body: formData,
        });

        if (r.ok) {
          const d = await r.json();
          alertSuccess(`上传成功 v${d.version}`);
          await refresh();
        } else {
          const d = await r.json().catch(() => ({}));
          alertError(`上传失败: ${d.message || r.status}`);
        }
      } finally {
        setUploading(false);
      }
    };
    fileInput.click();
  };

  const download = async () => {
    setDownloading(true);
    setDownloadProgress(null);
    try {
      const r = await fetch(`${MAIN_URL}/api/coworkers/app/win/install`, {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ version: undefined }),
      });
      const data = await r.json();
      if (!data.started) {
        setDownloading(false);
        alertError(`下载启动失败: ${data.reason || '未知原因'}`);
      }
    } catch (err) {
      setDownloading(false);
      alertError(`请求失败: ${err instanceof Error ? err.message : '网络错误'}`);
    }
  };

  if (!status) return null;

  return (
    <div className="border-t border-gray-100 p-3 text-xs bg-gray-50/60">
      <div className="flex items-center justify-between mb-1.5">
        <span className="font-medium text-gray-700">Windows 客户端</span>
        <span className="text-gray-400">安装器分发</span>
      </div>

      <div className="space-y-0.5 text-gray-600">
        <div className="flex items-center gap-1.5">
          <span className={`w-1.5 h-1.5 rounded-full ${status.available ? 'bg-green-400' : 'bg-gray-300'}`} />
          <span>{status.available ? `已就绪 v${status.version}` : '未上传'}</span>
          {status.available && status.size && (
            <span className="text-gray-400">· {(status.size / 1024 / 1024).toFixed(1)} MB</span>
          )}
        </div>
      </div>

      {showStats && stats && (
        <div className="mt-2 p-2 bg-white rounded border border-gray-200">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="text-gray-400">总下载</div>
              <div className="font-medium text-gray-800">{stats.total} 次</div>
            </div>
            <div>
              <div className="text-gray-400">独立用户</div>
              <div className="font-medium text-gray-800">{stats.uniqueUsers} 人</div>
            </div>
          </div>
        </div>
      )}

      {/* Download Progress */}
      {downloadProgress?.running && downloadProgress.downloadedBytes !== undefined && downloadProgress.totalBytes !== undefined && downloadProgress.totalBytes > 0 && (
        <ProgressBar
          percent={Math.round((downloadProgress.downloadedBytes / downloadProgress.totalBytes) * 100)}
          message={downloadProgress.message || `${downloadProgress.phase}中...`}
        />
      )}
      {downloadProgress?.running && (downloadProgress.downloadedBytes === undefined || downloadProgress.totalBytes === undefined || downloadProgress.totalBytes <= 0) && (
        <div className="mt-2 text-indigo-600">
          {downloadProgress.phase} · {downloadProgress.message || '处理中'}…
        </div>
      )}
      {!downloading && downloadProgress?.phase === 'done' && (
        <div className="mt-2 text-emerald-600">
          ✓ {downloadProgress.message || '下载完成'}
        </div>
      )}
      {!downloading && downloadProgress?.phase === 'error' && (
        <div className="mt-2 text-red-600 break-all">
          下载失败：{downloadProgress.error}
        </div>
      )}

      <div className="flex flex-wrap gap-1.5 mt-2">
        {status.available && (
          <a href={`${MAIN_URL}/api/coworkers/app/win?token=${getToken()}`} download
            className="px-2 py-1 bg-blue-600 text-white rounded-md hover:bg-blue-700">
            下载
          </a>
        )}
        <button disabled={downloading || uploading} onClick={download}
          className="px-2 py-1 bg-indigo-600 text-white rounded-md hover:bg-indigo-700 disabled:opacity-50">
          {downloading ? '下载中...' : '下载新版本'}
        </button>
        <button disabled={uploading} onClick={upload}
          className="px-2 py-1 border border-gray-300 text-gray-600 rounded-md hover:bg-gray-100 disabled:opacity-50">
          {uploading ? '上传中...' : '上传新版本'}
        </button>
        <button onClick={() => setShowStats(!showStats)}
          className="px-2 py-1 border border-gray-300 text-gray-500 rounded-md hover:bg-gray-100">
          {showStats ? '隐藏统计' : '下载统计'}
        </button>
        <button onClick={refresh}
          className="px-2 py-1 border border-gray-300 text-gray-500 rounded-md hover:bg-gray-100">
          刷新
        </button>
      </div>
    </div>
  );
}

function CapabilityAuthorization({
  capabilities, onChange,
}: {
  capabilities?: CoWorkerCapabilities;
  onChange: (cap: CoWorkerCapabilities) => void;
}) {
  const [catalog, setCatalog] = useState<{
    builtin: Array<{ section: string; tools: Array<{ id: string; label: string; description: string }> }>;
    mcp: Array<{ serverId: string; serverName: string; source?: 'kb' | 'host' | 'registry'; description: string; tools: Array<{ name: string; description: string }> }>;
    skills: Array<{ name: string; description: string; metadata?: Record<string, string>; hasHandler?: boolean }>;
  } | null>(null);
  const [tab, setTab] = useState<'builtin' | 'mcp' | 'skills'>('builtin');

  useEffect(() => {
    fetch(`${MAIN_URL}/api/coworkers/capability-catalog`, { headers: authHeaders() })
      .then(r => r.ok ? r.json() : null)
      .then(setCatalog)
      .catch(() => {});
  }, []);

  const cap: CoWorkerCapabilities = capabilities || { builtin: [], mcp: [], skills: [] };

  const toggleBuiltin = (id: string) => {
    const next = cap.builtin.includes(id) ? cap.builtin.filter(x => x !== id) : [...cap.builtin, id];
    onChange({ ...cap, builtin: next });
  };
  const selectBuiltinSection = (section: string, all: boolean) => {
    const ids = catalog?.builtin.find(s => s.section === section)?.tools.map(t => t.id) || [];
    onChange({ ...cap, builtin: all ? [...new Set([...cap.builtin, ...ids])] : cap.builtin.filter(x => !ids.includes(x)) });
  };
  const clearBuiltin = () => onChange({ ...cap, builtin: [] });

  const toggleMcpServer = (serverId: string) => {
    const exists = cap.mcp.find(m => m.serverId === serverId);
    if (exists) {
      onChange({ ...cap, mcp: cap.mcp.filter(m => m.serverId !== serverId) });
    } else {
      const server = catalog?.mcp.find(s => s.serverId === serverId);
      onChange({ ...cap, mcp: [...cap.mcp, { serverId, serverName: server?.serverName, tools: [] }] });
    }
  };
  const toggleMcpTool = (serverId: string, toolName: string) => {
    const next = cap.mcp.map(m => {
      if (m.serverId !== serverId) return m;
      // tools 为空数组表示「该 server 全部工具」（与服务端派生语义一致）。
      // 此时反勾选某工具需展开为 all-minus-one，而非从空列表追加单条（会把选中集反转成仅此一条）。
      if (m.tools.length === 0) {
        const allNames = catalog?.mcp.find(s => s.serverId === serverId)?.tools.map(t => t.name) || [];
        return { ...m, tools: allNames.filter(t => t !== toolName) };
      }
      const has = m.tools.includes(toolName);
      return { ...m, tools: has ? m.tools.filter(t => t !== toolName) : [...m.tools, toolName] };
    });
    onChange({ ...cap, mcp: next });
  };
  const setMcpServerTools = (serverId: string, all: boolean) => {
    if (!all) {
      // tools:[] 在派生语义中表示「全部工具」而非「无工具」。
      // 清空即移除整个 server 条目（等价于反勾选 server 级复选框）。
      onChange({ ...cap, mcp: cap.mcp.filter(m => m.serverId !== serverId) });
      return;
    }
    const server = catalog?.mcp.find(s => s.serverId === serverId);
    const names = server?.tools.map(t => t.name) || [];
    const exists = cap.mcp.find(m => m.serverId === serverId);
    if (!exists) {
      onChange({ ...cap, mcp: [...cap.mcp, { serverId, serverName: server?.serverName, tools: names }] });
      return;
    }
    onChange({ ...cap, mcp: cap.mcp.map(m => m.serverId === serverId ? { ...m, tools: names } : m) });
  };
  const selectAllMcp = () => onChange({
    ...cap,
    mcp: (catalog?.mcp || []).map(s => ({ serverId: s.serverId, serverName: s.serverName, tools: s.tools.map(t => t.name) })),
  });
  const clearMcp = () => onChange({ ...cap, mcp: [] });

  const toggleSkill = (name: string) => {
    const next = cap.skills.includes(name) ? cap.skills.filter(x => x !== name) : [...cap.skills, name];
    onChange({ ...cap, skills: next });
  };
  const clearSkills = () => onChange({ ...cap, skills: [] });

  const tabBtn = (active: boolean) =>
    `px-3 py-1.5 text-xs rounded-lg transition-colors ${active ? 'bg-indigo-600 text-white' : 'text-gray-600 hover:bg-gray-100'}`;

  const total = cap.builtin.length + cap.mcp.length + cap.skills.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-gray-700">能力授权</label>
        {total === 0
          ? <span className="text-xs text-amber-600">未勾选任何能力 → 将使用默认安全工具集</span>
          : <span className="text-xs text-gray-400">{total} 项已授权</span>}
      </div>
      <p className="text-xs text-gray-400 mb-2">分三类授权：内置工具、MCP 服务（含子工具）、技能</p>

      <div className="flex items-center gap-1 mb-2 border-b border-gray-200">
        <button type="button" onClick={() => setTab('builtin')} className={tabBtn(tab === 'builtin')}>
          内置工具 <span className="opacity-70">({cap.builtin.length})</span>
        </button>
        <button type="button" onClick={() => setTab('mcp')} className={tabBtn(tab === 'mcp')}>
          MCP 服务 <span className="opacity-70">({cap.mcp.length})</span>
        </button>
        <button type="button" onClick={() => setTab('skills')} className={tabBtn(tab === 'skills')}>
          技能 <span className="opacity-70">({cap.skills.length})</span>
        </button>
      </div>

      {!catalog && (
        <div className="text-xs text-gray-400 text-center py-4 border border-gray-200 rounded-lg">
          加载能力目录中...
        </div>
      )}

      {catalog && tab === 'builtin' && (
        <div className="border border-gray-200 rounded-lg p-2.5 max-h-72 overflow-auto space-y-2">
          <div className="flex justify-end gap-2 text-xs pb-1">
            <button type="button" onClick={() => onChange({ ...cap, builtin: catalog.builtin.flatMap(s => s.tools.map(t => t.id)) })} className="text-indigo-600 hover:underline">全选</button>
            <button type="button" onClick={clearBuiltin} className="text-gray-500 hover:underline">清空</button>
          </div>
          {catalog.builtin.map(section => {
            const ids = section.tools.map(t => t.id);
            const allChecked = ids.every(id => cap.builtin.includes(id));
            return (
              <div key={section.section}>
                <div className="flex items-center gap-1.5 cursor-pointer text-xs font-medium text-gray-600 hover:text-gray-800 py-0.5"
                  onClick={() => selectBuiltinSection(section.section, !allChecked)}>
                  <input type="checkbox" checked={allChecked} readOnly className="rounded border-gray-300 text-indigo-600" />
                  <span>{section.section}</span>
                  <span className="text-gray-400 font-normal">({section.tools.length})</span>
                </div>
                <div className="ml-4 grid grid-cols-2 gap-x-4">
                  {section.tools.map(tool => (
                    <label key={tool.id} className="flex items-center gap-1.5 py-0.5 text-xs cursor-pointer hover:bg-gray-50 rounded px-1">
                      <input type="checkbox" checked={cap.builtin.includes(tool.id)} onChange={() => toggleBuiltin(tool.id)} className="rounded border-gray-300 text-indigo-600" />
                      <span className="truncate text-gray-700" title={tool.description}>{tool.label}</span>
                    </label>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {catalog && tab === 'mcp' && (
        <div className="border border-gray-200 rounded-lg p-2.5 max-h-72 overflow-auto space-y-2">
          <div className="flex justify-end gap-2 text-xs pb-1">
            <button type="button" onClick={selectAllMcp} className="text-indigo-600 hover:underline">全选</button>
            <button type="button" onClick={clearMcp} className="text-gray-500 hover:underline">清空</button>
          </div>
          {catalog.mcp.length === 0 && <div className="text-xs text-gray-400 text-center py-2">无已启用的 MCP 服务</div>}
          {[...catalog.mcp].sort((a, b) => {
            const order = { host: 0, registry: 1, kb: 2 };
            return (order[a.source || 'kb'] ?? 2) - (order[b.source || 'kb'] ?? 2);
          }).map(server => {
            const serverEntry = cap.mcp.find(m => m.serverId === server.serverId);
            const enabled = !!serverEntry;
            return (
              <div key={server.serverId} className="border border-gray-100 rounded-lg p-2">
                <div className="flex items-center gap-2">
                  <input type="checkbox" checked={enabled} onChange={() => toggleMcpServer(server.serverId)} className="rounded border-gray-300 text-indigo-600" />
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-gray-700 truncate">
                      {server.serverName}
                      {server.source === 'host' && <span className="text-indigo-500 ml-1">[主台]</span>}
                      {server.source === 'registry' && <span className="text-emerald-600 ml-1">[连接]</span>}
                      {server.source === 'kb' && <span className="text-amber-600 ml-1">[知识库]</span>}
                      <span className="text-gray-400 font-normal"> ({server.serverId})</span>
                    </div>
                    <div className="text-[11px] text-gray-400 truncate">{server.description}</div>
                  </div>
                  {enabled && server.tools.length > 0 && (
                    <div className="flex gap-1.5 text-[11px]">
                      <button type="button" onClick={() => setMcpServerTools(server.serverId, true)} className="text-indigo-600 hover:underline">全选</button>
                      <button type="button" onClick={() => setMcpServerTools(server.serverId, false)} className="text-gray-500 hover:underline">清空</button>
                    </div>
                  )}
                  <span className="text-[11px] text-gray-400">{server.tools.length} 工具</span>
                </div>
                {enabled && server.tools.length > 0 && (
                  <div className="ml-5 mt-1.5 grid grid-cols-2 gap-x-4">
                    {server.tools.map(t => {
                      // tools 为空数组表示「该 server 全部工具」，与服务端派生语义一致。
                      const checked = !serverEntry || serverEntry.tools.length === 0 || serverEntry.tools.includes(t.name);
                      return (
                        <label key={t.name} className="flex items-center gap-1.5 py-0.5 text-[11px] cursor-pointer hover:bg-gray-50 rounded px-1">
                          <input type="checkbox" checked={checked} onChange={() => toggleMcpTool(server.serverId, t.name)} className="rounded border-gray-300 text-indigo-600" />
                          <span className="truncate text-gray-700" title={t.description}>{t.name}</span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {catalog && tab === 'skills' && (
        <div className="border border-gray-200 rounded-lg p-2.5 max-h-72 overflow-auto space-y-1">
          <div className="flex justify-end gap-2 text-xs pb-1">
            <button type="button" onClick={() => onChange({ ...cap, skills: catalog.skills.map(s => s.name) })} className="text-indigo-600 hover:underline">全选</button>
            <button type="button" onClick={clearSkills} className="text-gray-500 hover:underline">清空</button>
          </div>
          {catalog.skills.length === 0 && <div className="text-xs text-gray-400 text-center py-2">无可用技能</div>}
          {catalog.skills.map(s => (
            <label key={s.name} className="flex items-start gap-2 py-1 px-1 rounded hover:bg-gray-50 cursor-pointer">
              <input type="checkbox" checked={cap.skills.includes(s.name)} onChange={() => toggleSkill(s.name)} className="rounded border-gray-300 text-indigo-600 mt-0.5" />
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-700 flex items-center gap-1.5">
                  {s.name}
                  {s.hasHandler && <span className="text-[10px] px-1 py-0.5 rounded bg-indigo-50 text-indigo-600">handler</span>}
                  {s.metadata?.system && <span className="text-[10px] px-1 py-0.5 rounded bg-gray-100 text-gray-500">{s.metadata.system}</span>}
                </div>
                <div className="text-[11px] text-gray-400 truncate">{s.description}</div>
              </div>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="text-sm font-medium text-gray-700 mb-1 block">{label}</label>
      {children}
    </div>
  );
}

// ===== Analytics =====

function CoWorkerAnalytics({ coworkerId }: { coworkerId: string }) {
  const [stats, setStats] = useState<any>(null);
  const [messages, setMessages] = useState<any[]>([]);
  const [showMessages, setShowMessages] = useState(false);

  useEffect(() => {
    fetch(`${MAIN_URL}/api/coworkers/${coworkerId}/analytics`, { headers: authHeaders() })
      .then(r => r.json()).then(setStats).catch(() => {});
  }, [coworkerId]);

  const loadMessages = async () => {
    const res = await fetch(`${MAIN_URL}/api/coworkers/${coworkerId}/messages?limit=20`, { headers: authHeaders() });
    if (res.ok) setMessages(await res.json());
    setShowMessages(true);
  };

  if (!stats) return null;

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-gray-500">使用统计（近30天）</h3>
        <button onClick={loadMessages} className="text-xs text-indigo-600 hover:underline">
          {showMessages ? '刷新消息' : '查看消息'}
        </button>
      </div>
      <div className="grid grid-cols-4 gap-2">
        <StatBox label="总消息" value={stats.totalMessages} />
        <StatBox label="接收" value={stats.inboundMessages} />
        <StatBox label="发送" value={stats.outboundMessages} />
        <StatBox label="工具调用" value={stats.toolCalls} />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <StatBox label="Token 用量" value={stats.llmUsage?.tokens?.toLocaleString() || '0'} />
        <StatBox label="LLM 费用" value={`¥${(stats.llmUsage?.cost || 0).toFixed(2)}`} />
        <StatBox label="最后活跃" value={stats.lastActive ? new Date(stats.lastActive).toLocaleString('zh-CN') : '从未'} />
      </div>
      {showMessages && messages.length > 0 && (
        <div className="border-t border-gray-100 pt-2 max-h-60 overflow-auto">
          <p className="text-xs text-gray-500 mb-1">最近消息：</p>
          {messages.map((m: any, i: number) => (
            <div key={m.id || i} className="flex gap-2 py-1 text-xs border-b border-gray-50 last:border-0">
              <span className={`flex-shrink-0 px-1.5 rounded ${m.direction === 'in' ? 'bg-indigo-50 text-indigo-700' : 'bg-green-50 text-green-700'}`}>
                {m.direction === 'in' ? '收' : '发'}
              </span>
              <span className="text-gray-400 flex-shrink-0">{m.channel}</span>
              <span className="text-gray-700 truncate">{m.content?.slice(0, 80)}</span>
              <span className="text-gray-400 flex-shrink-0 ml-auto">{new Date(m.created_at).toLocaleTimeString('zh-CN')}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function StatBox({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="bg-gray-50 rounded-lg p-2.5 text-center">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-sm font-medium text-gray-800 mt-0.5">{value}</div>
    </div>
  );
}

// ===== Employee View =====

function MyCoWorkerView() {
  const [myList, setMyList] = useState<MyCoWorkerItem[]>([]);
  const [selected, setSelected] = useState<MyCoWorkerItem | null>(null);
  const [showInstall, setShowInstall] = useState(false);

  useEffect(() => {
    fetch(`${MAIN_URL}/api/my/coworkers`, { headers: authHeaders() })
      .then(r => r.json())
      .then(data => setMyList(Array.isArray(data) ? data : []))
      .catch(() => {});
  }, []);

  const isOnline = (item: MyCoWorkerItem) => {
    if (!item.lastSeen) return false;
    return Date.now() - new Date(item.lastSeen).getTime() < 90000;
  };

  return (
    <div className="h-full flex flex-col bg-gray-50">
      <div className="p-4 border-b border-gray-200 bg-white">
        <h2 className="text-lg font-semibold text-gray-900">我的 CoWorker</h2>
        <p className="text-sm text-gray-500 mt-1">管理员为你分配的 AI 数字员工</p>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {myList.length === 0 ? (
          <div className="text-center text-gray-400 mt-12">
            <p className="text-lg mb-2">暂无 CoWorker</p>
            <p className="text-sm">请联系管理员为你分配 AI 数字员工</p>
          </div>
        ) : (
          <div className="grid gap-4 max-w-3xl">
            {myList.map(item => (
              <div key={item.id} className="bg-white border border-gray-200 rounded-xl p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-400 to-purple-500 flex items-center justify-center text-white font-bold shrink-0">
                      {item.coworker.name.charAt(0)}
                    </div>
                    <div>
                      <h3 className="font-medium text-gray-900">{item.coworker.name}</h3>
                      <p className="text-sm text-gray-500">{item.coworker.description || '无描述'}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`flex items-center gap-1 text-xs px-2 py-1 rounded-full ${isOnline(item) ? 'bg-green-50 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${isOnline(item) ? 'bg-green-400' : 'bg-gray-300'}`} />
                      {isOnline(item) ? '在线' : '离线'}
                    </span>
                    <span className="text-xs text-gray-400">v{item.configVersion}</span>
                  </div>
                </div>

                <div className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div className="bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-500">模型</span>
                    <div className="font-medium text-gray-800 mt-0.5">{item.coworker.modelLevel}</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-500">工具</span>
                    <div className="font-medium text-gray-800 mt-0.5">{item.coworker.tools?.length || 0} 个</div>
                  </div>
                  <div className="bg-gray-50 rounded-lg p-2.5">
                    <span className="text-gray-500">技能</span>
                    <div className="font-medium text-gray-800 mt-0.5">{item.coworker.skills?.length || 0} 个</div>
                  </div>
                </div>

                {item.coworker.workScope && (
                  <div className="mt-3 text-sm text-gray-600 bg-indigo-50 border border-indigo-100 rounded-lg p-2.5">
                    <span className="text-xs text-indigo-600 font-medium">工作范围: </span>
                    {item.coworker.workScope.slice(0, 200)}
                  </div>
                )}

                <div className="mt-3 flex flex-wrap gap-2">
                  {item.downloadLinks ? (
                    <>
                      <a href={`${MAIN_URL}${item.downloadLinks.installer.windows}`} download
                        className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors inline-flex items-center gap-1">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                        Windows 安装包
                      </a>
                      <a href={`${MAIN_URL}${item.downloadLinks.config}`}
                        className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600 transition-colors inline-flex items-center gap-1">
                        配置文件
                      </a>
                      <a href={`${MAIN_URL}${item.downloadLinks.guide}`}
                        className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600 transition-colors inline-flex items-center gap-1">
                        使用指南
                      </a>
                    </>
                  ) : (
                    <a href={`${MAIN_URL}/api/coworkers/app/win?token=${getToken()}`} download
                      className="px-3 py-1.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors inline-flex items-center gap-1">
                      <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9.75 17L9 20l-1 1h8l-1-1-.75-3M3 13h18M5 17h14a2 2 0 002-2V5a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
                      下载 Windows 客户端
                    </a>
                  )}
                  <button onClick={() => { setSelected(item); setShowInstall(!showInstall || selected?.id !== item.id); }}
                    className="px-3 py-1.5 text-sm border border-gray-200 rounded-lg hover:bg-white text-gray-600 transition-colors">
                    {showInstall && selected?.id === item.id ? '收起' : '安装说明'}
                  </button>
                </div>

                {showInstall && selected?.id === item.id && (
                  <div className="mt-3 border-t border-gray-100 pt-3">
                    <h4 className="text-sm font-medium text-gray-800 mb-3">安装步骤</h4>
                    <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
                      <div className="space-y-1 text-xs text-gray-700">
                        <Step n={1} text="下载并运行 Windows 客户端安装器" />
                        <Step n={2} text="启动后输入激活码或点击激活链接" />
                        <Step n={3} text="扫码绑定微信（可选）" />
                        <Step n={4} text="开始使用" />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Step({ n, text }: { n: number; text: string }) {
  return (
    <div className="flex items-start gap-2">
      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-indigo-100 text-indigo-700 text-xs flex items-center justify-center font-medium">{n}</span>
      <span className="text-gray-700">{text}</span>
    </div>
  );
}
