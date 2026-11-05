// 오인식 제보 수집: 사용자가 "틀림"으로 평가한 행을 모아 Vercel Blob(비공개 스토어)에 JSON으로 저장한다.
// 토큰은 스토어 연결 시 생기는 환경변수 BLOB_READ_WRITE_TOKEN 을 @vercel/blob 이 자동으로 쓴다.
// 저장 경로: reports/YYYY-MM-DD/<시각>-<무작위>.json
import { put } from '@vercel/blob';

const MAX_BYTES = 3_000_000; // 함수 요청 본문 한도(4.5MB)보다 작게
const MAX_ROWS = 50;

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

export async function POST(request) {
  const text = await request.text();
  if (text.length > MAX_BYTES) return json({ error: '제보가 너무 큽니다.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ error: 'JSON 형식이 아닙니다.' }, 400); }
  const rows = body?.rows;
  if (!Array.isArray(rows) || !rows.length || rows.length > MAX_ROWS) return json({ error: '행이 없거나 너무 많습니다.' }, 400);

  const now = new Date();
  const doc = { receivedAt: now.toISOString(), client: body.client ?? null, rows };
  try {
    await put(`reports/${now.toISOString().slice(0, 10)}/${now.getTime()}.json`, JSON.stringify(doc), {
      access: 'private',
      addRandomSuffix: true,
      contentType: 'application/json',
    });
  } catch (e) {
    return json({ error: '저장 실패: ' + e.message }, 502);
  }
  return json({ ok: true, rows: rows.length });
}
