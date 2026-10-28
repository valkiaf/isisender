// IsiSender - interfaz
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const socket = io({ autoConnect: false });
let wa = { status: 'desconectado' };
let contacts = [];
let chats = [];
let templates = [];
let openPhone = null;
let selected = new Set();       // destinatarios del envío masivo
let contactSel = new Set();     // contactos marcados en la tabla
let contactTagFilter = null;
let chatFilter = 'all';         // 'all' | 'unread' | nombre de etiqueta
let unreadTotal = 0;

// ---------- Utilidades ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => /^\+?\d/.test(String(n || '')) ? '👤' : String(n || '?').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const hue = (s) => { let h = 0; for (const ch of String(s).toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const parseTags = (t) => String(t || '').split(',').map((x) => x.trim()).filter(Boolean);
const hasTag = (c, tag) => parseTags(c.tags).some((t) => t.toLowerCase() === tag.toLowerCase());
const tagHtml = (t, extra = '') => `<span class="tag" style="--h:${hue(t)}" ${extra}>${esc(t)}</span>`;
const contactByPhone = (p) => contacts.find((c) => c.phone === p);
const fillVars = (text, c) => text
  .replace(/\{nombre\}/gi, c.name)
  .replace(/\{primer_nombre\}/gi, c.name.split(' ')[0])
  .replace(/\{numero\}/gi, c.phone);
const fmtTime = (ts) => {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};
const fmtDay = (ts) => {
  const d = new Date(ts), today = new Date(), y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Hoy';
  if (d.toDateString() === y.toDateString()) return 'Ayer';
  return d.toLocaleDateString('es', { weekday: 'long', day: 'numeric', month: 'long' });
};
function allTags() {
  const m = new Map();
  for (const c of contacts) for (const t of parseTags(c.tags)) {
    const k = t.toLowerCase();
    m.set(k, { name: m.get(k)?.name || t, n: (m.get(k)?.n || 0) + 1 });
  }
  return [...m.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
}

function toast(msg, ms = 2800) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
function msgToast(name, text, onClick) {
  const t = document.createElement('div');
  t.className = 'toast msg-toast';
  t.innerHTML = `<img src="gato-logo.png" alt=""><div><b>${esc(name)}</b><div class="t">${esc(text)}</div></div>`;
  t.onclick = () => { onClick(); t.remove(); };
  $('#toasts').appendChild(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, 6000);
}
async function api(url, opts = {}) {
  const res = await fetch(url, {
    method: opts.method || (opts.body ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && !url.startsWith('/api/auth')) { showLogin(); throw new Error('Inicia sesión'); }
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}

// Diálogo para pedir un texto (ej: una etiqueta), con sugerencias clicables
function ask(title, hint, suggestions = []) {
  return new Promise((resolve) => {
    const d = $('#askDialog');
    $('#askTitle').textContent = title;
    $('#askHint').textContent = hint || '';
    $('#askInput').value = '';
    $('#askSuggest').innerHTML = suggestions.map((t) => tagHtml(t, `data-pick="${esc(t)}" style="--h:${hue(t)};cursor:pointer"`)).join('');
    $('#askSuggest').onclick = (e) => { const p = e.target.closest('[data-pick]'); if (p) { $('#askInput').value = p.dataset.pick; d.close('ok'); } };
    d.onclose = () => resolve(d.returnValue === 'ok' && $('#askInput').value.trim() ? $('#askInput').value.trim() : null);
    d.returnValue = '';
    d.showModal();
    $('#askInput').focus();
  });
}

// Chips de etiquetas existentes bajo un campo: al hacer clic se agregan al campo
function tagSuggest(input, box) {
  const render = () => {
    const current = parseTags(input.value).map((t) => t.toLowerCase());
    box.innerHTML = allTags().filter((t) => !current.includes(t.name.toLowerCase())).slice(0, 12)
      .map((t) => `<span class="tag chip-filter" style="--h:${hue(t.name)}" data-add="${esc(t.name)}">+ ${esc(t.name)}</span>`).join('');
  };
  box.onclick = (e) => {
    const a = e.target.closest('[data-add]');
    if (!a) return;
    input.value = [...parseTags(input.value), a.dataset.add].join(', ');
    render();
  };
  input.oninput = render;
  render();
}

// ---------- Efectos al recibir mensajes ----------
let audioCtx = null;
let soundOn = store.get('isi-sound', '1') === '1';
function renderSoundBtn() {
  $('#soundBtn').textContent = soundOn ? '🔔' : '🔕';
  $('#soundBtn').classList.toggle('off', !soundOn);
  $('#soundBtn').title = soundOn ? 'Sonido activado (clic para silenciar)' : 'Sonido silenciado (clic para activar)';
}
$('#soundBtn').onclick = () => {
  soundOn = !soundOn;
  store.set('isi-sound', soundOn ? '1' : '0');
  renderSoundBtn();
  if (soundOn) ding();
};
// Los navegadores solo permiten sonido después de un clic del usuario
document.addEventListener('pointerdown', () => {
  if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  audioCtx?.resume?.();
}, { once: false });
function ding() {
  if (!soundOn || !audioCtx) return;
  const now = audioCtx.currentTime;
  [[880, 0], [1320, 0.12]].forEach(([f, t]) => {
    const o = audioCtx.createOscillator(), g = audioCtx.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, now + t);
    g.gain.exponentialRampToValueAtTime(0.25, now + t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + t + 0.35);
    o.connect(g).connect(audioCtx.destination);
    o.start(now + t);
    o.stop(now + t + 0.4);
  });
}
function celebrate(el) {
  el.classList.remove('wiggle', 'bump');
  void el.offsetWidth;
  el.classList.add(el.id === 'logo' ? 'wiggle' : 'bump');
}
function updateTitle() {
  document.title = unreadTotal ? `(${unreadTotal}) IsiSender` : 'IsiSender';
}

// Notificaciones del sistema
function renderNotifCard() {
  const supported = 'Notification' in window;
  $('#notifCard').hidden = !supported || Notification.permission !== 'default';
}
$('#notifBtn').onclick = async () => {
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? '🔔 Notificaciones activadas' : 'Notificaciones no permitidas');
  renderNotifCard();
};
function systemNotify(name, text, phone) {
  if (!('Notification' in window) || Notification.permission !== 'granted' || !document.hidden) return;
  try {
    const n = new Notification(name, { body: text, icon: 'gato-logo.png', tag: 'isi-' + phone });
    n.onclick = () => { window.focus(); showTab('chats'); openChat(phone); n.close(); };
  } catch {}
}

// ---------- Pestañas ----------
function showTab(name) {
  $$('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  $$('main section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'chats') loadChats();
  if (name === 'masivo') renderPick();
  store.set('isi-tab', name);
}
$$('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
$('#connBox').onclick = () => showTab('inicio');
$$('.step').forEach((s) => s.addEventListener('click', () => {
  showTab(s.dataset.go);
  if (s.dataset.go === 'inicio') $('#connCard').scrollIntoView({ behavior: 'smooth' });
}));

function renderGuide() {
  const linked = wa.status === 'conectado';
  $('#step1').classList.toggle('done', linked);
  $('#step1t').textContent = linked ? '¡Listo! +' + (wa.me?.phone || '') : 'Con tu número, abajo';
  $('#step2').classList.toggle('done', contacts.length > 0);
  $('#step2t').textContent = contacts.length ? `${contacts.length} contacto(s)` : 'A mano o desde Excel';
  const sent = chats.some((c) => c.last?.dir === 'out');
  $('#step3').classList.toggle('done', sent);
  $('#step3t').textContent = sent ? '¡Ya enviaste mensajes!' : 'A todos o por etiqueta';
}

// ---------- Conexión ----------
function renderConn() {
  const dot = $('#connDot'), txt = $('#connText');
  dot.className = 'dot' + (wa.status === 'conectado' ? ' ok' : ['conectando', 'esperando-codigo', 'esperando-qr'].includes(wa.status) ? ' wait' : '');
  txt.textContent = wa.status === 'conectado' ? 'Conectado' : {
    conectando: 'Conectando…', 'esperando-codigo': 'Esperando vinculación', 'esperando-qr': 'Esperando QR', error: 'Error',
  }[wa.status] || 'Sin vincular';

  const card = $('#connCard');
  const err = wa.error ? `<div class="err">${esc(wa.error)}</div>` : '';
  if (wa.status === 'conectado') {
    card.innerHTML = `
      <h2>✅ WhatsApp conectado</h2>
      <p class="hint">Vinculado al número <b>+${esc(wa.me?.phone)}</b>${wa.me?.name ? ' (' + esc(wa.me.name) + ')' : ''}. Ya puedes enviar y recibir mensajes.</p>
      <div class="row" style="justify-content:flex-start">
        <button class="btn" data-go="masivo">📣 Ir a envío masivo</button>
        <button class="btn ghost" data-go="chats">💬 Ver chats</button>
        <button class="btn ghost" id="logoutBtn" style="color:var(--danger)">Desvincular</button>
      </div>`;
    $('#logoutBtn').onclick = async () => {
      if (!confirm('¿Desvincular este WhatsApp de IsiSender? Tendrás que volver a vincularlo para enviar mensajes.')) return;
      await api('/api/logout', { body: {} });
    };
  } else if (wa.status === 'esperando-codigo') {
    card.innerHTML = `
      <h2>📲 Ingresa este código en tu teléfono</h2>
      <div class="code">${esc(wa.pairingCode)}</div>
      <ol class="steps">
        <li>Abre <b>WhatsApp</b> en tu teléfono.</li>
        <li>Ve a <b>Ajustes → Dispositivos vinculados → Vincular un dispositivo</b>.</li>
        <li>Toca <b>“Vincular con número de teléfono”</b> (abajo).</li>
        <li>Escribe el código de arriba.</li>
      </ol>
      <p class="hint">El código vence en un par de minutos. Si vence, pide uno nuevo.</p>
      <button class="btn ghost" id="cancelLink">Cancelar / pedir otro código</button>${err}`;
    $('#cancelLink').onclick = () => api('/api/logout', { body: {} });
  } else if (wa.status === 'esperando-qr') {
    card.innerHTML = `
      <h2>📷 Escanea el código QR</h2>
      <img src="${wa.qr}" alt="QR" style="width:260px;height:260px;background:#fff;padding:8px;border-radius:8px">
      <ol class="steps"><li>WhatsApp → <b>Ajustes → Dispositivos vinculados → Vincular un dispositivo</b>.</li><li>Apunta la cámara al QR.</li></ol>
      <button class="btn ghost" id="cancelLink">Cancelar</button>${err}`;
    $('#cancelLink').onclick = () => api('/api/logout', { body: {} });
  } else if (wa.status === 'conectando') {
    card.innerHTML = `<h2>⏳ Conectando con WhatsApp…</h2><p class="hint">Esto toma unos segundos.</p>`;
  } else {
    card.innerHTML = `
      <h2>🔗 Vincula tu WhatsApp</h2>
      <p class="hint">IsiSender se conecta como un “dispositivo vinculado”, igual que WhatsApp Web. Tu teléfono sigue funcionando normal.</p>
      <form id="linkForm" class="row">
        <div><label for="linkPhone">Tu número de WhatsApp (con código de país)</label>
        <input id="linkPhone" placeholder="Ej: 56912345678" inputmode="numeric" value="${esc(store.get('isi-phone', ''))}"></div>
        <button class="btn">Obtener código</button>
      </form>
      <p class="hint" style="margin-top:14px">¿Prefieres escanear un QR? <a href="#" id="useQr">Usar código QR</a></p>${err}`;
    $('#linkForm').onsubmit = async (e) => {
      e.preventDefault();
      const phone = $('#linkPhone').value;
      store.set('isi-phone', phone);
      try { await api('/api/connect', { body: { phone } }); } catch (er) { toast(er.message); }
    };
    $('#useQr').onclick = async (e) => { e.preventDefault(); await api('/api/connect', { body: { method: 'qr' } }); };
  }
  card.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => showTab(b.dataset.go)));
  renderGuide();
}
socket.on('status', (s) => {
  const was = wa.status;
  wa = s;
  renderConn();
  if (was !== 'conectado' && s.status === 'conectado' && was !== 'desconectado') toast('✅ WhatsApp vinculado');
});

// ---------- Contactos ----------
async function loadContacts() {
  contacts = await api('/api/contacts');
  $('#tagList').innerHTML = allTags().map((t) => `<option value="${esc(t.name)}">`).join('');
  renderContacts();
  renderPick();
  renderChatFilters();
  renderGuide();
  tagSuggest($('#cfTags'), $('#cfTagSuggest'));
}
function visibleContacts() {
  const q = $('#contactSearch').value.toLowerCase();
  return contacts.filter((c) => (!q || (c.name + ' ' + c.phone + ' ' + c.tags).toLowerCase().includes(q))
    && (!contactTagFilter || hasTag(c, contactTagFilter)));
}
function renderContacts() {
  const tags = allTags();
  if (contactTagFilter && !tags.some((t) => t.name.toLowerCase() === contactTagFilter.toLowerCase())) contactTagFilter = null;
  $('#contactTagChips').innerHTML = tags.length ? '<span class="hint" style="margin-right:4px">Filtrar:</span>' + tags.map((t) =>
    `<span class="tag chip-filter ${contactTagFilter && contactTagFilter.toLowerCase() === t.name.toLowerCase() ? 'on' : ''}" style="--h:${hue(t.name)}" data-ftag="${esc(t.name)}">${esc(t.name)} <span class="chip-count">${t.n}</span></span>`).join('') : '';
  contactSel = new Set([...contactSel].filter((id) => contacts.some((c) => c.id === id)));
  const list = visibleContacts();
  $('#contactCount').textContent = contacts.length;
  $('#contactRows').innerHTML = list.length ? list.map((c) => `
    <tr class="${contactSel.has(c.id) ? 'sel' : ''}">
      <td class="chk"><input type="checkbox" data-sel="${c.id}" ${contactSel.has(c.id) ? 'checked' : ''} aria-label="Seleccionar"></td>
      <td><div style="display:flex;gap:10px;align-items:center"><div class="avatar" style="--h:${hue(c.name)};width:32px;height:32px;font-size:12px">${esc(initials(c.name))}</div>
        <div><b>${esc(c.name)}</b>${c.notes ? `<div class="hint" style="font-size:12px">${esc(c.notes)}</div>` : ''}</div></div></td>
      <td class="col-phone">+${esc(c.phone)}</td>
      <td class="col-tags">${parseTags(c.tags).map((t) => tagHtml(t)).join('')}</td>
      <td class="actions">
        <button class="btn ghost sm" data-chat="${c.phone}" title="Abrir chat">💬</button>
        <button class="btn ghost sm" data-edit="${c.id}" title="Editar">✏️</button>
        <button class="btn ghost sm" data-del="${c.id}" title="Borrar">🗑️</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="5"><div class="empty"><img src="gato.png" alt="">${contacts.length ? 'Ningún contacto coincide con la búsqueda.' : 'Todavía no hay contactos.<br>Agrégalos arriba o importa tu Excel.'}</div></td></tr>`;
  $('#chkAll').checked = list.length > 0 && list.every((c) => contactSel.has(c.id));
  renderBulkBar();
}
function renderBulkBar() {
  $('#bulkBar').hidden = !contactSel.size;
  $('#bulkCount').textContent = `${contactSel.size} seleccionado(s)`;
}
$('#contactSearch').oninput = renderContacts;
$('#contactTagChips').onclick = (e) => {
  const c = e.target.closest('[data-ftag]');
  if (!c) return;
  contactTagFilter = contactTagFilter && contactTagFilter.toLowerCase() === c.dataset.ftag.toLowerCase() ? null : c.dataset.ftag;
  renderContacts();
};
$('#chkAll').onchange = (e) => {
  for (const c of visibleContacts()) e.target.checked ? contactSel.add(c.id) : contactSel.delete(c.id);
  renderContacts();
};
$('#contactRows').onchange = (e) => {
  const id = e.target.dataset.sel;
  if (!id) return;
  e.target.checked ? contactSel.add(id) : contactSel.delete(id);
  e.target.closest('tr').classList.toggle('sel', e.target.checked);
  renderBulkBar();
};
$('#contactRows').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.chat) { showTab('chats'); openChat(b.dataset.chat); }
  if (b.dataset.del) {
    const c = contacts.find((x) => x.id === b.dataset.del);
    if (!confirm(`¿Borrar a ${c.name}?`)) return;
    await api('/api/contacts/' + c.id, { method: 'DELETE' });
    toast('🗑️ Contacto borrado');
    loadContacts();
  }
  if (b.dataset.edit) openEdit(b.dataset.edit);
};
function openEdit(id) {
  const c = contacts.find((x) => x.id === id);
  const f = $('#editForm');
  for (const k of ['id', 'name', 'phone', 'tags', 'notes']) f.elements[k].value = c[k] || '';
  tagSuggest($('#efTags'), $('#efTagSuggest'));
  $('#editDialog').showModal();
}
$('#editDialog').addEventListener('close', async () => {
  if ($('#editDialog').returnValue !== 'ok') return;
  const body = Object.fromEntries(new FormData($('#editForm')));
  try { await api('/api/contacts/' + body.id, { method: 'PUT', body }); toast('✅ Contacto actualizado'); await loadContacts(); loadChats(); if (openPhone) renderChatHead(); }
  catch (er) { toast(er.message); }
});
$('#contactForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  body.phone = normPhoneClient(body.phone, countryCode());
  try { await api('/api/contacts', { body }); e.target.reset(); toast('✅ Contacto agregado'); loadContacts(); }
  catch (er) { toast(er.message); }
};

// Acciones sobre varios contactos
async function batch(action, tag) {
  const r = await api('/api/contacts/batch', { body: { ids: [...contactSel], action, tag } });
  return r.count;
}
$('#bulkMsg').onclick = () => {
  selected = new Set(contactSel);
  showTab('masivo');
  toast(`📣 ${selected.size} destinatario(s) listos. Escribe tu mensaje.`);
  $('#bulkText').focus();
};
$('#bulkTagAdd').onclick = async () => {
  const tag = await ask('🏷️ Agregar etiqueta', `Se agregará a ${contactSel.size} contacto(s). Escribe una nueva o elige una existente.`, allTags().map((t) => t.name));
  if (!tag) return;
  const n = await batch('addTag', tag);
  toast(`🏷️ “${tag}” agregada a ${n} contacto(s)`);
  loadContacts();
};
$('#bulkTagRemove').onclick = async () => {
  const sel = contacts.filter((c) => contactSel.has(c.id));
  const tags = [...new Set(sel.flatMap((c) => parseTags(c.tags)))];
  if (!tags.length) return toast('Los seleccionados no tienen etiquetas');
  const tag = await ask('Quitar etiqueta', 'Elige la etiqueta que quieres quitar de los seleccionados.', tags);
  if (!tag) return;
  await batch('removeTag', tag);
  toast(`Etiqueta “${tag}” quitada`);
  loadContacts();
};
$('#bulkDelete').onclick = async () => {
  if (!confirm(`¿Borrar ${contactSel.size} contacto(s)? Esta acción no se puede deshacer.`)) return;
  const n = await batch('delete');
  contactSel.clear();
  toast(`🗑️ ${n} contacto(s) borrados`);
  loadContacts();
};

// ---------- Importar ----------
$$('.tabs-mini button').forEach((b) => (b.onclick = () => {
  $$('.tabs-mini button').forEach((x) => x.classList.toggle('on', x === b));
  $('#impExcel').hidden = b.dataset.imp !== 'excel';
  $('#impPaste').hidden = b.dataset.imp !== 'paste';
}));
$('#importBtn').onclick = async () => {
  const text = $('#importText').value;
  if (!text.trim()) return toast('Pega la lista primero');
  const r = await api('/api/contacts/import', { body: { text } });
  toast(`✅ Importados: ${r.added}${r.skipped ? ` · omitidos (repetidos o inválidos): ${r.skipped}` : ''}`, 4500);
  $('#importText').value = '';
  loadContacts();
};

const countryCode = () => store.get('isi-cc', '56');
function normPhoneClient(raw, cc) {
  let d = String(raw ?? '').replace(/\D/g, '').replace(/^00/, '');
  if (cc && !d.startsWith(cc) && d.length <= 10) d = cc + d.replace(/^0+/, '');
  return d;
}
let xlsxLoading = null;
function loadXLSX() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  xlsxLoading ||= new Promise((res, rej) => {
    const s = document.createElement('script');
    s.src = 'vendor/xlsx.full.min.js';
    s.onload = () => res(window.XLSX);
    s.onerror = () => { xlsxLoading = null; rej(new Error('No se pudo cargar el lector de Excel')); };
    document.head.appendChild(s);
  });
  return xlsxLoading;
}
const dz = $('#dropZone');
dz.onclick = () => $('#fileInput').click();
dz.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('#fileInput').click(); } };
dz.ondragover = (e) => { e.preventDefault(); dz.classList.add('over'); };
dz.ondragleave = () => dz.classList.remove('over');
dz.ondrop = (e) => { e.preventDefault(); dz.classList.remove('over'); if (e.dataTransfer.files[0]) readSheet(e.dataTransfer.files[0]); };
$('#fileInput').onchange = (e) => { if (e.target.files[0]) readSheet(e.target.files[0]); e.target.value = ''; };

let sheet = null; // { file, rows: [[...]], headerRow: bool, map: {name, phone, tags} }
const COLS = {
  name: /nombre|name|cliente|contacto|persona/i,
  phone: /tel[eé]fono|telefono|fono|celular|cel\b|m[oó]vil|movil|n[uú]mero|numero|whats|phone|wsp|wpp/i,
  tags: /etiqueta|tag|grupo|categor|segmento|tipo|lista/i,
};
async function readSheet(file) {
  try {
    const XLSX = await loadXLSX();
    const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false })
      .filter((r) => r.some((v) => String(v).trim()));
    if (!rows.length) return toast('El archivo está vacío');
    const first = rows[0].map((v) => String(v));
    const headerRow = first.some((v) => COLS.name.test(v) || COLS.phone.test(v)) || first.every((v) => !/\d{6,}/.test(v.replace(/\D/g, '')));
    const width = Math.max(...rows.map((r) => r.length));
    const body = headerRow ? rows.slice(1) : rows;
    const find = (re) => headerRow ? first.findIndex((v) => re.test(v)) : -1;
    let phone = find(COLS.phone);
    if (phone < 0) { // la columna con más números largos
      let best = -1, bestN = 0;
      for (let i = 0; i < width; i++) {
        const n = body.filter((r) => String(r[i] ?? '').replace(/\D/g, '').length >= 8).length;
        if (n > bestN) { best = i; bestN = n; }
      }
      phone = best;
    }
    let name = find(COLS.name);
    if (name < 0) name = [...Array(width).keys()].find((i) => i !== phone && body.some((r) => /[a-záéíóúñ]/i.test(String(r[i] ?? '')))) ?? -1;
    const tags = find(COLS.tags);
    sheet = { file: file.name, rows: body, header: headerRow ? first : null, width, map: { name, phone, tags } };
    renderMap();
  } catch (er) {
    toast('❌ No pude leer el archivo: ' + er.message, 5000);
  }
}
function sheetRows() {
  const { map } = sheet;
  return sheet.rows.map((r) => ({
    name: map.name >= 0 ? String(r[map.name] ?? '').trim() : '',
    phone: map.phone >= 0 ? String(r[map.phone] ?? '').trim() : '',
    tags: map.tags >= 0 ? String(r[map.tags] ?? '').trim() : '',
  }));
}
function renderMap() {
  const box = $('#mapBox');
  const colName = (i) => sheet.header ? (sheet.header[i] || `Columna ${i + 1}`) : `Columna ${String.fromCharCode(65 + i)}`;
  const opts = (sel, allowNone) => (allowNone ? `<option value="-1">— ninguna —</option>` : '') +
    [...Array(sheet.width).keys()].map((i) => `<option value="${i}" ${i === sel ? 'selected' : ''}>${esc(colName(i))}</option>`).join('');
  const rows = sheetRows();
  const cc = countryCode();
  const valid = rows.filter((r) => { const p = normPhoneClient(r.phone, cc); return p.length >= 8 && p.length <= 15; });
  const existing = new Set(contacts.map((c) => c.phone));
  const fresh = valid.filter((r) => !existing.has(normPhoneClient(r.phone, cc))).length;
  box.hidden = false;
  box.innerHTML = `
    <h3 style="margin-top:14px">📄 ${esc(sheet.file)} <span class="hint">· ${rows.length} filas</span></h3>
    <p class="hint">Revisa que cada dato esté en la columna correcta:</p>
    <div class="map-grid">
      <div><label>👤 Nombre</label><select data-map="name">${opts(sheet.map.name, true)}</select></div>
      <div><label>📞 Número</label><select data-map="phone">${opts(sheet.map.phone, false)}</select></div>
      <div><label>🏷️ Etiquetas</label><select data-map="tags">${opts(sheet.map.tags, true)}</select></div>
    </div>
    <div class="row" style="margin-top:4px">
      <div><label for="impCC">Código de país si falta</label><input id="impCC" value="${esc(cc)}" inputmode="numeric" placeholder="56"></div>
      <div><label for="impTag">Etiqueta para todos (opcional)</label><input id="impTag" list="tagList" placeholder="Ej: evento octubre"></div>
    </div>
    <div class="table-wrap"><table class="preview-table">
      <thead><tr><th>Nombre</th><th>Número</th><th>Etiquetas</th></tr></thead>
      <tbody>${rows.slice(0, 5).map((r) => {
        const p = normPhoneClient(r.phone, cc);
        const ok = p.length >= 8 && p.length <= 15;
        return `<tr><td>${esc(r.name) || '<span class="hint">(sin nombre)</span>'}</td><td class="${ok ? '' : 'bad-txt'}">${ok ? '+' + esc(p) : esc(r.phone) + ' ⚠️'}</td><td>${parseTags(r.tags).map((t) => tagHtml(t)).join('')}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
    <p class="hint">${rows.length > 5 ? `…y ${rows.length - 5} más. ` : ''}<span class="ok-txt">${valid.length} con número válido</span>${fresh !== valid.length ? ` (${fresh} nuevos, ${valid.length - fresh} ya existen: se les sumarán las etiquetas)` : ''}${rows.length - valid.length ? ` · <span class="bad-txt">${rows.length - valid.length} sin número válido (se omiten)</span>` : ''}</p>
    <div class="row"><button class="btn" id="impGo" ${valid.length ? '' : 'disabled'}>📥 Importar ${valid.length} contacto(s)</button><button class="btn ghost" id="impCancel">Cancelar</button></div>`;
  box.querySelectorAll('[data-map]').forEach((s) => (s.onchange = () => { sheet.map[s.dataset.map] = Number(s.value); renderMap(); }));
  $('#impCC').onchange = (e) => { store.set('isi-cc', e.target.value.replace(/\D/g, '')); renderMap(); };
  $('#impCancel').onclick = () => { sheet = null; box.hidden = true; };
  $('#impGo').onclick = async () => {
    $('#impGo').disabled = true;
    try {
      const r = await api('/api/contacts/bulk', { body: { rows: sheetRows(), countryCode: countryCode(), tag: $('#impTag').value } });
      toast(`🎉 ${r.added} contacto(s) nuevos${r.updated ? ` · ${r.updated} actualizados` : ''}${r.invalid ? ` · ${r.invalid} omitidos` : ''}`, 5000);
      sheet = null;
      box.hidden = true;
      loadContacts();
    } catch (er) { toast(er.message); $('#impGo').disabled = false; }
  };
}
$('#tplDownload').onclick = async (e) => {
  e.preventDefault();
  const XLSX = await loadXLSX();
  const ws = XLSX.utils.aoa_to_sheet([['Nombre', 'Número', 'Etiquetas'], ['María Pérez', '56912345678', 'cliente, vip'], ['Juan Soto', '912345678', 'proveedor']]);
  ws['!cols'] = [{ wch: 22 }, { wch: 16 }, { wch: 22 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contactos');
  XLSX.writeFile(wb, 'plantilla-isisender.xlsx');
};
$('#exportBtn').onclick = async () => {
  if (!contacts.length) return toast('No hay contactos para exportar');
  const XLSX = await loadXLSX();
  const ws = XLSX.utils.json_to_sheet(contacts.map((c) => ({ Nombre: c.name, 'Número': c.phone, Etiquetas: c.tags, Notas: c.notes || '' })));
  ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 24 }, { wch: 30 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Contactos');
  XLSX.writeFile(wb, `contactos-isisender-${new Date().toISOString().slice(0, 10)}.xlsx`);
};

// ---------- Chats ----------
async function loadChats() {
  chats = await api('/api/chats');
  renderChatList();
  renderGuide();
}
function renderChatFilters() {
  const opts = [['all', 'Todos'], ['unread', 'No leídos'], ...allTags().map((t) => [t.name, t.name])];
  if (!opts.some(([k]) => k === chatFilter)) chatFilter = 'all';
  $('#chatFilterChips').innerHTML = opts.map(([k, label]) => {
    const h = k === 'all' || k === 'unread' ? 150 : hue(k);
    return `<span class="tag chip-filter ${chatFilter === k ? 'on' : ''}" style="--h:${h}" data-cf="${esc(k)}">${esc(label)}</span>`;
  }).join('');
}
$('#chatFilterChips').onclick = (e) => {
  const c = e.target.closest('[data-cf]');
  if (!c) return;
  chatFilter = c.dataset.cf;
  renderChatFilters();
  renderChatList();
};
$('#chatSearch').oninput = () => renderChatList();
function renderChatList(flashPhone) {
  unreadTotal = chats.reduce((a, c) => a + c.unread, 0);
  $('#unreadPill').hidden = !unreadTotal;
  $('#unreadPill').textContent = unreadTotal;
  updateTitle();
  const q = $('#chatSearch').value.toLowerCase();
  const list = chats.filter((c) => {
    const ct = contactByPhone(c.phone);
    if (q && !(c.name + ' ' + c.phone + ' ' + (c.last?.text || '')).toLowerCase().includes(q)) return false;
    if (chatFilter === 'unread') return c.unread > 0;
    if (chatFilter !== 'all') return ct && hasTag(ct, chatFilter);
    return true;
  });
  $('#chatList').innerHTML = list.length ? list.map((c) => {
    const ct = contactByPhone(c.phone);
    const name = ct?.name || c.name;
    return `
    <div class="chat-item ${c.phone === openPhone ? 'active' : ''} ${c.unread ? 'unread' : ''} ${c.phone === flashPhone ? 'flash' : ''}" data-phone="${c.phone}">
      <div class="avatar" style="--h:${hue(name)}">${esc(initials(name))}</div>
      <div class="info">
        <div class="name"><span>${esc(name)}</span><small>${fmtTime(c.last.ts)}</small></div>
        <div class="preview">${c.last.dir === 'out' ? '✓ ' : ''}${esc(c.last.text)}</div>
        ${ct && ct.tags ? `<div>${parseTags(ct.tags).slice(0, 3).map((t) => tagHtml(t)).join('')}</div>` : ''}
      </div>
      ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}
    </div>`;
  }).join('') : `<div class="empty"><img src="gato.png" alt="">${chats.length ? 'Ningún chat con ese filtro.' : 'Aún no hay conversaciones.<br>Cuando envíes o recibas mensajes aparecerán aquí.'}</div>`;
}
$('#chatList').onclick = (e) => {
  const it = e.target.closest('.chat-item');
  if (it) openChat(it.dataset.phone);
};
$('#chatBack').onclick = () => { openPhone = null; $('#chatsBox').classList.remove('open'); renderChatList(); };

function renderChatHead() {
  const contact = contactByPhone(openPhone);
  const chat = chats.find((c) => c.phone === openPhone);
  const name = contact?.name || chat?.name || '+' + openPhone;
  $('#chatName').textContent = name;
  $('#chatPhone').textContent = '+' + openPhone;
  $('#chatAvatar').textContent = initials(name);
  $('#chatAvatar').style.setProperty('--h', hue(name));
  $('#chatSaveContact').hidden = !!contact;
  $('#chatTags').hidden = !contact;
  if (contact) {
    $('#chatTags').innerHTML = parseTags(contact.tags).map((t) => tagHtml(t, '').replace('</span>', ` <button data-untag="${esc(t)}" title="Quitar">×</button></span>`)).join('')
      + `<button class="btn ghost sm" id="chatAddTag" style="padding:2px 8px">🏷️ + etiqueta</button>
         <button class="btn ghost sm" id="chatEdit" style="padding:2px 8px">✏️ editar</button>`;
  }
}
$('#chatTags').onclick = async (e) => {
  const contact = contactByPhone(openPhone);
  if (!contact) return;
  const un = e.target.closest('[data-untag]');
  if (un) {
    const tags = parseTags(contact.tags).filter((t) => t !== un.dataset.untag).join(', ');
    await api('/api/contacts/' + contact.id, { method: 'PUT', body: { tags } });
    await loadContacts(); renderChatHead(); renderChatList();
  }
  if (e.target.id === 'chatAddTag') {
    const tag = await ask('🏷️ Agregar etiqueta', `Para ${contact.name}`, allTags().map((t) => t.name).filter((t) => !hasTag(contact, t)));
    if (!tag) return;
    await api('/api/contacts/' + contact.id, { method: 'PUT', body: { tags: contact.tags + ',' + tag } });
    toast(`🏷️ Etiqueta “${tag}” agregada`);
    await loadContacts(); renderChatHead(); renderChatList();
  }
  if (e.target.id === 'chatEdit') openEdit(contact.id);
};

let lastDay = null;
async function openChat(phone) {
  openPhone = phone;
  $('#chatsBox').classList.add('open');
  renderChatHead();
  $('#composer').hidden = false;
  renderQuickReplies();
  const msgs = await api('/api/chats/' + phone);
  lastDay = null;
  $('#msgs').innerHTML = msgs.length ? '' : '<div class="empty">Sin mensajes todavía. Escribe el primero abajo 👇</div>';
  msgs.forEach((m) => appendMsg(m, false));
  await loadChats();
  if (window.innerWidth > 760) $('#composerText').focus();
}
function appendMsg(m, animate = true) {
  const box = $('#msgs');
  box.querySelector('.empty')?.remove();
  const day = new Date(m.ts).toDateString();
  if (day !== lastDay) {
    lastDay = day;
    const sep = document.createElement('div');
    sep.className = 'day-sep';
    sep.textContent = fmtDay(m.ts);
    box.appendChild(sep);
  }
  const d = document.createElement('div');
  d.className = 'msg ' + m.dir + (animate ? ' new' : '');
  d.id = 'm-' + m.id;
  const st = { enviado: '✓', entregado: '✓✓', 'leído': '✓✓ leído', reproducido: '✓✓', pendiente: '🕓', error: '⚠️' }[m.status] || '';
  d.innerHTML = `${esc(m.text)}<div class="meta">${fmtTime(m.ts)}${m.dir === 'out' ? ' · <span class="st">' + st + '</span>' : ''}</div>`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
$('#chatSaveContact').onclick = async () => {
  const chat = chats.find((c) => c.phone === openPhone);
  const name = await ask('➕ Guardar contacto', 'Nombre para +' + openPhone);
  if (name === null) return;
  try { await api('/api/contacts', { body: { name: name || chat?.pushName || '', phone: openPhone } }); toast('✅ Contacto guardado'); await loadContacts(); renderChatHead(); }
  catch (er) { toast(er.message); }
};
function renderQuickReplies() {
  $('#quickReplies').hidden = !templates.length;
  $('#quickReplies').innerHTML = '<span class="hint" style="align-self:center;white-space:nowrap">⚡ Respuestas:</span>' +
    templates.map((t) => `<button class="btn ghost sm" data-qr="${t.id}">${esc(t.title)}</button>`).join('');
}
$('#quickReplies').onclick = (e) => {
  const b = e.target.closest('[data-qr]');
  if (!b) return;
  const t = templates.find((x) => x.id === b.dataset.qr);
  const c = contactByPhone(openPhone) || { name: chats.find((x) => x.phone === openPhone)?.pushName || '', phone: openPhone };
  $('#composerText').value = fillVars(t.text, c);
  $('#composerText').focus();
};
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#composerText').value.trim();
  if (!text || !openPhone) return;
  $('#composerText').value = '';
  try { await api('/api/send', { body: { phone: openPhone, text } }); }
  catch (er) { toast('❌ ' + er.message); $('#composerText').value = text; }
};
$('#composerText').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey && window.innerWidth > 760) { e.preventDefault(); $('#composer').requestSubmit(); }
};

socket.on('message', (m) => {
  const viewing = m.phone === openPhone && $('#tab-chats').classList.contains('active') && !document.hidden;
  if (m.phone === openPhone) {
    appendMsg(m);
    if (m.dir === 'in' && viewing) api('/api/chats/' + m.phone).catch(() => {}); // marcar leído
  }
  if (m.dir === 'in') {
    const c = contactByPhone(m.phone);
    const name = c?.name || m.pushName || '+' + m.phone;
    ding();
    navigator.vibrate?.(80);
    celebrate($('#logo'));
    if (!viewing) {
      msgToast(name, m.text, () => { showTab('chats'); openChat(m.phone); });
      systemNotify(name, m.text, m.phone);
    }
  }
  setTimeout(async () => {
    await loadChats();
    if (m.dir === 'in') { renderChatList(m.phone); celebrate($('#unreadPill')); }
  }, 150);
});
socket.on('message-status', ({ id, status }) => {
  const st = document.querySelector('#m-' + id + ' .st');
  if (st) st.textContent = { enviado: '✓', entregado: '✓✓', 'leído': '✓✓ leído', reproducido: '✓✓', error: '⚠️' }[status] || status;
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && openPhone && $('#tab-chats').classList.contains('active')) api('/api/chats/' + openPhone).then(loadChats).catch(() => {});
});

// ---------- Envío masivo ----------
function renderPick() {
  const tags = allTags();
  $('#pickTagChips').innerHTML = tags.length ? tags.map((t) => {
    const members = contacts.filter((c) => hasTag(c, t.name));
    const all = members.length && members.every((c) => selected.has(c.id));
    return `<span class="tag chip-filter ${all ? 'on' : ''}" style="--h:${hue(t.name)}" data-ptag="${esc(t.name)}">${all ? '✓ ' : ''}${esc(t.name)} <span class="chip-count">${t.n}</span></span>`;
  }).join('') : '<span class="hint">Aún no hay etiquetas. Agrégalas a tus contactos para elegir grupos con un clic.</span>';
  const q = $('#pickSearch').value.toLowerCase();
  const list = contacts.filter((c) => !q || (c.name + ' ' + c.tags + ' ' + c.phone).toLowerCase().includes(q));
  $('#pickList').innerHTML = list.length ? list.map((c) => `
    <label><input type="checkbox" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''}>
    <span style="flex:1">${esc(c.name)} <span class="hint" style="font-size:12px">+${esc(c.phone)}</span></span>
    <span>${parseTags(c.tags).slice(0, 2).map((t) => tagHtml(t)).join('')}</span></label>`).join('')
    : `<div class="empty">${contacts.length ? 'Nadie coincide con el filtro.' : 'No hay contactos. Agrégalos en la pestaña 👥 Contactos.'}</div>`;
  selected = new Set([...selected].filter((id) => contacts.some((c) => c.id === id)));
  $('#pickCount').textContent = selected.size;
  renderPreview();
}
$('#pickTagChips').onclick = (e) => {
  const c = e.target.closest('[data-ptag]');
  if (!c) return;
  const members = contacts.filter((x) => hasTag(x, c.dataset.ptag));
  const all = members.every((x) => selected.has(x.id));
  members.forEach((x) => (all ? selected.delete(x.id) : selected.add(x.id)));
  renderPick();
  if (!all) toast(`✓ ${members.length} con “${c.dataset.ptag}” seleccionados`);
};
$('#pickSearch').oninput = renderPick;
$('#pickList').onchange = (e) => {
  if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
  renderPick();
};
const visiblePicks = () => $$('#pickList input').map((i) => i.value);
$('#pickAll').onclick = () => { visiblePicks().forEach((id) => selected.add(id)); renderPick(); };
$('#pickNone').onclick = () => { visiblePicks().forEach((id) => selected.delete(id)); renderPick(); };

$$('[data-var]').forEach((b) => (b.onclick = () => {
  const t = $('#bulkText');
  const s = t.selectionStart ?? t.value.length;
  t.value = t.value.slice(0, s) + b.dataset.var + t.value.slice(t.selectionEnd ?? s);
  t.focus();
  t.selectionStart = t.selectionEnd = s + b.dataset.var.length;
  renderPreview();
}));
function renderPreview() {
  const c = contacts.find((x) => selected.has(x.id)) || contacts[0] || { name: 'María Pérez', phone: '56900000000' };
  const t = $('#bulkText').value;
  $('#bulkPreview').textContent = t ? fillVars(t, c) : 'Escribe tu mensaje arriba…';
  $('#previewWho').textContent = t ? `(así le llegará a ${c.name})` : '';
  $('#charCount').textContent = t.length ? `${t.length} caracteres` : '';
  const n = selected.size;
  const avg = (Number($('#minDelay').value || 8) + Number($('#maxDelay').value || 20)) / 2;
  const mins = Math.max(1, Math.round((n - 1) * avg / 60));
  $('#etaInfo').textContent = n ? `⏱️ ${n} mensaje(s) · tardará unos ${n > 1 ? mins + ' min' : 'segundos'}. Puedes cerrar la página mientras se envía.` : '';
  $('#bulkStart').textContent = n ? `📣 Enviar a ${n} persona(s)` : '📣 Enviar a seleccionados';
}
$('#bulkText').oninput = renderPreview;
$('#minDelay').oninput = $('#maxDelay').oninput = renderPreview;

// Plantillas
async function loadTemplates() {
  templates = await api('/api/templates');
  $('#tplList').innerHTML = templates.length ? '<span class="hint">Plantillas guardadas (clic para usar):</span>' + templates.map((t) => `
    <div class="tpl"><span data-tpl="${t.id}" title="${esc(t.text)}">📝 <b>${esc(t.title)}</b> — ${esc(t.text)}</span>
    <button class="btn ghost sm" data-deltpl="${t.id}" title="Borrar plantilla">✕</button></div>`).join('') : '';
  renderQuickReplies();
}
$('#tplList').onclick = async (e) => {
  const use = e.target.closest('[data-tpl]');
  if (use) { $('#bulkText').value = templates.find((t) => t.id === use.dataset.tpl).text; renderPreview(); toast('📝 Plantilla cargada'); }
  const del = e.target.closest('[data-deltpl]');
  if (del && confirm('¿Borrar esta plantilla?')) { await api('/api/templates/' + del.dataset.deltpl, { method: 'DELETE' }); loadTemplates(); }
};
$('#tplSave').onclick = async () => {
  const text = $('#bulkText').value.trim();
  if (!text) return toast('Escribe un mensaje primero');
  const title = await ask('💾 Guardar plantilla', 'Ponle un nombre corto (aparecerá también como respuesta rápida en los chats).');
  if (title === null) return;
  await api('/api/templates', { body: { title, text } });
  toast('💾 Plantilla guardada');
  loadTemplates();
};

$('#bulkStart').onclick = async () => {
  const text = $('#bulkText').value.trim();
  if (wa.status !== 'conectado') { toast('Primero vincula tu WhatsApp en 🏠 Inicio'); return showTab('inicio'); }
  if (!selected.size) return toast('👆 Elige a quién enviar');
  if (!text) { $('#bulkText').focus(); return toast('✍️ Escribe el mensaje'); }
  if (!confirm(`¿Enviar este mensaje a ${selected.size} persona(s)?\n\n“${fillVars(text, contacts.find((x) => selected.has(x.id)))}”`)) return;
  try {
    await api('/api/campaign', { body: { contactIds: [...selected], text, minDelay: $('#minDelay').value, maxDelay: $('#maxDelay').value } });
    $('#campaignCard').scrollIntoView({ behavior: 'smooth' });
  } catch (er) { toast(er.message); }
};
$('#bulkCancel').onclick = () => api('/api/campaign/cancel', { body: {} });

let countdown = null;
let wasRunning = false;
socket.on('campaign', (c) => {
  if (!c) return;
  $('#campaignCard').hidden = false;
  const done = c.sent + c.failed;
  $('#campaignBar').style.width = (done / c.total * 100) + '%';
  $('#campaignTitle').textContent = c.running ? `📤 Enviando… ${done}/${c.total}` : `🎉 Envío terminado: ${c.sent} enviados${c.failed ? `, ${c.failed} con error` : ''}`;
  $('#bulkCancel').hidden = !c.running;
  $('#bulkStart').disabled = c.running;
  if (wasRunning && !c.running) { toast(`🎉 Envío terminado: ${c.sent} enviados`, 5000); celebrate($('#logo')); loadChats(); }
  wasRunning = c.running;
  clearInterval(countdown);
  const info = () => {
    if (!c.running) return ($('#campaignInfo').textContent = '');
    const secs = c.nextAt ? Math.max(0, Math.round((c.nextAt - Date.now()) / 1000)) : 0;
    $('#campaignInfo').textContent = c.nextAt ? `⏳ Siguiente mensaje en ${secs} s` : `Enviando a ${c.current}…`;
  };
  info();
  countdown = setInterval(info, 1000);
  $('#campaignLog').innerHTML = c.log.map((l) => `<div>${l.ok ? '✅' : '❌'} <b>${esc(l.name)}</b> +${esc(l.phone)}${l.ok ? '' : ' — ' + esc(l.error)}</div>`).join('');
});

// ---------- Acceso desde teléfono / PC ----------
socket.on('access', (a) => {
  if (a.cloud) {
    $('#accessCard .access-grid').innerHTML = `<div class="access-box"><h3>Tu dirección de IsiSender</h3>
      ${a.url ? `<div class="url">${esc(a.url)}</div><img src="${a.qr}" alt="QR de IsiSender">` : `<div class="url">${esc(location.origin)}</div>`}
      <div class="hint">Ábrela en cualquier teléfono o PC y entra con tu contraseña.</div></div>`;
    return;
  }
  $('#lanInfo').innerHTML = a.lan.length ? `
    <div class="url">${esc(a.lan[0])}</div>
    <img src="${a.lanQr}" alt="QR para abrir en el teléfono">
    <div>Escanea con la cámara del teléfono, o escribe la dirección en el navegador. El teléfono debe estar en la misma red Wi-Fi que este computador.</div>`
    : 'Este computador no está conectado a una red Wi-Fi.';
  const n = a.internet;
  if (!n.available) {
    $('#netInfo').innerHTML = 'No disponible: falta el componente de acceso por internet (Cloudflare Tunnel) en la carpeta <b>runtime/bin</b>.';
    return;
  }
  $('#netInfo').innerHTML = `
    <label class="switch"><input type="checkbox" id="netToggle" ${n.enabled ? 'checked' : ''}> Activar acceso por internet</label>
    ${n.enabled && n.url ? `<div class="url" style="margin-top:8px">${esc(n.url)}</div><img src="${n.qr}" alt="QR acceso por internet">
      <div>Funciona con datos móviles y desde cualquier PC. <b>La dirección cambia cada vez que abres IsiSender</b>.</div>`
      : n.enabled ? '<div style="margin-top:8px">Generando dirección…</div>'
      : '<div style="margin-top:8px">Apagado. Al activarlo se crea una dirección segura (https) para entrar desde fuera.</div>'}
    ${n.error ? `<div class="err">${esc(n.error)}</div>` : ''}`;
  $('#netToggle').onchange = (e) => api('/api/access/internet', { body: { enabled: e.target.checked } }).catch((er) => toast(er.message));
});
$('#signOut').onclick = async () => {
  await api('/api/auth/logout', { body: {} });
  location.reload();
};

// ---------- Enlaces para clientes ----------
async function loadLinks() {
  const links = await api('/api/links');
  $('#linksList').innerHTML = links.length ? links.map((l) => `
    <div class="link-row">
      <div class="info"><b>${esc(l.label)}</b> <span class="hint" style="font-size:12px">· ${l.lastUsed ? 'usado ' + fmtTime(l.lastUsed) : 'aún sin usar'}</span>
        <div class="url">${esc(l.url)}</div></div>
      <button class="btn sm" data-copy="${esc(l.url)}">📋 Copiar</button>
      ${navigator.share ? `<button class="btn ghost sm" data-share="${esc(l.url)}">Compartir</button>` : ''}
      <button class="btn ghost sm" data-revoke="${esc(l.key)}" style="color:var(--danger)">Revocar</button>
    </div>`).join('') : '<p class="hint">Aún no has creado enlaces.</p>';
}
$('#linkCreate').onsubmit = async (e) => {
  e.preventDefault();
  try {
    const l = await api('/api/links', { body: { label: $('#linkLabel').value } });
    $('#linkLabel').value = '';
    await loadLinks();
    copyText(l.url);
  } catch (er) { toast(er.message); }
};
async function copyText(t) {
  try { await navigator.clipboard.writeText(t); toast('📋 Enlace copiado. Pégalo en WhatsApp o correo a tu cliente.'); }
  catch { prompt('Copia este enlace:', t); }
}
$('#linksList').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.copy) copyText(b.dataset.copy);
  if (b.dataset.share) navigator.share({ title: 'IsiSender', text: 'Tu acceso a IsiSender:', url: b.dataset.share }).catch(() => {});
  if (b.dataset.revoke) {
    if (!confirm('¿Revocar este enlace? Quien lo use quedará fuera de inmediato.')) return;
    await api('/api/links/' + encodeURIComponent(b.dataset.revoke), { method: 'DELETE' });
    toast('Enlace revocado');
    loadLinks();
  }
};

// ---------- Inicio de sesión ----------
let authMode = 'login';
function showLogin(hasPassword = true) {
  socket.disconnect();
  document.body.classList.add('locked');
  $('#loginScreen').hidden = false;
  authMode = hasPassword ? 'login' : 'setup';
  $('#loginHint').innerHTML = hasPassword ? '¡Hola de nuevo! Ingresa tu contraseña.'
    : 'Primera vez: crea una contraseña. La pedirá en el teléfono y en cualquier PC donde abras IsiSender.';
  $('#loginRepeatWrap').hidden = hasPassword;
  $('#loginPass').autocomplete = hasPassword ? 'current-password' : 'new-password';
  $('#loginBtn').textContent = hasPassword ? 'Entrar' : 'Crear contraseña';
  $('#loginPass').focus();
}
$('#loginForm').onsubmit = async (e) => {
  e.preventDefault();
  const password = $('#loginPass').value;
  $('#loginErr').textContent = '';
  const fail = (msg) => {
    $('#loginErr').textContent = msg;
    $('#loginForm').classList.remove('shake');
    void $('#loginForm').offsetWidth;
    $('#loginForm').classList.add('shake');
  };
  if (authMode === 'setup' && password !== $('#loginPass2').value) return fail('Las contraseñas no coinciden');
  try {
    await api(authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login', { body: { password } });
    $('#loginPass').value = $('#loginPass2').value = '';
    start(true);
  } catch (er) { fail(er.message); }
};
socket.on('connect_error', (err) => { if (err.message === 'auth') boot(); });

function start(admin) {
  // Quien entra por enlace usa el CRM, pero no administra accesos
  $('#accessCard').hidden = !admin;
  $('#linksCard').hidden = !admin;
  if (admin) loadLinks();
  $('#loginScreen').hidden = true;
  document.body.classList.remove('locked');
  socket.connect();
  renderSoundBtn();
  renderNotifCard();
  loadContacts();
  loadChats();
  loadTemplates();
  const tab = store.get('isi-tab', 'inicio');
  if ($('#tab-' + tab)) showTab(tab);
}
async function boot() {
  const st = await api('/api/auth/state');
  if (st.loggedIn) start(st.admin); else showLogin(st.hasPassword);
}
boot();
