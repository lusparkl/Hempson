/** Fixed-window counter per key, in memory (per node, reset on restart; same trade-off as the login throttle, D6). */
export class RateLimiter {
  private hits = new Map<string, { n: number; resetAt: number }>();
  constructor(
    private limit: number,
    private windowMs: number,
    private now: () => number = Date.now,
  ) {}

  /** Counts one hit. Returns 0 when allowed, else the seconds to wait. */
  hit(key: string): number {
    const t = this.now();
    if (this.hits.size > 10_000) this.sweep(t);
    const cur = this.hits.get(key);
    if (!cur || cur.resetAt <= t) {
      this.hits.set(key, { n: 1, resetAt: t + this.windowMs });
      return 0;
    }
    if (cur.n >= this.limit) return Math.max(1, Math.ceil((cur.resetAt - t) / 1000));
    cur.n++;
    return 0;
  }

  private sweep(t: number) {
    for (const [k, v] of this.hits) if (v.resetAt <= t) this.hits.delete(k);
  }
}
