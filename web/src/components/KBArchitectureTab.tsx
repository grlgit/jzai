'use client';

import { useState, useCallback, useEffect } from 'react';
import { ChevronRight, ChevronDown, Plus, Pencil, Trash2, FolderTree, Shield, Tag, X, Check, BookOpen } from 'lucide-react';
import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';

const MAIN_URL = getMainUrl();

function authHeaders(): Record<string, string> {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null;
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) h['Authorization'] = `Bearer ${token}`;
  return h;
}

// ── Types ──────────────────────────────────────────────────────────────────

interface Category {
  id: string; parent_id?: string | null; name: string; slug: string; path: string;
  tags?: string[]; template?: string; description?: string; icon?: string; sort_order?: number;
}

interface CatAccess {
  id: string; category_id: string; grantee_type: string; grantee_id: string; role: string;
}

interface Synonym { id: string; keyword: string; synonyms: string[] }

interface Dept { id: string; name: string; slug: string }
interface Wg { id: string; name: string; slug: string }
interface UserItem { id: string; name: string; email: string }

// ── Main Component ─────────────────────────────────────────────────────────

export default function KBArchitectureTab() {
  const [categories, setCategories] = useState<Category[]>([]);
  const [synonyms, setSynonyms] = useState<Synonym[]>([]);
  const [departments, setDepartments] = useState<Dept[]>([]);
  const [workgroups, setWorkgroups] = useState<Wg[]>([]);
  const [users, setUsers] = useState<UserItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState('');

  // Selection
  const [selCat, setSelCat] = useState<Category | null>(null);
  const [catAccess, setCatAccess] = useState<CatAccess[]>([]);

  // Forms
  const [catForm, setCatForm] = useState({ name: '', slug: '', path: '', parent_id: '', tags: '', template: '', description: '' });
  const [addingCat, setAddingCat] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [accessForm, setAccessForm] = useState({ grantee_type: 'department' as string, grantee_id: '', role: 'viewer' });
  const [showSynonyms, setShowSynonyms] = useState(false);
  const [newSynKey, setNewSynKey] = useState('');
  const [newSynVals, setNewSynVals] = useState('');

  const flash = useCallback((msg: string) => { setToast(msg); setTimeout(() => setToast(''), 3000); }, []);

  // ── Load all data ────────────────────────────────────────────────────────

  const loadAll = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    try {
      const [catsRes, synsRes, deptsRes, wgsRes, usersRes] = await Promise.all([
        fetch(`${MAIN_URL}/api/kb/categories`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/kb/synonyms`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/departments`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/workgroups`, { headers: authHeaders() }),
        fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() }),
      ]);
      const newCats: Category[] = catsRes.ok ? await catsRes.json() : [];
      setCategories(newCats);
      setSynonyms(synsRes.ok ? await synsRes.json() : []);
      setDepartments(deptsRes.ok ? await deptsRes.json() : []);
      setWorkgroups(wgsRes.ok ? await wgsRes.json() : []);
      const uData = usersRes.ok ? await usersRes.json() : [];
      setUsers(Array.isArray(uData) ? uData.map((u: any) => ({ id: u.id, name: u.name, email: u.email })) : []);
      // Preserve selection: re-match selCat by id in refreshed data
      setSelCat(prev => prev ? newCats.find(c => c.id === prev.id) || null : null);
    } catch { flash('!加载失败'); }
    setLoading(false);
  }, [flash]);

  useEffect(() => { loadAll(true); }, [loadAll]);

  // ── Category ops ─────────────────────────────────────────────────────────

  const selectCat = async (cat: Category) => {
    setSelCat(cat);
    setAddingCat(false); setAddingChild(false);
    setCatForm({
      name: cat.name, slug: cat.slug, path: cat.path,
      parent_id: cat.parent_id || '', tags: (cat.tags || []).join(', '),
      template: cat.template || '', description: cat.description || '',
    });
    try {
      const res = await fetch(`${MAIN_URL}/api/kb/categories/${cat.id}/access`, { headers: authHeaders() });
      setCatAccess(res.ok ? await res.json() : []);
    } catch { setCatAccess([]); }
  };

  const startAddRoot = () => {
    setAddingCat(true); setAddingChild(false); setSelCat(null);
    setCatForm({ name: '', slug: '', path: '', parent_id: '', tags: '', template: '', description: '' });
  };

  const startAddChild = () => {
    if (!selCat) return;
    setAddingChild(true); setAddingCat(false);
    setCatForm({ name: '', slug: '', path: selCat.path + '/', parent_id: selCat.id, tags: '', template: '', description: '' });
  };

  const saveCat = async () => {
    const name = catForm.name.trim();
    const slug = catForm.slug.trim() || name;
    if (!name) { flash('!名称不能为空'); return; }

    const parentPath = catForm.parent_id
      ? (categories.find(c => c.id === catForm.parent_id)?.path || '')
      : '';
    const path = parentPath ? `${parentPath}/${slug}` : `/${slug}`;
    const tags = catForm.tags.split(/[,，]/).map(t => t.trim()).filter(Boolean);

    const payload = {
      name, slug, path,
      parent_id: catForm.parent_id || null,
      tags, template: catForm.template.trim() || null,
      description: catForm.description.trim() || null,
    };

    try {
      const isNew = addingCat || addingChild;
      const url = isNew ? `${MAIN_URL}/api/kb/categories` : `${MAIN_URL}/api/kb/categories/${selCat!.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(payload) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); flash(`!失败: ${e.message || res.statusText}`); return; }
      flash(isNew ? '分类已创建' : '分类已更新');
      setAddingCat(false); setAddingChild(false);
      await loadAll(false); // Silent refresh — no loading flash
    } catch { flash('!操作失败'); }
  };

  const deleteCat = async () => {
    if (!selCat) return;
    const childCount = categories.filter(c => c.parent_id === selCat.id).length;
    const msg = childCount > 0
      ? `确认删除分类「${selCat.name}」及其 ${childCount} 个子分类？此操作不可撤销。`
      : `确认删除分类「${selCat.name}」？此操作不可撤销。`;
    if (!(await confirmDialog(msg, { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/kb/categories/${selCat.id}`, { method: 'DELETE', headers: authHeaders() });
    flash('分类已删除'); setSelCat(null); setCatAccess([]); await loadAll(false);
  };

  // ── Access ops ───────────────────────────────────────────────────────────

  const grantAccess = async () => {
    if (!selCat || !accessForm.grantee_id) return;
    const res = await fetch(`${MAIN_URL}/api/kb/categories/${selCat.id}/access`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify(accessForm),
    });
    if (!res.ok) { flash('!授权失败'); return; }
    flash('已授权'); setAccessForm(p => ({ ...p, grantee_id: '' }));
    selectCat(selCat);
  };

  const revokeAccess = async (accessId: string) => {
    if (!selCat) return;
    await fetch(`${MAIN_URL}/api/kb/categories/${selCat.id}/access/${accessId}`, { method: 'DELETE', headers: authHeaders() });
    flash('已撤销'); selectCat(selCat);
  };

  // ── Synonym ops ──────────────────────────────────────────────────────────

  const saveSynonyms = async (newSyns: Synonym[]) => {
    const map: Record<string, string[]> = {};
    for (const s of newSyns) map[s.keyword] = s.synonyms;
    await fetch(`${MAIN_URL}/api/kb/synonyms`, {
      method: 'PUT', headers: authHeaders(), body: JSON.stringify({ synonyms: map }),
    });
    setSynonyms(newSyns);
    flash('同义词已保存');
  };

  const addSynonym = () => {
    if (!newSynKey.trim() || !newSynVals.trim()) return;
    const vals = newSynVals.split(/[,，]/).map(v => v.trim()).filter(Boolean);
    const updated = [...synonyms, { id: crypto.randomUUID(), keyword: newSynKey.trim(), synonyms: vals }];
    saveSynonyms(updated);
    setNewSynKey(''); setNewSynVals('');
  };

  const deleteSynonym = (keyword: string) => {
    saveSynonyms(synonyms.filter(s => s.keyword !== keyword));
  };

  // ── Render helpers ───────────────────────────────────────────────────────

  const resolveGranteeName = (type: string, id: string): string => {
    if (type === 'department') return departments.find(d => d.id === id)?.name || id;
    if (type === 'workgroup') return workgroups.find(w => w.id === id)?.name || id;
    if (type === 'user') return users.find(u => u.id === id)?.name || id;
    return id;
  };

  const granteeOptions = () => {
    if (accessForm.grantee_type === 'department') return departments.map(d => ({ id: d.id, label: d.name }));
    if (accessForm.grantee_type === 'workgroup') return workgroups.map(w => ({ id: w.id, label: w.name }));
    return users.map(u => ({ id: u.id, label: `${u.name} (${u.email})` }));
  };

  if (loading) return <div className="text-gray-400 text-sm py-8 text-center">加载中...</div>;

  // Build category tree
  const catRoots = categories.filter(c => !c.parent_id);
  const catChildrenOf = (pid: string) => categories.filter(c => c.parent_id === pid);

  const renderCatNode = (cat: Category, depth: number): React.ReactNode => {
    const children = catChildrenOf(cat.id);
    const isSelected = selCat?.id === cat.id;
    return (
      <div key={cat.id}>
        <button onClick={() => selectCat(cat)}
          className={`w-full text-left py-2 border-b border-gray-100 text-sm transition-colors group ${isSelected ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'}`}
          style={{ paddingLeft: `${12 + depth * 18}px`, paddingRight: 8 }}>
          {children.length > 0
            ? <ChevronDown size={12} className="inline mr-1 text-gray-400" />
            : <span className="inline-block w-3 h-3 rounded-full bg-gray-200 mr-1.5 align-middle" />}
          <span className="font-medium">{cat.name}</span>
          {(cat.tags || []).length > 0 && (
            <span className="ml-2 text-[10px] text-gray-400">{(cat.tags || []).slice(0, 3).join(', ')}</span>
          )}
        </button>
        {children.map(c => renderCatNode(c, depth + 1))}
      </div>
    );
  };

  return (
    <div>
      {toast && (
        <div className={`fixed top-6 right-6 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${toast.startsWith('!') ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`}>
          {toast.startsWith('!') ? toast.slice(1) : toast}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between mb-4">
        <div>
          <h3 className="text-sm font-semibold text-gray-800">知识分类管理</h3>
          <p className="text-xs text-gray-400 mt-0.5">目录即分类，分类即权限 — 统一管理知识结构和访问控制</p>
        </div>
        <div className="flex gap-2">
          <button onClick={startAddRoot}
            className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-700 px-3 py-1 rounded-lg hover:bg-indigo-50">
            <Plus size={13} /> 添加根分类
          </button>
          <button onClick={() => setShowSynonyms(!showSynonyms)}
            className={`flex items-center gap-1 text-xs px-3 py-1 rounded-lg ${showSynonyms ? 'bg-indigo-50 text-indigo-600' : 'text-gray-500 hover:bg-gray-50'}`}>
            <Tag size={13} /> 同义词
          </button>
        </div>
      </div>

      {/* Main layout: tree + detail */}
      <div className="flex gap-0 border border-gray-200 rounded-lg overflow-hidden" style={{ height: showSynonyms ? '340px' : '460px' }}>
        {/* Left: category tree */}
        <div className="w-60 border-r border-gray-200 overflow-y-auto bg-gray-50/30">
          {categories.length === 0 && !addingCat && (
            <div className="py-8 text-center text-gray-400 text-xs">暂无分类，点击"添加根分类"创建</div>
          )}
          {catRoots.map(c => renderCatNode(c, 0))}
        </div>

        {/* Right: detail + permissions */}
        <div className="flex-1 overflow-y-auto p-4">
          {!selCat && !addingCat && !addingChild ? (
            <div className="h-full flex items-center justify-center text-gray-400 text-sm">选择左侧分类查看详情和权限</div>
          ) : (
            <div className="space-y-4">
              {/* Category form */}
              <div>
                <h4 className="text-sm font-semibold text-gray-800 mb-2">
                  {addingCat ? '添加根分类' : addingChild ? `在"${selCat?.name}"下添加子分类` : '分类详情'}
                </h4>
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">名称</label>
                    <input value={catForm.name} onChange={e => setCatForm(p => ({ ...p, name: e.target.value }))}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">标识 (slug)</label>
                    <input value={catForm.slug} onChange={e => setCatForm(p => ({ ...p, slug: e.target.value }))}
                      placeholder={catForm.name}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">标签（逗号分隔）</label>
                    <input value={catForm.tags} onChange={e => setCatForm(p => ({ ...p, tags: e.target.value }))}
                      placeholder="检验标准, QC, 质量报告"
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">模板（可选）</label>
                    <input value={catForm.template} onChange={e => setCatForm(p => ({ ...p, template: e.target.value }))}
                      placeholder="quality-doc.md"
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 block mb-0.5">描述</label>
                    <input value={catForm.description} onChange={e => setCatForm(p => ({ ...p, description: e.target.value }))}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                </div>
                <div className="flex gap-2 mt-2">
                  <button onClick={saveCat} className="bg-indigo-600 text-white px-3 py-1 rounded text-xs hover:bg-indigo-700">
                    {(addingCat || addingChild) ? '创建' : '保存'}
                  </button>
                  {(addingCat || addingChild) && (
                    <button onClick={() => { setAddingCat(false); setAddingChild(false); }} className="text-gray-500 text-xs">取消</button>
                  )}
                  {selCat && !addingCat && !addingChild && (
                    <>
                      <button onClick={startAddChild} className="text-indigo-600 text-xs flex items-center gap-0.5"><Plus size={11} /> 添加子分类</button>
                      <button onClick={deleteCat} className="text-red-500 text-xs ml-auto">删除分类</button>
                    </>
                  )}
                </div>
              </div>

              {/* Access / Permissions */}
              {selCat && !addingCat && !addingChild && (
                <div className="pt-3 border-t border-gray-200">
                  <div className="flex items-center gap-2 mb-2">
                    <Shield size={14} className="text-gray-500" />
                    <h4 className="text-sm font-semibold text-gray-800">访问权限</h4>
                    <span className="text-[10px] text-gray-400">子分类自动继承</span>
                  </div>

                  {/* Existing grants */}
                  {catAccess.length > 0 && (
                    <div className="space-y-1 mb-3">
                      {catAccess.map(a => (
                        <div key={a.id} className="flex items-center justify-between px-2 py-1.5 bg-gray-50 rounded text-xs">
                          <div className="flex items-center gap-2">
                            <span className={`px-1.5 py-0 rounded text-[10px] font-medium ${
                              a.grantee_type === 'department' ? 'bg-blue-50 text-blue-600'
                              : a.grantee_type === 'workgroup' ? 'bg-emerald-50 text-emerald-600'
                              : 'bg-gray-100 text-gray-600'
                            }`}>{a.grantee_type === 'department' ? '部门' : a.grantee_type === 'workgroup' ? '工作组' : '个人'}</span>
                            <span className="text-gray-700">{resolveGranteeName(a.grantee_type, a.grantee_id)}</span>
                            <span className={`px-1 py-0 rounded text-[10px] ${a.role === 'admin' ? 'bg-red-50 text-red-600' : a.role === 'editor' ? 'bg-amber-50 text-amber-600' : 'bg-gray-100 text-gray-500'}`}>
                              {a.role === 'admin' ? '管理' : a.role === 'editor' ? '编辑' : '查看'}
                            </span>
                          </div>
                          <button onClick={() => revokeAccess(a.id)} className="text-red-400 hover:text-red-600"><X size={12} /></button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Add grant */}
                  <div className="flex items-center gap-2 p-2 bg-gray-50/50 rounded-lg">
                    <select value={accessForm.grantee_type} onChange={e => setAccessForm(p => ({ ...p, grantee_type: e.target.value, grantee_id: '' }))}
                      className="px-2 py-1 border border-gray-200 rounded text-xs bg-white">
                      <option value="department">部门</option>
                      <option value="workgroup">工作组</option>
                      <option value="user">个人</option>
                    </select>
                    <select value={accessForm.grantee_id} onChange={e => setAccessForm(p => ({ ...p, grantee_id: e.target.value }))}
                      className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs bg-white">
                      <option value="">选择...</option>
                      {granteeOptions().map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
                    </select>
                    <select value={accessForm.role} onChange={e => setAccessForm(p => ({ ...p, role: e.target.value }))}
                      className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-16">
                      <option value="viewer">查看</option>
                      <option value="editor">编辑</option>
                      <option value="admin">管理</option>
                    </select>
                    <button onClick={grantAccess} disabled={!accessForm.grantee_id}
                      className="text-indigo-600 disabled:text-gray-300 text-xs font-medium">授权</button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Synonyms (collapsible) */}
      {showSynonyms && (
        <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
          <div className="px-3 py-2 bg-gray-50 text-xs font-medium text-gray-500">同义词映射 — 搜索时自动扩展</div>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {synonyms.map(s => (
                <tr key={s.keyword} className="hover:bg-gray-50/50">
                  <td className="px-3 py-1.5 font-medium text-gray-700 w-32">{s.keyword}</td>
                  <td className="px-3 py-1.5">
                    <div className="flex flex-wrap gap-1">
                      {s.synonyms.map(v => <span key={v} className="px-1.5 py-0 rounded bg-gray-100 text-gray-600 text-xs">{v}</span>)}
                    </div>
                  </td>
                  <td className="px-3 py-1.5 w-10 text-center">
                    <button onClick={() => deleteSynonym(s.keyword)} className="text-red-400 hover:text-red-600"><Trash2 size={12} /></button>
                  </td>
                </tr>
              ))}
              <tr className="bg-gray-50/30">
                <td className="px-3 py-1.5">
                  <input value={newSynKey} onChange={e => setNewSynKey(e.target.value)} placeholder="关键词"
                    className="w-full px-2 py-0.5 border border-gray-200 rounded text-xs outline-none focus:border-indigo-500" />
                </td>
                <td className="px-3 py-1.5">
                  <input value={newSynVals} onChange={e => setNewSynVals(e.target.value)} placeholder="同义词，逗号分隔"
                    className="w-full px-2 py-0.5 border border-gray-200 rounded text-xs outline-none focus:border-indigo-500" />
                </td>
                <td className="px-3 py-1.5 text-center">
                  <button onClick={addSynonym} disabled={!newSynKey.trim() || !newSynVals.trim()}
                    className="text-indigo-600 disabled:text-gray-300"><Plus size={13} /></button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
