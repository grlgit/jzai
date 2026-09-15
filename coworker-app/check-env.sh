#!/bin/bash
#
# 见智 CoWorker - 环境检查脚本
# 在构建前检查环境是否满足要求
#
# 注意: 不使用 set -e，因为输出被 Node.js 捕获时可能导致意外退出
# 我们会在关键步骤后手动检查退出状态

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR" || exit 1

echo "=== 见智 CoWorker 构建环境检查 ==="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

CHECKS_PASSED=0
CHECKS_FAILED=0

check_pass() {
    echo -e "${GREEN}✓${NC} $1"
    ((CHECKS_PASSED++))
}

check_fail() {
    echo -e "${RED}✗${NC} $1"
    ((CHECKS_FAILED++))
}

check_warn() {
    echo -e "${YELLOW}⚠${NC} $1"
}

# ===== 检查 Node.js =====
echo "1. 检查 Node.js..."
if command -v node &> /dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//')
    MAJOR=$(echo $NODE_VERSION | cut -d. -f1)
    if [ "$MAJOR" -ge 18 ]; then
        check_pass "Node.js $NODE_VERSION (>=18)"
    else
        check_fail "Node.js 版本过低: $NODE_VERSION (需要 >=18)"
    fi
else
    check_fail "未找到 Node.js，请先安装 Node.js 18+"
fi

# ===== 检查 npm =====
echo ""
echo "2. 检查 npm..."
if command -v npm &> /dev/null; then
    NPM_VERSION=$(npm -v)
    check_pass "npm $NPM_VERSION"
else
    check_fail "未找到 npm"
fi

# ===== 检查平台 =====
echo ""
echo "3. 检查平台..."
OS_TYPE=$(uname -s)
ARCH_TYPE=$(uname -m)

case "$OS_TYPE" in
    Linux*)
        PLATFORM="linux"
        check_pass "Linux 平台 ($ARCH_TYPE)"
        ;;
    Darwin*)
        PLATFORM="darwin"
        check_pass "macOS 平台 ($ARCH_TYPE)"
        ;;
    MINGW*|MSYS*|CYGWIN*)
        PLATFORM="windows"
        check_pass "Windows 平台 ($ARCH_TYPE)"
        ;;
    *)
        check_fail "未知平台: $OS_TYPE"
        ;;
esac

# ===== 检查 wine (Linux 上构建 Windows 需要) =====
echo ""
echo "4. 检查构建依赖..."
if [ "$PLATFORM" = "linux" ]; then
    if command -v wine &> /dev/null; then
        check_pass "wine 已安装（Linux 上构建 Windows 安装器需要）"
    else
        echo "→ wine 未安装，正在尝试自动安装..."
        if [ -f /etc/debian_version ]; then
            if sudo apt-get update && sudo apt-get install -y wine64; then
                check_pass "wine 已自动安装"
            else
                check_fail "wine 自动安装失败，请手动安装: sudo apt-get install wine64"
            fi
        else
            check_fail "未安装 wine，请手动安装（Linux 上构建 Windows 安装器需要）"
        fi
    fi
elif [ "$PLATFORM" = "darwin" ]; then
    check_warn "macOS 上构建 Windows 安装器需要特殊配置"
    echo "    建议在 Linux 或 Windows 环境中构建 Windows 安装器"
fi

# ===== 检查签名工具 =====
echo ""
echo "5. 检查签名工具..."
if [ "$PLATFORM" = "linux" ]; then
    if command -v osslsigncode &> /dev/null; then
        check_pass "osslsigncode 已安装"
    else
        echo "→ osslsigncode 未安装，正在尝试自动安装..."
        if [ -f /etc/debian_version ]; then
            if sudo apt-get update && sudo apt-get install -y osslsigncode; then
                check_pass "osslsigncode 已自动安装"
            else
                check_fail "osslsigncode 自动安装失败，请手动安装: sudo apt-get install osslsigncode"
            fi
        else
            check_fail "未安装 osslsigncode（签名需要），请手动安装"
        fi
    fi
elif [ "$PLATFORM" = "windows" ]; then
    if command -v signtool &> /dev/null; then
        check_pass "signtool 已安装"
    else
        check_warn "未找到 signtool（Windows SDK 签名工具）"
    fi
fi

# ===== 检查证书文件 =====
echo ""
echo "6. 检查证书文件..."
CERT_CRT="$SCRIPT_DIR/certificates/jzai-code-signing.crt"
CERT_KEY="$SCRIPT_DIR/certificates/jzai-code-signing.key"
CERT_PFX="$SCRIPT_DIR/certificates/jzai-code-signing.pfx"

if [ -f "$CERT_PFX" ]; then
    check_pass "找到证书文件: jzai-code-signing.pfx"
elif [ -f "$CERT_CRT" ] && [ -f "$CERT_KEY" ]; then
    check_pass "找到证书文件: jzai-code-signing.crt + .key"
else
    check_warn "未找到证书文件，需要先生成"
    echo "    运行: npm run generate-cert"
fi

# ===== 检查依赖是否已安装 =====
echo ""
echo "7. 检查项目依赖..."
if [ -d "node_modules" ]; then
    DEPS_COUNT=$(find node_modules -maxdepth 1 -type d | wc -l)
    check_pass "依赖已安装 ($DEPS_COUNT 个包)"
else
    check_warn "未安装依赖，需要先运行 npm install"
fi

# ===== 检查必要资源 =====
echo ""
echo "8. 检查必要资源..."
RESOURCES_OK=true

if [ ! -f "assets/icon.ico" ]; then
    check_warn "缺少图标: assets/icon.ico"
    RESOURCES_OK=false
fi

if [ ! -f "assets/installer-icon.ico" ]; then
    check_warn "缺少安装器图标: assets/installer-icon.ico"
    RESOURCES_OK=false
fi

if [ "$RESOURCES_OK" = true ]; then
    check_pass "图标资源完整"
fi

# ===== 检查 OpenClaw 运行时 =====
echo ""
echo "9. 检查 OpenClaw 运行时..."
RUNTIME_DIR="$SCRIPT_DIR/resources/runtime/win-x64"
if [ -d "$RUNTIME_DIR" ] && [ -f "$RUNTIME_DIR/node.exe" ]; then
    check_pass "OpenClaw 运行时存在"
else
    check_warn "未找到 OpenClaw 运行时，构建的应用将需要运行时下载"
    echo "    运行时可从见智后端下载，不影响构建"
fi

# ===== 总结 =====
echo ""
echo "=== 检查结果 ==="
echo -e "${GREEN}通过:${NC} $CHECKS_PASSED"
echo -e "${RED}失败:${NC} $CHECKS_FAILED"

if [ $CHECKS_FAILED -eq 0 ]; then
    echo ""
    echo -e "${GREEN}环境检查通过，可以开始构建${NC}"
    exit 0
else
    echo ""
    echo -e "${RED}环境检查失败，请解决上述问题后重试${NC}"
    exit 1
fi
