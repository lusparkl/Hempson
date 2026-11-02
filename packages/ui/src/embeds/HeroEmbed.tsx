import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Easing, P, TAU, useLoop } from './motion';

/**
 * Home hero (design: hero-embed.jsx): a phone with a scripted Instagram conversation — the customer asks,
 * the AI answers from the catalog, takes the Nova Poshta branch and creates an order draft — over a moving
 * gradient background. Loops; pauses off screen; static with reduced motion.
 */

// [name, played seconds, authored seconds]
const SCENES: Array<[string, number, number]> = [['Intro', 1.2, 1.2], ['Ask', 1.75, 3.5], ['Offer', 3.5, 3.5], ['Address', 4, 4], ['Draft', 3.5, 3.5], ['Done', 3.5, 3.5], ['Hold', 2, 2], ['Reset', 1, 1]];
const CUES: Record<string, number> = {};
let acc = 0;
for (const [n, , nat] of SCENES) {
  CUES[n] = acc;
  acc += nat;
}
const AUTH_TOTAL = acc;
const PLAY_TOTAL = SCENES.reduce((x, s) => x + s[1], 0);
const cue = (n: string) => CUES[n]!;
function warp(p: number) {
  let ps = 0;
  let as = 0;
  for (const [, d, nat] of SCENES) {
    if (p < ps + d) return as + (p - ps) * (nat / d);
    ps += d;
    as += nat;
  }
  return AUTH_TOTAL;
}

const Ctx = createContext(0);
const useT = () => useContext(Ctx);

const C = {
  brand50: '#F1F0FF', brand200: '#CBC6FF', brand300: '#A9A1FF', brand600: '#533AFD',
  ink900: '#0A2540', ink800: '#1F3A5C', ink600: '#5A6D86', ink500: '#7B8CA3', ink200: '#DCE3EC', ink100: '#E8EDF3', ink50: '#F6F9FC',
  cyan: '#80E9FF', violet: '#7A73FF', pink: '#FF80BB', amber: '#FFC857', orange: '#FF7A33',
};
const FONT = "'Geist','Helvetica Neue',Arial,sans-serif";
const MOTION = { enter: Easing.easeOutCubic, pop: Easing.easeOutBack, draw: Easing.easeInOutCubic };

const TXT1 = 'Доброго дня! Чи є льняна сумка кольору «пісок»?';
const TXT2 = 'Так, є 4 шт. — 640 ₴. Оформити з доставкою Новою Поштою?';
const TXT3 = 'Так, у Дніпро, відділення 12';
const TXT4 = 'Створюю чернетку замовлення…';
const TXT5 = 'Дякую! Менеджер підтвердить замовлення найближчим часом.';

const TL = {
  m1: { at: cue('Ask') + 0.6 },
  m2: { type: cue('Offer') + 0.1, send: cue('Offer') + 1.1, at: cue('Offer') + 1.2 },
  m3: { at: cue('Address') + 0.6 },
  m4: { type: cue('Draft') + 0.1, send: cue('Draft') + 0.7, at: cue('Draft') + 0.8 },
  m5: { type: cue('Done') + 0.1, send: cue('Done') + 1.1, at: cue('Done') + 1.2 },
  reset: cue('Reset'),
};

function wave(yb: number, amp: number, lam: number, ph: number, close: 'down' | 'up' | null) {
  let d = '';
  for (let x = -10; x <= 730; x += 10) {
    const y = yb + amp * Math.sin((TAU * x) / lam + ph) + amp * 0.45 * Math.sin((TAU * x) / (lam * 0.57) - ph * 2 + 1.3);
    d += (x === -10 ? 'M' : 'L') + x + ',' + y.toFixed(1);
  }
  if (close === 'down') d += 'L730,900L-10,900Z';
  if (close === 'up') d += 'L730,0L-10,0Z';
  return d;
}

function Background() {
  const T = useT();
  const ph = (TAU * T) / AUTH_TOTAL;
  const blob = (col: string, x: number, y: number, r: number, ax: number, ay: number, k: number, p: number) =>
    'radial-gradient(circle at ' + (x + ax * Math.sin(k * ph + p)).toFixed(1) + '% ' + (y + ay * Math.cos(k * ph + p * 1.3)).toFixed(1) + '%,' + col + ' 0,transparent ' + r + '%)';
  const mesh = [blob(C.violet, 0, 100, 62, 14, 10, 1, 0), blob(C.amber, 100, 0, 58, 12, 10, 1, 2), blob(C.orange, 80, 92, 52, 16, 8, 2, 1), blob(C.pink, 24, 14, 56, 14, 12, 1, 4), blob(C.cyan, 50, 50, 30, 30, 20, 2, 3)].join(',');
  const sweep = -120 + 240 * (T / AUTH_TOTAL);
  const sd = 56 * (T / AUTH_TOTAL);
  const lines = [];
  for (let i = 0; i < 9; i++) lines.push(<path key={'a' + i} d={wave(610 + i * 11, 38, 620, ph + i * 0.16, null)} fill="none" stroke="#fff" strokeWidth="1.2" opacity={0.7 - i * 0.05} />);
  for (let i = 0; i < 7; i++) lines.push(<path key={'b' + i} d={wave(170 - i * 10, 30, 520, -ph * 2 + i * 0.2 + 1, null)} fill="none" stroke="#fff" strokeWidth="1" opacity={0.6 - i * 0.06} />);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      <div style={{ position: 'absolute', inset: 0, background: mesh }} />
      <svg width="720" height="900" viewBox="0 0 720 900" style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="hs-hero-wg1" x1="0" y1="0" x2="1" y2="0.3"><stop offset="0" stopColor={C.cyan} /><stop offset=".35" stopColor={C.violet} /><stop offset=".7" stopColor={C.pink} /><stop offset="1" stopColor={C.amber} /></linearGradient>
          <linearGradient id="hs-hero-wg2" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stopColor={C.violet} /><stop offset=".5" stopColor={C.pink} /><stop offset="1" stopColor={C.orange} /></linearGradient>
          <linearGradient id="hs-hero-wg3" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor={C.pink} /><stop offset="1" stopColor={C.amber} /></linearGradient>
        </defs>
        <path d={wave(150, 34, 560, -ph * 2 + 1, 'up')} fill="url(#hs-hero-wg3)" opacity=".42" />
        <path d={wave(590, 42, 640, ph, 'down')} fill="url(#hs-hero-wg1)" opacity=".38" />
        <path d={wave(660, 36, 520, -ph * 2 + 2, 'down')} fill="url(#hs-hero-wg2)" opacity=".42" />
        {lines}
      </svg>
      <div style={{ position: 'absolute', top: -100, bottom: -100, width: 260, left: sweep + '%', transform: 'translateX(-50%) skewX(-14deg)', background: 'linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.34),rgba(255,255,255,0))' }} />
      <div style={{ position: 'absolute', inset: -60, transform: 'translate(' + (0.906 * sd).toFixed(2) + 'px,' + (0.423 * sd).toFixed(2) + 'px)', background: 'repeating-linear-gradient(115deg,rgba(255,255,255,.26) 0 1px,transparent 1px 7px)' }} />
    </div>
  );
}

function Dots({ T }: { T: number }) {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '13px 14px' }}>
      {[0, 1, 2].map((i) => {
        const s = 0.5 + 0.5 * Math.sin(T * 7 - i * 0.9);
        return <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: '#fff', opacity: 0.4 + 0.6 * s, transform: 'translateY(' + (-2.5 * s).toFixed(2) + 'px)' }} />;
      })}
    </div>
  );
}

function Bubble({ side, text, time }: { side: 'in' | 'out'; text: string; time: string }) {
  const out = side === 'out';
  return (
    <div style={{ maxWidth: '80%', padding: '9px 12px', borderRadius: out ? '16px 16px 4px 16px' : '16px 16px 16px 4px', fontSize: 14, lineHeight: 1.4, background: out ? C.brand600 : '#fff', color: out ? '#fff' : C.ink900, boxShadow: out ? 'none' : '0 1px 1px rgba(10,37,64,.08)' }}>
      {text}
      <div style={{ fontSize: 10, marginTop: 3, textAlign: 'right', opacity: 0.65 }}>{time}</div>
    </div>
  );
}

/** A chat row that grows in (optionally as a typing bubble first, then swaps to the content). */
function Row({ side, t0, t1, children }: { side: 'in' | 'out'; t0: number | null; t1: number; children: ReactNode }) {
  const T = useT();
  const out = side === 'out';
  const a = t0 == null ? 1 : P(T, t0, t0 + 0.35, MOTION.enter);
  const b = P(T, t1, t1 + 0.45, MOTION.enter);
  const swapped = T >= t1;
  const maxH = t0 == null ? 170 * b : 46 * a + 130 * b;
  const pop = P(T, t1, t1 + 0.5, MOTION.pop);
  const typing = !swapped && t0 != null;
  return (
    <div style={{ boxSizing: 'border-box', flex: 'none', display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', padding: '4px 0', overflow: 'hidden', maxHeight: maxH, opacity: t0 == null ? Math.min(1, b * 1.6) : Math.min(1, a * 1.6) }}>
      {typing && (
        <div style={{ borderRadius: '16px 16px 4px 16px', background: C.brand600, transform: 'translateY(' + (1 - a) * 10 + 'px)' }}>
          <Dots T={T} />
        </div>
      )}
      {swapped && (
        <div style={{ width: '100%', display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', transformOrigin: out ? 'bottom right' : 'bottom left', transform: 'scale(' + (0.9 + 0.1 * pop).toFixed(3) + ') translateY(' + ((1 - b) * 8).toFixed(2) + 'px)', opacity: Math.min(1, b * 2) }}>
          {children}
        </div>
      )}
    </div>
  );
}

function DraftCard({ c1 }: { c1: number }) {
  const T = useT();
  const n = 1280 * P(T, c1 + 0.3, c1 + 1.4, MOTION.draw);
  const badge = P(T, c1 + 1.4, c1 + 1.9, MOTION.pop);
  const ring = P(T, c1 + 1.4, c1 + 2.4, MOTION.enter);
  const glow = (1 - ring) * 8 * (T > c1 + 1.4 ? 1 : 0);
  return (
    <div style={{ width: '88%', background: '#fff', border: '1px solid ' + C.brand200, borderRadius: 12, padding: '10px 12px', display: 'flex', alignItems: 'center', gap: 10, boxShadow: '0 1px 2px rgba(10,37,64,.08), 0 0 0 ' + glow.toFixed(1) + 'px rgba(83,58,253,' + (0.18 * (1 - ring)).toFixed(3) + ')', boxSizing: 'border-box' }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 10, color: C.ink500 }}>Чернетка замовлення</div>
        <div style={{ fontSize: 20, fontWeight: 300, letterSpacing: '-.04em', color: C.ink900, fontVariantNumeric: 'tabular-nums' }}>{n.toFixed(2)} UAH</div>
      </div>
      <span style={{ fontSize: 12, fontWeight: 500, padding: '3px 9px', borderRadius: 4, background: '#FFF1CF', color: '#8A5A00', border: '1px solid #F0D58A', opacity: badge > 0 ? 1 : 0, transform: 'scale(' + (0.6 + 0.4 * badge).toFixed(3) + ')' }}>Очікує</span>
    </div>
  );
}

function InputBar() {
  const T = useT();
  const seqs: Array<[number, number, string]> = [[TL.m2.type, TL.m2.send, TXT2], [TL.m4.type, TL.m4.send, TXT4], [TL.m5.type, TL.m5.send, TXT5]];
  let text = '';
  let sendP = 0;
  for (const [a, b, s] of seqs) {
    if (T >= a && T < b) text = s.slice(0, Math.floor(s.length * P(T, a, b - 0.15, Easing.linear)));
    if (T >= b && T < b + 0.4) sendP = Math.sin(Math.PI * P(T, b, b + 0.4));
  }
  const caret = text && Math.floor(T * 2.5) % 2 === 0 ? '▏' : '';
  const hasText = !!text;
  return (
    <div style={{ flex: 'none', background: '#fff', borderTop: '1px solid ' + C.ink100, padding: '8px 12px 24px', display: 'flex', alignItems: 'flex-end', gap: 8 }}>
      <div style={{ flex: 1, minWidth: 0, boxSizing: 'border-box', minHeight: 34, borderRadius: 17, background: C.ink50, border: '1px solid ' + (hasText ? C.brand300 : C.ink200), padding: '7px 14px', display: 'flex', alignItems: 'center', fontSize: 13, lineHeight: '18px', color: hasText ? C.ink900 : C.ink500, overflow: 'hidden', overflowWrap: 'anywhere' }}>
        {hasText ? (
          <span>
            {text}
            <span style={{ color: C.brand600 }}>{caret}</span>
          </span>
        ) : (
          'Повідомлення'
        )}
      </div>
      <span style={{ flex: 'none', width: 34, height: 34, borderRadius: '50%', background: C.brand600, color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, transform: 'scale(' + (1 - 0.14 * sendP + (hasText ? 0.04 : 0)).toFixed(3) + ')', boxShadow: sendP > 0 ? '0 0 0 ' + (sendP * 6).toFixed(1) + 'px rgba(83,58,253,.18)' : 'none' }}>↑</span>
    </div>
  );
}

function Phone() {
  const T = useT();
  const ph = (TAU * T) / AUTH_TOTAL;
  const bob = 7 * Math.sin(2 * ph);
  const tilt = 1.1 * Math.sin(ph + 0.6);
  const aiTyping = [TL.m2, TL.m4, TL.m5].some((m) => T >= m.type && T < m.send);
  const fade = 1 - P(T, TL.reset + 0.05, TL.reset + 0.8, Easing.easeInOutQuad);
  const side = (l: 'left' | 'right', top: number, h: number, r: string) => <div style={{ position: 'absolute', [l]: -3, top, width: 3, height: h, background: C.ink800, borderRadius: r }} />;
  return (
    <div style={{ position: 'absolute', left: 200, top: 110, width: 320, height: 680, transform: 'translateY(' + bob.toFixed(2) + 'px) rotate(' + tilt.toFixed(3) + 'deg)', fontFamily: FONT, letterSpacing: '-.01em' }}>
      <div style={{ position: 'relative', width: '100%', height: '100%', boxSizing: 'border-box', borderRadius: 50, background: C.ink900, padding: 10, boxShadow: '0 40px 70px -24px rgba(40,20,120,.45), 0 14px 28px -12px rgba(11,42,34,.25), inset 0 0 0 2px ' + C.ink800 }}>
        {side('left', 110, 30, '2px 0 0 2px')}
        {side('left', 160, 54, '2px 0 0 2px')}
        {side('right', 150, 80, '0 2px 2px 0')}
        <div style={{ position: 'relative', width: '100%', height: '100%', borderRadius: 40, background: C.ink50, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ height: 46, flex: 'none', background: '#fff', display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', padding: '0 26px 6px', fontSize: 12, fontWeight: 600, color: C.ink900, position: 'relative' }}>
            <span>9:41</span>
            <span style={{ position: 'absolute', left: '50%', top: 10, marginLeft: -48, width: 96, height: 26, borderRadius: 14, background: C.ink900 }} />
            <span style={{ width: 16, height: 9, border: '1.5px solid ' + C.ink900, borderRadius: 3, position: 'relative', display: 'block', boxSizing: 'content-box' }}>
              <span style={{ position: 'absolute', inset: 1, right: 4, background: C.ink900, borderRadius: 1 }} />
            </span>
          </div>
          <div style={{ flex: 'none', background: '#fff', borderBottom: '1px solid ' + C.ink100, padding: '8px 14px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
            <span style={{ fontSize: 20, color: C.brand600, lineHeight: 1 }}>‹</span>
            <span style={{ flex: 'none', width: 36, height: 36, borderRadius: '50%', background: C.brand50, color: '#4228D6', fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>О</span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 500, color: C.ink900, whiteSpace: 'nowrap' }}>Олена Ковальчук</div>
              <div style={{ fontSize: 11, color: aiTyping ? C.brand600 : C.ink500, fontWeight: aiTyping ? 500 : 400 }}>{aiTyping ? 'ШІ пише…' : 'Instagram · Лавка Софії'}</div>
            </div>
            <span style={{ fontSize: 12, fontWeight: 500, padding: '3px 8px', borderRadius: 4, background: '#DDF3E5', color: '#0B6441', border: '1px solid #A9DDBD' }}>ШІ</span>
          </div>
          <div style={{ flex: 1, minHeight: 0, padding: '10px 12px', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', overflow: 'hidden', opacity: fade }}>
            <Row side="in" t0={null} t1={TL.m1.at}><Bubble side="in" text={TXT1} time="14:18" /></Row>
            <Row side="out" t0={null} t1={TL.m2.at}><Bubble side="out" text={TXT2} time="14:18" /></Row>
            <Row side="in" t0={null} t1={TL.m3.at}><Bubble side="in" text={TXT3} time="14:20" /></Row>
            <Row side="out" t0={null} t1={TL.m4.at}><DraftCard c1={TL.m4.at} /></Row>
            <Row side="out" t0={null} t1={TL.m5.at}><Bubble side="out" text={TXT5} time="14:20" /></Row>
          </div>
          <InputBar />
          <div style={{ position: 'absolute', left: '50%', bottom: 7, marginLeft: -52, width: 104, height: 4, borderRadius: 2, background: C.ink900 }} />
        </div>
      </div>
    </div>
  );
}

export function HeroEmbed() {
  const box = useRef<HTMLDivElement>(null);
  const p = useLoop(box, (v, dt) => (v + dt) % PLAY_TOTAL, -1);
  const T = p < 0 ? cue('Hold') + 0.5 : warp(p);
  const [fit, setFit] = useState({ scale: 1, k: 1 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      const sc = Math.max(r.width / 720, r.height / 900);
      setFit({ scale: sc, k: Math.max(0.3, Math.min(1, (r.height / sc - 56) / 680, (r.width / sc - 40) / 320)) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }} aria-hidden="true">
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: 720, height: 900, marginLeft: -360, marginTop: -450, transform: 'scale(' + fit.scale.toFixed(4) + ')', transformOrigin: '50% 50%' }}>
        <Ctx.Provider value={T}>
          <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', fontFamily: FONT }}>
            <Background />
            <div style={{ position: 'absolute', inset: 0, transform: 'scale(' + fit.k.toFixed(4) + ')', transformOrigin: '360px 450px' }}>
              <Phone />
            </div>
          </div>
        </Ctx.Provider>
      </div>
    </div>
  );
}
