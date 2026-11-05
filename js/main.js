import { RoiEditor } from './roi.js';
import { detectRows, fullRows, autoDividers, columnRects, regionHash } from './segment.js';
import { initOcr, recognizeRow } from './ocr.js';
import { ResultTable, loadSnapshots } from './table.js';
import { startShare, stopShare, bindImageInputs } from './capture.js';
import { findTable, headerStillThere } from './detect.js';
import { fetchRoster, getRoster, matchMember } from './members.js';
import { attachCombo } from './combo.js';

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

function setFrame(src, w, h) {
  if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
  fctx.drawImage(src, 0, 0);
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
  else if (!quiet) alert('열을 자동으로 찾지 못했습니다. 주황 세로선을 직접 끌어 맞춰 주세요.');
}

// 자동 감지 영역이 아직 머리글 바로 아래에 있는지
function headerOk() {
  const r = editor.roi;
  return r && r.y >= 1 && headerStillThere(fctx.getImageData(r.x, r.y - 1, r.w, 1));
}

// 표를 찾아 ROI로 지정. 수동 지정 영역(auto=false)은 force일 때만 덮어쓴다.
function autoLocate(force) {
  if (!frame.width || (!force && editor.roi && (!editor.auto || headerOk()))) return !!editor.roi;
  const roi = findTable(frameData());
  if (!roi) return false;
  editor.setRoi(roi, true);
  fitColumns(true);
  return true;
}

async function recognize() {
  if (busy) return;
  if (!frame.width) return alert('먼저 화면을 가져오세요.');
  if (!editor.roi) return alert('먼저 표 영역을 드래그로 지정하세요.');
  busy = true;
  try {
    await ocrReady;
    const img = frameData();
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
  setFrame(bmp, bmp.width, bmp.height);
  bmp.close();
}

bindImageInputs($('#fileInput'), async files => {
  if (sharing) stopSharing();
  for (const f of files) {
    await loadFile(f);
    autoLocate(false);
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
window.__mgo = {
  stats: () => ({ ticks, queued: seen.size, pending: queue.length, gaps, rejected, rows: table.rows.length }),
  lowRows: () => table.lowRows(),
  evalRows: () => table.evalRows(),
};

function sampleRows() {
  const roi = editor.roi;
  const img = fctx.getImageData(roi.x, roi.y, roi.w, roi.h);
  const local = { x: 0, y: 0, w: roi.w, h: roi.h };
  const bands = fullRows(detectRows(img, local), local);
  const cols = columnRects(local, editor.dividers);
  const keys = bands.map(b => regionHash(img, 0, roi.w, b[0], b[1] + 1) + '|' + editor.dividers.join());
  // 직전 화면과 겹치는 행이 하나도 없으면 그 사이 행이 지나갔을 수 있다
  if (prevKeys?.length && keys.length && !keys.some(k => prevKeys.includes(k)) && seen.size) gaps++;
  prevKeys = keys;
  bands.forEach((band, i) => {
    if (seen.has(keys[i]) || rowCache.has(keys[i])) return;
    const n = (sightings.get(keys[i]) || 0) + 1;
    sightings.set(keys[i], n);
    if (n < 2) return;
    seen.add(keys[i]);
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
    if (e.name !== 'NotAllowedError') alert('화면 공유 실패: ' + e.message);
    return;
  }
  sharing = true;
  $('#btnShare').hidden = true;
  $('#btnStopShare').hidden = false;
  $('#chkAuto').disabled = false;
  timer = setInterval(() => {
    if (!video.videoWidth || busy) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (frame.width !== w || frame.height !== h) { frame.width = w; frame.height = h; }
    fctx.drawImage(video, 0, 0);
    if (ticks++ % 4 === 0 || !editor.frame) editor.setFrame(frame); // 미리보기 갱신은 가끔만
    // 자동 감지 영역은 길드창을 옮기면 다시 찾는다(약 1초 간격)
    if ((!editor.roi || editor.auto) && ticks % 8 === 0 && !headerOk()) autoLocate(true);
    if ($('#chkAuto').checked && editor.roi && (!editor.auto || headerOk())) sampleRows();
  }, TICK_MS);
});
$('#btnStopShare').addEventListener('click', stopSharing);

$('#btnRecognize').addEventListener('click', recognize);
$('#btnAutoCols').addEventListener('click', () => fitColumns(false));
$('#btnFindTable').addEventListener('click', () => {
  if (!autoLocate(true)) alert('길드창의 컨텐츠 참여 현황 표를 찾지 못했습니다. 드래그로 직접 지정해 주세요.');
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
  if (!world || !name) return alert('월드와 길드명을 입력하세요.');
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

$('#btnSave').addEventListener('click', () => {
  if (!table.rows.length) return alert('저장할 결과가 없습니다.');
  const label = prompt('기록 이름', new Date().toLocaleDateString('ko-KR') + ' 이번 주');
  if (!label) return;
  table.saveSnapshot(label);
  refreshSnapshots();
});
$('#btnLoad').addEventListener('click', () => {
  const s = selectedSnapshot();
  if (!s) return alert('위 목록에서 불러올 기록을 선택하세요.');
  if (table.rows.length && !confirm('현재 결과를 지우고 선택한 기록을 불러올까요?')) return;
  table.loadSnapshot(s);
  compareSel.value = '';
  table.setCompare(null);
});
$('#btnDelSnap').addEventListener('click', () => {
  const s = selectedSnapshot();
  if (!s || !confirm(`"${s.label}" 기록을 삭제할까요?`)) return;
  ResultTable.deleteSnapshot(s.id);
  refreshSnapshots('');
  table.setCompare(null);
});

$('#btnCsv').addEventListener('click', () => table.downloadCsv());
$('#btnLowJson').addEventListener('click', () => {
  const bad = table.evalRows().length, unrated = table.unratedCount();
  if (!bad) return alert('"틀림"으로 평가한 행이 없습니다. 검토 필터에서 맞음/틀림을 평가해 주세요.');
  const noTruth = table.evalRows().filter(r => !r.truthKnown).length;
  const notes = [
    unrated && `평가하지 않은 ${unrated}건은 제외됩니다.`,
    noTruth && `틀림 ${bad}건 중 ${noTruth}건은 정답 닉네임을 고르지 않았습니다(검색칸에서 선택하면 분석에 도움이 됩니다).`,
  ].filter(Boolean);
  if (notes.length && !confirm(`${notes.join('\n')}\n\n틀림 ${bad}건을 내보낼까요?`)) return;
  table.downloadLowJson();
});
$('#btnCopy').addEventListener('click', async () => {
  await table.copyTsv();
  progressEl.textContent = '클립보드에 복사했습니다. 엑셀에 붙여넣으세요.';
});
$('#btnClear').addEventListener('click', () => {
  if (table.rows.length && confirm('결과를 모두 지울까요?')) {
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
let folded = ['roi'];  // 저장값이 없으면 2. 표 영역 지정만 접힌 상태로 시작
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
