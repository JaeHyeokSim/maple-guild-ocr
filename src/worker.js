// 정적 페이지 + 넥슨 오픈API 길드원 명단 프록시.
// API 키는 Worker 비밀값(NEXON_API_KEY)으로 두어 사이트 사용자는 키 없이 명단을 불러올 수 있다.
const NEXON = 'https://open.api.nexon.com/maplestory/v1';
const CACHE_SEC = 24 * 3600;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': `public, max-age=${status === 200 ? CACHE_SEC : 0}` },
  });

async function nexon(path, params, key) {
  const res = await fetch(`${NEXON}${path}?${new URLSearchParams(params)}`, { headers: { 'x-nxopen-api-key': key } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `넥슨 API 오류 ${res.status}`), { status: res.status });
  return body;
}

async function guild(url, env, ctx) {
  const world = url.searchParams.get('world')?.trim();
  const name = url.searchParams.get('name')?.trim();
  if (!world || !name) return json({ error: '월드와 길드명을 입력하세요.' }, 400);
  if (!env.NEXON_API_KEY) return json({ error: '서버에 넥슨 API 키가 설정되지 않았습니다. 개인 API 키를 입력해 주세요.' }, 500);

  const cache = caches.default;
  const cacheKey = new Request(`https://cache.local/guild?world=${encodeURIComponent(world)}&name=${encodeURIComponent(name)}`);
  // refresh=1 이면 캐시를 건너뛰고 새로 조회(강제 초기화)
  if (url.searchParams.get('refresh') !== '1') {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  try {
    const { oguild_id } = await nexon('/guild/id', { guild_name: name, world_name: world }, env.NEXON_API_KEY);
    const basic = await nexon('/guild/basic', { oguild_id }, env.NEXON_API_KEY);
    const res = json({
      world: basic.world_name,
      name: basic.guild_name,
      count: basic.guild_member_count,
      members: basic.guild_member ?? [],
      date: basic.date,
      fetchedAt: Date.now(),
    });
    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    return json({ error: e.message }, e.status === 400 ? 404 : 502);
  }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/guild') return guild(url, env, ctx);    return env.ASSETS.fetch(req);
  },
};
