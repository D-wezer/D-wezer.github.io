// A pannable, zoomable sheet of paper. Everything on it comes from content.json.
// Open the page with ?edit to get the admin toolbar; edits are kept as a draft in
// this browser and only go live once the downloaded content.json replaces the old one.

const EDIT = new URLSearchParams(location.search).has('edit');
const DRAFT_KEY = 'paper-site-draft';
const MIN_ZOOM = 0.15;
const MAX_ZOOM = 4;

const stage = document.getElementById('stage');
const world = document.getElementById('world');

let doc = { home: { cx: 0, cy: 0, k: 1 }, items: [] };
const view = { x: 0, y: 0, k: 1 };   // screen = world * k + (x, y)
const els = new Map();               // item id -> element
let selected = null;
let topZ = 10;

// ---------- loading / saving ----------

async function load() {
  if (EDIT) {
    try {
      const draft = JSON.parse(localStorage.getItem(DRAFT_KEY));
      if (draft && Array.isArray(draft.items)) return draft;
    } catch {}
  }
  try {
    const res = await fetch('content.json', { cache: 'no-store' });
    if (res.ok) return await res.json();
  } catch {}
  // fetch() is blocked on file:// — the site needs to be served over http
  return {
    home: { cx: 0, cy: 0, k: 1 },
    items: [{ id: 'err', type: 'text', x: -330, y: -30, size: 34,
      text: "Couldn't load content.json.\nServe this folder over http (see the notes)." }],
  };
}

function save() {
  if (!EDIT) return;
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
  } catch {
    // pictures are stored inside the draft, so enough of them can fill the browser's quota
    document.getElementById('hint').textContent =
      'The draft is now too big to save in this browser. Download content.json now so you don\'t lose your changes.';
  }
}

// Shrinks a picked photo and returns it as a JPEG data URL, so it can live inside content.json.
async function fileToDataURL(file, max = 1000) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';   // JPEG has no transparency
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.82);
}

// ---------- camera ----------

function applyView() {
  world.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.k})`;
  const grid = 40 * view.k;
  stage.style.backgroundSize = `${grid}px ${grid}px`;
  stage.style.backgroundPosition = `${view.x}px ${view.y}px`;
}

function goHome() {
  const h = doc.home || { cx: 0, cy: 0, k: 1 };
  view.k = h.k;
  view.x = innerWidth / 2 - h.cx * h.k;
  view.y = innerHeight / 2 - h.cy * h.k;
  applyView();
}

function zoomAt(sx, sy, factor) {
  const k = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.k * factor));
  view.x = sx - (sx - view.x) * (k / view.k);
  view.y = sy - (sy - view.y) * (k / view.k);
  view.k = k;
  applyView();
}

const toWorld = (sx, sy) => ({ x: (sx - view.x) / view.k, y: (sy - view.y) / view.k });

// ---------- rendering ----------

function build(item) {
  const el = document.createElement('div');
  el.className = `item ${item.type}`;
  el.dataset.id = item.id;

  if (item.type === 'text') {
    el.textContent = item.text;
    el.addEventListener('blur', () => {
      el.contentEditable = 'false';
      item.text = el.innerText.replace(/\n$/, '');
      save();
    });
  } else if (item.type === 'paper') {
    el.innerHTML = `
      <div class="ball-wrap"><div class="ball"></div></div>
      <div class="label"></div>
      <div class="sheet-wrap"><div class="sheet">
        <button class="scrunch" title="Scrunch it back up">scrunch ✕</button>
        <h2 class="title" data-placeholder="Title"></h2>
        <div class="body" data-placeholder="Write here…"></div>
      </div></div>`;
    const title = el.querySelector('.title');
    const body = el.querySelector('.body');
    const label = el.querySelector('.label');
    title.textContent = label.textContent = item.title;
    body.innerHTML = item.body;   // admin-authored HTML from content.json
    el.querySelector('.scrunch').addEventListener('click', () => setOpen(item, false));
    if (EDIT) {
      title.contentEditable = body.contentEditable = 'true';
      title.addEventListener('input', () => {
        item.title = label.textContent = title.textContent;
        save();
      });
      body.addEventListener('input', () => { item.body = body.innerHTML; save(); });
      for (const field of [title, body]) field.addEventListener('paste', pastePlain);
    }
  } else if (item.type === 'image') {
    el.innerHTML = '<img draggable="false"><div class="caption" data-placeholder="caption"></div>';
    const img = el.querySelector('img');
    const caption = el.querySelector('.caption');
    img.src = item.src;   // a data URL, or a path / URL to an image file
    img.alt = caption.textContent = item.caption || '';
    if (EDIT) {
      caption.contentEditable = 'true';
      caption.addEventListener('input', () => {
        item.caption = img.alt = caption.textContent;
        save();
      });
      caption.addEventListener('paste', pastePlain);
    }
  }

  if (EDIT && item.type !== 'text' && item.type !== 'paper') {
    el.insertAdjacentHTML('beforeend', '<div class="handle"></div>');
    if (item.type === 'image') el.insertAdjacentHTML('beforeend', '<div class="handle rotate"></div>');
  }
  els.set(item.id, el);
  world.appendChild(el);
  place(item);
  return el;
}

function place(item) {
  const el = els.get(item.id);
  el.style.left = item.x + 'px';
  el.style.top = item.y + 'px';
  if (item.type === 'text') el.style.fontSize = item.size + 'px';
  if (item.type === 'rect' || item.type === 'ellipse') {
    el.style.width = item.w + 'px';
    el.style.height = item.h + 'px';
  }
  if (item.type === 'arrow') {
    el.style.width = item.len + 'px';
    el.style.transform = `rotate(${item.angle}rad)`;
  }
  if (item.type === 'image') {
    el.style.width = item.w + 'px';
    el.style.transform = `rotate(${item.rot || 0}deg)`;
  }
}

function render() {
  world.textContent = '';
  els.clear();
  doc.items.forEach(build);
}

function pastePlain(e) {
  e.preventDefault();
  document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
}

// ---------- papers ----------

function setOpen(item, open) {
  const el = els.get(item.id);
  el.classList.toggle('open', open);
  if (open) el.style.zIndex = ++topZ;
  else if (el.contains(document.activeElement)) document.activeElement.blur();
}

// ---------- pointer: pan, drag, resize, click ----------

const byId = id => doc.items.find(it => it.id === id);
const isTyping = () => document.activeElement && document.activeElement.isContentEditable;

let gesture = null;

stage.addEventListener('pointerdown', e => {
  if (e.button !== 0 || gesture) return;
  const t = e.target;
  // let editable fields, links and buttons behave normally
  if (t.closest('[contenteditable="true"], a, button')) return;
  if (isTyping()) document.activeElement.blur();

  const el = t.closest('.item');
  const item = el && byId(el.dataset.id);
  let mode = 'pan';
  if (item && t.closest('.rotate')) mode = 'rotate';
  else if (item && t.closest('.handle')) mode = 'resize';
  else if (item && (EDIT || item.type === 'paper')) mode = 'move';

  gesture = {
    mode, item, el, target: t, id: e.pointerId,
    sx: e.clientX, sy: e.clientY,
    // a drag that starts on an item visitors can't move still pans the camera
    ox: mode === 'pan' ? view.x : item.x, oy: mode === 'pan' ? view.y : item.y,
    moved: false,
  };
  if (item && item.type === 'image') {
    // pictures turn about their centre, which is also the centre of their bounding box
    const box = el.getBoundingClientRect();
    gesture.cx = box.left + box.width / 2;
    gesture.cy = box.top + box.height / 2;
    gesture.w0 = item.w;
  }
  stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});

stage.addEventListener('pointermove', e => {
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  const dx = e.clientX - g.sx, dy = e.clientY - g.sy;
  if (!g.moved) {
    if (Math.hypot(dx, dy) < 4) return;   // still a click
    g.moved = true;
    if (g.mode === 'pan') stage.classList.add('panning');
    if (g.mode === 'move') {
      g.el.classList.add('dragging');
      if (g.item.type === 'paper') g.el.style.zIndex = ++topZ;
    }
  }
  if (g.mode === 'pan') {
    view.x = g.ox + dx;
    view.y = g.oy + dy;
    applyView();
  } else if (g.mode === 'move') {
    g.item.x = Math.round(g.ox + dx / view.k);
    g.item.y = Math.round(g.oy + dy / view.k);
    place(g.item);
  } else if (g.mode === 'rotate') {
    // the handle sits straight above the centre, hence the 90° offset; Shift snaps to 15° steps
    let deg = Math.atan2(e.clientY - g.cy, e.clientX - g.cx) * 180 / Math.PI + 90;
    if (e.shiftKey) deg = Math.round(deg / 15) * 15;
    g.item.rot = +(((deg + 180) % 360 + 360) % 360 - 180).toFixed(1);
    place(g.item);
  } else {
    const p = toWorld(e.clientX, e.clientY);
    const it = g.item;
    if (it.type === 'arrow') {
      it.len = Math.max(30, Math.round(Math.hypot(p.x - it.x, p.y - it.y)));
      it.angle = +Math.atan2(p.y - it.y, p.x - it.x).toFixed(3);
    } else if (it.type === 'image') {
      // grow along the picture's own (rotated) horizontal axis; height follows the photo
      const a = (it.rot || 0) * Math.PI / 180;
      it.w = Math.max(80, Math.round(g.w0 + (dx * Math.cos(a) + dy * Math.sin(a)) / view.k));
    } else {
      it.w = Math.max(30, Math.round(p.x - it.x));
      it.h = Math.max(30, Math.round(p.y - it.y));
    }
    place(it);
  }
});

function endGesture(e) {
  const g = gesture;
  if (!g || e.pointerId !== g.id) return;
  gesture = null;
  stage.classList.remove('panning');
  if (g.el) g.el.classList.remove('dragging');
  if (g.moved) save();
  else click(g.item, g.target);
}
stage.addEventListener('pointerup', endGesture);
stage.addEventListener('pointercancel', endGesture);

function click(item, target) {
  const wasSelected = item && item === selected;
  if (EDIT) select(item);
  if (!item) return;
  if (item.type === 'paper' && target.closest('.ball')) setOpen(item, true);
  // in edit mode a second click on a text item starts typing in it
  if (EDIT && item.type === 'text' && wasSelected) {
    const el = els.get(item.id);
    el.contentEditable = 'true';
    el.focus();
    getSelection().selectAllChildren(el);
  }
}

stage.addEventListener('wheel', e => {
  e.preventDefault();
  zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.004));
}, { passive: false });

// ---------- keyboard: WASD / arrows pan, Q / E zoom ----------

const MOVE_KEYS = new Set(['w', 'a', 's', 'd', 'q', 'e', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright']);
const held = new Set();
let lastFrame = 0;

function frame(now) {
  if (!held.size) { lastFrame = 0; return; }
  const dt = Math.min(0.05, lastFrame ? (now - lastFrame) / 1000 : 0.016);
  lastFrame = now;
  const step = 800 * dt;
  if (held.has('w') || held.has('arrowup')) view.y += step;
  if (held.has('s') || held.has('arrowdown')) view.y -= step;
  if (held.has('a') || held.has('arrowleft')) view.x += step;
  if (held.has('d') || held.has('arrowright')) view.x -= step;
  const zoom = (held.has('e') ? 1 : 0) - (held.has('q') ? 1 : 0);
  if (zoom) zoomAt(innerWidth / 2, innerHeight / 2, Math.exp(zoom * 1.6 * dt));
  applyView();
  requestAnimationFrame(frame);
}

addEventListener('keydown', e => {
  if (isTyping()) {
    if (e.key === 'Escape') document.activeElement.blur();
    return;
  }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const key = e.key.toLowerCase();
  if (MOVE_KEYS.has(key)) {
    e.preventDefault();
    if (!held.size) requestAnimationFrame(frame);
    held.add(key);
  } else if (key === 'escape') {
    // scrunch whichever open paper is on top
    const open = doc.items
      .filter(it => it.type === 'paper' && els.get(it.id).classList.contains('open'))
      .sort((a, b) => els.get(b.id).style.zIndex - els.get(a.id).style.zIndex)[0];
    if (open) setOpen(open, false);
  } else if (key === '0') {
    goHome();
  } else if (EDIT && (key === 'delete' || key === 'backspace')) {
    removeSelected();
  }
});
addEventListener('keyup', e => held.delete(e.key.toLowerCase()));
addEventListener('blur', () => held.clear());

// ---------- edit mode ----------

function select(item) {
  if (selected && els.has(selected.id)) els.get(selected.id).classList.remove('selected');
  selected = item || null;
  if (selected) els.get(selected.id).classList.add('selected');
}

function removeSelected() {
  if (!selected) return;
  doc.items = doc.items.filter(it => it !== selected);
  els.get(selected.id).remove();
  els.delete(selected.id);
  selected = null;
  save();
}

function addItem(type, extra) {
  const c = toWorld(innerWidth / 2, innerHeight / 2);
  const x = Math.round(c.x), y = Math.round(c.y);
  const item = {
    text: { x: x - 60, y: y - 20, size: 36, text: 'new text' },
    rect: { x: x - 100, y: y - 60, w: 200, h: 120 },
    ellipse: { x: x - 100, y: y - 60, w: 200, h: 120 },
    arrow: { x: x - 80, y, len: 160, angle: 0 },
    paper: { x, y, title: 'Untitled', body: '' },
    // a slight random tilt, like a photo dropped on the page
    image: { x: x - 140, y: y - 140, w: 280, caption: '', rot: +(Math.random() * 6 - 3).toFixed(1) },
  }[type];
  Object.assign(item, extra);
  item.id = type[0] + Date.now().toString(36);
  item.type = type;
  doc.items.push(item);
  build(item);
  select(item);
  if (type === 'paper') setOpen(item, true);
  save();
}

function initEditor() {
  document.body.classList.add('editing');
  const bar = document.getElementById('toolbar');
  bar.hidden = false;
  bar.querySelectorAll('[data-add]').forEach(b =>
    b.addEventListener('click', () => addItem(b.dataset.add)));

  const imageFile = document.getElementById('imageFile');
  document.getElementById('addImage').addEventListener('click', () => imageFile.click());
  imageFile.addEventListener('change', async () => {
    if (!imageFile.files[0]) return;
    try {
      addItem('image', { src: await fileToDataURL(imageFile.files[0]) });
    } catch {
      alert("That file couldn't be read as a picture.");
    }
    imageFile.value = '';
  });

  const resize = factor => {
    if (!selected || selected.type !== 'text') return;
    selected.size = Math.max(10, Math.round(selected.size * factor));
    place(selected);
    save();
  };
  document.getElementById('smaller').addEventListener('click', () => resize(1 / 1.15));
  document.getElementById('bigger').addEventListener('click', () => resize(1.15));
  document.getElementById('delete').addEventListener('click', removeSelected);

  document.getElementById('setHome').addEventListener('click', () => {
    const c = toWorld(innerWidth / 2, innerHeight / 2);
    doc.home = { cx: Math.round(c.x), cy: Math.round(c.y), k: +view.k.toFixed(3) };
    save();
  });

  document.getElementById('export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(doc, null, 2) + '\n'], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'content.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  const file = document.getElementById('importFile');
  document.getElementById('import').addEventListener('click', () => file.click());
  file.addEventListener('change', async () => {
    if (!file.files[0]) return;
    try {
      const next = JSON.parse(await file.files[0].text());
      if (!Array.isArray(next.items)) throw new Error('no items');
      doc = next;
      selected = null;
      render();
      goHome();
      save();
    } catch {
      alert("That file isn't a valid content.json.");
    }
    file.value = '';
  });

  document.getElementById('discard').addEventListener('click', () => {
    if (!confirm('Throw away the draft in this browser and reload the published content?')) return;
    localStorage.removeItem(DRAFT_KEY);
    location.reload();
  });
}

// ---------- start ----------

document.getElementById('hint').innerHTML = EDIT
  ? 'Edit mode — drag to move, click selected text again to type, drag the blue dot to resize, drag the dot above a picture to rotate it. Changes are a draft in this browser until you download content.json and publish it.'
  : '<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move · <kbd>Q</kbd><kbd>E</kbd> or scroll to zoom · click a paper ball to unravel it · drag papers around';

load().then(loaded => {
  doc = loaded;
  if (EDIT) initEditor();
  render();
  goHome();
});
