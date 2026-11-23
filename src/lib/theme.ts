/**
 * The app theme: a preference, so it lives in localStorage like effort and
 * reasoning. Palettes are CSS blocks in `theme-t3.css` keyed on `data-theme`;
 * this module only picks which one the document wears.
 */

export type ThemeId =
  | "system"
  | "dark"
  | "light"
  | "nord"
  | "dracula"
  | "mocha"
  | "tokyo"
  | "gruvbox"
  | "rose-pine"
  | "solarized-light"
  | "latte";

/*
 * Names are Atimo's own; `inspired` credits the palette each one adapts.
 */
export const THEMES: readonly {
  id: ThemeId;
  label: string;
  tone: "dark" | "light" | "system";
  inspired?: string;
}[] = [
  { id: "system", label: "Sistema", tone: "system" },
  { id: "dark", label: "Noite", tone: "dark" },
  { id: "light", label: "Dia", tone: "light" },
  { id: "nord", label: "Fiorde", tone: "dark", inspired: "Nord" },
  { id: "dracula", label: "Ametista", tone: "dark", inspired: "Dracula" },
  { id: "mocha", label: "Lavanda", tone: "dark", inspired: "Catppuccin Mocha" },
  { id: "tokyo", label: "Neon", tone: "dark", inspired: "Tokyo Night" },
  { id: "gruvbox", label: "Terra", tone: "dark", inspired: "Gruvbox" },
  { id: "rose-pine", label: "Crepúsculo", tone: "dark", inspired: "Rosé Pine" },
  { id: "solarized-light", label: "Areia", tone: "light", inspired: "Solarized" },
  { id: "latte", label: "Algodão", tone: "light", inspired: "Catppuccin Latte" },
];

const STORAGE_KEY = "atimo.theme.v1";

function isTheme(value: unknown): value is ThemeId {
  return THEMES.some((t) => t.id === value);
}

export function readTheme(): ThemeId {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return isTheme(value) ? value : "dark";
  } catch {
    return "dark";
  }
}

export function writeTheme(value: ThemeId): void {
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* private mode: the choice lasts this session */
  }
}

const darkQuery = () =>
  typeof matchMedia === "function" ? matchMedia("(prefers-color-scheme: dark)") : null;

/** "system" resolved against the OS right now. */
export function resolveTheme(theme: ThemeId): Exclude<ThemeId, "system"> {
  if (theme !== "system") return theme;
  return darkQuery()?.matches === false ? "light" : "dark";
}

export function isDarkTheme(theme: ThemeId): boolean {
  const resolved = resolveTheme(theme);
  return THEMES.find((t) => t.id === resolved)?.tone === "dark";
}

/**
 * Put the theme on the document, and keep following the OS while it is
 * "system". Returns the unsubscribe for that listener.
 */
export function applyTheme(theme: ThemeId): () => void {
  const set = () => {
    document.documentElement.dataset.theme = resolveTheme(theme);
    // The native blur picks light or dark material from the window theme.
    if (isMacDesktop()) void syncWindowTheme(isDarkTheme(theme));
  };
  set();
  const query = theme === "system" ? darkQuery() : null;
  query?.addEventListener("change", set);
  return () => query?.removeEventListener("change", set);
}

/* ---------------------------------------------------------------------- */
/* Accent, font and text size: inline overrides on <html>, so they sit on   */
/* top of whichever palette is active.                                      */
/* ---------------------------------------------------------------------- */

export type AccentId = "theme" | "indigo" | "blue" | "teal" | "green" | "orange" | "rose" | "violet";
export type FontId = "system" | "inter" | "rounded" | "serif" | "mono";

export interface Appearance {
  accent: AccentId;
  font: FontId;
  /** Page zoom: 1 is the design size. */
  scale: number;
  /** macOS only: the window shows the desktop through a native blur. */
  glass: boolean;
  /** How much shows through, 0–100. */
  glassIntensity: number;
}

/** Each is dark enough to carry white text, like the palettes' own accents. */
export const ACCENTS: readonly { id: AccentId; label: string; color: string | null }[] = [
  { id: "theme", label: "Do tema", color: null },
  { id: "indigo", label: "Índigo", color: "#4f46e5" },
  { id: "blue", label: "Azul", color: "#2563eb" },
  { id: "teal", label: "Petróleo", color: "#0f766e" },
  { id: "green", label: "Verde", color: "#15803d" },
  { id: "orange", label: "Laranja", color: "#c2410c" },
  { id: "rose", label: "Rosa", color: "#e11d48" },
  { id: "violet", label: "Violeta", color: "#7c3aed" },
];

export const FONTS: readonly { id: FontId; label: string; stack: string | null }[] = [
  { id: "system", label: "Sistema", stack: null },
  { id: "inter", label: "Inter", stack: '"Inter Variable", "Inter", system-ui, sans-serif' },
  { id: "rounded", label: "Arredondada", stack: 'ui-rounded, "SF Pro Rounded", "Nunito", system-ui, sans-serif' },
  { id: "serif", label: "Serifada", stack: 'ui-serif, "New York", "Iowan Old Style", Georgia, serif' },
  { id: "mono", label: "Mono", stack: 'ui-monospace, "SF Mono", "JetBrains Mono", Menlo, monospace' },
];

export const SCALE_MIN = 0.85;
export const SCALE_MAX = 1.25;
export const GLASS_MIN = 10;
export const GLASS_MAX = 100;
export const DEFAULT_APPEARANCE: Appearance = {
  accent: "theme",
  font: "system",
  scale: 1,
  glass: false,
  glassIntensity: 40,
};

const APPEARANCE_KEY = "atimo.appearance.v1";

export function readAppearance(): Appearance {
  try {
    const raw = JSON.parse(localStorage.getItem(APPEARANCE_KEY) ?? "null") as Partial<Appearance> | null;
    const accent = ACCENTS.some((a) => a.id === raw?.accent) ? raw!.accent! : DEFAULT_APPEARANCE.accent;
    const font = FONTS.some((f) => f.id === raw?.font) ? raw!.font! : DEFAULT_APPEARANCE.font;
    const scale =
      typeof raw?.scale === "number" && raw.scale >= SCALE_MIN && raw.scale <= SCALE_MAX
        ? raw.scale
        : DEFAULT_APPEARANCE.scale;
    const glass = raw?.glass === true;
    const glassIntensity =
      typeof raw?.glassIntensity === "number" && raw.glassIntensity >= GLASS_MIN && raw.glassIntensity <= GLASS_MAX
        ? raw.glassIntensity
        : DEFAULT_APPEARANCE.glassIntensity;
    return { accent, font, scale, glass, glassIntensity };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

export function writeAppearance(value: Appearance): void {
  try {
    localStorage.setItem(APPEARANCE_KEY, JSON.stringify(value));
  } catch {
    /* private mode: the choice lasts this session */
  }
}

export function applyAppearance({ accent, font, scale, glass, glassIntensity }: Appearance): void {
  const root = document.documentElement.style;
  const color = ACCENTS.find((a) => a.id === accent)?.color ?? null;
  if (color) {
    root.setProperty("--accent", color);
    root.setProperty("--accent-hover", `color-mix(in srgb, ${color} 85%, white)`);
  } else {
    root.removeProperty("--accent");
    root.removeProperty("--accent-hover");
  }
  const stack = FONTS.find((f) => f.id === font)?.stack ?? null;
  if (stack) root.setProperty("--font-ui", stack);
  else root.removeProperty("--font-ui");
  void applyScale(scale);
  applyGlass(glass, glassIntensity);
}

/* ---------------------------------------------------------------------- */
/* Glass: native macOS vibrancy behind a translucent tint.                  */
/* ---------------------------------------------------------------------- */

export function isMacDesktop(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window &&
    /Mac/i.test(navigator.userAgent)
  );
}

/*
 * The window is transparent and macOS draws its sidebar material behind the
 * webview; CSS then paints each surface with a tint of its own colour. The
 * intensity only thins that tint, so text keeps the palette's contrast. The
 * sidebar thins faster than the content, as in Finder or Notes.
 */
function applyGlass(on: boolean, intensity: number): void {
  const root = document.documentElement;
  const enabled = on && isMacDesktop();
  if (enabled) {
    root.dataset.glass = "";
    root.style.setProperty("--glass-tint", `${Math.round(100 - intensity * 0.6)}%`);
    root.style.setProperty("--glass-tint-sidebar", `${Math.round(100 - intensity * 0.85)}%`);
  } else {
    delete root.dataset.glass;
    root.style.removeProperty("--glass-tint");
    root.style.removeProperty("--glass-tint-sidebar");
  }
  if (isMacDesktop()) void setWindowGlass(enabled);
}

let glassApplied: boolean | null = null;

async function setWindowGlass(on: boolean): Promise<void> {
  // The slider calls this on every step; only the on/off edge reaches native.
  if (glassApplied === on) return;
  glassApplied = on;
  try {
    const { getCurrentWindow, Effect, EffectState } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    if (on) {
      await win.setEffects({ effects: [Effect.Sidebar], state: EffectState.FollowsWindowActiveState });
    } else {
      await win.clearEffects();
    }
  } catch {
    glassApplied = null; // not fatal: the CSS tint stays opaque enough to read
  }
}

async function syncWindowTheme(dark: boolean): Promise<void> {
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(dark ? "dark" : "light");
  } catch {
    /* the window keeps its configured theme */
  }
}

/*
 * The desktop app zooms the webview itself (the same thing ⌘+ does in a
 * browser), so every hardcoded pixel size and every anchored menu scales
 * together. The browser build falls back to CSS `zoom`.
 */
async function applyScale(scale: number): Promise<void> {
  if (typeof window !== "undefined" && "__TAURI_INTERNALS__" in window) {
    try {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview");
      await getCurrentWebview().setZoom(scale);
      return;
    } catch {
      /* fall through to CSS */
    }
  }
  document.documentElement.style.setProperty("zoom", scale === 1 ? "" : String(scale));
}
