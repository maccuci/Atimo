import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { RefObject } from "react";

/*
 * Drives the `.edge-fade` mask from a scroll container's real overflow state.
 *
 * The whole job is answering "is there content past this edge" at the right
 * moment. Answering it a frame late is the failure mode worth designing around:
 * a fade left over an edge that no longer overflows is a promise of more content
 * that does not exist, and it survives until something else happens to repaint.
 *
 * So the read happens in a layout effect, before paint, after every render —
 * because a render is exactly how a content change reaches us. Archiving the row
 * that made a list scrollable, switching to a shorter chat, and collapsing a
 * section all arrive that way, and all of them would otherwise leave a phantom
 * fade over a list that fits.
 */

/** Ramp height, px. Deep enough to read as a fade rather than a soft edge. */
export const EDGE_FADE_BAND = 32;

export interface EdgeFadeOptions {
  /** Ramp at the top edge. */
  top?: number;
  /** Ramp at the bottom edge. Separate from `top` for containers whose two
   *  edges meet different chrome — one sliding under a header needs a band as
   *  deep as the header, while its other edge only needs the default hint. */
  bottom?: number;
}

/**
 * Sub-pixel slack. Fractional row heights and fractional zoom both produce a
 * `scrollHeight` a hair past `clientHeight` on a container nothing can scroll,
 * and a strict compare would fade an edge that cannot move.
 */
const EPSILON = 1;

export function useEdgeFade(
  ref: RefObject<HTMLElement | null>,
  { top = EDGE_FADE_BAND, bottom = EDGE_FADE_BAND }: EdgeFadeOptions = {},
): void {
  // Read through a ref so changing a band does not tear down the listeners.
  const bandsRef = useRef({ top, bottom });
  bandsRef.current = { top, bottom };

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;

    const max = el.scrollHeight - el.clientHeight;
    const scrollable = max > EPSILON;
    const atTop = !scrollable || el.scrollTop <= EPSILON;
    const atBottom = !scrollable || el.scrollTop >= max - EPSILON;

    const { top: topBand, bottom: bottomBand } = bandsRef.current;
    el.style.setProperty("--edge-fade-top", atTop ? "0px" : `${topBand}px`);
    el.style.setProperty(
      "--edge-fade-bottom",
      atBottom ? "0px" : `${bottomBand}px`,
    );
  }, [ref]);

  // Scrolling and resizing happen without React hearing about them.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    el.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(el);

    return () => {
      el.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, [ref, update]);

  // No dependency array on purpose — see the note at the top of the file.
  useLayoutEffect(update);
}
