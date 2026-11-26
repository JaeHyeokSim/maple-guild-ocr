// 경매장 "거래 기록 → 판매 완료" 캡처에서 판매 금액을 읽는다.
// 캡처 전체를 흑백 반전·확대해 Tesseract(kor)로 읽고, 텍스트에서 "N억 NNNN만 NNNN" 금액을 찾는다.

let workerPromise = null;

export function initAuctionOcr(onStatus) {
  if (!workerPromise) {
    workerPromise = Tesseract.createWorker('kor', 1, {
      logger: m => {
        if (m.status !== 'recognizing text' && m.progress < 1) onStatus?.(`kor ${m.status} ${Math.round(m.progress * 100)}%`);
      },
    });
  }
  return workerPromise;
}

let digitWorkerPromise = null;
function digitWorker() {
  if (!digitWorkerPromise) {
    digitWorkerPromise = Tesseract.createWorker('eng').then(async w => {
      await w.setParameters({ tessedit_char_whitelist: '0123456789', tessedit_pageseg_mode: '7' });
      return w;
    });
  }
  return digitWorkerPromise;
}

// 어두운 배경의 밝은 글씨 → 흰 배경 검은 글씨, 작은 캡처는 2배 확대
// lum: 반전 전 밝기 (페이지 번호 박스 찾기용)
function preprocess(src) {
  const w = src.videoWidth || src.naturalWidth || src.width;
  const h = src.videoHeight || src.naturalHeight || src.height;
  const scale = w < 2000 ? 2 : 1;
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  const d = ctx.getImageData(0, 0, c.width, c.height);
  const p = d.data;
  const lum = new Uint8Array(c.width * c.height);
  for (let i = 0, j = 0; i < p.length; i += 4, j++) {
    lum[j] = p[i] * 0.299 + p[i + 1] * 0.587 + p[i + 2] * 0.114;
    p[i] = p[i + 1] = p[i + 2] = 255 - lum[j];
  }
  ctx.putImageData(d, 0, 0);
  return { canvas: c, lum, w: c.width, h: c.height, scale };
}

// 줄 판별 (거래 기록 탭 / 거래 완료 탭 공통)
const HEAD_RE = /처리일|거래일|최신순|판매\s*종료\s*\d|전체\s*\d+/;
const FOOT_RE = /회수.{0,3}수령|보관\s*기간|최대\s*1,?000/;

// 판매 행 박스(패널 배경보다 조금 밝은 사각형)들을 찾아 원본에서 잘라낸다. 못 찾으면 null.
function cropRows(lines, img, src) {
  const { lum, w, h, scale } = img;
  const head = lines.find(l => HEAD_RE.test(l.text));
  const foot = lines.find(l => FOOT_RE.test(l.text));
  const y0 = head ? head.bbox.y1 + 2 : 0;
  const y1 = foot ? foot.bbox.y0 - 2 : h;
  const x0 = head ? Math.max(0, head.bbox.x0 - 40 * scale) : 0;
  const x1 = head ? Math.min(w, head.bbox.x1 + 40 * scale) : w;
  if (y1 - y0 < 20) return null;

  // 패널 배경 = 띠 안에서 가장 흔한 밝기
  const hist = new Uint32Array(256);
  for (let y = y0; y < y1; y += 3) for (let x = x0; x < x1; x += 3) hist[lum[y * w + x]]++;
  const bg = hist.indexOf(Math.max(...hist));
  const rowish = v => v >= bg + 10 && v <= bg + 60;

  // 세로 프로필: 행 박스 배경이 가로로 절반 이상 깔린 y
  const rowsY = [];
  let s = -1;
  for (let y = y0; y <= y1; y++) {
    let n = 0;
    if (y < y1) for (let x = x0; x < x1; x += 2) if (rowish(lum[y * w + x])) n++;
    const on = y < y1 && n / ((x1 - x0) / 2) > 0.35;
    if (on && s < 0) s = y;
    if (!on && s >= 0) { if (y - s > 12 * scale) rowsY.push([s, y]); s = -1; }
  }
  if (!rowsY.length) return null;
  const top = rowsY[0][0], bot = rowsY[rowsY.length - 1][1];

  // 가로 범위: 첫 행에서 패널 배경과 다른 픽셀이 대부분인 x 구간 (아이콘 등으로 잠깐 끊긴 곳은 이어 붙임)
  const [ry0, ry1] = rowsY[0];
  const runs = [];
  s = -1;
  for (let x = x0; x <= x1; x++) {
    let n = 0;
    if (x < x1) for (let y = ry0; y < ry1; y++) if (Math.abs(lum[y * w + x] - bg) > 6) n++;
    const on = x < x1 && n / (ry1 - ry0) > 0.6;
    if (on && s < 0) s = x;
    if (!on && s >= 0) {
      const last = runs[runs.length - 1];
      if (last && s - last[1] < 8 * scale) last[1] = x; else runs.push([s, x]);
      s = -1;
    }
  }
  if (!runs.length) return null;
  const best = runs.reduce((a, b) => (b[1] - b[0] > a[1] - a[0] ? b : a));

  // 원본 좌표로 되돌려 잘라냄 (테두리 1px 포함)
  const sx = Math.max(0, Math.floor(best[0] / scale) - 1);
  const sy = Math.max(0, Math.floor(top / scale) - 1);
  const sw = Math.ceil((best[1] - best[0]) / scale) + 2;
  const sh = Math.ceil((bot - top) / scale) + 2;
  const c = document.createElement('canvas');
  c.width = sw;
  c.height = sh;
  c.getContext('2d').drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  return c;
}

// 하단 "회수,수령 … 보관" 줄 오른쪽의 페이지 버튼 중 선택된(회색 박스) 번호를 읽는다. 못 찾으면 null.
async function readPage(lines, img) {
  const foot = lines.find(l => FOOT_RE.test(l.text));
  if (!foot) return null;
  const { lum, w } = img;
  const y0 = foot.bbox.y0, y1 = foot.bbox.y1, bandH = y1 - y0;
  if (bandH < 6) return null;
  // 안내문 글자 끝 오른쪽부터 탐색 (거래 기록 탭: "…보관" 뒤에 페이지 버튼)
  const xs = foot.words?.find(wd => /보관$/.test(wd.text))?.bbox.x1 ?? foot.bbox.x0;
  // 줄 배경 밝기 (가장 어두운 쪽 25%)
  const sample = [];
  for (let x = xs; x < w; x += 4) sample.push(lum[((y0 + y1) >> 1) * w + x]);
  sample.sort((a, b) => a - b);
  const bg = sample[Math.floor(sample.length / 4)] ?? 0;
  const lit = v => v > bg + 40;
  // 띠 높이의 절반 이상이 밝은 열이 이어지는 구간 = 선택된 페이지 박스
  let run = null, start = -1;
  for (let x = xs; x <= w; x++) {
    let n = 0;
    if (x < w) for (let y = y0; y < y1; y++) if (lit(lum[y * w + x])) n++;
    const on = x < w && n / bandH > 0.5;
    if (on && start < 0) start = x;
    if (!on && start >= 0) {
      const width = x - start;
      if (width > bandH * 0.6 && width < bandH * 2.2) { run = [start, x]; break; }
      start = -1;
    }
  }
  if (!run) return null;
  // 박스 안 흰 글자만 검게 (박스 위아래 여백 포함)
  const [bx0, bx1] = run;
  const top = Math.max(0, y0 - (bandH >> 2)), bot = Math.min(img.h, y1 + (bandH >> 2));
  const bw = bx1 - bx0, bh = bot - top, pad = 10;
  const c = document.createElement('canvas');
  c.width = bw + pad * 2;
  c.height = bh + pad * 2;
  const ctx = c.getContext('2d');
  const out = ctx.createImageData(c.width, c.height);
  out.data.fill(255);
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (lum[(top + y) * w + bx0 + x] > 170) {
        const k = ((y + pad) * c.width + x + pad) * 4;
        out.data[k] = out.data[k + 1] = out.data[k + 2] = 0;
      }
    }
  }
  ctx.putImageData(out, 0, 0);
  const { data } = await (await digitWorker()).recognize(c);
  const n = parseInt(data.text.trim(), 10);
  return n > 0 && n < 1000 ? n : null;
}

// "11억 0711만 1807", "24억 4223만 3500", "9500만", "3억", "5000만 12"
const AMOUNT_RE = /(\d{1,4})\s*억(?:\s*(\d{1,4})\s*만)?(?:[ ]{0,2}(\d{1,4})(?![\d-]))?|(\d{1,4})\s*만(?:[ ]{0,2}(\d{1,4})(?![\d-]))?/g;

function toNumber(m) {
  if (m[1] !== undefined) return Number(m[1]) * 1e8 + Number(m[2] || 0) * 1e4 + Number(m[3] || 0);
  return Number(m[4]) * 1e4 + Number(m[5] || 0);
}

// 금액 앞쪽 텍스트에서 아이템명 추정 (두 칸 이상 공백으로 나뉜 마지막 한글 덩어리)
function guessName(before) {
  const segs = before.split(/\s{2,}/).map(s => s.trim()).filter(s => /[가-힣]/.test(s));
  if (!segs.length) return '';
  const words = segs[segs.length - 1].split(/\s+/);
  // 아이콘이 "8 렐" 같은 짧은 조각으로 읽혀 앞에 붙는 경우 제거
  while (words.length > 1 && !/[가-힣]{2}/.test(words[0])) words.shift();
  return words.join(' ').replace(/^[^가-힣A-Za-z0-9]+/, '').replace(/[\s@©®◎●○|!]+$/, '');
}

export function parseAuctionText(text) {
  let lines = text.split(/\r?\n/);
  // 필터 줄(전체 / 판매 완료 / 처리일 최신순) 아래 ~ 하단 안내문(회수,수령 … 보관) 위만 사용 → 상단 보유 메소 제외
  const start = lines.findIndex(l => HEAD_RE.test(l));
  if (start >= 0) lines = lines.slice(start + 1);
  const end = lines.findIndex(l => FOOT_RE.test(l));
  if (end >= 0) lines = lines.slice(0, end);

  const items = [];
  for (let line of lines) {
    const cut = line.search(/개\s*당/); // 개당 단가 제외
    if (cut >= 0) line = line.slice(0, cut);
    AMOUNT_RE.lastIndex = 0;
    let m;
    while ((m = AMOUNT_RE.exec(line))) {
      const value = toNumber(m);
      if (value > 0) items.push({ name: guessName(line.slice(0, m.index)), value });
    }
  }
  return items;
}

// src: HTMLImageElement | HTMLVideoElement | HTMLCanvasElement
// page: 하단 페이지 번호 (못 읽으면 null)
export async function readAuction(src) {
  const worker = await initAuctionOcr();
  const img = preprocess(src);
  const { data } = await worker.recognize(img.canvas);
  let page = null;
  try { page = await readPage(data.lines || [], img); } catch (e) { console.warn('[분배금] 페이지 번호 인식 실패', e); }
  let crop = null;
  try { crop = cropRows(data.lines || [], img, src); } catch (e) { console.warn('[분배금] 판매 행 자르기 실패', e); }
  return { items: parseAuctionText(data.text), text: data.text, page, crop };
}
