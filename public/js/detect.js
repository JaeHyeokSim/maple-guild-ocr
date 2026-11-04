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
