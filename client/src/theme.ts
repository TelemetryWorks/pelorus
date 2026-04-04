// ---------------------------------------------------------------------------
// Pelorus — Theme manager
// ---------------------------------------------------------------------------

export type Theme = "dark" | "light";

const DARK: Record<string, string> = {
  "--bg":         "#0a0a0f",
  "--surface":    "#12121a",
  "--border":     "#1e1e2e",
  "--text":       "#c8c8d4",
  "--text-dim":   "#5a5a6e",
  "--accent":     "#4a9eff",
  "--ok":         "#2ecc71",
  "--err":        "#e74c3c",
  "--warn":       "#f39c12",
  "--cat-alpha":  "#4a9eff",
  "--cat-bravo":  "#e94560",
  "--cat-charlie":"#2ecc71",
  "--cat-delta":  "#f39c12",
};

const LIGHT: Record<string, string> = {
  "--bg":         "#f4f4f8",
  "--surface":    "#ffffff",
  "--border":     "#d8d8e4",
  "--text":       "#1a1a2e",
  "--text-dim":   "#6a6a7e",
  "--accent":     "#2563eb",
  "--ok":         "#16a34a",
  "--err":        "#dc2626",
  "--warn":       "#d97706",
  "--cat-alpha":  "#2563eb",
  "--cat-bravo":  "#dc2626",
  "--cat-charlie":"#16a34a",
  "--cat-delta":  "#d97706",
};

let current: Theme = "dark";

export function getTheme(): Theme {
  return current;
}

export function setTheme(theme: Theme): void {
  current = theme;
  const vars = theme === "dark" ? DARK : LIGHT;
  const root = document.documentElement;
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value);
  }
  // Persist preference
  try { localStorage.setItem("pelorus-theme", theme); } catch {}
}

export function toggleTheme(): Theme {
  const next = current === "dark" ? "light" : "dark";
  setTheme(next);
  return next;
}

export function initTheme(): void {
  let saved: string | null = null;
  try { saved = localStorage.getItem("pelorus-theme"); } catch {}
  if (saved === "light" || saved === "dark") {
    setTheme(saved);
  } else {
    setTheme("dark");
  }
}
