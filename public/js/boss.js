// 보스 분배금 계산기 페이지: 경매장 판매 기록 OCR → 판매액 합계 → 분배 계산.
import { startShare, stopShare, bindImageInputs } from './capture.js';
import { initAuctionOcr, readAuction, onAuctionProgress } from './auction-ocr.js';
import {
  MAX_DIGITS, actualFromAuction, auctionFromActual, roleLabel, ratioPercent, split, leaderSurplus, korean, comma,
} from './boss-calc.js';

const $ = s => document.querySelector(s);
const STORE_KEY = 'bossCalc.v1';

/* ---------------- 상태 ---------------- */
const state = {
  commission: 5,
  count: 2,
  ratioMode: false,
  ratios: [1, 1],
  auction: 0,
  actual: 0,
  lastEdited: 'auction', // 수수료 바뀔 때 어느 쪽을 기준으로 다시 계산할지
  fromItems: false,      // 판매액이 OCR 목록 합계에서 왔는지
  items: [],             // {name, value, checked, dup}
};

function save() {
  try {
    const { commission, count, ratioMode, ratios, items } = state;
    localStorage.setItem(STORE_KEY, JSON.stringify({ commission, count, ratioMode, ratios, items }));
  } catch { /* 저장 불가 환경은 무시 */ }
}

function load() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
    if (!s) return;
    if ([0, 3, 5].includes(s.commission)) state.commission = s.commission;
    if (s.count >= 2 && s.count <= 6) state.count = s.count;
    state.ratioMode = !!s.ratioMode;
    if (Array.isArray(s.ratios)) state.ratios = s.ratios.map(n => Math.max(0, Math.min(999, n | 0)));
    if (Array.isArray(s.items)) state.items = s.items.filter(i => i && Number.isFinite(i.value));
  } catch { /* 깨진 값은 무시 */ }
}

/* ---------------- 판매 기록 목록 ---------------- */
function itemsTotal() {
  return state.items.filter(i => i.checked).reduce((s, i) => s + i.value, 0);
}

function applyItemsToAuction() {
  if (!state.items.length) {
    if (state.fromItems) setAuction(0);
    state.fromItems = false;
    return;
  }
  setAuction(itemsTotal());
  state.fromItems = true;
}

function renderItems() {
  const box = $('#items');
  box.innerHTML = '';
  state.items.forEach((it, idx) => {
    const row = document.createElement('div');
    row.className = 'item' + (it.dup ? ' dup' : '');
    row.innerHTML = `
      <input type="checkbox" title="합계에 포함">
      <span class="pg" title="인식한 페이지">${it.page != null ? `p${it.page}` : ''}</span>
      <input type="text" class="name" placeholder="아이템명">
      <input type="number" class="val" min="0">
      <span class="kr"></span>
      <button type="button" class="del" title="삭제">✕</button>`;
    const [chk, name, val] = row.querySelectorAll('input');
    const kr = row.querySelector('.kr');
    chk.checked = it.checked;
    name.value = it.name;
    val.value = it.value || '';
    kr.textContent = it.dup ? '중복?' : korean(it.value);
    chk.onchange = () => { it.checked = chk.checked; onItemsChanged(false); };
    name.oninput = () => { it.name = name.value; save(); };
    val.oninput = () => {
      it.value = Math.max(0, parseInt(val.value, 10) || 0);
      kr.textContent = korean(it.value);
      onItemsChanged(false);
    };
    row.querySelector('.del').onclick = () => { state.items.splice(idx, 1); onItemsChanged(true); };
    box.appendChild(row);
  });
  const n = state.items.filter(i => i.checked).length;
  $('#itemsTotal').innerHTML = state.items.length
    ? `합계 <b>${korean(itemsTotal())}</b> 메소 (${n}/${state.items.length}건)`
    : '';
}

function onItemsChanged(rerender) {
  if (!state.items.length) clearCrops();
  if (rerender) renderItems();
  else $('#itemsTotal').innerHTML = `합계 <b>${korean(itemsTotal())}</b> 메소 (${state.items.filter(i => i.checked).length}/${state.items.length}건)`;
  applyItemsToAuction();
  renderCalc();
  save();
}

// 중복 판정
// - 페이지 번호를 읽었으면: 그 페이지 건이 이미 목록에 있으면 캡처 전체를 건너뛴다.
//   (다른 페이지의 같은 금액은 별개 판매로 인정)
// - 못 읽었으면: 이미 목록에 있는 금액을 건너뛴다. 같은 캡처 안의 같은 금액은 그 개수만큼 인정.
function addItems(found, page) {
  if (page != null && state.items.some(i => i.page === page)) return 0;
  const have = new Map();
  if (page == null) for (const i of state.items) have.set(i.value, (have.get(i.value) || 0) + 1);
  const seen = new Map();
  let added = 0;
  for (const f of found) {
    const n = (seen.get(f.value) || 0) + 1;
    seen.set(f.value, n);
    if (n <= (have.get(f.value) || 0)) continue;
    state.items.push({ name: f.name, value: f.value, checked: true, dup: false, page });
    added++;
  }
  if (added) onItemsChanged(true);
  return added;
}

/* ---------------- 판매 내역 이미지 ---------------- */
// 인식한 캡처에서 잘라낸 판매 행 이미지. 페이지 순으로 이어 붙여 복사한다. (메모리에만 보관)
let crops = []; // {page, canvas, seq}
let cropSeq = 0;

function addCrop(canvas, page) {
  if (page != null) crops = crops.filter(c => c.page !== page);
  crops.push({ page, canvas, seq: cropSeq++ });
  renderCropPreview();
}

function clearCrops() {
  crops = [];
  renderCropPreview();
}

function combinedCrops() {
  if (!crops.length) return null;
  const list = [...crops].sort((a, b) =>
    (a.page ?? Infinity) - (b.page ?? Infinity) || a.seq - b.seq);
  const gap = 4;
  const c = document.createElement('canvas');
  c.width = Math.max(...list.map(x => x.canvas.width));
  c.height = list.reduce((s, x) => s + x.canvas.height, 0) + gap * (list.length - 1);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#2a2f36';
  ctx.fillRect(0, 0, c.width, c.height);
  let y = 0;
  for (const x of list) { ctx.drawImage(x.canvas, 0, y); y += x.canvas.height + gap; }
  return c;
}

function renderCropPreview() {
  const img = $('#cropPreview');
  const c = combinedCrops();
  img.hidden = !c;
  if (c) img.src = c.toDataURL('image/png');
  else img.removeAttribute('src');
}

async function copyCropImage() {
  const msg = $('#copyImgMsg');
  const c = combinedCrops();
  if (!c) {
    msg.textContent = state.items.length
      ? '복사할 이미지가 없습니다. 새로고침 후에는 캡처를 다시 인식해야 합니다.'
      : '먼저 판매 기록 캡처를 인식하세요.';
    return;
  }
  try {
    const blob = new Promise(res => c.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    msg.textContent = `판매 내역 이미지를 복사했습니다 (${crops.length}장 이어 붙임).`;
  } catch (e) {
    msg.textContent = '이미지 복사가 막혔습니다: ' + e.message;
  }
  setTimeout(() => { msg.textContent = ''; }, 3000);
}

/* ---------------- OCR ---------------- */
// 누른 시점의 화면을 캡처해 대기열에 넣고 순서대로 읽는다.
// 같은 페이지를 여러 번 넣어도 위의 중복 판정으로 한 번만 반영된다.
let busy = Promise.resolve();
let pending = 0;

// 처리 중 표시: 진행 막대 (대기 중인 건이 있으면 계속 표시)
function setProgress(v) {
  const pct = Math.round(Math.max(0, Math.min(1, v)) * 100);
  $('#ocrBar').style.width = pct + '%';
  $('#ocrPct').textContent = pct + '%';
}
function showBusy(on) {
  $('#ocrBusy').hidden = !on;
  if (on) setProgress(0);
}
onAuctionProgress(setProgress);

function recognize(src, label) {
  pending++;
  showBusy(true);
  if (pending > 1) $('#ocrMsg').textContent = `인식 중… (대기 ${pending - 1}건)`;
  busy = busy.then(async () => {
    const msg = $('#ocrMsg');
    setProgress(0);
    msg.textContent = `${label} 인식 중…${pending > 1 ? ` (대기 ${pending - 1}건)` : ''}`;
    try {
      const { items, text, page, crop } = await readAuction(src);
      const pg = page != null ? `${page}페이지: ` : '';
      if (!items.length) {
        msg.textContent = `${pg}금액을 찾지 못했습니다. 경매장 → 완료 → 거래 기록 → 판매 완료 화면인지 확인하세요.`;
        console.log('[분배금] OCR 원문\n' + text);
        return;
      }
      const added = addItems(items, page);
      const skipped = items.length - added;
      if (added && crop) addCrop(crop, page);
      if (!added && page != null) msg.textContent = `${page}페이지는 이미 인식했습니다. 다음 페이지로 넘긴 뒤 다시 인식하세요.`;
      else if (!added) msg.textContent = `새 판매 건이 없습니다 (${skipped}건 모두 이미 목록에 있음).`;
      else msg.textContent = `${pg}${added}건 추가${skipped ? ` (이미 있는 ${skipped}건 건너뜀)` : ''}. 틀린 금액은 직접 고치세요.`;
    } catch (e) {
      console.error(e);
      msg.textContent = 'OCR 실패: ' + e.message;
    } finally {
      pending--;
      if (!pending) showBusy(false);
    }
  });
  return busy;
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(img.src); resolve(img); };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

/* ---------------- 계산기 ---------------- */
function clampDigits(v) {
  const s = String(Math.max(0, Math.floor(v || 0)));
  return Number(s.slice(0, MAX_DIGITS));
}

function setAuction(v) {
  state.auction = clampDigits(v);
  state.actual = state.auction ? actualFromAuction(state.auction, state.commission) : 0;
  state.lastEdited = 'auction';
}

function setActual(v) {
  state.actual = clampDigits(v);
  state.auction = state.actual ? auctionFromActual(state.actual, state.commission) : 0;
  state.lastEdited = 'actual';
}

function syncRatios() {
  const r = state.ratios.slice(0, state.count);
  while (r.length < state.count) r.push(1);
  state.ratios = r;
}

function renderRatios() {
  const box = $('#ratioBox');
  box.hidden = !state.ratioMode;
  if (!state.ratioMode) return;
  box.innerHTML = '';
  state.ratios.forEach((v, i) => {
    if (i) box.insertAdjacentHTML('beforeend', '<span class="sep">:</span>');
    const wrap = document.createElement('label');
    wrap.className = 'ratio' + (i === 0 ? ' leader' : '');
    wrap.innerHTML = `<span>${roleLabel(i, state.count)}</span><input type="number" min="0" max="999" inputmode="numeric">`;
    const inp = wrap.querySelector('input');
    inp.value = v || '';
    inp.oninput = () => {
      state.ratios[i] = Math.max(0, Math.min(999, parseInt(inp.value, 10) || 0));
      updateRatioSum();
      renderCalc();
      save();
    };
    box.appendChild(wrap);
  });
  box.insertAdjacentHTML('beforeend', '<div class="sum" id="ratioSum"></div>');
  updateRatioSum();
}

function updateRatioSum() {
  const el = $('#ratioSum');
  if (!el) return;
  const sum = state.ratios.reduce((a, b) => a + b, 0);
  el.classList.toggle('bad', !sum);
  el.textContent = sum
    ? state.ratios.map((r, i) => `${roleLabel(i, state.count)} ${ratioPercent(r, sum)}%`).join(' · ')
    : '비율 합계가 0입니다. 한 칸 이상 입력하세요.';
}

function currentSplit() {
  const ratios = state.ratioMode ? state.ratios : Array(state.count).fill(1);
  return split(state.actual, state.commission, ratios);
}

function card(label, amount, sub, extra = '', hl = false) {
  return `<div class="card${hl ? ' hl' : ''}">
    <span class="lbl">${label}${extra}</span>
    <span class="v">${comma(amount)}</span>
    <span class="u">${korean(amount)} 메소</span>
    <span class="s">${sub}</span>
  </div>`;
}

function renderCalc() {
  const ap = $('#auctionPrice'), aa = $('#actualAmount');
  if (document.activeElement !== ap) ap.value = state.auction || '';
  if (document.activeElement !== aa) aa.value = state.actual || '';
  $('#auctionKr').textContent = state.auction ? `${korean(state.auction)} 메소` : '';
  $('#actualKr').textContent = state.actual ? `${korean(state.actual)} 메소` : '';
  $('#auctionSrc').textContent = state.fromItems ? '· 판매 기록 합계' : '';

  document.querySelectorAll('#segCommission button').forEach(b => b.classList.toggle('on', +b.dataset.v === state.commission));
  document.querySelectorAll('#segCount button').forEach(b => b.classList.toggle('on', +b.dataset.v === state.count));

  const badge = $('#modeBadge');
  badge.textContent = state.ratioMode ? `비율 ${state.ratios.join(':')}` : '공평 분배';
  badge.classList.toggle('custom', state.ratioMode);

  const cards = $('#resultCards');
  const dist = currentSplit();
  if (!dist) {
    cards.innerHTML = `<div class="card empty">${state.actual ? '비율을 확인하세요.' : '판매액 또는 실제 수령액을 입력하세요.'}</div>`;
    return;
  }
  if (state.ratioMode) {
    cards.innerHTML = dist.map((d, i) => card(
      d.label, d.amount,
      i === 0 ? '실수령 기준 잔여' : '전달 금액 (수수료 포함)',
      `<b>${d.pct}%</b>`, i === 1 && dist.length === 2,
    )).join('');
  } else {
    const { diff, rate } = leaderSurplus(dist, state.commission);
    cards.innerHTML =
      card('파티장 분배금', dist[0].amount, '실수령 기준 잔여') +
      card('파티원 분배금 (1인)', dist[1].amount, '전달 금액 (수수료 포함)', '', true) +
      `<div class="card"><span class="lbl">오차액 / 오차율</span>
        <span class="v">${comma(Math.round(diff))}</span>
        <span class="u">${rate >= 0.00001 ? rate.toFixed(5) + '%' : '0.00001% 미만'}</span>
        <span class="s">파티장이 파티원 실수령보다 더 갖는 금액</span></div>`;
  }
}

function resultText() {
  const dist = currentSplit();
  if (!dist) return '';
  const mode = state.ratioMode ? `비율 ${state.ratios.join(' : ')}` : '공평 분배';
  const lines = [
    '[보스 분배금]',
    `판매액 ${korean(state.auction)} / 실수령 ${korean(state.actual)}`,
    `${state.count}인 · ${mode} · 수수료 ${state.commission}%`,
  ];
  const sold = state.items.filter(i => i.checked);
  if (sold.length) {
    // 한글은 2칸으로 세어 콜론 위치를 맞춤
    const width = s => [...s].reduce((n, ch) => n + (/[ㄱ-ㅎ가-힣]/.test(ch) ? 2 : 1), 0);
    const names = sold.map(i => i.name || '?');
    const max = Math.max(...names.map(width));
    lines.push('판매 내역');
    sold.forEach((it, k) => lines.push(`- ${names[k]}${' '.repeat(max - width(names[k]) + 3)}: ${korean(it.value)}`));
  }
  dist.forEach((d, i) => lines.push(`${d.label}${state.ratioMode ? ` (${d.pct}%)` : ''}: ${korean(d.amount)}${i ? ` / ${Math.floor(d.amount)}` : ''}`));
  return lines.join('\n');
}

/* ---------------- 이벤트 ---------------- */
function bind() {
  $('#auctionPrice').addEventListener('input', e => {
    setAuction(parseInt(e.target.value, 10) || 0);
    state.fromItems = false;
    renderCalc();
  });
  $('#actualAmount').addEventListener('input', e => {
    setActual(parseInt(e.target.value, 10) || 0);
    state.fromItems = false;
    renderCalc();
  });
  $('#segCommission').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined) return;
    state.commission = +v;
    if (state.lastEdited === 'auction') setAuction(state.auction);
    else setActual(state.actual);
    renderCalc(); save();
  });
  $('#segCount').addEventListener('click', e => {
    const v = e.target.closest('button')?.dataset.v;
    if (v === undefined) return;
    state.count = +v;
    syncRatios(); renderRatios(); renderCalc(); save();
  });
  $('#chkRatio').addEventListener('change', e => {
    state.ratioMode = e.target.checked;
    syncRatios(); renderRatios(); renderCalc(); save();
  });
  $('#btnCopyResult').addEventListener('click', async () => {
    const text = resultText();
    const msg = $('#copyMsg');
    if (!text) { msg.textContent = '복사할 결과가 없습니다.'; return; }
    try { await navigator.clipboard.writeText(text); msg.textContent = '복사했습니다.'; }
    catch { msg.textContent = '클립보드 복사가 막혔습니다.'; }
    setTimeout(() => { msg.textContent = ''; }, 2000);
  });

  $('#btnAddItem').addEventListener('click', () => {
    state.items.push({ name: '', value: 0, checked: true, dup: false });
    onItemsChanged(true);
    $('#items .item:last-child .val')?.focus();
  });
  $('#btnCopyImage').addEventListener('click', copyCropImage);
  $('#btnClearItems').addEventListener('click', () => {
    state.items = [];
    clearCrops();
    showSource(null);
    $('#ocrMsg').textContent = '';
    onItemsChanged(true);
  });

  // 이미지 입력 (붙여넣기·드래그·파일)
  // 마지막으로 넣은 스크린샷 미리보기 (화면 공유 중이면 공유 화면이 대신 보임)
  let previewUrl = null;
  const showSource = file => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = file ? URL.createObjectURL(file) : null;
    const img = $('#srcPreview');
    if (previewUrl) img.src = previewUrl; else img.removeAttribute('src');
    img.hidden = !previewUrl || !!$('#video').srcObject;
  };
  bindImageInputs($('#fileInput'), async files => {
    showSource(files[files.length - 1]);
    for (const f of files) await recognize(await loadImage(f), f.name || '붙여넣은 이미지');
  });
  let dragDepth = 0;
  document.addEventListener('dragenter', () => { dragDepth++; document.body.classList.add('dragging'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
  document.addEventListener('drop', () => { dragDepth = 0; document.body.classList.remove('dragging'); });

  // 화면 공유
  const video = $('#video');
  const setSharing = on => {
    $('#btnShare').hidden = on;
    $('#btnStopShare').hidden = !on;
    $('#btnGrab').disabled = !on;
    video.hidden = !on;
    $('#srcPreview').hidden = on || !$('#srcPreview').getAttribute('src');
  };
  $('#btnShare').addEventListener('click', async () => {
    try {
      const stream = await startShare(video);
      stream.getVideoTracks()[0].addEventListener('ended', () => setSharing(false));
      setSharing(true);
    } catch (e) {
      if (e.name !== 'NotAllowedError') $('#ocrMsg').textContent = '화면 공유 실패: ' + e.message;
    }
  });
  $('#btnStopShare').addEventListener('click', () => { stopShare(video); setSharing(false); });
  $('#btnGrab').addEventListener('click', () => {
    if (!video.videoWidth) return;
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    recognize(c, '공유 화면');
  });
}

/* ---------------- 시작 ---------------- */
load();
syncRatios();
$('#chkRatio').checked = state.ratioMode;
bind();
renderRatios();
renderItems();
applyItemsToAuction();
renderCalc();

const status = $('#ocrStatus');
initAuctionOcr(t => { status.textContent = t; })
  .then(() => { status.textContent = 'OCR 준비 완료'; status.className = 'status ready'; })
  .catch(e => { status.textContent = 'OCR 로딩 실패: ' + e.message; status.className = 'status error'; });
