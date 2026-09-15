import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import zhCN from './locales/zh-CN.json';
import zhTW from './locales/zh-TW.json';
import en from './locales/en.json';

export type Locale = 'zh-CN' | 'zh-TW' | 'en';

export const LOCALES: { value: Locale; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'zh-TW', label: '繁體中文' },
  { value: 'en', label: 'English' },
];

const messages: Record<Locale, Record<string, string>> = {
  'zh-CN': zhCN as Record<string, string>,
  'zh-TW': zhTW as Record<string, string>,
  'en': en as Record<string, string>,
};

function detectLocale(): Locale {
  if (typeof navigator === 'undefined') return 'zh-CN';
  const lang = navigator.language || '';
  if (lang.startsWith('zh-TW') || lang.startsWith('zh-Hant')) return 'zh-TW';
  if (lang.startsWith('zh')) return 'zh-CN';
  if (lang.startsWith('en')) return 'en';
  return 'zh-CN';
}

interface I18nState {
  locale: Locale;
  setLocale: (locale: Locale) => void;
}

export const useI18nStore = create<I18nState>()(
  persist(
    (set) => ({
      locale: detectLocale(),
      setLocale: (locale) => set({ locale }),
    }),
    { name: 'jz_locale' },
  ),
);

/** Hook for i18n — use in components: const { t, locale, setLocale } = useI18n() */
export function useI18n() {
  const locale = useI18nStore(s => s.locale);
  const setLocale = useI18nStore(s => s.setLocale);

  const t = (key: string, params?: Record<string, string | number>): string => {
    let text = messages[locale]?.[key] ?? messages['zh-CN']?.[key] ?? key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        text = text.replaceAll(`{${k}}`, String(v));
      }
    }
    return text;
  };

  return { t, locale, setLocale };
}
