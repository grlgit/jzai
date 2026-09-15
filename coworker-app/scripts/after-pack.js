/**
 * electron-builder afterPack hook
 * 在打包完成后执行，用于：
 * - 验证资源完整性
 * - 添加额外的元数据
 */

const fs = require('fs');
const path = require('path');

exports.default = async function (context) {
  const { electronPlatformName, appOutDir, packager } = context;

  console.log(`[afterPack] Platform: ${electronPlatformName}`);
  console.log(`[afterPack] Output: ${appOutDir}`);
  console.log(`[afterPack] Package name: ${packager.appInfo.productName}`);

  // Windows 平台特殊处理
  if (electronPlatformName === 'windows') {
    console.log('[afterPack] Windows build completed');

    // 检查 resources 目录是否正确打包
    const resourcesDir = path.join(appOutDir, 'resources');
    const openclawDir = path.join(resourcesDir, 'openclaw');
    const extensionsDir = path.join(resourcesDir, 'extensions');
    const jianzhiBridgeDir = path.join(extensionsDir, 'jianzhi-bridge');

    console.log('[afterPack] 验证资源目录...');
    console.log(`  resources: ${fs.existsSync(resourcesDir) ? '✓' : '✗'}`);
    console.log(`  openclaw: ${fs.existsSync(openclawDir) ? '✓' : '✗'}`);
    console.log(`  extensions: ${fs.existsSync(extensionsDir) ? '✓' : '✗'}`);
    console.log(`  jianzhi-bridge: ${fs.existsSync(jianzhiBridgeDir) ? '✓' : '✗'}`);

    // 验证关键文件
    if (fs.existsSync(jianzhiBridgeDir)) {
      const pluginJson = path.join(jianzhiBridgeDir, 'openclaw.plugin.json');
      const pluginJs = path.join(jianzhiBridgeDir, 'plugin.js');
      console.log(`  jianzhi-bridge/plugin.json: ${fs.existsSync(pluginJson) ? '✓' : '✗'}`);
      console.log(`  jianzhi-bridge/plugin.js: ${fs.existsSync(pluginJs) ? '✓' : '✗'}`);
    }

    // 检查微信插件（如果预装）
    const weixinDir = path.join(extensionsDir, 'openclaw-weixin');
    if (fs.existsSync(weixinDir)) {
      console.log(`  openclaw-weixin: ✓ (预装)`);
    } else {
      console.log(`  openclaw-weixin: ✗ (未预装，将在首次启动时安装)`);
    }
  }
};
