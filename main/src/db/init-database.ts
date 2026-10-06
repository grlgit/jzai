/**
 * Pre-NestJS database initialization.
 *
 * Runs BEFORE NestFactory.create() to ensure all tables exist and seed data
 * is in place. This eliminates race conditions between parallel onModuleInit hooks.
 *
 * Usage: await initDatabase() in main.ts before creating the NestJS app.
 */

import { Pool } from 'pg';
import { loadMigrations } from './migrations';

const log = (msg: string) => console.log(`[InitDB] ${msg}`);
const warn = (msg: string) => console.warn(`[InitDB] ${msg}`);

// ── Seed data (must match service defaults) ───────────────────────────────

const SEED_ROLES = [
  { id: 'admin', name: '管理员', description: '拥有系统全部权限', permissions: ['chat:use','chat:coworker','kb:read','kb:write','kb:review','cw:view','cw:manage','cw:build','dash:view','dash:view_all','cfg:model','cfg:automation','cfg:users','sys:admin'], isSystem: true },
  { id: 'user', name: '普通用户', description: '使用对话、查看企业心智、查看个人看板', permissions: ['chat:use','chat:coworker','kb:read','dash:view'], isSystem: true },
];

const SEED_PANELS = [
  { id: 'cw', name: 'CoWorker', icon: 'img:/icons/AI员工.svg', permission: 'cw:view', isBuiltin: false, sortOrder: 2 },
  { id: 'dash', name: '看板', icon: 'img:/icons/看板.svg', permission: 'dash:view', isBuiltin: false, sortOrder: 3 },
  { id: 'skills', name: '技能', icon: 'img:/icons/技能.svg', permission: 'cfg:automation', isBuiltin: false, sortOrder: 4 },
  { id: 'connectors', name: '连接', icon: 'img:/icons/连接.svg', permission: 'cfg:automation', isBuiltin: false, sortOrder: 5 },
  { id: 'agents', name: '智能体', icon: 'img:/icons/智能体.svg', permission: 'sys:admin', isBuiltin: false, sortOrder: 6 },
  { id: 'users', name: '用户', icon: 'img:/icons/用户.svg', permission: 'cfg:users', isBuiltin: false, sortOrder: 7 },
  { id: 'cfg', name: '设置', icon: '⚙', permission: null, isBuiltin: true, sortOrder: 8 },
];

// ── Main entry ────────────────────────────────────────────────────────────

export async function initDatabase() {
  const host = process.env.PG_HOST || 'localhost';
  const port = Number(process.env.PG_PORT || 5432);
  const database = process.env.PG_DATABASE || 'jianzhi';
  const user = process.env.PG_USER || 'postgres';
  const password = process.env.PG_PASSWORD || 'postgres';

  const pool = new Pool({ host, port, database, user, password, max: 3 });

  // 1. Wait for DB connection (retry up to 30s for Docker DNS + PG startup)
  log(`Connecting to ${user}@${host}:${port}/${database} ...`);
  for (let i = 1; i <= 30; i++) {
    try {
      await pool.query('SELECT 1');
      log('Connected');
      break;
    } catch (err: any) {
      if (i === 30) {
        warn(`Connection failed after 30 attempts: ${err.message}`);
        throw err;
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // 2. Run migrations
  await runMigrations(pool);

  // 3. Seed default data (idempotent)
  await seedRoles(pool);
  await seedPanels(pool);

  log('Database initialization complete');
  await pool.end();
}

// ── Migrations ────────────────────────────────────────────────────────────

async function runMigrations(pool: Pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS jz_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);

  const { rows } = await pool.query('SELECT version FROM jz_migrations ORDER BY version');
  const applied = new Set(rows.map(r => r.version));

  const migrations = loadMigrations();
  let count = 0;

  for (const m of migrations) {
    if (applied.has(m.version)) continue;

    log(`Applying migration ${m.name} ...`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(m.sql);
      await client.query('INSERT INTO jz_migrations (version, name) VALUES ($1, $2)', [m.version, m.name]);
      await client.query('COMMIT');
      count++;
    } catch (err: any) {
      await client.query('ROLLBACK');
      warn(`Migration ${m.name} failed: ${err.message}`);
      throw err;
    } finally {
      client.release();
    }
  }

  if (count > 0) log(`${count} migration(s) applied`);
  else log('Schema up to date');
}

// ── Seeds ─────────────────────────────────────────────────────────────────

async function seedRoles(pool: Pool) {
  for (const r of SEED_ROLES) {
    await pool.query(
      `INSERT INTO jz_roles(id, name, description, permissions, is_system)
       VALUES($1,$2,$3,$4,$5) ON CONFLICT(id) DO NOTHING`,
      [r.id, r.name, r.description, r.permissions, r.isSystem],
    );
  }
}

async function seedPanels(pool: Pool) {
  for (const p of SEED_PANELS) {
    await pool.query(
      `INSERT INTO jz_panels(id, name, icon, permission, is_builtin, sort_order)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET
         name=EXCLUDED.name, icon=EXCLUDED.icon, permission=EXCLUDED.permission,
         is_builtin=EXCLUDED.is_builtin, sort_order=EXCLUDED.sort_order`,
      [p.id, p.name, p.icon, p.permission, p.isBuiltin, p.sortOrder],
    );
  }
}
