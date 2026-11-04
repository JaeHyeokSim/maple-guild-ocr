// 닉네임 학습 사전: 닉네임 글자 이미지 해시 → 사용자가 확인/수정한 닉네임.
// 같은 닉네임은 매주 같은 픽셀로 그려지므로 한 번 고치면 다음 캡처부터 자동으로 채워진다.
const KEY = 'mgo.names';
let book = null;

function load() {
  if (!book) {
    try { book = new Map(Object.entries(JSON.parse(localStorage.getItem(KEY)) || {})); } catch { book = new Map(); }
  }
  return book;
}

export function lookupName(hash) {
  return hash ? load().get(hash) : undefined;
}

export function learnName(hash, name) {
  if (!hash || !name) return;
  load().set(hash, name);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(book))); } catch {}
}
