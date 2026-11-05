// 오인식 제보(Vercel Blob, 비공개 스토어)를 내려받는다.
//   준비: npx vercel env pull .env.local   (BLOB_READ_WRITE_TOKEN)
//   실행: npm run reports            → reports-data/ 에 없는 파일만 받는다
//         npm run reports -- --delete <pathname...>   → 지정한 제보 삭제(시험 데이터 정리용)
import fs from 'node:fs';
import path from 'node:path';
import { list, get, del } from '@vercel/blob';

const root = path.resolve(import.meta.dirname, '..');
const envFile = path.join(root, '.env.local');
if (!process.env.BLOB_READ_WRITE_TOKEN && fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^BLOB_READ_WRITE_TOKEN="?(.*?)"?$/);
    if (m) process.env.BLOB_READ_WRITE_TOKEN = m[1];
  }
}
if (!process.env.BLOB_READ_WRITE_TOKEN) {
  console.error('BLOB_READ_WRITE_TOKEN 이 없습니다. npx vercel env pull .env.local 을 먼저 실행하세요.');
  process.exit(1);
}

const args = process.argv.slice(2);
if (args[0] === '--delete') {
  await del(args.slice(1));
  console.log(`삭제: ${args.length - 1}건`);
  process.exit(0);
}

const out = path.join(root, 'reports-data');
let cursor, total = 0, fetched = 0;
do {
  const page = await list({ prefix: 'reports/', cursor });
  for (const b of page.blobs) {
    total++;
    const file = path.join(out, b.pathname);
    if (fs.existsSync(file)) continue;
    const res = await get(b.pathname, { access: 'private' });
    const text = await new Response(res.stream).text();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    fetched++;
  }
  cursor = page.hasMore ? page.cursor : undefined;
} while (cursor);
console.log(`제보 ${total}건 중 새로 받은 ${fetched}건 → ${path.relative(process.cwd(), out) || '.'}`);
