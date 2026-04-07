/**
 * Dark mode hook. Reads/writes a "dark" class on <html>.
 * Persists preference in localStorage.
 */
import { useState, useEffect } from "react";

const KEY = "usms_dark_mode";

export function useIsDark() {
  const [isDark, setIsDark] = useState<boolean>(() => {
    const saved = localStorage.getItem(KEY);
    if (saved !== null) return saved === "true";
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
    localStorage.setItem(KEY, String(isDark));
  }, [isDark]);

  const toggle = () => setIsDark((d) => !d);

  return { isDark, toggle };
}
