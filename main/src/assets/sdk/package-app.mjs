/**
 * 通用 .jzapp 打包脚本（在 APP 工程根目录运行：node package-app.mjs [输出名.jzapp]）。
 *
 * 流程：拷贝打包输入到临时目录 → npm ci --omit=dev（生产依赖随包分发）
 * → 裁剪 node_modules → zip 为 .jzapp。
 * 注意：仅纯 JS 依赖可随包分发，且必须在平台 BACKEND_DEP_WHITELIST 白名单内；
 * 原生模块（.node）不可（sharp 等白名单预编译包除外）。
 */
import { cpSync, existsSync, mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = process.cwd();
const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf8'));
const archivePath = process.argv[2]
  ? join(packageRoot, process.argv[2])
  : join(packageRoot, `${manifest.shortName}-${manifest.version}.jzapp`);
const stagingDir = mkdtempSync(join(tmpdir(), `${manifest.shortName}-`));

// 打包输入：存在的才拷（agents/skills/migrations/pages 源码不进包，仅 dist 进）
const packageInputs = [
  'manifest.json',
  'package.json',
  'package-lock.json',
  'dist',
  'agents',
  'skills',
  'migrations',
  'config',
  'README.md',
];

for (const input of packageInputs) {
  const source = join(packageRoot, input);
  if (!existsSync(source)) continue;
  cpSync(source, join(stagingDir, input), { recursive: true });
}

if (!existsSync(join(stagingDir, 'manifest.json'))) throw new Error('Missing manifest.json');
if (!existsSync(join(stagingDir, 'dist'))) throw new Error('Missing dist/ — 先运行 node build.mjs');

try {
  if (existsSync(join(packageRoot, 'package-lock.json'))) {
    const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    execFileSync(npm, ['ci', '--omit=dev', '--ignore-scripts'], { cwd: stagingDir, stdio: 'inherit' });

    // 只清理各依赖包根目录下一层的同名目录，绝不递归进包内部（教训：exceljs/lib/doc 曾被误删）
    const nmRoot = join(stagingDir, 'node_modules');
    // npm executable shims are symlinks and are never needed by app runtime code.
    rmSync(join(nmRoot, '.bin'), { recursive: true, force: true });
    const pruneNames = new Set(['test', 'tests', 'docs', 'doc', 'examples', 'example', 'demos', 'demo', 'benchmarks', 'website', '.github', '.git']);
    const pkgDirs = [];
    for (const entry of readdirSync(nmRoot, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
      if (entry.name.startsWith('@')) {
        for (const sub of readdirSync(join(nmRoot, entry.name), { withFileTypes: true })) {
          if (sub.isDirectory()) pkgDirs.push(join(nmRoot, entry.name, sub.name));
        }
      } else {
        pkgDirs.push(join(nmRoot, entry.name));
      }
    }
    for (const pkgDir of pkgDirs) {
      for (const child of readdirSync(pkgDir, { withFileTypes: true })) {
        if (child.isDirectory() && pruneNames.has(child.name)) {
          rmSync(join(pkgDir, child.name), { recursive: true, force: true });
        }
      }
    }
  }

  rmSync(join(stagingDir, 'package-lock.json'), { force: true });

  // ── 包签名（设置 APP_PACKAGE_PRIVATE_KEY 时启用）──
  // 生成 PACKAGE-SIGNATURE.json：{files:{相对路径:sha256}, signature}
  // 文件集合必须与 zip 产物一致（复刻下方 zip -x 排除规则）
  if (process.env.APP_PACKAGE_PRIVATE_KEY) {
    const { createHash, createPrivateKey, sign } = await import('node:crypto');
    const zipExcludeBasename = (rel) => {
      const base = rel.split('/').pop();
      if (base.startsWith('._') || base === '.DS_Store') return true;
      if (rel.includes('node_modules/')) {
        if (/\.(map|md|d\.ts|d\.mts|ts)$/.test(base)) return true;
        if (/^(LICENSE|CHANGELOG)/.test(base)) return true;
        if (base === 'Makefile' || base === 'tsconfig.json') return true;
      }
      return false;
    };
    const files = {};
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (!entry.isFile()) continue;
        const rel = full.slice(stagingDir.length + 1).split(sep).join('/');
        if (zipExcludeBasename(rel)) continue;
        files[rel] = createHash('sha256').update(readFileSync(full)).digest('hex');
      }
    };
    walk(stagingDir);
    const sorted = {};
    for (const k of Object.keys(files).sort()) sorted[k] = files[k];
    const canonical = JSON.stringify({ files: sorted });
    const privateKey = createPrivateKey(process.env.APP_PACKAGE_PRIVATE_KEY.replace(/\\n/g, '\n'));
    const signature = sign(null, Buffer.from(canonical, 'utf8'), privateKey).toString('base64');
    writeFileSync(join(stagingDir, 'PACKAGE-SIGNATURE.json'), JSON.stringify({ files: sorted, signature }));
    console.log(`Signed package (${Object.keys(files).length} files)`);
  } else {
    console.log('APP_PACKAGE_PRIVATE_KEY 未设置 —— 跳过包签名（官方包安装将被平台拒绝）');
  }

  rmSync(archivePath, { force: true });
  execFileSync('zip', [
    '-qry', archivePath, '.',
    '-x', '._*', '*/._*', '.DS_Store', '*/.DS_Store',
    'node_modules/**/*.map', 'node_modules/**/*.md', 'node_modules/**/*.d.ts',
    'node_modules/**/*.d.mts', 'node_modules/**/*.ts', 'node_modules/**/LICENSE*',
    'node_modules/**/CHANGELOG*', 'node_modules/**/Makefile', 'node_modules/**/tsconfig.json',
  ], { cwd: stagingDir, stdio: 'inherit' });
  console.log(`Created ${archivePath}`);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}
