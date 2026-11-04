// Tesseract.js 워커 관리와 행 단위 인식.
import { makeCell, isOnline, cropDataURL, textHash, textBox, nameEnd } from './segment.js';
import { lookupName } from './names.js';
import { matchMember } from './members.js';
import { correctJob } from './jobs.js';
import { readDigits } from './digits.js';

const LINE = { tessedit_pageseg_mode: '7' }; // 한 줄 텍스트
const COMMA_NUM = /^\d{1,3}(,\d{3})*$/;
const SMALL_NUM = /^\d{1,3}$/;
// 숫자 칸 재시도 순서 [배율, 임계값] — 형식에 맞는 결과가 나올 때까지
const NUM_TRIES = [[4, 330], [3, 330], [5, 330], [6, 330], [4, 300], [3, 360]];

let W = null;

export async function initOcr(onStatus) {
  const make = async (lang, params) => {
    const w = await Tesseract.createWorker(lang, 1, {
      logger: m => {
        if (m.status !== 'recognizing text' && m.progress < 1) onStatus(`${lang} ${m.status} ${Math.round(m.progress * 100)}%`);
      },
    });
    await w.setParameters(params);
    return w;
  };
  const [mix, kor, num] = await Promise.all([
    make('kor+eng', LINE),
    make('kor', LINE),
    make('eng', { ...LINE, tessedit_char_whitelist: '0123456789,' }),
  ]);
  W = { mix, kor, num };
}

async function rec(worker, canvas) {
  const { data } = await worker.recognize(canvas);
  return { text: data.text.replace(/\s+/g, ' ').trim(), conf: data.confidence };
}

// 여러 전처리/언어 조합 중 신뢰도가 가장 높은 결과
async function readText(img, r, variants) {
  let best = null;
  for (const [worker, mode] of variants) {
    const res = await rec(worker, makeCell(img, ...r, { mode }));
    if (!best || res.conf > best.conf) best = res;
    if (best.conf >= 88) break;
  }
  return best;
}

// 닉네임: 모든 후보를 그럴듯한 순서로 돌려준다.
// 한영 모델은 한글 닉네임을 "IER", "BE" 같은 영문으로 높은 신뢰도로 읽기도 하는데,
// 영문은 글자 폭이 높이의 절반 정도라 글자당 폭이 한글 수준이면 영문 결과를 뒤로 미룬다.
async function readName(img, r, variants) {
  const box = textBox(img, ...r);
  const pxPerChar = box ? (box.r - box.l + 1) / Math.max(1, box.b - box.t + 1) : 0;
  const plausible = res => {
    if (!res.text) return false;
    if (/[가-힣]/.test(res.text) || !/^[\x20-\x7e]+$/.test(res.text)) return true;
    return pxPerChar / res.text.length < 0.8;
  };
  const out = [];
  for (const [worker, mode] of variants) {
    const res = await rec(worker, makeCell(img, ...r, { mode }));
    res.plausible = plausible(res);
    out.push(res);
    if (res.plausible && res.conf >= 88) break;
  }
  return out.sort((a, b) => b.plausible - a.plausible || b.conf - a.conf);
}

async function readNumber(img, r, re) {
  const exact = readDigits(img, ...r);
  if (exact !== null && re.test(exact)) return { value: parseInt(exact.replace(/,/g, ''), 10), ok: true, exact: true };
  let first = null;
  for (const [scale, th] of NUM_TRIES) {
    const res = await rec(W.num, makeCell(img, ...r, { scale, th }));
    first ??= res;
    if (re.test(res.text)) return { value: parseInt(res.text.replace(/,/g, ''), 10), ok: true };
  }
  const digits = first.text.replace(/\D/g, '');
  return { value: digits ? parseInt(digits, 10) : null, ok: false };
}

// "뷰부(탐욕)" → "뷰부": 괄호 뒤는 쓰지 않는다. 길어서 잘린 표시("..")도 제거.
export const cleanName = s => s.replace(/\s+/g, '').replace(/[(\[{「].*$/, '').replace(/\.+$/, '');

// band: [y0, y1], cols: 열별 [x0, x1] 7개(닉네임, 직업, 레벨, 직위, 주간미션, 지하수로, 플래그)
export async function recognizeRow(img, cols, band) {
  const y0 = Math.max(0, band[0] - 2), y1 = Math.min(img.height, band[1] + 3);
  const R = i => [cols[i][0], cols[i][1], y0, y1];
  const nameVariants = [[W.mix, 'fixed'], [W.kor, 'fixed'], [W.kor, 'stretch']];
  const korVariants = [[W.kor, 'fixed'], [W.kor, 'stretch']];

  // 닉네임은 괄호 앞(본캐 닉네임)까지만 읽는다
  const N = [cols[0][0], nameEnd(img, ...R(0)), y0, y1];
  const nameHash = textHash(img, ...N);
  const known = lookupName(nameHash);

  const [cands, jobRaw, level, rank, mission, suro, flag] = await Promise.all([
    known ? [{ text: known, conf: 100, plausible: true }] : readName(img, N, nameVariants),
    readText(img, R(1), korVariants),
    readNumber(img, R(2), SMALL_NUM),
    readText(img, R(3), korVariants),
    readNumber(img, R(4), SMALL_NUM),
    readNumber(img, R(5), COMMA_NUM),
    readNumber(img, R(6), COMMA_NUM),
  ]);
  // 학습된 닉네임이 없으면 모든 후보를 길드원 명단(넥슨 API)과 대조
  const name = { ...cands[0] };
  const rawName = cleanName(name.text);
  const member = known ? null : cands.map(c => matchMember(cleanName(c.text))).find(Boolean);
  if (member) Object.assign(name, { text: member, conf: 100 });

  const job = correctJob(jobRaw.text);

  const low = [];
  if (name.conf < 75) low.push('name');
  if (!job.ok) low.push('job');
  if (rank.conf < 70) low.push('rank');
  if (!level.ok) low.push('level');
  if (!mission.ok) low.push('mission');
  if (!suro.ok) low.push('suro');
  if (!flag.ok) low.push('flag');

  return {
    name: cleanName(name.text),
    rawName,
    // 신뢰도가 낮아도 버리지 않는 OCR 후보 전부(소거법 대조용: "HH2"와 함께 나온 "빼" 같은 단서)
    rawCands: known ? [rawName] : [...new Set(cands.map(c => cleanName(c.text)).filter(Boolean))],
    fuzzy: !!member && member !== rawName, // 명단 대조로 OCR 결과를 고친 경우(검토 대상)
    nameHash,
    job: job.job,
    level: level.value,
    rank: rank.text.replace(/\s+/g, ''),
    mission: mission.value,
    suro: suro.value,
    flag: flag.value,
    exact: !!(level.exact && suro.exact), // 숫자 폰트 템플릿으로 읽혔는지(깨진 행 판별용)
    online: isOnline(img, ...R(0)),
    img: cropDataURL(img, ...N),
    low,
    // 미인식 분석용 원자료
    debug: {
      nameCands: cands.map(c => `${c.text} (${Math.round(c.conf)}${c.plausible ? '' : ', 폭 불일치'})`),
      jobRaw: `${jobRaw.text} (${Math.round(jobRaw.conf)})`,
      rankRaw: `${rank.text} (${Math.round(rank.conf)})`,
      rowImg: cropDataURL(img, cols[0][0], cols[6][1], y0, y1),
      // 칸별 원본(결과 표의 각 칸 아래에 원본 크기로 표시)
      colImgs: cols.map(([x0, x1]) => cropDataURL(img, x0, x1, y0, y1)),
    },
  };
}
