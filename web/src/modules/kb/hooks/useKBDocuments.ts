'use client'

import * as React from 'react'
import { apiFetch } from '../lib/api'
import type { DocumentListItem } from '../lib/types'

const POLL_INTERVAL = 10000

export function useKBDocuments(knowledgeBaseId: string) {
  const [documents, setDocuments] = React.useState<DocumentListItem[]>([])
  const [loading, setLoading] = React.useState(true)

  const lastHashRef = React.useRef<string>('')

  const fetchDocs = React.useCallback(async () => {
    if (!knowledgeBaseId) return
    try {
      const data = await apiFetch<DocumentListItem[]>(
        `/v1/knowledge-bases/${knowledgeBaseId}/documents`,
      )
      // Skip re-render if data hasn't changed (compare by id+version fingerprint)
      const hash = data.map(d => `${d.id}:${d.version}`).join(',')
      if (hash === lastHashRef.current) return
      lastHashRef.current = hash
      setDocuments(data)
    } catch (err) {
      console.error('Failed to load documents:', err)
    }
  }, [knowledgeBaseId])

  // Initial load — always use the API
  React.useEffect(() => {
    if (!knowledgeBaseId) {
      setDocuments([])
      setLoading(false)
      return
    }
    setLoading(true)
    fetchDocs().finally(() => setLoading(false))
  }, [knowledgeBaseId, fetchDocs])

  // Polling for updates (local mode only, no WebSocket needed)
  React.useEffect(() => {
    if (!knowledgeBaseId) return
    const interval = setInterval(fetchDocs, POLL_INTERVAL)
    return () => clearInterval(interval)
  }, [knowledgeBaseId, fetchDocs])

  const refetchDocuments = React.useCallback(() => {
    return fetchDocs()
  }, [fetchDocs])

  return { documents, setDocuments, loading, refetchDocuments }
}
