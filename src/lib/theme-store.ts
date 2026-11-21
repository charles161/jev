import { useLayoutEffect, useSyncExternalStore } from "react";
import type { BoardTheme } from "@/lib/jev/types";
import { DARK_CLASS, DEFAULT_THEME, THEME_STORAGE_KEY, resolveTheme, storedThemeFor } from "@/lib/theme";

let sessionChoice: BoardTheme | null = null;
const listeners = new Set<() => void>();

export function readBoardTheme(): BoardTheme {
  if (sessionChoice) return sessionChoice;
  try {
    return resolveTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return DEFAULT_THEME;
  }
}

function applyBoardTheme(theme: BoardTheme): void {
  document.documentElement.classList.toggle(DARK_CLASS, theme === "midnight");
}

export function setBoardTheme(theme: BoardTheme): void {
  sessionChoice = theme;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, storedThemeFor(theme));
  } catch {}
  applyBoardTheme(theme);
  listeners.forEach((listener) => listener());
}

export function subscribeBoardTheme(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function useBoardTheme(): [BoardTheme, (theme: BoardTheme) => void] {
  const theme = useSyncExternalStore(subscribeBoardTheme, readBoardTheme, () => DEFAULT_THEME);
  useLayoutEffect(() => {
    applyBoardTheme(readBoardTheme());
  }, [theme]);
  return [theme, setBoardTheme];
}
