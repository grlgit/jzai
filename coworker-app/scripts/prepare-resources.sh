#!/bin/bash
#
# Windows 客户端资源准备脚本
# 在构建前执行，准备必要的扩展和插件
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_ROOT="$(cd "$PROJECT_ROOT/../openclaw" && pwd)"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== Windows 客户端资源准备 ===${NC}"
echo ""

# 检查 OPENCLAW_ROOT 是否存在
if [ ! -d "$OPENCLAW_ROOT" ]; then
    echo -e "${RED}错误: OpenClaw 源目录不存在: $OPENCLAW_ROOT${NC}"
    echo "请确保 openclaw 子模块已初始化: git submodule update --init --recursive"
    exit 1
fi

# ===== 1. 创建目录结构 =====
echo "1. 创建目录结构..."
RESOURCES_DIR="$PROJECT_ROOT/resources"
EXTENSIONS_DIR="$RESOURCES_DIR/extensions"
OPENCLAW_TARGET_DIR="$RESOURCES_DIR/openclaw"

mkdir -p "$EXTENSIONS_DIR"
mkdir -p "$OPENCLAW_TARGET_DIR"
echo -e "${GREEN}目录创建完成${NC}"
echo ""

# ===== 2. 校验 jianzhi-bridge 扩展 =====
# 插件源码常驻本仓库 resources/extensions/jianzhi-bridge（plugin.js 已提交），
# 不从 ../openclaw 复制——openclaw 目录仅用于分析运行机制，不参与客户端打包。
# 修改 plugin.ts 后需手动执行该目录下的 build.mjs 重新生成 plugin.js。
echo "2. 校验 jianzhi-bridge 扩展..."
JIANZHI_BRIDGE_TARGET="$EXTENSIONS_DIR/jianzhi-bridge"

if [ ! -f "$JIANZHI_BRIDGE_TARGET/plugin.js" ]; then
    echo -e "${RED}错误: jianzhi-bridge 打包产物缺失: $JIANZHI_BRIDGE_TARGET/plugin.js${NC}"
    echo "请在该目录执行: node build.mjs"
    exit 1
fi

# 插件只从 resources/extensions 分发（客户端首启复制到 ~/.openclaw/extensions）。
# resources/openclaw/extensions 是历史遗留位置，同时存在会让 OpenClaw 从自身运行时目录
# 与 ~/.openclaw 各发现一次插件，导致重复注册。
rm -rf "$OPENCLAW_TARGET_DIR/extensions"

echo -e "${GREEN}jianzhi-bridge 就绪${NC}"
echo ""

# ===== 3. 预安装微信插件（默认开启）=====
# 便携版客户端从 Temp 运行,运行时 npx/npm 会因 spawnSync cmd.exe EACCES 失败,
# 故默认随包预装 openclaw-weixin,客户端首启直接从打包资源复制,无需联网/权限。
INSTALL_WECHAT=${INSTALL_WECHAT:-true}

if [ "$INSTALL_WECHAT" = true ]; then
    echo "3. 预安装微信插件..."
    WEIXIN_TARGET="$EXTENSIONS_DIR/openclaw-weixin"

    # 清理旧文件
    rm -rf "$WEIXIN_TARGET"
    mkdir -p "$WEIXIN_TARGET"

    # 安装微信插件
    if npm install --prefix "$WEIXIN_TARGET" "@tencent-weixin/openclaw-weixin@latest" --no-fund --no-audit; then
        echo -e "${GREEN}微信插件安装完成${NC}"
    else
        echo -e "${YELLOW}警告: 微信插件安装失败（将在首次启动时重试）${NC}"
    fi
    echo ""
else
    echo "3. 跳过微信插件预安装（客户端首启将回退运行时安装，便携版可能 EACCES）"
    echo ""
fi

# ===== 4. 复制 OpenClaw 运行时 =====
echo "4. 复制 OpenClaw 运行时..."

if [ -n "$OPENCLAW_ROOT" ] && [ -f "$OPENCLAW_ROOT/openclaw.mjs" ]; then
    echo "找到 OpenClaw 源码: $OPENCLAW_ROOT"

    # 复制 OpenClaw 运行时到 resources/openclaw/
    # 应用期望路径: resources/openclaw/openclaw.mjs
    OPENCLAW_MJS_SOURCE="$OPENCLAW_ROOT/openclaw.mjs"
    OPENCLAW_MJS_TARGET="$OPENCLAW_TARGET_DIR/openclaw.mjs"

    # 检查是否需要复制
    NEED_COPY=true
    if [ -f "$OPENCLAW_MJS_TARGET" ]; then
        SOURCE_HASH=$(sha256sum "$OPENCLAW_MJS_SOURCE" 2>/dev/null | awk '{print $1}')
        TARGET_HASH=$(sha256sum "$OPENCLAW_MJS_TARGET" 2>/dev/null | awk '{print $1}')
        if [ "$SOURCE_HASH" = "$TARGET_HASH" ]; then
            NEED_COPY=false
        fi
    fi

    if [ "$NEED_COPY" = true ]; then
        echo "复制 OpenClaw 运行时..."
        cp -f "$OPENCLAW_MJS_SOURCE" "$OPENCLAW_MJS_TARGET"
        echo -e "${GREEN}OpenClaw 运行时已复制${NC}"
    else
        echo -e "${GREEN}OpenClaw 运行时已是最新${NC}"
    fi

    # 也复制 package.json（如果存在）
    if [ -f "$OPENCLAW_ROOT/package.json" ]; then
        cp -f "$OPENCLAW_ROOT/package.json" "$OPENCLAW_TARGET_DIR/package.json"
    fi

    # CRITICAL: 复制 dist/ 目录 - OpenClaw 需要 dist/entry.mjs
    OPENCLAW_DIST_SOURCE="$OPENCLAW_ROOT/dist"
    OPENCLAW_DIST_TARGET="$OPENCLAW_TARGET_DIR/dist"
    if [ -d "$OPENCLAW_DIST_SOURCE" ]; then
        echo "复制 OpenClaw dist/ 目录（运行时必需）..."
        # 清理旧的 dist 目录
        rm -rf "$OPENCLAW_DIST_TARGET"
        # 复制整个 dist 目录
        cp -R "$OPENCLAW_DIST_SOURCE" "$OPENCLAW_DIST_TARGET"
        echo -e "${GREEN}OpenClaw dist/ 目录已复制${NC}"
    else
        echo -e "${YELLOW}警告: OpenClaw dist/ 目录不存在: $OPENCLAW_DIST_SOURCE${NC}"
        echo -e "${YELLOW}OpenClaw 可能无法正常运行（缺少 dist/entry.mjs）${NC}"
    fi
else
    echo -e "${YELLOW}警告: OpenClaw 源码未找到${NC}"
    echo "OpenClaw 运行时将不会包含在构建中"
fi
echo ""

# ===== Node 运行时（可选）=====
# main.js 优先使用 resources/runtime/win-x64/node.exe，缺失时回退系统 PATH 的 node
RUNTIME_TARGET_DIR="$RESOURCES_DIR/runtime/win-x64"
mkdir -p "$RUNTIME_TARGET_DIR"
if [ -n "$NODE_RUNTIME_DIR" ] && [ -f "$NODE_RUNTIME_DIR/node.exe" ]; then
    echo "复制内置 Node 运行时..."
    cp -f "$NODE_RUNTIME_DIR/node.exe" "$RUNTIME_TARGET_DIR/node.exe"
    echo -e "${GREEN}内置 Node 运行时已复制${NC}"
else
    echo -e "${YELLOW}警告: 未提供内置 Node 运行时（设置 NODE_RUNTIME_DIR 指向含 node.exe 的目录）${NC}"
    echo -e "${YELLOW}客户机需自行安装 Node.js，否则 Gateway 会报 RUNTIME_MISSING${NC}"
fi
echo ""

# ===== 完成 =====
echo -e "${GREEN}=== 资源准备完成 ===${NC}"
echo ""

echo "资源目录结构:"
tree -L 2 "$RESOURCES_DIR" 2>/dev/null || find "$RESOURCES_DIR" -type d -maxdepth 2 | sort
echo ""

echo "下一步:"
echo "  npm run build:win    # 构建 Windows 安装器"
echo "  ./build.sh           # 或使用完整构建脚本"
