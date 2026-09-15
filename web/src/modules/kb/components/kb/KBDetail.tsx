'use client'

import * as React from 'react'
// useSearchParams replaced with local state for embedded panel mode
import { motion, AnimatePresence } from 'framer-motion'
import { Upload as UploadIcon, BookOpen, Loader2, Search, CheckCircle2, XCircle, FileUp, X, Sparkles, PanelLeftOpen } from 'lucide-react'
import * as tus from 'tus-js-client'
import { useKBDocuments } from '../../hooks/useKBDocuments'
import { apiFetch } from '../../lib/api'
import { toast } from 'sonner'
import { KBSidenav } from './KBSidenav'
import { FilesGrid } from './FilesGrid'
import { GraphViewer } from './GraphViewer'
import { SelectionActionBar } from './SelectionActionBar'
import { SearchView } from './SearchView'
import { WikiContent } from '../wiki/WikiContent'
import { EnterpriseMindEditor } from './EnterpriseMindEditor'
import { DistillPanel } from './DistillPanel'
import type { DocumentListItem, WikiNode } from '../../lib/types'

export type ViewMode = 'wiki' | 'files' | 'graph' | 'mind' | 'distill'

import { getMainUrl, getKbDirectUrl } from '@/lib/env';
const API_URL = getMainUrl() + '/api/kb';
const MAIN_API = getMainUrl();
const KB_DIRECT_URL = getKbDirectUrl();


/** Build WikiNode tree from jz_kb_categories (main platform) */
function buildTreeFromCategories(categories: { id: string; parent_id?: string | null; name: string; path: string }[]): WikiNode[] {
  const roots = categories.filter(c => !c.parent_id);
  const childrenOf = (pid: string) => categories.filter(c => c.parent_id === pid);
  const build = (cat: typeof categories[0]): WikiNode => {
    const children = childrenOf(cat.id).map(build);
    return {
      title: cat.name,
      // Use special path so WikiTreeNode renders it clickable and triggers upload guide
      path: `__category__:${cat.name}`,
      children: children.length > 0 ? children : undefined,
    };
  };
  return roots.map(build);
}

/** Merge category tree into doc tree — add category dirs that don't have docs yet */
function mergeCategoryTree(docTree: WikiNode[], catTree: WikiNode[]): WikiNode[] {
  if (!catTree.length) return docTree;
  // Create a map of existing doc tree top-level titles
  const existing = new Map(docTree.map(n => [n.title, n]));
  for (const catNode of catTree) {
    const match = existing.get(catNode.title);
    if (match) {
      // Recursively merge children
      if (catNode.children?.length) {
        match.children = mergeCategoryTree(match.children || [], catNode.children);
      }
    } else {
      // Add category as empty directory
      docTree.push(catNode);
    }
  }
  return docTree;
}

function buildTreeFromDocs(docs: DocumentListItem[]): WikiNode[] {
  const ORDER_MAP: Record<string, number> = {
    'overview': 0, 'concepts': 1, 'entities': 2, 'comparisons': 3, 'log': 99,
    '概览': 0, '概念': 1, '实体': 2, '对比': 3, '日志': 99,
  }
  const sortKey = (n: WikiNode) => {
    const slug = n.path?.replace(/\.(md|txt|json)$/, '').split('/').pop() ?? ''
    const title = n.title.toLowerCase()
    return ORDER_MAP[slug] ?? ORDER_MAP[title] ?? 50
  }
  const sortNodes = (nodes: WikiNode[]) => {
    nodes.sort((a, b) => {
      const oa = sortKey(a), ob = sortKey(b)
      if (oa !== ob) return oa - ob
      return a.title.localeCompare(b.title)
    })
  }

  // Build a nested map: each directory level maps folder names to children
  interface TreeEntry {
    doc?: { title: string; path: string; docNumber: number | null }
    children: Map<string, TreeEntry>
  }
  const root: TreeEntry = { children: new Map() }

  const sorted = [...docs].sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
  for (const doc of sorted) {
    const relative = (doc.path + doc.filename).replace(/^\/wiki\/?/, '')
    const parts = relative.split('/')
    const title =
      doc.title ||
      parts[parts.length - 1].replace(/\.(md|txt|json)$/, '').replace(/[-_]/g, ' ')

    if (parts.length === 1) {
      // Top-level file (e.g. 概览.md)
      const slug = parts[0].replace(/\.(md|txt|json)$/, '')
      if (!root.children.has(slug)) root.children.set(slug, { children: new Map() })
      root.children.get(slug)!.doc = { title, path: relative, docNumber: doc.document_number }
    } else {
      // Nested file — walk/create intermediate directories
      let current = root
      for (let i = 0; i < parts.length - 1; i++) {
        const folder = parts[i]
        if (!current.children.has(folder)) current.children.set(folder, { children: new Map() })
        current = current.children.get(folder)!
      }
      const filename = parts[parts.length - 1].replace(/\.(md|txt|json)$/, '')
      if (!current.children.has(filename)) current.children.set(filename, { children: new Map() })
      current.children.get(filename)!.doc = { title, path: relative, docNumber: doc.document_number }
    }
  }

  // Convert the nested map into WikiNode[]
  const OVERVIEW_KEYS = new Set(['overview', '概览', '总览'])
  function toNodes(entry: TreeEntry): WikiNode[] {
    const nodes: WikiNode[] = []
    for (const [key, child] of entry.children) {
      const isFolder = child.children.size > 0

      // For folder entries without their own doc, check if there's an
      // "overview" child and promote it as the folder's clickable page.
      if (isFolder && !child.doc) {
        for (const ovKey of OVERVIEW_KEYS) {
          const ovEntry = child.children.get(ovKey)
          if (ovEntry?.doc) {
            child.doc = { title: key.replace(/[-_]/g, ' '), path: ovEntry.doc.path, docNumber: ovEntry.doc.docNumber }
            child.children.delete(ovKey)
            break
          }
        }
      }

      const childNodes = toNodes(child)
      const node: WikiNode = {
        title: child.doc?.title ?? key.replace(/[-_]/g, ' '),
        path: child.doc?.path,
        docNumber: child.doc?.docNumber ?? null,
      }
      if (childNodes.length > 0) {
        node.children = childNodes
      }
      nodes.push(node)
    }
    sortNodes(nodes)
    return nodes
  }

  return toNodes(root)
}

function enrichTreeWithDocNumbers(tree: WikiNode[], docs: DocumentListItem[]): WikiNode[] {
  const pathToDocNumber = new Map<string, number | null>()
  for (const doc of docs) {
    const relative = (doc.path + doc.filename).replace(/^\/wiki\/?/, '')
    pathToDocNumber.set(relative, doc.document_number)
  }
  function enrich(nodes: WikiNode[]): WikiNode[] {
    return nodes.map((node) => ({
      ...node,
      docNumber: node.path ? (pathToDocNumber.get(node.path) ?? null) : null,
      children: node.children ? enrich(node.children) : undefined,
    }))
  }
  return enrich(tree)
}

function findFirstPath(nodes: WikiNode[]): { path: string; docNumber: number | null } | null {
  for (const node of nodes) {
    if (node.path) return { path: node.path, docNumber: node.docNumber ?? null }
    if (node.children) {
      const found = findFirstPath(node.children)
      if (found) return found
    }
  }
  return null
}

type Props = {
  kbId: string
  kbSlug: string
  kbName: string
  viewMode: ViewMode
  routeFilesPath: string
}

export function KBDetail({ kbId, kbSlug, kbName, viewMode, routeFilesPath }: Props) {
  // Local params state (replaces useSearchParams for embedded panel mode)
  const [localParams, setLocalParams] = React.useState<Record<string, string>>({})
  const searchParams = { get: (k: string) => localParams[k] ?? null }

  const token = 'internal' // auth handled by api.ts
  const userId = 'local-user'
  const { documents, setDocuments, loading, refetchDocuments } = useKBDocuments(kbId)

  // Admin check for destructive operations (clear wiki)
  const isAdmin = React.useMemo(() => {
    try {
      const u = JSON.parse(localStorage.getItem('jz_user') || '{}')
      const role = typeof u.role === 'string' ? u.role : u.role?.id
      return role === 'admin'
    } catch { return false }
  }, [])

  // ─── Wiki compilation status ────────────────────────────────
  const [compiling, setCompiling] = React.useState(false)
  const [compilingPages, setCompilingPages] = React.useState<string[]>([])

  React.useEffect(() => {
    // Listen for kb_compiling action from compile_wiki tool
    const onAction = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.actionType === 'kb_compiling') {
        setCompiling(true)
        setCompilingPages([])
      }
    }
    // Listen for tool calls — detect wiki writes by tool name
    const onTool = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.toolName === 'write' && compiling) {
        const result = detail?.result
        const text = typeof result === 'string' ? result : result?.content?.[0]?.text || ''
        if (text.includes('/wiki/')) {
          setCompilingPages((prev) => [...prev, text.substring(0, 60)])
          refetchDocuments()
        }
      }
    }
    // Listen for stream done — stop compiling
    const onDone = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (detail?.done && compiling) {
        setTimeout(() => {
          setCompiling(false)
          refetchDocuments()
        }, 1500)
      }
    }
    window.addEventListener('jianzhi:agent-action', onAction)
    window.addEventListener('jianzhi:tool', onTool)
    window.addEventListener('jianzhi:stream-done', onDone)
    return () => {
      window.removeEventListener('jianzhi:agent-action', onAction)
      window.removeEventListener('jianzhi:tool', onTool)
      window.removeEventListener('jianzhi:stream-done', onDone)
    }
  }, [refetchDocuments, compiling])

  // Auto-clear compiling state after timeout (fallback)
  React.useEffect(() => {
    if (compiling) {
      // Periodically refetch while compiling
      const interval = setInterval(refetchDocuments, 5000)
      // Auto-stop after 3 minutes max
      const timeout = setTimeout(() => { setCompiling(false); refetchDocuments() }, 180000)
      return () => { clearInterval(interval); clearTimeout(timeout) }
    }
  }, [compiling, compilingPages.length, refetchDocuments])

  const updateParam = React.useCallback((key: string, value: string | null) => {
    setLocalParams(prev => {
      const next = { ...prev }
      if (value != null) next[key] = value
      else delete next[key]
      return next
    })
  }, [])

  const navigateToView = React.useCallback((view: ViewMode, opts?: { filesPath?: string; searchParams?: Record<string, string> }) => {
    // In embedded panel mode, just update local state (no URL changes)
    setLocalParams(opts?.searchParams ?? {})
  }, [])

  // ─── Document splits ─────────────────────────────────────────
  const characterDocs = React.useMemo(
    () => documents.filter((d) => d.path.startsWith('/wiki/_character/') && !d.archived && d.file_type === 'md'),
    [documents],
  )
  const rulesDocs = React.useMemo(
    () => documents.filter((d) => d.path.startsWith('/wiki/_rules/') && !d.archived && d.file_type === 'md'),
    [documents],
  )
  const personalRawDocs = React.useMemo(
    () => documents.filter((d) => d.path.includes('/_personal/') && d.path.includes('/raw/') && !d.archived && d.file_type === 'md'),
    [documents],
  )
  const personalWikiDocs = React.useMemo(
    () => documents.filter((d) => d.path.includes('/_personal/') && d.path.includes('/wiki/') && !d.archived && d.file_type === 'md'),
    [documents],
  )
  const wikiDocs = React.useMemo(
    () => documents.filter((d) => (d.path === '/wiki/' || d.path.startsWith('/wiki/')) && !d.path.startsWith('/wiki/_') && !d.archived && d.file_type === 'md'),
    [documents],
  )
  const sourceDocs = React.useMemo(
    () => documents.filter((d) => !d.path.startsWith('/wiki/') && !d.archived),
    [documents],
  )

  // Determine if compilation is needed (for smart compile button display)
  const needsCompilation = React.useMemo(() => {
    if (sourceDocs.length === 0) return false
    if (wikiDocs.length === 0) return true // No wiki pages yet
    if (wikiDocs.some((d) => (d as any).stale_since != null)) return true // Stale pages exist
    // Check if any source is newer than the newest wiki page
    const newestWiki = Math.max(...wikiDocs.map((d) => new Date(d.updated_at).getTime()))
    return sourceDocs.some((d) => new Date(d.updated_at).getTime() > newestWiki)
  }, [sourceDocs, wikiDocs])

  const wikiExists = wikiDocs.length > 0

  // ─── View state ──────────────────────────────────────────────
  // activeView tracks the current tab. Initialized from the viewMode prop
  // (path segment) and kept in sync when the prop changes (back/forward).
  const [activeView, setActiveView] = React.useState<ViewMode | 'doc'>(viewMode)
  // 左侧导航折叠 + 悬浮：折叠后只留细条，hover 浮出完整导航
  const [navCollapsed, setNavCollapsed] = React.useState<boolean>(() => { try { return localStorage.getItem('kb_nav_collapsed') === '1' } catch { return false } })
  const [navFloat, setNavFloat] = React.useState(false)
  React.useEffect(() => { try { localStorage.setItem('kb_nav_collapsed', navCollapsed ? '1' : '0') } catch { /* ignore */ } }, [navCollapsed])
  React.useEffect(() => { setActiveView(viewMode) }, [viewMode])

  const filesViewActive = activeView === 'files' || activeView === 'doc'
  const graphViewActive = activeView === 'graph'

  // ─── Wiki page selection (from ?p= search param) ─────────────
  const pParam = searchParams.get('p')
  const urlWikiDocNumber = pParam ? parseInt(pParam, 10) : null

  const [wikiActivePath, setWikiActivePath] = React.useState<string | null>(null)
  const lastWikiDocNumberRef = React.useRef<number | null>(urlWikiDocNumber)

  // Initialize wikiActivePath from ?p= on mount and when ?p= changes
  React.useEffect(() => {
    if (urlWikiDocNumber == null) return
    if (!documents.length) return
    const doc = documents.find((d) => d.document_number === urlWikiDocNumber)
    if (doc) {
      const path = (doc.path + doc.filename).replace(/^\/wiki\/?/, '')
      setWikiActivePath(path)
      lastWikiDocNumberRef.current = urlWikiDocNumber
    }
  }, [urlWikiDocNumber, documents])

  // ─── Source doc selection ────────────────────────────────────
  // Read ?doc= only on mount (for bookmarked URLs / browser back-forward)
  const initialDocParam = React.useRef(searchParams.get('doc'))
  const initialDocNumber = initialDocParam.current ? parseInt(initialDocParam.current, 10) : null

  const [activeSourceDocId, setActiveSourceDocId] = React.useState<string | null>(() => {
    if (initialDocNumber == null) return null
    const doc = documents.find((d) => d.document_number === initialDocNumber)
    return doc?.id ?? null
  })

  // Resolve initial ?doc= once documents load
  React.useEffect(() => {
    if (initialDocNumber == null || activeSourceDocId) return
    const doc = documents.find((d) => d.document_number === initialDocNumber)
    if (doc) {
      setActiveSourceDocId(doc.id)
      setActiveView('doc')
    }
  }, [initialDocNumber, documents, activeSourceDocId])

  const [filesInitialPage, setFilesInitialPage] = React.useState<number | undefined>()

  // ─── Graph state ─────────────────────────────────────────────
  const [graphFocusNodeId, setGraphFocusNodeId] = React.useState<string | null>(null)

  // ─── Search state ───────────────────────────────────────────
  const [searchActive, setSearchActive] = React.useState(false)
  const [searchQuery, setSearchQuery] = React.useState('')

  // ─── Wiki tree ───────────────────────────────────────────────
  const indexDoc = wikiDocs.find((d) => d.filename === 'index.json' && d.path === '/wiki/')
  const SCAFFOLD_FILES = new Set(['index.json'])
  const [wikiTree, setWikiTree] = React.useState<WikiNode[]>([])
  const [kbCategories, setKbCategories] = React.useState<{ name: string; path: string }[]>([])
  const hasNavigableWiki = React.useMemo(
    () => wikiTree.length > 0 || wikiDocs.some((d) => d.path === '/wiki/' ? !SCAFFOLD_FILES.has(d.filename) : true),
    [wikiDocs, wikiTree],
  )
  const [indexLoaded, setIndexLoaded] = React.useState(false)

  const wikiDocIds = React.useMemo(() => wikiDocs.map((d) => d.id).join(), [wikiDocs])

  React.useEffect(() => {
    let cancelled = false
    setIndexLoaded(false)

    // Fetch categories from main platform to merge into wiki tree
    const fetchCategories = async (): Promise<{ tree: WikiNode[]; flat: { name: string; path: string }[] }> => {
      try {
        const jzToken = typeof window !== 'undefined' ? localStorage.getItem('jz_token') : null
        if (!jzToken) return { tree: [], flat: [] }
        const res = await fetch(`${MAIN_API}/api/kb/categories`, {
          headers: { Authorization: `Bearer ${jzToken}` },
        })
        if (!res.ok) return { tree: [], flat: [] }
        const cats = await res.json()
        if (!Array.isArray(cats)) return { tree: [], flat: [] }
        return {
          tree: buildTreeFromCategories(cats),
          flat: cats.map((c: any) => ({ name: c.name, path: c.path })),
        }
      } catch { return { tree: [], flat: [] } }
    }

    const buildTree = async () => {
      const { tree: catTree, flat: catFlat } = await fetchCategories()
      if (!cancelled) setKbCategories(catFlat)
      let docTree: WikiNode[]

      if (indexDoc && token) {
        try {
          const res = await apiFetch<{ content: string }>(`/v1/documents/${indexDoc.id}/content`, token)
          const parsed = JSON.parse(res.content)
          docTree = enrichTreeWithDocNumbers(parsed.tree || [], wikiDocs)
        } catch {
          docTree = buildTreeFromDocs(wikiDocs.filter((d) => d.id !== indexDoc.id))
        }
      } else {
        docTree = buildTreeFromDocs(wikiDocs)
      }

      if (!cancelled) {
        setWikiTree(mergeCategoryTree(docTree, catTree))
        setIndexLoaded(true)
      }
    }

    buildTree()
    return () => { cancelled = true }
  }, [indexDoc?.id, token, wikiDocIds, wikiDocs])

  // Auto-select first wiki page when none is selected
  React.useEffect(() => {
    if (indexLoaded && activeView === 'wiki' && !wikiActivePath && urlWikiDocNumber == null && wikiTree.length && !loading) {
      const first = findFirstPath(wikiTree)
      if (first) {
        setWikiActivePath(first.path)
        lastWikiDocNumberRef.current = first.docNumber
        if (first.docNumber != null) updateParam('p', String(first.docNumber))
      }
    }
  }, [indexLoaded, wikiTree, wikiActivePath, activeView, urlWikiDocNumber, loading, updateParam])

  // ─── Wiki content loading ────────────────────────────────────
  const [pageContent, setPageContent] = React.useState('')
  const [pageTitle, setPageTitle] = React.useState('')
  const [pageLoading, setPageLoading] = React.useState(false)
  const [pageLoadedPath, setPageLoadedPath] = React.useState<string | null>(null)

  const activeWikiDoc = React.useMemo(() => {
    if (!wikiActivePath) return null
    return wikiDocs.find((d) => {
      const relative = (d.path + d.filename).replace(/^\/wiki\/?/, '')
      return relative === wikiActivePath
    }) ?? null
  }, [wikiActivePath, wikiDocs])

  const activeWikiVersion = activeWikiDoc?.version ?? -1
  const activeWikiDocId = activeWikiDoc?.id ?? null

  React.useEffect(() => {
    if (!wikiActivePath || !token) {
      setPageLoadedPath(null)
      return
    }
    if (!activeWikiDoc) {
      setPageContent(`页面未找到: ${wikiActivePath}`)
      setPageTitle('')
      setPageLoadedPath(wikiActivePath)
      return
    }
    setPageTitle(activeWikiDoc.title || activeWikiDoc.filename.replace(/\.(md|txt)$/, ''))
    const isLiveUpdate = pageLoadedPath === wikiActivePath
    if (!isLiveUpdate) {
      setPageLoading(true)
      setPageLoadedPath(null)
    }
    const controller = new AbortController()
    apiFetch<{ content: string }>(`/v1/documents/${activeWikiDoc.id}/content`, token, { signal: controller.signal })
      .then((res) => {
        if (!controller.signal.aborted) setPageContent(res.content || '')
      })
      .catch((err) => {
        if (!controller.signal.aborted) setPageContent('页面内容加载失败。')
      })
      .finally(() => {
        if (!controller.signal.aborted) {
          setPageLoading(false)
          setPageLoadedPath(wikiActivePath)
        }
      })
    return () => controller.abort()
  }, [wikiActivePath, token, activeWikiDocId, activeWikiVersion])

  // ─── Token helper ────────────────────────────────────────────
  const getToken = () => {
    return 'internal' // auth handled by api.ts
  }

  // ─── Multi-selection ─────────────────────────────────────────
  const [selectedIds, setSelectedIds] = React.useState<Set<string>>(new Set())
  const lastSelectedIdRef = React.useRef<string | null>(null)
  const sourceDocIds = React.useMemo(() => sourceDocs.map((d) => d.id), [sourceDocs])

  const handleSelect = React.useCallback((docId: string, e: React.MouseEvent) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (e.shiftKey && lastSelectedIdRef.current) {
        const lastIdx = sourceDocIds.indexOf(lastSelectedIdRef.current)
        const currIdx = sourceDocIds.indexOf(docId)
        if (lastIdx !== -1 && currIdx !== -1) {
          const [start, end] = lastIdx < currIdx ? [lastIdx, currIdx] : [currIdx, lastIdx]
          for (let i = start; i <= end; i++) next.add(sourceDocIds[i])
        } else {
          next.add(docId)
        }
      } else if (e.metaKey || e.ctrlKey) {
        if (next.has(docId)) next.delete(docId)
        else next.add(docId)
      } else {
        next.clear()
        next.add(docId)
      }
      lastSelectedIdRef.current = docId
      return next
    })
  }, [sourceDocIds])

  const clearSelection = React.useCallback(() => {
    setSelectedIds(new Set())
    lastSelectedIdRef.current = null
  }, [])

  React.useEffect(() => {
    if (selectedIds.size === 0) return
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') clearSelection() }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [selectedIds.size, clearSelection])

  const handleDeleteSelected = async () => {
    const t = getToken()
    if (!t) return
    const ids = Array.from(selectedIds)
    if (!window.confirm(`确定删除 ${ids.length} 个文档？`)) return
    const results = await Promise.allSettled(ids.map((id) => apiFetch(`/v1/documents/${id}`, t, { method: 'DELETE' })))
    const succeeded = ids.filter((_, i) => results[i].status === 'fulfilled')
    const failed = ids.filter((_, i) => results[i].status === 'rejected')
    if (succeeded.length > 0) setDocuments((prev) => prev.filter((d) => !succeeded.includes(d.id)))
    if (failed.length > 0) toast.error(`删除 ${failed.length} 个文档失败`)
    clearSelection()
  }

  // ─── Navigation handlers ─────────────────────────────────────

  const [emptyCategoryName, setEmptyCategoryName] = React.useState<string | null>(null)

  // Wiki page click: only updates ?p= search param (instant, no route change)
  const handleWikiSelect = React.useCallback((path: string, docNumber?: number | null) => {
    setSearchActive(false)
    // Handle category click (no real document) — show upload guide
    if (path.startsWith('__empty_category__:') || path.startsWith('__category__:')) {
      const catName = path.replace('__empty_category__:', '').replace('__category__:', '')
      setEmptyCategoryName(catName)
      setActiveView('wiki')
      setWikiActivePath(path) // Keep it set so sidenav highlights the node
      return
    }
    setEmptyCategoryName(null)
    setActiveView('wiki')
    setWikiActivePath(path)
    const num = docNumber ?? wikiDocs.find((d) => {
      const relative = (d.path + d.filename).replace(/^\/wiki\/?/, '')
      return relative === path
    })?.document_number ?? null
    lastWikiDocNumberRef.current = num
    if (num != null) updateParam('p', String(num))
  }, [updateParam, wikiDocs])

  const handleFilesToggle = React.useCallback(() => {
    setSearchActive(false)
    if (activeView === 'doc') {
      // Doc is open — close it, go to root file browser
      setActiveSourceDocId(null)
      setActiveView('files')
      navigateToView('files')
    } else if (activeView === 'files') {
      // Already browsing files — toggle back to wiki
      const sp = lastWikiDocNumberRef.current != null
        ? { p: String(lastWikiDocNumberRef.current) }
        : undefined
      setActiveView('wiki')
      navigateToView('wiki', { searchParams: sp })
    } else {
      // From wiki/graph — switch to files
      setActiveView('files')
      navigateToView('files')
    }
  }, [activeView, navigateToView])

  const handleGraphToggle = React.useCallback(() => {
    setSearchActive(false)
    if (graphViewActive) {
      const sp = lastWikiDocNumberRef.current != null
        ? { p: String(lastWikiDocNumberRef.current) }
        : undefined
      navigateToView('wiki', { searchParams: sp })
    } else {
      setActiveView('graph')
      setGraphFocusNodeId(null)
      navigateToView('graph')
    }
  }, [graphViewActive, navigateToView])

  const handleGraphNodeClick = React.useCallback((docId: string, sourceKind: string) => {
    const doc = documents.find((d) => d.id === docId)
    if (!doc) return
    if (sourceKind === 'wiki') {
      const wikiPath = (doc.path + doc.filename).replace(/^\/wiki\/?/, '')
      setActiveView('wiki')
      setWikiActivePath(wikiPath)
      lastWikiDocNumberRef.current = doc.document_number
      navigateToView('wiki', { searchParams: doc.document_number != null ? { p: String(doc.document_number) } : undefined })
      return
    }
    setActiveSourceDocId(doc.id)
    setActiveView('doc')
    navigateToView('files', { searchParams: doc.document_number != null ? { doc: String(doc.document_number) } : undefined })
  }, [documents, navigateToView])

  const handleOpenSourceDoc = React.useCallback((docId: string) => {
    const doc = documents.find((d) => d.id === docId)
    if (!doc) return
    setActiveSourceDocId(doc.id)
    setActiveView('doc')
    if (doc.document_number != null) {
      navigateToView('files', { searchParams: { doc: String(doc.document_number) } })
    }
  }, [documents, navigateToView])

  const handleCitationSourceClick = React.useCallback((filename: string, page?: number) => {
    const lower = filename.toLowerCase()
    const match = sourceDocs.find((d) => {
      const fn = d.filename.toLowerCase()
      const title = (d.title || '').toLowerCase()
      return fn === lower || title === lower || fn === lower + '.md' || fn.replace(/\.md$/, '') === lower
    })
    if (!match) return
    setActiveSourceDocId(match.id)
    setActiveView('doc')
    setFilesInitialPage(page)
    if (match.document_number != null) {
      navigateToView('files', { searchParams: { doc: String(match.document_number) } })
    }
  }, [sourceDocs, navigateToView])

  const handlePageGraphClick = React.useCallback(() => {
    if (!activeWikiDocId) return
    setActiveView('graph')
    setGraphFocusNodeId(activeWikiDocId)
    navigateToView('graph')
  }, [activeWikiDocId, navigateToView])

  const wikiPathSet = React.useMemo(() => {
    const set = new Set<string>()
    for (const d of wikiDocs) {
      const relative = (d.path + d.filename).replace(/^\/wiki\/?/, '')
      set.add(relative)
    }
    return set
  }, [wikiDocs])

  const handleWikiNavigate = React.useCallback(
    (path: string) => {
      let nextPath = decodeURIComponent(path)
      if (nextPath.startsWith('/wiki/')) {
        nextPath = nextPath.replace(/^\/wiki\/?/, '')
      } else if (nextPath.startsWith('/')) {
        nextPath = nextPath.slice(1)
      } else if (wikiPathSet.has(nextPath)) {
        // already an exact match
      } else if (wikiActivePath) {
        const dir = wikiActivePath.includes('/')
          ? wikiActivePath.substring(0, wikiActivePath.lastIndexOf('/'))
          : ''
        let resolved = nextPath.startsWith('./')
          ? (dir ? dir + '/' : '') + nextPath.slice(2)
          : (dir ? dir + '/' : '') + nextPath
        while (resolved.includes('../')) {
          resolved = resolved.replace(/[^/]*\/\.\.\//, '')
        }
        nextPath = resolved
      }
      setWikiActivePath(nextPath)
      const doc = wikiDocs.find((d) => {
        const relative = (d.path + d.filename).replace(/^\/wiki\/?/, '')
        return relative === nextPath
      })
      lastWikiDocNumberRef.current = doc?.document_number ?? null
      if (doc?.document_number != null) updateParam('p', String(doc.document_number))
    },
    [wikiActivePath, wikiPathSet, updateParam, wikiDocs],
  )


  // ─── Document CRUD ───────────────────────────────────────────
  const handleCreateNote = async (targetPath: string = '/') => {
    const t = getToken()
    if (!t || !userId) return
    try {
      const data = await apiFetch<DocumentListItem>(`/v1/knowledge-bases/${kbId}/documents/note`, t, {
        method: 'POST',
        body: JSON.stringify({ filename: 'Untitled.md', path: targetPath }),
      })
      setDocuments((prev) => [data, ...prev])
      if (!filesViewActive) {
        setActiveView('files')
        navigateToView('files')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '创建笔记失败')
    }
  }

  const handleCreateFolder = (folderName: string, parentPath: string = '/') => {
    const t = getToken()
    if (!t || !userId) return
    const path = parentPath.replace(/\/$/, '') + '/' + folderName + '/'
    apiFetch<DocumentListItem>(`/v1/knowledge-bases/${kbId}/documents/note`, t, {
      method: 'POST',
      body: JSON.stringify({ filename: 'Untitled.md', path }),
    })
      .then((data) => {
        setDocuments((prev) => [data, ...prev])
        if (!filesViewActive) {
          setActiveView('files')
          navigateToView('files')
        }
      })
      .catch((err: Error) => toast.error(err.message || '创建文件夹失败'))
  }

  const handleMoveDocument = async (docId: string, targetPath: string) => {
    const t = getToken()
    if (!t) return
    try {
      await apiFetch(`/v1/documents/${docId}`, t, { method: 'PATCH', body: JSON.stringify({ path: targetPath }) })
      setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, path: targetPath } : d))
    } catch { toast.error('移动文档失败') }
  }

  const handleClearCategoryWiki = async (categoryName: string) => {
    if (!window.confirm(`确定清空「${categoryName}」下的所有百科页面？源文档不受影响，可重新编译。`)) return
    const cat = kbCategories.find((c) => c.name === categoryName)
    if (!cat) { toast.error('未找到该分类'); return }
    // Find the category ID from the database
    try {
      const jzToken = localStorage.getItem('jz_token')
      if (!jzToken) return
      const catsRes = await fetch(`${MAIN_API}/api/kb/categories`, { headers: { Authorization: `Bearer ${jzToken}` } })
      if (!catsRes.ok) throw new Error('获取分类失败')
      const cats = await catsRes.json()
      const dbCat = cats.find((c: any) => c.path === cat.path)
      if (!dbCat) { toast.error('分类不存在'); return }
      const res = await fetch(`${MAIN_API}/api/kb/categories/${dbCat.id}/wiki`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${jzToken}` },
      })
      if (!res.ok) { const body = await res.json().catch(() => ({})); toast.error(body.message || '清空失败'); return }
      const result = await res.json()
      toast.success(`已清空 ${result.deleted} 个百科页面`)
      refetchDocuments()
    } catch (e: any) { toast.error(e.message || '清空失败') }
  }

  const handleDeleteDocument = async (docId: string) => {
    const t = getToken()
    if (!t) return
    try {
      await apiFetch(`/v1/documents/${docId}`, t, { method: 'DELETE' })
      setDocuments((prev) => prev.filter((d) => d.id !== docId))
    } catch { toast.error('删除文档失败') }
  }

  const handleRenameDocument = async (docId: string, newTitle: string) => {
    const t = getToken()
    if (!t) return
    try {
      await apiFetch(`/v1/documents/${docId}`, t, { method: 'PATCH', body: JSON.stringify({ title: newTitle }) })
      setDocuments((prev) => prev.map((d) => d.id === docId ? { ...d, title: newTitle } : d))
    } catch { toast.error('重命名文档失败') }
  }

  // ─── File upload with progress ───────────────────────────────
  type UploadTask = { id: string; name: string; size: number; progress: number; status: 'uploading' | 'done' | 'error'; error?: string }
  const [uploadTasks, setUploadTasks] = React.useState<UploadTask[]>([])
  const [showUploadPanel, setShowUploadPanel] = React.useState(false)

  const updateTask = React.useCallback((id: string, patch: Partial<UploadTask>) => {
    setUploadTasks((prev) => prev.map((t) => t.id === id ? { ...t, ...patch } : t))
  }, [])

  const clearFinishedTasks = React.useCallback(() => {
    setUploadTasks((prev) => {
      const remaining = prev.filter((t) => t.status === 'uploading')
      if (remaining.length === 0) setShowUploadPanel(false)
      return remaining
    })
  }, [])

  const uploadPathRef = React.useRef('/')
  const handleUploadClick = (targetPath: string = '/raw/') => {
    uploadPathRef.current = targetPath
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.md,.txt,.pdf,.pptx,.ppt,.docx,.doc,.png,.jpg,.jpeg,.webp,.gif,.svg,.xlsx,.xls,.csv,.html,.htm'
    input.multiple = true
    input.onchange = () => { if (input.files) uploadFiles(Array.from(input.files), uploadPathRef.current) }
    input.click()
  }

  const tusUploadFile = React.useCallback((file: File, taskId: string, targetPath: string = '/'): Promise<void> => {
    const t = getToken()
    if (!t) return Promise.reject(new Error('Not authenticated'))
    return new Promise((resolve, reject) => {
      const upload = new tus.Upload(file, {
        endpoint: `${KB_DIRECT_URL}/v1/uploads`,
        retryDelays: [0, 1000, 3000, 5000],
        metadata: { filename: file.name, knowledge_base_id: kbId, path: targetPath },
        headers: { Authorization: `Bearer ${t}` },
        onProgress: (bytesUploaded, bytesTotal) => {
          updateTask(taskId, { progress: Math.round((bytesUploaded / bytesTotal) * 100) })
        },
        onError: (error) => { updateTask(taskId, { status: 'error', error: error.message }); reject(error) },
        onSuccess: () => { updateTask(taskId, { status: 'done', progress: 100 }); resolve() },
      })
      upload.start()
    })
  }, [kbId, updateTask])

  const uploadFileWithProgress = React.useCallback((file: File, taskId: string, targetPath: string): Promise<any> => {
    return new Promise((resolve, reject) => {
      const formData = new FormData()
      formData.append('file', file)
      formData.append('path', targetPath)
      const xhr = new XMLHttpRequest()
      xhr.open('POST', `${KB_DIRECT_URL}/v1/upload`)
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          updateTask(taskId, { progress: Math.round((e.loaded / e.total) * 100) })
        }
      }
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)) } catch { resolve(null) }
        } else {
          reject(new Error(`Upload failed: ${xhr.status}`))
        }
      }
      xhr.onerror = () => reject(new Error('Network error'))
      xhr.send(formData)
    })
  }, [updateTask])

  const uploadFiles = React.useCallback((files: File[], targetPath: string = '/raw/') => {
    const t = getToken()
    if (!t || !userId) return

    // Client-side duplicate check
    const existingNames = new Set(
      documents
        .filter((d) => d.path === targetPath && !d.archived)
        .map((d) => d.filename.toLowerCase()),
    )
    const duplicates = files.filter((f) => existingNames.has(f.name.toLowerCase()))
    if (duplicates.length > 0) {
      const names = duplicates.map((f) => f.name).join(', ')
      toast.error(`Already exists: ${names}`)
      if (duplicates.length === files.length) return
      files = files.filter((f) => !existingNames.has(f.name.toLowerCase()))
    }

    // Create upload tasks
    const newTasks: UploadTask[] = files.map((f) => ({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: f.name,
      size: f.size,
      progress: 0,
      status: 'uploading' as const,
    }))
    setUploadTasks((prev) => [...prev, ...newTasks])
    setShowUploadPanel(true)

    const uploads = files.map(async (file, i) => {
      const task = newTasks[i]
      const ext = file.name.split('.').pop()?.toLowerCase()
      if (ext === 'md' || ext === 'txt') {
        const content = await file.text()
        const title = file.name.replace(/\.(md|txt)$/i, '')
        try {
          updateTask(task.id, { progress: 50 })
          const data = await apiFetch<DocumentListItem>(`/v1/knowledge-bases/${kbId}/documents/note`, t, {
            method: 'POST',
            body: JSON.stringify({ filename: file.name, title, content, path: targetPath }),
          })
          setDocuments((prev) => [data, ...prev])
          updateTask(task.id, { status: 'done', progress: 100 })
        } catch { updateTask(task.id, { status: 'error', error: '导入失败' }) }
      } else {
        const supportedTypes = new Set(['pdf', 'pptx', 'ppt', 'docx', 'doc', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'xlsx', 'xls', 'csv', 'html', 'htm'])
        if (ext && supportedTypes.has(ext)) {
          if (process.env.NEXT_PUBLIC_MODE === 'local') {
            try {
              const data = await uploadFileWithProgress(file, task.id, targetPath)
              if (data) setDocuments((prev) => [data, ...prev])
              updateTask(task.id, { status: 'done', progress: 100 })
            } catch { updateTask(task.id, { status: 'error', error: '上传失败' }) }
          } else {
            try {
              await tusUploadFile(file, task.id, targetPath)
            } catch { /* already handled in tusUploadFile */ }
          }
        } else {
          updateTask(task.id, { status: 'error', error: `${ext} 格式暂不支持` })
        }
      }
    })
    Promise.all(uploads).then(() => {
      // Navigate to files view after first upload
      if (sourceDocs.length === 0) {
        setActiveView('files')
        navigateToView('files')
      }
      // Refetch to pick up processed status (backend processes async)
      setTimeout(refetchDocuments, 1500)
      setTimeout(refetchDocuments, 5000)
    })
  }, [kbId, userId, tusUploadFile, uploadFileWithProgress, updateTask, documents, sourceDocs.length, navigateToView, refetchDocuments])

  // ─── Drag-and-drop ───────────────────────────────────────────
  const [fileDragOver, setFileDragOver] = React.useState(false)
  const dragCounterRef = React.useRef(0)

  const handleFileDragEnter = (e: React.DragEvent) => {
    if (filesViewActive) return
    if (e.dataTransfer.types.includes('application/x-llmwiki-item')) return
    e.preventDefault()
    dragCounterRef.current++
    if (dragCounterRef.current === 1) setFileDragOver(true)
  }
  const handleFileDragLeave = (e: React.DragEvent) => {
    if (filesViewActive) return
    e.preventDefault()
    dragCounterRef.current--
    if (dragCounterRef.current === 0) setFileDragOver(false)
  }
  const handleFileDragOver = (e: React.DragEvent) => {
    if (filesViewActive) return
    if (e.dataTransfer.types.includes('application/x-llmwiki-item')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }
  const handleFileDrop = (e: React.DragEvent) => {
    if (filesViewActive) return
    if (e.dataTransfer.types.includes('application/x-llmwiki-item')) return
    e.preventDefault()
    dragCounterRef.current = 0
    setFileDragOver(false)
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) uploadFiles(files, '/raw/')
  }

  // ─── Search callbacks ────────────────────────────────────────
  const handleSearchNavigateWiki = React.useCallback((wikiPath: string) => {
    setSearchActive(false)
    handleWikiSelect(wikiPath)
  }, [handleWikiSelect])

  const handleSearchNavigateSource = React.useCallback((filename: string, page?: number) => {
    setSearchActive(false)
    const doc = documents.find((d) => d.filename === filename && !d.path.startsWith('/wiki/'))
    if (doc) {
      setActiveSourceDocId(doc.id)
      setActiveView('doc')
      if (page != null) setFilesInitialPage(page)
      if (doc.document_number != null) updateParam('doc', String(doc.document_number))
      navigateToView('files')
    }
  }, [documents, updateParam, navigateToView])

  // ─── FilesGrid URL-sync callbacks ────────────────────────────
  const handleFilesPathChange = React.useCallback((path: string) => {
    const clean = path === '/' ? '' : path.replace(/^\//, '').replace(/\/$/, '')
    const url = `/wikis/${kbSlug}` + (clean ? `/files/${encodeURI(clean)}` : '/files')
    // Use replaceState to update the URL bar without triggering a Next.js
    // navigation — avoids re-rendering the page component and the flash
    // that comes from KBPage → KBDetail → FilesGrid prop cascade.
    window.history.replaceState(window.history.state, '', url)
  }, [kbSlug])

  const handleFilesDocOpen = React.useCallback((docNumber: number | null) => {
    if (docNumber == null) return
    const doc = documents.find((d) => d.document_number === docNumber)
    if (doc) {
      setActiveSourceDocId(doc.id)
      setActiveView('doc')
      updateParam('doc', String(docNumber))
    }
  }, [documents, updateParam])

  const handleFilesDocClose = React.useCallback(() => {
    setActiveSourceDocId(null)
    setActiveView('files')
    updateParam('doc', null)
  }, [updateParam])

  // ─── Loading state ───────────────────────────────────────────
  const mindViewActive = activeView === 'mind'
  const distillViewActive = activeView === 'distill'
  const showMainLoading =
    distillViewActive ? false :
    loading ||
    (!filesViewActive && !graphViewActive && !mindViewActive && hasNavigableWiki && !wikiActivePath) ||
    (!filesViewActive && !graphViewActive && !mindViewActive && !!wikiActivePath && pageLoadedPath !== wikiActivePath)

  // ─── Render ──────────────────────────────────────────────────
  return (
    <div
      className="flex flex-col h-full relative"
      onDragEnter={handleFileDragEnter}
      onDragLeave={handleFileDragLeave}
      onDragOver={handleFileDragOver}
      onDrop={handleFileDrop}
    >
      <AnimatePresence>
        {fileDragOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            className="absolute inset-0 z-50 bg-background/80 backdrop-blur-sm flex items-center justify-center pointer-events-none"
          >
            <div className="flex flex-col items-center gap-3 border-2 border-dashed border-primary rounded-xl px-12 py-10">
              <UploadIcon className="size-8 text-primary" />
              <p className="text-sm font-medium text-primary">拖放文件以上传</p>
              <p className="text-xs text-muted-foreground">支持 PDF、Word、PowerPoint、图片等格式</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Wiki compiling status bar */}
      <AnimatePresence>
        {compiling && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="shrink-0 overflow-hidden"
          >
            <div className="flex items-center gap-2 px-4 py-1.5 bg-primary/5 border-b border-primary/10 text-xs">
              <Loader2 className="size-3 animate-spin text-primary" />
              <span className="text-primary font-medium">正在生成百科...</span>
              {compilingPages.length > 0 && (
                <span className="text-muted-foreground">已生成 {compilingPages.length} 页</span>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div className="flex-1 overflow-hidden flex relative">
        {navCollapsed && (
          <div
            className="w-7 shrink-0 border-r border-border bg-[hsl(30,3%,98%)] flex justify-center pt-2"
            onMouseEnter={() => setNavFloat(true)}
          >
            <button onClick={() => setNavCollapsed(false)} title="展开导航"
              className="text-muted-foreground/60 hover:text-foreground cursor-pointer">
              <PanelLeftOpen className="size-4" />
            </button>
          </div>
        )}
        <div
          className={navCollapsed
            ? `absolute left-7 top-0 bottom-0 w-64 z-30 shadow-2xl transition-transform duration-150 ${navFloat ? 'translate-x-0' : '-translate-x-[110%]'}`
            : 'w-64 shrink-0'}
          onMouseLeave={navCollapsed ? () => setNavFloat(false) : undefined}
        >
          <KBSidenav
            kbId={kbId}
            kbName={kbName}
            wikiTree={wikiTree}
            wikiActivePath={filesViewActive || graphViewActive ? null : wikiActivePath}
            onWikiNavigate={handleWikiSelect}
            sourceDocs={sourceDocs}
            hasWiki={hasNavigableWiki}
            loading={loading}
            onUpload={() => { setActiveView('files'); navigateToView('files'); }}
            filesViewActive={filesViewActive}
            onFilesToggle={handleFilesToggle}
            graphViewActive={graphViewActive}
            onGraphToggle={handleGraphToggle}
            onOpenSourceDoc={handleOpenSourceDoc}
            mindViewActive={activeView === 'mind'}
            onMindToggle={() => setActiveView(activeView === 'mind' ? 'wiki' : 'mind')}
            distillViewActive={activeView === 'distill'}
            onDistillToggle={() => setActiveView(activeView === 'distill' ? 'wiki' : 'distill')}
            onCollapse={() => { setNavCollapsed(true); setNavFloat(false); }}
            hasUncompiledDocs={needsCompilation}
            wikiExists={wikiExists}
            onCompileAll={() => {
              window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                detail: { actionType: 'switch_agent', actionData: { target: 'wiki_compiler' } },
              }));
              setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                detail: { content: '请将企业心智中所有来源文档编译为百科。' },
              })), 500);
            }}
            isAdmin={isAdmin}
            onClearCategoryWiki={handleClearCategoryWiki}
            needsCompilation={needsCompilation}
            onCompileCategory={(categoryName: string) => {
              const cat = kbCategories.find(c => c.name === categoryName);
              const catPath = cat?.path || '';
              const rawPath = `/raw${catPath}/`;
              window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                detail: { actionType: 'switch_agent', actionData: { target: 'wiki_compiler' } },
              }));
              setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                detail: { content: `请将「${categoryName}」分类（路径: ${rawPath}）下的来源文档编译为百科，写入 /wiki${catPath}/ 目录。` },
              })), 500);
            }}
          />
        </div>
        <div className="flex-1 min-w-0 relative">
          {/* Search input — top-right of content area（专项蒸馏视图不属于知识检索范畴，隐藏搜索栏）*/}
          {!searchActive && !distillViewActive && (
            <div className="absolute top-1 right-4 z-10 flex items-center gap-1.5 rounded-md border border-border bg-background/80 backdrop-blur-sm px-2 py-1 shadow-sm">
              <Search className="size-3.5 text-muted-foreground shrink-0" />
              <input
                type="text"
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && searchQuery.trim()) {
                    setSearchActive(true)
                  }
                }}
                placeholder="搜索..."
                className="w-32 bg-transparent text-xs outline-none placeholder:text-muted-foreground"
              />
            </div>
          )}

          {searchActive ? (
            <SearchView
              kbId={kbId}
              initialQuery={searchQuery}
              onNavigateToWiki={handleSearchNavigateWiki}
              onNavigateToSource={handleSearchNavigateSource}
              onClose={() => { setSearchActive(false); setSearchQuery('') }}
            />
          ) : (
          <AnimatePresence mode="wait">
            {showMainLoading ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="flex items-center justify-center h-full"
              >
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </motion.div>
            ) : activeView === 'distill' ? (
              <motion.div
                key="distill"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                className="h-full"
              >
                <DistillPanel />
              </motion.div>
            ) : activeView === 'mind' ? (
              <motion.div
                key="mind"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                className="h-full"
              >
                <EnterpriseMindEditor
                  kbId={kbId}
                  kbSlug={kbSlug}
                  characterDocs={characterDocs}
                  rulesDocs={rulesDocs}
                  personalRawDocs={personalRawDocs}
                  personalWikiDocs={personalWikiDocs}
                  wikiDocs={wikiDocs}
                  wikiTree={wikiTree}
                  documents={documents}
                  onCreateNote={handleCreateNote}
                  onDeleteDocument={handleDeleteDocument}
                  onRefetch={refetchDocuments}
                  onSwitchToWiki={(path?: string) => {
                    setActiveView('wiki')
                    setEmptyCategoryName(null)
                    if (path) {
                      setLocalParams((prev) => ({ ...prev, p: path }))
                    } else if (wikiTree.length > 0) {
                      const first = findFirstPath(wikiTree)
                      if (first) setWikiActivePath(first.path)
                    }
                  }}
                  onUpload={() => handleUploadClick()}
                />
              </motion.div>
            ) : graphViewActive ? (
              <motion.div
                key="graph"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                className="h-full"
              >
                <GraphViewer
                  kbId={kbId}
                  focusNodeId={graphFocusNodeId}
                  onNavigateToDoc={handleGraphNodeClick}
                />
              </motion.div>
            ) : filesViewActive ? (
              <motion.div
                key="files"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                className="h-full"
              >
                <FilesGrid
                  key={kbId}
                  documents={documents}
                  onDeleteDocument={handleDeleteDocument}
                  onRenameDocument={handleRenameDocument}
                  onUpload={handleUploadClick}
                  onCreateNote={handleCreateNote}
                  onCreateFolder={handleCreateFolder}
                  onMoveDocument={handleMoveDocument}
                  onUploadFiles={uploadFiles}
                  initialDocId={activeSourceDocId}
                  initialPage={filesInitialPage}
                  initialPath={routeFilesPath}
                  onPathChange={handleFilesPathChange}
                  onDocOpen={handleFilesDocOpen}
                  categoryFolders={kbCategories}
                  onCompile={needsCompilation ? (rawPath: string) => {
                    const catPath = rawPath.replace(/^\/raw/, '').replace(/\/$/, '') || '';
                    const catName = kbCategories.find(c => c.path === catPath)?.name || catPath || '全部';
                    const hasExistingWiki = wikiDocs.some(d => d.path.startsWith(`/wiki${catPath}/`));
                    const action = hasExistingWiki ? '更新' : '编译';
                    window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                      detail: { actionType: 'switch_agent', actionData: { target: 'wiki_compiler' } },
                    }));
                    setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                      detail: { content: `请${action}「${catName}」分类（路径: ${rawPath}）下的来源文档对应的百科，写入 /wiki${catPath}/ 目录。` },
                    })), 500);
                  } : undefined}
                  onDocClose={handleFilesDocClose}
                />
              </motion.div>
            ) : pageLoading ? (
              <motion.div
                key="wiki-loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.1 }}
                className="flex items-center justify-center h-full"
              >
                <Loader2 className="size-5 animate-spin text-muted-foreground" />
              </motion.div>
            ) : emptyCategoryName ? (
              <motion.div
                key="empty-category"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className="flex flex-col items-center justify-center h-full gap-4 px-6"
              >
                <UploadIcon className="size-10 text-primary/30" />
                <div className="text-center max-w-sm">
                  <h3 className="text-base font-medium mb-1.5">「{emptyCategoryName}」暂无内容</h3>
                  <p className="text-sm text-muted-foreground leading-relaxed">
                    上传来源文档到该分类，或在对话中让智能体为此分类生成知识。
                  </p>
                </div>
                <button
                  onClick={() => {
                    // Find category path by name, then upload to /raw/{catPath}/
                    const cat = kbCategories.find(c => c.name === emptyCategoryName)
                    const uploadPath = cat ? `/raw${cat.path}/` : '/raw/'
                    handleUploadClick(uploadPath)
                  }}
                  className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <UploadIcon className="size-3.5 opacity-60" />
                  上传文档到此分类
                </button>
              </motion.div>
            ) : hasNavigableWiki && wikiActivePath ? (
              <motion.div
                key={`wiki-${wikiActivePath}`}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.15, ease: [0.25, 0.1, 0.25, 1] }}
                className="h-full"
              >
                <WikiContent
                  content={pageContent}
                  title={pageTitle}
                  onNavigate={handleWikiNavigate}
                  onSourceClick={handleCitationSourceClick}
                  onGraphClick={handlePageGraphClick}
                  documents={documents}
                />
              </motion.div>
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
                className="flex flex-col items-center justify-center h-full gap-4 px-6"
              >
                {emptyCategoryName ? (
                  <>
                    <UploadIcon className="size-10 text-primary/30" />
                    <div className="text-center max-w-sm">
                      <h3 className="text-base font-medium mb-1.5">「{emptyCategoryName}」暂无内容</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        上传来源文档到该分类，或在对话中让智能体为此分类生成知识。
                      </p>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        onClick={() => {
                          const cat = kbCategories.find(c => c.name === emptyCategoryName)
                          handleUploadClick(cat ? `/raw${cat.path}/` : '/raw/')
                        }}
                        className="inline-flex items-center gap-2 rounded-full bg-foreground text-background px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
                      >
                        <UploadIcon className="size-3.5 opacity-60" />
                        上传文档到此分类
                      </button>
                    </div>
                  </>
                ) : sourceDocs.length > 0 ? (
                  <>
                    <Sparkles className="size-10 text-primary/30" />
                    <div className="text-center max-w-sm">
                      <h3 className="text-base font-medium mb-1.5">百科尚未生成</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        已有 {sourceDocs.length} 篇来源文档，可立即生成企业百科。
                      </p>
                    </div>
                    <div className="flex items-center gap-3 mt-2">
                      <button
                        onClick={() => {
                          window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                            detail: { actionType: 'switch_agent', actionData: { target: 'wiki_compiler' } },
                          }));
                          setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                            detail: { content: '请将企业心智中所有来源文档编译为百科。' },
                          })), 500);
                        }}
                        className="inline-flex items-center gap-2 rounded-full bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:opacity-90 transition-opacity cursor-pointer"
                      >
                        <Sparkles className="size-3.5 opacity-60" />
                        编译为百科
                      </button>
                      <p className="text-xs text-muted-foreground mt-1">上传来源文档请点击左侧「来源文档」，选择分类目录后上传</p>
                    </div>
                  </>
                ) : (
                  <>
                    <BookOpen className="size-10 text-muted-foreground/20" />
                    <div className="text-center max-w-sm">
                      <h3 className="text-base font-medium mb-1.5">暂无来源文档</h3>
                      <p className="text-sm text-muted-foreground leading-relaxed">
                        上传来源文档后，可生成企业百科。
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground mt-2">上传来源文档请点击左侧「来源文档」，进入分类目录后上传</p>
                  </>
                )}
              </motion.div>
            )}
          </AnimatePresence>
          )}
        </div>
      </div>

      <SelectionActionBar
        count={selectedIds.size}
        onDelete={handleDeleteSelected}
        onClear={clearSelection}
      />

      {/* Upload progress panel */}
      <AnimatePresence>
        {showUploadPanel && uploadTasks.length > 0 && (
          <motion.div
            initial={{ opacity: 0, y: 20, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.95 }}
            transition={{ duration: 0.2, ease: [0.25, 0.1, 0.25, 1] }}
            className="absolute bottom-4 right-4 z-50 w-80 rounded-lg border border-border bg-background shadow-lg overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-2 bg-muted/50 border-b border-border">
              <div className="flex items-center gap-2 text-xs font-medium">
                <FileUp className="size-3.5" />
                上传文件
                {(() => { const done = uploadTasks.filter((t) => t.status === 'done').length; return done < uploadTasks.length ? ` (${done}/${uploadTasks.length})` : ' — 全部完成' })()}
              </div>
              <div className="flex items-center gap-1">
                {uploadTasks.every((t) => t.status !== 'uploading') && (
                  <button onClick={clearFinishedTasks} className="text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer">清除</button>
                )}
                <button onClick={() => setShowUploadPanel(false)} className="p-0.5 text-muted-foreground hover:text-foreground transition-colors cursor-pointer">
                  <X className="size-3.5" />
                </button>
              </div>
            </div>
            <div className="max-h-48 overflow-y-auto divide-y divide-border">
              {uploadTasks.map((task) => (
                <div key={task.id} className="px-3 py-2 text-xs">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="truncate flex-1" title={task.name}>{task.name}</span>
                    {task.status === 'uploading' && <span className="text-muted-foreground shrink-0">{task.progress}%</span>}
                    {task.status === 'done' && <CheckCircle2 className="size-3.5 text-green-500 shrink-0" />}
                    {task.status === 'error' && (
                      <span className="flex items-center gap-1 text-red-500 shrink-0" title={task.error}>
                        <XCircle className="size-3.5" />
                      </span>
                    )}
                  </div>
                  {task.status === 'uploading' && (
                    <div className="h-1 rounded-full bg-muted overflow-hidden">
                      <motion.div
                        className="h-full bg-primary rounded-full"
                        initial={{ width: 0 }}
                        animate={{ width: `${task.progress}%` }}
                        transition={{ duration: 0.3, ease: 'easeOut' }}
                      />
                    </div>
                  )}
                  {task.status === 'error' && task.error && (
                    <p className="text-red-500/80 mt-0.5">{task.error}</p>
                  )}
                </div>
              ))}
            </div>
            {uploadTasks.length > 0 && uploadTasks.every((t) => t.status !== 'uploading') && uploadTasks.some((t) => t.status === 'done') && (
              <div className="px-3 py-2 border-t border-border">
                <button
                  onClick={() => {
                    window.dispatchEvent(new CustomEvent('jianzhi:agent-action', {
                      detail: { actionType: 'switch_agent', actionData: { target: 'wiki_compiler' } },
                    }));
                    setTimeout(() => window.dispatchEvent(new CustomEvent('jianzhi:send-message', {
                      detail: { content: '请将企业心智中新上传的来源文档编译为百科。' },
                    })), 500);
                    clearFinishedTasks()
                  }}
                  className="w-full inline-flex items-center justify-center gap-1.5 rounded-md bg-primary text-primary-foreground px-3 py-1.5 text-xs font-medium hover:opacity-90 transition-opacity cursor-pointer"
                >
                  <Sparkles className="size-3" />
                  立即编译为百科
                </button>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
