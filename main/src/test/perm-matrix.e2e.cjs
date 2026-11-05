/**
 * 权限矩阵正反测试（9 条用例）——针对本地实例 http://localhost:8899
 * 每条用例记录 预期/实际/结论。
 */
const BASE = 'http://localhost:8899';
const RUN = Date.now().toString(36);
const results = [];
function rec(id, name, expect, actual, pass, note = '') {
  results.push({ id, name, expect, actual, pass, note });
  console.log(`${pass ? '✓' : '✕'} [${id}] ${name} — ${actual}${note ? ' (' + note + ')' : ''}`);
}
async function api(token, method, path, body) {
  const resp = await fetch(BASE + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  try { data = await resp.json(); } catch {}
  return { status: resp.status, data };
}
async function login(account, password) {
  const r = await api(null, 'POST', '/api/auth/login', { account, password });
  if (!r.data?.token) throw new Error('login failed ' + account + ' ' + JSON.stringify(r.data).slice(0, 120));
  return r.data.token;
}
const { execSync } = require('child_process');
function createSkillAs(name, principalUserId, isAdmin) {
  const js = `
const { DbService } = require('/app/main/dist/db/db.service.js');
const { ConfigService } = require('@nestjs/config');
const { SkillRegistryService } = require('/app/main/dist/capability/skill/skill-registry.service.js');
const { ResourceMetaService } = require('/app/main/dist/platform/authz/resource-meta.service.js');
(async () => {
  const db = new DbService(new ConfigService());
  const ws = { getConfigDir: () => '/workspace/config' };
  const meta = new ResourceMetaService(db, ws);
  const reg = new SkillRegistryService(ws, meta);
  await reg.save({ name: '${name}', description: '权限测试技能(${name})', instructions: '# 测试', allowedTools: [] }, undefined, {
    type: 'user', principalId: 'user:${principalUserId}', userId: '${principalUserId}',
    roleIds: [], departmentIds: [], permissions: ${isAdmin ? "['sys:admin']" : '[]'}, origin: 'http:test', issuedAt: Date.now(),
  });
  console.log('created');
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
`;
  execSync(`docker exec -w /app/main docker_gen-main-1 node -e "${js.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`, { stdio: 'pipe' });
}
async function reloadSkills(token) { await api(token, 'POST', '/api/skills/reload'); }
function delSkill(name) {
  try {
    execSync(`docker exec docker_gen-postgres-1 psql -U postgres -d jianzhi -c "DELETE FROM jz_resource_grants WHERE resource_type='skill' AND resource_id='${name}'; DELETE FROM jz_resource_meta WHERE resource_type='skill' AND resource_id='${name}';"`, { stdio: 'pipe' });
    execSync(`docker exec docker_gen-main-1 rm -rf /workspace/config/skills/${name}`, { stdio: 'pipe' });
  } catch {}
}
function delAgent(id) {
  try {
    execSync(`docker exec docker_gen-postgres-1 psql -U postgres -d jianzhi -c "DELETE FROM jz_resource_grants WHERE resource_type='agent' AND resource_id='${id}'; DELETE FROM jz_resource_meta WHERE resource_type='agent' AND resource_id='${id}';"`, { stdio: 'pipe' });
    execSync(`docker exec docker_gen-main-1 rm -f /workspace/config/agents/${id}.yaml`, { stdio: 'pipe' });
  } catch {}
}

(async () => {
  const admin = await login('admin', 'admin123');
  // 开局幂态清理（防上次中断残留）
  try {
    const users = (await api(admin, 'GET', '/api/users')).data;
    for (const u of users.filter(x => ['perm_t1','perm_t2'].includes(x.username))) await api(admin, 'DELETE', `/api/users/${u.id}`);
    for (const id of []) { delAgent(id); }
    for (const sk of ['skill_permtest_admin','skill_permtest_user','skill_permtest_user_del']) { delSkill(sk); }
    await api(admin, 'POST', '/api/skills/reload');
  } catch (e) { console.log('cleanup warn', e.message); }

  // ---- 准备测试用户 ----
  const mk = async (uname, email) => {
    const r = await api(admin, 'POST', '/api/users', { name: uname, username: uname, email, password: 'Init1234', roleId: 'user' });
    return r.data.id;
  };
  const u1id = await mk('perm_t1', 'perm_t1@test.com');
  const u2id = await mk('perm_t2', 'perm_t2@test.com');
  const u1 = await login('perm_t1@test.com', 'Init1234');
  const u2 = await login('perm_t2@test.com', 'Init1234');

  // ============ T1: 管理员创建智能体，未授权普通用户不可见 ============
  const AG1 = 'adm_permtest_' + RUN;
  await api(admin, 'POST', '/api/agents', { id: AG1, name: '管理员测试智能体', description: 'T1', soul: 'test', modelLevel: 'standard', tools: [] });
  let list = await api(u1, 'GET', '/api/agents');
  rec('T1-反', '管理员创建智能体未授权→普通用户列表不可见', '列表不含', list.data.some(a => a.id === AG1) ? '含(BUG)' : '不含', !list.data.some(a => a.id === AG1));
  let detail = await api(u1, 'GET', `/api/agents/${AG1}`);
  rec('T1-反b', '普通用户直读详情', '403/404', `${detail.status} ${JSON.stringify(detail.data).slice(0, 40)}`, detail.status === 403 || detail.status === 404 || !!detail.data?.error, detail.status === 200 && !detail.data?.error ? '详情接口未做可见性校验，内容泄漏' : '');
  await api(admin, 'PUT', `/api/authz/agent/${AG1}/grants`, { grants: [{ targetType: 'user', targetId: u1id, level: 'user' }] });
  list = await api(u1, 'GET', '/api/agents');
  rec('T1-正', '管理员授权后普通用户可见', '列表含', list.data.some(a => a.id === AG1) ? '含' : '不含', list.data.some(a => a.id === AG1));
  const u2list0 = await api(u2, 'GET', '/api/agents');
  rec('T1-反c', '未被授权的第三个用户仍不可见', '列表不含', u2list0.data.some(a => a.id === AG1) ? '含(BUG)' : '不含', !u2list0.data.some(a => a.id === AG1));

  // ============ T2: 管理员创建技能 ============
  const SK1 = 'skill_permtest_admin_' + RUN;
  createSkillAs(SK1, u1id, true); await reloadSkills(admin);
  // 重新登录刷新 registry? registry 内存即时生效（skills.set）。列表接口查注册表+meta
  let slist = await api(u1, 'GET', '/api/skills');
  rec('T2-反', '管理员创建技能未授权→普通用户列表不可见', '列表不含', slist.data.some(s => s.name === SK1) ? '含(BUG)' : '不含', !slist.data.some(s => s.name === SK1));
  await api(admin, 'PUT', `/api/authz/skill/${SK1}/grants`, { grants: [{ targetType: 'user', targetId: u1id, level: 'user' }] });
  slist = await api(u1, 'GET', '/api/skills');
  rec('T2-正', '管理员授权后普通用户可见', '列表含', slist.data.some(s => s.name === SK1) ? '含' : '不含', slist.data.some(s => s.name === SK1));

  // ============ T3: 普通用户创建智能体 ============
  const AGU = (await api(u1, 'POST', '/api/agents', { id: 'my_agent', name: '用户测试智能体', description: 'T3', soul: 't', modelLevel: 'standard', tools: [] })).data.id;
  let alist = await api(admin, 'GET', '/api/agents');
  const adminView = alist.data.find(a => a.id === AGU);
  rec('T3-正a', '管理员可见他人 user 智能体', '可见 canEdit=false', adminView ? `可见 canEdit=${adminView.canEdit}` : '不可见', !!adminView && adminView.canEdit === false);
  const adminEdit = await api(admin, 'PUT', `/api/agents/${AGU}`, { description: 'admin 篡改' });
  rec('T3-反a', '管理员不可编辑他人 user 智能体', '403', `${adminEdit.status}`, adminEdit.status === 403);
  const adminDel = await api(admin, 'DELETE', `/api/agents/${AGU}`);
  rec('T3-反b', '管理员不可删除他人 user 智能体', '403', `${adminDel.status}`, adminDel.status === 403);
  const ownEdit = await api(u1, 'PUT', `/api/agents/${AGU}`, { description: '自己改' });
  rec('T3-正b', '创建者可编辑', '200', `${ownEdit.status}`, ownEdit.status === 200);
  const ownDel = await api(u1, 'DELETE', `/api/agents/${AGU}`);
  rec('T3-正c', '创建者可删除', '200', `${ownDel.status}`, ownDel.status === 200);
  delAgent(AGU);

  // ============ T4: 普通用户智能体分享 ============
  const AGU2 = (await api(u1, 'POST', '/api/agents', { id: 'share_agent', name: '分享测试智能体', description: 'T4', soul: 't', modelLevel: 'standard', tools: [] })).data.id;
  let u2list = await api(u2, 'GET', '/api/agents');
  rec('T4-反', '分享前其他普通用户不可见', '列表不含', u2list.data.some(a => a.id === AGU2) ? '含(BUG)' : '不含', !u2list.data.some(a => a.id === AGU2));
  await api(u1, 'POST', `/api/authz/agent/${AGU2}/share`, { userIds: [u2id] });
  u2list = await api(u2, 'GET', '/api/agents');
  rec('T4-正', '创建者分享后对方可见', '列表含', u2list.data.some(a => a.id === AGU2) ? '含' : '不含', u2list.data.some(a => a.id === AGU2));
  delAgent(AGU2);

  // ============ T5: 普通用户创建技能 ============
  const SK2 = 'skill_permtest_user_' + RUN;
  createSkillAs(SK2, u1id, false); await reloadSkills(admin);
  let slist5 = await api(admin, 'GET', '/api/skills');
  const adminS = slist5.data.find(s => s.name === SK2);
  rec('T5-正a', '管理员可见他人 user 技能', '可见 canEdit=false', adminS ? `可见 canEdit=${adminS.canEdit}` : '不可见', !!adminS && adminS.canEdit === false);
  const adminSEdit = await api(admin, 'PUT', `/api/skills/${SK2}`, { skill: { description: 'admin 篡改' } });
  rec('T5-反a', '管理员不可编辑他人 user 技能', '403', `${adminSEdit.status}`, adminSEdit.status === 403);
  const adminSDel = await api(admin, 'DELETE', `/api/skills/${SK2}`);
  rec('T5-反b', '管理员不可删除他人 user 技能', '403', `${adminSDel.status}`, adminSDel.status === 403);
  const ownSEdit = await api(u1, 'PUT', `/api/skills/${SK2}`, { skill: { description: '自己改' } });
  rec('T5-正b', '创建者可编辑', '200', `${ownSEdit.status}`, ownSEdit.status === 200);
  // 删除放最后（T6 还需要 user 技能）——T5 删除用独立技能
  const SK3 = 'skill_permtest_del_' + RUN;
  createSkillAs(SK3, u1id, false); await reloadSkills(admin);
  const ownSDel = await api(u1, 'DELETE', `/api/skills/${SK3}`);
  rec('T5-正c', '创建者可删除', '200', `${ownSDel.status}`, ownSDel.status === 200);
  // 回收站写操作仅管理员（对齐 mcp/tools 回收站的 @RequireAdmin）
  const rbRestore = await api(u1, 'POST', '/api/skills/deleted/nonexistent_x/restore');
  rec('T5-反d', '普通用户不可恢复回收站技能', '403', `${rbRestore.status}`, rbRestore.status === 403);
  const rbPurge = await api(u1, 'DELETE', '/api/skills/deleted/nonexistent_x');
  rec('T5-反e', '普通用户不可彻底删除回收站技能', '403', `${rbPurge.status}`, rbPurge.status === 403);
  delSkill(SK3);

  // ============ T6: 普通用户技能分享 ============
  let u2slist = await api(u2, 'GET', '/api/skills');
  rec('T6-反', '分享前其他普通用户不可见', '列表不含', u2slist.data.some(s => s.name === SK2) ? '含(BUG)' : '不含', !u2slist.data.some(s => s.name === SK2));
  await api(u1, 'POST', `/api/authz/skill/${SK2}/share`, { userIds: [u2id] });
  u2slist = await api(u2, 'GET', '/api/skills');
  rec('T6-正', '创建者分享后对方可见', '列表含', u2slist.data.some(s => s.name === SK2) ? '含' : '不含', u2slist.data.some(s => s.name === SK2));
  delSkill(SK2); delSkill(SK1);

  // ============ T7: 连接权限 ============
  const reg1 = await api(u1, 'POST', '/api/mcp/register', { manifest: 'mcp:\n  name: hack_mcp\n  description: x' });
  rec('T7-反a', '普通用户不可创建连接', '403', `${reg1.status}`, reg1.status === 403);
  const pat = await api(u1, 'PATCH', '/api/mcp/garment-erp', { enabled: false });
  rec('T7-反b', '普通用户不可修改连接基本属性', '403', `${pat.status}`, pat.status === 403);
  const del = await api(u1, 'DELETE', '/api/mcp/garment-erp');
  rec('T7-反c', '普通用户不可删除连接', '403', `${del.status}`, del.status === 403);
  const agl = await api(u1, 'GET', '/api/agents');
  const cm = agl.data.find(a => a.id === 'connector_master');
  rec('T7-反d', '普通用户不可调用连接大师（connector_master 不可见）', '列表不含', cm ? '含(BUG)' : '不含', !cm, cm ? '连接大师对普通用户可见，可被调用' : '');
  // 侧栏「连接」面板配对智能体不透出（前端据此并入聊天选择器/自动切换，053 起仅管理员）
  const sbT7 = await api(u1, 'GET', '/api/sidebar');
  const uPanelsT7 = Array.isArray(sbT7.data) ? sbT7.data : sbT7.data?.panels || [];
  const connPanelU = uPanelsT7.find(p => p.id === 'connectors');
  rec('T7-反e', '普通用户连接面板不透出配对智能体', 'agentId 为空', connPanelU?.agentId || '空', !!connPanelU && !connPanelU.agentId, connPanelU?.agentId ? `透出 ${connPanelU.agentId}，普通用户可经面板与连接大师对话` : '');
  const sbT7a = await api(admin, 'GET', '/api/sidebar');
  const aPanelsT7 = Array.isArray(sbT7a.data) ? sbT7a.data : sbT7a.data?.panels || [];
  const connPanelA = aPanelsT7.find(p => p.id === 'connectors');
  rec('T7-正d', '管理员连接面板仍透出 connector_master', 'agentId=connector_master', connPanelA?.agentId || '空', connPanelA?.agentId === 'connector_master');
  // 凭证：仅自己名下
  const cs = await api(u1, 'POST', '/api/skills/credentials/save', { userId: u2id, systemName: 'permtest_sys', credentials: { u: 'a', p: 'b' } });
  rec('T7-正a', '普通用户保存自己的凭证', '200/201', `${cs.status}`, cs.status === 200 || cs.status === 201);
  const cl1 = await api(u1, 'GET', '/api/skills/credentials/list');
  const cl2 = await api(u2, 'GET', '/api/skills/credentials/list');
  const u1has = JSON.stringify(cl1.data).includes('permtest_sys');
  const u2has = JSON.stringify(cl2.data).includes('permtest_sys');
  rec('T7-正b', '凭证仅落在登录用户名下（body.userId 被忽略）', 'u1有/u2无', `u1=${u1has ? '有' : '无'} u2=${u2has ? '有(BUG)' : '无'}`, u1has && !u2has);
  const cdel = await api(u1, 'DELETE', '/api/skills/credentials/permtest_sys');
  rec('T7-正c', '普通用户删除自己的凭证', '200', `${cdel.status}`, cdel.status === 200);

  // ============ T8: 工具级授权 ============
  const mlist0 = await api(admin, 'GET', '/api/mcp');
  const erp = mlist0.data.find(m => m.name === 'garment-erp');
  const tAll = (erp.tools || []).map(t => (typeof t === 'string' ? t : t.name));
  const t1 = tAll[0], t2n = tAll[1];
  console.log('  garment-erp 工具:', tAll.join(','));
  await api(admin, 'PUT', '/api/authz/connector/garment-erp/grants', { grants: [{ targetType: 'user', targetId: u1id, level: 'user', subId: t1 }] });
  const mlistU = await api(u1, 'GET', '/api/mcp');
  const erpU = mlistU.data.find(m => m.name === 'garment-erp');
  const uTools = (erpU?.tools || []).map(t => (typeof t === 'string' ? t : t.name));
  rec('T8-正', '授权子工具后仅见该工具', `仅[${t1}]`, `[${uTools.join(',')}]`, uTools.length === 1 && uTools[0] === t1);
  rec('T8-反', '未授权子工具不可见', `不含${t2n}`, uTools.includes(t2n) ? '含(BUG)' : '不含', !uTools.includes(t2n));
  await api(admin, 'PUT', '/api/authz/connector/garment-erp/grants', { grants: [] });

  // ============ T9: 设置仅管理员可见 ============
  const sbU = await api(u1, 'GET', '/api/sidebar');
  const uIds = (Array.isArray(sbU.data) ? sbU.data : sbU.data?.panels || []).map(p => p.id);
  rec('T9-反', '普通用户侧栏不含设置', '不含 cfg', uIds.includes('cfg') ? '含(BUG)' : '不含', !uIds.includes('cfg'), uIds.includes('cfg') ? 'nav:settings 被迁移 051 回填给了 user 角色' : '');
  const sbA = await api(admin, 'GET', '/api/sidebar');
  const aIds = (Array.isArray(sbA.data) ? sbA.data : sbA.data?.panels || []).map(p => p.id);
  rec('T9-正', '管理员侧栏含设置', '含 cfg', aIds.includes('cfg') ? '含' : '不含', aIds.includes('cfg'));

  // ---- 清理 ----
  await api(admin, 'DELETE', `/api/users/${u1id}`);
  await api(admin, 'DELETE', `/api/users/${u2id}`);
  delAgent(AG1);

  const failed = results.filter(r => !r.pass);
  console.log(`\n═══ 结果: ${results.length - failed.length}/${results.length} 通过, ${failed.length} 失败 ═══`);
  for (const f of failed) console.log(`  ✕ ${f.id} ${f.name}: 实际 ${f.actual}`);
})().catch(e => { console.error('FATAL', e); process.exit(1); });
