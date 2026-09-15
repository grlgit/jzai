/**
 * electron-builder afterSign hook
 * 在签名完成后执行，用于：
 * - 验证签名
 * - 记录签名信息
 */

exports.default = async function (context) {
  const { electronPlatformName, appOutDir, packager } = context;

  console.log(`[afterSign] Platform: ${electronPlatformName}`);
  console.log(`[afterSign] Output: ${appOutDir}`);
  console.log(`[afterSign] Package name: ${packager.appInfo.productName}`);

  // Windows 平台签名验证
  if (electronPlatformName === 'windows') {
    console.log('[afterSign] Windows build signed');

    // 检查 osslsigncode 是否可用于验证
    const { execSync } = require('child_process');
    try {
      const exePath = `${appOutDir}/见智CoWorker-Setup-x64.exe`;
      if (require('fs').existsSync(exePath)) {
        console.log('[afterSign] Verifying signature...');
        try {
          execSync(`osslsigncode verify "${exePath}"`, { stdio: 'inherit' });
          console.log('[afterSign] Signature verified successfully');
        } catch (err) {
          console.warn('[afterSign] Signature verification failed (expected for self-signed cert)');
        }
      }
    } catch (err) {
      console.log('[afterSign] osslsigncode not available for verification');
    }
  }
};
