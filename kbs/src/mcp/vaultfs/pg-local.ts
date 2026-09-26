/**
 * PgLocalVaultFS — 对译 llm_wiki/mcp/vaultfs/pg_local.py（jz_kb_* 表 + 本地文件系统）。
 * 所有 SQL 保持与 Python 一致的语义；scope 过滤 fail-closed。
 *
 * 与 Python 的一处有依据偏差：Python 查 `SELECT role FROM jz_users`（列不存在，
 * pg_local 下必报错），TS 改查 role_id —— 显式 scopes 路径（main 实际使用）逐字一致。
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../../shared/db';
import { scopeFilterSql } from '../../shared/scopes';

export const ADMIN_ALL = 'ADMIN_ALL';

export class PgLocalVaultFS {
  constructor(
    private readonly db: Db,
    private readonly workspace: string,
    private readonly userId: string,
  ) {}

  // ── KB（静态单例）──────────────────────────────────────────────────────

  async resolveKb(_slug: string): Promise<any | null> {
    return { id: 'default', slug: 'default', name: 'Enterprise Mind' };
  }

  async listKnowledgeBases(): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT ' +
        "(SELECT count(*)::int FROM jz_kb_documents WHERE source_kind != 'wiki' AND status = 'ready') AS source_count, " +
        "(SELECT count(*)::int FROM jz_kb_documents WHERE source_kind = 'wiki' AND status = 'ready') AS wiki_count",
    );
    return [
      {
        name: 'Enterprise Mind',
        slug: 'default',
        source_count: rows[0]?.source_count ?? 0,
        wiki_count: rows[0]?.wiki_count ?? 0,
      },
    ];
  }

  // ── 权限解析 ───────────────────────────────────────────────────────────

  /**
   * 返回可访问 category_id 集合；null 表示不过滤。
   * - explicitScopes 由可信调用方（main 签名代理）提供；含 ADMIN_ALL → 不过滤
   * - 否则按 jz_kb_category_access 递归解析；fail-closed：无 ACL 行 → 空集
   */
  async accessibleScopes(
    userId?: string | null,
    explicitScopes?: string[] | null,
  ): Promise<Set<string> | null> {
    if (explicitScopes != null) {
      if (explicitScopes.includes(ADMIN_ALL)) return new Set([ADMIN_ALL]);
      return new Set(explicitScopes);
    }
    if (!userId) return new Set();

    const count = await this.db.query('SELECT count(*)::int AS c FROM jz_kb_category_access');
    if ((count.rows[0]?.c ?? 0) === 0) return new Set();

    const role = await this.db.query('SELECT role_id FROM jz_users WHERE id = $1', [userId]);
    const roleId = role.rows[0]?.role_id;
    if (roleId === 'owner' || roleId === 'admin') return new Set([ADMIN_ALL]);

    const depts = await this.db.query('SELECT department_id FROM jz_department_members WHERE user_id = $1', [userId]);
    const wgs = await this.db.query('SELECT workgroup_id FROM jz_workgroup_members WHERE user_id = $1', [userId]);
    const deptIds = depts.rows.map((r) => r.department_id);
    const wgIds = wgs.rows.map((r) => r.workgroup_id);

    const { rows } = await this.db.query(
      `WITH RECURSIVE accessible AS (
         SELECT DISTINCT category_id FROM jz_kb_category_access
         WHERE (grantee_type = 'user' AND grantee_id = $1)
            OR (grantee_type = 'department' AND grantee_id = ANY($2::text[]))
            OR (grantee_type = 'workgroup' AND grantee_id = ANY($3::text[]))
         UNION ALL
         SELECT c.id FROM jz_kb_categories c
         JOIN accessible a ON c.parent_id = a.category_id
       )
       SELECT category_id FROM accessible`,
      [userId, deptIds, wgIds],
    );
    return new Set(rows.map((r) => String(r.category_id)));
  }

  private scopeFilter(scopes: Set<string> | null, paramIdx: number, alias: string) {
    return scopeFilterSql(scopes, paramIdx, alias, this.userId);
  }

  // ── 文档查询 ───────────────────────────────────────────────────────────

  async listDocuments(kbId: string, scopes: Set<string> | null = null): Promise<any[]> {
    const sf = this.scopeFilter(scopes, 1, 'd');
    const { rows } = await this.db.query(
      'SELECT id, filename, title, path, file_type, tags, page_count, updated_at, category_id, metadata ' +
        `FROM jz_kb_documents d WHERE status = 'ready'${sf.sql} ORDER BY path, filename`,
      sf.params,
    );
    return rows;
  }

  async listDocumentsWithContent(kbId: string, scopes: Set<string> | null = null): Promise<any[]> {
    const sf = this.scopeFilter(scopes, 1, 'd');
    const { rows } = await this.db.query(
      'SELECT id, filename, title, path, content, tags, file_type, page_count, category_id, metadata ' +
        `FROM jz_kb_documents d WHERE status = 'ready'${sf.sql} ORDER BY path, filename`,
      sf.params,
    );
    return rows;
  }

  async getDocument(kbId: string, filename: string, dirPath: string): Promise<any | null> {
    const { rows } = await this.db.query(
      'SELECT id, owner_user_id, filename, title, path, relative_path, content, tags, version, ' +
        'file_type, page_count, created_at, updated_at ' +
        "FROM jz_kb_documents WHERE filename = $1 AND path = $2 AND status = 'ready'",
      [filename, dirPath],
    );
    return rows[0] || null;
  }

  async findDocumentByName(kbId: string, name: string): Promise<any | null> {
    const { rows } = await this.db.query(
      'SELECT id, owner_user_id, filename, title, path, relative_path, content, tags, version, ' +
        'file_type, page_count, created_at, updated_at ' +
        'FROM jz_kb_documents ' +
        "WHERE (lower(filename) = lower($1) OR lower(title) = lower($1)) AND status = 'ready'",
      [name],
    );
    return rows[0] || null;
  }

  async createDocument(
    kbId: string,
    filename: string,
    title: string,
    dirPath: string,
    fileType: string,
    content: string,
    tags: string[],
    date: string | null = null,
    metadata: Record<string, any> | null = null,
  ): Promise<any> {
    const docId = randomUUID();
    const relativePath = `${dirPath.replace(/\/$/, '')}/${filename}`.replace(/^\//, '');
    const sourceKind = dirPath.replace(/^\//, '').startsWith('wiki') ? 'wiki' : 'source';

    let ownerId: string | null = null;
    if (dirPath.includes('/personal/')) {
      const u = await this.db.query('SELECT 1 FROM jz_users WHERE id = $1', [this.userId]);
      if (u.rows.length > 0) ownerId = this.userId;
    }

    await this.db.query(
      'INSERT INTO jz_kb_documents ' +
        '(id, owner_user_id, filename, title, path, relative_path, source_kind, ' +
        'file_type, status, content, tags, date, metadata, version) ' +
        "VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'ready', $9, $10, $11, $12::jsonb, 0)",
      [
        docId, ownerId, filename, title, dirPath, relativePath, sourceKind,
        fileType, content, tags, date,
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    return { id: docId, filename, path: dirPath };
  }

  async updateDocument(
    docId: string,
    content: string,
    tags: string[] | null = null,
    title: string | null = null,
    date: string | null = null,
    metadata: Record<string, any> | null = null,
  ): Promise<void> {
    const sets = ['content = $1', 'version = version + 1', 'updated_at = NOW()'];
    const params: any[] = [content, docId];
    let idx = 3;
    if (title !== null) {
      sets.push(`title = $${idx++}`);
      params.push(title);
    }
    if (tags !== null) {
      sets.push(`tags = $${idx++}`);
      params.push(tags);
    }
    if (date !== null) {
      sets.push(`date = $${idx++}`);
      params.push(date);
    }
    if (metadata !== null) {
      sets.push(`metadata = $${idx++}::jsonb`);
      params.push(JSON.stringify(metadata));
    }
    await this.db.query(`UPDATE jz_kb_documents SET ${sets.join(', ')} WHERE id = $2`, params);
  }

  /** pg_local 语义：硬删除（Python archive_documents 实为 DELETE） */
  async archiveDocuments(docIds: string[]): Promise<number> {
    if (docIds.length === 0) return 0;
    const r = await this.db.query('DELETE FROM jz_kb_documents WHERE id = ANY($1::text[])', [docIds]);
    return r.rowCount ?? 0;
  }

  // ── Pages ──────────────────────────────────────────────────────────────

  async getPages(docId: string, pageNums: number[]): Promise<any[]> {
    if (pageNums.length === 0) return [];
    const { rows } = await this.db.query(
      'SELECT page, content, elements FROM jz_kb_document_pages WHERE document_id = $1 AND page = ANY($2) ORDER BY page',
      [docId, pageNums],
    );
    return rows.map((r) => ({
      ...r,
      elements: typeof r.elements === 'string' ? safeJson(r.elements) : r.elements,
    }));
  }

  async getAllPages(docId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT page, content, elements FROM jz_kb_document_pages WHERE document_id = $1 ORDER BY page',
      [docId],
    );
    return rows.map((r) => ({
      ...r,
      elements: typeof r.elements === 'string' ? safeJson(r.elements) : r.elements,
    }));
  }

  // ── 搜索（pg_trgm + ILIKE；同义词组 OR 重写，见 taxonomy.expandQueryOrGroups）──

  async searchChunks(
    kbId: string,
    query: string,
    limit: number,
    pathFilter: string | null = null,
    scopes: Set<string> | null = null,
    orGroups?: string[][],
  ): Promise<any[]> {
    // 默认整串 ILIKE（无同义词展开时与 Python 一致）
    const groups = orGroups && orGroups.length > 0 ? orGroups : [[query]];
    let sql =
      'SELECT dc.content, dc.page, dc.header_breadcrumb, dc.chunk_index, ' +
      'd.filename, d.title, d.path, d.file_type, d.tags, d.category_id, d.metadata, ' +
      'similarity(dc.content, $1) AS score ' +
      'FROM jz_kb_document_chunks dc ' +
      'JOIN jz_kb_documents d ON dc.document_id = d.id ' +
      "WHERE d.status = 'ready' ";
    const params: any[] = [query];
    let idx = 2;

    // AND-of-OR 组：每组内任一 term 命中即算该组命中
    const groupConds: string[] = [];
    for (const group of groups) {
      const ors: string[] = [];
      for (const term of group) {
        ors.push(`dc.content ILIKE '%' || $${idx++} || '%'`);
        params.push(term);
      }
      groupConds.push(`(${ors.join(' OR ')})`);
    }
    sql += `AND ${groupConds.join(' AND ')} `;

    if (pathFilter === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (pathFilter === 'sources') sql += "AND d.source_kind != 'wiki' ";

    sql += "AND COALESCE(d.sensitivity, 'public') != 'restricted' ";

    const sf = this.scopeFilter(scopes, idx, 'd');
    sql += sf.sql;
    params.push(...sf.params);

    sql += `ORDER BY score DESC LIMIT $${sf.nextIdx}`;
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  /** hybrid 在 pg_local 退化为 searchChunks（无向量，对齐 Python） */
  async searchChunksHybrid(
    kbId: string,
    query: string,
    limit: number,
    pathFilter: string | null = null,
    scopes: Set<string> | null = null,
    orGroups?: string[][],
  ): Promise<any[]> {
    return this.searchChunks(kbId, query, limit, pathFilter, scopes, orGroups);
  }

  async searchDocumentsFull(
    kbId: string,
    query: string,
    limit: number,
    pathFilter: string | null = null,
    scopes: Set<string> | null = null,
  ): Promise<any[]> {
    let sql =
      'SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, ' +
      'd.file_type, d.source_kind, d.page_count, d.category_id, d.metadata, ' +
      'MAX(similarity(dc.content, $1)) AS best_score ' +
      'FROM jz_kb_document_chunks dc ' +
      'JOIN jz_kb_documents d ON dc.document_id = d.id ' +
      "WHERE dc.content ILIKE '%' || $1 || '%' AND d.status = 'ready' ";
    const params: any[] = [query];
    let idx = 2;

    if (pathFilter === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (pathFilter === 'sources') sql += "AND d.source_kind != 'wiki' ";

    const sf = this.scopeFilter(scopes, idx, 'd');
    sql += sf.sql;
    params.push(...sf.params);

    sql += `GROUP BY d.id ORDER BY best_score DESC LIMIT $${sf.nextIdx}`;
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  async searchDocumentsByContent(
    kbId: string,
    keywords: string[],
    limit: number,
    pathFilter: string | null = null,
    scopes: Set<string> | null = null,
  ): Promise<any[]> {
    if (keywords.length === 0) return [];
    const likeCases: string[] = [];
    const whereParts: string[] = [];
    const params: any[] = [];
    let idx = 1;
    for (const kw of keywords) {
      likeCases.push(`(CASE WHEN d.content ILIKE $${idx} THEN 1 ELSE 0 END)`);
      whereParts.push(`d.content ILIKE $${idx}`);
      params.push(`%${kw}%`);
      idx += 1;
    }

    let sql =
      'SELECT d.id, d.filename, d.title, d.path, d.content, d.tags, ' +
      'd.file_type, d.source_kind, d.page_count, ' +
      `(${likeCases.join(' + ')}) AS match_score ` +
      'FROM jz_kb_documents d ' +
      "WHERE d.status = 'ready' AND d.content IS NOT NULL " +
      `AND (${whereParts.join(' OR ')}) `;

    if (pathFilter === 'wiki') sql += "AND d.source_kind = 'wiki' ";
    else if (pathFilter === 'sources') sql += "AND d.source_kind != 'wiki' ";

    const sf = this.scopeFilter(scopes, idx, 'd');
    sql += sf.sql;
    params.push(...sf.params);

    sql += `ORDER BY match_score DESC LIMIT $${sf.nextIdx}`;
    params.push(limit);

    const { rows } = await this.db.query(sql, params);
    return rows;
  }

  // ── 引用图 ─────────────────────────────────────────────────────────────

  async deleteReferences(sourceDocId: string): Promise<void> {
    await this.db.query('DELETE FROM jz_kb_document_references WHERE source_document_id = $1', [
      sourceDocId,
    ]);
  }

  async upsertReference(
    sourceId: string,
    targetId: string,
    kbId: string,
    refType: string,
    page: number | null,
  ): Promise<void> {
    try {
      await this.db.query(
        'INSERT INTO jz_kb_document_references ' +
          '(source_document_id, target_document_id, reference_type, page) ' +
          'VALUES ($1, $2, $3, $4) ' +
          'ON CONFLICT (source_document_id, target_document_id, reference_type) ' +
          'DO UPDATE SET page = EXCLUDED.page',
        [sourceId, targetId, refType, page],
      );
    } catch (err: any) {
      console.warn(`[kbs] 引用写入失败 ${sourceId.slice(0, 8)} -> ${targetId.slice(0, 8)}: ${err.message}`);
    }
  }

  async propagateStaleness(docId: string): Promise<void> {
    await this.db.query(
      'UPDATE jz_kb_documents SET stale_since = NOW() ' +
        'WHERE id IN (' +
        '  SELECT source_document_id FROM jz_kb_document_references ' +
        "  WHERE target_document_id = $1 AND reference_type = 'links_to'" +
        ') AND stale_since IS NULL',
      [docId],
    );
  }

  async propagateStalenessFromSource(sourceDocId: string): Promise<void> {
    await this.db.query(
      'UPDATE jz_kb_documents SET stale_since = NOW() ' +
        'WHERE id IN (' +
        '  SELECT source_document_id FROM jz_kb_document_references ' +
        "  WHERE target_document_id = $1 AND reference_type = 'cites'" +
        ') AND stale_since IS NULL',
      [sourceDocId],
    );
  }

  async getSourceCompilationStatus(kbId: string): Promise<Record<string, string>> {
    const { rows } = await this.db.query(
      'SELECT r.target_document_id AS source_id, ' +
        '  d.filename AS wiki_filename, d.stale_since ' +
        'FROM jz_kb_document_references r ' +
        'JOIN jz_kb_documents d ON r.source_document_id = d.id ' +
        "WHERE r.reference_type = 'cites' " +
        "  AND d.path LIKE '/wiki/%' " +
        '  AND r.target_document_id IN (' +
        "    SELECT id FROM jz_kb_documents WHERE source_kind = 'source'" +
        "    AND path != '/' AND id IN (SELECT id FROM jz_kb_documents WHERE true)" +
        '  )',
    );
    const statusMap = new Map<string, { citingPages: string[]; hasStale: boolean }>();
    for (const row of rows) {
      const sid = String(row.source_id);
      if (!statusMap.has(sid)) statusMap.set(sid, { citingPages: [], hasStale: false });
      const info = statusMap.get(sid)!;
      info.citingPages.push(String(row.wiki_filename));
      if (row.stale_since !== null) info.hasStale = true;
    }
    const result: Record<string, string> = {};
    for (const [sid, info] of statusMap) {
      result[sid] = info.hasStale ? 'needs_update' : 'current';
    }
    return result;
  }

  async getBacklinks(docId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT d.path, d.filename, d.title, dr.reference_type ' +
        'FROM jz_kb_document_references dr ' +
        'JOIN jz_kb_documents d ON dr.source_document_id = d.id ' +
        "WHERE dr.target_document_id = $1 AND d.status = 'ready' " +
        'ORDER BY d.path, d.filename',
      [docId],
    );
    return rows;
  }

  async getForwardReferences(docId: string): Promise<any[]> {
    const { rows } = await this.db.query(
      'SELECT d.filename, d.title, d.path, dr.reference_type, dr.page ' +
        'FROM jz_kb_document_references dr ' +
        'JOIN jz_kb_documents d ON dr.target_document_id = d.id ' +
        "WHERE dr.source_document_id = $1 AND d.status = 'ready' " +
        'ORDER BY dr.reference_type, d.path, d.filename',
      [docId],
    );
    return rows;
  }

  async findUncitedSources(kbId: string, scopes: Set<string> | null = null): Promise<any[]> {
    const sf = this.scopeFilter(scopes, 1, 'd');
    const { rows } = await this.db.query(
      'SELECT d.filename, d.title, d.path, d.file_type, d.category_id, d.metadata ' +
        'FROM jz_kb_documents d ' +
        "WHERE d.source_kind != 'wiki' AND d.source_kind != 'asset' " +
        `AND d.status = 'ready'${sf.sql} ` +
        'AND d.id NOT IN (' +
        '  SELECT target_document_id FROM jz_kb_document_references ' +
        "  WHERE reference_type = 'cites'" +
        ') ORDER BY d.filename',
      sf.params,
    );
    return rows;
  }

  async findStalePages(kbId: string, scopes: Set<string> | null = null): Promise<any[]> {
    const sf = this.scopeFilter(scopes, 1, 'd');
    const { rows } = await this.db.query(
      'SELECT d.filename, d.title, d.path, d.stale_since, d.category_id ' +
        'FROM jz_kb_documents d ' +
        `WHERE d.status = 'ready' AND d.stale_since IS NOT NULL${sf.sql} ` +
        'ORDER BY d.stale_since DESC',
      sf.params,
    );
    return rows;
  }

  // ── 文件 I/O（本地文件系统，防穿越）─────────────────────────────────────

  private resolvePath(relativePath: string): string | null {
    const ws = this.workspace;
    const resolved = path.resolve(ws, relativePath);
    if (resolved !== ws && !resolved.startsWith(ws + path.sep)) return null;
    return resolved;
  }

  private loadLocalBytes(key: string): Buffer | null {
    const cachePath = this.resolvePath(path.join('.llmwiki', 'cache', key));
    if (cachePath && fs.existsSync(cachePath) && fs.statSync(cachePath).isFile()) {
      return fs.readFileSync(cachePath);
    }
    const rootPath = this.resolvePath(key);
    if (rootPath && fs.existsSync(rootPath) && fs.statSync(rootPath).isFile()) {
      return fs.readFileSync(rootPath);
    }
    return null;
  }

  async loadSourceBytes(doc: any): Promise<Buffer | null> {
    const relative =
      doc.relative_path || `${(doc.path as string).replace(/\/$/, '')}/${doc.filename}`.replace(/^\//, '');
    return this.loadLocalBytes(relative);
  }

  async loadImageBytes(_docId: string, _imageId: string): Promise<Buffer | null> {
    return null; // pg_local 无图片存储（对齐 Python）
  }

  writeToDisk(dirPath: string, filename: string, content: string): boolean {
    const filePath = this.resolvePath(dirPath.replace(/^\//, '') + filename);
    if (!filePath) return false;
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
    return true;
  }

  deleteFromDisk(docs: any[]): void {
    for (const d of docs) {
      const relative = (d.path as string).replace(/^\//, '') + d.filename;
      const filePath = this.resolvePath(relative);
      if (filePath && fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
}

function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}
