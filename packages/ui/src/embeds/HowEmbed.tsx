import { createContext, Fragment, useContext, useRef, type ReactNode } from 'react';
import { Easing, P, TAU, lerp, mix, useLoop, useSize } from './motion';

/**
 * "How it works" (design: how-embed.jsx): a three-step stepper over an order card that tells the story
 * client writes → AI drafts the order → you confirm (stock drops, customer notified, TTN created).
 */

const SCENES: Array<[string, number]> = [['Client', 6.4], ['Draft', 5.2], ['Confirm', 6], ['Reset', 1.2]];
const CUES: Record<string, number> = {};
let acc = 0;
for (const [n, d] of SCENES) {
  CUES[n] = acc;
  acc += d;
}
const AUTH_TOTAL = acc;
const D = CUES.Draft!;
const CF = CUES.Confirm!;
const R = CUES.Reset!;

const Z = {
  brand50: '#F1F0FF', brand200: '#CBC6FF', brand300: '#A9A1FF', brand600: '#533AFD', brand700: '#4228D6', brand800: '#331FA8', brand900: '#241678',
  ink900: '#0A2540', ink800: '#1F3A5C', ink700: '#425466', ink600: '#5A6D86', ink500: '#7B8CA3', ink400: '#A3AFC2', ink300: '#C9D2DF', ink200: '#DCE3EC', ink100: '#E8EDF3', ink50: '#F6F9FC',
};
const ZFONT = "'Geist','Helvetica Neue',Arial,sans-serif";
const ZMONO = "'Geist Mono',ui-monospace,Menlo,monospace";
const MOTION = { enter: Easing.easeOutCubic, glide: Easing.easeInOutCubic, pop: Easing.easeOutBack };

type Box = { x: number; y: number; w: number; h: number };
type Layout = { narrow: boolean; W: number; H: number; NODE_Y: number; CARD: Box; PANEL: Box; CX: [number, number, number] };
function layout(narrow: boolean): Layout {
  if (narrow) return { narrow, W: 480, H: 580, NODE_Y: 24, CARD: { x: 16, y: 184, w: 448, h: 356 }, PANEL: { x: 0, y: 160, w: 480, h: 404 }, CX: [80, 240, 400] };
  const W = 1232;
  return { narrow, W, H: 800, NODE_Y: 56, CARD: { x: W / 2 - 290, y: 366, w: 580, h: 356 }, PANEL: { x: 32, y: 316, w: W - 64, h: 448 }, CX: [W / 6, W / 2, (W * 5) / 6] };
}

type Step = { t: string; d: string };
const Ctx = createContext<{ T: number; L: Layout; steps: ReadonlyArray<Step> }>({ T: 0, L: layout(false), steps: [] });
const use = () => useContext(Ctx);

export const HOW_STEPS_UK: ReadonlyArray<Step> = [
  { t: 'Клієнт пише', d: 'В Instagram або у віджеті на вашому сайті. ШІ відповідає з перевірених даних каталогу: ціни, розміри, залишки.' },
  { t: 'ШІ готує замовлення', d: 'Збирає контакти, відділення Нової Пошти та спосіб оплати й створює чернетку замовлення.' },
  { t: 'Ви підтверджуєте', d: 'Один клік у кабінеті: залишки зменшуються, клієнт отримує підтвердження, створюється ТТН.' },
];

function Check({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round" style={{ display: 'block' }}>
      <path d="M5 12.5l4.5 4.5L19 7.5" />
    </svg>
  );
}

function Stepper() {
  const { T, L, steps } = use();
  let sp = P(T, D - 0.5, D + 0.7, MOTION.glide) + P(T, CF - 0.1, CF + 0.9, MOTION.glide);
  sp *= 1 - P(T, R, R + 1.2, MOTION.glide);
  const done = P(T, CF + 2.0, CF + 2.4);
  const nodes = steps.map((s, i) => {
    const reach = i === 0 ? 1 : P(sp, i - 0.25, i, MOTION.glide);
    const act = Math.max(0, 1 - Math.abs(sp - i) * 1.8);
    const chk = i < 2 ? P(sp, i + 0.55, i + 0.9) : done * (1 - P(T, R, R + 0.5));
    const pul = act * (0.5 + 0.5 * Math.sin(T * 3.2));
    const x = L.CX[i as 0 | 1 | 2];
    return (
      <Fragment key={i}>
        <div style={{ position: 'absolute', left: x - 24, top: L.NODE_Y, width: 48, height: 48, boxSizing: 'border-box', borderRadius: 8, background: mix('#FFFFFF', Z.brand600, reach), border: '1px solid ' + mix(Z.ink200, Z.brand600, reach), color: mix(Z.ink400, '#FFFFFF', reach), display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 500, transform: 'scale(' + (1 + 0.06 * act).toFixed(3) + ')', boxShadow: '0 0 0 ' + (4 + 5 * pul).toFixed(1) + 'px rgba(83,58,253,' + (0.2 * act * (1 - 0.4 * pul)).toFixed(3) + '), 0 ' + (8 * act).toFixed(1) + 'px ' + (20 * act).toFixed(1) + 'px -6px rgba(83,58,253,' + (0.45 * act).toFixed(3) + ')' }}>
          <span style={{ position: 'absolute', opacity: 1 - chk, transform: 'scale(' + (1 - 0.4 * chk).toFixed(3) + ')' }}>{i + 1}</span>
          <span style={{ position: 'absolute', opacity: chk, transform: 'scale(' + (0.6 + 0.4 * chk).toFixed(3) + ')' }}>
            <Check size={22} />
          </span>
        </div>
        <div style={{ position: 'absolute', left: x - (L.narrow ? 76 : 170), top: L.NODE_Y + (L.narrow ? 62 : 70), width: L.narrow ? 152 : 340, textAlign: 'center', fontSize: L.narrow ? 17 : 24, lineHeight: L.narrow ? 1.25 : undefined, fontWeight: 500, letterSpacing: '-.025em', color: mix(Z.ink500, Z.ink900, Math.max(act, reach * 0.35)), opacity: 0.6 + 0.4 * Math.max(act, reach * 0.5) }}>{s.t}</div>
        {!L.narrow && <div style={{ position: 'absolute', left: x - 150, top: L.NODE_Y + 114, width: 300, textAlign: 'center', fontSize: 15, lineHeight: 1.55, color: mix(Z.ink400, Z.ink700, Math.max(act, reach * 0.3)), opacity: 0.7 + 0.3 * act }}>{s.d}</div>}
      </Fragment>
    );
  });
  const seg = (k: 0 | 1) => {
    const x0 = L.CX[k] + 24 + 14;
    const x1 = L.CX[(k + 1) as 1 | 2] - 24 - 14;
    const f = P(sp, k, k + 1, null);
    const hd = x0 + (x1 - x0) * f;
    return (
      <Fragment key={'s' + k}>
        <div style={{ position: 'absolute', left: x0, top: L.NODE_Y + 23, width: x1 - x0, height: 2, background: Z.ink100, borderRadius: 1 }} />
        <div style={{ position: 'absolute', left: x0, top: L.NODE_Y + 23, width: (x1 - x0) * f, height: 2, borderRadius: 1, background: 'linear-gradient(90deg,' + Z.brand300 + ',' + Z.brand600 + ')' }} />
        {f > 0.01 && f < 0.995 && <div style={{ position: 'absolute', left: hd - 28, top: L.NODE_Y + 21, width: 56, height: 6, borderRadius: 3, background: 'radial-gradient(closest-side,rgba(83,58,253,.55),rgba(83,58,253,0))' }} />}
        {f > 0.01 && f < 0.995 && <div style={{ position: 'absolute', left: hd - 4, top: L.NODE_Y + 20, width: 8, height: 8, borderRadius: '50%', background: '#fff', border: '2px solid ' + Z.brand600, boxSizing: 'border-box' }} />}
      </Fragment>
    );
  };
  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      {seg(0)}
      {seg(1)}
      {nodes}
    </div>
  );
}

function PanelBg() {
  const { T, L } = use();
  const f = T / AUTH_TOTAL;
  const ph = TAU * f;
  const blob = (c: string, x: number, y: number, rx: number, ry: number, ax: number, ay: number, k: number, p: number) =>
    'radial-gradient(ellipse ' + rx + '% ' + ry + '% at ' + (x + ax * Math.sin(k * ph + p)).toFixed(1) + '% ' + (y + ay * Math.cos(k * ph + p)).toFixed(1) + '%,' + c + ' 0,transparent 100%)';
  const bg = [blob('rgba(255,128,187,.34)', 92, 100, 46, 70, 6, 8, 1, 0), blob('rgba(255,200,87,.34)', 98, 0, 40, 60, 5, 8, 1, 2), blob('rgba(122,115,255,.32)', 2, 100, 44, 70, 6, 8, 1, 4), blob('rgba(128,233,255,.22)', 6, 0, 36, 54, 6, 8, 2, 1)].join(',');
  const sd = 56 * f;
  return (
    <div style={{ position: 'absolute', left: L.PANEL.x, top: L.PANEL.y, width: L.PANEL.w, height: L.PANEL.h, boxSizing: 'border-box', border: '1px solid ' + Z.brand200, borderRadius: L.narrow ? 0 : 8, borderLeftWidth: L.narrow ? 0 : 1, borderRightWidth: L.narrow ? 0 : 1, overflow: 'hidden', background: Z.brand50 }}>
      <div style={{ position: 'absolute', inset: 0, background: bg }} />
      <div style={{ position: 'absolute', inset: -60, transform: 'translate(' + (0.906 * sd).toFixed(2) + 'px,' + (0.423 * sd).toFixed(2) + 'px)', background: 'repeating-linear-gradient(115deg,rgba(255,255,255,.4) 0 1px,transparent 1px 7px)' }} />
    </div>
  );
}

function Dots({ T }: { T: number }) {
  return (
    <div style={{ display: 'flex', gap: 5, padding: '14px 16px' }}>
      {[0, 1, 2].map((i) => {
        const s = 0.5 + 0.5 * Math.sin(T * 7 - i * 0.9);
        return <span key={i} style={{ width: 7, height: 7, borderRadius: '50%', background: Z.brand600, opacity: 0.35 + 0.65 * s, transform: 'translateY(' + (-2.5 * s).toFixed(2) + 'px)' }} />;
      })}
    </div>
  );
}

function Row({ side, t0, t1, children }: { side: 'in' | 'out'; t0: number | null; t1: number; children: ReactNode }) {
  const { T } = use();
  const out = side === 'out';
  const a = t0 == null ? 1 : P(T, t0, t0 + 0.4, MOTION.enter);
  const b = P(T, t1, t1 + 0.5, MOTION.enter);
  const swapped = T >= t1;
  const maxH = t0 == null ? 140 * b : 50 * a + 100 * b;
  const pop = P(T, t1, t1 + 0.55, MOTION.pop);
  const bub = { maxWidth: 400, padding: '10px 14px', borderRadius: 8, fontSize: 15, lineHeight: 1.45 };
  return (
    <div style={{ boxSizing: 'border-box', display: 'flex', justifyContent: out ? 'flex-end' : 'flex-start', padding: '5px 0', overflow: 'hidden', maxHeight: maxH, opacity: t0 == null ? Math.min(1, b * 1.6) : Math.min(1, a * 1.6) }}>
      {!swapped && t0 != null && (
        <div style={{ ...bub, padding: 0, background: Z.brand50, border: '1px solid ' + Z.brand200, transform: 'translateY(' + (1 - a) * 10 + 'px)' }}>
          <Dots T={T} />
        </div>
      )}
      {swapped && (
        <div style={{ ...bub, background: out ? Z.brand50 : '#fff', border: '1px solid ' + (out ? Z.brand200 : Z.ink200), color: out ? Z.brand900 : Z.ink800, transformOrigin: out ? 'bottom right' : 'bottom left', transform: 'scale(' + (0.92 + 0.08 * pop).toFixed(3) + ') translateY(' + ((1 - b) * 8).toFixed(2) + 'px)', opacity: Math.min(1, b * 2) }}>
          {children}
        </div>
      )}
    </div>
  );
}

function ChatLayer() {
  const { T } = use();
  const o = P(T, 0, 0.5, MOTION.enter) * (1 - P(T, D - 0.1, D + 0.45, MOTION.glide));
  const lift = -14 * P(T, D - 0.1, D + 0.45, MOTION.glide);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, transform: 'translateY(' + lift.toFixed(2) + 'px)' }}>
      <div style={{ height: 70, boxSizing: 'border-box', padding: '0 24px', display: 'flex', alignItems: 'center', gap: 12, borderBottom: '1px solid ' + Z.ink100 }}>
        <span style={{ width: 38, height: 38, borderRadius: '50%', background: Z.brand50, color: Z.brand700, fontWeight: 500, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>О</span>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 15, fontWeight: 500, color: Z.ink900 }}>Олена Ковальчук</div>
          <div style={{ fontSize: 12, color: Z.ink500 }}>Instagram · Лавка Софії</div>
        </div>
        <span style={{ fontSize: 12, fontWeight: 500, padding: '3px 9px', borderRadius: 4, background: '#DDF3E5', color: '#0B6441', border: '1px solid #A9DDBD' }}>ШІ</span>
      </div>
      <div style={{ padding: '14px 24px', display: 'flex', flexDirection: 'column' }}>
        <Row side="in" t0={null} t1={0.6}>Чи є льняна сумка кольору «пісок»?</Row>
        <Row side="out" t0={1.5} t1={3.0}>Так, є 4 шт. — 640 ₴. Оформити з доставкою Новою Поштою?</Row>
        <Row side="in" t0={null} t1={4.3}>Так, у Дніпро, відділення 12</Row>
        <Row side="out" t0={5.1} t1={D + 2}>…</Row>
      </div>
    </div>
  );
}

function StatusBadge({ k }: { k: number }) {
  const st = { gridArea: '1 / 1', textAlign: 'center' as const, whiteSpace: 'nowrap' as const };
  return (
    <span style={{ display: 'inline-grid', fontSize: 13, fontWeight: 500, padding: '3px 10px', borderRadius: 4, background: mix('#FDF0D0', '#DDF3E5', k), color: mix('#7A4F05', '#0B6441', k), border: '1px solid ' + mix('#F1D48C', '#A9DDBD', k) }}>
      <span style={{ ...st, opacity: 1 - k }}>Очікує</span>
      <span style={{ ...st, opacity: k }}>Підтверджено</span>
    </span>
  );
}

function OrderLayer() {
  const { T } = use();
  const o = P(T, D + 0.15, D + 0.75, MOTION.enter);
  const rise = (1 - o) * 16;
  const amt = 1280 * P(T, D + 0.8, D + 2.0, MOTION.glide);
  const k = P(T, CF + 0.1, CF + 0.8, MOTION.glide);
  const badge = P(T, D + 1.9, D + 2.4, MOTION.pop);
  const rows = [
    { at: D + 1.2, l: 'Лляна сумка · пісок × 2', r: 'BAG-LN-SND' },
    { at: D + 1.7, l: 'Олена Ковальчук · +380671234567' },
    { at: D + 2.2, l: 'Дніпро, НП №12 · накладений платіж' },
  ];
  const stock = P(T, CF + 1.2, CF + 1.7, MOTION.glide);
  const tgt = '20450912345678';
  const ttn = tgt.slice(0, Math.floor(tgt.length * P(T, CF + 2.6, CF + 3.9)));
  const confirmed = [
    <span key="a" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span style={{ flex: 1 }}>Залишок сумки «пісок»</span>
      <span style={{ position: 'relative', height: 22, width: 62, overflow: 'hidden', color: Z.ink600, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ position: 'absolute', right: 0, top: 0, transform: 'translateY(' + -22 * stock + 'px)', opacity: 1 - stock }}>4 → 4</span>
        <span style={{ position: 'absolute', right: 0, top: 0, transform: 'translateY(' + 22 * (1 - stock) + 'px)', opacity: stock, color: Z.ink900, fontWeight: 500 }}>4 → 2</span>
      </span>
    </span>,
    <span key="b" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span style={{ flex: 1 }}>Клієнт отримав підтвердження в Instagram</span>
      <span style={{ width: 20, height: 20, borderRadius: '50%', background: '#0B6441', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'scale(' + P(T, CF + 1.9, CF + 2.4, MOTION.pop).toFixed(3) + ')' }}>
        <Check size={12} />
      </span>
    </span>,
    <span key="c" style={{ display: 'flex', alignItems: 'center', gap: 10, width: '100%' }}>
      <span style={{ flex: 1 }}>ТТН Нової Пошти</span>
      <span style={{ fontFamily: ZMONO, fontSize: 13, color: Z.ink900 }}>{ttn}</span>
    </span>,
  ];
  const press = P(T, CF - 0.5, CF - 0.3) * (1 - P(T, CF - 0.15, CF + 0.2));
  const btnO = 1 - P(T, CF, CF + 0.45);
  return (
    <div style={{ position: 'absolute', inset: 0, opacity: o, transform: 'translateY(' + rise.toFixed(2) + 'px)' }}>
      <div style={{ position: 'absolute', left: 24, top: 22, right: 24, display: 'flex', alignItems: 'flex-start' }}>
        <div style={{ flex: 1 }}>
          <div style={{ position: 'relative', height: 18, fontSize: 13, color: Z.ink500 }}>
            <span style={{ position: 'absolute', opacity: 1 - k, whiteSpace: 'nowrap' }}>Чернетка замовлення · створив ШІ</span>
            <span style={{ position: 'absolute', opacity: k, whiteSpace: 'nowrap' }}>Замовлення підтверджено</span>
          </div>
          <div style={{ fontSize: 38, fontWeight: 300, letterSpacing: '-.04em', color: Z.ink900, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>{Math.round(amt).toLocaleString('uk-UA')} ₴</div>
        </div>
        <div style={{ opacity: badge > 0 ? 1 : 0, transform: 'scale(' + (0.6 + 0.4 * badge).toFixed(3) + ')', transformOrigin: 'top right' }}>
          <StatusBadge k={k} />
        </div>
      </div>
      {rows.map((r, i) => {
        const p = P(T, r.at, r.at + 0.5, MOTION.enter);
        const tk = P(T, r.at + 0.35, r.at + 0.75, MOTION.pop);
        const cp = P(T, CF + 0.25 + i * 0.12, CF + 0.7 + i * 0.12, MOTION.glide);
        return (
          <div key={i} style={{ position: 'absolute', left: 24, right: 24, top: 118 + i * 56, height: 46, boxSizing: 'border-box', padding: '0 14px', display: 'flex', alignItems: 'center', gap: 12, border: '1px solid ' + Z.ink100, borderRadius: 6, background: Z.ink50, fontSize: 15, color: Z.ink800, opacity: p, transform: 'translateX(' + ((1 - p) * -16).toFixed(2) + 'px)' }}>
            <span style={{ position: 'relative', flex: 'none', width: 18, height: 18, borderRadius: '50%', border: '1px solid ' + Z.ink300, opacity: 1 - cp, boxSizing: 'border-box' }}>
              <span style={{ position: 'absolute', inset: -1, borderRadius: '50%', background: Z.brand600, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: 'scale(' + tk.toFixed(3) + ')' }}>
                <Check size={11} />
              </span>
            </span>
            <span style={{ flex: 1, display: 'flex', alignItems: 'center', opacity: 1 - cp, whiteSpace: 'nowrap' }}>
              <span style={{ flex: 1 }}>{r.l}</span>
              {r.r && <span style={{ fontFamily: ZMONO, fontSize: 12, color: Z.ink500 }}>{r.r}</span>}
            </span>
            <span style={{ position: 'absolute', left: 14, right: 14, display: 'flex', alignItems: 'center', opacity: cp, transform: 'translateY(' + ((1 - cp) * 8).toFixed(2) + 'px)' }}>{confirmed[i]}</span>
          </div>
        );
      })}
      <div style={{ position: 'absolute', right: 24, top: 292, height: 44, boxSizing: 'border-box', padding: '0 22px', display: 'flex', alignItems: 'center', gap: 8, borderRadius: 4, background: mix(Z.brand600, Z.brand800, press), color: '#fff', fontSize: 15, fontWeight: 500, opacity: btnO * P(T, D + 2.6, D + 3.1), transform: 'translateY(' + press.toFixed(2) + 'px) scale(' + (1 - 0.03 * press).toFixed(3) + ')', boxShadow: '0 ' + (6 - 4 * press) + 'px 16px -6px rgba(83,58,253,.5)' }}>
        Підтвердити замовлення <span style={{ fontSize: 18 }}>›</span>
      </div>
    </div>
  );
}

function Cursor() {
  const { T, L } = use();
  const bx = L.CARD.x + L.CARD.w - 24 - 80;
  const by = L.CARD.y + 292 + 24;
  const p = P(T, D + 3.0, D + 4.5, MOTION.glide);
  const x = lerp(bx + 150, bx, p);
  const y = lerp(by + 110, by, p);
  const o = P(T, D + 3.0, D + 3.4) * (1 - P(T, CF + 0.4, CF + 0.9));
  const click = P(T, CF - 0.5, CF - 0.35) * (1 - P(T, CF - 0.3, CF + 0.1));
  const ring = P(T, CF - 0.5, CF + 0.4, MOTION.enter);
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, opacity: o, zIndex: 20 }}>
      {ring > 0 && ring < 1 && <div style={{ position: 'absolute', left: bx - 18 * (0.4 + ring), top: by - 18 * (0.4 + ring), width: 36 * (0.4 + ring), height: 36 * (0.4 + ring), borderRadius: '50%', border: '2px solid ' + Z.brand600, opacity: 0.5 * (1 - ring) }} />}
      <svg width="26" height="26" viewBox="0 0 24 24" style={{ position: 'absolute', left: x - 4, top: y - 3, transform: 'scale(' + (1 - 0.15 * click).toFixed(3) + ')', filter: 'drop-shadow(0 3px 5px rgba(10,37,64,.3))' }}>
        <path d="M4 2.5l15 8.2-6.4 1.9L9.8 19z" fill={Z.ink900} stroke="#fff" strokeWidth="1.6" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function Card() {
  const { T, L } = use();
  const fade = 1 - P(T, R, R + 0.7, MOTION.glide);
  const float = 3 * Math.sin(((TAU * T) / 18.8) * 2);
  return (
    <div style={{ position: 'absolute', left: L.CARD.x, top: L.CARD.y + float, width: L.CARD.w, height: L.CARD.h, boxSizing: 'border-box', background: '#fff', border: '1px solid ' + Z.ink200, borderRadius: 8, boxShadow: '0 24px 48px -12px rgba(40,30,120,.22), 0 8px 16px -8px rgba(10,37,64,.12)', overflow: 'hidden' }}>
      <div style={{ position: 'absolute', inset: 0, opacity: fade }}>
        <ChatLayer />
        <OrderLayer />
      </div>
    </div>
  );
}

/** `steps` are the three step titles and texts (localised by the caller; the demo card stays Ukrainian). */
export function HowEmbed({ steps = HOW_STEPS_UK }: { steps?: ReadonlyArray<Step> }) {
  const box = useRef<HTMLDivElement>(null);
  const T = useLoop(box, (v, dt) => (v + dt) % AUTH_TOTAL, CF + 4.8);
  const { w } = useSize(box, { w: 1232, h: 800 });
  const L = layout(w < 900);
  const sc = Math.min(1, w / L.W);
  return (
    <div ref={box} style={{ position: 'relative', width: '100%', height: L.H * sc, overflow: 'hidden', background: '#fff' }}>
      <div style={{ position: 'absolute', left: (w - L.W * sc) / 2, top: 0, width: L.W, height: L.H, transform: 'scale(' + sc.toFixed(4) + ')', transformOrigin: '0 0' }}>
        <Ctx.Provider value={{ T, L, steps }}>
          <div style={{ position: 'absolute', inset: 0, background: '#fff', fontFamily: ZFONT, letterSpacing: '-.01em', overflow: 'hidden' }}>
            <Stepper />
            <PanelBg />
            <Card />
            <Cursor />
          </div>
        </Ctx.Provider>
      </div>
    </div>
  );
}
