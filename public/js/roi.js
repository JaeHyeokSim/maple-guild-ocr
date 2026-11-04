// 표 영역(ROI) 드래그 지정과 열 경계 조정 UI.
const KEY = 'mgo.layout';
// 첨부 스크린샷 기준 기본 열 경계(ROI 폭 대비 비율)
export const DEFAULT_DIVIDERS = [0.198, 0.395, 0.470, 0.623, 0.708, 0.865];
const ZOOM = 2;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)); } catch { return null; }
}

function pos(cv, e) {
  const r = cv.getBoundingClientRect();
  return { x: (e.clientX - r.left) * cv.width / r.width, y: (e.clientY - r.top) * cv.height / r.height };
}

export class RoiEditor {
  constructor(overview, zoom, onRoiChange) {
    this.ov = overview;
    this.zv = zoom;
    this.onRoiChange = onRoiChange;
    this.frame = null;
    this.rows = [];
    this.drag = null;
    const saved = load();
    this.roi = saved?.roi ?? null;
    this.auto = saved?.auto ?? false; // 자동 감지한 영역이면 창이 움직일 때 다시 찾는다
    this.dividers = saved?.dividers ?? [...DEFAULT_DIVIDERS];
    this.#bindOverview();
    this.#bindZoom();
  }

  save() {
    try { localStorage.setItem(KEY, JSON.stringify({ roi: this.roi, auto: this.auto, dividers: this.dividers })); } catch {}
  }

  setRoi(roi, auto) {
    this.roi = roi;
    this.auto = auto;
    this.rows = [];
    this.save();
    this.draw();
  }

  setFrame(frame) {
    this.frame = frame;
    const r = this.roi;
    if (r && (r.x + r.w > frame.width || r.y + r.h > frame.height)) this.roi = null;
    this.draw();
  }

  setRows(rows) {
    this.rows = rows;
    this.drawZoom();
  }

  setDividers(d) {
    this.dividers = d;
    this.save();
    this.drawZoom();
  }

  draw() {
    this.drawOverview();
    this.drawZoom();
  }

  drawOverview() {
    const { ov, frame } = this;
    if (!frame) return;
    ov.hidden = false;
    if (ov.width !== frame.width || ov.height !== frame.height) {
      ov.width = frame.width;
      ov.height = frame.height;
    }
    const ctx = ov.getContext('2d');
    ctx.drawImage(frame, 0, 0);
    const r = this.drag?.rect ?? this.roi;
    if (r) {
      ctx.strokeStyle = '#2bb3d6';
      ctx.lineWidth = Math.max(2, frame.width / 500);
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    }
  }

  drawZoom() {
    const { zv, frame, roi } = this;
    if (!frame || !roi) { zv.hidden = true; return; }
    zv.hidden = false;
    zv.width = roi.w * ZOOM;
    zv.height = roi.h * ZOOM;
    const ctx = zv.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(frame, roi.x, roi.y, roi.w, roi.h, 0, 0, zv.width, zv.height);
    ctx.fillStyle = 'rgba(43,179,214,.15)';
    for (const [y0, y1] of this.rows) ctx.fillRect(0, (y0 - roi.y - 2) * ZOOM, zv.width, (y1 - y0 + 5) * ZOOM);
    ctx.strokeStyle = '#ff9f1c';
    ctx.lineWidth = 2;
    for (const f of this.dividers) {
      const x = Math.round(f * zv.width) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, zv.height);
      ctx.stroke();
    }
  }

  #bindOverview() {
    const cv = this.ov;
    cv.addEventListener('pointerdown', e => {
      if (!this.frame) return;
      cv.setPointerCapture(e.pointerId);
      const p = pos(cv, e);
      this.drag = { start: p, rect: null };
    });
    cv.addEventListener('pointermove', e => {
      if (!this.drag) return;
      const p = pos(cv, e), s = this.drag.start;
      this.drag.rect = {
        x: Math.round(Math.max(0, Math.min(s.x, p.x))),
        y: Math.round(Math.max(0, Math.min(s.y, p.y))),
        w: Math.round(Math.abs(p.x - s.x)),
        h: Math.round(Math.abs(p.y - s.y)),
      };
      this.drawOverview();
    });
    cv.addEventListener('pointerup', () => {
      const r = this.drag?.rect;
      this.drag = null;
      if (r && r.w > 20 && r.h > 10) {
        r.w = Math.min(r.w, this.frame.width - r.x);
        r.h = Math.min(r.h, this.frame.height - r.y);
        this.roi = r;
        this.auto = false;
        this.rows = [];
        this.save();
        this.onRoiChange();
      }
      this.draw();
    });
  }

  #bindZoom() {
    const cv = this.zv;
    const hit = e => {
      const p = pos(cv, e);
      const tol = 6 * cv.width / cv.getBoundingClientRect().width;
      return this.dividers.findIndex(f => Math.abs(f * cv.width - p.x) <= tol);
    };
    let idx = -1;
    cv.addEventListener('pointerdown', e => {
      idx = hit(e);
      if (idx >= 0) cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', e => {
      if (idx < 0) {
        cv.style.cursor = hit(e) >= 0 ? 'ew-resize' : 'default';
        return;
      }
      const f = pos(cv, e).x / cv.width;
      const lo = (this.dividers[idx - 1] ?? 0) + 0.01, hi = (this.dividers[idx + 1] ?? 1) - 0.01;
      this.dividers[idx] = Math.min(hi, Math.max(lo, f));
      this.drawZoom();
    });
    cv.addEventListener('pointerup', () => {
      if (idx >= 0) this.save();
      idx = -1;
    });
  }
}
