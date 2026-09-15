// ── Enterprise types ──────────────────────────────────────────────────────

export type OrgRole = 'owner' | 'admin' | 'member'
export type DeptRole = 'member' | 'editor'
export type AccessScope = 'global' | `department:${string}` | `personal:${string}` | `restricted:${string}`

export interface Organization {
  id: string
  name: string
  slug: string
  language: string
}

export interface Department {
  id: string
  org_id: string
  name: string
  slug: string
  head_email: string | null
  subdirectory_attribute: string | null
  subdirectory_label: string | null
}

export interface OrgMember {
  id: string
  email: string
  display_name: string | null
  role: OrgRole
}

export interface DepartmentMember {
  id: string
  email: string
  role: DeptRole
}

// ── Knowledge Base ───────────────────────────────────────────────────────

export interface KnowledgeBase {
  id: string
  user_id: string
  name: string
  slug: string
  description: string | null
  source_count: number
  wiki_page_count: number
  created_at: string
  updated_at: string
}

export interface Document {
  id: string
  knowledge_base_id: string
  user_id: string
  filename: string
  title: string | null
  path: string
  file_type: string
  file_size: number
  status: string
  page_count: number | null
  content: string | null
  tags: string[]
  date: string | null
  metadata: Record<string, unknown> | null
  access_scope: AccessScope | null
  error_message: string | null
  url: string | null
  version: number
  document_number: number | null
  sort_order: number | null
  archived: boolean
  stale_since: string | null
  created_at: string
  updated_at: string
}

export type DocumentListItem = Omit<Document, 'content'>

export type PropertyType = 'text' | 'number' | 'date' | 'checkbox' | 'select' | 'url'

export interface TypedProperty {
  type: PropertyType
  value: string | number | boolean | null
  options?: string[]
}

export type PropertyMap = Record<string, TypedProperty>

export interface WikiNode {
  title: string
  path?: string
  docNumber?: number | null
  children?: WikiNode[]
}

export interface WikiSubsection {
  id: string
  title: string
}

// ── Directory metadata (from SCHEMA.md) ─────────────────────────────────

export interface DirectoryMeta {
  path: string
  scope: 'global' | 'department' | 'personal' | 'restricted'
  department_name?: string
  department_slug?: string
  subdirectory_attribute?: string
  subdirectory_label?: string
  description?: string
}

/** Parsed from document.metadata JSON — e.g. { customer: "LC-Waikiki" } */
export type DocumentMetadata = Record<string, string>
