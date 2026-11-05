// Vercel 배포용 넥슨 오픈API 길드원 명단 프록시 (src/worker.js 의 /api/guild 와 같은 계약).
// API 키는 Vercel 환경변수 NEXON_API_KEY. 캐시는 Vercel CDN(s-maxage)에 맡긴다.
const NEXON = 'https://open.api.nexon.com/maplestory/v1';
const CACHE_SEC = 24 * 3600;

const json = (body, status = 200, cache = status === 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': cache ? `public, max-age=${CACHE_SEC}, s-maxage=${CACHE_SEC}` : 'no-store',
    },
  });

async function nexon(path, params, key) {
  const res = await fetch(`${NEXON}${path}?${new URLSearchParams(params)}`, { headers: { 'x-nxopen-api-key': key } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body?.error?.message || `넥슨 API 오류 ${res.status}`), { status: res.status });
  return body;
}

export async function GET(req) {
  const url = new URL(req.url);
  const world = url.searchParams.get('world')?.trim();
  const name = url.searchParams.get('name')?.trim();
  if (!world || !name) return json({ error: '월드와 길드명을 입력하세요.' }, 400);
  const key = process.env.NEXON_API_KEY;
  if (!key) return json({ error: '서버에 넥슨 API 키가 설정되지 않았습니다. 개인 API 키를 입력해 주세요.' }, 500);

  try {
    const { oguild_id } = await nexon('/guild/id', { guild_name: name, world_name: world }, key);
    const basic = await nexon('/guild/basic', { oguild_id }, key);
    // refresh=1(강제 새로고침)은 쿼리가 달라 CDN 캐시를 타지 않고, 응답도 캐시하지 않는다.
    return json({
      world: basic.world_name,
      name: basic.guild_name,
      count: basic.guild_member_count,
      members: basic.guild_member ?? [],
      date: basic.date,
      fetchedAt: Date.now(),
    }, 200, url.searchParams.get('refresh') !== '1');
  } catch (e) {
    return json({ error: e.message }, e.status === 400 ? 404 : 502, false);
  }
}
