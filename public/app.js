// IsiSender - interfaz
const $ = (s) => document.querySelector(s);
const socket = io({ autoConnect: false });
let wa = { status: 'desconectado' };
let contacts = [];
let chats = [];
let openPhone = null;
let selected = new Set();

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const initials = (n) => String(n || '?').replace(/^\+/, '').split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const fmtTime = (ts) => {
  const d = new Date(ts), now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString('es', { day: '2-digit', month: 'short' }) + ' ' + d.toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
};
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._h);
  t._h = setTimeout(() => t.classList.remove('show'), 2800);
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

// ---------- Pestañas ----------
function showTab(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('main section').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
  if (name === 'chats') loadChats();
  if (name === 'masivo') renderPick();
}
document.querySelectorAll('nav button').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

// ---------- Conexión ----------
function renderConn() {
  const dot = $('#connDot'), txt = $('#connText');
  dot.className = 'dot' + (wa.status === 'conectado' ? ' ok' : ['conectando', 'esperando-codigo', 'esperando-qr'].includes(wa.status) ? ' wait' : '');
  txt.textContent = wa.status === 'conectado' ? 'Conectado · +' + (wa.me?.phone || '') : {
    conectando: 'Conectando…', 'esperando-codigo': 'Esperando vinculación', 'esperando-qr': 'Esperando QR', error: 'Error',
  }[wa.status] || 'Desconectado';

  const card = $('#connCard');
  const err = wa.error ? `<div class="err">${esc(wa.error)}</div>` : '';
  if (wa.status === 'conectado') {
    card.innerHTML = `
      <h2>✅ WhatsApp conectado</h2>
      <p class="hint">Vinculado al número <b>+${esc(wa.me?.phone)}</b>${wa.me?.name ? ' (' + esc(wa.me.name) + ')' : ''}. Ya puedes enviar y recibir mensajes.</p>
      <div class="row" style="justify-content:flex-start">
        <button class="btn" onclick="showTab('masivo')">Ir a envío masivo</button>
        <button class="btn ghost" onclick="showTab('chats')">Ver chats</button>
        <button class="btn danger" id="logoutBtn">Desvincular</button>
      </div>`;
    $('#logoutBtn').onclick = async () => {
      if (!confirm('¿Desvincular este WhatsApp de IsiSender?')) return;
      await api('/api/logout', { body: {} });
    };
  } else if (wa.status === 'esperando-codigo') {
    card.innerHTML = `
      <h2>Ingresa este código en tu teléfono</h2>
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
      <h2>Escanea el código QR</h2>
      <img src="${wa.qr}" alt="QR" style="width:260px;height:260px;background:#fff;padding:8px;border-radius:8px">
      <ol class="steps"><li>WhatsApp → <b>Ajustes → Dispositivos vinculados → Vincular un dispositivo</b>.</li><li>Apunta la cámara al QR.</li></ol>
      <button class="btn ghost" id="cancelLink">Cancelar</button>${err}`;
    $('#cancelLink').onclick = () => api('/api/logout', { body: {} });
  } else if (wa.status === 'conectando') {
    card.innerHTML = `<h2>Conectando con WhatsApp…</h2><p class="hint">Esto toma unos segundos.</p>`;
  } else {
    card.innerHTML = `
      <h2>Vincula tu WhatsApp</h2>
      <p class="hint">IsiSender se conecta como un “dispositivo vinculado”, igual que WhatsApp Web. Tu teléfono sigue funcionando normal.</p>
      <form id="linkForm" class="row">
        <div><label>Tu número de WhatsApp (con código de país, sin + ni espacios)</label>
        <input id="linkPhone" placeholder="Ej: 56912345678" inputmode="numeric" value="${esc(localStorage.getItem('isi-phone') || '')}"></div>
        <button class="btn">Obtener código</button>
      </form>
      <p class="hint" style="margin-top:14px">¿Prefieres escanear un QR? <a href="#" id="useQr">Usar código QR</a></p>${err}`;
    $('#linkForm').onsubmit = async (e) => {
      e.preventDefault();
      const phone = $('#linkPhone').value;
      try { localStorage.setItem('isi-phone', phone); } catch {}
      try { await api('/api/connect', { body: { phone } }); } catch (er) { toast(er.message); }
    };
    $('#useQr').onclick = async (e) => { e.preventDefault(); await api('/api/connect', { body: { method: 'qr' } }); };
  }
}
socket.on('status', (s) => { wa = s; renderConn(); });

// ---------- Contactos ----------
async function loadContacts() {
  contacts = await api('/api/contacts');
  renderContacts();
  renderPick();
}
function renderContacts() {
  const q = $('#contactSearch').value.toLowerCase();
  const list = contacts.filter((c) => !q || (c.name + ' ' + c.phone + ' ' + c.tags).toLowerCase().includes(q));
  $('#contactCount').textContent = contacts.length;
  $('#contactRows').innerHTML = list.length ? list.map((c) => `
    <tr>
      <td><b>${esc(c.name)}</b>${c.notes ? `<div class="hint" style="margin:0;font-size:12px">${esc(c.notes)}</div>` : ''}</td>
      <td>+${esc(c.phone)}</td>
      <td>${c.tags.split(',').filter((t) => t.trim()).map((t) => `<span class="tag">${esc(t.trim())}</span>`).join('')}</td>
      <td class="actions">
        <button class="btn ghost sm" data-chat="${c.phone}">Chat</button>
        <button class="btn ghost sm" data-edit="${c.id}">Editar</button>
        <button class="btn ghost sm" data-del="${c.id}" style="color:var(--danger)">Borrar</button>
      </td>
    </tr>`).join('') : `<tr><td colspan="4" class="empty">Sin contactos todavía. Agrégalos arriba o impórtalos en lote.</td></tr>`;
}
$('#contactSearch').oninput = renderContacts;
$('#contactRows').onclick = async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  if (b.dataset.chat) { showTab('chats'); openChat(b.dataset.chat); }
  if (b.dataset.del) {
    const c = contacts.find((x) => x.id === b.dataset.del);
    if (!confirm(`¿Borrar a ${c.name}?`)) return;
    await api('/api/contacts/' + c.id, { method: 'DELETE' });
    loadContacts();
  }
  if (b.dataset.edit) {
    const c = contacts.find((x) => x.id === b.dataset.edit);
    const f = $('#editForm');
    for (const k of ['id', 'name', 'phone', 'tags', 'notes']) f.elements[k].value = c[k] || '';
    $('#editDialog').showModal();
  }
};
$('#editDialog').addEventListener('close', async () => {
  if ($('#editDialog').returnValue !== 'ok') return;
  const f = $('#editForm');
  const body = Object.fromEntries(new FormData(f));
  try { await api('/api/contacts/' + body.id, { method: 'PUT', body }); toast('Contacto actualizado'); loadContacts(); loadChats(); }
  catch (er) { toast(er.message); }
});
$('#contactForm').onsubmit = async (e) => {
  e.preventDefault();
  const body = Object.fromEntries(new FormData(e.target));
  try { await api('/api/contacts', { body }); e.target.reset(); toast('Contacto agregado'); loadContacts(); }
  catch (er) { toast(er.message); }
};
$('#importBtn').onclick = async () => {
  const text = $('#importText').value;
  if (!text.trim()) return toast('Pega la lista primero');
  const r = await api('/api/contacts/import', { body: { text } });
  toast(`Importados: ${r.added}${r.skipped ? ` · omitidos (repetidos o inválidos): ${r.skipped}` : ''}`);
  $('#importText').value = '';
  loadContacts();
};

// ---------- Chats ----------
async function loadChats() {
  chats = await api('/api/chats');
  renderChatList();
}
function renderChatList() {
  const unread = chats.reduce((a, c) => a + c.unread, 0);
  $('#unreadPill').hidden = !unread;
  $('#unreadPill').textContent = unread;
  $('#chatList').innerHTML = chats.length ? chats.map((c) => `
    <div class="chat-item ${c.phone === openPhone ? 'active' : ''}" data-phone="${c.phone}">
      <div class="avatar">${esc(initials(c.name))}</div>
      <div class="info">
        <div class="name"><span>${esc(c.name)}</span><small>${fmtTime(c.last.ts)}</small></div>
        <div class="preview">${c.last.dir === 'out' ? 'Tú: ' : ''}${esc(c.last.text)}</div>
      </div>
      ${c.unread ? `<span class="pill">${c.unread}</span>` : ''}
    </div>`).join('') : `<div class="empty">Aún no hay conversaciones.</div>`;
}
$('#chatList').onclick = (e) => {
  const it = e.target.closest('.chat-item');
  if (it) openChat(it.dataset.phone);
};
$('#chatBack').onclick = () => { openPhone = null; $('#chatsBox').classList.remove('open'); renderChatList(); };

async function openChat(phone) {
  openPhone = phone;
  $('#chatsBox').classList.add('open');
  const contact = contacts.find((c) => c.phone === phone);
  const chat = chats.find((c) => c.phone === phone);
  const name = contact?.name || chat?.name || '+' + phone;
  $('#chatName').textContent = name;
  $('#chatPhone').textContent = '+' + phone;
  $('#chatAvatar').textContent = initials(name);
  $('#chatSaveContact').hidden = !!contact;
  $('#composer').hidden = false;
  const msgs = await api('/api/chats/' + phone);
  $('#msgs').innerHTML = msgs.length ? '' : '<div class="empty">Sin mensajes. Escribe el primero abajo.</div>';
  msgs.forEach(appendMsg);
  await loadChats();
  $('#composerText').focus();
}
function appendMsg(m) {
  const box = $('#msgs');
  box.querySelector('.empty')?.remove();
  const d = document.createElement('div');
  d.className = 'msg ' + m.dir;
  d.id = 'm-' + m.id;
  d.innerHTML = `${esc(m.text)}<div class="meta">${fmtTime(m.ts)}${m.dir === 'out' ? ' · <span class="st">' + esc(m.status || '') + '</span>' : ''}</div>`;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
$('#chatSaveContact').onclick = async () => {
  const chat = chats.find((c) => c.phone === openPhone);
  const name = prompt('Nombre del contacto:', chat?.pushName || '');
  if (name === null) return;
  try { await api('/api/contacts', { body: { name, phone: openPhone } }); toast('Contacto guardado'); await loadContacts(); openChat(openPhone); }
  catch (er) { toast(er.message); }
};
$('#composer').onsubmit = async (e) => {
  e.preventDefault();
  const text = $('#composerText').value.trim();
  if (!text || !openPhone) return;
  $('#composerText').value = '';
  try { await api('/api/send', { body: { phone: openPhone, text } }); }
  catch (er) { toast(er.message); $('#composerText').value = text; }
};
$('#composerText').onkeydown = (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); $('#composer').requestSubmit(); }
};

socket.on('message', (m) => {
  if (m.phone === openPhone && $('#tab-chats').classList.contains('active')) {
    appendMsg(m);
    if (m.dir === 'in') api('/api/chats/' + m.phone); // marcar leído
  }
  if (m.dir === 'in') {
    const c = contacts.find((x) => x.phone === m.phone);
    toast('💬 ' + (c?.name || m.pushName || '+' + m.phone) + ': ' + m.text.slice(0, 60));
  }
  setTimeout(loadChats, 150);
});
socket.on('message-status', ({ id, status }) => {
  const st = document.querySelector('#m-' + id + ' .st');
  if (st) st.textContent = status;
});

// ---------- Envío masivo ----------
function renderPick() {
  const q = $('#pickSearch').value.toLowerCase();
  const list = contacts.filter((c) => !q || (c.name + ' ' + c.tags + ' ' + c.phone).toLowerCase().includes(q));
  $('#pickList').innerHTML = list.length ? list.map((c) => `
    <label><input type="checkbox" value="${c.id}" ${selected.has(c.id) ? 'checked' : ''}>
    <span style="flex:1">${esc(c.name)} <span class="hint" style="font-size:12px">+${esc(c.phone)}</span></span>
    ${c.tags ? `<span class="tag">${esc(c.tags)}</span>` : ''}</label>`).join('')
    : '<div class="empty">No hay contactos. Agrégalos en la pestaña Contactos.</div>';
  selected = new Set([...selected].filter((id) => contacts.some((c) => c.id === id)));
  $('#pickCount').textContent = selected.size;
  renderPreview();
}
$('#pickSearch').oninput = renderPick;
$('#pickList').onchange = (e) => {
  if (e.target.checked) selected.add(e.target.value); else selected.delete(e.target.value);
  $('#pickCount').textContent = selected.size;
  renderPreview();
};
const visiblePicks = () => [...document.querySelectorAll('#pickList input')].map((i) => i.value);
$('#pickAll').onclick = () => { visiblePicks().forEach((id) => selected.add(id)); renderPick(); };
$('#pickNone').onclick = () => { visiblePicks().forEach((id) => selected.delete(id)); renderPick(); };

function renderPreview() {
  const c = contacts.find((x) => selected.has(x.id)) || contacts[0] || { name: 'María Pérez', phone: '56900000000' };
  const t = $('#bulkText').value || '…';
  $('#bulkPreview').textContent = t.replace(/\{nombre\}/gi, c.name).replace(/\{primer_nombre\}/gi, c.name.split(' ')[0]).replace(/\{numero\}/gi, c.phone);
}
$('#bulkText').oninput = renderPreview;

$('#bulkStart').onclick = async () => {
  const text = $('#bulkText').value.trim();
  if (!selected.size) return toast('Selecciona destinatarios');
  if (!text) return toast('Escribe el mensaje');
  if (!confirm(`¿Enviar este mensaje a ${selected.size} persona(s)?`)) return;
  try {
    await api('/api/campaign', { body: { contactIds: [...selected], text, minDelay: $('#minDelay').value, maxDelay: $('#maxDelay').value } });
  } catch (er) { toast(er.message); }
};
$('#bulkCancel').onclick = () => api('/api/campaign/cancel', { body: {} });

let countdown = null;
socket.on('campaign', (c) => {
  if (!c) return;
  $('#campaignCard').hidden = false;
  const done = c.sent + c.failed;
  $('#campaignBar').style.width = (done / c.total * 100) + '%';
  $('#campaignTitle').textContent = c.running ? `Enviando… ${done}/${c.total}` : `Envío terminado: ${c.sent} enviados, ${c.failed} con error`;
  $('#bulkCancel').hidden = !c.running;
  $('#bulkStart').disabled = c.running;
  clearInterval(countdown);
  const info = () => {
    if (!c.running) return ($('#campaignInfo').textContent = '');
    const secs = c.nextAt ? Math.max(0, Math.round((c.nextAt - Date.now()) / 1000)) : 0;
    $('#campaignInfo').textContent = c.nextAt ? `Siguiente mensaje en ${secs} s` : `Enviando a ${c.current}…`;
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
      <div class="hint">Ábrela en cualquier teléfono o PC y entra con tu contraseña. Funciona 24/7, aunque tu computador esté apagado.</div></div>`;
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
      <div>Funciona con datos móviles y desde cualquier PC. <b>La dirección cambia cada vez que abres IsiSender</b>: vuelve a mirarla aquí.</div>`
      : n.enabled ? '<div style="margin-top:8px">Generando dirección…</div>'
      : '<div style="margin-top:8px">Apagado. Al activarlo se crea una dirección segura (https) para entrar desde fuera de tu casa u oficina.</div>'}
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
      <button class="btn sm" data-copy="${esc(l.url)}">Copiar</button>
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
  try { await navigator.clipboard.writeText(t); toast('Enlace copiado. Pégalo en WhatsApp o correo a tu cliente.'); }
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
  $('#loginHint').innerHTML = hasPassword ? 'Ingresa tu contraseña.'
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
  if (authMode === 'setup' && password !== $('#loginPass2').value) return ($('#loginErr').textContent = 'Las contraseñas no coinciden');
  try {
    await api(authMode === 'setup' ? '/api/auth/setup' : '/api/auth/login', { body: { password } });
    $('#loginPass').value = $('#loginPass2').value = '';
    start(true);
  } catch (er) { $('#loginErr').textContent = er.message; }
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
  loadContacts();
  loadChats();
}
async function boot() {
  const st = await api('/api/auth/state');
  if (st.loggedIn) start(st.admin); else showLogin(st.hasPassword);
}
boot();
