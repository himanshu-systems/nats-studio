import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { ipc, ThemePreference } from "@bindings";

type Resolved = "light" | "dark";

interface ThemeContextValue {
  /** The user's preference (may be "system"). */
  pref: ThemePreference;
  /** The concrete theme currently applied. */
  resolved: Resolved;
  setPref: (pref: ThemePreference) => void;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);
const STORAGE_KEY = "theme";

function systemPrefersDark(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches;
}

function resolve(pref: ThemePreference): Resolved {
  if (pref === ThemePreference.System) return systemPrefersDark() ? "dark" : "light";
  return pref === ThemePreference.Dark ? "dark" : "light";
}

function apply(resolved: Resolved): void {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

function readStored(): ThemePreference {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw as ThemePreference;
  return ThemePreference.System;
}

/**
 * Theme provider: resolves light/dark from the user preference (or the OS when
 * "system"), applies it to <html>, mirrors it to localStorage for a flash-free
 * boot, and persists the choice to backend Settings so it survives reinstalls.
 */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const [pref, setPrefState] = useState<ThemePreference>(() => readStored());
  const [resolved, setResolved] = useState<Resolved>(() => resolve(readStored()));

  // Apply on preference change; follow the OS while on "system".
  useEffect(() => {
    const next = resolve(pref);
    setResolved(next);
    apply(next);
    localStorage.setItem(STORAGE_KEY, pref);

    if (pref !== ThemePreference.System) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = (): void => {
      const r: Resolved = mq.matches ? "dark" : "light";
      setResolved(r);
      apply(r);
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [pref]);

  // Hydrate the persisted preference from backend Settings once.
  useEffect(() => {
    void ipc.settings
      .get()
      .then((s) => {
        if (s.theme && s.theme !== pref) setPrefState(s.theme);
      })
      .catch(() => {
        /* settings unavailable — keep local preference */
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setPref = (next: ThemePreference): void => {
    setPrefState(next);
    void ipc.settings
      .get()
      .then((s) => ipc.settings.update({ ...s, theme: next }))
      .catch(() => {
        /* best-effort persistence */
      });
  };

  const toggle = (): void =>
    setPref(resolved === "dark" ? ThemePreference.Light : ThemePreference.Dark);

  return (
    <ThemeContext.Provider value={{ pref, resolved, setPref, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used within a ThemeProvider");
  return ctx;
}
