// Bundle plugin.ts → plugin.js: a self-contained ESM plugin with socket.io-client inlined,
// so the client package can mount it into OpenClaw's state-dir extensions with no npm install.
//
// plugin.js is committed, so packaging the Windows client does NOT run this script —
// only re-run it after editing plugin.ts.
//
// Run: node build.mjs
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const dir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(dir, '..', '..', '..', '..');

// Build-time only tooling; neither package is a runtime dependency of the client.
const require = createRequire(import.meta.url);
const { build } = require(path.join(repoRoot, 'openclaw', 'node_modules', 'esbuild'));
const mainNodeModules = path.join(repoRoot, 'main', 'node_modules');

await build({
  entryPoints: [path.join(dir, 'plugin.ts')],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outfile: path.join(dir, 'plugin.js'),
  nodePaths: [mainNodeModules], // resolve socket.io-client (lives in main/)
  // ESM output; some bundled CJS deps use require() → provide it via createRequire.
  banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  logLevel: 'info',
});
console.log('[jianzhi-bridge] built plugin.js');
