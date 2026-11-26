// 보스 분배금 계산 (순수 함수).
// 수식은 메이플로드 보스 분배금 계산기와 같다.
// - 실수령(수수료 뗀 뒤) 기준으로 입력 비율대로 나눈다.
// - 파티원 전달액은 수수료를 포함한 금액(받는 쪽이 수수료를 떼고 목표액을 받도록), 100의 자리에서 내림.
// - 파티장은 실수령액에서 파티원 전달액 합계를 뺀 나머지를 갖는다.

export const MAX_DIGITS = 15;

export function actualFromAuction(price, commission) {
  return Math.floor(price * (100 - commission) / 100);
}

export function auctionFromActual(amount, commission) {
  return Math.ceil(amount / (100 - commission) * 100);
}

export function roleLabel(i, count) {
  if (i === 0) return '파티장';
  return count === 2 ? '파티원' : `파티원${i}`;
}

export function ratioPercent(ratio, sum) {
  if (!sum || !ratio) return '0';
  const pct = ratio / sum * 100;
  return Math.abs(pct - Math.round(pct)) < 0.05 ? String(Math.round(pct)) : pct.toFixed(1);
}

// amount: 실제 수령액, ratios: [파티장, 파티원1, ...]
export function split(amount, commission, ratios) {
  const sum = ratios.reduce((a, b) => a + b, 0);
  if (!amount || !sum) return null;
  const cv = 100 / (100 - commission);
  const denom = ratios[0] + cv * (sum - ratios[0]);
  const count = ratios.length;
  const out = ratios.map((r, i) => ({ label: roleLabel(i, count), ratio: r, pct: ratioPercent(r, sum), amount: 0 }));
  let members = 0;
  for (let i = 1; i < count; i++) {
    const t = Math.floor(amount * ratios[i] * cv / denom / 100) * 100;
    out[i].amount = t;
    members += t;
  }
  out[0].amount = amount - members;
  return out;
}

// 공평 분배에서 파티장이 파티원(수수료 뗀 실수령) 대비 더 가져가는 금액
export function leaderSurplus(dist, commission) {
  const leader = dist[0].amount;
  const memberNet = dist[1].amount * (100 - commission) / 100;
  const diff = leader - memberNet;
  return { diff, rate: leader ? diff / leader * 100 : 0 };
}

// 1234567890 → "12억 3456만 7890", 1107000000 → "11억 0700만" (게임 표기처럼 윗단위가 있으면 4자리 채움)
export function korean(n) {
  n = Math.floor(n || 0);
  if (!n) return '0';
  const parts = [];
  const cho = Math.floor(n / 1e12), eok = Math.floor(n % 1e12 / 1e8), man = Math.floor(n % 1e8 / 1e4), rest = n % 1e4;
  const pad = v => (parts.length ? String(v).padStart(4, '0') : String(v));
  if (cho) parts.push(`${cho}조`);
  if (eok) parts.push(`${pad(eok)}억`);
  if (man) parts.push(`${pad(man)}만`);
  if (rest) parts.push(pad(rest));
  return parts.join(' ');
}

export function comma(n) {
  return Math.floor(n || 0).toLocaleString('ko-KR');
}
