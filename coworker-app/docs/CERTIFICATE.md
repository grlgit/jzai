# 代码签名证书指南

本文档说明见智 CoWorker Windows 应用的代码签名证书相关事项。

## 一、证书类型

### 自签名证书（内部使用）

见智 CoWorker 默认使用自签名证书，适合企业内部分发。

**优点**：
- 免费，可自行生成
- 无需第三方审核
- 适合内部分发

**缺点**：
- 员工需要安装 CA 根证书
- 首次运行会触发 SmartScreen 警告
- 不能用于公开分发

### 商业证书（推荐用于公开分发）

从 DigiCert、Sectigo 等 CA 购买 OV/EV 代码签名证书。

**优点**：
- Windows 原生信任，无需额外操作
- 无 SmartScreen 警告
- 可用于公开分发

**缺点**：
- 需要购买（每年几百美元）
- 需要企业身份验证

## 二、生成自签名证书

### 使用生成脚本

```bash
cd coworker-app
npm run generate-cert
```

### 手动生成（参考）

```bash
# 生成 CA 私钥和证书
openssl genrsa -out jzai-ca.key 4096
openssl req -new -x509 -days 3650 -key jzai-ca.key -out jzai-ca.crt \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=YourCompany/OU=IT/CN=YourCompany-CA"

# 生成代码签名私钥
openssl genrsa -out jzai-code-signing.key 4096

# 生成证书签名请求
openssl req -new -key jzai-code-signing.key -out jzai-code-signing.csr \
  -subj "/C=CN/ST=Beijing/L=Beijing/O=YourCompany/OU=IT/CN=YourCompany-CoWorker"

# CA 签名
openssl x509 -req -days 3650 -in jzai-code-signing.csr \
  -CA jzai-ca.crt -CAkey jzai-ca.key -CAcreateserial \
  -out jzai-code-signing.crt

# 转换为 PFX（Windows 签名工具需要）
openssl pkcs12 -export -out jzai-code-signing.pfx \
  -inkey jzai-code-signing.key -in jzai-code-signing.crt \
  -passout pass:your-password
```

## 三、分发 CA 根证书

### 员工端安装步骤

1. **获取 CA 证书**：`jzai-ca.crt`

2. **安装证书**：
   - 双击 `jzai-ca.crt`
   - 选择"本地计算机"
   - 点击"安装证书"
   - 选择"将所有证书放入下列存储"
   - 浏览到"受信任的根证书颁发机构"
   - 完成

3. **验证安装**：
   ```
   certmgr.msc → 受信任的根证书颁发机构 → 证书
   应该能看到 "YourCompany-CA"
   ```

### 批量部署（IT 管理员）

#### 通过组策略

1. 将 CA 证书复制到域控制器
2. 打开组策略管理
3. 编辑默认域策略
4. 导航到：计算机配置 → 策略 → Windows 设置 → 安全设置 → 公钥策略 → 受信任的根证书颁发机构
5. 右键 → 导入证书

#### 通过 PowerShell

```powershell
# 安装到本地计算机
Import-Certificate -FilePath "jzai-ca.crt" -CertStoreLocation "Cert:\LocalMachine\Root"
```

#### 通过命令行

```bash
# Windows
certutil -addstore "Root" jzai-ca.crt

# Linux (如果使用)
cp jzai-ca.crt /usr/local/share/ca-certificates/
update-ca-certificates
```

## 四、SmartScreen 警告处理

### 自签名证书的警告

即使安装了 CA 证书，首次运行时可能仍会看到 SmartScreen 警告。

**处理方法**：

1. 点击"更多信息"
2. 点击"仍要运行"
3. 后续运行将不再警告

### 为什么仍有警告？

Windows SmartScreen 使用多种机制：
- 证书信任链（CA 安装可解决）
- 文件声誉（新文件需要时间建立）
- 应用声誉（首次分发的应用）

随着安装量增加，警告会逐渐消失。

### 加速建立声誉

1. 通过 Windows 商店分发（需要特殊认证）
2. 使用 EV 代码签名证书（建立速度更快）
3. 收集用户反馈，向 Microsoft 报告误报

## 五、商业证书购买

### 推荐的证书颁发机构

| CA | 官网 | 说明 |
|----|------|------|
| DigiCert | https://www.digicert.com | 行业标准，支持 EV |
| Sectigo | https://www.sectigo.com | 价格较低 |
| GlobalSign | https://www.globalsign.com | 国际认可 |

### 证书类型选择

| 类型 | 价格 | 信任速度 | 建议 |
|------|------|----------|------|
| OV（组织验证） | $200-500/年 | 1-3 天 | 内部分发推荐 |
| EV（扩展验证） | $500-1000/年 | 即时 | 公开发布推荐 |

### 购买流程

1. 准备企业证明文件
   - 营业执照
   - 组织电话验证
   - 企业身份验证

2. 生成 CSR
   ```bash
   # 使用脚本生成，或手动：
   openssl req -new -newkey rsa:4096 -nodes -out request.csr -keyout private.key \
     -subj "/C=CN/ST=Beijing/L=Beijing/O=YourCompany/OU=IT/CN=YourCompany"
   ```

3. 提交 CSR 给 CA
4. 等待验证
5. 下载证书文件

### 使用商业证书

```bash
export CERT_PATH=/path/to/certificate.pfx
export CERT_PASSWORD=your-password
./build.sh
```

## 六、证书安全

### 私钥保护

1. **不要提交到版本控制**
   ```bash
   # .gitignore
   certificates/*.key
   certificates/*.pfx
   certificates/*.pem
   certificates/*.srl
   ```

2. **安全存储**
   - 使用硬件安全模块（HSM）
   - 或加密存储在安全位置

3. **访问控制**
   - 限制可访问私钥的人员
   - 定期轮换证书

### 证书轮换

1. 生成新证书
2. 重新构建签名应用
3. 通知用户重新下载
4. 撤销旧证书（如需）

## 七、故障排查

### Q: 证书验证失败

**可能原因**：
- 证书已过期
- 证书链不完整
- 根证书未安装

**解决方法**：
```bash
# 验证证书
openssl x509 -in jzai-code-signing.crt -text -noout

# 检查有效期
openssl x509 -in jzai-code-signing.crt -noout -dates

# 验证证书链
openssl verify -CAfile jzai-ca.crt jzai-code-signing.crt
```

### Q: 签名后验证失败

**可能原因**：
- 证书与签名不匹配
- 时间戳服务器不可达

**解决方法**：
```bash
# Linux 上验证
osslsigncode verify -in dist/见智CoWorker-Setup-x64.exe

# 查看签名详情
osslsigncode verify -in dist/见智CoWorker-Setup-x64.exe -verbose
```

## 八、参考资源

- [Microsoft 代码签名最佳实践](https://docs.microsoft.com/en-us/windows/win32/seccrypto/cryptography-tools)
- [osslsigncode 文档](https://github.com/mtrojnar/osslsigncode)
- [DigiCert 代码签名指南](https://www.digicert.com/kb-code-signing)
