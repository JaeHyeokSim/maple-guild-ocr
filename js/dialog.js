// 브라우저 기본 alert/confirm/prompt 대신 쓰는 사이트 테마 대화상자(<dialog>).
// 모두 Promise를 돌려준다: uiAlert → undefined, uiConfirm → true/false, uiPrompt → 입력값 또는 null.
// 메시지의 줄바꿈(\n)은 그대로 표시된다. Esc·바깥 클릭은 취소로 처리한다.

let dlg = null;

function build() {
  dlg = document.createElement('dialog');
  dlg.className = 'uiDialog';
  dlg.innerHTML = `
    <form method="dialog">
      <h3 class="uiTitle"></h3>
      <p class="uiMsg"></p>
      <input class="uiInput" autocomplete="off">
      <div class="uiBtns">
        <button value="cancel" class="uiCancel" type="submit">취소</button>
        <button value="ok" class="uiOk primary" type="submit">확인</button>
      </div>
    </form>`;
  // 바깥(backdrop) 클릭은 취소
  dlg.addEventListener('click', e => { if (e.target === dlg) dlg.close('cancel'); });
  document.body.append(dlg);
}

function open({ title = '', message = '', ok = '확인', cancel = null, input = null, danger = false }) {
  if (!dlg) build();
  if (dlg.open) dlg.close('cancel');
  const $ = s => dlg.querySelector(s);
  $('.uiTitle').textContent = title;
  $('.uiTitle').hidden = !title;
  $('.uiMsg').textContent = message;
  const okBtn = $('.uiOk'), cancelBtn = $('.uiCancel'), field = $('.uiInput');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  cancelBtn.hidden = cancel == null;
  if (cancel != null) cancelBtn.textContent = cancel;
  field.hidden = input == null;
  field.value = input ?? '';
  dlg.returnValue = '';
  return new Promise(resolve => {
    dlg.addEventListener('close', () => resolve({ ok: dlg.returnValue === 'ok', value: field.value }), { once: true });
    dlg.showModal();
    (input != null ? field : okBtn).focus();
    if (input != null) field.select();
  });
}

export async function uiAlert(message, title = '알림') {
  await open({ title, message });
}

export async function uiConfirm(message, { title = '확인', ok = '확인', cancel = '취소', danger = false } = {}) {
  return (await open({ title, message, ok, cancel, danger })).ok;
}

export async function uiPrompt(message, value = '', { title = '입력', ok = '확인', cancel = '취소' } = {}) {
  const r = await open({ title, message, ok, cancel, input: value });
  return r.ok ? r.value : null;
}
