'use client';

import { useState, useEffect, useCallback } from 'react';
import { useI18n } from '@/i18n';

import { getMainUrl } from '@/lib/env';
import { confirmDialog } from '@/components/AppDialog';
const MAIN_URL = getMainUrl();

interface Role { id: string; name: string; description: string; permissions: string[]; isSystem: boolean }
interface UserItem { id: string; name: string; username: string; email: string; role: Role; status: string; lastLoginAt?: string }
interface PermDef { id: string; module: string; action: string; label: string }

function getToken() { return localStorage.getItem('jz_token') || ''; }
function authHeaders() { return { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' }; }

export default function UserManagePanel({ embedded }: { embedded?: boolean }) {
  const { t } = useI18n();
  const [tab, setTab] = useState<'users' | 'org' | 'roles'>('users');
  const [users, setUsers] = useState<UserItem[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [allPerms, setAllPerms] = useState<PermDef[]>([]);
  const [showAddUser, setShowAddUser] = useState(false);
  const [editUser, setEditUser] = useState<UserItem | null>(null);
  const [resetPwdUser, setResetPwdUser] = useState<UserItem | null>(null);
  const [resetPwdValue, setResetPwdValue] = useState('');
  const [resetPwdDone, setResetPwdDone] = useState(false);
  const [resetPwdCopied, setResetPwdCopied] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [editRole, setEditRole] = useState<Role | null>(null);
  const [msg, setMsg] = useState('');
  const [deptsList, setDeptsList] = useState<{ id: string; name: string }[]>([]);
  const [userDeptMap, setUserDeptMap] = useState<Record<string, string>>({}); // userId → deptId

  const load = useCallback(async () => {
    const [u, r, p, d] = await Promise.all([
      fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/roles`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/permissions`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
      fetch(`${MAIN_URL}/api/departments`, { headers: authHeaders() }).then(r => r.json()).catch(() => []),
    ]);
    setUsers(Array.isArray(u) ? u : []);
    setRoles(Array.isArray(r) ? r : []);
    setAllPerms(Array.isArray(p) ? p : []);
    const deptsArr = Array.isArray(d) ? d : [];
    setDeptsList(deptsArr.map((x: any) => ({ id: x.id, name: x.name })));

    // Load department membership for all users (fetch members per dept)
    const dMap: Record<string, string> = {};
    for (const dept of deptsArr) {
      try {
        const members = await fetch(`${MAIN_URL}/api/departments/${dept.id}/members`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []);
        for (const m of members) { dMap[m.user_id] = dept.id; }
      } catch {}
    }
    setUserDeptMap(dMap);
  }, []);

  useEffect(() => { load(); }, [load]);

  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); };

  // Add user
  const handleAddUser = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const res = await fetch(`${MAIN_URL}/api/users`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ name: fd.get('name'), username: fd.get('username') || undefined, email: fd.get('email'), password: fd.get('password'), roleId: fd.get('roleId') }),
    });
    if (res.ok) { flash('✅ ' + t('common.saved')); setShowAddUser(false); load(); }
    else { const d = await res.json(); flash(`❌ ${d.message}`); }
  };

  // Toggle user status
  const toggleStatus = async (u: UserItem) => {
    await fetch(`${MAIN_URL}/api/users/${u.id}`, {
      method: 'PUT', headers: authHeaders(),
      body: JSON.stringify({ status: u.status === 'active' ? 'disabled' : 'active' }),
    });
    load();
  };

  // Delete user
  const delUser = async (id: string) => {
    if (!(await confirmDialog(t('common.confirm') + '?', { danger: true }))) return;
    await fetch(`${MAIN_URL}/api/users/${id}`, { method: 'DELETE', headers: authHeaders() });
    load();
  };

  // Save role (create or update)
  const saveRole = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    const perms = allPerms.filter(p => fd.get(`perm_${p.id}`) === 'on').map(p => p.id);
    if (editRole) {
      await fetch(`${MAIN_URL}/api/roles/${editRole.id}`, {
        method: 'PUT', headers: authHeaders(),
        body: JSON.stringify({ name: fd.get('name'), description: fd.get('desc'), permissions: perms }),
      });
      flash('✅ ' + t('common.saved'));
    } else {
      await fetch(`${MAIN_URL}/api/roles`, {
        method: 'POST', headers: authHeaders(),
        body: JSON.stringify({ name: fd.get('name'), description: fd.get('desc'), permissions: perms }),
      });
      flash('✅ ' + t('common.saved'));
    }
    setShowAddRole(false); setEditRole(null); load();
  };

  const delRole = async (id: string) => {
    const res = await fetch(`${MAIN_URL}/api/roles/${id}`, { method: 'DELETE', headers: authHeaders() });
    if (res.ok) { flash('✅ ' + t('common.saved')); load(); }
    else { const d = await res.json(); flash(`❌ ${d.message}`); }
  };

  // Group permissions by module
  const permGroups: Record<string, PermDef[]> = {};
  allPerms.forEach(p => { (permGroups[p.module] = permGroups[p.module] || []).push(p); });
  const moduleLabels: Record<string, string> = { chat: '对话', kb: '企业心智', cw: 'CoWorker', dash: '看板', cfg: '设置', sys: '系统' };

  return (
    <div className={embedded ? 'overflow-y-auto h-full' : 'p-6 overflow-y-auto h-full'}>
      {msg && <div className="mb-4 text-sm px-3 py-2 bg-gray-50 rounded-lg">{msg}</div>}

      <div className="flex border-b border-gray-200 mb-6">
        <button onClick={() => setTab('users')} className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'users' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>{t('users.accountTab')}</button>
        <button onClick={() => setTab('org')} className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'org' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>组织结构</button>
        <button onClick={() => setTab('roles')} className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${tab === 'roles' ? 'border-indigo-500 text-indigo-600' : 'border-transparent text-gray-400 hover:text-gray-600'}`}>{t('users.roleTab')}</button>
      </div>

      {/* ===== Users Tab ===== */}
      {tab === 'users' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold">{t('users.accountList', { n: users.length })}</h3>
            <button onClick={() => { setEditUser(null); setShowAddUser(true); }} className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-lg hover:bg-indigo-700">{t('users.addAccount')}</button>
          </div>

          <div className="border border-gray-200 rounded-lg overflow-hidden">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] text-gray-400 bg-gray-50 border-b">
                <th className="text-left py-2 px-4">{t('users.account')}</th>
                <th className="text-left py-2 px-4">{t('users.username')}</th>
                <th className="text-left py-2 px-4">{t('users.email')}</th>
                <th className="text-left py-2 px-4">部门</th>
                <th className="text-left py-2 px-4">{t('users.role')}</th>
                <th className="text-left py-2 px-4">{t('users.status')}</th>
                <th className="text-left py-2 px-4">{t('users.lastLogin')}</th>
                <th className="py-2 px-4"></th>
              </tr></thead>
              <tbody>
                {users.map(u => (
                  <tr key={u.id} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2.5 px-4 font-medium">{u.name}</td>
                    <td className="py-2.5 px-4">{u.username || u.name}</td>
                    <td className="py-2.5 px-4 text-gray-500 text-xs">{u.email}</td>
                    <td className="py-2.5 px-4 text-xs text-gray-500">{deptsList.find(d => d.id === userDeptMap[u.id])?.name || '—'}</td>
                    <td className="py-2.5 px-4"><span className="px-2 py-0.5 bg-indigo-50 text-indigo-600 rounded text-xs">{u.role.name}</span></td>
                    <td className="py-2.5 px-4">
                      <span className={`text-xs ${u.status === 'active' ? 'text-green-500' : 'text-red-400'}`}>
                        {u.status === 'active' ? t('common.enabled') : t('common.disabled')}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-xs text-gray-400">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString('zh-CN') : '—'}</td>
                    <td className="py-2.5 px-4 text-right space-x-2">
                      <button onClick={() => { setEditUser(u); setShowAddUser(true); }} className="text-xs text-gray-400 hover:text-indigo-600">{t('common.edit')}</button>
                      <button onClick={() => {
                        setResetPwdUser(u);
                        setResetPwdValue('Jz' + Math.random().toString(36).slice(2, 8) + '!');
                        setResetPwdDone(false); setResetPwdCopied(false);
                      }} className="text-xs text-gray-400 hover:text-amber-600">重置密码</button>
                      <button onClick={() => toggleStatus(u)} className="text-xs text-gray-400 hover:text-gray-600">{u.status === 'active' ? t('common.disable') : t('common.enable')}</button>
                      <button onClick={() => delUser(u.id)} className="text-xs text-red-400 hover:text-red-600">{t('common.delete')}</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Add/Edit User Dialog */}
          {showAddUser && (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
              <form onSubmit={async (e) => {
                e.preventDefault();
                const fd = new FormData(e.currentTarget);
                const newDeptId = (fd.get('deptId') as string) || '';
                if (editUser) {
                  // Edit mode — update user fields
                  const body: any = {};
                  const name = fd.get('name') as string;
                  const username = fd.get('username') as string;
                  const roleId = fd.get('roleId') as string;
                  const password = fd.get('password') as string;
                  if (name && name !== editUser.name) body.name = name;
                  if (username && username !== editUser.username) body.username = username;
                  if (roleId && roleId !== editUser.role.id) body.roleId = roleId;
                  if (password) body.password = password;
                  if (Object.keys(body).length > 0) {
                    await fetch(`${MAIN_URL}/api/users/${editUser.id}`, {
                      method: 'PUT', headers: authHeaders(), body: JSON.stringify(body),
                    });
                  }
                  // Update department membership
                  const oldDeptId = userDeptMap[editUser.id] || '';
                  if (newDeptId !== oldDeptId) {
                    // Remove from old dept
                    if (oldDeptId) {
                      const oldMembers = await fetch(`${MAIN_URL}/api/departments/${oldDeptId}/members`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []);
                      const oldMembership = oldMembers.find((m: any) => m.user_id === editUser.id);
                      if (oldMembership) await fetch(`${MAIN_URL}/api/departments/${oldDeptId}/members/${oldMembership.id}`, { method: 'DELETE', headers: authHeaders() });
                    }
                    // Add to new dept
                    if (newDeptId) {
                      await fetch(`${MAIN_URL}/api/departments/${newDeptId}/members`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ user_id: editUser.id, role: 'member' }) });
                    }
                  }
                } else {
                  // Create mode
                  await handleAddUser(e);
                  // After create, assign dept if selected
                  if (newDeptId) {
                    const allUsers = await fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() }).then(r => r.json());
                    const email = fd.get('email') as string;
                    const newUser = allUsers.find((u: any) => u.email === email);
                    if (newUser) {
                      await fetch(`${MAIN_URL}/api/departments/${newDeptId}/members`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({ user_id: newUser.id, role: 'member' }) });
                    }
                  }
                  return;
                }
                setShowAddUser(false); setEditUser(null); load();
              }} className="bg-white rounded-xl p-6 w-96 shadow-xl">
                <h3 className="text-sm font-semibold mb-4">{editUser ? '编辑账户' : t('users.addTitle')}</h3>
                <div className="space-y-3">
                  <div><label className="block text-xs text-gray-500 mb-1">{t('users.accountName')}</label><input name="name" required defaultValue={editUser?.name} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder={t('users.accountNameHint')} /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">{t('users.displayName')}</label><input name="username" defaultValue={editUser?.username} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder={t('users.displayNameHint')} /></div>
                  {!editUser && <div><label className="block text-xs text-gray-500 mb-1">{t('users.email')}</label><input name="email" type="email" required className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" /></div>}
                  <div><label className="block text-xs text-gray-500 mb-1">{editUser ? '新密码（留空不改）' : t('users.password')}</label><input name="password" type="password" {...(editUser ? {} : { required: true })} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" placeholder={editUser ? '留空保持不变' : ''} /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">{t('users.role')}</label>
                    <select name="roleId" defaultValue={editUser?.role.id} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                      {roles.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
                    </select>
                  </div>
                  <div><label className="block text-xs text-gray-500 mb-1">部门</label>
                    <select name="deptId" defaultValue={editUser ? (userDeptMap[editUser.id] || '') : ''} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500">
                      <option value="">无</option>
                      {deptsList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button type="button" onClick={() => { setShowAddUser(false); setEditUser(null); }} className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg">{t('common.cancel')}</button>
                  <button type="submit" className="px-4 py-1.5 bg-indigo-600 text-white text-xs rounded-lg">{editUser ? '保存' : t('common.create')}</button>
                </div>
              </form>
            </div>
          )}
          {/* Reset Password Dialog */}
          {resetPwdUser && (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
              <div className="bg-white rounded-xl p-6 w-96 shadow-xl">
                <h3 className="text-sm font-semibold mb-1">重置密码</h3>
                <p className="text-xs text-gray-400 mb-4">为 <span className="font-medium text-gray-700">{resetPwdUser.name}</span> ({resetPwdUser.email}) 设置新密码</p>

                <div className="mb-4">
                  <label className="block text-xs text-gray-500 mb-1">新密码</label>
                  <div className="flex gap-2">
                    <input
                      value={resetPwdValue}
                      onChange={e => { setResetPwdValue(e.target.value); setResetPwdDone(false); }}
                      className="flex-1 px-3 py-1.5 border border-gray-200 rounded-lg text-sm font-mono outline-none focus:border-indigo-500"
                    />
                    <button
                      type="button"
                      onClick={() => { navigator.clipboard.writeText(resetPwdValue); setResetPwdCopied(true); setTimeout(() => setResetPwdCopied(false), 2000); }}
                      className={`px-3 py-1.5 text-xs rounded-lg border transition-all ${resetPwdCopied ? 'bg-green-50 border-green-300 text-green-600' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}
                    >
                      {resetPwdCopied ? '已复制' : '复制'}
                    </button>
                  </div>
                </div>

                {resetPwdDone && (
                  <div className="mb-4 px-3 py-2 bg-green-50 border border-green-200 rounded-lg text-xs text-green-700">
                    密码已重置成功，请将新密码告知用户。
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setResetPwdUser(null)}
                    className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg hover:bg-gray-50"
                  >
                    {resetPwdDone ? '关闭' : '取消'}
                  </button>
                  {!resetPwdDone && (
                    <button
                      type="button"
                      disabled={!resetPwdValue.trim()}
                      onClick={async () => {
                        await fetch(`${MAIN_URL}/api/users/${resetPwdUser.id}`, {
                          method: 'PUT', headers: authHeaders(), body: JSON.stringify({ password: resetPwdValue }),
                        });
                        setResetPwdDone(true);
                      }}
                      className="px-4 py-1.5 bg-amber-500 text-white text-xs rounded-lg hover:bg-amber-600 disabled:opacity-50"
                    >
                      确认重置
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ===== Roles Tab ===== */}
      {tab === 'roles' && (
        <div>
          <div className="flex justify-between items-center mb-4">
            <h3 className="text-sm font-semibold">{t('users.roleList', { n: roles.length })}</h3>
            <button onClick={() => { setEditRole(null); setShowAddRole(true); }} className="px-3 py-1.5 bg-indigo-600 text-white text-xs rounded-lg hover:bg-indigo-700">{t('users.newRole')}</button>
          </div>

          <div className="space-y-3">
            {roles.map(r => (
              <div key={r.id} className="border border-gray-200 rounded-lg p-4">
                <div className="flex items-center justify-between mb-2">
                  <div>
                    <span className="font-medium text-sm">{r.name}</span>
                    {r.isSystem && <span className="ml-2 text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded">{t('users.system')}</span>}
                  </div>
                  <div className="flex gap-2">
                    <button onClick={() => { setEditRole(r); setShowAddRole(true); }} className="text-xs text-gray-400 hover:text-gray-600">{t('common.edit')}</button>
                    {!r.isSystem && <button onClick={() => delRole(r.id)} className="text-xs text-red-400 hover:text-red-600">{t('common.delete')}</button>}
                  </div>
                </div>
                <div className="text-xs text-gray-400 mb-2">{r.description}</div>
                <div className="flex flex-wrap gap-1">
                  {r.permissions.map(p => {
                    const def = allPerms.find(d => d.id === p);
                    return <span key={p} className="px-1.5 py-0.5 bg-gray-100 text-gray-500 rounded text-[10px]">{def?.label || p}</span>;
                  })}
                </div>
              </div>
            ))}
          </div>

          {/* Role Editor Dialog */}
          {showAddRole && (
            <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50">
              <form onSubmit={saveRole} className="bg-white rounded-xl p-6 w-[480px] max-h-[80vh] overflow-y-auto shadow-xl">
                <h3 className="text-sm font-semibold mb-4">{editRole ? t('users.editRole') : t('users.newRoleTitle')}</h3>
                <div className="space-y-3 mb-4">
                  <div><label className="block text-xs text-gray-500 mb-1">{t('users.roleName')}</label><input name="name" required defaultValue={editRole?.name} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" /></div>
                  <div><label className="block text-xs text-gray-500 mb-1">{t('common.description')}</label><input name="desc" defaultValue={editRole?.description} className="w-full px-3 py-1.5 border border-gray-200 rounded-lg text-sm outline-none focus:border-indigo-500" /></div>
                </div>
                <div className="text-xs font-semibold text-gray-500 mb-2">{t('users.permissions')}</div>
                <div className="space-y-3">
                  {Object.entries(permGroups).map(([mod, perms]) => (
                    <div key={mod} className="border border-gray-100 rounded-lg p-3">
                      <div className="text-xs font-medium text-gray-600 mb-2">{moduleLabels[mod] || mod}</div>
                      <div className="space-y-1">
                        {perms.map(p => (
                          <label key={p.id} className="flex items-center gap-2 text-xs text-gray-500 cursor-pointer hover:text-gray-700">
                            <input type="checkbox" name={`perm_${p.id}`} defaultChecked={editRole?.permissions.includes(p.id)} className="rounded border-gray-300" />
                            {p.label}
                          </label>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button type="button" onClick={() => { setShowAddRole(false); setEditRole(null); }} className="px-4 py-1.5 text-xs border border-gray-200 rounded-lg">{t('common.cancel')}</button>
                  <button type="submit" className="px-4 py-1.5 bg-indigo-600 text-white text-xs rounded-lg">{t('common.save')}</button>
                </div>
              </form>
            </div>
          )}
        </div>
      )}

      {tab === 'org' && <OrgStructPanel />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// Organization Structure Panel (Departments + Workgroups) — uses main platform API
// ═══════════════════════════════════════════════════════════════════════════════

interface Dept { id: string; name: string; slug: string; parent_id?: string | null; head_user_id?: string | null; sort_order?: number }
interface DeptMember { id: string; user_id: string; user_name: string; user_email: string; role: string }
interface Wg { id: string; name: string; slug: string; description?: string }
interface WgMember { id: string; user_id: string; user_name: string; user_email: string }

function OrgStructPanel() {
  const [depts, setDepts] = useState<Dept[]>([]);
  const [wgs, setWgs] = useState<Wg[]>([]);
  const [users, setUsers] = useState<{ id: string; name: string; email: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState('');
  const flash = useCallback((m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3000); }, []);

  // Dept detail
  const [selDept, setSelDept] = useState<Dept | null>(null);
  const [deptMembers, setDeptMembers] = useState<DeptMember[]>([]);
  const [deptForm, setDeptForm] = useState({ name: '', slug: '', parent_id: '' });
  const [addingDept, setAddingDept] = useState(false);
  const [addMemberUserId, setAddMemberUserId] = useState('');
  const [addMemberRole, setAddMemberRole] = useState('member');

  // Wg detail
  const [selWg, setSelWg] = useState<Wg | null>(null);
  const [wgMembers, setWgMembers] = useState<WgMember[]>([]);
  const [wgForm, setWgForm] = useState({ name: '', slug: '', description: '' });
  const [addingWg, setAddingWg] = useState(false);
  const [addWgUserId, setAddWgUserId] = useState('');

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [d, w, u] = await Promise.all([
        fetch(`${MAIN_URL}/api/departments`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
        fetch(`${MAIN_URL}/api/workgroups`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
        fetch(`${MAIN_URL}/api/users`, { headers: authHeaders() }).then(r => r.ok ? r.json() : []),
      ]);
      setDepts(Array.isArray(d) ? d : []);
      setWgs(Array.isArray(w) ? w : []);
      setUsers(Array.isArray(u) ? u.map((x: any) => ({ id: x.id, name: x.name, email: x.email })) : []);
    } catch { flash('!加载失败'); }
    setLoading(false);
  }, [flash]);

  useEffect(() => { loadAll(); }, [loadAll]);

  // Dept ops
  const loadDeptMembers = async (deptId: string) => {
    try {
      const res = await fetch(`${MAIN_URL}/api/departments/${deptId}/members`, { headers: authHeaders() });
      setDeptMembers(res.ok ? await res.json() : []);
    } catch { setDeptMembers([]); }
  };

  const selectDept = async (d: Dept) => {
    setSelDept(d); setAddingDept(false);
    setDeptForm({ name: d.name, slug: d.slug, parent_id: d.parent_id || '' });
    // Load members — must await to ensure state is set before next render
    try {
      const res = await fetch(`${MAIN_URL}/api/departments/${d.id}/members`, { headers: authHeaders() });
      const members = res.ok ? await res.json() : [];
      setDeptMembers(Array.isArray(members) ? members : []);
    } catch { setDeptMembers([]); }
  };

  const saveDept = async () => {
    if (!deptForm.name.trim() || !deptForm.slug.trim()) { flash('!名称和标识不能为空'); return; }
    const payload = { ...deptForm, parent_id: deptForm.parent_id || null };
    try {
      const isNew = addingDept;
      const url = isNew ? `${MAIN_URL}/api/departments` : `${MAIN_URL}/api/departments/${selDept!.id}`;
      const method = isNew ? 'POST' : 'PUT';
      const res = await fetch(url, { method, headers: authHeaders(), body: JSON.stringify(payload) });
      if (!res.ok) { const e = await res.json().catch(() => ({})); flash(`!失败: ${e.message || res.statusText}`); return; }
      const saved = await res.json();
      flash(isNew ? '部门已创建' : '部门已保存');
      setAddingDept(false);
      await loadAll();
      // Re-select to refresh members
      if (saved?.id) selectDept(saved);
    } catch { flash('!操作失败'); }
  };

  const deleteDept = async (id: string) => {
    await fetch(`${MAIN_URL}/api/departments/${id}`, { method: 'DELETE', headers: authHeaders() });
    flash('部门已删除'); setSelDept(null); await loadAll();
  };

  const addDeptMember = async () => {
    if (!selDept || !addMemberUserId) return;
    const deptId = selDept.id; // Capture before async
    const res = await fetch(`${MAIN_URL}/api/departments/${deptId}/members`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ user_id: addMemberUserId, role: addMemberRole }),
    });
    if (!res.ok) { flash('!添加失败'); return; }
    flash('成员已添加'); setAddMemberUserId('');
    // Reload members inline
    try {
      const r2 = await fetch(`${MAIN_URL}/api/departments/${deptId}/members`, { headers: authHeaders() });
      setDeptMembers(r2.ok ? await r2.json() : []);
    } catch { /* ignore */ }
  };

  const removeDeptMember = async (mid: string) => {
    if (!selDept) return;
    const deptId = selDept.id;
    await fetch(`${MAIN_URL}/api/departments/${deptId}/members/${mid}`, { method: 'DELETE', headers: authHeaders() });
    flash('已移除');
    try {
      const r2 = await fetch(`${MAIN_URL}/api/departments/${deptId}/members`, { headers: authHeaders() });
      setDeptMembers(r2.ok ? await r2.json() : []);
    } catch { /* ignore */ }
  };

  // Wg ops
  const selectWg = async (w: Wg) => {
    setSelWg(w); setAddingWg(false);
    setWgForm({ name: w.name, slug: w.slug, description: w.description || '' });
    try {
      const res = await fetch(`${MAIN_URL}/api/workgroups/${w.id}/members`, { headers: authHeaders() });
      setWgMembers(res.ok ? await res.json() : []);
    } catch { setWgMembers([]); }
  };

  const saveWg = async () => {
    if (!wgForm.name.trim() || !wgForm.slug.trim()) { flash('!名称和标识不能为空'); return; }
    try {
      const res = await fetch(`${MAIN_URL}/api/workgroups`, { method: 'POST', headers: authHeaders(), body: JSON.stringify(wgForm) });
      if (!res.ok) { flash('!创建失败'); return; }
      flash('工作组已创建'); setAddingWg(false); await loadAll();
    } catch { flash('!操作失败'); }
  };

  const deleteWg = async (id: string) => {
    await fetch(`${MAIN_URL}/api/workgroups/${id}`, { method: 'DELETE', headers: authHeaders() });
    flash('已删除'); setSelWg(null); await loadAll();
  };

  const addWgMember = async () => {
    if (!selWg || !addWgUserId) return;
    const res = await fetch(`${MAIN_URL}/api/workgroups/${selWg.id}/members`, {
      method: 'POST', headers: authHeaders(), body: JSON.stringify({ user_id: addWgUserId }),
    });
    if (!res.ok) { flash('!添加失败'); return; }
    flash('成员已添加'); setAddWgUserId(''); selectWg(selWg);
  };

  const removeWgMember = async (mid: string) => {
    if (!selWg) return;
    await fetch(`${MAIN_URL}/api/workgroups/${selWg.id}/members/${mid}`, { method: 'DELETE', headers: authHeaders() });
    flash('已移除'); selectWg(selWg);
  };

  if (loading) return <div className="text-gray-400 text-sm py-8 text-center">加载中...</div>;

  // Build dept tree
  const deptRoots = depts.filter(d => !d.parent_id);
  const deptChildrenOf = (pid: string) => depts.filter(d => d.parent_id === pid);
  const renderDeptNode = (d: Dept, depth: number): React.ReactNode => (
    <div key={d.id}>
      <button onClick={() => selectDept(d)}
        className={`w-full text-left py-2 border-b border-gray-100 text-sm ${selDept?.id === d.id ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'}`}
        style={{ paddingLeft: `${12 + depth * 16}px`, paddingRight: 8 }}>
        {depth > 0 && <span className="text-gray-300 mr-1">└</span>}{d.name}
        <span className="text-[10px] text-gray-400 ml-1">({d.slug})</span>
      </button>
      {deptChildrenOf(d.id).map(c => renderDeptNode(c, depth + 1))}
    </div>
  );

  // Available users for member add (exclude already added)
  const deptAvailUsers = users.filter(u => !deptMembers.some(m => m.user_id === u.id));
  const wgAvailUsers = users.filter(u => !wgMembers.some(m => m.user_id === u.id));

  return (
    <div className="space-y-6">
      {msg && <div className={`fixed top-6 right-6 z-50 px-4 py-2 rounded-lg text-sm shadow-lg ${msg.startsWith('!') ? 'bg-red-600 text-white' : 'bg-gray-900 text-white'}`}>{msg.startsWith('!') ? msg.slice(1) : msg}</div>}

      {/* Departments */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-800">部门管理</h3>
          <button onClick={() => { setAddingDept(true); setSelDept(null); setDeptForm({ name: '', slug: '', parent_id: '' }); }}
            className="text-xs text-indigo-600 hover:text-indigo-700">+ 添加部门</button>
        </div>
        <div className="flex gap-0 h-72 border border-gray-200 rounded-lg overflow-hidden">
          <div className="w-56 border-r border-gray-200 overflow-y-auto bg-gray-50/30">
            {depts.length === 0 && !addingDept && <div className="py-6 text-center text-gray-400 text-xs">暂无部门</div>}
            {deptRoots.map(d => renderDeptNode(d, 0))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {!selDept && !addingDept ? (
              <div className="h-full flex items-center justify-center text-gray-400 text-xs">选择部门或添加新部门</div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">部门名称</label>
                    <input value={deptForm.name} onChange={e => setDeptForm(p => ({ ...p, name: e.target.value }))}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">标识 (slug)</label>
                    <input value={deptForm.slug} onChange={e => setDeptForm(p => ({ ...p, slug: e.target.value }))} disabled={!!selDept}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500 disabled:bg-gray-50" />
                  </div>
                  <div className="col-span-2">
                    <label className="text-xs text-gray-500 block mb-0.5">上级部门</label>
                    <select value={deptForm.parent_id} onChange={e => setDeptForm(p => ({ ...p, parent_id: e.target.value }))}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500 bg-white">
                      <option value="">无（顶级部门）</option>
                      {depts.filter(d => d.id !== selDept?.id).map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  </div>
                </div>
                <div className="flex gap-2">
                  <button onClick={saveDept} className="bg-indigo-600 text-white px-3 py-1 rounded text-xs hover:bg-indigo-700">
                    {addingDept ? '创建' : '保存'}
                  </button>
                  {addingDept && <button onClick={() => setAddingDept(false)} className="text-gray-500 text-xs">取消</button>}
                  {selDept && <button onClick={() => deleteDept(selDept.id)} className="text-red-500 text-xs ml-auto">删除部门</button>}
                </div>

                {/* Members */}
                {selDept && (
                  <div className="pt-2 border-t border-gray-200">
                    <span className="text-xs font-medium text-gray-600 block mb-1">成员 ({deptMembers.length})</span>
                    <div className="space-y-1 mb-2 max-h-28 overflow-y-auto">
                      {deptMembers.map(m => (
                        <div key={m.id} className="flex items-center justify-between px-2 py-1 bg-gray-50 rounded text-xs">
                          <span className="text-gray-700">{m.user_name} <span className="text-gray-400">({m.user_email})</span></span>
                          <div className="flex items-center gap-1">
                            <span className={`px-1 py-0 rounded text-[10px] ${m.role === 'head' ? 'bg-amber-50 text-amber-600' : m.role === 'editor' ? 'bg-blue-50 text-blue-600' : 'bg-gray-100 text-gray-500'}`}>{m.role}</span>
                            <button onClick={() => removeDeptMember(m.id)} className="text-red-400 hover:text-red-600 ml-1">×</button>
                          </div>
                        </div>
                      ))}
                    </div>
                    <div className="flex gap-1">
                      <select value={addMemberUserId} onChange={e => setAddMemberUserId(e.target.value)}
                        className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs bg-white">
                        <option value="">选择用户...</option>
                        {deptAvailUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                      </select>
                      <select value={addMemberRole} onChange={e => setAddMemberRole(e.target.value)}
                        className="px-2 py-1 border border-gray-200 rounded text-xs bg-white w-20">
                        <option value="member">成员</option>
                        <option value="editor">编辑</option>
                        <option value="head">负责人</option>
                      </select>
                      <button onClick={addDeptMember} disabled={!addMemberUserId}
                        className="text-indigo-600 disabled:text-gray-300 text-xs font-medium">添加</button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Workgroups */}
      <div>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-sm font-semibold text-gray-800">工作组管理</h3>
          <button onClick={() => { setAddingWg(true); setSelWg(null); setWgForm({ name: '', slug: '', description: '' }); }}
            className="text-xs text-indigo-600 hover:text-indigo-700">+ 添加工作组</button>
        </div>
        <div className="flex gap-0 h-52 border border-gray-200 rounded-lg overflow-hidden">
          <div className="w-52 border-r border-gray-200 overflow-y-auto bg-gray-50/30">
            {wgs.length === 0 && !addingWg && <div className="py-6 text-center text-gray-400 text-xs">暂无工作组</div>}
            {wgs.map(w => (
              <button key={w.id} onClick={() => selectWg(w)}
                className={`w-full text-left px-3 py-2 border-b border-gray-100 text-sm ${selWg?.id === w.id ? 'bg-indigo-50 text-indigo-600' : 'text-gray-700 hover:bg-gray-50'}`}>
                {w.name}
              </button>
            ))}
          </div>
          <div className="flex-1 overflow-y-auto p-3">
            {!selWg && !addingWg ? (
              <div className="h-full flex items-center justify-center text-gray-400 text-xs">选择工作组或创建新工作组</div>
            ) : (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">名称</label>
                    <input value={wgForm.name} onChange={e => setWgForm(p => ({ ...p, name: e.target.value }))}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500" />
                  </div>
                  <div>
                    <label className="text-xs text-gray-500 block mb-0.5">标识 (slug)</label>
                    <input value={wgForm.slug} onChange={e => setWgForm(p => ({ ...p, slug: e.target.value }))} disabled={!!selWg}
                      className="w-full px-2 py-1 border border-gray-200 rounded text-sm outline-none focus:border-indigo-500 disabled:bg-gray-50" />
                  </div>
                </div>
                {addingWg ? (
                  <div className="flex gap-2">
                    <button onClick={saveWg} className="bg-indigo-600 text-white px-3 py-1 rounded text-xs hover:bg-indigo-700">创建</button>
                    <button onClick={() => setAddingWg(false)} className="text-gray-500 text-xs">取消</button>
                  </div>
                ) : selWg && (
                  <>
                    <button onClick={() => deleteWg(selWg.id)} className="text-red-500 text-xs">删除工作组</button>
                    <div className="pt-2 border-t border-gray-200">
                      <span className="text-xs font-medium text-gray-600 block mb-1">成员 ({wgMembers.length})</span>
                      <div className="space-y-1 mb-2 max-h-24 overflow-y-auto">
                        {wgMembers.map(m => (
                          <div key={m.id} className="flex items-center justify-between px-2 py-1 bg-gray-50 rounded text-xs">
                            <span className="text-gray-700">{m.user_name} <span className="text-gray-400">({m.user_email})</span></span>
                            <button onClick={() => removeWgMember(m.id)} className="text-red-400 hover:text-red-600">×</button>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-1">
                        <select value={addWgUserId} onChange={e => setAddWgUserId(e.target.value)}
                          className="flex-1 px-2 py-1 border border-gray-200 rounded text-xs bg-white">
                          <option value="">选择用户...</option>
                          {wgAvailUsers.map(u => <option key={u.id} value={u.id}>{u.name} ({u.email})</option>)}
                        </select>
                        <button onClick={addWgMember} disabled={!addWgUserId}
                          className="text-indigo-600 disabled:text-gray-300 text-xs font-medium">添加</button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
