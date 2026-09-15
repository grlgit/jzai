# 见智 CoWorker - 客户构建指南

本文档说明如何在客户环境中构建和签名见智 CoWorker Windows 安装器。

## 一、环境要求

### 必需环境

| 组件 | 版本要求 | 用途 |
|------|---------|------|
| Node.js | 18+ | 构建环境 |
| npm | 8+ | 依赖管理 |

### 可选环境

| 平台 | 额外要求 | 说明 |
|------|---------|------|
| Linux | wine, osslsigncode | 构建安装器和签名 |
| Windows | Windows SDK | 签名（signtool） |
| macOS | - | 仅可构建 macOS 版本 |

### 推荐环境

- **Ubuntu 22.04+**（构建 Windows 安装器）
- **Windows 10/11**（构建 Windows 安装器）

---

## 二、快速开始

### 2.1 Linux/macOS 构建

```bash
# 1. 进入项目目录
cd coworker-app

# 2. 检查环境
./check-env.sh

# 3. 安装依赖
npm install

# 4. 生成自签名证书（或使用自己的证书）
npm run generate-cert

# 5. 一键构建签名
./build.sh

# 6. 输出
# dist/见智CoWorker-Setup-x64.exe（已签名）
```

### 2.2 Windows 构建

```powershell
# 1. 进入 Windows 构建目录
cd coworker-app\windows-builder

# 2. 检查环境
.\check-env.ps1

# 3. 生成自签名证书（首次）
.\generate-cert.ps1

# 4. 一键构建
.\build.ps1

# 5. 输出
# ..\dist\见智CoWorker-Setup-x64.exe（已签名）
```

> **注意**：Windows 构建提供了原生的 PowerShell 脚本，更加友好。详见 [windows-builder/README.md](windows-builder/README.md)

## 二、快速开始

```bash
# 1. 进入项目目录
cd coworker-app

# 2. 检查环境
./check-env.sh

# 3. 安装依赖
npm install

# 4. 生成自签名证书（或使用自己的证书）
npm run generate-cert

# 5. 一键构建签名
./build.sh

# 6. 输出
# dist/见智CoWorker-Setup-x64.exe（已签名）
```

## 三、详细步骤

### 3.1 环境检查

运行环境检查脚本，确认所有依赖已安装：

```bash
./check-env.sh
```

检查项包括：
- Node.js 版本
- npm 可用性
- 平台识别
- 构建依赖（wine 等）
- 签名工具
- 证书文件
- 图标资源

### 3.2 安装依赖

```bash
npm install
```

主要依赖：
- `electron` - Electron 框架
- `electron-builder` - 打包工具
- `axios` - HTTP 客户端
- `electron-store` - 本地存储

### 3.3 准备证书

#### 选项A：生成自签名证书（内部使用）

```bash
npm run generate-cert
```

这将生成：
- `certificates/jzai-ca.crt` - CA 根证书
- `certificates/jzai-code-signing.crt` - 代码签名证书
- `certificates/jzai-code-signing.key` - 私钥
- `certificates/jzai-code-signing.pfx` - PFX 格式

**重要**：需要将 CA 根证书分发给员工，安装到"受信任的根证书颁发机构"。

#### 选项B：使用自己的证书

如果有商业代码签名证书，可以设置环境变量：

```bash
export CERT_PATH=/path/to/your/certificate.pfx
export CERT_PASSWORD=your-certificate-password
./build.sh
```

### 3.4 构建

```bash
./build.sh
```

构建选项：

```bash
# 跳过环境检查
./build.sh --skip-env-check

# 构建但不签名
./build.sh --no-sign

# 清理后重新构建
./build.sh --clean

# 查看帮助
./build.sh --help
```

### 3.5 验证签名

```bash
# Linux 上验证
osslsigncode verify dist/见智CoWorker-Setup-x64.exe

# Windows 上验证
signtool verify /pa dist/见智CoWorker-Setup-x64.exe
```

## 四、分发

### 4.1 上传到见智后台

通过管理界面上传，或调用 API：

```bash
curl -X POST http://your-jzai-instance/api/coworkers/app/win/upload \
  -H "Authorization: Bearer YOUR_ADMIN_TOKEN" \
  -H "X-App-Version: 1.0.0" \
  -F "path=@dist/见智CoWorker-Setup-x64.exe"
```

### 4.2 分发给员工

1. **下载链接**：员工通过见智后台下载
   ```
   http://your-jzai-instance/api/coworkers/app/win?token=XXX
   ```

2. **激活 token**：每个分配有唯一的激活 token

3. **CA 证书**：如使用自签名证书，需将 `jzai-ca.crt` 发给员工安装

## 五、Windows 专门指南

### 5.1 Windows 构建系统

`windows-builder/` 目录提供了完整的 Windows 原生构建系统：

```
windows-builder/
├── build.ps1              # 主构建脚本
├── check-env.ps1          # 环境检查
├── prepare-resources.ps1  # 资源准备
├── sign.ps1               # 代码签名
├── generate-cert.ps1      # 证书生成
├── lib/                   # PowerShell 模块
├── config/                # 配置文件
└── README.md              # Windows 构建文档
```

### 5.2 Windows 构建选项

```powershell
# 完整构建（默认）
.\build.ps1

# 跳过环境检查
.\build.ps1 -SkipEnvCheck

# 构建但不签名
.\build.ps1 -NoSign

# 清理后重建
.\build.ps1 -Clean

# 跳过微信插件预安装
.\build.ps1 -SkipWeixin
```

### 5.3 Windows 环境要求

- **PowerShell 5.1+**：Windows 10/11 默认包含
- **Node.js 18+**：从 [nodejs.org](https://nodejs.org) 下载
- **OpenSSL**：生成证书需要（[Win32 OpenSSL](https://slproweb.com/products/Win32OpenSSL.html)）
- **Windows SDK**：签名需要 signtool（通过 Visual Studio Installer 安装）

### 5.4 PowerShell 执行策略

如果遇到"无法加载文件，因为在此系统上禁止运行脚本"错误：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 5.5 使用商业证书

```powershell
# 设置环境变量
$env:CERT_PATH = "C:\certs\commercial.pfx"
$env:CERT_PASSWORD = "your-password"

# 构建
.\build.ps1
```

### 5.6 导入 CA 证书

为避免 SmartScreen 警告，员工需要安装 CA 证书：

**方法 1：GUI**
1. 双击 `certificates/jzai-ca.crt`
2. 点击"安装证书"
3. 选择"受信任的根证书颁发机构"
4. 完成安装

**方法 2：命令行**（需要管理员权限）

```cmd
certutil -addstore Root jzai-ca.crt
```

---

## 六、常见问题

**解决方案**：
```bash
# Ubuntu/Debian
sudo apt-get update
sudo apt-get install wine64

# 验证
wine --version
```

### Q2: 签名失败 "osslsigncode not found"

**解决方案**：
```bash
sudo apt-get install osslsigncode
```

### Q3: Windows SmartScreen 警告

**原因**：自签名证书不受 Windows 信任

**解决方案**：
1. 员工安装 CA 根证书到"受信任的根证书颁发机构"
2. 首次运行时点击"更多信息" → "仍要运行"

### Q4: 构建产物过大

**原因**：Electron 包含了 Chromium 和 Node.js

**说明**：
- 预期大小：150-300 MB
- 内网分发通常可接受
- 可考虑使用 electron-updater 实现增量更新（未来）

### Q5: 如何修改应用图标？

**解决方案**：
替换 `assets/icon.ico` 和 `assets/installer-icon.ico`

## 六、高级配置

### 使用自定义证书

```bash
export CERT_PATH=/path/to/certificate.pfx
export CERT_PASSWORD=your-password
./build.sh
```

### 仅构建不签名

```bash
./build.sh --no-sign
```

### 指定输出目录

构建产物固定在 `dist/` 目录，可以通过符号链接或复制移动到其他位置。

## 七、故障排查

### 构建环境问题

1. 检查 Node.js 版本：`node -v`（需要 >=18）
2. 清理重试：`rm -rf node_modules && npm install && ./build.sh --clean`
3. 查看详细日志：`npm run build -- --verbose`

### 签名问题

1. 确认证书文件存在
2. 检查证书密码
3. 验证签名工具安装

### 运行时问题

应用安装后的运行时问题，参见 `docs/CERTIFICATE.md`。

## 八、参考链接

- Electron 官方文档: https://www.electronjs.org/docs
- electron-builder 文档: https://www.electron.build/
- osslsigncode: https://github.com/mtrojnar/osslsigncode
