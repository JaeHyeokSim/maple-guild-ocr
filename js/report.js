// 오인식 자동 제보: "틀림"으로 평가한 행을 모아 서버(/api/report)로 보낸다.
// 건마다 보내지 않고 모아서 보낸다(Vercel Blob 무료 한도는 쓰기 횟수 기준).
//  - 보낼 행이 BATCH개 이상이거나, 가장 오래된 행이 MAX_WAIT 이상 기다렸거나, 탭을 벗어날 때 전송
//  - 정답을 고쳐 내용이 바뀐 행은 다시 보낸다(분석할 때 id로 최신 것만 쓴다)
const SENT_KEY = 'mgo.reported'; // { 행 id: 보낸 내용 서명 }
const OPT_KEY = 'mgo.reportOff';
const BATCH = 10, MAX_WAIT = 2 * 60 * 1000, CHUNK = 20;

const load = (k, d) => { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } };

export function startReporter(table, checkbox, getClient) {
  let sent = load(SENT_KEY, {});
  const firstSeen = new Map(); // 행 id → 처음 보낼 대상이 된 시각
  let sending = false, disabled = false; // disabled: 서버가 없는 곳(GitHub Pages·로컬)이면 이번 세션은 그만 보낸다

  try { checkbox.checked = localStorage.getItem(OPT_KEY) !== '1'; } catch {}
  checkbox.addEventListener('change', () => {
    try { localStorage.setItem(OPT_KEY, checkbox.checked ? '0' : '1'); } catch {}
  });

  // 보낼 행: 틀림으로 평가했고 아직 안 보냈거나 내용이 바뀐 것
  function pending() {
    const bad = table.rows.filter(r => r.eval === 'bad');
    const ev = table.evalRows(); // bad와 같은 순서
    return ev.map((e, i) => {
      const id = bad[i].id;
      const sig = JSON.stringify([e.truth, e.auto]);
      return { id, sig, row: { id, ...e } };
    }).filter(x => sent[x.id] !== x.sig);
  }

  async function flush(force) {
    if (sending || disabled || !checkbox.checked) return;
    const items = pending();
    const now = Date.now();
    for (const x of items) if (!firstSeen.has(x.id)) firstSeen.set(x.id, now);
    if (!items.length) return;
    const oldest = Math.min(...items.map(x => firstSeen.get(x.id)));
    if (!force && items.length < BATCH && now - oldest < MAX_WAIT) return;

    sending = true;
    try {
      for (let i = 0; i < items.length; i += CHUNK) {
        const part = items.slice(i, i + CHUNK);
        const res = await fetch('/api/report', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ client: getClient(), rows: part.map(x => x.row) }),
        });
        if (res.status === 404 || res.status === 405 || !res.headers.get('content-type')?.includes('json')) { disabled = true; return; }
        if (!res.ok) return;
        for (const x of part) { sent[x.id] = x.sig; firstSeen.delete(x.id); }
        // 오래된 기록은 정리(최근 2000건만)
        const keys = Object.keys(sent);
        if (keys.length > 2000) sent = Object.fromEntries(keys.slice(-2000).map(k => [k, sent[k]]));
        try { localStorage.setItem(SENT_KEY, JSON.stringify(sent)); } catch {}
      }
    } catch {
      // 네트워크 오류: 다음 기회에 다시 시도
    } finally {
      sending = false;
    }
  }

  setInterval(() => flush(false), 30 * 1000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(true); });
  return { flush, pendingCount: () => pending().length };
}
