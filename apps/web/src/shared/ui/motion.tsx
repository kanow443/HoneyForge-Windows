import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

const easing = "cubic-bezier(0.22, 1, 0.36, 1)";

// Animate the existing node: changing a view must not remount its editor or form.
export function useContentMotion<T extends HTMLElement>(
  change: unknown,
  kind: "rise" | "fade" = "rise",
) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const node = ref.current;
    if (!node?.animate || !window.matchMedia) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    if (preference.matches) return;
    const animation = node.animate(
      kind === "fade"
        ? [{ opacity: 0.82 }, { opacity: 1 }]
        : [
            { opacity: 0.65, transform: "translateY(6px)" },
            { opacity: 1, transform: "translateY(0)" },
          ],
      { duration: kind === "fade" ? 160 : 240, easing },
    );
    const stop = () => preference.matches && animation.cancel();
    preference.addEventListener("change", stop);
    return () => {
      animation.cancel();
      preference.removeEventListener("change", stop);
    };
  }, [change, kind]);
  return ref;
}

// Keep the last visible detail only long enough to finish its exit animation.
export function useExitValue<T>(value: T | null | undefined, duration = 160) {
  const [held, setHeld] = useState<T | null>(value ?? null);
  useEffect(() => {
    if (value != null) {
      setHeld(value);
      return;
    }
    const preference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (preference?.matches) {
      setHeld(null);
      return;
    }
    const timer = setTimeout(() => setHeld(null), duration);
    const stop = () => preference?.matches && setHeld(null);
    preference?.addEventListener("change", stop);
    return () => {
      clearTimeout(timer);
      preference?.removeEventListener("change", stop);
    };
  }, [value, duration]);
  return value ?? held;
}

// Retain form controls while collapsing; closed content cannot receive focus.
export function Collapse({
  open,
  children,
  id,
}: {
  open: boolean;
  children: ReactNode;
  id?: string;
}) {
  return (
    <div
      id={id}
      className="motion-collapse"
      data-open={open}
      aria-hidden={!open}
      inert={!open}
    >
      <div className="motion-collapse-inner">{children}</div>
    </div>
  );
}

// The indicator follows the actual selected control, including wrapped/scrolled tabs.
export function MotionIndicator({ active }: { active: unknown }) {
  const ref = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const indicator = ref.current;
    const parent = indicator?.parentElement;
    if (!indicator || !parent) return;
    function measure() {
      const selected = parent!.querySelector<HTMLElement>(
        '[aria-current="page"], [aria-selected="true"], .active',
      );
      if (!selected) {
        indicator!.style.opacity = "0";
        return;
      }
      const bounds = selected.getBoundingClientRect();
      const origin = parent!.getBoundingClientRect();
      indicator!.style.width = `${bounds.width}px`;
      indicator!.style.transform = `translateX(${bounds.left - origin.left + parent!.scrollLeft - parent!.clientLeft}px)`;
      indicator!.style.top = `${bounds.bottom - origin.top + parent!.scrollTop - parent!.clientTop - 2}px`;
      indicator!.style.opacity = "1";
    }
    measure();
    const observer =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(measure)
        : undefined;
    observer?.observe(parent);
    for (const control of parent.querySelectorAll("button, a"))
      observer?.observe(control);
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [active]);
  return <span ref={ref} className="motion-tab-indicator" aria-hidden="true" />;
}
