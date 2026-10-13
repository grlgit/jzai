'use client';

import { useState, useEffect, FormEvent } from 'react';
import { useI18n, LOCALES } from '@/i18n';

interface LoginPageProps {
  onLogin: (email: string, password: string) => Promise<string | null>;
}

/** 现代 CSS 基线检测：oklch 颜色支持 ≈ Tailwind v4 基线（Chrome/Edge 111+、Safari 16.4+）。
 *  低于此基线的内核（如旧版华为浏览器）无法解析 @layer/oklch，工具类整体失效。 */
function detectModernCss(): boolean {
  try {
    return typeof CSS !== 'undefined' && CSS.supports('color', 'oklch(69% 0.1 200)');
  } catch {
    return false;
  }
}

export default function LoginPage({ onLogin }: LoginPageProps) {
  const { t, locale, setLocale } = useI18n();
  const [account, setAccount] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPwd, setShowPwd] = useState(false);
  const [outdatedBrowser, setOutdatedBrowser] = useState(false);

  useEffect(() => {
    if (!detectModernCss()) setOutdatedBrowser(true);
  }, []);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!account || !password) return;
    setLoading(true);
    setError('');
    const err = await onLogin(account, password);
    if (err) setError(err);
    setLoading(false);
  };

  return (
    <div className="h-full flex bg-white">
      {/* 过旧浏览器警告：必须用内联样式——老内核上 Tailwind 工具类已整体失效，横幅自身不能依赖它们 */}
      {outdatedBrowser && (
        <div style={{
          position: 'fixed', top: 0, left: 0, right: 0, zIndex: 9999,
          background: '#b45309', color: '#fff', padding: '10px 16px',
          fontSize: 13, lineHeight: 1.6, textAlign: 'center',
        }}>
          {locale === 'en'
            ? 'Your browser is outdated and this page may not render correctly. Please upgrade, or use Chrome / Edge 111+ or Safari 16.4+.'
            : '当前浏览器版本过低，页面样式可能无法正常显示。请升级浏览器，或使用 Chrome / Edge 111+、Safari 16.4+ 访问。'}
        </div>
      )}
      {/* Left: Brand Poster */}
      <div className="hidden lg:flex lg:w-[56%] relative overflow-hidden">
        {/* Gradient background */}
        <div className="absolute inset-0 bg-gradient-to-br from-[#1a2a6c] via-[#2d4a7a] to-[#0f3460]" />

        {/* Decorative elements */}
        <svg className="absolute inset-0 w-full h-full" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="none">
          {/* Large glow circles */}
          <defs>
            <radialGradient id="glow1" cx="30%" cy="40%" r="40%">
              <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.3" />
              <stop offset="100%" stopColor="#3b82f6" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glow2" cx="70%" cy="70%" r="35%">
              <stop offset="0%" stopColor="#f97316" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#f97316" stopOpacity="0" />
            </radialGradient>
            <radialGradient id="glow3" cx="20%" cy="80%" r="30%">
              <stop offset="0%" stopColor="#22c55e" stopOpacity="0.15" />
              <stop offset="100%" stopColor="#22c55e" stopOpacity="0" />
            </radialGradient>
            <linearGradient id="lineGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="#60a5fa" stopOpacity="0.4" />
              <stop offset="100%" stopColor="#a78bfa" stopOpacity="0.1" />
            </linearGradient>
            <linearGradient id="cardGrad" x1="0%" y1="0%" x2="100%" y2="100%">
              <stop offset="0%" stopColor="white" stopOpacity="0.1" />
              <stop offset="100%" stopColor="white" stopOpacity="0.03" />
            </linearGradient>
          </defs>

          <rect width="100%" height="100%" fill="url(#glow1)" />
          <rect width="100%" height="100%" fill="url(#glow2)" />
          <rect width="100%" height="100%" fill="url(#glow3)" />

          {/* Grid lines */}
          {[...Array(8)].map((_, i) => (
            <line key={`h${i}`} x1="0" y1={`${(i + 1) * 12}%`} x2="100%" y2={`${(i + 1) * 12}%`}
              stroke="white" strokeOpacity="0.04" strokeWidth="1" />
          ))}
          {[...Array(6)].map((_, i) => (
            <line key={`v${i}`} x1={`${(i + 1) * 16}%`} y1="0" x2={`${(i + 1) * 16}%`} y2="100%"
              stroke="white" strokeOpacity="0.04" strokeWidth="1" />
          ))}

          {/* Floating geometric shapes */}
          <circle cx="15%" cy="20%" r="60" fill="none" stroke="url(#lineGrad)" strokeWidth="1.5" opacity="0.6">
            <animateTransform attributeName="transform" type="rotate" from="0 15% 20%" to="360 15% 20%" dur="30s" repeatCount="indefinite" />
          </circle>
          <circle cx="15%" cy="20%" r="45" fill="none" stroke="url(#lineGrad)" strokeWidth="1" opacity="0.3" strokeDasharray="6 4">
            <animateTransform attributeName="transform" type="rotate" from="360 15% 20%" to="0 15% 20%" dur="20s" repeatCount="indefinite" />
          </circle>

          <rect x="78%" y="15%" width="80" height="80" rx="16" fill="none" stroke="white" strokeOpacity="0.12" strokeWidth="1.5"
            transform="rotate(30, 82%, 19%)">
            <animateTransform attributeName="transform" type="rotate" from="30 82% 19%" to="390 82% 19%" dur="40s" repeatCount="indefinite" />
          </rect>

          <polygon points="50,10 90,75 10,75" fill="none" stroke="white" strokeOpacity="0.08" strokeWidth="1.5"
            transform="translate(70, 520)">
            <animateTransform attributeName="transform" type="rotate" from="0 50 45" to="360 50 45" dur="35s" repeatCount="indefinite" />
          </polygon>

          {/* Accent dots */}
          {[
            { cx: '10%', cy: '60%', r: 3, o: 0.4 },
            { cx: '25%', cy: '85%', r: 2, o: 0.3 },
            { cx: '85%', cy: '45%', r: 4, o: 0.2 },
            { cx: '90%', cy: '80%', r: 2.5, o: 0.3 },
            { cx: '60%', cy: '12%', r: 3, o: 0.25 },
            { cx: '40%', cy: '92%', r: 2, o: 0.35 },
          ].map((d, i) => (
            <circle key={`dot${i}`} cx={d.cx} cy={d.cy} r={d.r} fill="#60a5fa" opacity={d.o}>
              <animate attributeName="opacity" values={`${d.o};${d.o * 2};${d.o}`} dur={`${3 + i}s`} repeatCount="indefinite" />
            </circle>
          ))}
        </svg>

        {/* Content overlay */}
        <div className="relative z-10 flex flex-col justify-between p-12 w-full">
          {/* Top: Logo + Brand */}
          <div className="flex items-center gap-3">
            <img src="/logo.png" alt={t('login.brand')} className="w-10 h-auto drop-shadow-lg" />
            <div>
              <span className="text-white/90 text-lg font-semibold tracking-wide">{t('login.brand')}</span>
              <span className="text-white/40 text-xs ml-2">{t('login.brandEn')}</span>
            </div>
          </div>

          {/* Center: Hero content */}
          <div className="flex-1 flex flex-col justify-center max-w-lg">
            <h1 className="text-[2.75rem] leading-tight font-bold text-white mb-3 tracking-tight">
              {t('login.slogan')}
            </h1>
            <p className="text-xl text-blue-200/80 mb-8 font-light">
              {t('login.subSlogan')}
            </p>

            {/* Feature cards */}
            <div className="space-y-4">
              {[
                {
                  icon: (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 2a7 7 0 0 1 7 7c0 2.5-1.3 4.7-3.2 6H8.2C6.3 13.7 5 11.5 5 9a7 7 0 0 1 7-7z" />
                      <path d="M9 16h6" /><path d="M10 20h4" /><path d="M9.5 16v2a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-2" />
                    </svg>
                  ),
                  title: t('login.heart'),
                  desc: t('login.heartDesc'),
                  color: 'from-blue-400/20 to-cyan-400/10',
                  border: 'border-blue-400/20',
                },
                {
                  icon: (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
                      <circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                    </svg>
                  ),
                  title: t('login.coworker'),
                  desc: t('login.coworkerDesc'),
                  // color: 'from-orange-400/20 to-amber-400/10',
                  // border: 'border-orange-400/20',
                  color: 'from-green-400/20 to-emerald-400/10',
                  border: 'border-green-400/20',
                },
                {
                  icon: (
                    <svg className="w-5 h-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M12 20V10" /><path d="M18 20V4" /><path d="M6 20v-4" />
                    </svg>
                  ),
                  title: t('login.smart'),
                  desc: t('login.smartDesc'),
                  color: 'from-orange-400/20 to-amber-400/10',
                  border: 'border-orange-400/20',
                  // color: 'from-green-400/20 to-emerald-400/10',
                  // border: 'border-green-400/20',
                }
              ].map((f, i) => (
                <div key={i} className={`flex items-start gap-4 bg-gradient-to-r ${f.color} backdrop-blur-sm border ${f.border} rounded-xl px-5 py-4 transition-all hover:scale-[1.02]`}>
                  <div className="text-white/70 mt-0.5 shrink-0">{f.icon}</div>
                  <div>
                    <div className="text-white/90 text-sm font-medium mb-0.5">{f.title}</div>
                    <div className="text-white/50 text-xs leading-relaxed">{f.desc}</div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Bottom: tagline */}
          <div className="text-white/25 text-xs">
            {t('login.tagline')}
          </div>
        </div>
      </div>

      {/* Right: Login Form */}
      <div className="flex-1 flex items-center justify-center px-6 relative">
        {/* Subtle background pattern */}
        <div className="absolute inset-0 bg-gradient-to-b from-gray-50/50 to-white" />

        <div className="relative z-10 w-full max-w-sm">
          {/* Mobile logo (hidden on desktop) */}
          <div className="lg:hidden text-center mb-8">
            <img src="/logo.png" alt={t('login.brand')} className="w-14 h-auto mx-auto mb-3" />
            <h1 className="text-2xl font-bold bg-gradient-to-r from-[#1a2a6c] to-[#3b82f6] bg-clip-text text-transparent">
              {t('login.slogan')}
            </h1>
            <p className="text-xs text-gray-400 mt-1">{t('login.brandEn')}</p>
          </div>

          {/* Welcome text (desktop) */}
          <div className="hidden lg:block mb-8">
            <h2 className="text-2xl font-bold text-gray-800 mb-1">{t('login.welcome')}</h2>
            <p className="text-sm text-gray-400">{t('login.welcomeDesc')}</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">{t('login.account')}</label>
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
                <input
                  type="text"
                  value={account}
                  onChange={e => setAccount(e.target.value)}
                  className="w-full pl-10 pr-4 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-400/10 transition-all"
                  placeholder={t('login.accountPlaceholder')}
                  autoFocus
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-gray-500 mb-1.5">{t('login.password')}</label>
              <div className="relative">
                <div className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-300">
                  <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" />
                  </svg>
                </div>
                <input
                  type={showPwd ? 'text' : 'password'}
                  value={password}
                  onChange={e => setPassword(e.target.value)}
                  className="w-full pl-10 pr-10 py-2.5 bg-gray-50 border border-gray-200 rounded-lg text-sm outline-none focus:bg-white focus:border-blue-400 focus:ring-2 focus:ring-blue-400/10 transition-all"
                  placeholder={t('login.passwordPlaceholder')}
                />
                <button type="button" onClick={() => setShowPwd(!showPwd)}
                  className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-300 hover:text-gray-500 transition-colors">
                  {showPwd ? (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                      <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                      <line x1="1" y1="1" x2="23" y2="23" />
                    </svg>
                  ) : (
                    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                      <circle cx="12" cy="12" r="3" />
                    </svg>
                  )}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-xs text-red-600 bg-red-50 border border-red-100 rounded-lg px-3 py-2.5">
                <svg className="w-4 h-4 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10" /><line x1="15" y1="9" x2="9" y2="15" /><line x1="9" y1="9" x2="15" y2="15" />
                </svg>
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || !account || !password}
              className="w-full py-2.5 bg-gradient-to-r from-[#1a2a6c] to-[#3b82f6] text-white text-sm font-medium rounded-lg hover:shadow-lg hover:shadow-blue-500/25 disabled:opacity-40 disabled:hover:shadow-none transition-all duration-300"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="w-4 h-4 animate-spin" viewBox="0 0 24 24" fill="none">
                    <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeOpacity="0.3" />
                    <path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                  </svg>
                  {t('login.loading')}
                </span>
              ) : t('login.submit')}
            </button>
          </form>

          <p className="text-[11px] text-gray-300 text-center mt-6">
            {t('login.defaultHint')}
          </p>

          <div className="flex items-center justify-center gap-1 mt-4">
            {LOCALES.map(l => (
              <button key={l.value} onClick={() => setLocale(l.value)}
                className={`text-xs px-2 py-1 rounded transition-colors ${locale === l.value ? 'text-gray-700 font-medium bg-gray-100' : 'text-gray-300 hover:text-gray-500'}`}>
                {l.label}
              </button>
            ))}
          </div>

          {/* Footer */}
          <div className="mt-16 pt-6 border-t border-gray-100 text-center">
            <p className="text-[11px] text-gray-300">
              {t('login.footer')}
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
