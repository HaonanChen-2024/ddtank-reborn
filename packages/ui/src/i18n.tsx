import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Locale = "zh-CN" | "pt-BR" | "en";

const STORAGE_KEY = "ddtank.locale";

function readStoredLocale(fallback: Locale): Locale {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "zh-CN" || v === "en" || v === "pt-BR" ? v : fallback;
  } catch {
    return fallback;
  }
}

type Vars = Record<string, string | number>;

/**
 * Tiny i18n. `pt-BR` is the source dictionary (keys are typed from it); `en` is the fallback.
 * A complete `zh-CN` dictionary makes Chinese the default; saved locale preferences take precedence.
 * Lookup: current locale -> en -> pt-BR -> key. `{name}` placeholders are interpolated.
 */
export function createI18n<K extends string>(dicts: { "pt-BR": Record<K, string>; en: Partial<Record<K, string>>; "zh-CN"?: Record<K, string> }) {
  const defaultLocale: Locale = dicts["zh-CN"] ? "zh-CN" : "pt-BR";
  interface Ctx {
    locale: Locale;
    setLocale: (l: Locale) => void;
    t: (key: K, vars?: Vars) => string;
  }

  const translate = (locale: Locale, key: K, vars?: Vars): string => {
    const table: Partial<Record<K, string>> = dicts[locale] ?? {};
    let s = table[key] ?? dicts.en[key] ?? dicts["pt-BR"][key] ?? key;
    if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{${k}}`, String(v));
    return s;
  };

  const I18nContext = createContext<Ctx>({
    locale: defaultLocale,
    setLocale: () => {},
    t: (key, vars) => translate(defaultLocale, key, vars),
  });

  function I18nProvider({ children, defaultLocale: initialLocale = defaultLocale }: { children: ReactNode; defaultLocale?: Locale }) {
    const [locale, setLocaleState] = useState<Locale>(() => readStoredLocale(initialLocale));
    const setLocale = useCallback((l: Locale) => {
      setLocaleState(l);
      try {
        localStorage.setItem(STORAGE_KEY, l);
      } catch {
        /* storage unavailable */
      }
    }, []);
    useEffect(() => { document.documentElement.lang = locale; }, [locale]);
    const value = useMemo<Ctx>(
      () => ({ locale, setLocale, t: (k: K, v?: Vars) => translate(locale, k, v) }),
      [locale, setLocale],
    );
    return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
  }

  const useI18n = () => useContext(I18nContext);
  return { I18nProvider, useI18n, translate };
}

/** Compact Chinese / PT-BR / EN switch. */
export function LocaleToggle({ locale, onChange }: { locale: Locale; onChange: (l: Locale) => void }) {
  return (
    <div className="inline-flex rounded-lg border border-line p-0.5 text-xs font-semibold" role="group" aria-label="语言 / Language / Idioma">
      {(["zh-CN", "pt-BR", "en"] as const).map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={locale === l}
          onClick={() => onChange(l)}
          className={
            "rounded-md px-2 py-1 transition-colors " +
            (locale === l ? "bg-panel-2 text-ink" : "text-muted hover:text-ink")
          }
        >
          {l === "zh-CN" ? "中文" : l === "pt-BR" ? "PT" : "EN"}
        </button>
      ))}
    </div>
  );
}
