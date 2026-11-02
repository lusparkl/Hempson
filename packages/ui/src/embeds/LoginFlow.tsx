import { useRef, type ReactElement } from 'react';
import { Easing, TAU, clamp01, lerp, rnd, useLoop, useSize } from './motion';

/**
 * Login-screen art (design: login-embed.jsx): order cards flow through the four order lanes
 * (pending → payment → shipped → received) over a soft gradient wash. Decorative only.
 */

const LOOP = 24;
const Q = {
  brand50: '#F1F0FF', brand200: '#CBC6FF', brand300: '#A9A1FF', brand600: '#533AFD', brand700: '#4228D6',
  ink900: '#0A2540', ink600: '#5A6D86', ink500: '#7B8CA3', ink400: '#A3AFC2', ink300: '#C9D2DF', ink200: '#DCE3EC', ink100: '#E8EDF3', ink50: '#F6F9FC',
};
const QFONT = "'Geist','Helvetica Neue',Arial,sans-serif";
const QMONO = "'Geist Mono',ui-monospace,Menlo,monospace";
const MOTION = { enter: Easing.easeOutCubic, glide: Easing.easeInOutCubic, slide: Easing.easeInOutSine, pop: Easing.easeOutBack };

const W = 960, H = 1080, OY = 270, NC = 8, CARD_W = 200, CARD_H = 76;
const X = [120, 360, 600, 840] as const;
const RAIL = OY + 150, SLOT0 = OY + 250, SLOT_GAP = 92;
const E = [0.6, 2.5, 4.1, 5.7] as const; // arrival (beats) into each lane
const S = [1.9, 3.5, 5.1, 6.9] as const; // departure from each lane
const SEG = [
  // moves: spawn, 0→1, 1→2, 2→3, exit
  { s: 0, e: E[0] }, { s: S[0], e: E[1] }, { s: S[1], e: E[2] }, { s: S[2], e: E[3] }, { s: S[3], e: 8 },
];
type IconName = 'clock' | 'card' | 'truck' | 'pack' | 'ig' | 'tg' | 'web';
const LANES: Array<{ name: string; badge: string; tone: 'w' | 'i' | 's'; icon: IconName }> = [
  { name: 'Очікує', badge: 'Очікує', tone: 'w', icon: 'clock' },
  { name: 'Оплата', badge: 'Чекає оплату', tone: 'i', icon: 'card' },
  { name: 'Відправлено', badge: 'Відправлено', tone: 'i', icon: 'truck' },
  { name: 'Отримано', badge: 'Отримано', tone: 's', icon: 'pack' },
];
const TONES = { w: ['#FDF0D0', '#7A4F05', '#F1D48C'], i: ['#DCEEF9', '#14578A', '#A7D2EC'], s: ['#DDF3E5', '#0B6441', '#A9DDBD'] } as const;
const ORDERS: Array<[string, number, number, IconName]> = [
  ['Олена К.', 1048, 1280, 'ig'], ['Андрій М.', 1049, 640, 'tg'], ['Ірина П.', 1050, 2150, 'web'], ['Максим Т.', 1051, 890, 'ig'],
  ['Софія Л.', 1052, 1740, 'tg'], ['Дмитро Б.', 1053, 420, 'web'], ['Наталя Г.', 1054, 3260, 'ig'], ['Тарас В.', 1055, 975, 'tg'],
];

const ageOf = (c: number, f: number) => ((((f * NC) - c) % NC) + NC) % NC;
const SL = 0.55;
const laneAt = (a: number) => {
  for (let L = 0; L < 4; L++) if (a >= E[L]! && a < S[L]! + SL) return L;
  return -1;
};
const pres = (a: number, L: number) => (a < S[L]! ? 1 : 1 - MOTION.slide(clamp01((a - S[L]!) / SL)));
const slotY = (n: number) => SLOT0 + n * SLOT_GAP;

function slotOf(c: number, lane: number, a: number, f: number) {
  let n = 0;
  for (let k = 0; k < NC; k++) {
    if (k === c) continue;
    const a2 = ageOf(k, f);
    if (a2 > a && laneAt(a2) === lane) n += pres(a2, lane);
  }
  return n;
}

type Pose = { x: number; y: number; o: number; lane: number; move: number; seg: number; u: number; head?: number };
function pose(c: number, f: number): Pose {
  const a = ageOf(c, f);
  const L = laneAt(a);
  if (L >= 0 && a < S[L]!) return { x: X[L]!, y: slotY(slotOf(c, L, a, f)), o: 1, lane: L, move: 0, seg: -1, u: 0 };
  let j = 0;
  for (let i = 0; i < SEG.length; i++) if (a >= SEG[i]!.s && a < SEG[i]!.e) j = i;
  const sg = SEG[j]!;
  const u = (a - sg.s) / (sg.e - sg.s);
  const yE = MOTION.slide;
  if (j === 0) {
    const dst = slotY(slotOf(c, 0, a + 0.0001, f));
    const tr = clamp01(u / 0.75), dr = clamp01((u - 0.5) / 0.5);
    const x = lerp(X[0] - 230, X[0], MOTION.glide(tr));
    return { x, y: lerp(RAIL, dst, yE(dr)), o: clamp01(u / 0.6), lane: 0, move: 1, seg: 0, u: tr, head: x };
  }
  if (j === 4) {
    const src = slotY(slotOf(c, 3, a, f));
    const ru = clamp01(u / 0.4), tr = clamp01((u - 0.2) / 0.8);
    const x = lerp(X[3], X[3] + 330, MOTION.glide(tr));
    return { x, y: lerp(src, RAIL, yE(ru)), o: 1 - clamp01((u - 0.45) / 0.55), lane: 3, move: 1, seg: 4, u: tr, head: x };
  }
  const src = slotY(slotOf(c, j - 1, a, f)), dst = slotY(slotOf(c, j, a, f));
  const tr = clamp01((u - 0.14) / 0.72);
  const x = lerp(X[j - 1]!, X[j]!, MOTION.glide(tr));
  const y = u < 0.5 ? lerp(src, RAIL, yE(clamp01(u / 0.44))) : lerp(RAIL, dst, yE(clamp01((u - 0.56) / 0.44)));
  return { x, y, o: 1, lane: tr < 0.5 ? j - 1 : j, move: 1, seg: j, u: clamp01(u), head: x };
}

function LIcon({ name, size = 20, color = Q.brand600, sw = 1.75 }: { name: IconName; size?: number; color?: string; sw?: number }) {
  const p = { fill: 'none', stroke: color, strokeWidth: sw, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const g: Record<IconName, ReactElement> = {
    clock: <g {...p}><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></g>,
    card: <g {...p}><rect x="2" y="5" width="20" height="14" rx="2" /><path d="M2 10h20" /></g>,
    truck: <g {...p}><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2" /><path d="M15 18H9" /><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14" /><circle cx="17" cy="18" r="2" /><circle cx="7" cy="18" r="2" /></g>,
    pack: <g {...p}><path d="m16 16 2 2 4-4" /><path d="M21 10V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l2-1.14" /><path d="m7.5 4.27 9 5.15" /><path d="M3.29 7 12 12l8.71-5" /><path d="M12 22V12" /></g>,
    ig: <g {...p}><rect x="2" y="2" width="20" height="20" rx="5" /><circle cx="12" cy="12" r="4.5" /><path d="M17.5 6.5h.01" /></g>,
    tg: <g {...p}><path d="M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11z" /><path d="m21.854 2.147-10.94 10.939" /></g>,
    web: <g {...p}><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" /></g>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'block', flex: 'none' }}>{g[name]}</svg>;
}

function strand(i: number, ph: number) {
  const r1 = rnd(i, 1), r2 = rnd(i, 2), r3 = rnd(i, 3), r4 = rnd(i, 4);
  const sx = -300 + rnd(i, 5) * (W + 600);
  const ang = ((62 + 14 * Math.sin((sx / W) * Math.PI) + (r1 - 0.5) * 8) * Math.PI) / 180;
  const L = 900 + r2 * 700, amp = 8 + r3 * 26, fr = 0.7 + r4 * 1.1, phi = r1 * TAU, m = r2 < 0.4 ? 1 : r2 < 0.75 ? -1 : 2;
  const dx = Math.cos(ang), dy = -Math.sin(ang), nx = Math.sin(ang), ny = Math.cos(ang);
  let d = '';
  for (let j = 0; j <= 26; j++) {
    const t = j / 26, off = amp * Math.sin(TAU * t * fr + phi + m * ph) * Math.sin(Math.PI * t * 0.9 + 0.15);
    d += (j ? 'L' : 'M') + (sx + t * L * dx + off * nx).toFixed(1) + ',' + (H + 80 + t * L * dy + off * ny).toFixed(1);
  }
  return d;
}

function Wash({ T }: { T: number }) {
  const f = T / LOOP, ph = TAU * f;
  const blob = (c: string, x: number, y: number, rx: number, ry: number, ax: number, ay: number, kk: number, p: number) =>
    'radial-gradient(ellipse ' + rx + '% ' + ry + '% at ' + (x + ax * Math.sin(kk * ph + p)).toFixed(1) + '% ' + (y + ay * Math.cos(kk * ph + p)).toFixed(1) + '%,' + c + ' 0,transparent 100%)';
  const bg = [
    blob('rgba(255,200,87,.62)', 100, 0, 62, 48, 8, 8, 1, 0),
    blob('rgba(122,115,255,.58)', 0, 100, 62, 48, 8, 8, 1, 2),
    blob('rgba(255,128,187,.58)', 100, 100, 58, 44, 8, 8, 1, 4),
    blob('rgba(255,122,51,.4)', 100, 56, 40, 28, 6, 10, 2, 1),
    blob('rgba(169,161,255,.5)', 0, 4, 56, 40, 8, 8, 1, 5.5),
    blob('rgba(128,233,255,.38)', 20, 52, 36, 22, 8, 10, 2, 3.3),
  ].join(',');
  const sd = 56 * f;
  const cols = ['255,128,187', '122,115,255', '255,200,87'];
  const sts = [];
  for (let i = 0; i < 64; i++)
    sts.push(<path key={i} d={strand(i, ph)} fill="none" stroke={'rgba(' + cols[i % 3] + ',' + (0.16 + rnd(i, 7) * 0.26).toFixed(2) + ')'} strokeWidth={(0.7 + rnd(i, 8) * 1.8).toFixed(2)} strokeLinecap="round" />);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }}>
      <div style={{ position: 'absolute', inset: 0, background: bg }} />
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{ position: 'absolute', inset: 0 }}>{sts}</svg>
      <div style={{ position: 'absolute', inset: -60, transform: 'translate(' + (0.906 * sd).toFixed(2) + 'px,' + (0.423 * sd).toFixed(2) + 'px)', background: 'repeating-linear-gradient(115deg,rgba(255,255,255,.3) 0 1px,transparent 1px 7px)' }} />
    </div>
  );
}

function Board({ T }: { T: number }) {
  const f = T / LOOP;
  const poses: Pose[] = [];
  for (let c = 0; c < NC; c++) poses.push(pose(c, f));
  const counts = [0, 0, 0, 0], pulse = [0, 0, 0, 0];
  const seg: Array<{ p: Pose; o: number; end: boolean } | null> = [null, null, null, null, null];
  for (let c = 0; c < NC; c++) {
    const a = ageOf(c, f), p = poses[c]!;
    if (p.o > 0.5) counts[p.lane]! += 1;
    for (let L = 0; L < 4; L++) if (a >= E[L]! && a < E[L]! + 0.6) pulse[L] = Math.max(pulse[L]!, 1 - clamp01((a - E[L]!) / 0.6));
    for (let j = 0; j < 5; j++) {
      const sg = SEG[j]!;
      if (a >= sg.s && a < sg.e + 0.8) seg[j] = { p, o: a < sg.e ? 1 : 1 - clamp01((a - sg.e) / 0.8), end: a >= sg.e };
    }
  }
  const x0 = [0, X[0], X[1], X[2], X[3]], x1 = [X[0], X[1], X[2], X[3], W];
  const fills = [];
  for (let j = 0; j < 5; j++) {
    const s = seg[j];
    if (!s) continue;
    const head = s.end ? x1[j]! : Math.min(x1[j]!, Math.max(x0[j]!, s.p.head ?? x0[j]!));
    fills.push(<rect key={j} x={x0[j]} y={RAIL - 1} width={Math.max(0, head - x0[j]!)} height={2} fill={Q.brand600} opacity={s.o.toFixed(3)} />);
    if (!s.end && j < 4) fills.push(<circle key={'h' + j} cx={head} cy={RAIL} r={4.5} fill="#fff" stroke={Q.brand600} strokeWidth={2} />);
  }
  const hdr = LANES.map((l, i) => {
    const pu = pulse[i]!, pop = 1 + 0.18 * Math.sin(Math.PI * clamp01(1 - pu)) * (pu > 0 ? 1 : 0);
    return (
      <div key={i} style={{ position: 'absolute', left: X[i]! - 120, top: OY + 4, width: 240, height: 56, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 10, fontFamily: QFONT }}>
        <div style={{ width: 40, height: 40, boxSizing: 'border-box', borderRadius: 6, background: pu > 0 ? Q.brand50 : '#fff', border: '1px solid ' + (pu > 0 ? Q.brand300 : Q.ink200), display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: '0 0 0 ' + (pu * 5).toFixed(1) + 'px rgba(83,58,253,' + (0.12 * pu).toFixed(3) + ')' }}>
          <LIcon name={l.icon} />
        </div>
        <div style={{ fontSize: 17, fontWeight: 500, letterSpacing: '-.02em', color: Q.ink900 }}>{l.name}</div>
        <div style={{ minWidth: 24, height: 24, boxSizing: 'border-box', padding: '0 6px', borderRadius: 4, background: Q.ink50, border: '1px solid ' + Q.ink100, fontSize: 13, fontWeight: 500, color: Q.ink600, display: 'flex', alignItems: 'center', justifyContent: 'center', fontVariantNumeric: 'tabular-nums', transform: 'scale(' + pop.toFixed(3) + ')' }}>{counts[i]}</div>
      </div>
    );
  });
  const cards = poses.map((p, c) => {
    const [name, no, amt, ch] = ORDERS[c]!;
    const t = TONES[LANES[p.lane]!.tone];
    const lift = p.move ? Math.sin(Math.PI * clamp01(p.u)) : 0;
    return (
      <div key={c} style={{ position: 'absolute', left: p.x - CARD_W / 2, top: p.y - CARD_H / 2, width: CARD_W, height: CARD_H, boxSizing: 'border-box', padding: '10px 12px', background: '#fff', border: '1px solid ' + (p.move ? Q.brand200 : Q.ink200), borderRadius: 8, opacity: p.o.toFixed(3), zIndex: p.move ? 5 : 1, transform: 'scale(' + (1 + 0.025 * lift).toFixed(3) + ')', boxShadow: p.move ? '0 24px 48px -12px rgba(10,37,64,.20), 0 8px 16px -8px rgba(10,37,64,.12)' : '0 8px 24px -6px rgba(10,37,64,.12), 0 2px 6px rgba(10,37,64,.06)', fontFamily: QFONT, display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ flex: 'none', width: 26, height: 26, borderRadius: '50%', background: Q.brand50, color: Q.brand700, fontSize: 12, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{name[0]}</span>
          <span style={{ fontSize: 14, fontWeight: 500, letterSpacing: '-.01em', color: Q.ink900, whiteSpace: 'nowrap' }}>{name}</span>
          <span style={{ fontFamily: QMONO, fontSize: 11, color: Q.ink500, flex: 1, whiteSpace: 'nowrap' }}>№{no}</span>
          <LIcon name={ch} size={14} color={Q.ink400} sw={1.8} />
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 20, fontWeight: 300, letterSpacing: '-.04em', color: Q.ink900, fontVariantNumeric: 'tabular-nums' }}>{amt} ₴</span>
          <span style={{ fontSize: 11, fontWeight: 500, padding: '2px 7px', borderRadius: 4, background: t[0], color: t[1], border: '1px solid ' + t[2], whiteSpace: 'nowrap' }}>{LANES[p.lane]!.badge}</span>
        </div>
      </div>
    );
  });
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{ position: 'absolute', inset: 0 }}>
        <defs>
          <linearGradient id="hs-login-rail" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2={W} y2="0">
            <stop offset="0" stopColor={Q.ink200} stopOpacity="0" />
            <stop offset=".14" stopColor={Q.ink200} />
            <stop offset="1" stopColor={Q.ink200} />
          </linearGradient>
          <linearGradient id="hs-login-lane" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={Q.ink300} />
            <stop offset="1" stopColor={Q.ink300} stopOpacity="0" />
          </linearGradient>
        </defs>
        <line x1="40" y1={OY + 80} x2={W - 40} y2={OY + 80} stroke={Q.ink200} strokeWidth="1" />
        {X.map((x, i) => <rect key={i} x={x - 0.5} y={RAIL} width="1" height={470} fill="url(#hs-login-lane)" />)}
        <rect x="0" y={RAIL - 0.5} width={W} height="1" fill="url(#hs-login-rail)" />
        {fills}
        {X.map((x, i) => <circle key={i} cx={x} cy={RAIL} r={4.5 + 3 * pulse[i]!} fill="#fff" stroke={pulse[i]! > 0 ? Q.brand600 : Q.ink300} strokeWidth="1.5" />)}
      </svg>
      {hdr}
      {cards}
    </div>
  );
}

export function LoginFlow() {
  const box = useRef<HTMLDivElement>(null);
  const T = useLoop(box, (v, dt) => (v + dt) % LOOP, 0.42 * LOOP);
  const sz = useSize(box, { w: 920, h: 900 });
  const cover = Math.max(sz.w / W, sz.h / H);
  const kb = Math.min(1.1, (sz.w - 32) / 940, (sz.h - 32) / 680);
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#fff' }} aria-hidden="true">
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: W, height: H, marginLeft: -W / 2, marginTop: -H / 2, transform: 'scale(' + cover.toFixed(4) + ')' }}>
        <Wash T={T} />
      </div>
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: W, height: H, marginLeft: -W / 2, marginTop: -580, transformOrigin: '480px 580px', transform: 'scale(' + kb.toFixed(4) + ')' }}>
        <Board T={T} />
      </div>
    </div>
  );
}
