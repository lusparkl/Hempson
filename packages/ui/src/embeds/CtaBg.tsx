import { useRef } from 'react';
import { TAU, rnd, useLoop, useSize } from './motion';

/** Closing call-to-action background (design: cta-embed.jsx): drifting gradient with flowing strands, 12 s loop. */

const W = 1232;
const H = 552;

function strandPath(i: number, ph: number, seed: number, ampMul: number) {
  const r1 = rnd(i, seed + 1), r2 = rnd(i, seed + 2), r3 = rnd(i, seed + 3), r4 = rnd(i, seed + 4);
  const sx = -260 + rnd(i, seed + 5) * (W + 520);
  const ang = ((58 + 18 * Math.sin((sx / W) * Math.PI) + (r1 - 0.5) * 8) * Math.PI) / 180;
  const L = 700 + r2 * 500, amp = (6 + r3 * 24) * ampMul, f = 0.7 + r4 * 1.2, phi = r1 * TAU;
  const m = r2 < 0.4 ? 1 : r2 < 0.75 ? -1 : 2;
  const dx = Math.cos(ang), dy = -Math.sin(ang), nx = Math.sin(ang), ny = Math.cos(ang);
  let d = '';
  for (let j = 0; j <= 28; j++) {
    const t = j / 28;
    const off = amp * Math.sin(TAU * t * f + phi + m * ph) * Math.sin(Math.PI * t * 0.9 + 0.15);
    d += (j ? 'L' : 'M') + (sx + t * L * dx + off * nx).toFixed(1) + ',' + (H + 80 + t * L * dy + off * ny).toFixed(1);
  }
  return d;
}

function CtaBackground({ f }: { f: number }) {
  const ph = TAU * f;
  const blob = (c: string, x: number, y: number, rx: number, ry: number, ax: number, ay: number, kk: number, p: number) =>
    'radial-gradient(ellipse ' + rx + '% ' + ry + '% at ' + (x + ax * Math.sin(kk * ph + p)).toFixed(1) + '% ' + (y + ay * Math.cos(kk * ph + p)).toFixed(1) + '%,' + c + ' 0,transparent 100%)';
  const sh = 6 * Math.sin(ph);
  const bg = [
    blob('rgba(255,122,51,0.850)', 92, 100, 40, 80, 6, 10, 1, 0.5),
    blob('rgba(255,200,87,0.950)', 84, 4, 38, 70, 7, 10, 1, 2.6),
    blob('rgba(255,128,187,0.950)', 36, 46, 34, 80, 8, 14, 1, 4.1),
    blob('rgba(122,115,255,0.900)', 4, 92, 34, 80, 6, 10, 2, 1),
    blob('rgba(169,161,255,0.900)', 12, 6, 30, 70, 6, 8, 1, 5.2),
    blob('rgba(255,179,212,0.800)', 58, 100, 30, 60, 8, 8, 1, 3.3),
    'linear-gradient(' + (100 + sh).toFixed(1) + 'deg,#A9A1FF 0%,#FF80BB 38%,#FFC857 72%,#FF7A33 100%)',
  ].join(',');
  const bc = ['255,255,255', '255,128,187', '255,200,87', '122,115,255', '255,255,255', '255,122,51'];
  const paths = [];
  for (let i = 0; i < 6; i++)
    paths.push(<path key={'b' + i} d={strandPath(i, ph, 90, 2.2)} fill="none" stroke={'rgba(' + bc[i] + ',' + (0.13 + 0.05 * (i % 2)).toFixed(2) + ')'} strokeWidth={70 + rnd(i, 9) * 90} strokeLinecap="round" />);
  for (let i = 0; i < 110; i++) {
    const r = rnd(i, 21);
    const w = 0.6 + rnd(i, 22) * 1.9;
    const col =
      r < 0.5 ? 'rgba(255,255,255,' + (0.14 + rnd(i, 23) * 0.34).toFixed(2) + ')'
      : r < 0.68 ? 'rgba(255,128,187,' + (0.3 + rnd(i, 23) * 0.3).toFixed(2) + ')'
      : r < 0.84 ? 'rgba(255,200,87,' + (0.3 + rnd(i, 23) * 0.35).toFixed(2) + ')'
      : 'rgba(83,58,253,' + (0.12 + rnd(i, 23) * 0.14).toFixed(2) + ')';
    paths.push(<path key={'s' + i} d={strandPath(i, ph, 5, 1)} fill="none" stroke={col} strokeWidth={w.toFixed(2)} strokeLinecap="round" />);
  }
  const sweep = -30 + 160 * f;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#FFB3D4' }}>
      <div style={{ position: 'absolute', inset: 0, background: bg }} />
      <svg width={W} height={H} viewBox={'0 0 ' + W + ' ' + H} style={{ position: 'absolute', inset: 0 }}>
        <g transform="translate(-24,-24)">{paths}</g>
      </svg>
      <div style={{ position: 'absolute', top: -80, bottom: -80, width: 320, left: sweep + '%', transform: 'translateX(-50%) skewX(-22deg)', background: 'linear-gradient(90deg,rgba(255,255,255,0),rgba(255,255,255,.28),rgba(255,255,255,0))' }} />
    </div>
  );
}

export function CtaBg() {
  const box = useRef<HTMLDivElement>(null);
  const f = useLoop(box, (v, dt) => (v + dt / 12) % 1, 0.3);
  const { w, h } = useSize(box, { w: W, h: H });
  const sc = Math.max(w / W, h / H);
  return (
    <div ref={box} style={{ position: 'absolute', inset: 0, overflow: 'hidden' }} aria-hidden="true">
      <div style={{ position: 'absolute', left: '50%', top: '50%', width: W, height: H, marginLeft: -W / 2, marginTop: -H / 2, transform: 'scale(' + sc.toFixed(4) + ')' }}>
        <CtaBackground f={f} />
      </div>
    </div>
  );
}
