'use client';

import { useState, useEffect } from 'react';

/** 手机图标 + hover 展开移动访问二维码。仅在桌面模式头部使用。 */
export default function MobileAccessQr({ url }: { url: string }) {
  const [qrDataUrl, setQrDataUrl] = useState('');

  useEffect(() => {
    if (!url) { setQrDataUrl(''); return; }
    let cancelled = false;
    import('qrcode').then(QRCode =>
      QRCode.toDataURL(url, { width: 160, margin: 1, color: { dark: '#1f2937', light: '#ffffff' } }),
    ).then(dataUrl => { if (!cancelled) setQrDataUrl(dataUrl); })
     .catch(() => {});
    return () => { cancelled = true; };
  }, [url]);

  if (!url) return null;

  return (
    <div className="relative group">
      <div className="w-8 h-8 rounded-full flex items-center justify-center cursor-pointer text-gray-400 hover:text-indigo-600 hover:bg-indigo-50" title="手机访问">
        <svg className="w-4.5 h-4.5" width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.8}>
          <rect x="7" y="2.5" width="10" height="19" rx="2" />
          <line x1="10.5" y1="18.5" x2="13.5" y2="18.5" strokeLinecap="round" />
        </svg>
      </div>
      <div className="hidden group-hover:block absolute right-0 top-9 bg-white border border-gray-200 rounded-lg p-3 shadow-lg z-50 w-[200px]">
        <div className="text-xs font-medium text-gray-700 mb-2 text-center">手机扫码访问</div>
        {qrDataUrl ? (
          <img src={qrDataUrl} alt="移动访问二维码" width={160} height={160} className="mx-auto rounded" />
        ) : (
          <div className="w-[160px] h-[160px] mx-auto bg-gray-50 rounded flex items-center justify-center text-xs text-gray-300">生成中…</div>
        )}
        <div className="text-[10px] text-gray-400 mt-2 break-all text-center leading-relaxed">{url}</div>
      </div>
    </div>
  );
}
