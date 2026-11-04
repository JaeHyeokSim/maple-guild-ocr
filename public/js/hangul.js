// 한글 자모 분해와 편집거리. OCR은 음절 하나를 통째로 틀리기보다 자모 일부를 틀리므로(왈↔황, 편↔팬) 자모 단위로 비교한다.

export function jamo(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    if (c < 0 || c > 11171) { out += ch.toLowerCase(); continue; }
    out += String.fromCharCode(0x1100 + Math.floor(c / 588), 0x1161 + Math.floor((c % 588) / 28));
    if (c % 28) out += String.fromCharCode(0x11a7 + (c % 28));
  }
  return out;
}

// 이 게임 폰트에서 Tesseract가 자주 헷갈리는 자모 쌍(실제 오인식 사례 기반). 서로 바뀌면 거리 0.4로 친다.
// 예: 이→미(ㅇ/ㅁ), 왈→활(ㅇ/ㅎ), 땜→탬(ㄸ/ㅌ), 쎄→비, 옴→음(ㅗ/ㅡ), 쿵→룸
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ' ㄱㄲㄳㄴㄵㄶㄷㄹㄺㄻㄼㄽㄾㄿㅀㅁㅂㅄㅅㅆㅇㅈㅊㅋㅌㅍㅎ';
const CONFUSED = new Set();
function confuse(table, base, pairs) {
  for (const [x, y] of pairs) {
    const i = table.indexOf(x), j = table.indexOf(y);
    if (i < 0 || j < 0) continue;
    const a = String.fromCharCode(base + i), b = String.fromCharCode(base + j);
    CONFUSED.add(a + b).add(b + a);
  }
}
confuse(CHO, 0x1100, ['ㅁㅇ', 'ㅇㅎ', 'ㄱㄲ', 'ㄷㄸ', 'ㅂㅃ', 'ㅅㅆ', 'ㅈㅉ', 'ㅌㄸ', 'ㄱㅋ', 'ㄲㅋ', 'ㄹㅋ', 'ㅂㅍ'].map(p => [...p]));
confuse(JUNG, 0x1161, ['ㅐㅔ', 'ㅗㅜ', 'ㅗㅡ', 'ㅜㅡ', 'ㅏㅑ', 'ㅓㅕ', 'ㅔㅖ', 'ㅣㅟ'].map(p => [...p]));
confuse(JONG, 0x11a7, ['ㅁㅇ', 'ㄱㄲ', 'ㅅㅆ', 'ㄹㅀ'].map(p => [...p]));
// 영문 닉네임을 숫자로 읽는 경우(Soble → 50016). jamo()가 영문을 소문자로 바꾸므로 소문자 기준.
for (const [x, y] of ['5s', '0o', '1l', '1i', '6b', '6e', '8b', '9g', '2z', 'il']) CONFUSED.add(x + y).add(y + x);

// OCR 버릇을 반영한 편집거리(소수)
export function ocrDistance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      const sub = a[i - 1] === b[j - 1] ? 0 : CONFUSED.has(a[i - 1] + b[j - 1]) ? 0.4 : 1;
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + sub);
      prev = tmp;
    }
  }
  return dp[b.length];
}

export function distance(a, b) {
  const dp = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}
