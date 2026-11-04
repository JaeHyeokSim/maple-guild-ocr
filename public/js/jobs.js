// 직업명 사전. OCR 결과를 가장 가까운 직업명으로 보정한다(예: 마크메미지 → 아크메이지).
import { jamo, distance } from './hangul.js';

export const JOBS = [
  '히어로', '팔라딘', '다크나이트',
  '아크메이지(불,독)', '아크메이지(썬,콜)', '비숍',
  '보우마스터', '신궁', '패스파인더',
  '나이트로드', '섀도어', '듀얼블레이드',
  '바이퍼', '캡틴', '캐논마스터',
  '소울마스터', '플레임위자드', '윈드브레이커', '나이트워커', '스트라이커', '미하일',
  '아란', '에반', '루미너스', '메르세데스', '팬텀', '은월',
  '블래스터', '배틀메이지', '와일드헌터', '메카닉', '제논', '데몬 슬레이어', '데몬 어벤져',
  '카이저', '카인', '카데나', '엔젤릭버스터',
  '아델', '일리움', '칼리', '아크',
  '라라', '호영', '렌', '레테',
  '제로', '키네시스',
  '초보자', '시티즌', '노블레스',
];

// 사전에 없는 신규 직업은 사용자가 표에서 직접 고치면 여기에 추가된다
const CUSTOM_KEY = 'mgo.customJobs';
const toEntry = j => [j, jamo(j.replace(/\s+/g, ''))];
let entries = [...JOBS, ...loadCustom()].map(toEntry);

function loadCustom() {
  try { return JSON.parse(localStorage.getItem(CUSTOM_KEY)) || []; } catch { return []; }
}

export function addCustomJob(job) {
  job = job.trim();
  if (!job || entries.some(([j]) => j === job)) return;
  const list = [...loadCustom(), job];
  try { localStorage.setItem(CUSTOM_KEY, JSON.stringify(list)); } catch {}
  entries.push(toEntry(job));
}

// 직업은 사전 안에서만 나오므로 항상 가장 가까운 직업으로 맞춘다(편탬 → 팬텀).
// ok=false 는 거리가 멀어 사람이 확인해야 한다는 뜻.
export function correctJob(raw) {
  const s = jamo(raw.replace(/\s+/g, ''));
  if (!s) return { job: '', ok: false };
  let best = null, bestD = Infinity;
  for (const entry of entries) {
    const d = distance(s, entry[1]);
    if (d < bestD) { bestD = d; best = entry; }
  }
  return { job: best[0], ok: bestD <= Math.max(1, Math.floor(best[1].length * 0.4)) };
}
