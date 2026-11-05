import { RoiEditor } from './roi.js';
import { detectRows, fullRows, autoDividers, columnRects, regionHash } from './segment.js';
import { initOcr, recognizeRow } from './ocr.js';
import { ResultTable, loadSnapshots } from './table.js';
import { startShare, stopShare, bindImageInputs } from './capture.js';
import { findTable, findTableScaled, headerStrip, sameStrip } from './detect.js';
import { fetchRoster, getRoster, matchMember } from './members.js';
import { attachCombo } from './combo.js';
import { startReporter } from './report.js';
import { uiAlert, uiConfirm, uiPrompt } from './dialog.js';

const $ = s => document.querySelector(s);
const statusEl = $('#ocrStatus'), progressEl = $('#progress'), video = $('#video');

const frame = document.createElement('canvas');
const fctx = frame.getContext('2d', { willReadFrequently: true });
const rowCache = new Map(); // 이진화 행 해시 → 인식 결과
let busy = false, sharing = false;

const editor = new RoiEditor($('#overview'), $('#roiView'), () => fitColumns(true));
const table = new ResultTable($('#result'), $('#summary'), $('#chips'));
table.render();

function setStatus(text, cls = '') {
  statusEl.textContent = text;
  statusEl.className = 'status ' + cls;
}

const ocrReady = initOcr(s => setStatus(`OCR 엔진 로딩 중… ${s}`))
  .then(() => setStatus('OCR 준비 완료', 'ready'))
  .catch(e => { setStatus('OCR 로딩 실패: ' + e.message, 'error'); throw e; });

// 게임 해상도에 따라 UI가 확대·축소되어 들어오면(1366x768 기준) 원래 배율로 되돌려 frame에 그린다.
// 이후 행·열 분리, 숫자 템플릿, OCR은 모두 원래 배율 frame에서 동작한다.
let scale = (() => { try { return +localStorage.getItem('mgo.scale') || 1; } catch { return 1; } })();
let raw = null; // 마지막 원본 입력 { src, w, h } — 배율을 다시 잴 때 쓴다
const rawCanvas = document.createElement('canvas');
const rctx = rawCanvas.getContext('2d', { willReadFrequently: true });

// 배율이 1이 아니면 원본을 rawCanvas에 한 번 찍어 두고(OCR용 고해상도 칸도 같은 프레임에서 자른다) 줄여서 frame에 그린다.
function drawFrame() {
  const { src, w, h } = raw;
  let from = src;
  if (scale !== 1) {
    if (rawCanvas.width !== w || rawCanvas.height !== h) { rawCanvas.width = w; rawCanvas.height = h; }
    rctx.drawImage(src, 0, 0);
    from = rawCanvas;
  }
  const fw = Math.round(w / scale), fh = Math.round(h / scale);
  if (frame.width !== fw || frame.height !== fh) { frame.width = fw; frame.height = fh; }
  fctx.imageSmoothingEnabled = true;
  fctx.imageSmoothingQuality = 'high';
  fctx.drawImage(from, 0, 0, fw, fh);
}

function setFrame(src, w, h) {
  raw = { src, w, h };
  drawFrame();
  editor.setFrame(frame);
}

function rawData() {
  if (scale === 1) return frameData();
  return rctx.getImageData(0, 0, raw.w, raw.h);
}

// 확대된 화면이면 OCR용 칸은 줄이기 전 원본에서 자른다(r: 원래 배율 좌표 영역). 원래 배율 이하면 null.
function hiRes(r) {
  if (scale <= 1) return null;
  const d = rctx.getImageData(Math.round(r.x * scale), Math.round(r.y * scale), Math.ceil(r.w * scale), Math.ceil(r.h * scale));
  d.s = scale;
  return d;
}

function setScale(s) {
  if (s === scale) return;
  scale = s;
  try { localStorage.setItem('mgo.scale', String(s)); } catch {}
  exactStat.ok = exactStat.fail = 0; // 배율이 바뀌면 숫자 템플릿 성공률도 다시 잰다
  drawFrame();
  editor.setFrame(frame);
}

const frameData = () => fctx.getImageData(0, 0, frame.width, frame.height);

// ROI 안의 행을 찾고, 열 덩어리가 정확히 7개로 잡히면 경계를 자동으로 맞춘다.
function fitColumns(quiet) {
  if (!editor.roi) return;
  const img = frameData();
  const rows = detectRows(img, editor.roi);
  editor.setRows(rows);
  const d = autoDividers(img, editor.roi, rows);
  if (d) editor.setDividers(d);
  else if (!quiet) uiAlert('열을 자동으로 찾지 못했습니다. 주황 세로선을 직접 끌어 맞춰 주세요.');
}

// 자동 감지 영역이 아직 머리글 바로 아래에 있는지
let headerRef = null;
function headerOk() {
  const r = editor.roi;
  return !!r && sameStrip(headerStrip(fctx, r), headerRef);
}

// 표를 찾아 ROI로 지정. 수동 지정 영역(auto=false)은 force일 때만 덮어쓴다.
function autoLocate(force) {
  if (!frame.width || (!force && editor.roi && (!editor.auto || headerOk()))) return !!editor.roi;
  let roi = scale === 1 ? findTable(frameData()) : null;
  if (!roi) {
    // 배율이 바뀌었거나(해상도 변경) 원래 배율이 아닌 화면: 원본에서 머리글 폭으로 배율을 잰다
    const img = rawData();
    const exact = findTable(img);
    const found = exact ? { scale: 1, roi: exact } : findTableScaled(img);
    if (!found) return false;
    setScale(found.scale);
    roi = found.roi;
  }
  editor.setRoi(roi, true);
  fitColumns(true);
  headerRef = headerStrip(fctx, roi);
  return true;
}

// 명단은 필수: 닉네임은 명단 안에서만 맞추므로 명단 없이 인식하지 않는다
const hasRoster = () => !!getRoster()?.members?.length;
const NEED_ROSTER = '먼저 "2. 길드원 명단"에서 월드와 길드명을 넣고 명단을 불러오세요.\n닉네임은 길드원 명단 안에서만 맞춥니다.';

async function recognize() {
  if (busy) return;
  if (!hasRoster()) return uiAlert(NEED_ROSTER);
  if (!frame.width) return uiAlert('먼저 화면을 가져오세요.');
  if (!editor.roi) return uiAlert('먼저 표 영역을 드래그로 지정하세요.');
  busy = true;
  try {
    await ocrReady;
    const img = frameData();
    img.hi = hiRes({ x: 0, y: 0, w: frame.width, h: frame.height });
    const rows = fullRows(detectRows(img, editor.roi), editor.roi);
    editor.setRows(rows);
    const cols = columnRects(editor.roi, editor.dividers);
    const t0 = performance.now();
    let done = 0, cached = 0;
    progressEl.textContent = `${rows.length}행 인식 중…`;
    const results = await Promise.all(rows.map(async band => {
      const key = regionHash(img, editor.roi.x, editor.roi.x + editor.roi.w, band[0], band[1] + 1) + '|' + editor.dividers.join();
      let r = rowCache.get(key);
      if (r) cached++;
      else { r = await recognizeRow(img, cols, band); rowCache.set(key, r); }
      progressEl.textContent = `${++done}/${rows.length}행 인식 중…`;
      return r;
    }));
    const added = table.merge(results);
    progressEl.textContent = `${rows.length}행 인식 (새로 추가 ${added}행, 캐시 ${cached}행) · ${((performance.now() - t0) / 1000).toFixed(1)}초`;
  } catch (e) {
    progressEl.textContent = '인식 실패: ' + e.message;
    console.error(e);
  } finally {
    busy = false;
  }
}

async function loadFile(file) {
  const bmp = await createImageBitmap(file);
  // 배율을 다시 잴 수 있게 원본을 캔버스에 보관
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  setFrame(c, c.width, c.height);
}

bindImageInputs($('#fileInput'), async files => {
  if (sharing) stopSharing();
  for (const f of files) {
    await loadFile(f);
    autoLocate(false);
    if (!hasRoster()) { progressEl.textContent = '길드원 명단을 불러온 뒤 "현재 화면 인식"을 누르세요.'; uiAlert(NEED_ROSTER); return; }
    if (editor.roi) await recognize();
  }
  if (!editor.roi) progressEl.textContent = '길드창 표를 찾지 못했습니다. 표 영역을 드래그로 지정한 뒤 "현재 화면 인식"을 누르세요.';
});

// 화면 공유 자동 캡처: 짧은 주기로 ROI를 보고 처음 보는 행만 대기열에 넣어 인식한다.
// 화면이 멈추길 기다리지 않으므로 빠르게 스크롤해도 지나간 행을 놓치지 않는다.
const TICK_MS = 120;
let timer = null, ticks = 0, prevKeys = null, gaps = 0, draining = false, rejected = 0;
const queue = [], seen = new Set();
const sightings = new Map(); // 행 해시 → 본 횟수. 스크롤 중 한 번만 스친 깨진 프레임 행은 거른다.
const exactStat = { ok: 0, fail: 0 }; // 숫자 템플릿 성공/실패 — 원본 배율 캡처인지 판단
// 정수배가 아닌 배율에서는 줄인 글자 가장자리의 중간 밝기 픽셀이 영상 노이즈로 임계값을 오가 같은 행도 해시가 달라진다.
// 그래서 처음 보는 해시는 열별 글자량 프로필이 거의 같은 기존 행의 키로 묶는다.
const profiles = []; // { key, p: Float32Array }
window.__mgo = {
  stats: () => ({ ticks, queued: seen.size, pending: queue.length, gaps, rejected, rows: table.rows.length }),
  lowRows: () => table.lowRows(),
  evalRows: () => table.evalRows(),
};

function rowProfile(img, band) {
  const { data, width } = img;
  const p = new Float32Array(width);
  for (let y = band[0]; y <= band[1]; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4, v = data[i] + data[i + 1] + data[i + 2];
      if (v > 220) p[x] += Math.min(1, (v - 220) / 300);
    }
  return p;
}
// 3px 창마다 글자량 차이가 모두 작으면 같은 행(숫자 한 글자만 달라도 그 자리에서 차이가 커진다)
function sameProfile(a, b) {
  if (a.length !== b.length) return false;
  for (let x = 0; x + 3 <= a.length; x++) {
    const d = a[x] - b[x] + a[x + 1] - b[x + 1] + a[x + 2] - b[x + 2];
    if (d > 2 || d < -2) return false;
  }
  return true;
}
function canonicalKey(img, band, key) {
  if (scale === 1 || Number.isInteger(scale) || seen.has(key) || sightings.has(key) || rowCache.has(key)) return key;
  const p = rowProfile(img, band);
  const hit = profiles.find(x => sameProfile(x.p, p));
  if (hit) return hit.key;
  profiles.push({ key, p });
  if (profiles.length > 3000) profiles.splice(0, 1000);
  return key;
}

function sampleRows() {
  const roi = editor.roi;
  const img = fctx.getImageData(roi.x, roi.y, roi.w, roi.h);
  const local = { x: 0, y: 0, w: roi.w, h: roi.h };
  const bands = fullRows(detectRows(img, local), local);
  const cols = columnRects(local, editor.dividers);
  const keys = bands.map(b => canonicalKey(img, b, regionHash(img, 0, roi.w, b[0], b[1] + 1) + '|' + editor.dividers.join()));
  // 직전 화면과 겹치는 행이 하나도 없으면 그 사이 행이 지나갔을 수 있다
  if (prevKeys?.length && keys.length && !keys.some(k => prevKeys.includes(k)) && seen.size) gaps++;
  prevKeys = keys;
  bands.forEach((band, i) => {
    if (seen.has(keys[i]) || rowCache.has(keys[i])) return;
    const n = (sightings.get(keys[i]) || 0) + 1;
    sightings.set(keys[i], n);
    if (n < 2) return;
    seen.add(keys[i]);
    if (img.hi === undefined) img.hi = hiRes(roi); // 고해상도 원본은 새 행이 있을 때만 잘라 둔다
    queue.push({ img, cols, band, key: keys[i] });
  });
  drain();
}

async function drain() {
  if (draining) return;
  draining = true;
  try {
    await ocrReady;
    while (queue.length) {
      const batch = queue.splice(0);
      progressEl.textContent = `새 행 ${batch.length}개 인식 중…`;
      const results = await Promise.all(batch.map(async j => {
        const r = await recognizeRow(j.img, j.cols, j.band);
        rowCache.set(j.key, r);
        return r;
      }));
      // 원본 배율 캡처(숫자 템플릿이 대부분 성공)인데 이 행만 실패했다면 깨진 행으로 보고 버린다
      const native = () => exactStat.ok >= 5 && exactStat.ok > exactStat.fail * 4;
      const good = results.filter(r => {
        r.exact ? exactStat.ok++ : exactStat.fail++;
        if (!r.exact && native()) { rejected++; return false; }
        return true;
      });
      table.merge(good);
    }
    progressEl.textContent = `자동 캡처 중 · ${table.rows.length}명`
      + (gaps ? ` · ⚠ 스크롤이 너무 빨라 누락됐을 수 있습니다(${gaps}회). 천천히 다시 훑어 주세요.` : '');
  } catch (e) {
    progressEl.textContent = '인식 실패: ' + e.message;
    console.error(e);
  } finally {
    draining = false;
  }
}

function stopSharing() {
  sharing = false;
  clearInterval(timer);
  stopShare(video);
  $('#btnShare').hidden = false;
  $('#btnStopShare').hidden = true;
  $('#chkAuto').disabled = true;
  $('#chkAuto').checked = false;
}

$('#btnShare').addEventListener('click', async () => {
  try {
    const stream = await startShare(video);
    stream.getVideoTracks()[0].addEventListener('ended', stopSharing);
  } catch (e) {
    if (e.name !== 'NotAllowedError') uiAlert('화면 공유 실패: ' + e.message);
    return;
  }
  sharing = true;
  $('#btnShare').hidden = true;
  $('#btnStopShare').hidden = false;
  $('#chkAuto').disabled = false;
  timer = setInterval(() => {
    if (!video.videoWidth || busy) return;
    raw = { src: video, w: video.videoWidth, h: video.videoHeight };
    drawFrame();
    if (ticks++ % 4 === 0 || !editor.frame) editor.setFrame(frame); // 미리보기 갱신은 가끔만
    // 자동 감지 영역은 길드창을 옮기면 다시 찾는다(약 1초 간격)
    if ((!editor.roi || editor.auto) && ticks % 8 === 0 && !headerOk()) autoLocate(true);
    if ($('#chkAuto').checked && editor.roi && (!editor.auto || headerOk())) sampleRows();
  }, TICK_MS);
});
$('#btnStopShare').addEventListener('click', stopSharing);
$('#chkAuto').addEventListener('change', e => {
  if (e.target.checked && !hasRoster()) { e.target.checked = false; uiAlert(NEED_ROSTER); }
});

$('#btnRecognize').addEventListener('click', recognize);
$('#btnAutoCols').addEventListener('click', () => fitColumns(false));
$('#btnFindTable').addEventListener('click', () => {
  if (!autoLocate(true)) uiAlert('길드창의 컨텐츠 참여 현황 표를 찾지 못했습니다. 드래그로 직접 지정해 주세요.');
});

// 길드원 명단(넥슨 API)
const rosterStatus = $('#rosterStatus');
function showRoster(r) {
  if (!r) return;
  $('#world').value = r.world;
  $('#guildName').value = r.name;
  const at = new Date(r.fetchedAt).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  rosterStatus.textContent = `${r.world} ${r.name} · 길드원 ${r.members.length}명`
    + ` · ${at} 조회${r.fromCache ? ' (24시간 캐시 사용 — 최신 명단은 강제 새로고침)' : ''}`;
  table.setRoster(r);
}
showRoster(getRoster());
try { $('#apiKey').value = localStorage.getItem('mgo.apiKey') || ''; } catch {}

async function loadRoster(force) {
  const world = $('#world').value.trim(), name = $('#guildName').value.trim(), key = $('#apiKey').value.trim();
  if (!world || !name) return uiAlert('월드와 길드명을 입력하세요.');
  try { localStorage.setItem('mgo.apiKey', key); } catch {}
  rosterStatus.textContent = '불러오는 중…';
  try {
    showRoster(await fetchRoster(world, name, key, force));
    table.rematch(matchMember);
    rowCache.clear(); // 이후 인식부터 명단 대조 적용
  } catch (e) {
    rosterStatus.textContent = '불러오기 실패: ' + e.message;
  }
}
$('#btnRoster').addEventListener('click', () => loadRoster(false));
$('#btnRosterRefresh').addEventListener('click', () => loadRoster(true));

// 결과/기록
const compareSel = $('#compare'), filterSel = $('#filter');

function refreshSnapshots(selectId = compareSel.value) {
  compareSel.innerHTML = '<option value="">비교 기록 없음</option>'
    + loadSnapshots().map(s => `<option value="${s.id}">${s.label} (${s.rows.length}명)</option>`).join('');
  compareSel.value = loadSnapshots().some(s => s.id === selectId) ? selectId : '';
}
refreshSnapshots();

const selectedSnapshot = () => loadSnapshots().find(s => s.id === compareSel.value);

filterSel.addEventListener('change', () => table.setFilter(filterSel.value));
table.onFilter = k => { filterSel.value = k; };
$('#chkOrig').addEventListener('change', e => table.setShowOrig(e.target.checked));
compareSel.addEventListener('change', () => table.setCompare(selectedSnapshot()));

$('#btnSave').addEventListener('click', async () => {
  if (!table.rows.length) return uiAlert('저장할 결과가 없습니다.');
  if (!(await reviewed('기록으로 저장'))) return;
  const label = await uiPrompt('기록 이름을 입력하세요.', new Date().toLocaleDateString('ko-KR') + ' 이번 주', { title: '기록 저장', ok: '저장' });
  if (!label) return;
  table.saveSnapshot(label);
  refreshSnapshots();
});
$('#btnLoad').addEventListener('click', async () => {
  const s = selectedSnapshot();
  if (!s) return uiAlert('위 목록에서 불러올 기록을 선택하세요.');
  if (table.rows.length && !(await uiConfirm('현재 결과를 지우고 선택한 기록을 불러올까요?', { title: '기록 불러오기', ok: '불러오기' }))) return;
  table.loadSnapshot(s);
  compareSel.value = '';
  table.setCompare(null);
});
$('#btnDelSnap').addEventListener('click', async () => {
  const s = selectedSnapshot();
  if (!s || !(await uiConfirm(`"${s.label}" 기록을 삭제할까요?`, { title: '기록 삭제', ok: '삭제', danger: true }))) return;
  ResultTable.deleteSnapshot(s.id);
  refreshSnapshots('');
  table.setCompare(null);
});

// 확인 절차: 확인이 필요한 행이 남아 있으면 저장·내보내기 전에 한 번 더 묻는다
async function reviewed(action) {
  const n = table.unratedCount();
  if (!n || await uiConfirm(`확인이 필요한 ${n}행을 아직 평가하지 않았습니다.\n그대로 ${action}할까요?`, { title: '검토가 남아 있습니다', ok: `그대로 ${action}`, cancel: '검토하기' })) return true;
  table.setFilter('unrated');
  filterSel.value = 'unrated';
  return false;
}

$('#btnCsv').addEventListener('click', async () => { if (await reviewed('CSV로 저장')) table.downloadCsv(); });
$('#btnLowJson').addEventListener('click', async () => {
  const bad = table.evalRows().length, unrated = table.unratedCount();
  if (!bad) return uiAlert('"틀림"으로 평가한 행이 없습니다. 검토 필터에서 맞음/틀림을 평가해 주세요.');
  const noTruth = table.evalRows().filter(r => !r.truthKnown).length;
  const notes = [
    unrated && `평가하지 않은 ${unrated}건은 제외됩니다.`,
    noTruth && `틀림 ${bad}건 중 ${noTruth}건은 정답 닉네임을 고르지 않았습니다(검색칸에서 선택하면 분석에 도움이 됩니다).`,
  ].filter(Boolean);
  if (notes.length && !(await uiConfirm(`${notes.join('\n')}\n\n틀림 ${bad}건을 내보낼까요?`, { title: '오인식 내보내기', ok: '내보내기' }))) return;
  table.downloadLowJson();
});
$('#btnCopy').addEventListener('click', async () => {
  if (!(await reviewed('복사'))) return;
  await table.copyTsv();
  progressEl.textContent = '클립보드에 복사했습니다. 엑셀에 붙여넣으세요.';
});
$('#btnClear').addEventListener('click', async () => {
  if (table.rows.length && await uiConfirm('결과를 모두 지울까요?', { title: '전체 지우기', ok: '지우기', danger: true })) {
    table.clear();
    rowCache.clear();
    seen.clear();
    sightings.clear();
    prevKeys = null;
    gaps = rejected = 0;
  }
});

// 패널 접기: 제목 클릭으로 토글, 상태는 localStorage에 기억
const FOLD_KEY = 'mgo.folded';
let folded = [];  // 저장값이 없으면 모두 펼친 상태로 시작(명단·표 영역은 필수 단계)
try { folded = JSON.parse(localStorage.getItem(FOLD_KEY)) ?? folded; } catch {}
document.querySelectorAll('.panel[data-fold]').forEach(panel => {
  const id = panel.dataset.fold;
  panel.classList.toggle('folded', folded.includes(id));
  panel.querySelector('h2').addEventListener('click', e => {
    if (e.target.closest('.tip')) return;
    const on = panel.classList.toggle('folded');
    folded = on ? [...new Set([...folded, id])] : folded.filter(f => f !== id);
    try { localStorage.setItem(FOLD_KEY, JSON.stringify(folded)); } catch {}
  });
});

// 월드 입력: 입력 즉시 필터 + 초성 검색
attachCombo($('#world'), [...document.querySelectorAll('#worlds option')].map(o => o.textContent));

// 오인식 자동 제보: 틀림으로 평가한 행을 모아 서버(Vercel Blob)에 저장
startReporter(table, $('#chkReport'), () => ({
  scale,
  frame: raw ? [raw.w, raw.h] : null,
  share: sharing,
  at: new Date().toISOString(),
}));
