/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public origin of this site, no trailing slash. Used for canonical, hreflang, sitemap and Open Graph URLs. */
  readonly VITE_SITE_URL?: string;
  /** Shop-owner dashboard origin; the header's "log in" and "start" links point here. */
  readonly VITE_DASHBOARD_URL?: string;
}
