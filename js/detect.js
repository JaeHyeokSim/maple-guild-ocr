// 길드창 표 영역 자동 감지.
// 표 머리글 바는 [짙은 선 / 바로 아래 밝은 선 / 25px 아래 짙은 선]이 같은 폭(원본 배율 511px)으로 그려진다.
// 이 머리글 바 바로 아래부터 19행(26px 간격)이 길드원 목록이다.
const DARK = [31, 37, 42];
const LIGHT = [90, 104, 113];
const BASE_W = 511, HEADER_H = 25, BODY_H = 500, SCROLLBAR_W = 6;
const MIN_RUN = 250;

const near = (d, i, c, t = 10) =>
  Math.abs(d[i] - c[0]) <= t && Math.abs(d[i + 1] - c[1]) <= t && Math.abs(d[i + 2] - c[2]) <= t;

function coverage(img, x0, x1, y, color) {
  const { data, width } = img;
  let n = 0;
  for (let x = x0; x <= x1; x++) if (near(data, (y * width + x) * 4, color)) n++;
  return n / (x1 - x0 + 1);
}

function verify(img, x0, x1, y) {
  if (coverage(img, x0, x1, y + 1, LIGHT) < 0.9) return null;
  const s = (x1 - x0 + 1) / BASE_W;
  const hb = Math.round(HEADER_H * s);
  for (let d = hb - 2; d <= hb + 2; d++) {
    const yb = y + d;
    if (yb >= img.height || coverage(img, x0, x1, yb, DARK) < 0.9) continue;
    const top = yb + 1;
    return {
      x: x0,
      y: top,
      w: x1 - x0 + 1 - Math.round(SCROLLBAR_W * s),
      h: Math.min(Math.round(BODY_H * s), img.height - top),
    };
  }
  return null;
}

// 전체 프레임에서 표를 찾는다. 반환: ROI 또는 null
export function findTable(img) {
  const { data, width, height } = img;
  for (let y = 0; y < height - 30; y++) {
    let run = 0, start = 0;
    for (let x = 0; x <= width; x++) {
      if (x < width && near(data, (y * width + x) * 4, DARK)) {
        if (!run) start = x;
        run++;
        continue;
      }
      if (run >= MIN_RUN) {
        const roi = verify(img, start, start + run - 1, y);
        if (roi) return roi;
      }
      run = 0;
    }
  }
  return null;
}

// ROI 바로 위 줄(머리글 아래 짙은 선)이 그대로인지 — 창이 움직였는지 빠르게 확인. line: ROI 폭 x 1px ImageData
export function headerStillThere(line) {
  return coverage(line, 0, line.width - 1, 0, DARK) >= 0.9;
}

// 해상도에 따라 게임이 UI를 확대·축소해 그린 화면(1366x768 기준 — 1920x1080이면 1.406배)에서 표를 찾는다.
// 색이 보간으로 섞이므로 정확한 색 대신 "위·아래보다 어두운 가로선"으로 머리글 바를 찾고, 그 폭으로 배율을 잰다.
// 크게 확대되면 1px 선이 2~3px 띠가 되므로 띠의 맨 아랫줄(바로 아래가 밝은 줄)을 선으로 본다.
// 반환: { scale, roi(원래 배율 좌표) } 또는 null
// 선 길이로 잰 배율은 끝 픽셀 보간 때문에 0.5%쯤 어긋날 수 있다(500px 표 아래쪽에서 2~3px).
// 게임 화면 크기에서 나온 배율(가로/1366, 세로/768)이나 흔한 윈도우 배율과 가까우면 그 값으로 맞춘다.
const COMMON_SCALES = [1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 3];
function snapScale(s, width, height) {
  const cands = [...COMMON_SCALES, width / 1366, height / 768];
  let best = s, bd = 0.015;
  for (const c of cands) { const d = Math.abs(c - s) / c; if (d < bd) { bd = d; best = c; } }
  return best;
}

const MIN_SCALE = 0.5, MAX_SCALE = 3.2, GAP = 8;
export function findTableScaled(img) {
  const { data, width, height } = img;
  const sum = (x, y) => { const i = (y * width + x) * 4; return data[i] + data[i + 1] + data[i + 2]; };
  // 선: 아래(1~2줄)보다 확실히 어둡고, 위(1~3줄) 어딘가보다 어두운 픽셀
  const isLine = (x, y) => {
    const v = sum(x, y);
    if (v >= 200) return false;
    if (v + 25 >= Math.max(sum(x, y + 1), sum(x, y + 2))) return false;
    for (let k = 1; k <= 3 && y - k >= 0; k++) if (v + 10 < sum(x, y - k)) return true;
    return false;
  };
  // 한 줄의 가로선 구간들 [x0, x1, 선 픽셀 수] — 글자·보간 때문에 짧게 끊긴 곳(GAP 이하)은 잇는다
  const cache = new Map();
  const runs = y => {
    if (cache.has(y)) return cache.get(y);
    const out = [];
    let x0 = -1, last = -1, n = 0;
    for (let x = 0; x < width; x++) {
      if (!isLine(x, y)) continue;
      if (x0 >= 0 && x - last - 1 > GAP) { out.push([x0, last, n]); x0 = -1; }
      if (x0 < 0) { x0 = x; n = 0; }
      last = x; n++;
    }
    if (x0 >= 0) out.push([x0, last, n]);
    const good = out.filter(([a, b, k]) => b - a + 1 >= BASE_W * MIN_SCALE * 0.9 && k / (b - a + 1) >= 0.8);
    cache.set(y, good);
    return good;
  };
  for (let y = 3; y < height - 40; y++) {
    for (const [x0, x1] of runs(y)) {
      const s = (x1 - x0 + 1) / BASE_W;
      if (s > MAX_SCALE) continue;
      // 머리글 높이(25px x 배율)만큼 아래에 양끝이 같은 어두운 선이 있어야 한다
      const hb = Math.round(HEADER_H * s), tol = Math.max(2, Math.ceil(s));
      for (let d = hb - tol; d <= hb + tol; d++) {
        const yb = y + d;
        if (yb + 2 >= height) break;
        if (!runs(yb).some(([a, b]) => Math.abs(a - x0) <= tol && Math.abs(b - x1) <= tol)) continue;
        const scale = snapScale(s, width, height);
        const top = Math.round((yb + 1) / scale);
        return {
          scale,
          roi: {
            x: Math.round(x0 / scale),
            y: top,
            w: BASE_W - SCROLLBAR_W,
            h: Math.min(BODY_H, Math.floor(height / scale) - top),
          },
        };
      }
    }
  }
  return null;
}

// 머리글 바(ROI 바로 위 몇 줄)의 모양이 그대로인지 — 배율과 상관없이 쓰도록 처음 찾았을 때와 비교한다.
// 머리글은 스크롤해도 움직이지 않으므로 달라졌으면 창이 옮겨진 것.
export function headerStrip(ctx, roi) {
  const h = Math.min(4, roi.y);
  return h > 0 ? ctx.getImageData(roi.x, roi.y - h, roi.w, h).data : null;
}
export function sameStrip(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0, n = 0;
  for (let i = 0; i < a.length; i += 4) { diff += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]); n++; }
  return diff / n < 24;
}
