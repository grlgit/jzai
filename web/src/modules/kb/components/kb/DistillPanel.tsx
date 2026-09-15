'use client'

import * as React from 'react'
import { io, type Socket } from 'socket.io-client'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { getMainUrl } from '@/lib/env'

// 蒸馏实时进度 socket（/ws/distill，单例）
let distillSocket: Socket | null = null
let distillTok: string | null = null
function getDistillSocket(token: string | null): Socket | null {
  if (typeof window === 'undefined' || !token) return null
  if (distillSocket && token !== distillTok) { distillSocket.disconnect(); distillSocket = null }
  if (distillSocket) return distillSocket
  distillTok = token
  const wsUrl = (process.env.NEXT_PUBLIC_MODE === 'local' && process.env.NEXT_PUBLIC_MAIN_URL) ? process.env.NEXT_PUBLIC_MAIN_URL : ''
  distillSocket = io(`${wsUrl}/ws/distill`, { transports: ['websocket'], auth: { token }, query: { token } })
  return distillSocket
}

/**
 * DistillPanel — 企业心智「专项蒸馏」视图：尤达大师成果动态可见。
 * - 左：蒸馏任务列表（含迷你进度）
 * - 右：选中任务的【动态进度头(轮询 /status)】+ 生命周期分布 + 结果分层卡片 + 内容/打分抽屉
 * - 合并原设置面板的「演练打分 / 回流重写」能力（就地操作）
 * 直接访问主台 /api/distill/*（非 KB 服务）。
 */

const MAIN_URL = getMainUrl()
function authHeaders() {
  const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : ''
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }
}
const get = (p: string) => fetch(`${MAIN_URL}${p}`, { headers: authHeaders() }).then(r => (r.ok ? r.json() : null)).catch(() => null)

interface Run { runId: string; topic: string; status: string; breadthN: number; maxRounds: number; categoryRoot: string; createdAt?: string; finalizedAt?: string }

// 用时格式化（分秒）：从创建到收尾（未收尾则到现在）
function fmtDuration(createdAt?: string, finalizedAt?: string): string {
  if (!createdAt) return '—'
  const start = new Date(createdAt).getTime()
  const end = finalizedAt ? new Date(finalizedAt).getTime() : Date.now()
  let sec = Math.max(0, Math.round((end - start) / 1000))
  const h = Math.floor(sec / 3600); sec -= h * 3600
  const m = Math.floor(sec / 60); const s = sec - m * 60
  return h > 0 ? `${h}时${m}分${s}秒` : m > 0 ? `${m}分${s}秒` : `${s}秒`
}
interface Status {
  runId: string; topic: string; totalNodes: number; budgetMaxNodes: number
  byStatus: Record<string, number>; byRound?: { round: number; n: number }[]; frontier: { nodeId: string; round: number; question: string }[]
  breadthN: number; maxRounds: number; done: boolean
  background?: { running: boolean; processed?: number; failed?: number; elapsedSec?: number; lastError?: string }
  curate?: { running: boolean; phase?: string; polished?: number; merged?: number; total?: number; elapsedSec?: number; lastError?: string }
}
interface Candidate {
  nodeId: string; round: number; question: string; title?: string; content?: string
  resultLayer?: string; artifactType?: string; confidence?: number
  lifecycle: string; version: number; aggScore?: number; ratingCount: number; hasSafetyFlag: boolean; structured?: any
}
interface TreeNode {
  nodeId: string; parentId: string | null; round: number; question: string; title?: string
  resultLayer?: string; artifactType?: string; confidence?: number; lifecycle: string; status: string
}
interface Scores { accuracy: number; usability: number; effectiveness: number; safety: number }

const LIFECYCLE: Record<string, { label: string; cls: string }> = {
  candidate: { label: '候选', cls: 'bg-gray-100 text-gray-500' },
  validating: { label: '验证中', cls: 'bg-blue-50 text-blue-600' },
  live: { label: '已生效', cls: 'bg-green-50 text-green-600' },
  needs_fix: { label: '待优化', cls: 'bg-amber-50 text-amber-600' },
  retired: { label: '已下架', cls: 'bg-gray-100 text-gray-400' },
}
const LAYER_ORDER = ['原理', '领域', '现状', '实操']
const RUN_STATUS: Record<string, string> = { running: '进行中', done: '已收尾', partial: '部分收尾', failed: '失败' }
const runStatusLabel = (s: string) => RUN_STATUS[s] || s
const DIMS: { key: keyof Scores; label: string; hint: string }[] = [
  { key: 'accuracy', label: '准确性', hint: '内容是否正确、无事实错误（≤2 触发安全红线）' },
  { key: 'usability', label: '可用性', hint: '是否好用、贴合真实场景' },
  { key: 'effectiveness', label: '有效性', hint: '是否推进到下一步/促成交' },
  { key: 'safety', label: '安全性', hint: '是否有误导/不当承诺（≤2 触发安全红线）' },
]
const stripFrontmatter = (md: string) => (md || '').replace(/^---[\s\S]*?---\n/, '').trim()

export function DistillPanel() {
  const [runs, setRuns] = React.useState<Run[]>([])
  const [activeRun, setActiveRun] = React.useState<string>('')
  const [status, setStatus] = React.useState<Status | null>(null)
  const [candidates, setCandidates] = React.useState<Candidate[]>([])
  const [selected, setSelected] = React.useState<Candidate | null>(null)
  const [layerTab, setLayerTab] = React.useState<string>('全部')   // 分层视图：上方 TAG 选中的层（'全部' 或某层名）
  const [view, setView] = React.useState<'layer' | 'tree'>('layer')
  const [tree, setTree] = React.useState<TreeNode[]>([])
  const [msg, setMsg] = React.useState('')
  const flash = (m: string) => { setMsg(m); setTimeout(() => setMsg(''), 3500) }

  const loadTree = React.useCallback(async (runId: string) => {
    if (!runId) return
    const t = await get(`/api/distill/runs/${runId}/tree`)
    setTree(Array.isArray(t) ? t : [])
  }, [])

  const loadRuns = React.useCallback(async () => {
    const r = await get('/api/distill/runs')
    const arr: Run[] = Array.isArray(r) ? r : []
    setRuns(arr)
    setActiveRun(cur => cur || (arr[0]?.runId ?? ''))
  }, [])

  const loadRun = React.useCallback(async (runId: string) => {
    if (!runId) return
    const [s, c] = await Promise.all([
      get(`/api/distill/runs/${runId}/status`),
      get(`/api/distill/runs/${runId}/candidates?lifecycle=all`),
    ])
    setStatus(s || null)
    setCandidates(Array.isArray(c) ? c : [])
  }, [])

  React.useEffect(() => { loadRuns() }, [loadRuns])
  React.useEffect(() => { if (activeRun) loadRun(activeRun) }, [activeRun, loadRun])
  React.useEffect(() => { if (activeRun && view === 'tree') loadTree(activeRun) }, [activeRun, view, loadTree])
  // 任务列表定时刷新：尤达对话里新建/正在蒸馏的任务能及时出现在列表
  React.useEffect(() => { const t = setInterval(loadRuns, 8000); return () => clearInterval(t) }, [loadRuns])

  // 兜底轮询：进行中时每 6s 校正一次（WS 负责"蒸一条弹一条"的即时，轮询纠偏计数）
  const active = !!status && (!status.done || !!status.background?.running || !!status.curate?.running)
  React.useEffect(() => {
    if (!activeRun || !active) return
    const t = setInterval(() => { loadRun(activeRun); if (view === 'tree') loadTree(activeRun) }, 6000)
    return () => clearInterval(t)
  }, [activeRun, active, loadRun, view, loadTree])

  // 实时推送：订阅 /ws/distill 的当前任务房间，蒸出一条即插入 + 本地校正进度计数
  React.useEffect(() => {
    if (!activeRun) return
    const token = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null
    const sock = getDistillSocket(token)
    if (!sock) return
    const join = () => sock.emit('distill.watch', { runId: activeRun })
    join()
    sock.on('connect', join) // 重连后重新加入房间
    const onProgress = (p: any) => {
      if (p?.runId !== activeRun || p.type !== 'node' || !p.node) return
      setCandidates(prev => prev.some(c => c.nodeId === p.node.nodeId) ? prev : [p.node as Candidate, ...prev])
      const child = p.childCount || 0
      setStatus(s => s ? {
        ...s,
        totalNodes: s.totalNodes + child,
        byStatus: { ...s.byStatus, expanded: (s.byStatus.expanded || 0) + 1, pending: Math.max(0, (s.byStatus.pending || 0) - 1 + child) },
      } : s)
    }
    sock.on('distill.progress', onProgress)
    return () => { sock.emit('distill.unwatch', { runId: activeRun }); sock.off('distill.progress', onProgress); sock.off('connect', join) }
  }, [activeRun])

  const onScored = (gate: any) => { flash(`评分已记录：${gate.hint || gate.lifecycle}`); loadRun(activeRun); setSelected(null) }
  const refine = async (nodeId: string) => {
    const res = await fetch(`${MAIN_URL}/api/distill/nodes/${nodeId}/refine`, { method: 'POST', headers: authHeaders() })
    if (!res.ok) { flash(res.status === 403 ? '需要知识审核权限' : '回流失败'); return }
    const r = await res.json()
    flash(`已回流重写 → v${r.version}，回候选态待重新验证`)
    loadRun(activeRun)
  }

  // 批量入库：一键把该专项全部可发布候选直发企业心智（跳过逐条评分，需审核权限）
  const [busy, setBusy] = React.useState<'' | 'publish' | 'curate'>('')
  const batchPublish = async () => {
    if (!activeRun) return
    if (!window.confirm('把本专项【全部候选】一键发布到企业心智正式检索？此操作跳过逐条实战评分，需知识审核权限。')) return
    setBusy('publish')
    const res = await fetch(`${MAIN_URL}/api/distill/runs/${activeRun}/batch-publish`, { method: 'POST', headers: authHeaders() })
    const r = await res.json().catch(() => null)
    setBusy('')
    if (!res.ok) { flash(res.status === 403 ? '需要知识审核权限' : '批量入库失败'); return }
    flash(`已入库 ${r.published}/${r.total}${r.failed?.length ? `，失败 ${r.failed.length}` : ''}`)
    loadRun(activeRun)
  }
  // AI 整理精炼：后台两段式（逐篇精炼 + 按层合并主文档）
  const curate = async () => {
    if (!activeRun) return
    if (!window.confirm('对本专项做 AI 整理精炼？将逐篇精炼候选并按层合并成主文档（后台运行，需审核权限）。')) return
    setBusy('curate')
    const res = await fetch(`${MAIN_URL}/api/distill/runs/${activeRun}/curate`, { method: 'POST', headers: authHeaders(), body: JSON.stringify({}) })
    const r = await res.json().catch(() => null)
    setBusy('')
    if (!res.ok) { flash(res.status === 403 ? '需要知识审核权限' : '启动失败'); return }
    flash(r?.started ? `已启动整理精炼（待精炼 ${r.total}）` : r?.alreadyRunning ? '整理精炼已在进行' : (r?.reason === 'nothing_to_curate' ? '没有可整理的候选' : r?.reason === 'background_expanding' ? '后台展开中，稍后再试' : '未启动'))
    loadRun(activeRun)
  }
  // 停止整理精炼（当前条跑完即停）
  const stopCurate = async () => {
    if (!activeRun) return
    const res = await fetch(`${MAIN_URL}/api/distill/runs/${activeRun}/curate/stop`, { method: 'POST', headers: authHeaders() })
    if (!res.ok) { flash(res.status === 403 ? '需要知识审核权限' : '停止失败'); return }
    flash('已请求停止（当前条跑完即停）')
    loadRun(activeRun)
  }

  // 删除未生效任务
  const delRun = async (runId: string, topic: string, e: React.MouseEvent) => {
    e.stopPropagation()
    if (!window.confirm(`删除蒸馏任务「${topic}」？仅未生效任务可删，删除不可恢复。`)) return
    const res = await fetch(`${MAIN_URL}/api/distill/runs/${runId}`, { method: 'DELETE', headers: authHeaders() })
    const r = await res.json().catch(() => null)
    if (!res.ok || !r?.deleted) { flash(r?.reason || (res.status === 403 ? '需要知识审核权限' : '删除失败')); return }
    flash('任务已删除')
    if (activeRun === runId) { setActiveRun(''); setStatus(null); setCandidates([]) }
    loadRuns()
  }
  // 删除单条未生效内容
  const delNode = async (nodeId: string) => {
    if (!window.confirm('删除这条未生效内容？不可恢复。')) return
    const res = await fetch(`${MAIN_URL}/api/distill/nodes/${nodeId}`, { method: 'DELETE', headers: authHeaders() })
    const r = await res.json().catch(() => null)
    if (!res.ok || !r?.deleted) { flash(r?.reason || '删除失败'); return }
    flash('已删除')
    setCandidates(prev => prev.filter(c => c.nodeId !== nodeId))
    setSelected(s => (s?.nodeId === nodeId ? null : s))
  }

  // 生命周期分布
  const lifeCounts = candidates.reduce((a, c) => { a[c.lifecycle] = (a[c.lifecycle] || 0) + 1; return a }, {} as Record<string, number>)
  // 按结果层分组（固定顺序 + 其余）
  const byLayer = candidates.reduce((a, c) => { const l = c.resultLayer || '未分层'; (a[l] = a[l] || []).push(c); return a }, {} as Record<string, Candidate[]>)
  const layers = [...LAYER_ORDER.filter(l => byLayer[l]), ...Object.keys(byLayer).filter(l => !LAYER_ORDER.includes(l))]
  // 分层 TAG 选中的层（失效时回退到"全部"）
  const activeLayer = (layerTab === '全部' || layers.includes(layerTab)) ? layerTab : '全部'
  const shownLayers = activeLayer === '全部' ? layers : [activeLayer]

  const expanded = status?.byStatus?.expanded ?? 0
  const total = status?.totalNodes ?? 0
  const pending = status?.byStatus?.pending ?? 0
  const pct = total ? Math.round((expanded / total) * 100) : 0
  const bgRunning = !!status?.background?.running   // 有后台蒸馏任务在跑：进度行高亮，否则浅灰

  return (
    <div className="h-full flex text-sm">
      {/* 左：任务列表 */}
      <div className="w-64 shrink-0 border-r border-gray-100 flex flex-col">
        <div className="px-4 py-3 border-b border-gray-100">
          <div className="font-semibold flex items-center gap-1.5">🧪 专项蒸馏</div>
          <div className="text-[11px] text-gray-400 mt-0.5">尤达大师成果 · 动态可见</div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {runs.length === 0 && <div className="p-4 text-xs text-gray-400">暂无蒸馏任务。在对话里让「尤达大师」蒸一套专项知识库。</div>}
          {runs.map(r => (
            <div key={r.runId} onClick={() => { setActiveRun(r.runId); setSelected(null) }}
              className={`group relative w-full text-left px-4 py-2.5 border-b border-gray-50 hover:bg-gray-50 cursor-pointer ${activeRun === r.runId ? 'bg-indigo-50' : ''}`}>
              <div className="font-medium truncate pr-6">{r.topic}</div>
              <div className="text-[11px] text-gray-400 mt-0.5">{runStatusLabel(r.status)} · N{r.breadthN}/d{r.maxRounds}</div>
              <button onClick={(e) => delRun(r.runId, r.topic, e)} title="删除（仅未生效）"
                className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 text-gray-300 hover:text-red-500 text-sm leading-none">🗑</button>
            </div>
          ))}
        </div>
      </div>

      {/* 右：详情 */}
      <div className="flex-1 overflow-y-auto">
        {msg && <div className="m-3 text-xs text-indigo-600 bg-indigo-50 rounded px-3 py-2">{msg}</div>}
        {!activeRun ? (
          <div className="text-center text-gray-300 py-24"><div className="text-4xl mb-3">🧙</div><div>选择或新建一个蒸馏任务</div></div>
        ) : (
          <div className="p-5 space-y-5 max-w-4xl">
            {/* 动态进度头 */}
            <div className="border border-gray-200 rounded-xl p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="font-semibold">{status?.topic || runs.find(r => r.runId === activeRun)?.topic}</div>
                {status?.background?.running
                  ? <span className="text-xs text-emerald-600 flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />后台展开中 · 已处理 {status.background.processed ?? 0} · {status.background.elapsedSec ?? 0}s</span>
                  : <span className="text-xs text-gray-400">{status?.done ? '✅ 队列已空' : `待展开 ${pending}`}</span>}
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-indigo-400 transition-all" style={{ width: `${pct}%` }} />
              </div>
              <div className={`text-[11px] mt-1.5 -mx-1.5 px-1.5 py-0.5 rounded transition-colors ${bgRunning ? 'text-emerald-700 bg-emerald-50 font-medium' : 'text-gray-300'}`}>
                节点 {expanded}/{total}（{pct}%） · 待展开 {pending} · 预算 {status?.budgetMaxNodes ?? '—'} · N{status?.breadthN}/d{status?.maxRounds}
                {status?.background?.failed ? ` · 跳过 ${status.background.failed}` : ''}
                {(() => { const r = runs.find(x => x.runId === activeRun); return r?.createdAt ? ` · 用时 ${fmtDuration(r.createdAt, r.finalizedAt)}` : ''; })()}
              </div>
              {/* 各深度(层级)统计：D1(n) D2(n) … */}
              <div className="flex flex-wrap gap-1.5 mt-2">
                {(status?.byRound?.length)
                  ? status.byRound.map(r => <span key={r.round} className="text-[11px] px-2 py-0.5 rounded bg-gray-50 text-gray-500 border border-gray-100">D{r.round}({r.n})</span>)
                  : <span className="text-[11px] text-gray-300">暂无节点</span>}
              </div>
              {/* AI 整理精炼进度 + 停止 */}
              {status?.curate?.running && (
                <div className="text-[11px] mt-2 px-2 py-1 rounded bg-violet-50 text-violet-700 flex items-center gap-1.5">
                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-violet-500 animate-pulse" />
                  AI 整理精炼中 · {status.curate.phase === 'merge' ? `按层合并主文档（已合并 ${status.curate.merged ?? 0}）` : `逐篇精炼 ${status.curate.polished ?? 0}/${status.curate.total ?? 0}`} · {status.curate.elapsedSec ?? 0}s
                  <button onClick={stopCurate} className="ml-auto px-2 py-0.5 rounded bg-white text-red-500 border border-red-200 hover:bg-red-50">停止</button>
                </div>
              )}
              {/* 生命周期分布 + 操作 + 视图切换 */}
              <div className="flex flex-wrap items-center gap-1.5 mt-3">
                {(['candidate', 'validating', 'live', 'needs_fix'] as const).map(k => (
                  <span key={k} className={`text-[11px] px-2 py-0.5 rounded-full ${LIFECYCLE[k].cls}`}>{LIFECYCLE[k].label} {lifeCounts[k] || 0}</span>
                ))}
                <button onClick={batchPublish} disabled={!!busy}
                  className="text-[11px] px-2.5 py-1 rounded bg-green-50 text-green-700 hover:bg-green-100 disabled:opacity-40"
                  title="把全部候选一键发布到企业心智（跳过逐条评分，需审核权限）">
                  {busy === 'publish' ? '入库中…' : '全部入库'}
                </button>
                <button onClick={curate} disabled={!!busy || !!status?.curate?.running}
                  className="text-[11px] px-2.5 py-1 rounded bg-violet-50 text-violet-700 hover:bg-violet-100 disabled:opacity-40"
                  title="AI 整理精炼：逐篇精炼 + 按层合并主文档（后台运行，需审核权限）">
                  {busy === 'curate' ? '启动中…' : 'AI整理精炼'}
                </button>
                <div className="ml-auto flex rounded-md border border-gray-200 overflow-hidden">
                  {(['layer', 'tree'] as const).map(v => (
                    <button key={v} onClick={() => setView(v)}
                      className={`text-[11px] px-2.5 py-1 ${view === v ? 'bg-indigo-500 text-white' : 'text-gray-500 hover:bg-gray-50'}`}>
                      {v === 'layer' ? '分层' : '问题树'}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            {/* 视图：问题树 */}
            {view === 'tree' ? (
              <DistillTree tree={tree} candidates={candidates} active={active}
                onOpen={(nodeId) => { const c = candidates.find(c => c.nodeId === nodeId); if (c) setSelected(c); else flash('该节点待展开/已剪枝，暂无内容'); }} />
            ) : /* 视图：结果分层 */
            candidates.length === 0 ? (
              <div className="text-center text-gray-300 py-12">
                {active ? '🔄 蒸馏进行中，成果将陆续出现…' : '暂无已生成内容'}
              </div>
            ) : (
            <>
              {/* 层 TAG：上方可选，点击筛选该层 */}
              <div className="flex flex-wrap gap-1.5 mb-1">
                {['全部', ...layers].map(l => {
                  const cnt = l === '全部' ? candidates.length : byLayer[l].length
                  const on = activeLayer === l
                  return (
                    <button key={l} onClick={() => setLayerTab(l)}
                      className={`text-xs px-3 py-1 rounded-full border transition-colors ${on ? 'bg-indigo-500 text-white border-indigo-500' : 'bg-white text-gray-500 border-gray-200 hover:bg-gray-50'}`}>
                      {l === '全部' ? '全部' : `${l}层`} {cnt}
                    </button>
                  )
                })}
              </div>
              {shownLayers.map(layer => (
              <div key={layer}>
                {activeLayer === '全部' && <div className="text-xs font-semibold text-gray-400 mb-2">{layer}层（{byLayer[layer].length}）</div>}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  {byLayer[layer].map(c => (
                    <div key={c.nodeId} className="border border-gray-100 rounded-lg p-3 hover:border-indigo-200 hover:shadow-sm transition">
                      <div className="flex items-center justify-between gap-2">
                        <button onClick={() => setSelected(c)} className="text-left font-medium truncate flex-1">{c.title || c.question}</button>
                        <Badge lifecycle={c.lifecycle} />
                      </div>
                      <div className="text-[11px] text-gray-400 mt-1">
                        {c.artifactType} · 置信 {(c.confidence ?? 0).toFixed(2)} · 均分 {c.aggScore != null ? c.aggScore.toFixed(2) : '—'}（{c.ratingCount}评）{c.hasSafetyFlag ? ' · ⚠️安全红线' : ''}
                      </div>
                      <div className="flex gap-2 mt-2">
                        {(c.lifecycle === 'candidate' || c.lifecycle === 'validating') && (
                          <button onClick={() => setSelected(c)} className="text-[11px] px-2 py-1 bg-indigo-50 text-indigo-600 rounded hover:bg-indigo-100">演练打分</button>
                        )}
                        {c.lifecycle === 'needs_fix' && (
                          <button onClick={() => refine(c.nodeId)} className="text-[11px] px-2 py-1 bg-amber-50 text-amber-700 rounded hover:bg-amber-100">回流重写</button>
                        )}
                        <button onClick={() => setSelected(c)} className="text-[11px] px-2 py-1 text-gray-400 hover:text-gray-600">查看</button>
                        {c.lifecycle !== 'live' && (
                          <button onClick={() => delNode(c.nodeId)} className="text-[11px] px-2 py-1 text-gray-300 hover:text-red-500 ml-auto" title="删除（未生效）">删除</button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
              ))}
            </>
            )}
          </div>
        )}
      </div>

      {selected && <ScoreCard candidate={selected} onClose={() => setSelected(null)} onScored={onScored} flash={flash} />}
    </div>
  )
}

function Badge({ lifecycle }: { lifecycle: string }) {
  const l = LIFECYCLE[lifecycle] || LIFECYCLE.candidate
  return <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${l.cls}`}>{l.label}</span>
}

function StructuredView({ s }: { s: any }) {
  if (!s || typeof s !== 'object') return null
  const kind = s.kind
  return (
    <div className="mt-2 border border-indigo-100 bg-indigo-50/40 rounded-lg p-2.5 text-xs">
      <div className="text-indigo-500 font-medium mb-1">工具规格 · {kind}</div>
      {kind === 'checklist' && <ul className="list-disc list-inside space-y-0.5">{(s.items || []).map((i: any, n: number) => <li key={n}>{typeof i === 'string' ? i : (i.label || i.text || JSON.stringify(i))}</li>)}</ul>}
      {kind === 'script' && <ol className="list-decimal list-inside space-y-0.5">{(s.steps || []).map((i: any, n: number) => <li key={n}>{typeof i === 'string' ? i : (i.label || i.text || JSON.stringify(i))}</li>)}</ol>}
      {kind === 'scorecard' && <div className="space-y-0.5">{(s.dimensions || []).map((d: any, n: number) => <div key={n}>· {d.name}（满分 {d.max ?? 5}）</div>)}</div>}
      {kind === 'form' && <div className="space-y-0.5">{(s.fields || []).map((f: any, n: number) => <div key={n}>· {typeof f === 'string' ? f : (f.label || f.name)}</div>)}</div>}
    </div>
  )
}

function nodeTag(n: TreeNode): { label: string; cls: string } {
  if (n.status === 'pending') return { label: '待展开', cls: 'bg-gray-100 text-gray-400' }
  if (n.status === 'pruned') return { label: '剪枝', cls: 'bg-gray-100 text-gray-300' }
  return LIFECYCLE[n.lifecycle] || LIFECYCLE.candidate
}

function DistillTree({ tree, active, onOpen }: { tree: TreeNode[]; candidates: Candidate[]; active: boolean; onOpen: (nodeId: string) => void }) {
  const childrenOf = React.useMemo(() => {
    const m: Record<string, TreeNode[]> = {}
    for (const n of tree) { const k = n.parentId || '__root__'; (m[k] = m[k] || []).push(n) }
    return m
  }, [tree])
  if (tree.length === 0) return <div className="text-center text-gray-300 py-12">{active ? '🔄 蒸馏进行中，问题树将逐步展开…' : '暂无问题树'}</div>
  const roots = childrenOf['__root__'] || []
  return <div className="text-[13px]">{roots.map(n => <TreeRow key={n.nodeId} node={n} depth={0} childrenOf={childrenOf} onOpen={onOpen} />)}</div>
}

function TreeRow({ node, depth, childrenOf, onOpen }: { node: TreeNode; depth: number; childrenOf: Record<string, TreeNode[]>; onOpen: (nodeId: string) => void }) {
  const kids = childrenOf[node.nodeId] || []
  const [open, setOpen] = React.useState(depth < 1)
  const tag = nodeTag(node)
  const hasContent = node.status === 'expanded'
  return (
    <div>
      <div className="flex items-center gap-1.5 py-1 hover:bg-gray-50 rounded" style={{ paddingLeft: depth * 16 }}>
        <button onClick={() => setOpen(o => !o)} className={`w-4 shrink-0 text-gray-400 ${kids.length ? '' : 'invisible'}`}>{open ? '▾' : '▸'}</button>
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full shrink-0 ${tag.cls}`}>{tag.label}</span>
        <button onClick={() => hasContent && onOpen(node.nodeId)}
          className={`truncate flex-1 text-left ${hasContent ? 'hover:text-indigo-600 cursor-pointer' : 'cursor-default'} ${node.status === 'pruned' ? 'line-through text-gray-300' : node.status === 'pending' ? 'text-gray-400' : ''}`}
          title={node.question}>
          {node.title || node.question}
        </button>
        {hasContent && node.resultLayer && <span className="text-[10px] text-gray-400 shrink-0">{node.resultLayer}/{node.artifactType}</span>}
        {kids.length > 0 && <span className="text-[10px] text-gray-300 shrink-0">{kids.length}</span>}
      </div>
      {open && kids.map(k => <TreeRow key={k.nodeId} node={k} depth={depth + 1} childrenOf={childrenOf} onOpen={onOpen} />)}
    </div>
  )
}

function ScoreCard({ candidate, onClose, onScored, flash }: {
  candidate: Candidate; onClose: () => void; onScored: (gate: any) => void; flash: (m: string) => void
}) {
  const editable = candidate.lifecycle === 'candidate' || candidate.lifecycle === 'validating'
  const [scores, setScores] = React.useState<Scores>({ accuracy: 3, usability: 3, effectiveness: 3, safety: 3 })
  const [scenario, setScenario] = React.useState('')
  const [comment, setComment] = React.useState('')
  const [submitting, setSubmitting] = React.useState(false)

  const submit = async () => {
    setSubmitting(true)
    const res = await fetch(`${MAIN_URL}/api/distill/nodes/${candidate.nodeId}/feedback`, {
      method: 'POST', headers: authHeaders(),
      body: JSON.stringify({ scores, scenario: scenario || undefined, comment: comment || undefined }),
    })
    setSubmitting(false)
    if (!res.ok) { flash('提交失败'); return }
    onScored(await res.json())
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl flex flex-col resize overflow-hidden shadow-2xl"
        style={{ width: 'min(92vw, 820px)', height: 'min(88vh, 660px)', minWidth: 380, minHeight: 320, maxWidth: '95vw', maxHeight: '92vh' }}
        onClick={e => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b border-gray-100 flex items-center justify-between">
          <div>
            <div className="font-semibold">{candidate.title || candidate.question}</div>
            <div className="text-xs text-gray-400 mt-0.5">{candidate.resultLayer}层 · {candidate.artifactType} · v{candidate.version}</div>
          </div>
          <Badge lifecycle={candidate.lifecycle} />
        </div>

        <div className="flex-1 overflow-y-auto grid grid-cols-2">
          <div className="p-5 border-r border-gray-100 overflow-y-auto">
            <div className="text-xs font-semibold text-gray-400 mb-2">内容</div>
            <div className="prose prose-sm prose-gray max-w-none text-[13px] leading-relaxed [&_h1]:text-base [&_h2]:text-sm [&_h3]:text-[13px] [&_p]:my-1.5 [&_ul]:my-1.5 [&_ul]:pl-5 [&_ul]:list-disc [&_ol]:my-1.5 [&_ol]:pl-5 [&_ol]:list-decimal [&_li]:my-0.5 [&_table]:w-full [&_table]:border-collapse [&_table]:border [&_table]:border-gray-200 [&_th]:bg-gray-50 [&_th]:border [&_th]:border-gray-200 [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_td]:border [&_td]:border-gray-200 [&_td]:px-2 [&_td]:py-1 [&_code]:text-indigo-600 [&_code]:bg-indigo-50 [&_code]:px-1 [&_code]:rounded [&_pre]:bg-gray-900 [&_pre]:text-gray-100 [&_pre]:rounded-lg [&_pre]:p-2.5 [&_pre]:overflow-x-auto [&_blockquote]:border-l-2 [&_blockquote]:border-indigo-300 [&_blockquote]:pl-3 [&_blockquote]:text-gray-600">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{stripFrontmatter(candidate.content || '')}</ReactMarkdown>
            </div>
            {candidate.structured && <StructuredView s={candidate.structured} />}
          </div>
          <div className="p-5 overflow-y-auto space-y-4">
            {editable ? (
              <>
                <div className="text-xs text-gray-400">在 CoWorker 里模拟运用一遍后打分。达标(均分≥4 且≥3评)自动生效；准确性/安全性≤2 一票否决。</div>
                {DIMS.map(d => (
                  <div key={d.key}>
                    <div className="flex items-center justify-between"><label className="text-sm font-medium">{d.label}</label><span className="text-sm text-indigo-600 font-mono">{scores[d.key]}</span></div>
                    <div className="text-xs text-gray-400 mb-1">{d.hint}</div>
                    <input type="range" min={1} max={5} value={scores[d.key]} className="w-full" onChange={e => setScores(s => ({ ...s, [d.key]: Number(e.target.value) }))} />
                  </div>
                ))}
                <div><label className="text-xs font-medium text-gray-500">场景（可选）</label><input value={scenario} onChange={e => setScenario(e.target.value)} className="w-full mt-1 border border-gray-200 rounded px-2 py-1.5 text-sm" /></div>
                <div><label className="text-xs font-medium text-gray-500">评语（可选）</label><textarea value={comment} onChange={e => setComment(e.target.value)} rows={2} className="w-full mt-1 border border-gray-200 rounded px-2 py-1.5 text-sm" /></div>
              </>
            ) : (
              <div className="text-sm text-gray-400">该内容当前为「{LIFECYCLE[candidate.lifecycle]?.label || candidate.lifecycle}」，均分 {candidate.aggScore != null ? candidate.aggScore.toFixed(2) : '—'}（{candidate.ratingCount} 评）。{candidate.lifecycle === 'live' ? '已进入企业心智正式检索。' : ''}</div>
            )}
          </div>
        </div>

        <div className="px-6 py-3 border-t border-gray-100 flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-500 hover:bg-gray-50 rounded-lg">关闭</button>
          {editable && <button onClick={submit} disabled={submitting} className="px-4 py-2 text-sm bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-40">{submitting ? '提交中…' : '提交评分'}</button>}
        </div>
      </div>
    </div>
  )
}
