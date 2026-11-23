import { useLayoutEffect, useRef, type RefObject } from "react";
import { useReducedMotion } from "motion/react";

/*
 * Resort glide.
 *
 * A list whose order carries meaning — recents sorted by last activity — is
 * telling the user something every time it reorders. Repainted in place, that
 * message is lost: the row that just moved to the top looks identical to a row
 * that was always there, and the only way to notice the change is to have been
 * reading the list at the moment it happened. Sliding the survivors from where
 * they were to where they now are makes the reorder the visible event.
 *
 * The technique is FLIP: layout has *already* settled at the new positions when
 * this runs, so nothing here moves anything. It measures the delta against the
 * previous settled positions and paints each row back at its old offset, then
 * animates that offset away. Because the offset is a transform, no sibling is
 * disturbed and no layout is recomputed for the 260ms it lasts.
 *
 * Rows that are new fade in instead — they have no old position to come from,
 * and sliding them from an invented one would claim a history they don't have.
 * Removals just go. First fill never animates: there is no "before" for a list
 * the user is seeing for the first time.
 */

/** Marks our own animations so a resort mid-flight can cancel only those. */
const RESORT_ID = "flip-resort";
const ENTER_ID = "flip-enter";

/** Sub-pixel deltas are layout noise, not movement. */
const MIN_OFFSET_PX = 0.5;

const FALLBACK_RESORT_MS = 260;
const FALLBACK_ENTER_MS = 150;
const FALLBACK_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/**
 * How far each surviving key has to travel back to look unmoved: its previous
 * top minus its current one. Keys absent from `prev` are new and get no offset;
 * keys absent from `next` are gone and are not our problem.
 */
export function resortOffsets(
  prev: ReadonlyMap<string, number>,
  next: ReadonlyMap<string, number>,
): Map<string, number> {
  const offsets = new Map<string, number>();
  for (const [key, top] of next) {
    const before = prev.get(key);
    if (before === undefined) continue;
    const dy = before - top;
    if (Math.abs(dy) >= MIN_OFFSET_PX) offsets.set(key, dy);
  }
  return offsets;
}

/**
 * Read a duration token as milliseconds. Going through the CSS variable rather
 * than hardcoding 260 keeps the timing in one vocabulary — including the
 * `--motion-scale` debug knob, which would otherwise slow every transition in
 * the app except this one, making the comparison it exists for useless.
 */
function durationMs(name: string, fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  if (raw.endsWith("ms")) {
    const ms = Number.parseFloat(raw);
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (raw.endsWith("s")) {
    const s = Number.parseFloat(raw);
    return Number.isFinite(s) ? s * 1000 : fallback;
  }
  return fallback;
}

function easing(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return raw || fallback;
}

/**
 * Glide `container`'s direct children when their order changes.
 *
 * `keys` must be the rendered rows in order, one per direct child. When the two
 * disagree the hook measures nothing and forgets what it knew: a child that is
 * not a keyed row — an empty-state button standing in for the list — would slide
 * every measurement onto the wrong key and animate rows to positions that were
 * never theirs.
 *
 * `resetKey` re-baselines without animating. Pass whatever changes the rows'
 * geometry for reasons that are not a reorder; the sidebar passes its expanded
 * state, because collapsing to the icon strip moves every row at once and
 * gliding them there would animate the layout change twice — once by the rail's
 * own width transition, and once here, in disagreement with it.
 */
export function useFlipResort(
  containerRef: RefObject<HTMLElement | null>,
  keys: readonly string[],
  resetKey?: string | number | boolean,
): void {
  const prevRef = useRef<Map<string, number>>(new Map());
  const resetRef = useRef(resetKey);
  const reduceMotion = useReducedMotion();

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) {
      prevRef.current = new Map();
      return;
    }

    const rows = Array.from(container.children).filter(
      (node): node is HTMLElement => node instanceof HTMLElement,
    );
    if (rows.length !== keys.length) {
      prevRef.current = new Map();
      return;
    }

    // An animation still running has the row painted away from where layout
    // put it, and `getBoundingClientRect` reports the painted box. Cancelling
    // first is what makes a resort interrupting a resort measure the truth.
    for (const row of rows) {
      for (const animation of row.getAnimations()) {
        if (animation.id === RESORT_ID || animation.id === ENTER_ID) {
          animation.cancel();
        }
      }
    }

    // Measured against the container, so a scroll between renders — which moves
    // every row by the same amount and means nothing — reads as no movement.
    const origin = container.getBoundingClientRect().top;
    const next = new Map<string, number>();
    rows.forEach((row, i) => {
      next.set(keys[i]!, row.getBoundingClientRect().top - origin);
    });

    const prev = prevRef.current;
    const wasReset = resetRef.current !== resetKey;
    resetRef.current = resetKey;
    prevRef.current = next;

    if (prev.size === 0 || wasReset || reduceMotion) return;

    const offsets = resortOffsets(prev, next);
    if (offsets.size === 0 && rows.every((_, i) => prev.has(keys[i]!))) return;

    const glide = {
      duration: durationMs("--dur-resort", FALLBACK_RESORT_MS),
      easing: easing("--ease-resort", FALLBACK_EASING),
      id: RESORT_ID,
    };
    const enter = {
      duration: durationMs("--dur-quick", FALLBACK_ENTER_MS),
      easing: easing("--ease-out", FALLBACK_EASING),
      id: ENTER_ID,
    };

    rows.forEach((row, i) => {
      const key = keys[i]!;
      const dy = offsets.get(key);
      if (dy !== undefined) {
        row.animate(
          [
            { transform: `translateY(${dy}px)` },
            { transform: "translateY(0px)" },
          ],
          glide,
        );
      } else if (!prev.has(key)) {
        row.animate([{ opacity: 0 }, { opacity: 1 }], enter);
      }
    });
  });
}
