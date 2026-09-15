import { Injectable, Logger } from '@nestjs/common';
import { CoWorkerService, CoWorker } from './coworker.service';
import { CoWorkerConfigService } from './coworker-config.service';
import { WorkspaceService } from '../../workspace/workspace.service';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

/**
 * Build service for CoWorker deployment packages.
 *
 * Two modes:
 * 1. Server-side build: docker buildx (requires Docker daemon)
 * 2. Local build export: pre-compiled bundle + Dockerfile + scripts (no source code)
 */
@Injectable()
export class CoWorkerBuildService {
  private readonly logger = new Logger(CoWorkerBuildService.name);

  constructor(
    private readonly cwService: CoWorkerService,
    private readonly cwConfig: CoWorkerConfigService,
    private readonly workspace: WorkspaceService,
  ) {}

  /**
   * Generate a complete deployment package as an in-memory tar.gz buffer.
   * Contains: docker-compose.yml, .env.template, config/, skills/, build/, scripts/, README.md
   * No source code (.ts) — only pre-compiled JS and config files.
   */
  async generatePackage(coworkerId: string, mainUrl: string): Promise<{
    filename: string;
    files: Array<{ path: string; content: string }>;
  }> {
    const cw = await this.cwService.getById(coworkerId);
    if (!cw) throw new Error('CoWorker 不存在');

    const files: Array<{ path: string; content: string }> = [];
    const pkgName = `cw-${cw.name.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '-').slice(0, 30)}-${cw.id.slice(0, 8)}`;

    // 1. docker-compose.yml
    files.push({
      path: 'docker-compose.yml',
      content: this.cwConfig.generateDockerCompose(cw),
    });

    // 2. .env template
    files.push({
      path: '.env',
      content: this.cwConfig.generateEnvTemplate(cw, mainUrl),
    });

    // 3. OpenClaw config — JSON is loaded by OpenClaw (entrypoint injects token); YAML is a readable ref.
    files.push({
      path: 'config/openclaw.json',
      content: this.cwConfig.generateConfigJson(cw, mainUrl),
    });
    files.push({
      path: 'config/openclaw.yaml',
      content: this.cwConfig.generateConfig(cw, mainUrl),
    });

    // 3b. 人格指令 SOUL.md — 由 entrypoint / 原生安装脚本复制到 workspace 根目录。
    //     不能写进 openclaw.json：新版 OpenClaw 已移除 systemPromptOverride，未知键会导致校验失败。
    const soulMd = this.cwConfig.generateSoulMarkdown(cw);
    if (soulMd) {
      files.push({ path: 'config/SOUL.md', content: soulMd });
    }

    // 4. Dockerfile (for local build — uses pre-compiled dist, no source)
    files.push({
      path: 'build/Dockerfile',
      content: this.generateDockerfile(cw),
    });

    // 5. Build scripts (cross-platform)
    files.push({
      path: 'scripts/build.sh',
      content: this.generateBuildScript(cw, 'bash'),
    });
    files.push({
      path: 'scripts/build.ps1',
      content: this.generateBuildScript(cw, 'powershell'),
    });

    // 5b. Runtime entrypoint (first-run: inject token, install WeChat plugin) + one-click install + WeChat bind
    files.push({ path: 'scripts/entrypoint.sh', content: this.generateEntrypoint(cw) });
    files.push({ path: 'scripts/install.sh', content: this.generateInstallScript(cw, 'bash') });
    files.push({ path: 'scripts/install.ps1', content: this.generateInstallScript(cw, 'powershell') });
    files.push({ path: 'scripts/bind-wechat.sh', content: this.generateBindWechatScript('bash') });
    files.push({ path: 'scripts/bind-wechat.ps1', content: this.generateBindWechatScript('powershell') });
    // 5c. Native (non-Docker) install: run OpenClaw directly with Node.
    files.push({ path: 'scripts/install-native.sh', content: this.generateNativeInstallScript(cw, 'bash') });
    files.push({ path: 'scripts/install-native.ps1', content: this.generateNativeInstallScript(cw, 'powershell') });

    // 6. Minimal package.json (no devDependencies, no build scripts)
    files.push({
      path: 'build/package.json',
      content: JSON.stringify({
        name: pkgName,
        version: '1.0.0',
        private: true,
        main: 'dist/openclaw.mjs',
        scripts: { start: 'node dist/openclaw.mjs gateway run' },
        engines: { node: '>=22.0.0' },
      }, null, 2),
    });

    // 7. jianzhi-bridge plugin runtime (bundled): manifest + package.json + self-contained plugin.js.
    //    Mounted into the container's state-dir extensions so OpenClaw discovers/loads it.
    const bridgeDir = this.getBridgeDir();
    let bridgeBundled = false;
    if (bridgeDir) {
      for (const f of ['openclaw.plugin.json', 'package.json', 'plugin.js']) {
        const p = path.join(bridgeDir, f);
        if (fs.existsSync(p)) {
          files.push({ path: `extensions/jianzhi-bridge/${f}`, content: fs.readFileSync(p, 'utf-8') });
          if (f === 'plugin.js') bridgeBundled = true;
        }
      }
    }
    if (!bridgeBundled) {
      this.logger.warn('jianzhi-bridge plugin.js 未找到 — 审计桥不可用，请先构建插件 bundle（见 extensions/jianzhi-bridge）');
    }

    // 8. Selected skills (copy from workspace — with path boundary check)
    const workRoot = this.workspace.getRoot();
    for (const skillName of cw.skills) {
      // Sanitize skill name to prevent path traversal
      const safeName = skillName.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '');
      if (!safeName || safeName !== skillName) continue;
      const skillPath = this.findSkillFile(safeName);
      if (skillPath && fs.existsSync(skillPath)) {
        // Verify path is within workspace boundary
        const realPath = fs.realpathSync(skillPath);
        if (!realPath.startsWith(fs.realpathSync(workRoot))) {
          this.logger.warn(`Skill path escape blocked: ${skillPath}`);
          continue;
        }
        files.push({
          path: `skills/${safeName}/SKILL.md`,
          content: fs.readFileSync(realPath, 'utf-8'),
        });
      }
    }

    // 9. README
    files.push({
      path: 'README.md',
      content: this.cwConfig.generateReadme(cw),
    });

    return { filename: `${pkgName}.tar.gz`, files };
  }

  /**
   * Generate a Dockerfile that builds from pre-compiled dist, not from source.
   */
  private generateDockerfile(cw: CoWorker): string {
    return `# CoWorker: ${cw.name}
# Built from pre-compiled artifacts — no source code included
FROM node:22-slim

WORKDIR /app

# Copy pre-compiled artifacts only (no .ts source)
COPY package.json ./
COPY dist/ ./dist/
COPY extensions/ ./extensions/

# Install production dependencies only
RUN npm install --omit=dev --ignore-scripts 2>/dev/null || true

# Copy config and skills (mounted at runtime, but include defaults)
COPY ../config/ /app/config/
COPY ../skills/ /app/skills/

# Security: non-root user
RUN groupadd -r openclaw && useradd -r -g openclaw openclaw \\
    && mkdir -p /home/openclaw/.openclaw \\
    && chown -R openclaw:openclaw /app /home/openclaw
USER openclaw

ENV NODE_ENV=production
EXPOSE 18789

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \\
  CMD curl -f http://localhost:18789/health || exit 1

CMD ["node", "dist/openclaw.mjs", "gateway", "run"]
`;
  }

  /**
   * Generate cross-platform build scripts.
   */
  private generateBuildScript(cw: CoWorker, platform: 'bash' | 'powershell'): string {
    const tag = `cw-${cw.id.slice(0, 8)}`;

    if (platform === 'bash') {
      return `#!/bin/bash
# CoWorker 本地构建脚本 — ${cw.name}
set -e

echo "=== 构建 CoWorker Docker 镜像 ==="

# 检查 Docker
if ! command -v docker &> /dev/null; then
    echo "❌ 未安装 Docker，请先安装: https://docs.docker.com/get-docker/"
    exit 1
fi

# 检查 .env
if ! grep -q "JIANZHI_CW_TOKEN=.*[^<]" ../.env 2>/dev/null; then
    echo "❌ 请先编辑 .env 文件，填入 JIANZHI_CW_TOKEN"
    exit 1
fi

# 构建镜像
cd "$(dirname "$0")/../build"
docker build -t ${tag}:latest -f Dockerfile .

echo "✅ 镜像构建完成: ${tag}:latest"
echo ""
echo "启动命令:"
echo "  cd .. && docker compose up -d"
`;
    }

    // PowerShell
    return `# CoWorker 本地构建脚本 — ${cw.name}
$ErrorActionPreference = "Stop"

Write-Host "=== 构建 CoWorker Docker 镜像 ==="

# 检查 Docker
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Host "❌ 未安装 Docker，请先安装: https://docs.docker.com/get-docker/" -ForegroundColor Red
    exit 1
}

# 检查 .env
$envContent = Get-Content "..\.env" -ErrorAction SilentlyContinue
if (-not ($envContent -match "JIANZHI_CW_TOKEN=.+[^<]")) {
    Write-Host "❌ 请先编辑 .env 文件，填入 JIANZHI_CW_TOKEN" -ForegroundColor Red
    exit 1
}

# 构建镜像
Set-Location "$PSScriptRoot\..\build"
docker build -t ${tag}:latest -f Dockerfile .

Write-Host "✅ 镜像构建完成: ${tag}:latest" -ForegroundColor Green
Write-Host ""
Write-Host "启动命令:"
Write-Host "  cd .. ; docker compose up -d"
`;
  }

  /**
   * Runtime entrypoint (mounted into the official OpenClaw image).
   * First run: inject token/mainUrl into openclaw.json (OpenClaw has no ${ENV} expansion),
   * install the Tencent WeChat plugin, then launch the Gateway.
   */
  private generateEntrypoint(cw: CoWorker): string {
    // Single-quoted so ${...} stays literal in the emitted bash; node reads real env at runtime.
    const inject =
      'const fs=require("fs");let s=fs.readFileSync("/app/config/openclaw.json","utf8");' +
      's=s.split("${JIANZHI_CW_TOKEN}").join(process.env.JIANZHI_CW_TOKEN||"");' +
      's=s.split("${JIANZHI_MAIN_URL}").join(process.env.JIANZHI_MAIN_URL||"");' +
      'fs.writeFileSync(process.argv[1],s);';
    return [
      '#!/bin/bash',
      `# CoWorker 运行时入口 — ${cw.name}`,
      'set -e',
      'STATE_DIR="${OPENCLAW_STATE_DIR:-/home/node/.openclaw}"',
      'CONFIG_DST="$STATE_DIR/openclaw.json"',
      'INIT_MARKER="$STATE_DIR/.jz-initialized"',
      'log(){ echo "[cw] $*"; }',
      'mkdir -p "$STATE_DIR"',
      '',
      'if [ ! -f "$INIT_MARKER" ]; then',
      '  log "首次初始化…"',
      '  if [ -f /app/config/openclaw.json ]; then',
      `    node -e '${inject}' "$CONFIG_DST"`,
      '    log "配置已写入 $CONFIG_DST"',
      '  fi',
      '  # 人格指令：SOUL.md 复制到 workspace 根目录（容器内 /workspace）。仅当不存在时写入，',
      '  # 与 OpenClaw 的 writeFileIfMissing 语义一致，避免覆盖用户已修改的 SOUL.md。',
      '  if [ -f /app/config/SOUL.md ] && [ ! -f /workspace/SOUL.md ]; then',
      '    mkdir -p /workspace && cp /app/config/SOUL.md /workspace/SOUL.md && log "人格 SOUL.md 已写入 /workspace"',
      '  fi',
      '  PLUGIN_DIR="$STATE_DIR/extensions/openclaw-weixin"',
      '  if [ ! -d "$PLUGIN_DIR" ]; then',
      '    log "安装 WeChat 插件 @tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION:-latest}…"',
      '    mkdir -p "$PLUGIN_DIR"',
      '    npm install --prefix "$PLUGIN_DIR" "@tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION:-latest}" --save --no-fund --no-audit 2>&1 || log "WARNING: 微信插件安装失败，稍后可用 bind-wechat 重试"',
      '  fi',
      '  touch "$INIT_MARKER"',
      '  log "初始化完成"',
      'fi',
      '',
      'log "启动 OpenClaw Gateway…"',
      'exec node /app/openclaw.mjs gateway run',
      '',
    ].join('\n');
  }

  /** One-click install: env checks → docker compose up → guide WeChat QR bind. */
  private generateInstallScript(cw: CoWorker, platform: 'bash' | 'powershell'): string {
    if (platform === 'bash') {
      return [
        '#!/bin/bash',
        `# 一键安装并启动 CoWorker — ${cw.name}`,
        'set -e',
        'cd "$(dirname "$0")/.."',
        'echo "=== 安装并启动 CoWorker ==="',
        'command -v docker >/dev/null 2>&1 || { echo "❌ 未安装 Docker: https://docs.docker.com/get-docker/"; exit 1; }',
        'grep -q "JIANZHI_CW_TOKEN=.*[^<]" .env 2>/dev/null || { echo "❌ 请先在 .env 填写 JIANZHI_CW_TOKEN"; exit 1; }',
        'grep -Eq "OPENCLAW_WORKDIR=.+" .env 2>/dev/null || { echo "❌ 请先在 .env 填写 OPENCLAW_WORKDIR（本机业务文件目录）"; exit 1; }',
        'set -a; . ./.env; set +a',
        '# 从见智服务器下载"锁定版"OpenClaw 运行时（不从 GitHub/DockerHub，确保所有用户版本一致）',
        'if [ ! -f openclaw-runtime/openclaw.mjs ]; then',
        '  echo "→ 从见智下载 OpenClaw 运行时…"',
        '  curl -fL "${JIANZHI_MAIN_URL}/api/coworkers/openclaw/asset?token=${JIANZHI_CW_TOKEN}" -o openclaw-asset.tar.gz',
        '  rm -rf openclaw-runtime && mkdir -p openclaw-runtime',
        '  tar -xzf openclaw-asset.tar.gz -C openclaw-runtime',
        '  if [ ! -f openclaw-runtime/openclaw.mjs ]; then',
        '    sub=$(find openclaw-runtime -maxdepth 1 -mindepth 1 -type d | head -1)',
        '    [ -n "$sub" ] && mv "$sub"/* "$sub"/.[!.]* openclaw-runtime/ 2>/dev/null || true',
        '  fi',
        '  rm -f openclaw-asset.tar.gz',
        '  echo "  OpenClaw 运行时就绪"',
        'fi',
        'echo "启动容器…"',
        'docker compose up -d',
        'echo "等待就绪…"; sleep 5',
        'echo "→ 微信扫码绑定"',
        'bash scripts/bind-wechat.sh || true',
        'echo "✅ 完成。查看日志: docker compose logs -f"',
        '',
      ].join('\n');
    }
    return [
      `# 一键安装并启动 CoWorker — ${cw.name}`,
      '$ErrorActionPreference = "Stop"',
      'Set-Location "$PSScriptRoot\\.."',
      'if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Write-Host "❌ 未安装 Docker" -ForegroundColor Red; exit 1 }',
      '$envc = Get-Content ".env" -ErrorAction SilentlyContinue',
      'if (-not ($envc -match "JIANZHI_CW_TOKEN=.+[^<]")) { Write-Host "❌ 请先在 .env 填写 JIANZHI_CW_TOKEN" -ForegroundColor Red; exit 1 }',
      'if (-not ($envc -match "OPENCLAW_WORKDIR=.+")) { Write-Host "❌ 请先在 .env 填写 OPENCLAW_WORKDIR（本机业务文件目录）" -ForegroundColor Red; exit 1 }',
      '$vars=@{}; foreach ($l in $envc) { if ($l -match "^\\s*([^#=]+)=(.*)$") { $vars[$matches[1].Trim()]=$matches[2].Trim() } }',
      '# 从见智服务器下载"锁定版"OpenClaw 运行时（版本一致）',
      'if (-not (Test-Path "openclaw-runtime/openclaw.mjs")) {',
      '  Write-Host "→ 从见智下载 OpenClaw 运行时…"',
      '  Invoke-WebRequest -Uri "$($vars[\'JIANZHI_MAIN_URL\'])/api/coworkers/openclaw/asset?token=$($vars[\'JIANZHI_CW_TOKEN\'])" -OutFile "openclaw-asset.tar.gz"',
      '  if (Test-Path "openclaw-runtime") { Remove-Item -Recurse -Force "openclaw-runtime" }',
      '  New-Item -ItemType Directory -Force -Path "openclaw-runtime" | Out-Null',
      '  tar -xzf openclaw-asset.tar.gz -C openclaw-runtime',
      '  if (-not (Test-Path "openclaw-runtime/openclaw.mjs")) {',
      '    $sub = Get-ChildItem "openclaw-runtime" -Directory | Select-Object -First 1',
      '    if ($sub) { Get-ChildItem $sub.FullName -Force | Move-Item -Destination "openclaw-runtime" -Force }',
      '  }',
      '  Remove-Item -Force "openclaw-asset.tar.gz"',
      '  Write-Host "  OpenClaw 运行时就绪"',
      '}',
      'docker compose up -d',
      'Start-Sleep -Seconds 5',
      'Write-Host "→ 微信扫码绑定"',
      '& "$PSScriptRoot\\bind-wechat.ps1"',
      'Write-Host "✅ 完成。日志: docker compose logs -f" -ForegroundColor Green',
      '',
    ].join('\n');
  }

  /**
   * Native (non-Docker) install + run: Node runtime, no container.
   * Downloads the pinned asset from 见智, injects config (workspace = user's host dir),
   * installs WeChat + jianzhi-bridge into the state dir, starts the Gateway, guides QR bind.
   */
  private generateNativeInstallScript(cw: CoWorker, platform: 'bash' | 'powershell'): string {
    // node -e that injects token + sets workspace to the host OPENCLAW_WORKDIR. Single-quoted so
    // ${...} stays literal; process.env supplies real values at runtime.
    const inject =
      'const fs=require("fs");let s=fs.readFileSync("config/openclaw.json","utf8");' +
      's=s.split("${JIANZHI_CW_TOKEN}").join(process.env.JIANZHI_CW_TOKEN||"");' +
      's=s.split("${JIANZHI_MAIN_URL}").join(process.env.JIANZHI_MAIN_URL||"");' +
      'const c=JSON.parse(s);c.agents=c.agents||{};c.agents.defaults=c.agents.defaults||{};' +
      'c.agents.defaults.workspace=process.env.OPENCLAW_WORKDIR;' +
      'fs.writeFileSync(process.argv[1],JSON.stringify(c,null,2));';

    if (platform === 'bash') {
      return [
        '#!/bin/bash',
        `# 原生（非 Docker）安装并运行 CoWorker — ${cw.name}`,
        'set -e',
        'cd "$(dirname "$0")/.."',
        'echo "=== 原生安装 CoWorker（Node，无需 Docker）==="',
        'command -v node >/dev/null 2>&1 || { echo "❌ 未安装 Node.js 22+：https://nodejs.org/"; exit 1; }',
        'NODE_MAJOR=$(node -p "process.versions.node.split(\'.\')[0]")',
        '[ "$NODE_MAJOR" -ge 22 ] || { echo "❌ 需要 Node.js 22+（当前 $NODE_MAJOR）"; exit 1; }',
        'grep -q "JIANZHI_CW_TOKEN=.*[^<]" .env 2>/dev/null || { echo "❌ 请先在 .env 填写 JIANZHI_CW_TOKEN"; exit 1; }',
        'grep -Eq "OPENCLAW_WORKDIR=.+" .env 2>/dev/null || { echo "❌ 请先在 .env 填写 OPENCLAW_WORKDIR（本机业务文件目录）"; exit 1; }',
        'set -a; . ./.env; set +a',
        'export JIANZHI_MAIN_URL JIANZHI_CW_TOKEN JIANZHI_COWORKER_ID OPENCLAW_WORKDIR',
        'STATE_DIR="${OPENCLAW_STATE_DIR:-$HOME/.openclaw}"',
        'mkdir -p "$STATE_DIR/extensions"',
        '# 1. 从见智下载锁定版 OpenClaw 运行时',
        'if [ ! -f openclaw-runtime/openclaw.mjs ]; then',
        '  echo "→ 从见智下载 OpenClaw 运行时…"',
        '  curl -fL "${JIANZHI_MAIN_URL}/api/coworkers/openclaw/asset?token=${JIANZHI_CW_TOKEN}" -o openclaw-asset.tar.gz',
        '  rm -rf openclaw-runtime && mkdir -p openclaw-runtime',
        '  tar -xzf openclaw-asset.tar.gz -C openclaw-runtime',
        '  if [ ! -f openclaw-runtime/openclaw.mjs ]; then',
        '    sub=$(find openclaw-runtime -maxdepth 1 -mindepth 1 -type d | head -1)',
        '    [ -n "$sub" ] && mv "$sub"/* "$sub"/.[!.]* openclaw-runtime/ 2>/dev/null || true',
        '  fi',
        '  rm -f openclaw-asset.tar.gz',
        'fi',
        '# 2. 写入配置（注入 token；workspace=宿主目录）',
        `node -e '${inject}' "$STATE_DIR/openclaw.json"`,
        '# 2b. 人格 SOUL.md → workspace 根目录（仅当不存在时写入，与 OpenClaw 语义一致）',
        'if [ -f config/SOUL.md ] && [ ! -f "$OPENCLAW_WORKDIR/SOUL.md" ]; then',
        '  mkdir -p "$OPENCLAW_WORKDIR" && cp config/SOUL.md "$OPENCLAW_WORKDIR/SOUL.md" && echo "  人格 SOUL.md 已写入 $OPENCLAW_WORKDIR"',
        'fi',
        '# 3. 安装微信插件',
        'if [ ! -d "$STATE_DIR/extensions/openclaw-weixin" ]; then',
        '  echo "→ 安装微信插件…"',
        '  mkdir -p "$STATE_DIR/extensions/openclaw-weixin"',
        '  npm install --prefix "$STATE_DIR/extensions/openclaw-weixin" "@tencent-weixin/openclaw-weixin@${WECHAT_PLUGIN_VERSION:-latest}" --no-fund --no-audit || echo "WARNING: 微信插件安装失败，稍后可重试"',
        'fi',
        '# 4. 注入见智桥插件',
        'rm -rf "$STATE_DIR/extensions/jianzhi-bridge"',
        'cp -r extensions/jianzhi-bridge "$STATE_DIR/extensions/jianzhi-bridge"',
        '# 5. 启动 Gateway（后台）+ 微信扫码',
        'echo "→ 启动 OpenClaw Gateway…"',
        'node openclaw-runtime/openclaw.mjs gateway run &',
        'GW=$!',
        'sleep 5',
        'echo "→ 微信扫码绑定（手机微信扫描终端二维码）"',
        'node openclaw-runtime/openclaw.mjs channels login --channel openclaw-weixin || echo "登录未完成，稍后可重试同一命令"',
        'echo "✅ Gateway 运行中 (pid $GW)。停止：kill $GW"',
        'wait $GW',
        '',
      ].join('\n');
    }

    return [
      `# 原生（非 Docker）安装并运行 CoWorker — ${cw.name}`,
      '$ErrorActionPreference = "Stop"',
      'Set-Location "$PSScriptRoot\\.."',
      'if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Write-Host "❌ 未安装 Node.js 22+：https://nodejs.org/" -ForegroundColor Red; exit 1 }',
      '$nodeMajor = [int](node -p "process.versions.node.split(\'.\')[0]")',
      'if ($nodeMajor -lt 22) { Write-Host "❌ 需要 Node.js 22+（当前 $nodeMajor）" -ForegroundColor Red; exit 1 }',
      '$envc = Get-Content ".env" -ErrorAction SilentlyContinue',
      'if (-not ($envc -match "JIANZHI_CW_TOKEN=.+[^<]")) { Write-Host "❌ 请先在 .env 填写 JIANZHI_CW_TOKEN" -ForegroundColor Red; exit 1 }',
      'if (-not ($envc -match "OPENCLAW_WORKDIR=.+")) { Write-Host "❌ 请先在 .env 填写 OPENCLAW_WORKDIR" -ForegroundColor Red; exit 1 }',
      '$vars=@{}; foreach ($l in $envc) { if ($l -match "^\\s*([^#=]+)=(.*)$") { $vars[$matches[1].Trim()]=$matches[2].Trim() } }',
      'foreach ($k in $vars.Keys) { [Environment]::SetEnvironmentVariable($k, $vars[$k]) }',
      '$stateDir = if ($env:OPENCLAW_STATE_DIR) { $env:OPENCLAW_STATE_DIR } else { Join-Path $HOME ".openclaw" }',
      'New-Item -ItemType Directory -Force -Path (Join-Path $stateDir "extensions") | Out-Null',
      'if (-not (Test-Path "openclaw-runtime/openclaw.mjs")) {',
      '  Write-Host "→ 从见智下载 OpenClaw 运行时…"',
      '  Invoke-WebRequest -Uri "$($vars[\'JIANZHI_MAIN_URL\'])/api/coworkers/openclaw/asset?token=$($vars[\'JIANZHI_CW_TOKEN\'])" -OutFile "openclaw-asset.tar.gz"',
      '  if (Test-Path "openclaw-runtime") { Remove-Item -Recurse -Force "openclaw-runtime" }',
      '  New-Item -ItemType Directory -Force -Path "openclaw-runtime" | Out-Null',
      '  tar -xzf openclaw-asset.tar.gz -C openclaw-runtime',
      '  if (-not (Test-Path "openclaw-runtime/openclaw.mjs")) { $sub = Get-ChildItem "openclaw-runtime" -Directory | Select-Object -First 1; if ($sub) { Get-ChildItem $sub.FullName -Force | Move-Item -Destination "openclaw-runtime" -Force } }',
      '  Remove-Item -Force "openclaw-asset.tar.gz"',
      '}',
      `node -e '${inject}' (Join-Path $stateDir "openclaw.json")`,
      '$workDir = $vars[\'OPENCLAW_WORKDIR\']',
      'if ((Test-Path "config/SOUL.md") -and -not (Test-Path (Join-Path $workDir "SOUL.md"))) {',
      '  New-Item -ItemType Directory -Force -Path $workDir | Out-Null',
      '  Copy-Item "config/SOUL.md" (Join-Path $workDir "SOUL.md")',
      '  Write-Host "  人格 SOUL.md 已写入 $workDir"',
      '}',
      '$wx = Join-Path $stateDir "extensions/openclaw-weixin"',
      'if (-not (Test-Path $wx)) { Write-Host "→ 安装微信插件…"; New-Item -ItemType Directory -Force -Path $wx | Out-Null; npm install --prefix $wx "@tencent-weixin/openclaw-weixin@latest" --no-fund --no-audit }',
      '$jb = Join-Path $stateDir "extensions/jianzhi-bridge"; if (Test-Path $jb) { Remove-Item -Recurse -Force $jb }; Copy-Item -Recurse "extensions/jianzhi-bridge" $jb',
      'Write-Host "→ 启动 OpenClaw Gateway…"',
      '$gw = Start-Process node -ArgumentList "openclaw-runtime/openclaw.mjs","gateway","run" -PassThru',
      'Start-Sleep -Seconds 5',
      'Write-Host "→ 微信扫码绑定（手机微信扫描终端二维码）"',
      'node openclaw-runtime/openclaw.mjs channels login --channel openclaw-weixin',
      'Write-Host "✅ Gateway 运行中 (pid $($gw.Id))。停止：Stop-Process -Id $($gw.Id)" -ForegroundColor Green',
      '',
    ].join('\n');
  }

  /** WeChat QR bind helper: runs `channels login` inside the container (QR to terminal). */
  private generateBindWechatScript(platform: 'bash' | 'powershell'): string {
    if (platform === 'bash') {
      return [
        '#!/bin/bash',
        'cd "$(dirname "$0")/.."',
        'echo "=== 微信扫码绑定（请用手机微信扫描终端二维码）==="',
        'docker compose exec openclaw node /app/openclaw.mjs channels login --channel openclaw-weixin',
        '',
      ].join('\n');
    }
    return [
      '$ErrorActionPreference = "Stop"',
      'Set-Location "$PSScriptRoot\\.."',
      'Write-Host "=== 微信扫码绑定（请用手机微信扫描终端二维码）==="',
      'docker compose exec openclaw node /app/openclaw.mjs channels login --channel openclaw-weixin',
      '',
    ].join('\n');
  }

  /**
   * Find a skill file by name in the workspace.
   */
  private findSkillFile(skillName: string): string | null {
    const workRoot = this.workspace.getRoot();
    const candidates = [
      path.join(workRoot, 'config', 'skills', skillName, 'SKILL.md'),
      path.join(workRoot, 'config', 'skills', `${skillName}.md`),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) return c;
    }
    return null;
  }

  /** Locate the bundled jianzhi-bridge plugin dir (prefers the one with a built plugin.js). */
  private getBridgeDir(): string | null {
    const candidates = [
      process.env.JIANZHI_BRIDGE_DIR || '',
      path.join(this.getOpenClawRoot(), 'extensions', 'jianzhi-bridge'),
      // Shipped with the main OTA artifact (dist/assets/jianzhi-bridge) — present in customer containers.
      path.resolve(__dirname, '..', '..', 'assets', 'jianzhi-bridge'),
      path.resolve(__dirname, '..', '..', '..', '..', 'openclaw', 'extensions', 'jianzhi-bridge'),
    ].filter(Boolean);
    return (
      candidates.find(c => fs.existsSync(path.join(c, 'plugin.js'))) ||
      candidates.find(c => fs.existsSync(path.join(c, 'openclaw.plugin.json'))) ||
      null
    );
  }

  private getOpenClawRoot(): string {
    // OpenClaw source = mounted volume managed by CoWorkerOpenClawService (workspace/.openclaw).
    // The bundled repo path is kept as a dev fallback when the mounted source isn't installed yet.
    const mounted = path.join(this.workspace.getRoot(), '.openclaw');
    if (fs.existsSync(mounted)) return mounted;
    return path.resolve(__dirname, '..', '..', '..', 'openclaw');
  }
}
