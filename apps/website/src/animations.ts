/**
 * Catalogue of every animation slot on the site. Nothing here animates yet: each slot is an element
 * rendered by <AnimSlot id="..."> with `data-anim="<id>"` and `data-anim-trigger="<trigger>"`.
 * For `in-view` slots the client adds `data-anim-state="visible"` once the element enters the viewport
 * (see `observeAnimations`), so the design pass can attach CSS transitions or a JS timeline to it.
 *
 * Rules for the design pass:
 * - `prefers-reduced-motion: reduce` must give the `reducedMotion` result, never a hidden element.
 * - Content must be readable with JS off (prerendered HTML): animate from visible, or hide only under `.js`.
 * - Animate only `transform` and `opacity` unless noted; no layout shift (keep the slot's size fixed).
 */
export type AnimationTrigger = 'load' | 'in-view' | 'hover' | 'interaction' | 'loop';

export type AnimationSpec = {
  trigger: AnimationTrigger;
  /** What the animation shows and why it is there. */
  description: string;
  /** Suggested total duration; the design pass may change it. */
  durationMs?: number;
  /** What a visitor with reduced motion sees instead. */
  reducedMotion: string;
};

export const ANIMATIONS = {
  // Global
  'header.scroll': {
    trigger: 'interaction',
    description: 'Header gains a background and shadow and shrinks slightly once the page is scrolled past the hero.',
    durationMs: 200,
    reducedMotion: 'State changes instantly.',
  },
  'header.mobile-menu': {
    trigger: 'interaction',
    description: 'Mobile menu slides down from the header; links fade in with a 40 ms stagger. Burger icon morphs into a cross.',
    durationMs: 250,
    reducedMotion: 'Menu appears instantly, no stagger.',
  },
  'lang.switch': {
    trigger: 'hover',
    description: 'Language switcher (UA / RU): active-language indicator slides under the hovered option.',
    durationMs: 150,
    reducedMotion: 'Indicator does not move; hover only changes colour.',
  },

  // Home
  'hero.intro': {
    trigger: 'load',
    description: 'Headline words rise and fade in one after another, then subtitle and the two CTA buttons follow.',
    durationMs: 900,
    reducedMotion: 'Everything is visible at once.',
  },
  'hero.chat-demo': {
    trigger: 'loop',
    description:
      'Phone mock-up with a scripted conversation: customer asks for a product in Ukrainian, typing dots, Hepson replies with price and stock from the catalog, customer gives Nova Poshta branch, a payment-link message appears, then an order card with "TTN created". Loops every ~12 s, pauses when off-screen or when the tab is hidden.',
    durationMs: 12000,
    reducedMotion: 'Static image of the finished conversation.',
  },
  'channels.icons': {
    trigger: 'in-view',
    description: 'Instagram, Telegram and website-chat icons pop in, then thin lines draw from each one into a single Hepson inbox.',
    durationMs: 800,
    reducedMotion: 'Icons and lines shown fully drawn.',
  },
  'how.steps': {
    trigger: 'in-view',
    description: 'The four steps (message, answer, order, TTN) reveal left to right; a progress line fills between them as the user scrolls.',
    durationMs: 1200,
    reducedMotion: 'All steps and the full line visible.',
  },
  'features.cards': {
    trigger: 'in-view',
    description: 'Feature cards fade up with an 80 ms stagger. On hover a card lifts and its icon plays a short one-shot micro-animation.',
    durationMs: 600,
    reducedMotion: 'Cards visible; hover only changes border colour.',
  },
  'trust.guard': {
    trigger: 'in-view',
    description:
      'Explains the reply guard: a draft AI reply with an invented price appears, the wrong figure is highlighted and struck through, and the reply is replaced by one quoting the catalog price.',
    durationMs: 2500,
    reducedMotion: 'Before/after shown side by side, no motion.',
  },
  'pricing.cards': {
    trigger: 'in-view',
    description: 'Plan cards fade up; the recommended plan scales in last with a subtle glow.',
    durationMs: 700,
    reducedMotion: 'Cards visible; recommended plan marked only by its badge.',
  },
  'faq.accordion': {
    trigger: 'interaction',
    description: 'Answer expands with a height transition; the plus icon rotates into a minus. Uses native <details>, so it works without JS.',
    durationMs: 200,
    reducedMotion: 'Opens instantly.',
  },
  'cta.final': {
    trigger: 'in-view',
    description: 'Closing call-to-action band: background gradient drifts slowly; button gets a single soft pulse when the band enters view.',
    durationMs: 1500,
    reducedMotion: 'Static background, no pulse.',
  },

  // Inner pages
  'page.hero': {
    trigger: 'load',
    description: 'Inner-page title and intro fade up together (features, pricing, about, security, contact).',
    durationMs: 500,
    reducedMotion: 'Visible at once.',
  },
  'features.section': {
    trigger: 'in-view',
    description: 'Each feature section: illustration slides in from the side opposite the text; alternates left/right per section.',
    durationMs: 600,
    reducedMotion: 'Illustration visible in place.',
  },
  'about.principles': {
    trigger: 'in-view',
    description: 'Principle cards reveal one after another with a 100 ms stagger.',
    durationMs: 600,
    reducedMotion: 'All cards visible.',
  },
  'security.flow': {
    trigger: 'in-view',
    description: 'Diagram: shop credentials enter a lock (encrypted vault); outbound arrows only reach the allow-listed providers, an arrow to an unknown host bounces off.',
    durationMs: 2000,
    reducedMotion: 'Static diagram.',
  },
  'notfound.illustration': {
    trigger: 'loop',
    description: 'Small looping illustration on the 404 page (for example a parcel that keeps missing the branch).',
    durationMs: 4000,
    reducedMotion: 'Static illustration.',
  },
} as const satisfies Record<string, AnimationSpec>;

export type AnimationId = keyof typeof ANIMATIONS;

/** Marks `in-view` slots with `data-anim-state="visible"` the first time they enter the viewport. Client only. */
export function observeAnimations(root: ParentNode = document): void {
  const nodes = root.querySelectorAll<HTMLElement>('[data-anim-trigger="in-view"]:not([data-anim-state])');
  if (!('IntersectionObserver' in window)) {
    nodes.forEach((n) => (n.dataset.animState = 'visible'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        (e.target as HTMLElement).dataset.animState = 'visible';
        io.unobserve(e.target);
      }
    },
    { threshold: 0.2 },
  );
  nodes.forEach((n) => io.observe(n));
}
