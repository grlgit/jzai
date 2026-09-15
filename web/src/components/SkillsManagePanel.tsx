'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useI18n } from '@/i18n';
import dynamic from 'next/dynamic';
import { useAuth } from '@/hooks/useAuth';
import { confirmDialog } from '@/components/AppDialog';
import CredentialForm from './CredentialForm';
import type { ChatMessage } from '@/hooks/useChat';

const MonacoEditor = dynamic(() => import('@monaco-editor/react'), { ssr: false });
const MarkdownWysiwyg = dynamic(() => import('@/components/MarkdownWysiwyg'), { ssr: false });

import { getMainUrl } from '@/lib/env';
const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

interface SkillsManagePanelProps {
  messages?: ChatMessage[];
  onOpenSession?: (connectorName: string, sessionId: string, agentType: string) => void;
}

export default function SkillsManagePanel({ messages = [], onOpenSession }: SkillsManagePanelProps = {}) {
  const { t } = useI18n();
  const { user } = useAuth();
  const [skills, setSkills] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<any>(null);
  const [credentials, setCredentials] = useState<Record<string, Record<string, string>>>({});
  const [detailTab, setDetailTab] = useState<'overview' | 'scripts' | 'references' | 'assets' | 'credentials'>('overview');
  const [editingInstructions, setEditingInstructions] = useState<false | 'body' | 'source'>(false);
  const [instructionsDraft, setInstructionsDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [sideWidth, setSideWidth] = useState(288);
  const draggingRef = useRef(false);

  const userId = user?.id || '';

  const load = useCallback(async () => {
    const data = await fetch(`${MAIN_URL}/api/skills`, { headers: authHeaders() }).then(r => r.json()).catch(() => []);
    setSkills(Array.isArray(data) ? data : []);
  }, []);

  const loadCredentials = useCallback(async () => {
    if (!userId) return;
    const data = await fetch(`${MAIN_URL}/api/skills/credentials/list?userId=${userId}`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({}));
    if (data && !data.error) setCredentials(data);
  }, [userId]);

  useEffect(() => { load(); loadCredentials(); }, [load, loadCredentials]);

  // Auto-reload when skill_master creates something
  const toolCallCount = (messages || []).reduce((n, m) => n + (m.toolCalls?.length || 0), 0);
  useEffect(() => { if (toolCallCount > 0) load(); }, [toolCallCount, load]);

  // Build progress tracking
  const toolCalls = (messages || []).flatMap(m => (m.toolCalls || []).map(tc => ({ name: tc.name, result: tc.result })));
  const isBuilding = toolCalls.length > 0;
  const writtenFiles = toolCalls.filter(tc => tc.name === 'write' && tc.result).length;
  const reloaded = toolCalls.some(tc => tc.name === 'reload_skills');
  const testResults = toolCalls.filter(tc => tc.name === 'test_skill' && tc.result);
  const buildSteps = [
    { label: '分析需求', done: toolCalls.length > 0, active: toolCalls.length > 0 && writtenFiles === 0 },
    { label: '创建文件', done: writtenFiles > 0, active: false },
    { label: '注册技能', done: reloaded, active: writtenFiles > 0 && !reloaded },
    { label: '测试验证', done: testResults.length > 0, active: reloaded && testResults.length === 0 },
  ];

  const loadDetail = async (name: string) => {
    const data = await fetch(`${MAIN_URL}/api/skills/${name}`, { headers: authHeaders() }).then(r => r.json());
    setSelected(name);
    setDetail(data);
    setDetailTab('overview');
  };

  const handleDelete = async (name: string) => {
    if (!(await confirmDialog(`确认删除技能 "${name}"？`, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/skills/${name}`, { method: 'DELETE', headers: authHeaders() });
    setSelected(null); setDetail(null); load();
  };

  const chatEdit = async (name: string) => {
    if (!onOpenSession) return;
    try {
      const resp = await fetch(`${MAIN_URL}/api/sessions/by-skill/${name}`, { headers: authHeaders() }).then(r => r.json()).catch(() => ({ session: null }));
      if (resp.session) { onOpenSession(name, resp.session.id, resp.session.agentType); return; }
    } catch {}
    onOpenSession(name, '', 'skill_master');
  };

  const saveFile = async (skillName: string, dir: string, file: string, content: string) => {
    setSaving(true);
    await fetch(`${MAIN_URL}/api/skills/${skillName}/${dir}/${file}`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content }),
    });
    setSaving(false);
    setMsg('已保存');
    setTimeout(() => setMsg(''), 2000);
  };

  const saveSkillMd = async (skillName: string, content: string, mode: 'body' | 'source') => {
    setSaving(true);
    if (mode === 'source') {
      // Save entire SKILL.md (frontmatter + body)
      await fetch(`${MAIN_URL}/api/skills/${skillName}/skillmd`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content }),
      });
    } else {
      // Save instructions body only (preserves frontmatter)
      await fetch(`${MAIN_URL}/api/skills/${skillName}/instructions`, {
        method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content }),
      });
    }
    const data = await fetch(`${MAIN_URL}/api/skills/${skillName}`, { headers: authHeaders() }).then(r => r.json());
    setDetail(data);
    setSaving(false);
    setEditingInstructions(false);
    setMsg('已保存');
    setTimeout(() => setMsg(''), 2000);
    load();
  };

  const uploadFile = async (skillName: string, dir: string, file: File) => {
    const formData = new FormData();
    formData.append('file', file);
    const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
    await fetch(`${MAIN_URL}/api/skills/${skillName}/upload/${dir}`, {
      method: 'POST', headers: token ? { 'Authorization': `Bearer ${token}` } : {},
      body: formData,
    });
    // Reload detail to refresh file lists
    const data = await fetch(`${MAIN_URL}/api/skills/${skillName}`, { headers: authHeaders() }).then(r => r.json());
    setDetail(data);
    setMsg(`已上传 ${file.name}`);
    setTimeout(() => setMsg(''), 2000);
  };

  const deleteSkillFile = async (skillName: string, dir: string, file: string) => {
    if (!(await confirmDialog(`删除 ${dir}/${file}？`, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/skills/${skillName}/files/${dir}/${file}`, { method: 'DELETE', headers: authHeaders() });
    const data = await fetch(`${MAIN_URL}/api/skills/${skillName}`, { headers: authHeaders() }).then(r => r.json());
    setDetail(data);
  };

  const createNewFile = async (skillName: string, dir: string, fileName: string) => {
    await fetch(`${MAIN_URL}/api/skills/${skillName}/${dir}/${fileName}`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ content: '' }),
    });
    const data = await fetch(`${MAIN_URL}/api/skills/${skillName}`, { headers: authHeaders() }).then(r => r.json());
    setDetail(data);
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Left: skill list */}
      <div className="flex flex-col shrink-0 min-h-0" style={{ width: sideWidth }}>
        <div className="p-3 border-b border-gray-200 flex items-center justify-between">
          <span className="text-sm font-medium">{t('skills.title')}</span>
          <button onClick={async () => {
            await fetch(`${MAIN_URL}/api/skills/reload`, { method: 'POST', headers: authHeaders() });
            load();
            if (selected && detail) loadDetail(detail.name);
            setMsg('已重新加载');
            setTimeout(() => setMsg(''), 2000);
          }} className="text-[11px] px-2 py-0.5 text-gray-400 hover:text-indigo-600 border border-gray-200 rounded hover:border-indigo-300" title="重新加载所有技能">
            ⟳ 重载
          </button>
        </div>

        {/* Build progress */}
        {isBuilding && (
          <div className="p-3 border-b border-gray-200 bg-indigo-50/50">
            <div className="text-[11px] font-medium text-gray-500 mb-2">{t('skills.buildProgress')}</div>
            <div className="space-y-1.5">
              {buildSteps.map((step, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <div className={`w-3.5 h-3.5 rounded-full flex items-center justify-center text-[9px] shrink-0 ${
                    step.done ? 'bg-green-100 text-green-500' : step.active ? 'bg-indigo-100 text-indigo-500 animate-pulse' : 'bg-gray-100 text-gray-300'
                  }`}>{step.done ? '✓' : step.active ? '◉' : '○'}</div>
                  <span className={`text-[11px] ${step.done ? 'text-gray-700' : step.active ? 'text-indigo-600' : 'text-gray-400'}`}>{step.label}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-3">
          {skills.length === 0 ? (
            <div className="text-center text-gray-400 py-12">
              <div className="text-3xl mb-2">⚡</div>
              <div className="text-xs">{t('skills.empty')}</div>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              {skills.map((s: any) => (
                <button key={s.name} onClick={() => loadDetail(s.name)}
                  className={`text-left p-3 rounded-lg border transition-all hover:shadow-sm w-[130px] shrink-0 ${
                    selected === s.name
                      ? 'border-indigo-400 bg-indigo-50 shadow-sm'
                      : 'border-gray-200 bg-white hover:border-indigo-200'
                  }`}>
                  <div className="flex items-center gap-1.5 mb-1">
                    <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-emerald-50 text-emerald-600">Skill</span>
                    {s.hasHandler && <span className="text-[9px] px-1 py-0.5 rounded bg-blue-50 text-blue-500">⚙</span>}
                    {s.sourceApp && (
                      <span className="text-[9px] px-1 py-0.5 rounded font-medium bg-indigo-50 text-indigo-600 truncate max-w-[72px]" title={s.sourceApp.name}>
                        {s.sourceApp.name}
                      </span>
                    )}
                  </div>
                  <div className="text-xs font-medium text-gray-800 truncate">{s.name}</div>
                  <div className="text-[10px] text-gray-400 truncate mt-0.5">
                    {s.allowedTools?.length ? `${s.allowedTools.length} tools` : s.metadata?.system || '—'}
                  </div>
                </button>
              ))}
            </div>
          )}
          <SkillRecycleBin onRestore={load} />
        </div>
      </div>

      {/* Draggable divider */}
      <div
        onMouseDown={(e) => {
          e.preventDefault();
          draggingRef.current = true;
          const startX = e.clientX;
          const startW = sideWidth;
          const onMove = (ev: MouseEvent) => { if (draggingRef.current) setSideWidth(Math.max(200, Math.min(500, startW + ev.clientX - startX))); };
          const onUp = () => { draggingRef.current = false; document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); document.body.style.cursor = ''; document.body.style.userSelect = ''; };
          document.body.style.cursor = 'col-resize';
          document.body.style.userSelect = 'none';
          document.addEventListener('mousemove', onMove);
          document.addEventListener('mouseup', onUp);
        }}
        className="w-1 shrink-0 cursor-col-resize bg-gray-200 hover:bg-indigo-400 active:bg-indigo-500 transition-colors"
      />

      {/* Right: detail */}
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
        {detail ? (
          <>
            {/* Header */}
            <div className="flex items-center gap-3 px-5 py-3 border-b border-gray-200 shrink-0">
              <span className="text-[10px] px-1.5 py-0.5 rounded font-medium bg-emerald-50 text-emerald-600">Skill</span>
              <h3 className="text-base font-semibold">{detail.name}</h3>
              {detail.metadata?.version && <span className="text-[10px] text-gray-400">v{detail.metadata.version}</span>}
              <div className="flex-1" />
              <button onClick={() => chatEdit(detail.name)}
                className="text-xs px-3 py-1 border border-indigo-200 text-indigo-600 rounded hover:bg-indigo-50 flex items-center gap-1">
                <img src="/icons/对话.svg" alt="" className="w-3.5 h-3.5" /> 对话
              </button>
              <button onClick={() => handleDelete(detail.name)} className="text-xs text-gray-400 hover:text-red-500">🗑️</button>
            </div>

            {/* Description + metadata */}
            <div className="px-5 py-2 bg-gray-50 border-b border-gray-200 shrink-0">
              <div className="text-xs text-gray-600">{detail.description}</div>
              <div className="flex flex-wrap gap-2 mt-1.5">
                {detail.metadata?.system && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{detail.metadata.system}</span>
                )}
                {detail.allowedTools?.map((t: string) => (
                  <span key={t} className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-500 font-mono">{t}</span>
                ))}
              </div>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-gray-200 shrink-0">
              {([
                ['overview', 'SKILL.md'],
                ['scripts', `脚本${detail.scripts?.length ? ` (${detail.scripts.length})` : ''}`],
                ['references', `参考${detail.references?.length ? ` (${detail.references.length})` : ''}`],
                ['assets', `资源${detail.assets?.length ? ` (${detail.assets.length})` : ''}`],
                ['credentials', '凭证'],
              ] as const).map(([key, label]) => (
                <button key={key} onClick={() => setDetailTab(key)}
                  className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${detailTab === key ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>
                  {label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div className="flex-1 overflow-hidden min-h-0">
              {detailTab === 'overview' ? (
                editingInstructions === 'body' ? (
                  <div className="h-full flex flex-col">
                    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 bg-gray-50 shrink-0">
                      <span className="text-xs text-gray-500 flex-1">SKILL.md — 内容编辑</span>
                      <button onClick={() => setEditingInstructions(false)} className="text-xs px-2 py-0.5 text-gray-400 hover:text-gray-600 border border-gray-200 rounded">取消</button>
                      <button onClick={() => saveSkillMd(detail.name, instructionsDraft, 'body')} disabled={saving}
                        className="text-xs px-3 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50">
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <MarkdownWysiwyg value={instructionsDraft} onChange={setInstructionsDraft} />
                    </div>
                  </div>
                ) : editingInstructions === 'source' ? (
                  <div className="h-full flex flex-col">
                    <div className="flex items-center gap-2 px-4 py-1.5 border-b border-gray-200 bg-gray-50 shrink-0">
                      <span className="text-xs text-gray-500 flex-1">SKILL.md — 源码编辑（含 frontmatter）</span>
                      <button onClick={() => setEditingInstructions(false)} className="text-xs px-2 py-0.5 text-gray-400 hover:text-gray-600 border border-gray-200 rounded">取消</button>
                      <button onClick={() => saveSkillMd(detail.name, instructionsDraft, 'source')} disabled={saving}
                        className="text-xs px-3 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50">
                        {saving ? '保存中...' : '保存'}
                      </button>
                    </div>
                    <div className="flex-1 min-h-0 overflow-hidden">
                      <MarkdownWysiwyg value={instructionsDraft} onChange={setInstructionsDraft} />
                    </div>
                  </div>
                ) : (
                  <div className="h-full flex flex-col">
                    <div className="flex items-center px-5 py-1.5 shrink-0">
                      <div className="flex-1" />
                      <button onClick={() => { setEditingInstructions('body'); setInstructionsDraft(detail.instructions || ''); }}
                        className="text-[11px] px-2 py-0.5 text-gray-400 hover:text-indigo-600 border border-gray-200 rounded hover:border-indigo-300">
                        ✏️ 编辑内容
                      </button>
                      <button onClick={() => { setEditingInstructions('source'); setInstructionsDraft(detail.rawSkillMd || ''); }}
                        className="text-[11px] px-2 py-0.5 ml-1 text-gray-400 hover:text-indigo-600 border border-gray-200 rounded hover:border-indigo-300">
                        { } 编辑源码
                      </button>
                    </div>
                    <div className="flex-1 overflow-y-auto px-5 pb-5">
                      <SkillMdPreview
                        content={detail.instructions || ''}
                        onNavigate={(dir, _file) => {
                          const tabMap: Record<string, 'references' | 'scripts' | 'assets'> = { references: 'references', scripts: 'scripts', assets: 'assets' };
                          const tab = tabMap[dir];
                          if (tab) setDetailTab(tab);
                        }}
                      />
                    </div>
                  </div>
                )
              ) : detailTab === 'scripts' ? (
                <FileTabPanel
                  skillName={detail.name} dir="scripts" files={detail.scripts || []}
                  emptyHint="点击 + 新建脚本"
                  onSaveFile={saveFile} onDeleteFile={deleteSkillFile}
                  onCreateFile={(name) => createNewFile(detail.name, 'scripts', name)}
                  createPlaceholder="文件名 (如 handler.ts)"
                  saving={saving} editorType="code" language="javascript"
                />
              ) : detailTab === 'references' ? (
                <FileTabPanel
                  skillName={detail.name} dir="references" files={detail.references || []}
                  emptyHint="上传或新建参考文档"
                  onSaveFile={saveFile} onDeleteFile={deleteSkillFile}
                  onUpload={(file) => uploadFile(detail.name, 'references', file)}
                  onCreateFile={(name) => createNewFile(detail.name, 'references', name)}
                  createPlaceholder="文件名 (如 fields.md)"
                  saving={saving} editorType="markdown"
                />
              ) : detailTab === 'assets' ? (
                <FileTabPanel
                  skillName={detail.name} dir="assets" files={detail.assets || []}
                  emptyHint="上传模板或样例数据"
                  onSaveFile={saveFile} onDeleteFile={deleteSkillFile}
                  onUpload={(file) => uploadFile(detail.name, 'assets', file)}
                  onCreateFile={(name) => createNewFile(detail.name, 'assets', name)}
                  createPlaceholder="文件名 (如 template.json)"
                  saving={saving} editorType="code" language="json"
                />
              ) : (
                <CredentialForm
                  name={detail.name}
                  credSystem={detail.metadata?.system || detail.name}
                  authFields={null}
                  userId={userId}
                  credentials={credentials}
                  onSaved={loadCredentials}
                />
              )}
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-gray-400">
            <div className="text-center">
              <div className="text-4xl mb-2">⚡</div>
              <div className="text-sm">{t('skills.selectHint')}</div>
              <div className="text-xs mt-1">{t('skills.createHint')}</div>
            </div>
          </div>
        )}

        {msg && (
          <div className="fixed bottom-4 right-4 bg-gray-800 text-white text-sm px-4 py-2 rounded-lg shadow-lg z-50">
            {msg}
            <button onClick={() => setMsg('')} className="ml-3 text-gray-300 hover:text-white">✕</button>
          </div>
        )}
      </div>
    </div>
  );
}

// === SKILL.md Markdown preview with internal link interception ===

const mdProseClass = "prose prose-sm prose-gray max-w-none leading-relaxed [&_table]:text-xs [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 [&_th]:bg-gray-50 [&_th]:px-3 [&_th]:py-2 [&_th]:border [&_th]:border-gray-200 [&_th]:text-left [&_th]:font-semibold [&_td]:px-3 [&_td]:py-1.5 [&_td]:border [&_td]:border-gray-200 [&_pre]:bg-gray-900 [&_pre]:text-green-300 [&_pre]:rounded-lg [&_pre]:p-3 [&_pre]:text-[12px] [&_pre]:overflow-x-auto [&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_code]:text-[12px] [&_pre_code]:text-green-300 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_h1]:text-base [&_h2]:text-sm [&_h2]:mt-5 [&_h2]:mb-2 [&_h3]:text-xs [&_h3]:mt-4 [&_h3]:mb-1 [&_p]:text-xs [&_p]:my-2 [&_li]:text-xs [&_li]:my-0.5 [&_ul]:pl-5 [&_ol]:pl-5 [&_blockquote]:border-indigo-300 [&_blockquote]:text-gray-500 [&_blockquote]:pl-3 [&_hr]:my-4";

function SkillMdPreview({ content, onNavigate }: {
  content: string;
  onNavigate: (dir: string, file: string) => void;
}) {
  return (
    <div className={mdProseClass}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={{
        a: ({ href, children }) => {
          // Intercept internal skill file links: references/xxx, scripts/xxx, assets/xxx
          if (href && !href.startsWith('http') && !href.startsWith('#')) {
            const match = href.match(/^(references|scripts|assets)\/(.+)$/);
            if (match) {
              return (
                <a href="#" onClick={(e) => { e.preventDefault(); onNavigate(match[1], match[2]); }}
                  className="text-indigo-600 hover:text-indigo-800 underline cursor-pointer">
                  {children}
                </a>
              );
            }
          }
          return <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
        },
      }}>
        {content || '*无指令内容*'}
      </ReactMarkdown>
    </div>
  );
}

// === File tab panel: tags bar + inline editor ===

function FileTabPanel({ skillName, dir, files, emptyHint, onSaveFile, onDeleteFile, onUpload, onCreateFile, createPlaceholder, saving, editorType, language }: {
  skillName: string;
  dir: string;
  files: string[];
  emptyHint: string;
  onSaveFile: (skillName: string, dir: string, file: string, content: string) => Promise<void>;
  onDeleteFile: (skillName: string, dir: string, file: string) => Promise<void>;
  onUpload?: (file: File) => void;
  onCreateFile?: (name: string) => void;
  createPlaceholder?: string;
  saving: boolean;
  editorType: 'code' | 'markdown';
  language?: string;
}) {
  const [activeFile, setActiveFile] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [originalContent, setOriginalContent] = useState('');
  const [loading, setLoading] = useState(false);
  const [newFileName, setNewFileName] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // Auto-select first file
  useEffect(() => {
    if (files.length > 0 && !activeFile) selectFile(files[0]);
    else if (files.length > 0 && activeFile && !files.includes(activeFile)) selectFile(files[0]);
    else if (files.length === 0) { setActiveFile(null); setContent(''); setOriginalContent(''); }
  }, [files]);

  const selectFile = async (file: string) => {
    setActiveFile(file);
    setLoading(true);
    try {
      const resp = await fetch(`${getMainUrl()}/api/skills/${skillName}/${dir}/${file}`, { headers: authHeaders() }).then(r => r.json());
      const c = resp.content ?? '';
      setContent(c);
      setOriginalContent(c);
    } catch { setContent(''); setOriginalContent(''); }
    setLoading(false);
  };

  const handleSave = async () => {
    if (!activeFile) return;
    await onSaveFile(skillName, dir, activeFile, content);
    setOriginalContent(content);
  };

  const modified = content !== originalContent;
  const isMd = editorType === 'markdown' || (activeFile?.endsWith('.md'));

  return (
    <div className="h-full flex flex-col">
      {/* File tags bar */}
      <div className="flex items-center gap-1 px-3 py-1.5 border-b border-gray-200 bg-gray-50 shrink-0 flex-wrap">
        {files.map(file => (
          <span key={file} className={`inline-flex items-center gap-0.5 rounded text-[11px] font-mono transition-colors ${
            activeFile === file ? 'bg-indigo-100 text-indigo-700' : 'text-gray-500 hover:bg-gray-100'
          }`}>
            <button onClick={() => selectFile(file)} className="px-1.5 py-0.5">{file}</button>
            <button onClick={(e) => { e.stopPropagation(); onDeleteFile(skillName, dir, file); }}
              className="px-0.5 py-0.5 text-gray-300 hover:text-red-500 text-[9px]" title="删除">✕</button>
          </span>
        ))}
        <span className="flex-1" />
        {onUpload && (
          <>
            <input ref={fileInputRef} type="file" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onUpload(f);
              e.target.value = '';
            }} />
            <button onClick={() => fileInputRef.current?.click()}
              className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-indigo-600">上传</button>
          </>
        )}
        {onCreateFile && !showCreate && (
          <button onClick={() => setShowCreate(true)}
            className="text-[10px] px-1.5 py-0.5 text-gray-400 hover:text-indigo-600">+</button>
        )}
        {showCreate && onCreateFile && (
          <div className="flex items-center gap-1">
            <input type="text" value={newFileName} onChange={e => setNewFileName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && newFileName.trim()) { onCreateFile(newFileName.trim()); setNewFileName(''); setShowCreate(false); } if (e.key === 'Escape') setShowCreate(false); }}
              placeholder={createPlaceholder || '文件名'} className="text-[11px] border border-gray-200 rounded px-1.5 py-0.5 w-32 focus:outline-none focus:border-indigo-400" autoFocus />
            <button onClick={() => { if (newFileName.trim()) { onCreateFile(newFileName.trim()); setNewFileName(''); setShowCreate(false); } }}
              className="text-[10px] px-1.5 py-0.5 bg-indigo-500 text-white rounded">OK</button>
            <button onClick={() => setShowCreate(false)} className="text-[10px] text-gray-400">✕</button>
          </div>
        )}
        {modified && (
          <button onClick={handleSave} disabled={saving}
            className="text-[10px] px-2 py-0.5 bg-indigo-500 text-white rounded hover:bg-indigo-600 disabled:opacity-50 ml-1">
            {saving ? '...' : '保存'}
          </button>
        )}
      </div>

      {/* Editor area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {files.length === 0 ? (
          <div className="flex items-center justify-center h-full text-gray-300">
            <div className="text-center">
              <div className="text-2xl mb-2">📁</div>
              <div className="text-[10px] text-gray-400">{emptyHint}</div>
            </div>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full text-gray-400 text-xs">加载中...</div>
        ) : isMd ? (
          <MarkdownWysiwyg value={content} onChange={setContent} />
        ) : (
          <MonacoEditor
            height="100%"
            language={language || 'javascript'}
            theme="vs-dark"
            value={content}
            onChange={(val) => setContent(val || '')}
            options={{ minimap: { enabled: false }, fontSize: 12, lineNumbers: 'on', scrollBeyondLastLine: false, wordWrap: 'on', tabSize: 2, automaticLayout: true }}
          />
        )}
      </div>
    </div>
  );
}

// === Recycle bin ===

function SkillRecycleBin({ onRestore }: { onRestore: () => void }) {
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<any[]>([]);

  const headers = () => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    const t = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
    if (t) h['Authorization'] = `Bearer ${t}`;
    return h;
  };

  const load = async () => {
    try { setItems(await fetch(`${MAIN_URL}/api/skills/deleted`, { headers: headers() }).then(r => r.json())); } catch {}
  };

  const restore = async (dirName: string) => {
    await fetch(`${MAIN_URL}/api/skills/deleted/${dirName}/restore`, { method: 'POST', headers: headers() });
    load(); onRestore();
  };

  const purge = async (dirName: string) => {
    if (!(await confirmDialog('永久删除？此操作不可恢复。', { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/skills/deleted/${dirName}`, { method: 'DELETE', headers: headers() });
    load();
  };

  return (
    <div className="p-3 pt-6">
      <button onClick={() => { setOpen(!open); if (!open) load(); }}
        className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
        🗑️ 回收站 {open ? '▾' : '▸'}
      </button>
      {open && (
        <div className="mt-2 border border-dashed border-gray-200 rounded-lg p-2 space-y-1">
          {items.length === 0 && <div className="text-xs text-gray-400 text-center py-2">回收站为空</div>}
          {items.map((item: any) => (
            <div key={item.dirName} className="flex items-center gap-2 py-1.5 border-b border-gray-100 last:border-0">
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium text-gray-600 truncate">{item.name || item.originalName}</div>
                <div className="text-[10px] text-gray-400">{new Date(item.deletedAt).toLocaleString('zh-CN')}</div>
              </div>
              <button onClick={() => restore(item.dirName)} className="px-1.5 py-0.5 text-[10px] text-emerald-600 border border-emerald-200 rounded hover:bg-emerald-50">恢复</button>
              <button onClick={() => purge(item.dirName)} className="px-1.5 py-0.5 text-[10px] text-red-400 border border-red-200 rounded hover:bg-red-50">删除</button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
