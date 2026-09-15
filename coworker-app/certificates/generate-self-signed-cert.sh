#!/bin/bash
#
# 生成自签名代码签名证书
# 用于见智 CoWorker 内部分发
#
# 用法: ./generate-self-signed-cert.sh
#
# 注意：自签名证书会触发 Windows SmartScreen 警告，
# 员工需要手动信任证书或点击"更多信息"->"仍要运行"。
#

set -e

# 支持通过环境变量 CERT_DIR 指定证书目录（用于后端构建服务）
# 如果未设置，使用脚本所在目录
if [ -z "$CERT_DIR" ]; then
  CERT_DIR="$(cd "$(dirname "$0")" && pwd)"
fi
CA_KEY="$CERT_DIR/jzai-ca.key"
CA_CERT="$CERT_DIR/jzai-ca.crt"
CERT_KEY="$CERT_DIR/jzai-code-signing.key"
CERT_CSR="$CERT_DIR/jzai-code-signing.csr"
CERT_CRT="$CERT_DIR/jzai-code-signing.crt"
CERT_PFX="$CERT_DIR/jzai-code-signing.pfx"

# 证书配置
SUBJ="/C=CN/ST=Beijing/L=Beijing/O=JZAI/OU=AI/CN=JZAI AI CoWorker"
VALID_DAYS=3650  # 10年有效期
CERT_PASSWORD="jzai-coworker-2026"  # PFX 导出密码

echo "=== 生成自签名代码签名证书 ==="
echo ""

# 1. 生成 CA 私钥
if [ -f "$CA_KEY" ]; then
  echo "✓ CA 私钥已存在: $CA_KEY"
else
  echo "→ 生成 CA 私钥..."
  openssl genrsa -out "$CA_KEY" 4096
fi

# 2. 生成 CA 证书
if [ -f "$CA_CERT" ]; then
  echo "✓ CA 证书已存在: $CA_CERT"
else
  echo "→ 生成 CA 证书..."
  openssl req -new -x509 -days "$VALID_DAYS" -key "$CA_KEY" -out "$CA_CERT" \
    -subj "$SUBJ" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,digitalSignature,keyCertSign"
fi

# 3. 生成代码签名证书私钥
if [ -f "$CERT_KEY" ]; then
  echo "✓ 证书私钥已存在: $CERT_KEY"
else
  echo "→ 生成代码签名证书私钥..."
  openssl genrsa -out "$CERT_KEY" 2048
fi

# 4. 生成证书签名请求 (CSR)
echo "→ 生成 CSR..."
openssl req -new -key "$CERT_KEY" -out "$CERT_CSR" \
  -subj "$SUBJ"

# 5. 用 CA 签发代码签名证书
if [ -f "$CERT_CRT" ]; then
  echo "✓ 证书已存在: $CERT_CRT"
else
  echo "→ 用 CA 签发代码签名证书..."
  openssl x509 -req -days "$VALID_DAYS" -in "$CERT_CSR" -CA "$CA_CERT" -CAkey "$CA_KEY" \
    -CAcreateserial -out "$CERT_CRT" \
    -extfile <(cat <<EOF
subjectKeyIdentifier=hash
keyUsage=digitalSignature
extendedKeyUsage=codeSigning
basicConstraints=CA:FALSE
EOF
)
fi

# 6. 转换为 PFX 格式 (Windows 签名工具需要)
echo "→ 导出 PFX 格式..."
openssl pkcs12 -export -out "$CERT_PFX" -inkey "$CERT_KEY" -in "$CERT_CRT" \
  -certfile "$CA_CERT" -passout pass:"$CERT_PASSWORD"

# 7. 设置权限
chmod 600 "$CA_KEY" "$CERT_KEY"
chmod 644 "$CA_CERT" "$CERT_CRT"

echo ""
echo "=== 证书生成完成 ==="
echo ""
echo "文件位置:"
echo "  CA 证书: $CA_CERT"
echo "  代码签名证书: $CERT_CRT"
echo "  PFX (Windows): $CERT_PFX"
echo "  PFX 密码: $CERT_PASSWORD"
echo ""
echo "=== 员工信任证书指引 ==="
echo "1. 将 $CA_CERT 分发给员工"
echo "2. 员工双击 CA 证书 → 安装证书 → 受信任的根证书颁发机构"
echo "3. 或在 Windows 运行: certutil -addstore Root $CA_CERT"
echo ""
echo "注意：使用自签名证书签名的应用在首次运行时会触发 SmartScreen 警告。"
echo "     员工可以点击"更多信息" → "仍要运行"来继续。"
