// 결과 표: 병합(중복 제거), 렌더링, 편집, 정렬/필터, 내보내기, 기록 저장/비교.
import { addCustomJob } from './jobs.js';
import { jamo, distance } from './hangul.js';
import { assignByElimination, candidatesFor } from './members.js';
import { learnName } from './names.js';
import { cleanName } from './ocr.js';

const SNAP_KEY = 'mgo.snapshots';
const COLS = [
  { key: 'online', label: '접속' },
  { key: 'name', label: '닉네임', edit: true },
  { key: 'job', label: '직업', edit: true },
  { key: 'level', label: '레벨', edit: true, num: true },
  { key: 'rank', label: '직위', edit: true },
  { key: 'mission', label: '주간미션', edit: true, num: true },
  { key: 'suro', label: '지하수로', edit: true, num: true },
  { key: 'flag', label: '플래그', edit: true, num: true },
];
const FIELDS = ['name', 'job', 'level', 'rank', 'mission', 'suro', 'flag'];

const fmt = v => (v == null ? '' : v.toLocaleString('ko-KR'));
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// 스크롤 캡처 사이 중복 판정 키. 점수가 있으면 점수 조합만으로(닉네임 오인식에 강함), 0점이면 닉네임 포함.
// 닉네임은 소거법 추정으로 바뀔 수 있으므로 OCR 원문(rawName)을 쓴다.
const sig = r => (r.suro > 0 ? `${r.level}|${r.job}|${r.suro}|${r.flag}|${r.mission}` : `${r.rawName ?? r.name}|${r.level}|${r.job}`);

export function loadSnapshots() {
  try { return JSON.parse(localStorage.getItem(SNAP_KEY)) || []; } catch { return []; }
}
function saveSnapshots(list) {
  try { localStorage.setItem(SNAP_KEY, JSON.stringify(list)); } catch { alert('브라우저 저장소에 저장하지 못했습니다.'); }
}

export class ResultTable {
  constructor(table, summaryEl, chipsEl) {
    this.table = table;
    this.summaryEl = summaryEl;
    this.chipsEl = chipsEl;
    this.onFilter = null; // 빠른 필터 버튼으로 바뀌었을 때 알림(필터 select 동기화)
    chipsEl.addEventListener('click', e => {
      const k = e.target.closest('button')?.dataset.filter;
      if (!k) return;
      this.setFilter(k);
      this.onFilter?.(k);
    });
    this.rows = [];
    this.sortKey = 'suro';
    this.sortAsc = false;
    this.filter = 'all';
    this.compare = null; // name → 비교 기록 행
    this.roster = null; // 넥슨 API 길드원 명단
    this.showOrig = false; // 각 행 아래에 원본 캡처 행 표시
    this.table.tHead.addEventListener('click', e => this.#onSort(e));
    this.table.tBodies[0].addEventListener('blur', e => this.#onEdit(e), true);
    this.table.tBodies[0].addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); }
    });
    this.table.tBodies[0].addEventListener('change', e => this.#pick(e));
    this.table.tBodies[0].addEventListener('click', e => {
      const ev = e.target.closest('button.ev');
      if (ev) return this.#onEval(ev);
      const cand = e.target.closest('button.cand');
      if (cand) {
        const r = this.rows.find(x => x.id === cand.dataset.id);
        if (r) this.#applyName(r, cand.dataset.name);
        return;
      }
      const id = e.target.closest('.del')?.dataset.id;
      if (id) { this.rows = this.rows.filter(r => r.id !== id); this.render(); }
    });
  }

  // 새 행을 합친다. 반환: 추가된 행 수
  merge(newRows) {
    const seen = new Set(this.rows.map(sig));
    let added = 0;
    for (const r of newRows) {
      const k = sig(r);
      if (seen.has(k)) continue;
      seen.add(k);
      this.rows.push({ ...r, id: crypto.randomUUID(), review: r.low.length > 0 || !!r.fuzzy });
      added++;
    }
    this.#normalizeRanks();
    this.#eliminate();
    this.render();
    return added;
  }

  clear() {
    this.rows = [];
    this.render();
  }

  // 한 번만 나온 직위가 더 흔한 직위와 자모 기준으로 가까우면 흔한 쪽으로 맞춘다(막바 → 악마, 직위는 길드마다 몇 개뿐).
  #normalizeRanks() {
    const cnt = new Map();
    for (const r of this.rows) cnt.set(r.rank, (cnt.get(r.rank) || 0) + 1);
    const common = [...cnt].filter(([, c]) => c >= 2).map(([k]) => k);
    for (const r of this.rows) {
      if (cnt.get(r.rank) !== 1) continue;
      const a = jamo(r.rank);
      const m = common.find(k => distance(jamo(k), a) <= Math.max(1, Math.floor(a.length * 0.4)));
      if (m) { r.rank = m; r.low = r.low.filter(f => f !== 'rank'); }
    }
  }

  setFilter(f) { this.filter = f; this.render(); }

  setRoster(roster) {
    this.roster = roster;
    // 닉네임 검색 입력이 함께 쓰는 명단 목록
    let dl = document.getElementById('rosterList');
    if (!dl) { dl = document.createElement('datalist'); dl.id = 'rosterList'; document.body.append(dl); }
    dl.innerHTML = (roster?.members ?? []).map(m => `<option value="${esc(m)}">`).join('');
    this.#eliminate();
    this.render();
  }

  // 명단을 불러왔으면 닉네임은 명단 안에서만 나온다. 명단에 없는 닉네임 행을 소거법으로 추정(guess)한다.
  // 거리가 가까우면 파란 칸(추정), 멀면 명단 닉네임을 넣되 노란 칸(확인 필요)으로 둔다.
  // 매번 처음부터 다시 계산해, 후보가 줄면 틀린 추정도 고쳐진다.
  // 직접 고친 행(manual)과 OCR 원문이 없는 행(불러온 기록)은 건드리지 않는다.
  #eliminate() {
    if (!this.roster?.members?.length) return;
    for (const r of this.rows) {
      if (!r.guess) continue;
      r.name = r.rawName;
      r.guess = false;
      if (!r.low.includes('name')) r.low.push('name');
    }
    const names = new Set(this.roster.members);
    const taken = new Set(this.rows.filter(r => names.has(r.name)).map(r => r.name));
    const open = this.rows.filter(r => !names.has(r.name) && !r.manual && !r.eval && r.rawName != null);
    for (const [i, { m, sure }] of assignByElimination(open.map(r => r.rawCands ?? [r.rawName].filter(Boolean)), taken)) {
      const r = open[i];
      r.name = m;
      r.guess = true;
      r.review = true;
      if (sure) r.low = r.low.filter(f => f !== 'name');
    }
  }

  setShowOrig(v) { this.showOrig = v; this.render(); }

  // 명단을 새로 불러왔을 때, 명단에 없는 닉네임 행을 OCR 원문으로 다시 대조
  rematch(match) {
    const names = new Set(this.roster?.members ?? []);
    for (const r of this.rows) {
      if (names.has(r.name) || !r.rawName) continue;
      const m = match(r.rawName);
      if (m) { r.name = m; r.low = r.low.filter(f => f !== 'name'); }
    }
    this.#eliminate();
    this.render();
  }

  setCompare(snapshot) {
    this.compare = snapshot ? new Map(snapshot.rows.map(r => [r.name, r])) : null;
    this.render();
  }

  visibleRows() {
    const maxMission = Math.max(0, ...this.rows.map(r => r.mission ?? 0));
    const f = {
      all: () => true,
      suro0: r => !r.suro,
      flag0: r => !r.flag,
      mission: r => (r.mission ?? 0) < maxMission,
      low: r => r.low.length > 0,
      guess: r => r.guess,
      review: r => r.review,
      unrated: r => r.review && !r.eval,
      bad: r => r.eval === 'bad',
    }[this.filter];
    const k = this.sortKey, dir = this.sortAsc ? 1 : -1;
    return this.rows.filter(f).sort((a, b) => {
      const x = a[k] ?? '', y = b[k] ?? '';
      return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'ko')) * dir;
    });
  }

  render() {
    const cmp = this.compare;
    const debug = ['low', 'guess', 'review', 'unrated', 'bad'].includes(this.filter);
    const head = ['#', ...COLS.map(c => c.label), ...(cmp ? ['비교 수로', '수로 증감', '비교 플래그'] : []), ''];
    const keys = [null, ...COLS.map(c => c.key)];
    this.table.tHead.innerHTML = '<tr>' + head.map((h, i) => {
      const k = keys[i];
      const cls = k && k === this.sortKey ? `sorted${this.sortAsc ? ' asc' : ''}` : '';
      return `<th data-key="${k ?? ''}" class="${cls}">${h}</th>`;
    }).join('') + '</tr>';

    this.table.tBodies[0].innerHTML = this.visibleRows().map((r, i) => {
      const tds = COLS.map(c => {
        if (c.key === 'online') return `<td><span class="dot${r.online ? ' on' : ''}"></span></td>`;
        const cls = [c.num && 'num', r.low.includes(c.key) && 'low', c.num && c.key !== 'level' && r[c.key] === 0 && 'zero',
          c.key === 'name' && r.guess && !r.low.includes('name') && 'guess']
          .filter(Boolean).join(' ');
        const val = c.num ? fmt(r[c.key]) : esc(r[c.key]);
        return `<td class="${cls}" data-id="${r.id}" data-key="${c.key}" contenteditable="plaintext-only">${val}</td>`;
      });
      let extra = '';
      if (cmp) {
        const p = cmp.get(r.name);
        const d = p && r.suro != null && p.suro != null ? r.suro - p.suro : null;
        extra = `<td class="num">${p ? fmt(p.suro) : '-'}</td>`
          + `<td class="num ${d > 0 ? 'delta-up' : d < 0 ? 'delta-down' : ''}">${d == null ? '-' : (d > 0 ? '+' : '') + fmt(d)}</td>`
          + `<td class="num">${p ? fmt(p.flag) : '-'}</td>`;
      }
      const row = `<tr><td class="num">${i + 1}</td>${tds.join('')}${extra}<td><button class="del" data-id="${r.id}" title="행 삭제">×</button></td></tr>`;
      // 결과 바로 아래 줄: 검토 보기면 평가 버튼·명단 선택·OCR 후보, 그 아래 원본 캡처 한 줄
      // 검토 보기: 평가 버튼·명단 선택·OCR 후보 줄
      const review = debug && r.debug
        ? `<tr class="reviewRow"><td></td><td colspan="${head.length - 1}"><div class="reviewBar">${this.#evalButtons(r)}${this.#picker(r)}`
          + `<span>닉네임 후보: ${esc(r.debug.nameCands.join(' / '))} · 직업: ${esc(r.debug.jobRaw)} · 직위: ${esc(r.debug.rankRaw)}</span></div></td></tr>`
        : '';
      return row + review + ((this.showOrig || debug) ? this.#origRow(r, head.length) : '');
    }).join('');
    this.#renderSummary();
  }

  // 원본 캡처를 결과 칸 바로 아래에 칸별로, 확대·축소 없이(늘리면 픽셀 글자가 깨짐)
  #origRow(r, span) {
    const d = r.debug;
    if (!d) return '';
    if (!d.colImgs) {
      // 칸별 이미지가 없는 예전 결과는 한 줄 그대로
      return d.rowImg ? `<tr class="origRow"><td></td><td colspan="${span - 1}"><img src="${d.rowImg}" alt="원본 행"></td></tr>` : '';
    }
    const img = i => `<td><img src="${d.colImgs[i]}" alt=""></td>`;
    // 표 열 순서: #, 접속, 닉네임, 직업, 레벨, 직위, 주간미션, 지하수로, 플래그, (비교 열), 삭제
    const cells = ['<td></td>', '<td></td>', ...[0, 1, 2, 3, 4, 5, 6].map(img)];
    while (cells.length < span) cells.push('<td></td>');
    return `<tr class="origRow">${cells.join('')}</tr>`;
  }

  #renderSummary() {
    const rs = this.rows;
    const chips = [
      ['all', '전체', rs.length],
      ['review', '검토', rs.filter(r => r.review).length],
      ['unrated', '미평가', rs.filter(r => r.review && !r.eval).length],
      ['bad', '틀림', rs.filter(r => r.eval === 'bad').length],
    ];
    this.chipsEl.innerHTML = chips.map(([k, label, n]) =>
      `<button data-filter="${k}" class="${this.filter === k ? 'on' : ''}">${label}<b>${n}</b></button>`).join('');
    const suro = rs.filter(r => r.suro > 0), flag = rs.filter(r => r.flag > 0);
    const total = suro.reduce((a, r) => a + r.suro, 0);
    const low = rs.filter(r => r.low.length).length;
    const guess = rs.filter(r => r.guess).length;
    this.summaryEl.innerHTML = `<b>${rs.length}</b>명 · 수로 참여 <b>${suro.length}</b>명 (합계 ${fmt(total)})`
      + ` · 플래그 참여 <b>${flag.length}</b>명` + (low ? ` · 확인 필요 <b>${low}</b>명` : '') + (guess ? ` · 소거법 추정 <b>${guess}</b>명` : '');
    if (this.roster?.members?.length) {
      // 명단은 부캐 포함 캐릭터 목록(계정당 최대 6캐릭)이라 미캡처 수는 의미가 없다
      const names = new Set(this.roster.members);
      const matched = rs.filter(r => names.has(r.name)).length;
      this.summaryEl.innerHTML += `<br>명단 ${this.roster.members.length}캐릭터(부캐 포함) · 결과 ${rs.length}명 중 <b>${matched}</b>명 명단 일치`;
    }
  }

  #onSort(e) {
    const k = e.target.closest('th')?.dataset.key;
    if (!k) return;
    if (this.sortKey === k) this.sortAsc = !this.sortAsc;
    else { this.sortKey = k; this.sortAsc = !COLS.find(c => c.key === k)?.num; }
    this.render();
  }

  #evalButtons(r) {
    const on = v => (r.eval === v ? ' on' : '');
    return `<div class="evals"><button class="ev ok${on('ok')}" data-id="${r.id}" data-ev="ok">맞음</button>`
      + `<button class="ev bad${on('bad')}" data-id="${r.id}" data-ev="bad">틀림</button></div>`;
  }

  // 처음 자동으로 나온 값을 보관(평가·내보내기 비교용)
  #keepAuto(r) {
    r.auto ??= Object.fromEntries(FIELDS.map(f => [f, r[f]]));
  }

  // 사용자가 값을 고친 뒤: 자동값과 다르면 틀림
  #markChanged(r) {
    if (!r.auto) return;
    if (FIELDS.some(f => r[f] !== r.auto[f])) r.eval = 'bad';
  }

  #onEval(btn) {
    const r = this.rows.find(x => x.id === btn.dataset.id);
    if (!r) return;
    this.#keepAuto(r);
    r.eval = btn.dataset.ev;
    r.manual = true;
    r.guess = false;
    if (r.eval === 'ok') { r.low = []; learnName(r.nameHash, r.name); }
    this.#eliminate();
    this.render();
    if (r.eval === 'bad') this.table.querySelector(`input.pickInput[data-id="${r.id}"]`)?.focus();
  }

  // 명단에서 닉네임 직접 선택(가까운 후보 순). 다른 행이 쓰는 닉네임은 제외.
  // 명단에서 닉네임 고르기: 가까운 후보 3개 버튼 + 검색 입력(명단 1000명 이상이라 목록 대신 검색).
  #picker(r) {
    if (!this.roster?.members?.length) return '';
    const taken = new Set(this.rows.filter(x => x !== r).map(x => x.name));
    const top = candidatesFor(r.rawName, taken).filter(c => c.m !== r.name).slice(0, 3)
      .map(({ m }) => `<button class="cand" data-id="${r.id}" data-name="${esc(m)}">${esc(m)}</button>`).join('');
    return `${top}<input class="pickInput" list="rosterList" data-id="${r.id}" placeholder="닉네임 검색" size="12">`;
  }

  #pick(e) {
    const el = e.target.closest('input.pickInput');
    const r = el && this.rows.find(x => x.id === el.dataset.id);
    if (!r || !this.roster?.members?.includes(el.value)) return;
    this.#applyName(r, el.value);
  }

  #applyName(r, name) {
    this.#keepAuto(r);
    r.name = name;
    r.manual = true;
    r.guess = false;
    r.low = r.low.filter(f => f !== 'name');
    learnName(r.nameHash, r.name);
    this.#markChanged(r);
    if (r.eval !== 'bad') r.eval = 'ok';
    this.#eliminate();
    this.render();
  }

  #onEdit(e) {
    const td = e.target;
    if (!td.matches?.('td[contenteditable]')) return;
    const r = this.rows.find(x => x.id === td.dataset.id);
    if (!r) return;
    const k = td.dataset.key, col = COLS.find(c => c.key === k);
    const text = td.textContent.trim();
    const v = col.num ? (text.replace(/\D/g, '') ? parseInt(text.replace(/\D/g, ''), 10) : null) : text;
    if (v === r[k]) return;
    if (r.review) this.#keepAuto(r);
    r[k] = v;
    r.low = r.low.filter(f => f !== k);
    if (k === 'name') {
      r.name = cleanName(v);
      r.manual = true;
      r.guess = false;
      learnName(r.nameHash, r.name);
      this.#eliminate();
    }
    if (k === 'job') addCustomJob(v);
    this.#markChanged(r);
    this.render();
  }

  // 확인 필요 행의 OCR 원자료(후보·원본 이미지) — 인식 개선 분석용
  lowRows() {
    return this.rows.filter(r => r.low.length || r.guess).map(r => ({
      name: r.name, rawName: r.rawName, job: r.job, rank: r.rank,
      level: r.level, mission: r.mission, suro: r.suro, flag: r.flag,
      low: r.low, guess: !!r.guess, ...r.debug,
    }));
  }

  // "틀림"으로 평가한 행만: 자동값(auto)과 정답(truth), 틀린 필드, OCR 원자료
  evalRows() {
    return this.rows.filter(r => r.eval === 'bad').map(r => {
      const truth = Object.fromEntries(FIELDS.map(f => [f, r[f]]));
      const auto = r.auto ?? truth;
      return {
        truth, auto, wrong: FIELDS.filter(f => truth[f] !== auto[f]),
        truthKnown: FIELDS.some(f => truth[f] !== auto[f]), // false: 틀림만 누르고 정답을 안 고친 행
        rawName: r.rawName, guess: !!r.guess, low: r.low, ...r.debug,
      };
    });
  }

  unratedCount() {
    return this.rows.filter(r => r.review && !r.eval).length;
  }

  downloadLowJson() {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(this.evalRows(), null, 1)], { type: 'application/json' }));
    a.download = `오인식_${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  toMatrix() {
    const rows = this.visibleRows();
    return [
      ['닉네임', '직업', '레벨', '직위', '주간미션', '지하수로', '플래그', '접속'],
      ...rows.map(r => [...FIELDS.map(f => r[f] ?? ''), r.online ? 'O' : '']),
    ];
  }

  downloadCsv() {
    const csv = this.toMatrix().map(row => row.map(v => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    }).join(',')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
    a.download = `길드참여현황_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async copyTsv() {
    await navigator.clipboard.writeText(this.toMatrix().map(r => r.join('\t')).join('\n'));
  }

  // 저장 = 사용자가 결과를 확인했다는 뜻이므로 닉네임도 학습시킨다.
  saveSnapshot(label) {
    for (const r of this.rows) learnName(r.nameHash, r.name);
    const list = loadSnapshots();
    const snap = {
      id: String(Date.now()),
      label,
      rows: this.rows.map(r => Object.fromEntries([...FIELDS, 'online'].map(f => [f, r[f]]))),
    };
    list.unshift(snap);
    saveSnapshots(list.slice(0, 30));
    return snap;
  }

  loadSnapshot(snap) {
    this.rows = snap.rows.map(r => ({ ...r, low: [], img: null, id: crypto.randomUUID() }));
    this.render();
  }

  static deleteSnapshot(id) {
    saveSnapshots(loadSnapshots().filter(s => s.id !== id));
  }
}
