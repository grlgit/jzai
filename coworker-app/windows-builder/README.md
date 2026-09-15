# CoWorker Windows Builder

Windows 原生构建系统，用于构建见智 CoWorker AI 员工客户端。

## 快速开始

### 1. 环境要求

- Windows 10/11
- Node.js 18+
- npm 8+
- PowerShell 5.1+（默认）

### 2. 首次构建

```powershell
# 进入目录
cd coworker-app\windows-builder

# 检查环境
.\check-env.ps1

# 生成自签名证书（首次）
.\generate-cert.ps1

# 构建
.\build.ps1
```

### 3. 输出

构建完成后，安装器位于：
```
coworker-app\dist\见智CoWorker-Setup-x64.exe
```

## 命令参考

### build.ps1 - 主构建脚本

```powershell
# 完整构建（环境检查 + 资源准备 + 构建 + 签名）
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

### 辅助脚本

#### download-source.ps1 - 下载 OpenClaw 源码

```powershell
# 下载最新版本
.\download-source.ps1

# 下载指定版本
.\download-source.ps1 -Version "1.2.3"

# 使用官方 npm 源
.\download-source.ps1 -Mirror "npm"

# 从后端 API 下载
.\download-source.ps1 -BackendUrl "http://localhost:1111"
```

#### copy-bridge.ps1 - 复制 jianzhi-bridge 扩展

```powershell
# 自动查找并复制 jianzhi-bridge
.\copy-bridge.ps1

# 指定源路径
.\copy-bridge.ps1 -Source "D:\openclaw\extensions\jianzhi-bridge"

# 指定目标路径
.\copy-bridge.ps1 -Target "D:\coworker-app\resources\extensions\jianzhi-bridge"
```

#### install-sdk.ps1 - 安装 Windows SDK

```powershell
# 安装 Windows 11 SDK（推荐）
.\install-sdk.ps1

# 安装 Windows 10 SDK
.\install-sdk.ps1 -Version "win10"

# 仅安装签名工具组件
.\install-sdk.ps1 -Components "OptionId.WindowsDesktopSDKTools"
```

### 环境变量

```powershell
# 使用商业证书
$env:CERT_PATH = "C:\certs\commercial.pfx"
$env:CERT_PASSWORD = "your-password"
.\build.ps1

# 控制微信插件安装
$env:INSTALL_WECHAT = "false"
.\build.ps1
```

## 单独脚本

### check-env.ps1 - 环境检查

检查构建环境是否满足要求：
- Node.js 版本
- npm 可用性
- Windows 平台
- 签名工具（signtool）
- 证书文件
- 项目依赖
- 必要资源

```powershell
.\check-env.ps1
```

### prepare-resources.ps1 - 资源准备

准备构建所需的扩展和插件：
- 创建 resources/ 目录结构
- 复制 jianzhi-bridge 扩展
- 预安装微信插件
- 检查 OpenClaw 运行时

```powershell
.\prepare-resources.ps1

# 跳过微信插件
.\prepare-resources.ps1 -SkipWeixin
```

### sign.ps1 - 代码签名

对 exe 文件进行签名：

```powershell
# 签名文件
.\sign.ps1 "path\to\file.exe"

# 签名并另存
.\sign.ps1 "path\to\input.exe" "path\to\output.exe"
```

### generate-cert.ps1 - 生成证书

生成自签名代码签名证书：

```powershell
.\generate-cert.ps1
```

生成文件：
- `certificates/jzai-ca.crt` - CA 根证书
- `certificates/jzai-code-signing.crt` - 代码签名证书
- `certificates/jzai-code-signing.key` - 私钥
- `certificates/jzai-code-signing.pfx` - PFX 格式（Windows 签名）

## 证书管理

### 自签名证书

生成的证书用于内部分发，需要员工信任 CA 证书：

1. 将 `certificates/jzai-ca.crt` 分发给员工
2. 员工双击证书 → 安装证书 → 受信任的根证书颁发机构
3. 或运行：`certutil -addstore Root jzai-ca.crt`

### 商业证书

使用商业证书可避免 SmartScreen 警告：

```powershell
$env:CERT_PATH = "C:\path\to\commercial.pfx"
$env:CERT_PASSWORD = "your-password"
.\build.ps1
```

## 常见问题

### PowerShell 执行策略受限

如果脚本无法运行：

```powershell
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### signtool 未找到

签名需要 Windows SDK，安装方法：
- 通过 Visual Studio Installer 安装 Windows SDK
- 或下载 [Windows SDK](https://developer.microsoft.com/windows/downloads/windows-sdk/)

### OpenClaw 子模块未初始化

```powershell
cd ..
git submodule update --init --recursive
cd windows-builder
```

### 依赖安装失败

```powershell
cd ..
npm install
cd windows-builder
```

### 生成证书需要 OpenSSL

下载安装 OpenSSL：
- Win32 OpenSSL: https://slproweb.com/products/Win32OpenSSL.html
- 或使用 chocolatey: `choco install openssl`

## 输出说明

构建产物位置：`coworker-app\dist\`

| 文件 | 说明 |
|------|------|
| `见智CoWorker-Setup-x64.exe` | 安装器（主要输出） |
| `win-unpacked/` | 便携版（未打包） |

## 配置文件

构建配置：`config/build.config.json`

```json
{
  "openClaw": {
    "sourcePath": "../openclaw",
    "useSubmodule": true
  },
  "extensions": {
    "jianzhiBridge": true,
    "weixinPlugin": true
  },
  "build": {
    "target": "portable",
    "arch": "x64",
    "outputDir": "../dist"
  },
  "signing": {
    "enabled": true,
    "timestampServers": [...]
  }
}
```

## 验证签名

```powershell
signtool verify /pa ..\dist\见智CoWorker-Setup-x64.exe
```

## 项目结构

```
windows-builder/
├── build.ps1              # 主构建脚本
├── check-env.ps1          # 环境检查
├── prepare-resources.ps1  # 资源准备
├── sign.ps1               # 代码签名
├── generate-cert.ps1      # 证书生成
├── lib/                   # PowerShell 模块
│   ├── Logger.psm1       # 日志模块
│   ├── FileOps.psm1      # 文件操作
│   └── CertManager.psm1  # 证书管理
├── config/                # 配置文件
│   └── build.config.json
└── README.md
```

## 高级用法

### 构建指定目标

修改 `config/build.config.json`：

```json
{
  "build": {
    "target": "nsis",  // NSIS 安装器
    "arch": "x64"
  }
}
```

### 调试模式

查看详细构建日志：

```powershell
cd ..
npx electron-builder --win --x64 --verbose
```

## 相关文档

- [BUILD.md](../BUILD.md) - 完整构建指南
- [CERTIFICATE.md](../docs/CERTIFICATE.md) - 证书管理详解

## 注意事项

1. **PowerShell 编码**：脚本使用 UTF-8 编码，确保 PowerShell 控制台编码正确
2. **SmartScreen 警告**：自签名证书会触发警告，需要员工信任 CA 证书
3. **管理员权限**：首次导入 CA 证书需要管理员权限
4. **路径长度**：避免在路径过长的目录中构建，可能超过 Windows 路径限制
