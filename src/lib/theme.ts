import type { BoardTheme } from "@/lib/jev/types";

export const THEME_STORAGE_KEY = "skot_theme";
export const DEFAULT_THEME: BoardTheme = "midnight";
export const DARK_CLASS = "dark";

export type StoredTheme = "light" | "dark";

export function resolveTheme(saved: string | null | undefined): BoardTheme {
  if (saved === "light") return "vellum";
  if (saved === "dark") return "midnight";
  return DEFAULT_THEME;
}

export function storedThemeFor(theme: BoardTheme): StoredTheme {
  return theme === "vellum" ? "light" : "dark";
}

const KEY = JSON.stringify(THEME_STORAGE_KEY);
const CLASS = JSON.stringify(DARK_CLASS);

export const THEME_BOOT_SCRIPT =
  `(function(){var c=document.documentElement.classList;` +
  `try{if(localStorage.getItem(${KEY})==="light"){c.remove(${CLASS});return}}catch(e){}` +
  `c.add(${CLASS})})()`;
