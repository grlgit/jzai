import * as fs from 'fs';
import * as path from 'path';

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export function loadMigrations(): Migration[] {
  const dir = __dirname;
  const files = fs.readdirSync(dir)
    .filter(f => /^\d{3}_.*\.sql$/.test(f))
    .sort();

  return files.map(f => {
    const version = parseInt(f.substring(0, 3), 10);
    const name = f.replace(/\.sql$/, '');
    const sql = fs.readFileSync(path.join(dir, f), 'utf-8');
    return { version, name, sql };
  });
}
