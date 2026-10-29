/** In-memory failed-login limiter per key (email). Resets on restart; adequate for a single node. */
export class LoginThrottle {
  private readonly fails = new Map<string, number[]>();
  constructor(
    private readonly max = 5,
    private readonly windowMs = 15 * 60_000,
    private readonly clock: () => number = Date.now,
  ) {}
  private recent(key: string): number[] {
    const cutoff = this.clock() - this.windowMs;
    const list = (this.fails.get(key) ?? []).filter((t) => t > cutoff);
    if (list.length) this.fails.set(key, list);
    else this.fails.delete(key);
    return list;
  }
  blocked(key: string): boolean {
    return this.recent(key).length >= this.max;
  }
  fail(key: string): void {
    this.fails.set(key, [...this.recent(key), this.clock()]);
  }
  reset(key: string): void {
    this.fails.delete(key);
  }
}
