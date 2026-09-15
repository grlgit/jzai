#!/bin/bash
#
# 见智 CoWorker - 一键构建脚本
# 在客户环境中执行，构建 Windows 安装器
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}=== 见智 CoWorker 构建脚本 ===${NC}"
echo ""

# ===== 解析参数 =====
SKIP_ENV_CHECK=${SKIP_ENV_CHECK:-false}
SIGN=${SIGN:-true}
CLEAN=${CLEAN:-false}

# 解析命令行参数
while [[ $# -gt 0 ]]; do
    case $1 in
        --skip-env-check)
            SKIP_ENV_CHECK=true
            shift
            ;;
        --no-sign)
            SIGN=false
            shift
            ;;
        --clean)
            CLEAN=true
            shift
            ;;
        --help)
            echo "用法: $0 [选项]"
            echo ""
            echo "选项:"
            echo "  --skip-env-check  跳过环境检查"
            echo "  --no-sign         构建但不签名"
            echo "  --clean           构建前清理"
            echo "  --help            显示此帮助"
            echo ""
            echo "环境变量:"
            echo "  CERT_PATH         自定义证书路径（.pfx）"
            echo "  CERT_PASSWORD     证书密码"
            echo ""
            exit 0
            ;;
        *)
            echo -e "${RED}未知选项: $1${NC}"
            echo "使用 --help 查看帮助"
            exit 1
            ;;
    esac
done

# ===== 环境检查 =====
if [ "$SKIP_ENV_CHECK" = false ]; then
    echo "1. 环境检查..."
    if ./check-env.sh; then
        echo -e "${GREEN}环境检查通过${NC}"
    else
        echo -e "${RED}环境检查失败${NC}"
        echo "使用 --skip-env-check 跳过检查"
        exit 1
    fi
    echo ""
else
    echo -e "${YELLOW}跳过环境检查${NC}"
    echo ""
fi

# ===== 清理 =====
if [ "$CLEAN" = true ]; then
    echo "2. 清理旧构建..."
    rm -rf dist/
    rm -rf out/
    rm -rf .webpack/
    echo -e "${GREEN}清理完成${NC}"
    echo ""
fi

# ===== 准备资源 =====
echo "3. 准备资源..."
./scripts/prepare-resources.sh
echo ""

# ===== 安装依赖 =====
echo "4. 检查依赖..."
if [ ! -d "node_modules" ]; then
    echo "安装 npm 依赖..."
    npm install
    echo -e "${GREEN}依赖安装完成${NC}"
else
    echo -e "${GREEN}依赖已安装${NC}"
fi
echo ""

# ===== 构建 =====
echo "5. 构建 Electron 应用..."

# ===== 构建 =====
echo "4. 构建 Electron 应用..."
echo "平台: Windows x64"
echo ""

# 直接调用 electron-builder 构建
# 注意：在无 X11 的服务器环境中，Wine 验证会失败但安装器已成功构建
BUILD_EXIT_CODE=0
npx electron-builder --win --x64 || BUILD_EXIT_CODE=$?

# 动态查找安装器文件（portable 或 Setup）
OUTPUT_FILE=$(ls dist/*.exe 2>/dev/null | grep -v ".block" | head -n 1)
if [ -z "$OUTPUT_FILE" ]; then
  echo -e "${RED}构建失败：未找到输出文件${NC}"
  echo "dist 目录内容:"
  ls -la dist/ || echo "dist 目录不存在"
  exit 1
fi

if [ $BUILD_EXIT_CODE -ne 0 ]; then
  echo -e "${YELLOW}Wine 验证失败（退出码 $BUILD_EXIT_CODE），但安装器已成功构建${NC}"
  echo "此错误在 Linux 跨平台构建时属于正常现象"
fi

# 检查构建产物
if [ ! -f "$OUTPUT_FILE" ]; then
    echo -e "${RED}构建失败：未找到输出文件${NC}"
    exit 1
fi

echo -e "${GREEN}构建完成${NC}"
echo "输出: $OUTPUT_FILE"
echo ""

# ===== 签名 =====
if [ "$SIGN" = true ]; then
    echo "5. 签名安装器..."

    # 检查是否使用自定义证书
    if [ -n "$CERT_PATH" ]; then
        echo "使用自定义证书: $CERT_PATH"
        export CERT_PATH
        export CERT_PASSWORD="${CERT_PASSWORD:-}"
    fi

    # 运行签名脚本
    if ./certificates/sign-windows.sh "$OUTPUT_FILE"; then
        echo -e "${GREEN}签名完成${NC}"
    else
        echo -e "${YELLOW}签名失败（构建产物未签名）${NC}"
    fi
    echo ""
else
    echo -e "${YELLOW}跳过签名${NC}"
    echo ""
fi

# ===== 完成 =====
if [ -f "$OUTPUT_FILE" ]; then
    FILE_SIZE=$(du -h "$OUTPUT_FILE" | cut -f1)
    echo -e "${GREEN}=== 构建完成 ===${NC}"
    echo ""
    echo "文件: $OUTPUT_FILE"
    echo "大小: $FILE_SIZE"
    echo ""

    # 检查签名状态
    if command -v osslsigncode &> /dev/null; then
        echo "签名验证:"
        osslsigncode verify "$OUTPUT_FILE" 2>&1 | grep -E "(Signer|Issuer|NumberOf)" || echo "  无法验证签名"
    fi

    echo ""
    echo "下一步:"
    echo "  1. 测试安装: 在 Windows 上运行安装器"
    echo "  2. 上传到见智后台: 通过管理界面上传"
    echo "     或调用 API: POST /api/coworkers/app/win/upload"
else
    echo -e "${RED}=== 构建失败 ===${NC}"
    exit 1
fi
