import { useEffect, useState, type RefObject } from 'react';

/** Shared timing helpers for the design's animated embeds (hero, how-it-works, CTA, login board). */

export const Easing = {
  linear: (t: number) => t,
  easeOutCubic: (t: number) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeInOutQuad: (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2),
  easeInOutSine: (t: number) => -(Math.cos(Math.PI * t) - 1) / 2,
  easeOutBack: (t: number) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
};
export type Ease = (t: number) => number;

export const TAU = Math.PI * 2;
export const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** Progress of `T` through [a, b], clamped and optionally eased. */
export const P = (T: number, a: number, b: number, e?: Ease | null) => {
  const x = clamp01((T - a) / (b - a));
  return e ? e(x) : x;
};
/** Deterministic pseudo-random in [0, 1). */
export const rnd = (i: number, s: number) => {
  const x = Math.sin(i * 127.1 + s * 311.7) * 43758.5453;
  return x - Math.floor(x);
};
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
/** Mixes two `#rrggbb` colours. */
export const mix = (a: string, b: string, t: number) => {
  const x = hex(a);
  const y = hex(b);
  return 'rgb(' + x.map((v, i) => Math.round(lerp(v, y[i]!, t))).join(',') + ')';
};

export const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * Loop clock in seconds: advances `step(prev, dt)` every frame while the element is on screen and the tab
 * is visible. With reduced motion it stays at `still`.
 */
export function useLoop(ref: RefObject<HTMLElement | null>, step: (prev: number, dt: number) => number, still: number): number {
  // Starts at 0 on server and client alike so prerendered markup hydrates cleanly.
  const [t, setT] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reducedMotion()) {
      setT(still);
      return;
    }
    let raf = 0;
    let onScreen = true;
    let last = performance.now();
    let v = 0;
    const io = new IntersectionObserver(([e]) => {
      onScreen = !!e?.isIntersecting;
    });
    io.observe(el);
    const loop = (now: number) => {
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      if (onScreen && !document.hidden) {
        v = step(v, dt);
        setT(v);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return t;
}

/** Element size, kept current with a ResizeObserver. */
export function useSize(ref: RefObject<HTMLElement | null>, initial: { w: number; h: number }) {
  const [sz, setSz] = useState(initial);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      setSz({ w: r.width || initial.w, h: r.height || initial.h });
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return sz;
}
