#!/bin/bash
#
# 上传 Windows 安装器到官网
#
# 用法: bash scripts/upload-to-website.sh [version] [exe-path]
#   version  - 版本号（如 1.0.0），留空则从 package.json 读取
#   exe-path - 安装器路径，留空则使用 dist/见智CoWorker-Setup-x64.exe
#
# 环境变量:
#   WEBSITE_URL    - 官网地址（默认 http://43.133.38.52）
#   ADMIN_SECRET   - 管理密钥（默认 0WH6ZBDaVQQq2026）
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 参数解析
VERSION="${1:-}"
EXE_PATH="${2:-$APP_DIR/dist/见智CoWorker-Setup-x64.exe"
WEBSITE_URL="${WEBSITE_URL:-http://43.133.38.52}"
ADMIN_SECRET="${ADMIN_SECRET:-0WH6ZBDaVQQq2026}"

# 如果没有提供版本号，从 package.json 读取
if [ -z "$VERSION" ]; then
    VERSION=$(node -e "console.log(require('$APP_DIR/package.json').version)")
fi

echo -e "${GREEN}=== 上传 Windows 安装器到官网 ===${NC}"
echo ""
echo "官网: $WEBSITE_URL"
echo "版本: $VERSION"
echo "文件: $EXE_PATH"
echo ""

# 检查文件是否存在
if [ ! -f "$EXE_PATH" ]; then
    echo -e "${RED}错误: 文件不存在: $EXE_PATH${NC}"
    exit 1
fi

# 检查文件大小
FILE_SIZE=$(stat -f%z "$EXE_PATH" 2>/dev/null || stat -c%s "$EXE_PATH" 2>/dev/null)
FILE_SIZE_MB=$((FILE_SIZE / 1024 / 1024))
echo "文件大小: ${FILE_SIZE_MB} MB"
echo ""

# 确认
read -p "确认上传? (y/N) " -n 1 -r
echo ""
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "已取消"
    exit 0
fi

# 上传
echo -e "${YELLOW}上传中...${NC}"

RESPONSE=$(curl -s -w "\n%{http_code}" -X POST "$WEBSITE_URL/api/v1/admin/coworker-app" \
    -H "X-Admin-Key: $ADMIN_SECRET" \
    -F "file=@$EXE_PATH" \
    -F "version=$VERSION")

HTTP_CODE=$(echo "$RESPONSE" | tail -n1)
BODY=$(echo "$RESPONSE" | head -n-1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
    echo -e "${GREEN}上传成功！${NC}"
    echo ""
    echo "$BODY" | python3 -m json.tool 2>/dev/null || echo "$BODY"
    echo ""
    echo "下载链接:"
    echo "  $WEBSITE_URL/api/v1/coworker-app/$VERSION/download"
    echo "  $WEBSITE_URL/api/v1/coworker-app (latest)"
else
    echo -e "${RED}上传失败 (HTTP $HTTP_CODE)${NC}"
    echo "$BODY"
    exit 1
fi
