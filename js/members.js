// 넥슨 오픈API 길드원 명단을 불러와 OCR 닉네임을 실제 닉네임으로 대조한다.
import { jamo, ocrDistance } from './hangul.js';

const KEY = 'mgo.guilds'; // { "월드|길드명": 명단 } — 조회한 길드별 캐시
const CURRENT = 'mgo.guild.current';
const TTL = 24 * 3600 * 1000;
const NEXON = 'https://open.api.nexon.com/maplestory/v1';
const guildKey = (world, name) => `${world}|${name}`;

function loadAll() {
  try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return {}; }
}
let roster = (() => {
  try { return loadAll()[localStorage.getItem(CURRENT)] ?? null; } catch { return null; }
})();

export const getRoster = () => roster;

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message || body?.error || `요청 실패 (${res.status})`);
  return body;
}

// apiKey가 있으면 브라우저에서 넥슨 API를 직접 호출, 없으면 서버 프록시(/api/guild) 사용.
// 24시간 안에 조회한 길드는 저장된 명단을 쓰고, force면 브라우저·서버 캐시를 모두 무시한다.
export async function fetchRoster(world, name, apiKey, force = false) {
  const all = loadAll(), k = guildKey(world, name);
  const saved = all[k];
  if (!force && saved && Date.now() - saved.fetchedAt < TTL) {
    roster = saved;
    try { localStorage.setItem(CURRENT, k); } catch {}
    return { ...roster, fromCache: true };
  }
  let data;
  if (apiKey) {
    const h = { 'x-nxopen-api-key': apiKey };
    const q = new URLSearchParams({ guild_name: name, world_name: world });
    const { oguild_id } = await getJson(`${NEXON}/guild/id?${q}`, h);
    const b = await getJson(`${NEXON}/guild/basic?${new URLSearchParams({ oguild_id })}`, h);
    data = { world: b.world_name, name: b.guild_name, count: b.guild_member_count, members: b.guild_member ?? [], date: b.date };
  } else {
    // 서버 프록시가 없는 정적 호스팅(GitHub Pages 등)에서는 개인 API 키가 필요하다
    const probe = await fetch('/api/guild?world=_&name=_').catch(() => null);
    if (!probe?.headers.get('content-type')?.includes('json')) throw new Error('이 사이트에서는 개인 API 키가 필요합니다. 넥슨 오픈API에서 발급받은 키를 입력해 주세요.');
    data = await getJson(`/api/guild?${new URLSearchParams({ world, name, ...(force ? { refresh: '1' } : {}) })}`);
  }
  // 서버 캐시에서 온 경우 실제 조회 시각을 유지
  roster = { ...data, fetchedAt: data.fetchedAt ?? Date.now() };
  all[k] = roster;
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
    localStorage.setItem(CURRENT, k);
  } catch {}
  return roster;
}

let cache = null; // 명단 자모 분해 캐시
function members() {
  if (cache?.src !== roster) cache = { src: roster, list: (roster?.members ?? []).map(m => ({ m, j: jamo(m) })) };
  return cache.list;
}

// 정규화 거리: OCR 버릇을 반영한 자모 편집거리 / 긴 쪽 길이.
// 괄호 앞(본캐)만 읽으므로 닉네임이 ".."로 잘리는 일은 없다(최대 한글 6자가 칸에 다 들어감).
function score(raw, a, { j }) {
  return ocrDistance(a, j) / Math.max(a.length, j.length, 1);
}

// 닉네임 유사도 순위: best = 가장 가까운 후보, second = 2등 거리
function rankByName(raw, list) {
  const a = jamo(raw);
  let best = null, second = Infinity;
  for (const x of list) {
    const n = score(raw, a, x);
    if (!best || n < best.n) { second = best?.n ?? Infinity; best = { m: x.m, n }; }
    else if (n < second) second = n;
  }
  return { best, second };
}

// 최소 비용 배정(헝가리안). cost: n x m (n <= m), 반환: 행별 열 인덱스
function hungarian(cost) {
  const n = cost.length, m = cost[0].length, INF = 1e9;
  const u = new Array(n + 1).fill(0), v = new Array(m + 1).fill(0), p = new Array(m + 1).fill(0), way = new Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(m + 1).fill(INF), used = new Array(m + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF, j1 = 0;
      for (let j = 1; j <= m; j++) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) { minv[j] = cur; way[j] = j0; }
        if (minv[j] < delta) { delta = minv[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) {
        if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  const res = new Array(n).fill(-1);
  for (let j = 1; j <= m; j++) if (p[j]) res[p[j] - 1] = j - 1;
  return res;
}

const HANGUL = /^[가-힣]+$/;
const HANGUL_JAMO_END = /^[가-힣]+[ㄱ-ㅎ]$/; // "빠ㄷ"처럼 마지막 글자를 자모로만 읽은 경우
const LATIN = /[A-Za-z0-9]/;

// 게임 폰트에서 글자 픽셀 폭(원래 배율, 글자 사이 간격 포함). 한글 2자 20px, 3자 30px, 빳따c 26px 실측.
function charW(c) {
  if (/[가-힣ㄱ-ㅎㅏ-ㅣ]/.test(c)) return 10.4;
  if (/[iljI1!.,'|:;]/.test(c)) return 3;
  if (/[mwMW]/.test(c)) return 8;
  if (/[A-Z]/.test(c)) return 6.5;
  if (/[0-9]/.test(c)) return 6;
  return 5.4;
}
const textW = m => [...m].reduce((a, c) => a + charW(c), 0) - 1;

// 닉네임 픽셀 폭이 명단 닉네임의 예상 폭과 얼마나 다른지 → 벌점(12% 이내는 0)
function widthPenalty(w, x) {
  if (!w) return 0;
  const e = x.w ?? (x.w = textW(x.m));
  const rel = Math.abs(e - w) / Math.max(e, w);
  return 0.6 * Math.max(0, rel - 0.12);
}

// 한 행의 OCR 후보들과 길드원 하나 사이의 거리.
//  - 후보 중 가장 가까운 것을 쓴다(보조 후보는 +0.05)
//  - 한글 후보가 닉네임보다 짧으면 앞부분 일치도 본다(빼 → 빼멧, 벌점 있음). 끝이 자모만 남은 "빠ㄷ"도 포함
//  - 다른 후보가 닉네임 끝 영문·숫자와 맞으면(빳따c ← "Yc") 단서를 합쳐 조금 깎는다
//  - 닉네임 픽셀 폭(w)이 명단 닉네임 예상 폭과 다르면 벌점(동점일 때 글자 수·종류로 가른다)
// OCR 후보가 없으면(못 읽은 행) 폭만으로 고르되 거리는 크게 둔다.
// 반환 { n: 배정용 거리, full: 첫 후보의 전체 거리(확신 판정용) }
// 글자 단위 OCR(glyphs)과 같은 글자 수의 닉네임을 자리별로 비교: 같으면 0, 못 읽은 자리 0.5, 다르면 자모 거리(최대 1)
function glyphScore(glyphs, x) {
  if (!glyphs?.some(Boolean)) return null;
  const mc = [...x.m];
  if (mc.length !== glyphs.length) return null;
  let sum = 0;
  glyphs.forEach((g, i) => {
    if (!g) { sum += 0.5; return; }
    if (g === mc[i]) return;
    const a = jamo(g), b = jamo(mc[i]);
    sum += Math.min(1, ocrDistance(a, b) / Math.max(a.length, b.length, 1));
  });
  return sum / mc.length;
}

function rowScore(cands, aj, x, w, glyphs) {
  let n = Infinity, full = Infinity;
  cands.forEach((raw, k) => {
    const d = ocrDistance(aj[k], x.j) / Math.max(aj[k].length, x.j.length, 1);
    if (k === 0) full = d;
    n = Math.min(n, d + (k ? 0.05 : 0));
    const hj = HANGUL_JAMO_END.test(raw);
    if ((HANGUL.test(raw) || hj) && raw.length < x.m.length + (hj ? 1 : 0)) {
      // 같은 자모 수의 앞부분과 한 자모 더 긴 앞부분 중 가까운 쪽(빳따 → 빠ㄷ: ㅅ 빠짐 + ㄸ→ㄷ)
      const mj = x.j;
      let pd = Infinity;
      for (const L of [aj[k].length, aj[k].length + 1]) {
        if (L > mj.length) continue;
        pd = Math.min(pd, ocrDistance(aj[k], mj.slice(0, L)) / L);
      }
      const len = hj ? raw.length - 0.5 : raw.length;
      n = Math.min(n, pd + 0.25 + 0.2 * (1 - len / x.m.length) + (k ? 0.05 : 0));
    }
  });
  if (!cands.length) n = full = 1;
  // 글자 단위 결과가 모두 맞으면 확정할 만한 근거
  const g = glyphScore(glyphs, x);
  if (g != null) { n = Math.min(n, g + 0.05); if (g === 0) full = 0; }
  // 끝 글자 단서: 닉네임이 영문·숫자로 끝나고 어떤 후보의 끝 글자와 같으면
  const last = x.m.slice(-1);
  if (LATIN.test(last) && cands.some(c => c.length && c.slice(-1).toLowerCase() === last.toLowerCase())) n -= 0.1;
  n += widthPenalty(w, x);
  return { n, full };
}

// 소거법: 명단을 불러왔으면 닉네임은 반드시 명단 안에 있다.
// 미확정 행 전체와 아직 확정되지 않은 길드원(taken 제외)을 거리 합이 최소가 되게 한꺼번에 짝짓는다.
// 스크롤할수록 확정된 길드원이 늘어 후보가 줄고, 매번 다시 계산하므로 앞선 추정도 바로잡힌다.
// rows: 미확정 행별 OCR 후보 배열(첫 번째가 대표), widths: 행별 닉네임 픽셀 폭(없으면 0).
// 반환: Map(행 인덱스 → { m: 닉네임, sure })
// sure는 대표 후보가 닉네임 전체와 가까울 때만 — 앞부분 일치·보조 후보·폭만으로 맞춘 건 확인 필요로 둔다.
// OCR 후보가 없는 행도 명단 밖 닉네임을 남기지 않도록 폭으로 배정한다(항상 확인 필요).
export function assignByElimination(rows, taken, widths = [], glyphs = []) {
  const pool = members().filter(x => !taken.has(x.m));
  const idx = rows.map((_, i) => i);
  if (!idx.length || !pool.length) return new Map();
  const scores = idx.map(i => {
    const c = rows[i] ?? [];
    const aj = c.map(jamo);
    return pool.map(x => rowScore(c, aj, x, widths[i], glyphs[i]));
  });
  const cost = scores.map(row => {
    const c = row.map(s => s.n);
    while (c.length < idx.length) c.push(9); // 길드원보다 행이 많으면 남는 행은 배정 안 함
    return c;
  });
  const out = new Map();
  hungarian(cost).forEach((j, k) => {
    if (j < 0 || j >= pool.length) return;
    out.set(idx[k], { m: pool[j].m, sure: ((rows[k]?.length ?? 0) > 0 || glyphs[k]?.length > 0) && scores[k][j].full <= 0.35 });
  });
  return out;
}

// 직접 고를 때 쓸 명단 후보: 가까운 순(taken 제외). cands: OCR 후보 배열(또는 문자열 하나), w: 닉네임 픽셀 폭
export function candidatesFor(cands, taken, w = 0, glyphs = null) {
  const c = (Array.isArray(cands) ? cands : [cands]).filter(Boolean);
  const aj = c.map(jamo);
  return members().filter(x => !taken.has(x.m))
    .map(x => ({ m: x.m, n: rowScore(c, aj, x, w, glyphs).n }))
    .sort((p, q) => p.n - q.n || p.m.localeCompare(q.m, 'ko'));
}

// 반환: 확신할 수 있는 명단 닉네임 또는 null
export function matchMember(raw) {
  const list = members();
  if (!raw || !list.length) return null;
  const { best, second } = rankByName(raw, list);
  if (best.n === 0) return best.m;
  if (best.n <= 0.35 && second - best.n >= 0.15) return best.m;
  // Tesseract가 드문 글자(넋 등)를 통째로 빠뜨리는 경우: OCR 결과를 포함하는 닉네임이 명단에 딱 하나면 인정
  if (raw.length >= 2) {
    const hits = list.filter(({ m }) => m.includes(raw) && m.length - raw.length <= 2);
    if (hits.length === 1) return hits[0].m;
  }
  return null;
}
