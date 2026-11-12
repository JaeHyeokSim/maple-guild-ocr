// 게임 숫자 비트맵 폰트 템플릿 매칭. 원본 해상도(100% 배율) 캡처에서는 Tesseract보다 정확하고 빠르다.
// 템플릿: 글자별 세로 열 비트마스크(bit0 = 숫자 윗줄), '.'로 구분.
import { TEXT_TH } from './segment.js';

const TEMPLATES = {
  '0': '126.129.129.129.126',
  '1': '2.255',
  '2': '134.193.161.145.142',
  '3': '66.137.137.137.118',
  '4': '56.36.34.255.32',
  '5': '95.137.137.137.113',
  '6': '126.137.137.137.114',
  '7': '1.1.225.25.7',
  '8': '118.137.137.137.118',
  '9': '78.145.145.145.126',
  ',': '256.128',
};
const LOOKUP = new Map(Object.entries(TEMPLATES).map(([ch, key]) => [key, ch]));

// 칸 안의 숫자를 읽는다. 모르는 모양이 하나라도 있으면 null(배율이 다르거나 숫자가 아님).
export function readDigits(img, x0, x1, y0, y1) {
  if (y1 - y0 > 30) return null;
  const { data, width } = img;
  const cols = [];
  for (let x = x0; x < x1; x++) {
    let m = 0;
    for (let y = y0; y < y1; y++) {
      const i = (y * width + x) * 4;
      if (data[i] + data[i + 1] + data[i + 2] > TEXT_TH) m |= 1 << (y - y0);
    }
    cols.push(m);
  }
  const all = cols.reduce((a, m) => a | m, 0);
  if (!all) return null;
  const top = 31 - Math.clz32(all & -all); // 가장 위에 있는 글자 픽셀 줄
  let text = '', glyph = [];
  for (const m of [...cols, 0]) {
    if (m) { glyph.push(m >>> top); continue; }
    if (!glyph.length) continue;
    const ch = LOOKUP.get(glyph.join('.'));
    if (ch === undefined) return null;
    text += ch;
    glyph = [];
  }
  return text;
}

// ── 확대·축소된 화면(배율 ≠ 1)을 원래 배율로 줄인 칸: 글자가 회색으로 번져 위 완전 일치가 안 된다.
// 숫자 템플릿을 소수 픽셀만큼 옮겨 쌍선형으로 번지게 그린 모양과 최소제곱으로 비교해 가장 닮은 숫자를 고른다.
// 5와 6처럼 픽셀 한두 개만 다른 숫자는 1·2등 차이가 작으면 unsure로 돌려 확인 칸(노란색)으로 보낸다.
const GLYPH_H = 8;
const BLUR_DIGITS = Object.entries(TEMPLATES).filter(([ch]) => ch !== ',').map(([ch, key]) => {
  const cols = key.split('.').map(Number);
  return { ch, w: cols.length, px: (x, y) => (cols[x] >> y) & 1 };
});
const SUB = [0, 0.2, 0.4, 0.6, 0.8];
const tent = (t, s) => Math.max(0, 1 - Math.abs(t) / s);
// 2등 잔차가 1등보다 이만큼(비율) 크지 않으면 확인 필요. 1.407배 제보 88칸에서 정답 글자의 최소값은 1.08.
const UNSURE_MARGIN = 0.4;

// 템플릿 g를 (ox, oy)에 놓고 번지게 그렸을 때 (x, y) 칸의 값
function renderAt(g, ox, oy, s, x, y) {
  let v = 0;
  const u0 = Math.max(0, Math.floor(x - ox - s)), u1 = Math.min(g.w - 1, Math.ceil(x - ox + s));
  const v0 = Math.max(0, Math.floor(y - oy - s)), v1 = Math.min(GLYPH_H - 1, Math.ceil(y - oy + s));
  for (let u = u0; u <= u1; u++) {
    const kx = tent(x - ox - u, s);
    if (!kx) continue;
    for (let w = v0; w <= v1; w++) if (g.px(u, w)) v += kx * tent(y - oy - w, s);
  }
  return v;
}

// 글자 한 덩어리(열 a..b)에 가장 잘 맞는 숫자. 잔차는 최적 밝기 배율을 곱한 뒤의 제곱오차.
function bestDigit(ink, W, H, a, b, top) {
  const x0 = Math.max(0, a - 1), x1 = Math.min(W - 1, b + 1);
  const y0 = Math.max(0, top - 2), y1 = Math.min(H - 1, top + GLYPH_H + 1);
  let oo = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) oo += ink[y * W + x] ** 2;
  const best = new Map();
  for (const g of BLUR_DIGITS) {
    if (g.w > b - a + 3 || g.w < b - a - 2) continue; // 덩어리 폭과 동떨어진 숫자는 제외
    let r = Infinity;
    for (const s of [1, 1.25])
      for (let iy = top - 1; iy <= top; iy++) for (const fy of SUB)
        for (let ix = a - 1; ix <= b - g.w + 1; ix++) for (const fx of SUB) {
          const ox = ix + fx, oy = iy + fy;
          let ot = 0, tt = 0;
          for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
            const t = renderAt(g, ox, oy, s, x, y);
            if (!t) continue;
            ot += ink[y * W + x] * t;
            tt += t * t;
          }
          if (tt && ot > 0) r = Math.min(r, oo - ot * ot / tt);
        }
    best.set(g.ch, r);
  }
  const sorted = [...best].sort((p, q) => p[1] - q[1]);
  if (!sorted.length) return null;
  const [c1, r1] = sorted[0], r2 = sorted[1]?.[1] ?? Infinity;
  return { ch: c1, margin: (r2 - r1) / Math.max(r1, oo * 0.02) };
}

// 반환: { text, margin(가장 애매한 글자의 1·2등 차이), unsure } 또는 null(숫자 덩어리를 못 찾음)
export function readDigitsBlurred(img, x0, x1, y0, y1) {
  const { data, width } = img;
  const W = x1 - x0, H = y1 - y0;
  const vals = [];
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * width + x) * 4;
    vals.push(data[i] + data[i + 1] + data[i + 2]);
  }
  const bg = [...vals].sort((p, q) => p - q)[vals.length >> 1];
  const peak = Math.max(...vals);
  if (peak - bg < 120) return null;
  const ink = Float32Array.from(vals, v => Math.max(0, v - bg) / (peak - bg));
  // 글자 줄: 행별 최대 잉크로 숫자 윗줄 추정
  const rowMax = [], colMax = [];
  for (let y = 0; y < H; y++) { let m = 0; for (let x = 0; x < W; x++) m = Math.max(m, ink[y * W + x]); rowMax.push(m); }
  const lit = rowMax.map((m, y) => m > 0.35 ? y : -1).filter(y => y >= 0);
  if (!lit.length) return null;
  const top = lit[0], bottom = lit.at(-1);
  // 열 덩어리
  for (let x = 0; x < W; x++) { let m = 0; for (let y = 0; y < H; y++) m = Math.max(m, ink[y * W + x]); colMax.push(m); }
  const runs = [];
  let cur = null;
  colMax.forEach((m, x) => {
    if (m > 0.3) { if (cur) cur[1] = x; else runs.push(cur = [x, x]); }
    else cur = null;
  });
  // 숫자 사이 빈 열이 번져 두 글자가 붙으면, 안쪽에서 가장 어두운 열을 경계로 나눈다(숫자 폭 최대 5).
  for (let i = 0; i < runs.length; i++) {
    const [a, b] = runs[i];
    if (b - a <= 6) continue;
    let cut = -1;
    for (let x = a + 2; x <= b - 2; x++) if (cut < 0 || colMax[x] < colMax[cut]) cut = x;
    runs.splice(i, 1, [a, cut - 1], [cut + 1, b]);
    i--;
  }
  let text = '', margin = Infinity;
  for (const [a, b] of runs) {
    // 쉼표: 폭이 좁고 잉크가 숫자 아랫부분에만 있다
    let inkTop = H;
    for (let y = 0; y < H && inkTop === H; y++) for (let x = a; x <= b; x++) if (ink[y * W + x] > 0.35) { inkTop = y; break; }
    if (b - a <= 2 && inkTop >= top + GLYPH_H - 3) { text += ','; continue; }
    const d = bestDigit(ink, W, H, a, b, top);
    if (!d) return null;
    text += d.ch;
    margin = Math.min(margin, d.margin);
  }
  if (!text || bottom - top > GLYPH_H + 3) return null;
  return { text, margin, unsure: margin < UNSURE_MARGIN };
}
