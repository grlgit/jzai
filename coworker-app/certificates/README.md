# 自签名证书方案 - 见智 CoWorker Windows 客户端

## 概述

由于见智 CoWorker 是内部系统，不对外公开发布，我们使用**自签名证书**来签名 Windows 安装器。这样可以节省购买 OV/EV 证书的费用，同时满足内部分发需求。

## 证书文件

| 文件 | 说明 |
|------|------|
| `jzai-ca.crt` | CA 根证书（需要员工安装到受信任的根证书） |
| `jzai-code-signing.crt` | 代码签名证书 |
| `jzai-code-signing.key` | 证书私钥（保密） |
| `jzai-code-signing.pfx` | PKCS#12 格式（Windows 签名工具使用） |
| `jzai-code-signing.pub` | 公钥（可选） |

## 生成证书

```bash
cd coworker-app/certificates
./generate-self-signed-cert.sh
```

生成过程会创建：
1. CA 根证书和私钥
2. 代码签名证书和私钥
3. PFX 格式证书（用于 osslsigncode）

## 签名安装器

```bash
cd coworker-app
npm run build:win
npm run sign dist/见智CoWorker-Setup-x64.exe
```

或手动使用 osslsigncode：

```bash
osslsigncode sign \
  -certs certificates/jzai-code-signing.crt \
  -key certificates/jzai-code-signing.key \
  -pass jzai-coworker-2026 \
  -n "见智 CoWorker" \
  -i "JZAI" \
  -t http://timestamp.digicert.com \
  -in dist/见智CoWorker-Setup-x64.exe \
  -out dist/见智CoWorker-Setup-x64-signed.exe
```

## 员工安装 CA 证书

为减少 SmartScreen 警告，员工需要将 CA 根证书安装到"受信任的根证书颁发机构"。

### 方法 1：双击安装（推荐）

1. 管理员将 `jzai-ca.crt` 分发给员工
2. 员工双击 `jzai-ca.crt`
3. 点击"安装证书"
4. 选择"将所有证书放入下列存储" → "受信任的根证书颁发机构"
5. 点击"完成"

### 方法 2：命令行安装

**管理员权限运行：**

```cmd
certutil -addstore Root jzai-ca.crt
```

### 方法 3：组策略部署（企业环境）

通过 AD 组策略将 CA 证书部署到所有员工电脑。

## SmartScreen 警告

即使安装了 CA 证书，首次运行时仍可能触发 SmartScreen 警告。

**员工操作：**
1. 点击"更多信息"
2. 点击"仍要运行"

**原因：**
- 自签名证书不在 Microsoft 信任列表中
- 内部分发，未积累足够的"声誉"

## 安全注意事项

1. **私钥保护**：`jzai-code-signing.key` 和 `jzai-ca.key` 必须保密，不应提交到公开仓库
2. **证书有效期**：当前设置为 10 年，到期后需重新生成
3. **证书分发**：仅向内部员工分发 CA 证书
4. **证书撤销**：如私钥泄露，需立即重新生成并通知员工

## 替代方案

如果未来需要对外发布或消除 SmartScreen 警告，可考虑：
1. 购买 OV/EV 代码签名证书
2. 使用 Windows Defender Application Control (WDAC)
3. 加入 Microsoft SmartScreen 白名单程序

## 故障排除

### 签名失败

```
Error: Certificate not found
```

检查证书文件路径是否正确，证书是否已生成。

### SmartScreen 仍然拦截

1. 确认 CA 证书已安装到"受信任的根证书颁发机构"
2. 检查证书是否在有效期内
3. 尝试完全卸载后重新安装应用
4. 临时关闭 SmartScreen（不推荐）

### 证书安装失败

确保以管理员权限运行安装命令。
