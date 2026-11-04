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
