// 프레임(ImageData)에서 행/열을 찾고 OCR용 칸 이미지를 만드는 순수 이미지 처리 함수 모음.

// 글자 판정 임계값(r+g+b 합). 길드창 배경은 약 160, 오프라인 회색 글자 약 540, 흰 글자 765.
export const TEXT_TH = 330;
// 이 밝기 이상이 있으면 흰 글자 = 접속 중
const ONLINE_TH = 700;

const sum = (d, i) => d[i] + d[i + 1] + d[i + 2];

// ROI 안에서 가로 투영으로 글자 줄(행)을 찾는다. 반환: [[y0, y1], ...] (프레임 절대좌표, y1 포함)
export function detectRows(img, roi) {
  const { data, width } = img;
  const prof = [];
  for (let y = roi.y; y < roi.y + roi.h; y++) {
    let c = 0;
    for (let x = roi.x; x < roi.x + roi.w; x++) if (sum(data, (y * width + x) * 4) > TEXT_TH) c++;
    prof.push(c);
  }
  const bands = [];
  let cur = null;
  prof.forEach((c, i) => {
    if (c >= 2) {
      if (cur && i - cur[1] <= 3) cur[1] = i;
      else { cur = [i, i]; bands.push(cur); }
    }
  });
  const hs = bands.map(b => b[1] - b[0] + 1).sort((a, b) => a - b);
  const median = hs[hs.length >> 1] || 0;
  // 위/아래 가장자리에서 잘린 행, 잡티 제거
  return bands
    .filter(b => b[1] - b[0] + 1 >= Math.max(4, median * 0.7))
    .map(([a, b]) => [roi.y + a, roi.y + b]);
}

// 스크롤 중 위/아래 끝에서 잘린 행, 두 행이 붙어 잡힌 덩어리를 걸러낸다.
// 모든 행에는 한글(직업·직위)이 있어 정상 행 높이가 일정하므로 가장 흔한 높이를 기준으로 삼는다.
export function fullRows(bands, roi) {
  const hs = bands.map(b => b[1] - b[0] + 1);
  const count = new Map();
  for (const h of hs) count.set(h, (count.get(h) || 0) + 1);
  const mode = [...count].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0]?.[0] ?? 0;
  return bands.filter((b, i) =>
    hs[i] >= mode && hs[i] <= mode + 2 && b[0] > roi.y && b[1] < roi.y + roi.h - 1);
}

// 세로 투영으로 7개 열 덩어리를 찾아 경계(ROI 폭 대비 비율 6개)를 돌려준다. 실패 시 null.
export function autoDividers(img, roi, rows) {
  if (!rows.length) return null;
  const { data, width } = img;
  const rowH = rows.map(r => r[1] - r[0] + 1).sort((a, b) => a - b)[rows.length >> 1];
  const runs = [];
  let cur = null;
  for (let x = roi.x; x < roi.x + roi.w; x++) {
    let hit = false;
    for (const [y0, y1] of rows) {
      for (let y = y0; y <= y1 && !hit; y++) if (sum(data, (y * width + x) * 4) > TEXT_TH) hit = true;
      if (hit) break;
    }
    if (hit) {
      if (cur && x - cur[1] < rowH * 0.8) cur[1] = x;
      else { cur = [x, x]; runs.push(cur); }
    }
  }
  if (runs.length !== 7) return null;
  const divs = [];
  for (let i = 0; i < 6; i++) divs.push(((runs[i][1] + runs[i + 1][0]) / 2 - roi.x) / roi.w);
  return divs;
}

// 경계 비율 → 열별 [x0, x1]
export function columnRects(roi, dividers) {
  const xs = [0, ...dividers, 1].map(f => Math.round(roi.x + f * roi.w));
  return xs.slice(0, -1).map((x, i) => [x, xs[i + 1]]);
}

// 이진화한 영역의 해시. 같은 행이 다시 캡처되면 같은 값이 나와 OCR 캐시 키로 쓴다.
export function regionHash(img, x0, x1, y0, y1, step = 1) {
  const { data, width } = img;
  let h = 2166136261;
  for (let y = y0; y < y1; y += step) {
    for (let x = x0; x < x1; x += step) {
      h ^= sum(data, (y * width + x) * 4) > TEXT_TH ? 1 : 0;
      h = Math.imul(h, 16777619);
    }
  }
  return (h >>> 0).toString(36);
}

// 글자 픽셀의 외곽 박스 기준 해시 — 열 경계를 조금 옮겨도, 접속(흰색)/미접속(회색)이 바뀌어도 같은 값.
export function textHash(img, x0, x1, y0, y1) {
  const box = textBox(img, x0, x1, y0, y1);
  if (!box) return null;
  const { l, r, t, b } = box;
  return `${r - l + 1}x${b - t + 1}:` + regionHash(img, l, r + 1, t, b + 1);
}

// 글자 픽셀 외곽 박스 { l, r, t, b } (포함 좌표) 또는 null
export function textBox(img, x0, x1, y0, y1) {
  const { data, width } = img;
  let l = x1, r = -1, t = y1, b = -1;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++)
      if (sum(data, (y * width + x) * 4) > TEXT_TH) {
        if (x < l) l = x;
        if (x > r) r = x;
        if (y < t) t = y;
        if (y > b) b = y;
      }
  return r < 0 ? null : { l, r, t, b };
}

// 접속 중이면 "본캐(접속캐릭)" 처럼 괄호가 붙고 길면 ".."로 잘린다. 괄호 '(' 글리프를 찾아 그 앞까지만 닉네임으로 쓴다.
const OPEN_PAREN = '124.130.257'; // 원본 배율 '(' 의 세로 열 비트마스크
export function nameEnd(img, x0, x1, y0, y1) {
  const { data, width } = img;
  const cols = [];
  for (let x = x0; x < x1; x++) {
    let m = 0;
    for (let y = y0; y < y1; y++) if (sum(data, (y * width + x) * 4) > TEXT_TH) m |= 1 << (y - y0);
    cols.push(m);
  }
  const all = cols.reduce((a, m) => a | m, 0);
  if (!all) return x1;
  const top = 31 - Math.clz32(all & -all);
  let start = -1, glyph = [];
  for (let i = 0; i <= cols.length; i++) {
    const m = cols[i] ?? 0;
    if (m) { if (start < 0) start = i; glyph.push(m >>> top); continue; }
    if (start >= 0 && glyph.join('.') === OPEN_PAREN) return x0 + start;
    start = -1;
    glyph = [];
  }
  return x1;
}

export function isOnline(img, x0, x1, y0, y1) {
  const { data, width } = img;
  for (let y = y0; y < y1; y++)
    for (let x = x0; x < x1; x++) if (sum(data, (y * width + x) * 4) > ONLINE_TH) return true;
  return false;
}

function crop(img, x0, x1, y0, y1) {
  const c = document.createElement('canvas');
  c.width = x1 - x0;
  c.height = y1 - y0;
  c.getContext('2d').putImageData(img, -x0, -y0, x0, y0, c.width, c.height);
  return c;
}

export function cropDataURL(img, x0, x1, y0, y1) {
  return crop(img, x0, x1, y0, y1).toDataURL('image/png');
}

// OCR 입력용 칸 이미지: 확대 → 이진화(흰 바탕 검은 글자) → 여백.
// mode 'fixed'는 고정 임계값, 'stretch'는 칸 안의 최소~최대 밝기 중간값을 임계값으로 쓴다(회색 글자용).
export function makeCell(img, x0, x1, y0, y1, { scale = 4, mode = 'fixed', th = TEXT_TH } = {}) {
  const small = crop(img, x0, x1, y0, y1);
  if (mode === 'stretch') {
    let mn = Infinity, mx = 0;
    const { data, width } = img;
    for (let y = y0; y < y1; y++)
      for (let x = x0; x < x1; x++) {
        const v = sum(data, (y * width + x) * 4);
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    th = (mn + mx) / 2;
  }
  const pad = 16;
  const W = small.width * scale, H = small.height * scale;
  const big = document.createElement('canvas');
  big.width = W + pad * 2;
  big.height = H + pad * 2;
  const ctx = big.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(small, pad, pad, W, H);
  const out = ctx.getImageData(0, 0, big.width, big.height);
  const d = out.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = d[i + 3] === 0 ? 0 : sum(d, i);
    const c = v > th ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = c;
    d[i + 3] = 255;
  }
  ctx.putImageData(out, 0, 0);
  return big;
}
