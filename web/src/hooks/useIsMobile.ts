'use client';

import { useState, useEffect } from 'react';

/** 移动模式判定：视口宽度 ≤768px，监听 resize 动态切换（不用 UA 嗅探） */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mql = window.matchMedia('(max-width: 768px)');
    const update = () => setIsMobile(mql.matches);
    update();
    mql.addEventListener('change', update);
    return () => mql.removeEventListener('change', update);
  }, []);

  return isMobile;
}
