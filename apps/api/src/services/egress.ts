/** Hosts Hepson may call in production (D22). Everything else is refused before a socket is opened. */
export const DEFAULT_EGRESS_HOSTS = [
  'api.openai.com',
  'graph.facebook.com',
  'api.telegram.org',
  'api.novaposhta.ua',
  'api.monobank.ua',
  'api.wayforpay.com',
  // P8: Google Sheets CSV export of a shop's own public sheet (D35). The download is served from a googleusercontent host.
  'docs.google.com',
] as const;
/** Allowed host families: `<one label>.<suffix>` only (D35: Google's per-file download hosts, e.g. `doc-0c-1a-sheets.googleusercontent.com`). */
export const DEFAULT_EGRESS_SUFFIXES = ['.googleusercontent.com'] as const;
const SUFFIX_LABEL = /^[a-z0-9-]{1,63}$/;
const suffixAllowed = (host: string) => DEFAULT_EGRESS_SUFFIXES.some((s) => host.endsWith(s) && SUFFIX_LABEL.test(host.slice(0, -s.length)));

export class EgressDeniedError extends Error {
  constructor(readonly host: string) {
    super(`outbound request to '${host}' is not allowed`);
    this.name = 'EgressDeniedError';
  }
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

export type EgressOptions = {
  /** Added to the default list (e.g. the configured LLM provider's host, or a local mock in tests). */
  extraHosts?: Iterable<string>;
  /** The real transport; tests pass a stub, which is still subject to the allow-list. */
  fetchImpl?: typeof fetch;
};

/** Host part of a URL or host string, lowercase, or undefined when it cannot be parsed. */
export function hostOf(urlOrHost: string): string | undefined {
  try {
    return new URL(urlOrHost.includes('://') ? urlOrHost : `https://${urlOrHost}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * The only `fetch` production code may use. Refuses: hosts outside the allow-list, URLs with embedded credentials, and
 * plain http (except loopback hosts that were explicitly allowed, for local mocks). Redirects are never followed, so an
 * allowed host cannot bounce a request (and its token) to another one.
 */
export function createEgress(opts: EgressOptions = {}): typeof fetch {
  const allowed = new Set<string>(DEFAULT_EGRESS_HOSTS);
  for (const h of opts.extraHosts ?? []) {
    const host = hostOf(h);
    if (host) allowed.add(host);
  }
  const base = opts.fetchImpl ?? fetch;
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      throw new EgressDeniedError('(invalid url)');
    }
    const host = u.hostname.toLowerCase();
    if (!(allowed.has(host) || suffixAllowed(host)) || u.username || u.password) throw new EgressDeniedError(host);
    if (u.protocol !== 'https:' && !(u.protocol === 'http:' && LOOPBACK.has(host))) throw new EgressDeniedError(host);
    return base(input, { ...init, redirect: 'manual' });
  }) as typeof fetch;
}
