'use client'

import * as React from 'react'
import { Brain, ScrollText, BookOpen, Plus, FileText, Trash2, Loader2, User, Sparkles, Upload } from 'lucide-react'
import { NoteEditor } from '../editor/NoteEditor'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { confirmDialog } from '@/components/AppDialog'
import { cn } from '../../lib/utils'
import type { DocumentListItem, WikiNode } from '../../lib/types'

type MindTab = 'character' | 'rules' | 'knowledge' | 'personal'

const LAYER_LIMITS = {
  character: { maxDocs: 3, maxChars: 8000 },
  rules: { maxDocs: 10, maxChars: 20000 },
}

const TAB_CONFIG: Record<MindTab, {
  icon: React.ReactNode
  label: string
  description: string
  path: string
}> = {
  character: {
    icon: <Brain className="size-4" />,
    label: '企业文化',
    description: '企业的使命、愿景和核心价值观。智能体会理解并内化这些文化理念，体现在沟通风格和决策原则中。',
    path: '/wiki/_character/',
  },
  rules: {
    icon: <ScrollText className="size-4" />,
    label: '行为准则',
    description: '设定操作规范和安全边界。行为准则追加到系统提示词，约束AI的行为边界。',
    path: '/wiki/_rules/',
  },
  knowledge: {
    icon: <BookOpen className="size-4" />,
    label: '知识',
    description: '企业的产品资料、技术文档、制度文件等。知识层按需检索，不占用系统提示词配额。',
    path: '/wiki/',
  },
  personal: {
    icon: <User className="size-4" />,
    label: '个人知识',
    description: '仅您可见的个人知识库。可手动编辑，也可从对话中保存有价值的内容。',
    path: '/wiki/_personal/',
  },
}

interface Props {
  kbId: string
  kbSlug: string
  characterDocs: DocumentListItem[]
  rulesDocs: DocumentListItem[]
  personalRawDocs: DocumentListItem[]
  personalWikiDocs: DocumentListItem[]
  wikiDocs: DocumentListItem[]
  wikiTree: WikiNode[]
  documents: DocumentListItem[]
  onCreateNote: (path: string) => Promise<void>
  onDeleteDocument: (docId: string) => Promise<void>
  onRefetch: () => void | Promise<void>
  onSwitchToWiki: (path?: string) => void
  onUpload?: () => void
}

function getToken(): string | null {
  if (typeof window === 'undefined') return null
  return localStorage.getItem('jz_token')
}

export function EnterpriseMindEditor({
  kbId,
  kbSlug,
  characterDocs,
  rulesDocs,
  personalRawDocs,
  personalWikiDocs,
  wikiDocs,
  wikiTree,
  documents,
  onCreateNote,
  onDeleteDocument,
  onRefetch,
  onSwitchToWiki,
  onUpload,
}: Props) {
  const [activeTab, setActiveTab] = React.useState<MindTab>('knowledge')
  const [personalSubView, setPersonalSubView] = React.useState<'raw' | 'wiki'>('raw')
  const [compiling, setCompiling] = React.useState(false)
  const [selectedDocId, setSelectedDocId] = React.useState<string | null>(null)
  const [docContent, setDocContent] = React.useState<{ content: string; title: string; tags: string[]; date: string | null } | null>(null)
  const [loadingContent, setLoadingContent] = React.useState(false)

  // Current layer docs
  const personalDocs = personalSubView === 'raw' ? personalRawDocs : personalWikiDocs
  const layerDocs = activeTab === 'character' ? characterDocs : activeTab === 'rules' ? rulesDocs : activeTab === 'personal' ? personalDocs : wikiDocs
  const limits = (activeTab === 'knowledge' || activeTab === 'personal') ? null : LAYER_LIMITS[activeTab]

  // 记录"本会话已尝试播种过的 (kbId, tab)"，防止 refetch 落地前 effect 重复触发导致重复建档（Identity 2/General 2）
  const seededRef = React.useRef<Set<string>>(new Set())

  // Auto-seed default content when character or rules tab is empty
  React.useEffect(() => {
    if (activeTab === 'knowledge' || activeTab === 'personal' || layerDocs.length > 0) return
    const t = getToken()
    if (!t) return

    // 一次性守卫：同一 (kbId, tab) 只尝试一次，无论 refetch 是否已把新文档刷回来
    const seedKey = `${kbId}:${activeTab}`
    if (seededRef.current.has(seedKey)) return
    seededRef.current.add(seedKey)

    const seeds: Record<string, { filename: string; title: string; content: string }> = {
      character: {
        filename: 'identity.md',
        title: '企业文化',
        content: '---\ntitle: 企业文化\ndescription: 企业使命、愿景与核心价值观\ntags:\n  - character\n  - culture\n---\n\n# 企业文化\n\n## 使命\n[请填写企业使命]\n\n## 愿景\n[请填写企业愿景]\n\n## 核心价值观\n- 诚信：以诚待人，言出必行\n- 创新：拥抱变化，持续改进\n- 协作：开放共享，团队至上\n- 卓越：追求品质，精益求精\n\n## 文化理念\n[请填写企业的文化理念]\n',
      },
      rules: {
        filename: 'general.md',
        title: '行为准则',
        content: '---\ntitle: 行为准则\ndescription: AI助手的通用操作规则和安全边界\ntags:\n  - rules\n  - general\n---\n\n# 行为准则\n\n## 回答规范\n1. 引用企业心智内容时标注来源文档\n2. 涉及数字、日期、规格等关键信息务必核实\n3. 不确定的内容明确标注"待确认"\n4. 多条信息时使用结构化格式（列表、表格）\n\n## 安全边界\n1. 不透露内部系统架构或配置细节\n2. 不代替人工做最终审批决策\n3. 涉及合同、法律、财务问题建议咨询专业人员\n4. 不对外部人员披露企业内部信息\n',
      },
    }

    const seed = seeds[activeTab]
    if (!seed) { seededRef.current.delete(seedKey); return }

    apiFetch<DocumentListItem>(
      `/v1/knowledge-bases/${kbId}/documents/note`, t,
      { method: 'POST', body: JSON.stringify({ filename: seed.filename, path: TAB_CONFIG[activeTab].path, title: seed.title, content: seed.content }) },
    )
      .then(() => onRefetch())
      .catch(() => { seededRef.current.delete(seedKey) /* 失败则释放守卫，用户可手动重试 */ })
  }, [activeTab, layerDocs.length, kbId, onRefetch])

  // Auto-select first doc when switching tabs
  React.useEffect(() => {
    if (layerDocs.length > 0 && (!selectedDocId || !layerDocs.find(d => d.id === selectedDocId))) {
      setSelectedDocId(layerDocs[0].id)
    } else if (layerDocs.length === 0) {
      setSelectedDocId(null)
      setDocContent(null)
    }
  }, [activeTab, layerDocs, selectedDocId])

  // Load doc content when selection changes
  React.useEffect(() => {
    if (!selectedDocId) { setDocContent(null); return }
    const t = getToken()
    if (!t) return
    setLoadingContent(true)
    apiFetch<{ content: string; title: string; tags: string[]; date: string | null }>(
      `/v1/documents/${selectedDocId}/content`, t,
    )
      .then((data) => setDocContent(data))
      .catch(() => setDocContent(null))
      .finally(() => setLoadingContent(false))
  }, [selectedDocId])

  // Capacity calculation
  const totalChars = layerDocs.reduce((sum, d) => {
    // Estimate from file_size or use a rough estimate
    return sum + (d.file_size || 0)
  }, 0)

  const handleCreate = async () => {
    if (limits && layerDocs.length >= limits.maxDocs) {
      toast.error(`${TAB_CONFIG[activeTab].label}层已达上限 (${limits.maxDocs} 篇)`)
      return
    }
    // Personal tab creates in raw/ subdirectory
    const createPath = activeTab === 'personal'
      ? TAB_CONFIG[activeTab].path.replace(/\/$/, '/raw/')
      : TAB_CONFIG[activeTab].path
    await onCreateNote(createPath)
    onRefetch()
  }

  const handleDelete = async (docId: string) => {
    if (!(await confirmDialog('确定要删除这篇文档吗？', { danger: true }))) return
    await onDeleteDocument(docId)
    if (selectedDocId === docId) setSelectedDocId(null)
    onRefetch()
  }

  // Knowledge tab: switch to wiki view
  if (activeTab === 'knowledge') {
    return (
      <div className="h-full flex flex-col">
        {/* Tab bar */}
        <TabBar activeTab={activeTab} onTabChange={setActiveTab} characterCount={characterDocs.length} rulesCount={rulesDocs.length} knowledgeCount={wikiDocs.length} personalCount={personalRawDocs.length + personalWikiDocs.length} />
        {/* Knowledge layer description */}
        <div className="px-6 py-4 border-b border-border/50 bg-muted/30">
          <p className="text-sm text-muted-foreground">{TAB_CONFIG.knowledge.description}</p>
        </div>
        {/* Show wiki tree summary and link to wiki view */}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center space-y-4 max-w-md">
            <BookOpen className="size-12 mx-auto text-muted-foreground/40" />
            <div>
              <p className="text-lg font-medium">{wikiDocs.length} 篇知识文档</p>
              <p className="text-sm text-muted-foreground mt-1">
                {documents.filter(d => !d.path.startsWith('/wiki/') && !d.archived).length} 篇来源文档
              </p>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => onSwitchToWiki()}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 transition-colors"
              >
                <BookOpen className="size-4" />
                进入知识浏览
              </button>
              <p className="text-xs text-muted-foreground mt-2">上传来源文档请点击左侧「来源文档」，选择分类目录后上传</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      {/* Tab bar */}
      <TabBar activeTab={activeTab} onTabChange={setActiveTab} characterCount={characterDocs.length} rulesCount={rulesDocs.length} knowledgeCount={wikiDocs.length} personalCount={personalRawDocs.length + personalWikiDocs.length} />

      {/* Layer description */}
      <div className="px-6 py-3 border-b border-border/50 bg-muted/30">
        <p className="text-sm text-muted-foreground">{TAB_CONFIG[activeTab].description}</p>
        {activeTab === 'personal' && (
          <div className="flex items-center gap-1 mt-2">
            <button
              onClick={() => { setPersonalSubView('raw'); setSelectedDocId(null) }}
              className={cn('px-2.5 py-1 rounded text-xs font-medium transition-colors', personalSubView === 'raw' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50')}
            >
              原始资料 ({personalRawDocs.length})
            </button>
            <button
              onClick={() => { setPersonalSubView('wiki'); setSelectedDocId(null) }}
              className={cn('px-2.5 py-1 rounded text-xs font-medium transition-colors', personalSubView === 'wiki' ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted/50')}
            >
              个人百科 ({personalWikiDocs.length})
            </button>
            <div className="flex-1" />
            <button
              onClick={() => {
                if (compiling) return
                const t = getToken()
                if (!t) return
                setCompiling(true)
                apiFetch<{ success: boolean; message?: string; error?: string }>(
                  '/personal-knowledge/compile', t, { method: 'POST' },
                )
                  .then((d) => {
                    toast.success(d.message || '整理完成')
                    setPersonalSubView('wiki')
                    setSelectedDocId(null)
                    onRefetch()
                  })
                  .catch((err) => toast.error(err instanceof Error ? err.message : '整理失败'))
                  .finally(() => setCompiling(false))
              }}
              disabled={compiling || personalRawDocs.length === 0}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {compiling ? <Loader2 className="size-3 animate-spin" /> : <Sparkles className="size-3" />}
              整理为百科
            </button>
          </div>
        )}
      </div>

      {/* Two-pane: doc list + editor */}
      <div className="flex-1 flex min-h-0">
        {/* Left: document list */}
        <div className="w-56 shrink-0 border-r border-border/50 flex flex-col">
          <div className="flex-1 overflow-y-auto p-2 space-y-1">
            {layerDocs.map((doc) => (
              <button
                key={doc.id}
                onClick={() => setSelectedDocId(doc.id)}
                className={cn(
                  'w-full flex items-center gap-2 px-3 py-2 rounded-md text-sm text-left transition-colors group',
                  selectedDocId === doc.id
                    ? 'bg-accent text-accent-foreground'
                    : 'hover:bg-muted/50 text-foreground/80',
                )}
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate flex-1">{doc.title || doc.filename}</span>
                <button
                  onClick={(e) => { e.stopPropagation(); handleDelete(doc.id) }}
                  className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-opacity"
                >
                  <Trash2 className="size-3" />
                </button>
              </button>
            ))}

            {layerDocs.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                暂无文档
              </div>
            )}
          </div>

          {/* Create button + capacity */}
          <div className="p-3 border-t border-border/50 space-y-2">
            {(limits || (activeTab === 'personal' && personalSubView === 'raw')) && (
              <button
                onClick={handleCreate}
                disabled={limits ? layerDocs.length >= limits.maxDocs : false}
                className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                <Plus className="size-3.5" />
                新建文档
              </button>
            )}
            {limits && (
              <div className="space-y-1">
                <CapacityBar
                  label="篇数"
                  current={layerDocs.length}
                  max={limits.maxDocs}
                />
                <CapacityBar
                  label="字符"
                  current={totalChars}
                  max={limits.maxChars}
                  formatValue={(v) => v >= 1000 ? `${(v / 1000).toFixed(1)}K` : String(v)}
                />
              </div>
            )}
          </div>
        </div>

        {/* Right: editor */}
        <div className="flex-1 min-w-0">
          {loadingContent ? (
            <div className="flex items-center justify-center h-full">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          ) : selectedDocId && docContent ? (
            <NoteEditor
              key={selectedDocId}
              documentId={selectedDocId}
              initialContent={docContent.content}
              initialTitle={docContent.title}
              initialTags={docContent.tags}
              initialDate={docContent.date}
              embedded
            />
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
              {layerDocs.length === 0 ? '点击"新建文档"开始编辑' : '选择左侧文档进行编辑'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Tab bar ──────────────────────────────────────────────────────────────

function TabBar({ activeTab, onTabChange, characterCount, rulesCount, knowledgeCount, personalCount }: {
  activeTab: MindTab
  onTabChange: (tab: MindTab) => void
  characterCount: number
  rulesCount: number
  knowledgeCount: number
  personalCount: number
}) {
  // 「企业文化」「行为准则」入口暂隐藏，相关逻辑（种子、容量限制等）保留备后用
  const tabs: { id: MindTab; count: number }[] = [
    { id: 'knowledge', count: knowledgeCount },
    { id: 'personal', count: personalCount },
  ]
  void characterCount
  void rulesCount

  return (
    <div className="flex items-center gap-1 px-4 py-2 border-b border-border/50">
      {tabs.map(({ id, count }) => {
        const cfg = TAB_CONFIG[id]
        const active = activeTab === id
        return (
          <button
            key={id}
            onClick={() => onTabChange(id)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors',
              active
                ? 'bg-accent text-accent-foreground'
                : 'text-muted-foreground hover:text-foreground hover:bg-muted/50',
            )}
          >
            {cfg.icon}
            {cfg.label}
            {count > 0 && (
              <span className={cn(
                'text-[10px] px-1.5 py-0.5 rounded-full',
                active ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
              )}>
                {count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}

// ── Capacity bar ─────────────────────────────────────────────────────────

function CapacityBar({ label, current, max, formatValue }: {
  label: string
  current: number
  max: number
  formatValue?: (v: number) => string
}) {
  const pct = Math.min(100, (current / max) * 100)
  const fmt = formatValue || String
  const warn = pct > 80

  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-[10px] text-muted-foreground">
        <span>{label}</span>
        <span className={warn ? 'text-amber-500 font-medium' : ''}>{fmt(current)} / {fmt(max)}</span>
      </div>
      <div className="h-1 rounded-full bg-muted overflow-hidden">
        <div
          className={cn('h-full rounded-full transition-all', warn ? 'bg-amber-500' : 'bg-primary/50')}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  )
}
