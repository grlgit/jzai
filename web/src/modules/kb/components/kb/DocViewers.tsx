'use client'

import * as React from 'react'
import { Loader2, FileText } from 'lucide-react'
import { apiFetch } from '../../lib/api'
import dynamic from 'next/dynamic'

const PdfViewer = dynamic(() => import('../viewer/PdfViewer'), { ssr: false })
const HtmlViewer = dynamic(() => import('../viewer/HtmlViewer'), { ssr: false })

function useDocumentUrl(documentId: string) {
  const token = 'internal' // auth handled by api.ts
  const [url, setUrl] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    apiFetch<{ url: string }>(`/v1/documents/${documentId}/url`, token)
      .then((res) => { if (!cancelled) setUrl(res.url) })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [documentId, token])

  return { url, error }
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center h-full">
      <Loader2 className="size-5 animate-spin text-muted-foreground" />
    </div>
  )
}

function ErrorMessage({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center h-full">
      <p className="text-sm text-destructive">{message}</p>
    </div>
  )
}

export function PdfDocViewer({ documentId, title, initialPage, hideToolbar }: { documentId: string; title: string; initialPage?: number; hideToolbar?: boolean }) {
  const { url, error } = useDocumentUrl(documentId)
  if (error) return <ErrorMessage message="PDF 加载失败" />
  if (!url) return <LoadingSpinner />
  return <PdfViewer fileUrl={url} title={title} initialPage={initialPage} hideToolbar={hideToolbar} />
}

export function ImageViewer({ documentId, title }: { documentId: string; title: string }) {
  const { url, error } = useDocumentUrl(documentId)
  if (error) return <ErrorMessage message="图片加载失败" />
  if (!url) return <LoadingSpinner />

  return (
    <div className="h-full overflow-auto flex items-center justify-center p-4 bg-muted/30">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={url} alt={title} className="max-w-full max-h-full object-contain rounded-md" />
    </div>
  )
}

export function HtmlDocViewer({ documentId, title }: { documentId: string; title: string }) {
  const { url, error } = useDocumentUrl(documentId)
  if (error) return <ErrorMessage message="HTML 加载失败" />
  if (!url) return <LoadingSpinner />
  return <HtmlViewer fileUrl={url} className="h-full" />
}

export function ContentViewer({ documentId, title, fileType }: { documentId: string; title: string; fileType: string }) {
  const token = 'internal' // auth handled by api.ts
  const [content, setContent] = React.useState<string | null>(null)
  const [error, setError] = React.useState(false)

  React.useEffect(() => {
    if (!token) return
    let cancelled = false
    apiFetch<{ content: string }>(`/v1/documents/${documentId}/content`, token)
      .then((res) => { if (!cancelled) setContent(res.content ?? '') })
      .catch(() => { if (!cancelled) setError(true) })
    return () => { cancelled = true }
  }, [documentId, token])

  if (error) return <ErrorMessage message="内容加载失败" />
  if (content === null) return <LoadingSpinner />

  const isHtml = fileType === 'html' || fileType === 'htm'

  return (
    <div className="h-full flex flex-col">
      {isHtml ? (
        <iframe
          srcDoc={content}
          sandbox="allow-same-origin"
          className="flex-1 w-full bg-white"
          title={title}
        />
      ) : (
        <div className="flex-1 overflow-auto">
          <div className="max-w-3xl mx-auto px-8 py-6 prose prose-sm dark:prose-invert">
            <pre className="whitespace-pre-wrap text-sm font-mono">{content}</pre>
          </div>
        </div>
      )}
    </div>
  )
}

export function UnsupportedViewer({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-xl bg-muted">
        <FileText size={28} className="text-muted-foreground" />
      </div>
      <div className="text-center">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="text-xs text-muted-foreground mt-2">文件预览即将推出</p>
      </div>
    </div>
  )
}

export function ProcessingViewer({ title }: { title: string }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <Loader2 className="size-8 animate-spin text-muted-foreground" />
      <div className="text-center">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="text-xs text-muted-foreground mt-2">文档处理中...</p>
      </div>
    </div>
  )
}

export function FailedViewer({ title, errorMessage }: { title: string; errorMessage?: string | null }) {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-4 p-8">
      <div className="flex items-center justify-center w-16 h-16 rounded-xl bg-destructive/10">
        <FileText size={28} className="text-destructive" />
      </div>
      <div className="text-center">
        <h1 className="text-lg font-medium">{title}</h1>
        <p className="text-xs text-destructive mt-2">处理失败</p>
        {errorMessage && (
          <p className="text-xs text-muted-foreground mt-1 max-w-sm">{errorMessage}</p>
        )}
      </div>
    </div>
  )
}
