/**
 * 见智 APP 通用构建脚本（在 APP 工程根目录运行：node build.mjs）。
 *
 * 产物规则（与平台加载器约定一致）：
 * - backend：tsc 编译 src/ → dist/backend/（CJS，不打包；纯 JS 依赖在打包期 npm ci 进 node_modules）
 * - pages：esbuild 每面板一个 ESM（react 经 alias 指向 shim，共享宿主 React）
 * - schemas：esbuild ESM（面板消息校验器，可选）
 */
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const SDK_LIB = path.join(ROOT, 'sdk-lib'); // 由模板从 SDK lib/ 拷入（含 react-shim 等）
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));

fs.rmSync(path.join(ROOT, 'dist'), { recursive: true, force: true });

// ── backend → CJS（tsc）──
if (manifest.backend) {
  execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.backend.json'],
    { cwd: ROOT, stdio: 'inherit' },
  );
  console.log('✓ backend (tsc → dist/backend)');
}

// ── pages → ESM（每面板一个 bundle）──
const pagesDir = path.join(ROOT, 'pages');
if (fs.existsSync(pagesDir)) {
  const entries = fs.readdirSync(pagesDir).filter(f => f.endsWith('.tsx'));
  for (const f of entries) {
    const name = f.replace(/\.tsx$/, '.js');
    await build({
      entryPoints: [path.join(pagesDir, f)],
      outfile: path.join(ROOT, 'dist', 'pages', name),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2020',
      jsx: 'automatic',
      alias: {
        react: path.join(SDK_LIB, 'react-shim.ts'),
        'react/jsx-runtime': path.join(SDK_LIB, 'jsx-runtime-shim.ts'),
      },
      logLevel: 'warning',
    });
    console.log(`✓ pages/${f} → dist/pages/${name}`);
  }
}

// ── schemas → ESM（可选）──
const schemasDir = path.join(ROOT, 'schemas');
if (fs.existsSync(schemasDir)) {
  for (const f of fs.readdirSync(schemasDir).filter(f => f.endsWith('.ts'))) {
    const name = f.replace(/\.ts$/, '.js');
    await build({
      entryPoints: [path.join(schemasDir, f)],
      outfile: path.join(ROOT, 'dist', 'schemas', name),
      bundle: true,
      platform: 'browser',
      format: 'esm',
      target: 'es2020',
      logLevel: 'warning',
    });
    console.log(`✓ schemas/${f} → dist/schemas/${name}`);
  }
}

console.log('build done');
