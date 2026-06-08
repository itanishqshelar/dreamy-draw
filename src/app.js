const $ = (sel) => document.querySelector(sel);

const canvas = $("#board");
const ctx = canvas.getContext("2d");
const textEditor = $("#textEditor");
const emptyHint = $("#emptyHint");
const propsPanel = $("#propsPanel");
const sessionList = $("#sessionList");
const titleInput = $("#titleInput");
const drawer = $("#drawer");
const drawerOverlay = $("#drawerOverlay");
const toastEl = $("#toast");

/* ---------- Palettes ---------- */
const STROKE_COLORS = ["#1e1e1e", "#e03131", "#2f9e44", "#1971c2", "#f08c00"];
const FILL_COLORS = ["transparent", "#ffc9c9", "#b2f2bb", "#a5d8ff", "#ffec99"];

/* ---------- State ---------- */
const state = {
  sessions: [],
  activeId: null,
  title: "Untitled drawing",
  tool: "select",
  elements: [],
  selectedIds: [],

  // viewport
  scrollX: 0,
  scrollY: 0,
  zoom: 1,
  dpr: 1,

  // defaults for new elements
  defaults: {
    strokeColor: "#1e1e1e",
    fillColor: "transparent",
    fillStyle: "hachure",
    strokeWidth: 2,
    strokeStyle: "solid",
    edges: "round",
    fontSize: 24,
    fontFamily: "Caveat",
    textAlign: "left",
    opacity: 1,
  },

  // interaction
  action: "none", // none | drawing | moving | resizing | marquee | panning | erasing
  draft: null,
  resize: null,
  marquee: null,
  startPoint: null,
  lastPoint: null,

  history: [],
  future: [],
  saveTimer: null,
  clipboard: null,
};

const makeId = () =>
  crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
const now = () => Date.now();
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/* ============================================================
   Coordinate transforms
   ============================================================ */
function screenToWorld(sx, sy) {
  return { x: (sx - state.scrollX) / state.zoom, y: (sy - state.scrollY) / state.zoom };
}
function pointerWorld(event) {
  const rect = canvas.getBoundingClientRect();
  return screenToWorld(event.clientX - rect.left, event.clientY - rect.top);
}
function pointerScreen(event) {
  const rect = canvas.getBoundingClientRect();
  return { x: event.clientX - rect.left, y: event.clientY - rect.top };
}

function resizeCanvas() {
  state.dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(window.innerWidth * state.dpr));
  canvas.height = Math.max(1, Math.floor(window.innerHeight * state.dpr));
  render();
}

/* ============================================================
   Geometry
   ============================================================ */
function normalizeRect(el) {
  return {
    x: Math.min(el.x, el.x + el.w),
    y: Math.min(el.y, el.y + el.h),
    w: Math.abs(el.w),
    h: Math.abs(el.h),
  };
}

function measureText(el) {
  ctx.save();
  ctx.font = `${el.fontSize}px "${el.fontFamily || "Caveat"}", system-ui, sans-serif`;
  const lines = (el.text || "").split("\n");
  let width = 0;
  for (const line of lines) width = Math.max(width, ctx.measureText(line || " ").width);
  ctx.restore();
  return { w: width, h: lines.length * el.fontSize * 1.25 };
}

function elementBounds(el) {
  if (el.type === "draw") {
    const xs = el.points.map((p) => p.x);
    const ys = el.points.map((p) => p.y);
    return {
      x: Math.min(...xs),
      y: Math.min(...ys),
      w: Math.max(...xs) - Math.min(...xs),
      h: Math.max(...ys) - Math.min(...ys),
    };
  }
  if (el.type === "text") {
    const m = measureText(el);
    const align = el.textAlign || "left";
    const bx = align === "center" ? el.x - m.w / 2 : align === "right" ? el.x - m.w : el.x;
    return { x: bx, y: el.y, w: m.w, h: m.h };
  }
  return normalizeRect(el);
}

function getSelectionBounds(ids = state.selectedIds) {
  const els = state.elements.filter((e) => ids.includes(e.id));
  if (!els.length) return null;
  const b = els.map(elementBounds);
  const x = Math.min(...b.map((r) => r.x));
  const y = Math.min(...b.map((r) => r.y));
  const x2 = Math.max(...b.map((r) => r.x + r.w));
  const y2 = Math.max(...b.map((r) => r.y + r.h));
  return { x, y, w: x2 - x, h: y2 - y };
}

function allBounds() {
  if (!state.elements.length) return null;
  return getSelectionBounds(state.elements.map((e) => e.id));
}

function hitTest(point, el) {
  const pad = Math.max(8, (el.strokeWidth || 2) + 4) / state.zoom;
  if (el.type === "line" || el.type === "arrow") {
    return distToSegment(point, { x: el.x, y: el.y }, { x: el.x + el.w, y: el.y + el.h }) <= pad;
  }
  if (el.type === "draw") {
    for (let i = 1; i < el.points.length; i++) {
      if (distToSegment(point, el.points[i - 1], el.points[i]) <= pad) return true;
    }
    return false;
  }
  if (el.type === "ellipse") {
    const r = normalizeRect(el);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    const rx = r.w / 2 + pad;
    const ry = r.h / 2 + pad;
    if (rx <= 0 || ry <= 0) return false;
    const inOuter = ((point.x - cx) ** 2) / (rx * rx) + ((point.y - cy) ** 2) / (ry * ry) <= 1;
    if (el.fillColor !== "transparent") return inOuter;
    // hollow: ring test
    const innerRx = r.w / 2 - pad;
    const innerRy = r.h / 2 - pad;
    const inInner =
      innerRx > 0 && innerRy > 0
        ? ((point.x - cx) ** 2) / (innerRx * innerRx) + ((point.y - cy) ** 2) / (innerRy * innerRy) <= 1
        : false;
    return inOuter && !inInner;
  }
  const b = elementBounds(el);
  const inside =
    point.x >= b.x - pad && point.x <= b.x + b.w + pad && point.y >= b.y - pad && point.y <= b.y + b.h + pad;
  if (el.type === "rect" || el.type === "diamond") {
    if (el.fillColor !== "transparent" || el.type === "text") return inside;
    // hollow shapes: only border
    const innerHit =
      point.x >= b.x + pad && point.x <= b.x + b.w - pad && point.y >= b.y + pad && point.y <= b.y + b.h - pad;
    return inside && !innerHit;
  }
  return inside;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = clamp(t, 0, 1);
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/* Resize handles in WORLD coords for a given bounds */
const HANDLE = 9; // screen px
function handlePositions(b) {
  return {
    nw: { x: b.x, y: b.y },
    n: { x: b.x + b.w / 2, y: b.y },
    ne: { x: b.x + b.w, y: b.y },
    e: { x: b.x + b.w, y: b.y + b.h / 2 },
    se: { x: b.x + b.w, y: b.y + b.h },
    s: { x: b.x + b.w / 2, y: b.y + b.h },
    sw: { x: b.x, y: b.y + b.h },
    w: { x: b.x, y: b.y + b.h / 2 },
  };
}

function handleAt(point) {
  const b = getSelectionBounds();
  if (!b) return null;
  const tol = (HANDLE + 4) / state.zoom;
  const handles = handlePositions(b);
  for (const [name, pos] of Object.entries(handles)) {
    if (Math.abs(point.x - pos.x) <= tol && Math.abs(point.y - pos.y) <= tol) return name;
  }
  return null;
}

/* ============================================================
   History
   ============================================================ */
function snapshot() {
  return JSON.stringify(state.elements);
}
function pushHistory() {
  state.history.push(snapshot());
  if (state.history.length > 100) state.history.shift();
  state.future = [];
}
function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  state.elements = JSON.parse(state.history.pop());
  state.selectedIds = state.selectedIds.filter((id) => state.elements.some((e) => e.id === id));
  render();
  scheduleSave();
}
function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  state.elements = JSON.parse(state.future.pop());
  render();
  scheduleSave();
}

/* ============================================================
   Persistence
   ============================================================ */
function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(saveActiveSession, 500);
}

async function saveActiveSession() {
  if (!state.activeId) return;
  const existing = state.sessions.find((s) => s.id === state.activeId);
  const session = {
    id: state.activeId,
    title: state.title.trim() || "Untitled drawing",
    createdAt: existing?.createdAt || now(),
    updatedAt: now(),
    elements: state.elements,
    thumbnail: makeThumbnail(),
  };
  await DreamyDB.saveSession(session);
  await refreshSessions(false);
}

function makeThumbnail() {
  const W = 112;
  const H = 84;
  const thumb = document.createElement("canvas");
  thumb.width = W;
  thumb.height = H;
  const tctx = thumb.getContext("2d");
  tctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "#fff";
  tctx.fillRect(0, 0, W, H);
  const b = allBounds();
  if (b && (b.w || b.h)) {
    const pad = 8;
    const scale = Math.min((W - pad * 2) / Math.max(b.w, 1), (H - pad * 2) / Math.max(b.h, 1), 2);
    tctx.translate(pad - b.x * scale + (W - pad * 2 - b.w * scale) / 2, pad - b.y * scale + (H - pad * 2 - b.h * scale) / 2);
    tctx.scale(scale, scale);
    drawElements(tctx, state.elements);
  }
  return thumb.toDataURL("image/png");
}

/* ============================================================
   Rendering
   ============================================================ */
function resolveColor(color) {
  if (!color || color === "transparent" || !color.startsWith("#")) return color;
  const r = parseInt(color.slice(1, 3), 16) / 255;
  const g = parseInt(color.slice(3, 5), 16) / 255;
  const b = parseInt(color.slice(5, 7), 16) / 255;
  const lin = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  const dark = document.documentElement.dataset.theme === "dark";
  if (dark && lum < 0.05) return "#e3e3e8";
  if (!dark && lum > 0.75) return "#1e1e1e";
  return color;
}

function applyStrokeStyle(c, el) {
  if (el.strokeStyle === "dashed") c.setLineDash([el.strokeWidth * 3, el.strokeWidth * 2.5]);
  else if (el.strokeStyle === "dotted") c.setLineDash([0.1, el.strokeWidth * 2.5]);
  else c.setLineDash([]);
}

function hachureFill(c, el, gap, cross) {
  const b = elementBounds(el);
  c.save();
  c.strokeStyle = el.fillColor;
  c.lineWidth = Math.max(0.8, el.strokeWidth * 0.6);
  c.setLineDash([]);
  c.lineCap = "round";
  const draw = (slope) => {
    c.beginPath();
    if (slope > 0) {
      for (let i = -b.h; i < b.w; i += gap) {
        c.moveTo(b.x + i, b.y);
        c.lineTo(b.x + i + b.h, b.y + b.h);
      }
    } else {
      for (let i = 0; i < b.w + b.h; i += gap) {
        c.moveTo(b.x + i, b.y);
        c.lineTo(b.x + i - b.h, b.y + b.h);
      }
    }
    c.stroke();
  };
  draw(1);
  if (cross) draw(-1);
  c.restore();
}

function buildPath(c, el) {
  if (el.type === "rect") {
    const r = normalizeRect(el);
    const radius = el.edges === "round" ? Math.min(16, r.w / 2, r.h / 2) : 0;
    c.beginPath();
    c.roundRect(r.x, r.y, r.w, r.h, radius);
  } else if (el.type === "diamond") {
    const r = normalizeRect(el);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2;
    c.beginPath();
    c.moveTo(cx, r.y);
    c.lineTo(r.x + r.w, cy);
    c.lineTo(cx, r.y + r.h);
    c.lineTo(r.x, cy);
    c.closePath();
  } else if (el.type === "ellipse") {
    const r = normalizeRect(el);
    c.beginPath();
    c.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2);
  }
}

function drawElement(c, el) {
  c.save();
  c.globalAlpha = el.opacity ?? 1;
  c.lineWidth = el.strokeWidth;
  const resolvedStroke = resolveColor(el.strokeColor);
  c.strokeStyle = resolvedStroke;
  c.lineCap = "round";
  c.lineJoin = "round";

  if (el.type === "draw") {
    applyStrokeStyle(c, el);
    c.beginPath();
    el.points.forEach((p, i) => (i === 0 ? c.moveTo(p.x, p.y) : c.lineTo(p.x, p.y)));
    c.stroke();
  } else if (el.type === "rect" || el.type === "diamond" || el.type === "ellipse") {
    const fillable = el.fillColor && el.fillColor !== "transparent";
    if (fillable) {
      if (el.fillStyle === "solid") {
        buildPath(c, el);
        c.fillStyle = el.fillColor;
        c.fill();
      } else {
        buildPath(c, el);
        c.save();
        c.clip();
        hachureFill(c, el, Math.max(5, el.strokeWidth * 2.2), el.fillStyle === "cross");
        c.restore();
      }
    }
    applyStrokeStyle(c, el);
    buildPath(c, el);
    c.stroke();
  } else if (el.type === "line" || el.type === "arrow") {
    applyStrokeStyle(c, el);
    c.beginPath();
    c.moveTo(el.x, el.y);
    c.lineTo(el.x + el.w, el.y + el.h);
    c.stroke();
    if (el.type === "arrow") drawArrowHead(c, el);
  } else if (el.type === "text") {
    c.setLineDash([]);
    c.fillStyle = resolvedStroke;
    c.textBaseline = "top";
    c.textAlign = el.textAlign || "left";
    c.font = `${el.fontSize}px "${el.fontFamily || "Caveat"}", system-ui, sans-serif`;
    (el.text || "").split("\n").forEach((line, i) => {
      c.fillText(line, el.x, el.y + i * el.fontSize * 1.25);
    });
    c.textAlign = "left";
  }
  c.restore();
}

function drawArrowHead(c, el) {
  const ex = el.x + el.w;
  const ey = el.y + el.h;
  const angle = Math.atan2(el.h, el.w);
  const size = 10 + el.strokeWidth * 1.6;
  c.setLineDash([]);
  c.beginPath();
  c.moveTo(ex, ey);
  c.lineTo(ex - size * Math.cos(angle - Math.PI / 7), ey - size * Math.sin(angle - Math.PI / 7));
  c.moveTo(ex, ey);
  c.lineTo(ex - size * Math.cos(angle + Math.PI / 7), ey - size * Math.sin(angle + Math.PI / 7));
  c.stroke();
}

function drawElements(c, elements) {
  for (const el of elements) drawElement(c, el);
}

function drawGrid() {
  // adaptive gap so on-screen spacing stays readable (and bounded) at any zoom
  let gap = 24;
  while (gap * state.zoom < 16) gap *= 2;
  const view = screenToWorld(0, 0);
  const viewEnd = screenToWorld(window.innerWidth, window.innerHeight);
  const startX = Math.floor(view.x / gap) * gap;
  const startY = Math.floor(view.y / gap) * gap;
  ctx.save();
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--grid").trim();
  const dot = Math.max(1, 1.4 / state.zoom);
  for (let x = startX; x < viewEnd.x; x += gap) {
    for (let y = startY; y < viewEnd.y; y += gap) {
      ctx.fillRect(x - dot / 2, y - dot / 2, dot, dot);
    }
  }
  ctx.restore();
}

function drawSelectionUI() {
  if (!state.selectedIds.length || state.action === "drawing") return;
  const b = getSelectionBounds();
  if (!b) return;
  const z = state.zoom;
  ctx.save();
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--selection").trim();
  ctx.lineWidth = 1 / z;
  ctx.setLineDash([4 / z, 3 / z]);
  const m = 4 / z;
  ctx.strokeRect(b.x - m, b.y - m, b.w + 2 * m, b.h + 2 * m);

  // handles (skip for single line/arrow — endpoints feel odd; still allow bbox handles)
  ctx.setLineDash([]);
  const hs = HANDLE / z;
  const fill = getComputedStyle(document.documentElement).getPropertyValue("--island").trim();
  const handles = handlePositions(b);
  for (const pos of Object.values(handles)) {
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.roundRect(pos.x - hs / 2, pos.y - hs / 2, hs, hs, 2 / z);
    ctx.fill();
    ctx.stroke();
  }
  ctx.restore();
}

function render() {
  // clear in device space
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const z = state.dpr * state.zoom;
  ctx.setTransform(z, 0, 0, z, state.scrollX * state.dpr, state.scrollY * state.dpr);

  drawGrid();
  drawElements(ctx, editingTextId ? state.elements.filter((e) => e.id !== editingTextId) : state.elements);
  if (state.draft) drawElement(ctx, state.draft);
  drawSelectionUI();

  // marquee (drawn in screen space)
  if (state.marquee) {
    ctx.setTransform(state.dpr, 0, 0, state.dpr, 0, 0);
    const m = state.marquee;
    ctx.save();
    ctx.fillStyle = "rgba(105,101,219,0.08)";
    ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue("--selection").trim();
    ctx.lineWidth = 1;
    const x = Math.min(m.x0, m.x1);
    const y = Math.min(m.y0, m.y1);
    ctx.fillRect(x, y, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.strokeRect(x, y, Math.abs(m.x1 - m.x0), Math.abs(m.y1 - m.y0));
    ctx.restore();
  }

  emptyHint.classList.toggle("hidden", state.elements.length > 0 || Boolean(state.draft));
  updateZoomLabel();
}

/* ============================================================
   Element creation
   ============================================================ */
function makeElement(type, point) {
  const d = state.defaults;
  const base = {
    id: makeId(),
    type,
    x: point.x,
    y: point.y,
    w: 0,
    h: 0,
    strokeColor: d.strokeColor,
    fillColor: d.fillColor,
    fillStyle: d.fillStyle,
    strokeWidth: d.strokeWidth,
    strokeStyle: d.strokeStyle,
    edges: d.edges,
    opacity: d.opacity,
  };
  if (type === "draw") return { ...base, points: [{ ...point }] };
  return base;
}

function commitDraft() {
  if (!state.draft) return;
  const draft = state.draft;
  const keep =
    draft.type === "draw"
      ? draft.points.length > 1
      : Math.abs(draft.w) > 4 || Math.abs(draft.h) > 4;
  state.draft = null;
  if (keep) {
    pushHistory();
    state.elements.push(draft);
    state.selectedIds = [draft.id];
    scheduleSave();
    // shapes revert to selection; draw/eraser/hand stay sticky
    if (!["draw"].includes(draft.type)) setTool("select");
  }
  render();
  syncPropsFromContext();
}

/* ---------- transforms on elements ---------- */
function moveElement(el, dx, dy) {
  el.x += dx;
  el.y += dy;
  if (el.type === "draw") el.points = el.points.map((p) => ({ x: p.x + dx, y: p.y + dy }));
}

function scaleElementFrom(orig, live, fx, fy, sx, sy) {
  // write scaled geometry from `orig` snapshot into `live` element
  if (orig.type === "draw") {
    live.points = orig.points.map((p) => ({ x: fx + (p.x - fx) * sx, y: fy + (p.y - fy) * sy }));
    live.x = fx + (orig.x - fx) * sx;
    live.y = fy + (orig.y - fy) * sy;
  } else if (orig.type === "text") {
    live.x = fx + (orig.x - fx) * sx;
    live.y = fy + (orig.y - fy) * sy;
    live.fontSize = Math.max(6, orig.fontSize * sy);
  } else {
    live.x = fx + (orig.x - fx) * sx;
    live.y = fy + (orig.y - fy) * sy;
    live.w = orig.w * sx;
    live.h = orig.h * sy;
  }
}

/* ============================================================
   Text tool
   ============================================================ */
let editingTextId = null;

function openTextEditor(worldPoint, existing) {
  const d = state.defaults;
  const fontSize = existing ? existing.fontSize : d.fontSize;
  const fontFamily = existing ? (existing.fontFamily || "Caveat") : d.fontFamily;
  const textAlign = existing ? (existing.textAlign || "left") : d.textAlign;
  editingTextId = existing ? existing.id : null;

  textEditor.value = existing ? existing.text : "";
  textEditor.style.display = "block";
  textEditor.style.color = existing ? existing.strokeColor : d.strokeColor;
  textEditor.style.fontSize = `${fontSize * state.zoom}px`;
  textEditor.style.fontFamily = `"${fontFamily}", system-ui, sans-serif`;
  textEditor.style.textAlign = textAlign;
  textEditor.style.opacity = existing ? existing.opacity : d.opacity;

  const wx = existing ? existing.x : worldPoint.x;
  const wy = existing ? existing.y : worldPoint.y;
  textEditor.dataset.wx = wx;
  textEditor.dataset.wy = wy;
  textEditor.dataset.fontSize = fontSize;
  textEditor.dataset.fontFamily = fontFamily;
  textEditor.dataset.textAlign = textAlign;

  const screenX = wx * state.zoom + state.scrollX;
  const screenY = wy * state.zoom + state.scrollY;
  textEditor.style.left = `${screenX}px`;
  textEditor.style.top = `${screenY}px`;
  autoSizeEditor();

  if (existing) render();
  setTimeout(() => textEditor.focus(), 0);
}

function autoSizeEditor() {
  textEditor.style.width = "auto";
  textEditor.style.height = "auto";
  textEditor.style.width = `${textEditor.scrollWidth + 4}px`;
  textEditor.style.height = `${textEditor.scrollHeight}px`;
}

function commitText() {
  if (textEditor.style.display !== "block") return;
  const text = textEditor.value.replace(/\s+$/g, "");
  const wx = Number(textEditor.dataset.wx);
  const wy = Number(textEditor.dataset.wy);
  const fontSize = Number(textEditor.dataset.fontSize);
  const fontFamily = textEditor.dataset.fontFamily || state.defaults.fontFamily;
  const textAlign = textEditor.dataset.textAlign || state.defaults.textAlign;
  textEditor.style.display = "none";

  const editing = editingTextId ? state.elements.find((e) => e.id === editingTextId) : null;

  if (!text) {
    if (editing) {
      // emptied -> delete
      pushHistory();
      state.elements = state.elements.filter((e) => e.id !== editing.id);
      state.selectedIds = [];
      scheduleSave();
    }
    editingTextId = null;
    render();
    return;
  }

  pushHistory();
  if (editing) {
    editing.text = text;
    editing.fontSize = fontSize;
    editing.fontFamily = fontFamily;
    editing.textAlign = textAlign;
  } else {
    const d = state.defaults;
    const el = {
      id: makeId(),
      type: "text",
      text,
      x: wx,
      y: wy,
      w: 0,
      h: 0,
      fontSize,
      fontFamily,
      textAlign,
      strokeColor: d.strokeColor,
      fillColor: "transparent",
      fillStyle: d.fillStyle,
      strokeWidth: d.strokeWidth,
      strokeStyle: "solid",
      edges: d.edges,
      opacity: d.opacity,
    };
    state.elements.push(el);
    state.selectedIds = [el.id];
  }
  editingTextId = null;
  scheduleSave();
  setTool("select");
  render();
}

textEditor.addEventListener("input", autoSizeEditor);
textEditor.addEventListener("keydown", (e) => {
  e.stopPropagation();
  if (e.key === "Escape") {
    e.preventDefault();
    commitText();
  } else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    commitText();
  }
});
textEditor.addEventListener("blur", commitText);

/* ============================================================
   Pointer interaction
   ============================================================ */
let spaceDown = false;

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1 || (event.button === 0 && (spaceDown || state.tool === "hand"))) {
    // pan
    canvas.setPointerCapture(event.pointerId);
    state.action = "panning";
    state.startPoint = { x: event.clientX, y: event.clientY, sx: state.scrollX, sy: state.scrollY };
    canvas.classList.add("panning");
    return;
  }
  if (event.button !== 0) return;

  canvas.setPointerCapture(event.pointerId);
  const world = pointerWorld(event);
  state.startPoint = world;
  state.lastPoint = world;

  if (state.tool === "text") {
    const hit = [...state.elements].reverse().find((e) => e.type === "text" && hitTest(world, e));
    openTextEditor(world, hit || null);
    return;
  }

  if (state.tool === "eraser") {
    pushHistory();
    state.action = "erasing";
    eraseAt(world);
    return;
  }

  if (state.tool === "select") {
    // 1. resize handle?
    const handle = handleAt(world);
    if (handle && state.selectedIds.length) {
      beginResize(handle);
      return;
    }
    // 2. hit element?
    const hit = [...state.elements].reverse().find((e) => hitTest(world, e));
    if (hit) {
      if (event.shiftKey) {
        if (state.selectedIds.includes(hit.id))
          state.selectedIds = state.selectedIds.filter((id) => id !== hit.id);
        else state.selectedIds.push(hit.id);
      } else if (!state.selectedIds.includes(hit.id)) {
        state.selectedIds = [hit.id];
      }
      if (state.selectedIds.length) {
        pushHistory();
        state.action = "moving";
        state.moveStarted = false;
      }
    } else {
      if (!event.shiftKey) state.selectedIds = [];
      state.action = "marquee";
      const s = pointerScreen(event);
      state.marquee = { x0: s.x, y0: s.y, x1: s.x, y1: s.y };
    }
    render();
    syncPropsFromContext();
    return;
  }

  // drawing tools
  state.action = "drawing";
  state.draft = makeElement(state.tool, world);
  render();
});

canvas.addEventListener("pointermove", (event) => {
  const world = pointerWorld(event);

  if (state.action === "panning") {
    state.scrollX = state.startPoint.sx + (event.clientX - state.startPoint.x);
    state.scrollY = state.startPoint.sy + (event.clientY - state.startPoint.y);
    render();
    return;
  }

  if (state.action === "erasing") {
    eraseAt(world);
    return;
  }

  if (state.action === "moving") {
    const dx = world.x - state.lastPoint.x;
    const dy = world.y - state.lastPoint.y;
    if (dx || dy) state.moveStarted = true;
    for (const id of state.selectedIds) {
      const el = state.elements.find((e) => e.id === id);
      if (el) moveElement(el, dx, dy);
    }
    state.lastPoint = world;
    render();
    return;
  }

  if (state.action === "resizing") {
    doResize(world);
    return;
  }

  if (state.action === "marquee") {
    const s = pointerScreen(event);
    state.marquee.x1 = s.x;
    state.marquee.y1 = s.y;
    render();
    return;
  }

  if (state.action === "drawing" && state.draft) {
    if (state.draft.type === "draw") {
      state.draft.points.push({ ...world });
    } else {
      let w = world.x - state.draft.x;
      let h = world.y - state.draft.y;
      if (event.shiftKey) {
        if (state.draft.type === "line" || state.draft.type === "arrow") {
          // snap to 45°
          const angle = Math.round(Math.atan2(h, w) / (Math.PI / 4)) * (Math.PI / 4);
          const len = Math.hypot(w, h);
          w = Math.cos(angle) * len;
          h = Math.sin(angle) * len;
        } else {
          const m = Math.max(Math.abs(w), Math.abs(h));
          w = Math.sign(w || 1) * m;
          h = Math.sign(h || 1) * m;
        }
      }
      state.draft.w = w;
      state.draft.h = h;
    }
    render();
    return;
  }

  // hover cursor feedback for resize handles
  if (state.tool === "select" && state.selectedIds.length && state.action === "none") {
    const h = handleAt(world);
    canvas.style.cursor = h ? handleCursor(h) : "";
  }
});

canvas.addEventListener("pointerup", () => {
  if (state.action === "panning") {
    canvas.classList.remove("panning");
  } else if (state.action === "moving") {
    if (state.moveStarted) scheduleSave();
    else state.history.pop(); // no real move; discard history entry
  } else if (state.action === "resizing") {
    scheduleSave();
  } else if (state.action === "erasing") {
    scheduleSave();
  } else if (state.action === "marquee") {
    finishMarquee();
    state.marquee = null;
  } else if (state.action === "drawing") {
    commitDraft();
  }
  if (state.action !== "drawing") {
    state.action = "none";
    render();
    syncPropsFromContext();
  } else {
    state.action = "none";
  }
});

canvas.addEventListener("pointercancel", () => {
  state.action = "none";
  state.draft = null;
  state.marquee = null;
  canvas.classList.remove("panning");
  render();
});

canvas.addEventListener("dblclick", (event) => {
  if (state.tool === "hand") return;
  const world = pointerWorld(event);
  const hit = [...state.elements].reverse().find((e) => hitTest(world, e));
  if (hit && hit.type === "text") {
    setTool("select");
    openTextEditor(world, hit);
  } else if (!hit) {
    setTool("text");
    openTextEditor(world, null);
  }
});

function eraseAt(world) {
  const before = state.elements.length;
  const survivors = state.elements.filter((e) => !hitTest(world, e));
  if (survivors.length !== before) {
    state.elements = survivors;
    state.selectedIds = state.selectedIds.filter((id) => survivors.some((e) => e.id === id));
    render();
  }
}

function finishMarquee() {
  const m = state.marquee;
  if (!m) return;
  const a = screenToWorld(Math.min(m.x0, m.x1), Math.min(m.y0, m.y1));
  const b = screenToWorld(Math.max(m.x0, m.x1), Math.max(m.y0, m.y1));
  const box = { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y };
  if (box.w < 3 && box.h < 3) {
    render();
    return;
  }
  const inside = state.elements.filter((el) => {
    const eb = elementBounds(el);
    return eb.x >= box.x && eb.y >= box.y && eb.x + eb.w <= box.x + box.w && eb.y + eb.h <= box.y + box.h;
  });
  state.selectedIds = inside.map((e) => e.id);
  render();
  syncPropsFromContext();
}

/* ---------- resize ---------- */
function beginResize(handle) {
  pushHistory();
  state.action = "resizing";
  state.resize = {
    handle,
    bounds: getSelectionBounds(),
    orig: state.selectedIds.map((id) => JSON.parse(JSON.stringify(state.elements.find((e) => e.id === id)))),
  };
}

function doResize(world) {
  const { handle, bounds: B, orig } = state.resize;
  let fx = B.x;
  let fy = B.y;
  let sx = 1;
  let sy = 1;
  const minW = 4;
  const minH = 4;

  const right = handle.includes("e");
  const left = handle.includes("w");
  const bottom = handle.includes("s");
  const top = handle.includes("n");

  if (right) {
    fx = B.x;
    sx = Math.max(world.x - B.x, minW) / Math.max(B.w, minW);
  } else if (left) {
    fx = B.x + B.w;
    sx = Math.max(fx - world.x, minW) / Math.max(B.w, minW);
  }
  if (bottom) {
    fy = B.y;
    sy = Math.max(world.y - B.y, minH) / Math.max(B.h, minH);
  } else if (top) {
    fy = B.y + B.h;
    sy = Math.max(fy - world.y, minH) / Math.max(B.h, minH);
  }

  // edge handles scale a single axis; keep the other fixed
  if (handle === "n" || handle === "s") { sx = 1; fx = B.x; }
  if (handle === "e" || handle === "w") { sy = 1; fy = B.y; }

  state.resize.orig.forEach((o) => {
    const live = state.elements.find((e) => e.id === o.id);
    if (live) scaleElementFrom(o, live, fx, fy, sx, sy);
  });
  render();
}

function handleCursor(h) {
  return {
    nw: "nwse-resize", se: "nwse-resize",
    ne: "nesw-resize", sw: "nesw-resize",
    n: "ns-resize", s: "ns-resize",
    e: "ew-resize", w: "ew-resize",
  }[h] || "default";
}

/* ============================================================
   Wheel: pan + zoom-to-cursor
   ============================================================ */
canvas.addEventListener(
  "wheel",
  (event) => {
    event.preventDefault();
    if (event.ctrlKey || event.metaKey) {
      const rect = canvas.getBoundingClientRect();
      const cx = event.clientX - rect.left;
      const cy = event.clientY - rect.top;
      const factor = Math.exp(-event.deltaY * 0.0015);
      zoomAtPoint(cx, cy, state.zoom * factor);
    } else {
      state.scrollX -= event.deltaX;
      state.scrollY -= event.deltaY;
      render();
    }
  },
  { passive: false }
);

function zoomAtPoint(cx, cy, newZoom) {
  newZoom = clamp(newZoom, 0.1, 10);
  const world = screenToWorld(cx, cy);
  state.zoom = newZoom;
  state.scrollX = cx - world.x * newZoom;
  state.scrollY = cy - world.y * newZoom;
  render();
}

function zoomBy(delta) {
  zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, state.zoom + delta);
}

function resetZoom() {
  zoomAtPoint(window.innerWidth / 2, window.innerHeight / 2, 1);
}

function zoomToFit() {
  const b = allBounds();
  if (!b || (!b.w && !b.h)) {
    resetZoom();
    return;
  }
  const pad = 80;
  const z = clamp(Math.min((window.innerWidth - pad) / b.w, (window.innerHeight - pad) / b.h), 0.1, 4);
  state.zoom = z;
  state.scrollX = (window.innerWidth - b.w * z) / 2 - b.x * z;
  state.scrollY = (window.innerHeight - b.h * z) / 2 - b.y * z;
  render();
}

function updateZoomLabel() {
  $("#zoomReset").textContent = `${Math.round(state.zoom * 100)}%`;
}

/* ============================================================
   Tools
   ============================================================ */
function setTool(tool) {
  state.tool = tool;
  document.querySelectorAll(".tool-btn[data-tool]").forEach((b) =>
    b.classList.toggle("active", b.dataset.tool === tool)
  );
  canvas.className = `tool-${tool}`;
  if (tool !== "select") {
    // keep selection visible only for select tool
  }
  syncPropsFromContext();
}

document.querySelectorAll(".tool-btn[data-tool]").forEach((btn) => {
  btn.addEventListener("click", () => setTool(btn.dataset.tool));
});

const SHORTCUTS = {
  v: "select", "1": "select",
  h: "hand",
  r: "rect", "2": "rect",
  d: "diamond", "3": "diamond",
  o: "ellipse", "4": "ellipse",
  a: "arrow", "5": "arrow",
  l: "line", "6": "line",
  p: "draw", "7": "draw",
  t: "text", "8": "text",
  e: "eraser", "9": "eraser",
};

/* ============================================================
   Properties panel
   ============================================================ */
function buildSwatches() {
  buildSwatchRow("stroke", STROKE_COLORS, "strokeColor");
  buildSwatchRow("fill", FILL_COLORS, "fillColor");
}

function buildSwatchRow(key, colors, prop) {
  const container = document.querySelector(`[data-swatches="${key}"]`);
  container.innerHTML = "";
  colors.forEach((color) => {
    const b = document.createElement("button");
    b.className = "swatch" + (color === "transparent" ? " transparent" : "");
    if (color !== "transparent") b.style.background = color;
    b.dataset.color = color;
    b.title = color;
    b.addEventListener("click", () => applyProp(prop, color));
    container.appendChild(b);
  });
  const sep = document.createElement("span");
  sep.className = "swatch-sep";
  container.appendChild(sep);
  const picker = document.createElement("input");
  picker.type = "color";
  picker.className = "color-pick";
  picker.value = prop === "strokeColor" ? "#1e1e1e" : "#ffc9c9";
  picker.title = "Custom color";
  picker.addEventListener("input", (e) => applyProp(prop, e.target.value));
  picker.dataset.picker = prop;
  container.appendChild(picker);
}

function applyProp(prop, value) {
  if (prop === "strokeWidth" || prop === "fontSize") value = Number(value);
  if (prop === "opacity") value = Number(value) / 100;

  state.defaults[prop] = value;

  if (state.selectedIds.length) {
    pushHistory();
    for (const id of state.selectedIds) {
      const el = state.elements.find((e) => e.id === id);
      if (el) el[prop] = value;
    }
    scheduleSave();
    render();
  }
  // keep live text editor in sync when font/align changes
  if (textEditor.style.display === "block") {
    if (prop === "fontFamily") textEditor.style.fontFamily = `"${value}", system-ui, sans-serif`;
    if (prop === "textAlign") textEditor.style.textAlign = value;
    if (prop === "fontSize") textEditor.style.fontSize = `${Number(value) * state.zoom}px`;
    textEditor.dataset[prop] = value;
    autoSizeEditor();
  }
  syncPropsFromContext();
}

// option buttons (fillStyle, strokeWidth, strokeStyle, edges, fontSize)
document.querySelectorAll("[data-options]").forEach((group) => {
  const prop = group.dataset.options;
  group.querySelectorAll(".opt").forEach((btn) => {
    btn.addEventListener("click", () => applyProp(prop, btn.dataset.value));
  });
});

// action buttons
document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => runAction(btn.dataset.action));
});

$("#opacity").addEventListener("input", (e) => applyProp("opacity", e.target.value));

function runAction(action) {
  if (!state.selectedIds.length && action !== "delete") return;
  if (action === "delete") return deleteSelection();
  if (action === "duplicate") return duplicateSelection();

  pushHistory();
  const selected = state.elements.filter((e) => state.selectedIds.includes(e.id));
  const rest = state.elements.filter((e) => !state.selectedIds.includes(e.id));
  if (action === "toFront") state.elements = [...rest, ...selected];
  if (action === "toBack") state.elements = [...selected, ...rest];
  scheduleSave();
  render();
}

function deleteSelection() {
  if (!state.selectedIds.length) return;
  pushHistory();
  state.elements = state.elements.filter((e) => !state.selectedIds.includes(e.id));
  state.selectedIds = [];
  scheduleSave();
  render();
  syncPropsFromContext();
}

function duplicateSelection() {
  if (!state.selectedIds.length) return;
  pushHistory();
  const clones = state.elements
    .filter((e) => state.selectedIds.includes(e.id))
    .map((e) => {
      const c = JSON.parse(JSON.stringify(e));
      c.id = makeId();
      return c;
    });
  clones.forEach((c) => moveElement(c, 16, 16));
  state.elements.push(...clones);
  state.selectedIds = clones.map((c) => c.id);
  scheduleSave();
  render();
  syncPropsFromContext();
}

/* Decide which prop groups apply & sync active states */
function syncPropsFromContext() {
  const selected = state.elements.filter((e) => state.selectedIds.includes(e.id));
  const drawingTool = !["select", "hand", "eraser"].includes(state.tool);

  // visibility of whole panel
  const show = selected.length > 0 || drawingTool;
  propsPanel.classList.toggle("show", show);
  if (!show) return;

  // determine the "subject" types
  const types = selected.length ? [...new Set(selected.map((e) => e.type))] : [state.tool];
  const has = (t) => types.includes(t);
  const onlyText = types.length === 1 && has("text");
  const hasShape = types.some((t) => ["rect", "diamond", "ellipse"].includes(t));
  const hasFillable = hasShape;

  show_($("#strokeWidthGroup"), !onlyText && !(drawingTool && state.tool === "text"));
  show_($("#fillGroup"), hasFillable);
  show_($("#fillStyleGroup"), hasFillable && getProp("fillColor") !== "transparent");
  show_($("#edgesGroup"), has("rect"));
  show_($("#fontFamilyGroup"), onlyText || (drawingTool && state.tool === "text"));
  show_($("#fontGroup"), onlyText || (drawingTool && state.tool === "text"));
  show_($("#textAlignGroup"), onlyText || (drawingTool && state.tool === "text"));
  show_($("#layerGroup"), selected.length > 0);
  show_($("#actionGroup"), selected.length > 0);

  // reflect current values (from selection if uniform, else defaults)
  reflectSwatch("stroke", getProp("strokeColor"));
  reflectSwatch("fill", getProp("fillColor"));
  reflectOptions("fillStyle", getProp("fillStyle"));
  reflectOptions("strokeWidth", String(getProp("strokeWidth")));
  reflectOptions("edges", getProp("edges"));
  reflectOptions("fontFamily", getProp("fontFamily"));
  reflectOptions("fontSize", String(getProp("fontSize")));
  reflectOptions("textAlign", getProp("textAlign"));
  $("#opacity").value = Math.round((getProp("opacity") ?? 1) * 100);
}

function getProp(prop) {
  const selected = state.elements.filter((e) => state.selectedIds.includes(e.id));
  if (selected.length) {
    const first = selected[0][prop];
    return selected.every((e) => e[prop] === first) ? first : state.defaults[prop];
  }
  return state.defaults[prop];
}

function show_(el, on) {
  if (el) el.style.display = on ? "flex" : "none";
}

function reflectSwatch(key, value) {
  const container = document.querySelector(`[data-swatches="${key}"]`);
  let matched = false;
  container.querySelectorAll(".swatch").forEach((s) => {
    const on = s.dataset.color === value;
    s.classList.toggle("active", on);
    if (on) matched = true;
  });
  const picker = container.querySelector(".color-pick");
  if (picker && value && value !== "transparent") picker.value = toHex(value);
  if (picker) picker.classList.toggle("active", !matched && value !== "transparent");
}

function reflectOptions(prop, value) {
  const group = document.querySelector(`[data-options="${prop}"]`);
  if (!group) return;
  group.querySelectorAll(".opt").forEach((b) => b.classList.toggle("active", b.dataset.value === value));
}

function toHex(c) {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = c.match(/\d+/g);
  if (!m) return "#000000";
  return "#" + m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, "0")).join("");
}

/* ============================================================
   Keyboard
   ============================================================ */
window.addEventListener("keydown", (event) => {
  if (textEditor.style.display === "block") return;
  const target = event.target;
  if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") return;

  const ctrl = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (key === " ") {
    spaceDown = true;
    return;
  }

  if (ctrl) {
    if (key === "z") {
      event.preventDefault();
      event.shiftKey ? redo() : undo();
    } else if (key === "y") {
      event.preventDefault();
      redo();
    } else if (key === "d") {
      event.preventDefault();
      duplicateSelection();
    } else if (key === "a") {
      event.preventDefault();
      state.selectedIds = state.elements.map((e) => e.id);
      setTool("select");
      render();
      syncPropsFromContext();
    } else if (key === "c") {
      state.clipboard = state.elements
        .filter((e) => state.selectedIds.includes(e.id))
        .map((e) => JSON.parse(JSON.stringify(e)));
    } else if (key === "v") {
      pasteClipboard();
    } else if (key === "=" || key === "+") {
      event.preventDefault();
      zoomBy(0.1);
    } else if (key === "-") {
      event.preventDefault();
      zoomBy(-0.1);
    } else if (key === "0") {
      event.preventDefault();
      resetZoom();
    }
    return;
  }

  if (key === "delete" || key === "backspace") {
    event.preventDefault();
    deleteSelection();
  } else if (key === "escape") {
    state.selectedIds = [];
    render();
    syncPropsFromContext();
  } else if (SHORTCUTS[key]) {
    setTool(SHORTCUTS[key]);
  }
});

window.addEventListener("keyup", (event) => {
  if (event.key === " ") spaceDown = false;
});

function pasteClipboard() {
  if (!state.clipboard || !state.clipboard.length) return;
  pushHistory();
  const clones = state.clipboard.map((e) => {
    const c = JSON.parse(JSON.stringify(e));
    c.id = makeId();
    return c;
  });
  clones.forEach((c) => moveElement(c, 20, 20));
  state.elements.push(...clones);
  state.selectedIds = clones.map((c) => c.id);
  setTool("select");
  scheduleSave();
  render();
  syncPropsFromContext();
}

/* ============================================================
   Zoom / history controls
   ============================================================ */
$("#zoomIn").addEventListener("click", () => zoomBy(0.1));
$("#zoomOut").addEventListener("click", () => zoomBy(-0.1));
$("#zoomReset").addEventListener("click", resetZoom);
$("#undoBtn").addEventListener("click", undo);
$("#redoBtn").addEventListener("click", redo);

/* ============================================================
   Theme
   ============================================================ */
const root = document.documentElement;
function applyTheme(theme) {
  root.dataset.theme = theme;
  localStorage.setItem("dreamydraw-theme", theme);
  // theme-aware default stroke so it stays visible
  if (state.defaults.strokeColor === "#1e1e1e" && theme === "dark")
    state.defaults.strokeColor = "#e3e3e8";
  else if (state.defaults.strokeColor === "#e3e3e8" && theme === "light")
    state.defaults.strokeColor = "#1e1e1e";
  $("#themeIcon").innerHTML =
    theme === "dark"
      ? '<circle cx="12" cy="12" r="4.5"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.5 1.5M17.5 17.5L19 19M19 5l-1.5 1.5M6.5 17.5L5 19"/>'
      : '<path d="M21 12.8A8.5 8.5 0 1111.2 3a6.5 6.5 0 009.8 9.8z"/>';
  render();
}
$("#themeBtn").addEventListener("click", () =>
  applyTheme(root.dataset.theme === "dark" ? "light" : "dark")
);

/* ============================================================
   Drawer / sessions
   ============================================================ */
function openDrawer() {
  drawer.classList.add("open");
  drawerOverlay.classList.add("show");
}
function closeDrawer() {
  drawer.classList.remove("open");
  drawerOverlay.classList.remove("show");
}
$("#menuBtn").addEventListener("click", openDrawer);
$("#drawerClose").addEventListener("click", closeDrawer);
drawerOverlay.addEventListener("click", closeDrawer);

titleInput.addEventListener("input", () => {
  state.title = titleInput.value;
  scheduleSave();
});

$("#newSessionBtn").addEventListener("click", async () => {
  await createSession();
  closeDrawer();
});

async function createSession() {
  const session = {
    id: makeId(),
    title: "Untitled drawing",
    createdAt: now(),
    updatedAt: now(),
    elements: [],
    thumbnail: "",
  };
  await DreamyDB.saveSession(session);
  await loadSession(session.id);
}

async function loadSession(id) {
  const session = await DreamyDB.getSession(id);
  if (!session) return;
  state.activeId = session.id;
  state.title = session.title;
  state.elements = session.elements || [];
  state.selectedIds = [];
  state.history = [];
  state.future = [];
  titleInput.value = state.title;
  await refreshSessions(false);
  zoomToFit();
  render();
  syncPropsFromContext();
}

async function refreshSessions(selectNewest) {
  state.sessions = await DreamyDB.listSessions();
  sessionList.innerHTML = "";

  if (!state.sessions.length) {
    sessionList.innerHTML = `<div class="session-meta">No drawings yet.</div>`;
    return;
  }

  for (const session of state.sessions) {
    const card = document.createElement("div");
    card.className = `session-card ${session.id === state.activeId ? "active" : ""}`;
    card.innerHTML = `
      <img class="session-thumb" alt="" src="${session.thumbnail || emptyThumb()}" />
      <div class="session-info">
        <span class="session-title">${escapeHtml(session.title)}</span>
        <span class="session-meta">${new Date(session.updatedAt).toLocaleDateString()} · ${new Date(
      session.updatedAt
    ).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</span>
      </div>
      <button class="session-delete" title="Delete drawing">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 7h14M10 7V5a1 1 0 011-1h2a1 1 0 011 1v2M6 7l1 13a1 1 0 001 1h8a1 1 0 001-1l1-13"/></svg>
      </button>`;
    card.querySelector(".session-thumb").addEventListener("click", () => {
      loadSession(session.id);
      closeDrawer();
    });
    card.querySelector(".session-info").addEventListener("click", () => {
      loadSession(session.id);
      closeDrawer();
    });
    card.querySelector(".session-delete").addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${session.title}"? This can't be undone.`)) return;
      await DreamyDB.deleteSession(session.id);
      if (session.id === state.activeId) {
        const remaining = (await DreamyDB.listSessions())[0];
        if (remaining) await loadSession(remaining.id);
        else await createSession();
      } else {
        await refreshSessions(false);
      }
    });
    sessionList.appendChild(card);
  }

  if (selectNewest && state.sessions[0]) await loadSession(state.sessions[0].id);
}

function emptyThumb() {
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='112' height='84'%3E%3Crect width='112' height='84' fill='%23f1f3f5'/%3E%3Cpath d='M24 50 C40 22 60 60 88 32' fill='none' stroke='%23cbd0d6' stroke-width='5' stroke-linecap='round'/%3E%3C/svg%3E";
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" }[c]));
}

/* ============================================================
   Export / import
   ============================================================ */
function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function downloadJson(filename, data) {
  downloadBlob(filename, new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
}
function slug(text) {
  return (text || "drawing").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "drawing";
}

$("#exportPngBtn").addEventListener("click", exportPng);

function exportPng() {
  const b = allBounds();
  if (!b || (!b.w && !b.h)) {
    toast("Nothing to export yet");
    return;
  }
  const pad = 32;
  const scale = 2;
  const out = document.createElement("canvas");
  out.width = (b.w + pad * 2) * scale;
  out.height = (b.h + pad * 2) * scale;
  const octx = out.getContext("2d");
  octx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--canvas-bg").trim() || "#fff";
  octx.fillRect(0, 0, out.width, out.height);
  octx.scale(scale, scale);
  octx.translate(pad - b.x, pad - b.y);
  drawElements(octx, state.elements);
  out.toBlob((blob) => downloadBlob(`${slug(state.title)}.png`, blob), "image/png");
  toast("Exported PNG");
}

$("#exportAllBtn").addEventListener("click", async () => {
  downloadJson("dreamydraw-backup.drmdr", await DreamyDB.exportAll());
  toast("Backup downloaded");
});

$("#importFile").addEventListener("change", async (event) => {
  const file = event.target.files[0];
  if (!file) return;
  try {
    const backup = JSON.parse(await file.text());
    const sessions = Array.isArray(backup.sessions) ? backup.sessions : [backup];
    for (const session of sessions) {
      await DreamyDB.saveSession({
        id: session.id || makeId(),
        title: session.title || "Imported drawing",
        createdAt: session.createdAt || now(),
        updatedAt: now(),
        elements: Array.isArray(session.elements) ? session.elements : [],
        thumbnail: session.thumbnail || "",
      });
    }
    toast(`Imported ${sessions.length} drawing${sessions.length > 1 ? "s" : ""}`);
    await refreshSessions(true);
  } catch (err) {
    toast("Could not read that file");
  }
  event.target.value = "";
});

/* ============================================================
   Toast
   ============================================================ */
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove("show"), 2200);
}

/* ============================================================
   Boot
   ============================================================ */
window.addEventListener("resize", resizeCanvas);

(async function boot() {
  applyTheme(localStorage.getItem("dreamydraw-theme") || "light");
  buildSwatches();
  resizeCanvas();
  await refreshSessions(false);
  if (state.sessions[0]) await loadSession(state.sessions[0].id);
  else await createSession();
  setTool("select");
})();
