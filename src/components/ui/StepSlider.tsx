import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  animate,
  useMotionValue,
  useMotionTemplate,
  useReducedMotion,
  useSpring,
  useTransform,
  motion,
  type AnimationPlaybackControls,
} from "motion/react";
import { cn } from "@/lib/utils";

/*
 * A range slider over a small, ordered set of named steps.
 *
 * The interaction it copies is the one that makes a stepped slider feel like an
 * object rather than a radio group: the thumb tracks the pointer *continuously*
 * while you drag — it does not jump between notches under your finger — and
 * only settles onto the nearest step when you let go. The value, meanwhile,
 * commits on crossing, so the label above reads the step you are over rather
 * than lagging until release. Those two rates are the whole trick; pinning the
 * thumb to notches during the drag is what makes most stepped sliders feel
 * cheap, and springing the value instead of the thumb makes them feel laggy.
 *
 * Geometry is measured rather than expressed in percentages because the drag
 * math needs pixels anyway, and deriving both from one measurement is what
 * keeps the fill edge welded to the thumb centre at every frame.
 */

/** Set here rather than in a class, because the cell grid has to do arithmetic on it. */
const TRACK_H = 32;
/** Thumb is a bar, not a knob — narrow enough that the notch it covers is the one it is on. */
const THUMB_W = 5;
/** Keeps the thumb fully inside the track at both extremes. */
const PAD = THUMB_W / 2 + 5;

/** Settling onto a notch. Bounce, because a released thumb *did* arrive with momentum. */
const SETTLE = { type: "spring", stiffness: 620, damping: 34, mass: 0.7 } as const;
/** Arriving from a click or a keypress — no momentum to honour, so no overshoot. */
const JUMP = { type: "spring", bounce: 0, duration: 0.34 } as const;

/* ---- the tail ----------------------------------------------------------- */

/*
 * The thumb's wake.
 *
 * It hangs off the thumb rather than flying its own route across the track. An
 * earlier version sent a comet looping past on a timer, and the screenshot of
 * it explained the problem better than any amount of tuning could: two things
 * were moving to two different rhythms, and neither belonged to the other. A
 * wake is not a decoration that happens near the handle. It is the handle's,
 * and it only exists because the handle went somewhere.
 */

/** Cell size and spacing. 1px of air: dense enough to read as texture, not as tiles. */
const CELL = 3;
const PITCH = 4;
/** Tighter than the thumb's margin — an extra row of pixels beats an extra row of air. */
const FIELD_INSET = 2;

/** Columns of wake at full reach. Shorter levels show a prefix of this. */
const TRAIL_COLS = 38;
/** Leading columns drawn solid — the wake meets the thumb as a body, not a sprinkle. */
const HEAD_COLS = 4;
/** Fast's streak — same cells, further and sooner. Mirrors `tail-ember-fast`. */
const DRIFT_FAST = 24;

/** The wake's own box, sized for the longer streak so Fast does not resize the mask. */
const TRAIL_PX = TRAIL_COLS * PITCH + THUMB_W + CELL + DRIFT_FAST;
/** Softness on the cut end, so the wake stops being rather than stopping dead. */
const CUT_FADE = 26;

/** One ember's life: lit, carried backwards, spent. */
const EMBER_MS = 1500;
/** Shorter life, same cells — Fast is throughput, so the shed has to move like it. */
const EMBER_FAST_MS = 720;

/**
 * How the wake extends and retracts between levels.
 *
 * Springs rather than a duration because this is the one place the control
 * makes a claim about magnitude — Max costs more than High — and a length that
 * snapped between two values would state that as a fact instead of showing it.
 */
const REACH = { stiffness: 520, damping: 40, mass: 0.7 } as const;

/**
 * How far the tail lags the thumb, as a spring. Loose enough that a fast drag
 * visibly stretches it and it gathers back in on the settle — the wake's whole
 * claim is that motion costs something, so it cannot be rigidly welded on.
 */
const LAG = { stiffness: 300, damping: 32, mass: 0.9 } as const;

/**
 * Deterministic value in [0,1) for a cell. A real hash, not `Math.random`, so
 * the pattern is stable across renders — a wake that reshuffled itself on
 * every drag frame would read as noise, not as texture.
 */
function hash(c: number, r: number): number {
  const n = Math.sin(c * 12.9898 + r * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

export function StepSlider({
  steps,
  index,
  onIndexChange,
  label,
  intensityFrom,
  boosted,
  className,
}: {
  /** Ordered, low to high. At least two. */
  steps: readonly string[];
  index: number;
  onIndexChange: (index: number) => void;
  /** Accessible name — the control renders no label of its own. */
  label: string;
  /**
   * Index from which the thumb grows a wake, in the same pixel idiom as the
   * thinking loader.
   *
   * A threshold rather than a flag, because the wake says something specific:
   * that from here on the scale buys depth with time. Below the threshold it
   * is not dimmed, it is absent — a faint version would still be making the
   * claim, only quietly.
   */
  intensityFrom?: number;
  /**
   * A second claim stacked on the scale. The wake does not grow a badge —
   * it changes how it moves: shorter life, longer streak, a faster rise.
   * Fast, in the one place this ships.
   */
  boosted?: boolean;
  className?: string;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const reduceMotion = !!useReducedMotion();

  const [width, setWidth] = useState(0);
  const [dragging, setDragging] = useState(false);

  const last = steps.length - 1;
  const travel = Math.max(width - PAD * 2, 0);

  /*
   * How much wake this level has earned, in [0,1].
   *
   * The threshold level itself gets a share rather than nothing, so crossing
   * into it reads as the wake *appearing* at a length; the top level gets all
   * of it. With High/Max that is a half-length wake and a full one — the
   * difference the setting is actually asking you to weigh.
   */
  const reachFor =
    intensityFrom == null || index < intensityFrom
      ? 0
      : (index - intensityFrom + 1) / (last - intensityFrom + 1);

  /* Thumb centre, in px from the track's left edge. The single source of truth
     for the thumb, the fill, and the tail, so none of them can drift apart. */
  const x = useMotionValue(PAD);
  const fillW = useMotionTemplate`${x}px`;

  /*
   * The tail's own anchor: `x` chased by a softer spring, then clamped so it
   * can never overtake the thumb. Dragging toward the high end stretches the
   * wake out behind; dragging back leaves it gathered at the thumb instead of
   * poking out in front, which is the one thing a wake must never do.
   */
  const lagged = useSpring(x, LAG);
  const tailX = useTransform<number, number>(
    [x, lagged],
    ([head, behind]: number[]) => Math.min(head, behind),
  );

  /*
   * Reach is animated, never assigned. Dropping from Max to High has to look
   * like the wake being *pulled in* — the far end retreating toward the thumb —
   * because that is the same fact the extension stated on the way up. Swapping
   * one length for another, or fading the whole thing out and a shorter one
   * back in, throws away the only part that carries meaning.
   */
  const reachRaw = useMotionValue(reachFor);
  const reach = useSpring(reachRaw, REACH);
  useEffect(() => {
    reachRaw.set(reachFor);
  }, [reachFor, reachRaw]);

  /* The cut eats in from the far end, so the wake shortens from the tail and
     stays welded to the thumb — a wake that shrank from both ends would read
     as a bar being scaled, not as something being reeled in. */
  const cut = useTransform(reach, (r) => TRAIL_PX * (1 - r));
  const cutEnd = useTransform(reach, (r) => TRAIL_PX * (1 - r) + CUT_FADE);
  const tailMask = useMotionTemplate`linear-gradient(to right, transparent ${cut}px, #000 ${cutEnd}px)`;
  /* A short wake is a quieter one too, not merely a clipped one. */
  const tailOpacity = useTransform(reach, [0, 0.4, 1], [0, 0.72, 1]);

  /* The pointer owns the thumb for the whole gesture, including the settle it
     hands off to on release. Kept in a ref rather than read off `dragging`
     because the follow-the-value effect below has to consult it during the
     same commit that clears the drag — a state read there would be a frame
     stale, and the effect would restart the settle it is meant to leave alone. */
  const held = useRef(false);

  /* One in-flight animation at a time: a click landing mid-settle has to cancel
     the settle, not race it. */
  const anim = useRef<AnimationPlaybackControls | null>(null);
  const stop = () => {
    anim.current?.stop();
    anim.current = null;
  };

  const at = useCallback(
    (i: number) => PAD + (last > 0 ? (i / last) * travel : 0),
    [last, travel],
  );

  /*
   * The wake, in its own coordinates: the head sits at x = 0 and the body runs
   * backwards into negative x. Built once, never per drag frame — the whole
   * set is parented to one element that carries `tailX`, which is what makes
   * it one object trailing the thumb instead of a queue of cells taking turns.
   */
  const tail = useMemo(() => {
    if (intensityFrom == null) return [];

    const rows = Math.max(Math.floor((TRACK_H - FIELD_INSET * 2) / PITCH), 1);
    // Rounded: a 3px square on a half-pixel is a blurry 4px smear, and at this
    // size that is the difference between a grid and a haze.
    const top = Math.round(
      FIELD_INSET +
        (TRACK_H - FIELD_INSET * 2 - (rows * PITCH - (PITCH - CELL))) / 2,
    );
    const mid = (rows - 1) / 2;

    const out: {
      key: string;
      right: number;
      top: number;
      opacity: number;
      delay: number;
    }[] = [];

    for (let c = 0; c < TRAIL_COLS; c++) {
      const t = c / (TRAIL_COLS - 1);
      // Dense at the thumb, thinning backwards…
      const density = Math.pow(1 - t, 0.85);
      // …and flaring: tight at the head, most of the height by the tail. A
      // wake of constant thickness reads as a bar, not as something shed.
      const spread = 2.3 + t * 2.0;

      for (let r = 0; r < rows; r++) {
        const dy = Math.abs(r - mid);
        /* Gaussian across the wake's axis. A hard `dy > spread` cut starved the
           columns just behind the head, which put a gap in exactly the place
           this is densest. */
        const p = Math.min(1, 1.55 * density * Math.exp(-Math.pow(dy / spread, 2)));

        if (c < HEAD_COLS) {
          // The head is drawn, not diced — dithering it leaves holes in the
          // one part that touches the thumb.
          if (p < 0.34) continue;
        } else if (hash(c + 7, r + 3) > p) {
          continue;
        }

        out.push({
          key: `${c}-${r}`,
          /* Anchored to the box's right edge — which is the thumb — so the
             wake stays pinned to the handle while the cut trims the far end.
             Clear of the thumb's own width, so the two read as joined rather
             than as the thumb sitting on top of its own texture. */
          right: c * PITCH + THUMB_W,
          top: top + r * PITCH,
          opacity: Math.max(0.12, Math.pow(1 - t, 1.1)),
          // Spread across the whole cycle so the wake is a steady shed rather
          // than a pulse every cell joins in on.
          delay: -Math.round(hash(c + 31, r + 53) * EMBER_MS),
        });
      }
    }
    return out;
  }, [intensityFrom]);

  /* Track resizes: the flyout it lives in can be laid out before fonts settle,
     and a stale width would put the thumb off its notch. */
  useLayoutEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) =>
      setWidth(entry.contentRect.width),
    );
    observer.observe(el);
    setWidth(el.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  /* Follow the value while it is not the pointer's to own. Covers keyboard,
     external resets, and the re-measure above. */
  useEffect(() => {
    if (held.current) return;
    const target = at(index);
    if (width === 0) {
      x.set(target);
      return;
    }
    stop();
    if (reduceMotion) {
      x.set(target);
      return;
    }
    anim.current = animate(x, target, JUMP);
  }, [index, at, width, reduceMotion, x]);

  const indexFor = useCallback(
    (clientX: number) => {
      const rect = trackRef.current?.getBoundingClientRect();
      if (!rect || travel <= 0) return index;
      const local = clamp(clientX - rect.left, PAD, PAD + travel);
      return Math.round(((local - PAD) / travel) * last);
    },
    [travel, last, index],
  );

  const commit = useCallback(
    (clientX: number) => {
      const next = indexFor(clientX);
      if (next !== index) onIndexChange(next);
    },
    [indexFor, index, onIndexChange],
  );

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    stop();
    e.currentTarget.setPointerCapture(e.pointerId);
    held.current = true;
    setDragging(true);
    trackRef.current?.focus();
    commit(e.clientX);

    /* Press is not grab. Snapping the thumb to the pointer here would make a
       click on the far end of the track a teleport; the thumb travels there
       instead, and the first real move below takes the reins mid-flight. */
    const rect = e.currentTarget.getBoundingClientRect();
    const target = clamp(e.clientX - rect.left, PAD, PAD + travel);
    if (reduceMotion) x.set(target);
    else anim.current = animate(x, target, JUMP);
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!held.current) return;
    const rect = e.currentTarget.getBoundingClientRect();
    // The thumb goes exactly where the pointer is — the notch it lands on is
    // decided separately, on release.
    stop();
    x.set(clamp(e.clientX - rect.left, PAD, PAD + travel));
    commit(e.clientX);
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!held.current) return;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    // Settle onto the notch the value already committed to. The effect above
    // would do this too, but only when `index` changed — a drag that ends on
    // the step it started from still has a thumb sitting off-centre.
    const target = at(indexFor(e.clientX));
    stop();
    if (reduceMotion) x.set(target);
    else anim.current = animate(x, target, SETTLE);

    held.current = false;
    setDragging(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowUp"
        ? 1
        : e.key === "ArrowLeft" || e.key === "ArrowDown"
          ? -1
          : 0;
    if (step !== 0) {
      e.preventDefault();
      const next = clamp(index + step, 0, last);
      if (next !== index) onIndexChange(next);
      return;
    }
    if (e.key === "Home") {
      e.preventDefault();
      onIndexChange(0);
    } else if (e.key === "End") {
      e.preventDefault();
      onIndexChange(last);
    }
  };

  return (
    <div
      ref={trackRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={last}
      aria-valuenow={index}
      aria-valuetext={steps[index]}
      aria-orientation="horizontal"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={onKeyDown}
      style={{ height: TRACK_H }}
      className={cn(
        "relative w-full touch-none select-none overflow-hidden rounded-lg bg-bg-inset",
        "outline-none focus-visible:ring-[3px] focus-visible:ring-cyan/30",
        dragging ? "cursor-grabbing" : "cursor-grab",
        className,
      )}
    >
      {/* Fill. Not a progress bar — it is the part of the scale you have
          claimed, which is why it is a shade of the surface and not an accent. */}
      <motion.div
        aria-hidden
        style={{ width: fillW }}
        className="absolute inset-y-0 left-0 rounded-lg bg-bg-active"
      />

      {/* The wake, carried by the thumb's own position. Always mounted once
          configured: every appearance and disappearance is an extend or a
          retract, and mounting would make one of them a pop instead. */}
      {tail.length ? (
        <motion.div
          aria-hidden
          style={{ x: tailX }}
          className="absolute inset-y-0 left-0 w-0 will-change-transform"
        >
          <motion.div
            style={{
              width: TRAIL_PX,
              opacity: tailOpacity,
              maskImage: tailMask,
              WebkitMaskImage: tailMask,
              maskRepeat: "no-repeat",
              WebkitMaskRepeat: "no-repeat",
            }}
            className="absolute inset-y-0 right-0"
          >
            {tail.map((cell) => (
              <span
                key={cell.key}
                className="absolute rounded-[1px] bg-cyan"
                style={{
                  right: cell.right,
                  top: cell.top,
                  width: CELL,
                  height: CELL,
                  /* Reduced motion keeps the shape and drops the shedding —
                     the wake still says which part of the scale is expensive,
                     it just stops streaming while it says it. */
                  ...(reduceMotion
                    ? { opacity: cell.opacity * (boosted ? 1 : 0.85) }
                    : {
                        ["--o" as string]: boosted
                          ? Math.min(1, cell.opacity * 1.2)
                          : cell.opacity,
                        transformOrigin: boosted ? "right center" : undefined,
                        animation: `${boosted ? "tail-ember-fast" : "tail-ember"} ${boosted ? EMBER_FAST_MS : EMBER_MS}ms linear ${cell.delay}ms infinite`,
                      }),
                }}
              />
            ))}
          </motion.div>
        </motion.div>
      ) : null}

      {/* Notches. Rendered under the thumb, so the one in use is simply
          covered — no separate "hide the active tick" rule to keep in sync. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0"
        style={{ left: PAD, right: PAD }}
      >
        {steps.map((_, i) => (
          <span
            key={i}
            className="absolute top-1/2 size-[3px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-fg-faint/55"
            style={{ left: last > 0 ? `${(i / last) * 100}%` : 0 }}
          />
        ))}
      </div>

      <motion.div
        aria-hidden
        style={{ x, width: THUMB_W }}
        animate={{ scaleY: dragging ? 1 : 0.82 }}
        transition={reduceMotion ? { duration: 0 } : { type: "spring", bounce: 0, duration: 0.22 }}
        className="absolute inset-y-[5px] left-0 -ml-[2.5px] rounded-full bg-fg"
      />
    </div>
  );
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
