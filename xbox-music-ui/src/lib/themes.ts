// src/lib/themes.ts

export type ThemeName = "classic" | "ocean" | "sunset" | "violet" | "pink" | "blue" | "redblack";
export type ThemeMode = "color" | "rainbow";

/** Ordre des thèmes pour le bouton 'Couleurs' */
export const THEME_ORDER: ThemeName[] = ["classic", "ocean", "sunset", "violet", "pink", "blue", "redblack"];

/** Définitions des couleurs et labels */
export const THEMES_SWATCH: Record<ThemeName, { c1: string; c2: string; label: string }> = {
  classic: { c1: "#60a5fa", c2: "#f472b6", label: "Classic" },
  ocean: { c1: "#22d3ee", c2: "#34d399", label: "Ocean" },
  sunset: { c1: "#f59e0b", c2: "#f472b6", label: "Sunset" },
  violet: { c1: "#a78bfa", c2: "#f472b6", label: "Violet" },
  pink: { c1: "#f472b6", c2: "#e879f9", label: "Pink" },
  blue: { c1: "#3b82f6", c2: "#22d3ee", label: "Blue" },
  redblack: { c1: "#ef4444", c2: "#4b1616", label: "RedBlack" }, // Rouge 500 / Orange 500
};