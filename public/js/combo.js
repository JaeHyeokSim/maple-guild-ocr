// 입력 즉시 필터되는 자동완성 목록. 네이티브 datalist는 한글 조합 중(엔터 전)에는 필터하지 않고 초성 검색도 못 해서 대체한다.
// 초성(ㅅㅋ → 스카니아)과 조합 중인 마지막 글자(벨 → 베라)도 일치로 본다.
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const JONG = ['', 'ㄱ', 'ㄲ', 'ㄱㅅ', 'ㄴ', 'ㄴㅈ', 'ㄴㅎ', 'ㄷ', 'ㄹ', 'ㄹㄱ', 'ㄹㅁ', 'ㄹㅂ', 'ㄹㅅ', 'ㄹㅌ', 'ㄹㅍ', 'ㄹㅎ',
  'ㅁ', 'ㅂ', 'ㅂㅅ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];

const syl = ch => { const c = ch.charCodeAt(0) - 0xac00; return c >= 0 && c <= 11171 ? c : -1; };
const cho = ch => { const c = syl(ch); return c < 0 ? ch : CHO[Math.floor(c / 588)]; };
// 호환 자모로 분해(종성 겹받침도 풀어서 다음 글자 초성과 이어 비교할 수 있게)
const split = s => [...s].map(ch => {
  const c = syl(ch);
  return c < 0 ? ch.toLowerCase() : CHO[Math.floor(c / 588)] + JUNG[Math.floor((c % 588) / 28)] + JONG[c % 28];
}).join('');
const isCho = ch => CHO.includes(ch);

export function matches(word, query) {
  const q = [...query.trim()], w = [...word];
  if (!q.length) return true;
  for (let i = 0; i + q.length <= w.length; i++) {
    const ok = q.every((qc, k) => {
      if (isCho(qc)) return cho(w[i + k]) === qc;
      if (k === q.length - 1) return split(w.slice(i + k).join('')).startsWith(split(qc));
      return w[i + k].toLowerCase() === qc.toLowerCase();
    });
    if (ok) return true;
  }
  return false;
}

export function attachCombo(input, items) {
  const wrap = document.createElement('span');
  wrap.className = 'combo';
  input.replaceWith(wrap);
  wrap.append(input);
  const list = document.createElement('ul');
  list.className = 'comboList';
  list.hidden = true;
  wrap.append(list);
  input.setAttribute('autocomplete', 'off');

  let shown = [], active = -1;
  const render = () => {
    shown = items.filter(it => matches(it, input.value));
    if (shown.includes(input.value.trim()) && shown.length === 1) shown = [];
    list.replaceChildren(...shown.map((it, i) => {
      const li = document.createElement('li');
      li.textContent = it;
      li.classList.toggle('on', i === active);
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(it); });
      return li;
    }));
    list.hidden = !shown.length;
  };
  const open = () => { active = -1; render(); };
  const close = () => { list.hidden = true; active = -1; };
  const pick = it => { input.value = it; close(); input.dispatchEvent(new Event('change', { bubbles: true })); };

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', e => {
    if (e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (list.hidden) return open();
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      render();
      list.children[active]?.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && !list.hidden && active >= 0) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') close();
  });
}
