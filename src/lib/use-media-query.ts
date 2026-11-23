import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query. Returns `false` during SSR / first paint
 * when `window` is unavailable, then syncs on mount.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Narrow shell — drawer nav, compact chrome. Aligns with Tailwind `md`. */
export function useIsMobile(): boolean {
  return useMediaQuery("(max-width: 767px)");
}

/** Coarse pointer (touch) — show hover-gated affordances permanently. */
export function useIsCoarsePointer(): boolean {
  return useMediaQuery("(hover: none), (pointer: coarse)");
}

/** Tauri injects this before app code; used for traffic-light titlebar inset. */
export function isDesktopShell(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}
