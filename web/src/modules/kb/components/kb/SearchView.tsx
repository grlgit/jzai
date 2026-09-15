'use client'

import * as React from 'react'
import { Search, Loader2, FileText, BookOpen, X } from 'lucide-react'
import { apiFetch } from '../../lib/api'

interface SearchResult {
  content: string
  page: number | null
  header_breadcrumb: string | null
  chunk_index: number
  filename: string
  title: string | null
  path: string
  file_type: string
  tags: string | null
}

interface Props {
  kbId: string
  initialQuery?: string
  onNavigateToWiki: (path: string) => void
  onNavigateToSource: (filename: string, page?: number) => void
  onClose: () => void
}

export function SearchView({ kbId, initialQuery, onNavigateToWiki, onNavigateToSource, onClose }: Props) {
  const token = 'internal' // auth handled by api.ts
  const [query, setQuery] = React.useState(initialQuery || '')
  const [results, setResults] = React.useState<SearchResult[]>([])
  const [searching, setSearching] = React.useState(false)
  const [searched, setSearched] = React.useState(false)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const didAutoSearch = React.useRef(false)

  React.useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const handleSearch = React.useCallback(async () => {
    const q = query.trim()
    if (!q || !token) return

    setSearching(true)
    setSearched(true)
    try {
      const data = await apiFetch<SearchResult[]>(
        `/v1/knowledge-bases/${kbId}/search?q=${encodeURIComponent(q)}&limit=20`,
        token,
      )
      setResults(data)
    } catch {
      setResults([])
    } finally {
      setSearching(false)
    }
  }, [query, kbId, token])

  // Auto-search on mount if initialQuery is provided
  React.useEffect(() => {
    if (initialQuery?.trim() && !didAutoSearch.current) {
      didAutoSearch.current = true
      handleSearch()
    }
  }, [initialQuery, handleSearch])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleSearch()
    } else if (e.key === 'Escape') {
      onClose()
    }
  }

  const handleResultClick = (result: SearchResult) => {
    if (result.path.startsWith('/wiki/')) {
      const wikiPath = (result.path + result.filename).replace(/^\/wiki\/?/, '')
      onNavigateToWiki(wikiPath)
    } else {
      onNavigateToSource(result.filename, result.page ?? undefined)
    }
  }

  // Extract a snippet around the query keyword from content
  const extractSnippet = React.useCallback((content: string, maxLen = 150) => {
    // Strip YAML frontmatter
    let text = content.replace(/^---[\s\S]*?---\s*/, '')
    // Strip markdown images and links syntax
    text = text.replace(/!\[.*?\]\(.*?\)/g, '').replace(/\[([^\]]*)\]\(.*?\)/g, '$1')
    // Strip markdown headers/bold/italic
    text = text.replace(/#{1,6}\s*/g, '').replace(/\*{1,2}(.*?)\*{1,2}/g, '$1')
    text = text.trim()

    const q = query.trim().toLowerCase()
    const idx = text.toLowerCase().indexOf(q)
    if (idx >= 0) {
      const start = Math.max(0, idx - 40)
      const end = Math.min(text.length, idx + q.length + maxLen - 40)
      return (start > 0 ? '...' : '') + text.slice(start, end).trim() + (end < text.length ? '...' : '')
    }
    return text.slice(0, maxLen) + (text.length > maxLen ? '...' : '')
  }, [query])

  // Group results by document (path + filename)
  const grouped = React.useMemo(() => {
    const map = new Map<string, { result: SearchResult; snippets: string[] }>()
    for (const r of results) {
      const key = r.path + r.filename
      if (!map.has(key)) {
        map.set(key, { result: r, snippets: [] })
      }
      const entry = map.get(key)!
      if (entry.snippets.length < 2) {
        entry.snippets.push(extractSnippet(r.content))
      }
    }
    return Array.from(map.values())
  }, [results, extractSnippet])

  // Highlight matched keywords in text
  const highlight = React.useCallback((text: string) => {
    const q = query.trim()
    if (!q) return <>{text}</>
    const regex = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi')
    const parts = text.split(regex)
    return (
      <>
        {parts.map((part, i) =>
          regex.test(part) ? (
            <span key={i} className="text-red-500 font-medium">{part}</span>
          ) : (
            <span key={i}>{part}</span>
          )
        )}
      </>
    )
  }, [query])

  return (
    <div className="h-full flex flex-col">
      {/* Search bar */}
      <div className="flex items-center gap-2 px-6 py-3 border-b border-border">
        <Search className="size-4 text-muted-foreground shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入关键字搜索，按回车确认..."
          className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
        />
        {searching && <Loader2 className="size-4 animate-spin text-muted-foreground shrink-0" />}
        <button
          onClick={onClose}
          className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {!searched ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <Search className="size-8 opacity-20 mb-3" />
            <p className="text-sm">输入关键字并按回车搜索</p>
          </div>
        ) : searching ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : grouped.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
            <p className="text-sm">未找到与 &ldquo;{query}&rdquo; 相关的结果</p>
          </div>
        ) : (
          <div className="py-2">
            <p className="px-6 py-2 text-xs text-muted-foreground">
              找到 {grouped.length} 个相关文档
            </p>
            {grouped.map(({ result, snippets }, i) => {
              const isWiki = result.path.startsWith('/wiki/')
              const displayTitle = result.title || result.filename.replace(/\.(md|txt)$/, '')

              return (
                <button
                  key={`${result.path}${result.filename}-${i}`}
                  onClick={() => handleResultClick(result)}
                  className="w-full text-left px-6 py-3 hover:bg-accent/50 transition-colors border-b border-border/50 cursor-pointer"
                >
                  <div className="flex items-center gap-2 mb-1">
                    {isWiki ? (
                      <BookOpen className="size-3.5 text-primary shrink-0" />
                    ) : (
                      <FileText className="size-3.5 text-muted-foreground shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate">{highlight(displayTitle)}</span>
                    {result.page != null && (
                      <span className="text-xs text-muted-foreground shrink-0">p.{result.page}</span>
                    )}
                    <span className="text-xs text-muted-foreground shrink-0 ml-auto">
                      {isWiki ? '百科' : result.file_type?.toUpperCase()}
                    </span>
                  </div>
                  {snippets.map((snippet, j) => (
                    <p key={j} className="text-xs text-muted-foreground line-clamp-1 mt-0.5 pl-5.5">
                      {highlight(snippet)}
                    </p>
                  ))}
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
