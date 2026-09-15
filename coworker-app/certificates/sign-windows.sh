#!/bin/bash
#
# 使用自签名证书签名 Windows 安装器
# 在 Linux 上使用 osslsigncode 进行签名
#

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
# 支持通过环境变量 CERT_DIR 指定证书目录（用于后端构建服务）
CERT_DIR="${CERT_DIR:-$SCRIPT_DIR}"
CERT_CRT="$CERT_DIR/jzai-code-signing.crt"
CERT_KEY="$CERT_DIR/jzai-code-signing.key"
CERT_PFX="$CERT_DIR/jzai-code-signing.pfx"
CERT_PASSWORD="${CERT_PASSWORD:-jzai-coworker-2026}"

# 时间戳服务器（备用）
TIMESTAMP_SERVERS=(
  "http://timestamp.digicert.com"
  "http://timestamp.sectigo.com"
  "http://timestamp.apple.com"
)

# 检查参数
if [ -z "$1" ]; then
  echo "用法: $0 <exe文件路径> [输出路径]"
  echo "示例: $0 dist/见智CoWorker-Setup-x64.exe"
  echo "       $0 dist/见智CoWorker-Setup-x64.exe dist/见智CoWorker-Setup-x64-signed.exe"
  exit 1
fi

EXE_FILE="$1"
OUTPUT_FILE="${2:-$1}"

if [ ! -f "$EXE_FILE" ]; then
  echo "错误: 文件不存在: $EXE_FILE"
  exit 1
fi

echo "=== 签名 Windows 安装器 ==="
echo "输入: $EXE_FILE"
echo "输出: $OUTPUT_FILE"
echo ""

# 检查证书是否存在（优先使用 PFX）
if [ ! -f "$CERT_PFX" ]; then
  echo "错误: 证书文件不存在: $CERT_PFX"
  echo "请先运行: npm run generate-cert"
  exit 1
fi

# 检查 osslsigncode 是否安装
if ! command -v osslsigncode &> /dev/null; then
  echo "→ osslsigncode 未安装，正在安装..."
  if [ -f /etc/debian_version ]; then
    sudo apt-get update && sudo apt-get install -y osslsigncode
  else
    echo "错误: 请手动安装 osslsigncode"
    echo "  Ubuntu/Debian: sudo apt-get install osslsigncode"
    exit 1
  fi
fi

# 如果输入和输出不同，先复制
if [ "$EXE_FILE" != "$OUTPUT_FILE" ]; then
  echo "→ 复制文件..."
  cp "$EXE_FILE" "$OUTPUT_FILE"
fi

# 签名（尝试多个时间戳服务器）
echo "→ 使用 osslsigncode 签名..."
SIGN_SUCCESS=0
for TS_SERVER in "${TIMESTAMP_SERVERS[@]}"; do
  echo "  尝试时间戳服务器: $TS_SERVER"
  # 创建临时输出文件
  TEMP_OUTPUT="${OUTPUT_FILE}.signed"
  if osslsigncode sign \
    -pkcs12 "$CERT_PFX" \
    -pass "$CERT_PASSWORD" \
    -n "见智 CoWorker" \
    -i "https://jzai.ai" \
    -t "$TS_SERVER" \
    -in "$OUTPUT_FILE" \
    -out "$TEMP_OUTPUT" 2>/dev/null; then
    # 替换原文件
    mv "$TEMP_OUTPUT" "$OUTPUT_FILE"
    SIGN_SUCCESS=1
    echo "  ✓ 签名成功（使用 $TS_SERVER）"
    break
  else
    rm -f "$TEMP_OUTPUT"
    echo "  × 失败，尝试下一个..."
  fi
done

if [ $SIGN_SUCCESS -eq 0 ]; then
  echo "错误: 所有时间戳服务器都失败，尝试无时间戳签名..."
  TEMP_OUTPUT="${OUTPUT_FILE}.signed"
  if osslsigncode sign \
    -pkcs12 "$CERT_PFX" \
    -pass "$CERT_PASSWORD" \
    -n "见智 CoWorker" \
    -i "https://jzai.ai" \
    -in "$OUTPUT_FILE" \
    -out "$TEMP_OUTPUT"; then
    mv "$TEMP_OUTPUT" "$OUTPUT_FILE"
  else
    rm -f "$TEMP_OUTPUT"
    echo "错误: 签名失败"
    exit 1
  fi
fi

# 验证签名
echo "→ 验证签名..."
if osslsigncode verify "$OUTPUT_FILE" 2>&1 | grep -q "Signer:"; then
  echo "  ✓ 签名验证成功"
  osslsigncode verify "$OUTPUT_FILE" | grep -E "(Signer|Issuer)"
else
  echo "  ⚠ 签名验证可能失败（自签名证书预期行为）"
fi

echo ""
echo "=== 签名完成 ==="
echo ""
echo "文件大小: $(du -h "$OUTPUT_FILE" | cut -f1)"
echo ""
echo "注意：自签名证书会触发 SmartScreen 警告"
echo "员工需要："
echo "  1. 安装 CA 证书到受信任的根证书颁发机构"
echo "  2. 或在运行时点击"更多信息" → "仍要运行""
