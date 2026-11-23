import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { IconSvgElement } from "@hugeicons/react";
import { Icon } from "@/components/ui/Icon";
import { cn } from "@/lib/utils";

/*
 * A menu anchored to a trigger, rendered in a portal.
 *
 * The portal is not decoration. The rail's recents list is a scroll container,
 * so a menu positioned inside one of its rows gets clipped by `overflow-y-auto`
 * the moment it is taller than the space left below the row. Fixed positioning
 * out at the document root is the only placement that cannot be cut off.
 *
 * Which means the position has to be computed rather than inherited, and kept
 * up to date: the anchor moves when the rail scrolls or the window resizes, and
 * a menu that stayed behind would be pointing at the wrong row.
 */

const GAP = 6;
const EDGE = 8;

interface Placement {
  top: number;
  left: number;
  /** Which corner the menu grows from, so it scales out of its trigger. */
  origin: string;
}

export function Menu({
  open,
  anchor,
  onClose,
  label,
  width = 190,
  role = "menu",
  className,
  children,
}: {
  open: boolean;
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Names the menu for assistive tech — it is detached from its trigger. */
  label: string;
  width?: number;
  /**
   * "menu" for a list of actions (arrow keys move between items); "dialog"
   * for a small anchored form — switches, sliders — where Tab moves instead.
   * Same layer either way: placement, outside click, Escape, focus return.
   */
  role?: "menu" | "dialog";
  className?: string;
  children: ReactNode;
}) {
  const reduceMotion = useReducedMotion();
  const menuRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<Placement | null>(null);

  const position = useCallback(() => {
    const trigger = anchor.current;
    const menu = menuRef.current;
    if (!trigger || !menu) return;

    const rect = trigger.getBoundingClientRect();
    const height = menu.offsetHeight;

    // Below the trigger by default, above it when that would run off the
    // bottom — the same rule a native menu follows, and the reason the origin
    // flips with it.
    const below = rect.bottom + GAP;
    const flip = below + height > window.innerHeight - EDGE;
    const top = flip ? Math.max(EDGE, rect.top - height - GAP) : below;

    // Right-aligned to the trigger, then pulled back inside the viewport.
    const left = Math.min(
      Math.max(EDGE, rect.right - width),
      window.innerWidth - width - EDGE,
    );

    setPlacement({
      top,
      left,
      origin: `${flip ? "bottom" : "top"} ${
        rect.right - left > width / 2 ? "right" : "left"
      }`,
    });
  }, [anchor, width]);

  // Before paint, so the menu never shows up at the wrong spot for a frame.
  useLayoutEffect(() => {
    if (!open) {
      setPlacement(null);
      return;
    }
    position();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (menuRef.current?.contains(target)) return;
      // A click on the trigger is the trigger's own toggle to handle; closing
      // here too would make it reopen immediately.
      if (anchor.current?.contains(target)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      const menu = menuRef.current;
      if (!menu || !menu.contains(document.activeElement)) return;
      // Tab leaves a menu (WAI-ARIA menu pattern); in a dialog it moves
      // between the controls as usual.
      if (e.key === "Tab" && role === "menu") {
        onClose();
        return;
      }
      if (role !== "menu") return;
      const items = menuItems(menu);
      if (!items.length) return;
      const at = items.indexOf(document.activeElement as HTMLElement);
      const next =
        e.key === "ArrowDown" ? (at + 1) % items.length
        : e.key === "ArrowUp" ? (at - 1 + items.length) % items.length
        : e.key === "Home" ? 0
        : e.key === "End" ? items.length - 1
        : null;
      if (next === null) return;
      e.preventDefault();
      items[next].focus();
    };

    // Capture, so a scroll inside the rail is seen as well as one on the page.
    const onReflow = () => position();

    // The menu's own height can change while it is open — a destructive item
    // that swaps in a confirmation step is taller than the list it replaced.
    // Without this, a menu that had flipped above its trigger would grow
    // downwards straight off the bottom of the window.
    const observer = new ResizeObserver(onReflow);
    if (menuRef.current) observer.observe(menuRef.current);

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onReflow, true);
    window.addEventListener("resize", onReflow);
    return () => {
      observer.disconnect();
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onReflow, true);
      window.removeEventListener("resize", onReflow);
    };
  }, [open, anchor, onClose, position, role]);

  // Closing must not drop focus on <body>: hand it back to the trigger,
  // unless the action already moved it somewhere on purpose. Keyed to `open`
  // alone — callers pass inline onClose, and a cleanup that ran on every
  // re-render would yank focus out of the menu mid-navigation.
  useEffect(() => {
    if (!open) return;
    const menu = menuRef.current;
    return () => {
      const active = document.activeElement;
      if (!active || active === document.body || menu?.contains(active)) {
        anchor.current?.focus({ preventScroll: true });
      }
    };
  }, [open, anchor]);

  // Focus moves in once the layer is placed (it is visibility:hidden until
  // then, and hidden elements cannot take focus): the current item if there
  // is one, else the first. Keyboard users land inside; pointer users see no
  // ring because the focus is programmatic.
  const placed = placement !== null;
  useEffect(() => {
    if (!open || !placed) return;
    const menu = menuRef.current;
    if (!menu || menu.contains(document.activeElement)) return;
    const target =
      role === "menu"
        ? (menu.querySelector<HTMLElement>('[role="menuitem"][aria-current="true"]') ??
          menuItems(menu)[0])
        : menu.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus({ preventScroll: true });
  }, [open, placed, role]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          ref={menuRef}
          role={role}
          aria-label={label}
          data-anchored-layer=""
          initial={reduceMotion ? { opacity: 0 } : { opacity: 0, scale: 0.96 }}
          animate={reduceMotion ? { opacity: 1 } : { opacity: 1, scale: 1 }}
          // Quicker out than in: the user has already chosen, and waiting on
          // their own click is the one delay they always notice.
          exit={
            reduceMotion
              ? { opacity: 0 }
              : { opacity: 0, scale: 0.99, transition: { duration: 0.15, ease: [0.22, 1, 0.36, 1] } }
          }
          transition={
            reduceMotion
              ? { duration: 0.1 }
              : { type: "spring", bounce: 0, duration: 0.25 }
          }
          style={{
            width,
            top: placement?.top ?? 0,
            left: placement?.left ?? 0,
            transformOrigin: placement?.origin ?? "top right",
            boxShadow: "var(--shadow-panel)",
            // Nothing to point at until it has been measured.
            visibility: placement ? "visible" : "hidden",
          }}
          className={cn(
            "fixed z-[60] overflow-hidden rounded-[12px] border border-border-strong bg-bg-raised",
            // Inset items, so each highlight is a rounded pill inside the card.
            role === "menu" && "p-1.5",
            className,
          )}
        >
          {children}
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function menuItems(menu: HTMLElement): HTMLElement[] {
  return [...menu.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])')];
}

export function MenuItem({
  icon,
  iconColor,
  title,
  label,
  detail,
  trailing,
  active = false,
  tone = "default",
  onSelect,
}: {
  icon?: IconSvgElement;
  /** Brand color for a provider mark; plain icons inherit the text color. */
  iconColor?: string;
  title?: string;
  label: string;
  detail?: string;
  trailing?: ReactNode;
  active?: boolean;
  tone?: "default" | "danger";
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      aria-current={active ? "true" : undefined}
      title={title}
      onClick={onSelect}
      className={cn(
        // 6px radius = the menu's 12px minus its 6px inset (concentric corners).
        // Highlight lands instantly and only fades on the way out: the pointer
        // sweeps through lists, and a fade-in trails behind it.
        "pressable flex w-full items-center gap-2.5 rounded-[6px] px-3 py-1.5 text-left transition-[background-color,color] duration-150 ease-out hover:duration-0 focus-visible:duration-0",
        tone === "danger"
          ? "text-red hover:bg-red/10 focus-visible:bg-red/10"
          : active
            ? "bg-bg-active text-fg"
            : "text-fg-dim hover:bg-bg-hover hover:text-fg focus-visible:bg-bg-hover focus-visible:text-fg",
        // The row's own fill is the focus indicator; no outer ring on a list.
        "outline-none",
      )}
    >
      {icon ? (
        <Icon
          icon={icon}
          size={14}
          strokeWidth={1.75}
          color={tone === "danger" ? undefined : iconColor}
          className={tone === "danger" ? "text-red" : undefined}
        />
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[12.5px] tracking-[-0.01em]">
        {label}
      </span>
      {detail ? (
        <span
          className={cn(
            "shrink-0 text-[11px]",
            tone === "danger" ? "text-red/70" : "text-fg-faint",
          )}
        >
          {detail}
        </span>
      ) : null}
      {trailing}
    </button>
  );
}

export function MenuSeparator() {
  return <div className="my-1.5 h-px bg-border" aria-hidden />;
}
