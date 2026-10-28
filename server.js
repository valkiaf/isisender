// IsiSender - CRM para WhatsApp (vinculado a WhatsApp Web como dispositivo)
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import crypto from 'crypto';
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { Server } from 'socket.io';
import QRCode from 'qrcode';
import pino from 'pino';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  Browsers,
} from 'baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
// En la nube (Railway, Render, Fly…) la app ya tiene su propia dirección pública
const PUBLIC_URL = process.env.PUBLIC_URL
  || (process.env.FLY_APP_NAME ? `https://${process.env.FLY_APP_NAME}.fly.dev` : null)
  || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : process.env.RENDER_EXTERNAL_URL || null);
const IS_CLOUD = !!(PUBLIC_URL || process.env.RAILWAY_ENVIRONMENT || process.env.RENDER || process.env.FLY_APP_NAME);
// Minutos sin uso antes de apagarse solo (0 = nunca). El hosting lo vuelve a encender al abrir el enlace.
const IDLE_MINUTES = Number(process.env.IDLE_MINUTES || 0);
// Contraseña fija definida en el servidor (recomendado en la nube)
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || null;
const AUTH_DIR = path.join(DATA_DIR, 'sesion-whatsapp');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Base de datos (archivo JSON) ----------
let db = { contacts: [], messages: [], jids: {}, settings: {} };
try {
  db = { ...db, ...JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) };
} catch {}
let saveTimer = null;
function writeDb() {
  clearTimeout(saveTimer);
  fs.writeFileSync(DB_FILE + '.tmp', JSON.stringify(db, null, 1));
  fs.renameSync(DB_FILE + '.tmp', DB_FILE);
}
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDb, 300);
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const onlyDigits = (s) => String(s || '').replace(/\D/g, '');

// ---------- Servidor web ----------
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server);
app.use(express.json({ limit: '2mb' }));
let lastActivity = Date.now();
app.use((req, res, next) => { lastActivity = Date.now(); next(); });
// Enlace de acceso directo: https://…/?k=CLAVE inicia sesión sin contraseña
app.get('/', (req, res, next) => {
  const k = String(req.query.k || '');
  const link = k && db.settings.links.find((l) => l.key === k);
  if (!k) return next();
  if (!link) return res.status(403).send('<meta name="viewport" content="width=device-width"><p style="font-family:sans-serif;padding:24px">Este enlace de IsiSender ya no es válido. Pide uno nuevo.</p>');
  link.lastUsed = Date.now();
  issueToken(req, res, link.key);
  res.redirect('/');
});
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Acceso con contraseña (para entrar desde el teléfono u otro PC) ----------
db.settings.tokens ||= [];
db.settings.links ||= [];        // enlaces de acceso directo [{key, label, createdAt, lastUsed}]
db.settings.linkSessions ||= {}; // sesión -> enlace con que se abrió
const hashPass = (pass, salt) => crypto.scryptSync(String(pass), salt, 32).toString('hex');
const getToken = (cookieHeader) => (String(cookieHeader || '').match(/(?:^|;\s*)isi=([a-f0-9]+)/) || [])[1];
const isAuthed = (cookieHeader) => {
  const t = getToken(cookieHeader);
  return !!t && db.settings.tokens.includes(t);
};
const isAdmin = (cookieHeader) => isAuthed(cookieHeader) && !db.settings.linkSessions[getToken(cookieHeader)];
function issueToken(req, res, linkKey) {
  const t = crypto.randomBytes(24).toString('hex');
  db.settings.tokens = [...db.settings.tokens.slice(-199), t];
  if (linkKey) db.settings.linkSessions[t] = linkKey;
  save();
  res.setHeader('Set-Cookie', `isi=${t}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${req.secure ? '; Secure' : ''}`);
}
let failCount = 0, lockedUntil = 0;

app.get('/api/auth/state', (req, res) => {
  res.json({ hasPassword: !!(ADMIN_PASSWORD || db.settings.passHash), loggedIn: isAuthed(req.headers.cookie), admin: isAdmin(req.headers.cookie) });
});
app.post('/api/auth/setup', (req, res) => {
  if (ADMIN_PASSWORD || db.settings.passHash) return res.status(400).json({ error: 'La contraseña ya existe' });
  const pass = String(req.body.password || '');
  if (pass.length < 6) return res.status(400).json({ error: 'Usa al menos 6 caracteres' });
  db.settings.passSalt = crypto.randomBytes(16).toString('hex');
  db.settings.passHash = hashPass(pass, db.settings.passSalt);
  issueToken(req, res);
  res.json({ ok: true });
});
app.post('/api/auth/login', (req, res) => {
  if (Date.now() < lockedUntil) return res.status(429).json({ error: 'Demasiados intentos. Espera un minuto.' });
  const given = String(req.body.password || '');
  const ok = ADMIN_PASSWORD
    ? crypto.timingSafeEqual(crypto.createHash('sha256').update(given).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest())
    : db.settings.passHash && crypto.timingSafeEqual(
      Buffer.from(hashPass(given, db.settings.passSalt), 'hex'),
      Buffer.from(db.settings.passHash, 'hex'));
  if (!ok) {
    if (++failCount >= 5) { lockedUntil = Date.now() + 60000; failCount = 0; }
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }
  failCount = 0;
  issueToken(req, res);
  res.json({ ok: true });
});
app.post('/api/auth/logout', (req, res) => {
  const t = getToken(req.headers.cookie);
  db.settings.tokens = db.settings.tokens.filter((x) => x !== t);
  delete db.settings.linkSessions[t];
  save();
  res.setHeader('Set-Cookie', 'isi=; Path=/; Max-Age=0');
  res.json({ ok: true });
});
// Todo lo demás de la API requiere sesión iniciada
app.use('/api', (req, res, next) => (isAuthed(req.headers.cookie) ? next() : res.status(401).json({ error: 'Inicia sesión' })));

// ---------- Enlaces de acceso directo (solo quien entró con contraseña los administra) ----------
const onlyAdmin = (req, res, next) => (isAdmin(req.headers.cookie) ? next() : res.status(403).json({ error: 'Solo el administrador puede hacer esto' }));
const baseUrl = (req) => PUBLIC_URL || tunnel.url || `${req.protocol}://${req.get('host')}`;
const linkView = (req, l) => ({ ...l, url: `${baseUrl(req)}/?k=${l.key}` });
app.get('/api/links', onlyAdmin, (req, res) => res.json(db.settings.links.map((l) => linkView(req, l))));
app.post('/api/links', onlyAdmin, (req, res) => {
  const l = { key: crypto.randomBytes(18).toString('base64url'), label: String(req.body.label || '').trim() || 'Cliente', createdAt: Date.now(), lastUsed: null };
  db.settings.links.push(l);
  save();
  res.json(linkView(req, l));
});
app.delete('/api/links/:key', onlyAdmin, (req, res) => {
  const key = req.params.key;
  db.settings.links = db.settings.links.filter((l) => l.key !== key);
  // Cierra también las sesiones abiertas con ese enlace
  for (const [t, k] of Object.entries(db.settings.linkSessions)) {
    if (k === key) { delete db.settings.linkSessions[t]; db.settings.tokens = db.settings.tokens.filter((x) => x !== t); }
  }
  save();
  for (const s of io.sockets.sockets.values()) if (!isAuthed(s.handshake.headers.cookie)) s.disconnect(true);
  res.json({ ok: true });
});
io.use((s, next) => (isAuthed(s.handshake.headers.cookie) ? next() : next(new Error('auth'))));

// ---------- Direcciones para abrir IsiSender desde otros equipos ----------
const CLOUDFLARED = path.join(__dirname, 'runtime', 'bin', 'cloudflared');
let tunnel = { proc: null, url: null, starting: false, error: null };

function lanUrls() {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family === 'IPv4' && !i.internal) urls.push(`http://${i.address}:${PORT}`);
    }
  }
  return urls;
}
async function accessInfo() {
  if (IS_CLOUD) {
    return { cloud: true, url: PUBLIC_URL, qr: PUBLIC_URL ? await QRCode.toDataURL(PUBLIC_URL, { margin: 1, width: 220 }) : null };
  }
  const lan = lanUrls();
  const out = {
    lan,
    lanQr: lan[0] ? await QRCode.toDataURL(lan[0], { margin: 1, width: 220 }) : null,
    internet: {
      available: fs.existsSync(CLOUDFLARED),
      enabled: !!db.settings.tunnel,
      starting: tunnel.starting,
      url: tunnel.url,
      error: tunnel.error,
      qr: tunnel.url ? await QRCode.toDataURL(tunnel.url, { margin: 1, width: 220 }) : null,
    },
  };
  return out;
}
const emitAccess = async () => io.emit('access', await accessInfo());

function startTunnel() {
  if (tunnel.proc || !fs.existsSync(CLOUDFLARED)) return;
  tunnel = { proc: null, url: null, starting: true, error: null };
  const p = spawn(CLOUDFLARED, ['tunnel', '--no-autoupdate', '--url', `http://localhost:${PORT}`]);
  tunnel.proc = p;
  const onData = (buf) => {
    const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !tunnel.url) {
      tunnel.url = m[0];
      tunnel.starting = false;
      console.log('  Acceso desde internet: ' + tunnel.url + '\n');
      emitAccess();
    }
  };
  p.stdout.on('data', onData);
  p.stderr.on('data', onData);
  p.on('exit', () => {
    const wasWanted = db.settings.tunnel && tunnel.proc === p;
    tunnel = { proc: null, url: null, starting: false, error: wasWanted ? 'El acceso por internet se cortó; reintentando…' : null };
    emitAccess();
    if (wasWanted) setTimeout(startTunnel, 5000);
  });
  emitAccess();
}
function stopTunnel() {
  const p = tunnel.proc;
  tunnel = { proc: null, url: null, starting: false, error: null };
  p?.kill();
  emitAccess();
}
process.on('exit', () => tunnel.proc?.kill());
process.on('SIGINT', () => process.exit());
process.on('SIGTERM', () => process.exit());
process.on('SIGHUP', () => process.exit());

app.get('/api/access', async (req, res) => res.json(await accessInfo()));
app.post('/api/access/internet', (req, res) => {
  db.settings.tunnel = !!req.body.enabled;
  save();
  if (db.settings.tunnel && !IS_CLOUD) startTunnel(); else stopTunnel();
  res.json({ ok: true });
});

// ---------- WhatsApp ----------
let sock = null;
let wa = { status: 'desconectado', me: null, qr: null, pairingCode: null, error: null };
let pairingPhone = null;
let pairingRequested = false;

function setStatus(patch) {
  wa = { ...wa, ...patch };
  io.emit('status', wa);
}

async function connectWhatsApp(phone) {
  if (sock) {
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  pairingPhone = phone || null;
  pairingRequested = false;
  setStatus({ status: 'conectando', qr: null, pairingCode: null, error: null });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try { ({ version } = await fetchLatestBaileysVersion()); } catch {}

  sock = makeWASocket({
    version,
    auth: state,
    logger: pino({ level: 'silent' }),
    browser: Browsers.macOS('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });
  const current = sock;

  current.ev.on('creds.update', saveCreds);

  current.ev.on('connection.update', async ({ connection, lastDisconnect, qr }) => {
    if (current !== sock) return;
    if (qr) {
      if (pairingPhone && !pairingRequested && !state.creds.registered) {
        pairingRequested = true;
        try {
          const code = await current.requestPairingCode(pairingPhone);
          setStatus({ status: 'esperando-codigo', pairingCode: code.match(/.{1,4}/g).join('-') });
        } catch (e) {
          setStatus({ status: 'error', error: 'No se pudo generar el código: ' + e.message });
        }
      } else if (!pairingPhone) {
        setStatus({ status: 'esperando-qr', qr: await QRCode.toDataURL(qr) });
      }
    }
    if (connection === 'open') {
      const meId = current.user?.id || '';
      setStatus({
        status: 'conectado',
        me: { phone: meId.split('@')[0].split(':')[0], name: current.user?.name || '' },
        qr: null,
        pairingCode: null,
        error: null,
      });
      db.settings.linked = true;
      save();
    }
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      if (code === DisconnectReason.loggedOut) {
        fs.rmSync(AUTH_DIR, { recursive: true, force: true });
        db.settings.linked = false;
        save();
        sock = null;
        setStatus({ status: 'desconectado', me: null, qr: null, pairingCode: null,
          error: 'La sesión se cerró desde el teléfono. Vuelve a vincular.' });
      } else {
        // Reconexión normal (incluye el reinicio que pide WhatsApp tras vincular)
        setStatus({ status: 'conectando' });
        setTimeout(() => current === sock && connectWhatsApp(state.creds.me ? null : pairingPhone), 2000);
      }
    }
  });

  current.ev.on('messages.upsert', async ({ messages }) => {
    for (const m of messages) {
      try { await handleIncoming(m); } catch (e) { console.error('Error procesando mensaje', e.message); }
    }
  });

  current.ev.on('messages.update', (updates) => {
    for (const { key, update } of updates) {
      if (update?.status == null) continue;
      const msg = db.messages.find((x) => x.waId === key.id);
      if (msg) {
        msg.status = ['error', 'pendiente', 'enviado', 'entregado', 'leído', 'reproducido'][update.status] || msg.status;
        io.emit('message-status', { id: msg.id, status: msg.status });
        save();
      }
    }
  });
}

function extractText(message) {
  let m = message;
  if (!m) return null;
  m = m.ephemeralMessage?.message || m.viewOnceMessageV2?.message || m.viewOnceMessage?.message || m.documentWithCaptionMessage?.message || m;
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  if (m.imageMessage) return '📷 Imagen' + (m.imageMessage.caption ? ': ' + m.imageMessage.caption : '');
  if (m.videoMessage) return '🎥 Video' + (m.videoMessage.caption ? ': ' + m.videoMessage.caption : '');
  if (m.audioMessage) return '🎤 Audio';
  if (m.documentMessage) return '📄 Documento: ' + (m.documentMessage.fileName || '');
  if (m.stickerMessage) return '🏷️ Sticker';
  if (m.locationMessage) return '📍 Ubicación';
  if (m.contactMessage) return '👤 Contacto: ' + (m.contactMessage.displayName || '');
  if (m.buttonsResponseMessage) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage) return m.listResponseMessage.title;
  return null;
}

async function phoneFromKey(key) {
  const candidates = [key.remoteJidAlt, key.senderPn, key.remoteJid].filter(Boolean);
  const pn = candidates.find((j) => j.endsWith('@s.whatsapp.net'));
  if (pn) return pn.split('@')[0].split(':')[0];
  if (key.remoteJid?.endsWith('@lid')) {
    try {
      const mapped = await sock.signalRepository?.lidMapping?.getPNForLID(key.remoteJid);
      if (mapped) return mapped.split('@')[0].split(':')[0];
    } catch {}
    return key.remoteJid.split('@')[0];
  }
  return null;
}

async function handleIncoming(m) {
  const jid = m.key?.remoteJid;
  if (!jid || jid.endsWith('@g.us') || jid === 'status@broadcast' || jid.endsWith('@newsletter') || jid.endsWith('@broadcast')) return;
  if (db.messages.some((x) => x.waId === m.key.id)) return;
  const text = extractText(m.message);
  if (!text) return;
  const phone = await phoneFromKey(m.key);
  if (!phone) return;
  db.jids[phone] = jid;
  const msg = {
    id: uid(),
    waId: m.key.id,
    phone,
    dir: m.key.fromMe ? 'out' : 'in',
    text,
    ts: Number(m.messageTimestamp) * 1000 || Date.now(),
    pushName: m.key.fromMe ? undefined : m.pushName,
    read: !!m.key.fromMe,
    status: m.key.fromMe ? 'enviado' : undefined,
  };
  db.messages.push(msg);
  save();
  io.emit('message', msg);
}

async function sendText(phone, text) {
  if (!sock || wa.status !== 'conectado') throw new Error('WhatsApp no está conectado');
  phone = onlyDigits(phone);
  let jid = db.jids[phone];
  if (!jid) {
    const [r] = await sock.onWhatsApp(phone);
    if (!r?.exists) throw new Error('El número ' + phone + ' no tiene WhatsApp');
    jid = r.jid;
    db.jids[phone] = jid;
  }
  const sent = await sock.sendMessage(jid, { text });
  let msg = db.messages.find((x) => x.waId === sent.key.id);
  if (!msg) {
    msg = { id: uid(), waId: sent.key.id, phone, dir: 'out', text, ts: Date.now(), read: true, status: 'enviado' };
    db.messages.push(msg);
    io.emit('message', msg);
  }
  save();
  return msg;
}

// ---------- API: conexión ----------
app.get('/api/status', (req, res) => res.json(wa));

app.post('/api/connect', async (req, res) => {
  const phone = onlyDigits(req.body.phone);
  if (req.body.method !== 'qr' && phone.length < 8) {
    return res.status(400).json({ error: 'Escribe tu número con código de país (ej: 56912345678)' });
  }
  // Si se vincula un número nuevo, se parte de una sesión limpia
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  connectWhatsApp(req.body.method === 'qr' ? null : phone).catch((e) => setStatus({ status: 'error', error: e.message }));
  res.json({ ok: true });
});

app.post('/api/logout', async (req, res) => {
  try { await sock?.logout(); } catch {}
  try { sock?.end(undefined); } catch {}
  sock = null;
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  db.settings.linked = false;
  save();
  setStatus({ status: 'desconectado', me: null, qr: null, pairingCode: null, error: null });
  res.json({ ok: true });
});

// ---------- API: contactos ----------
app.get('/api/contacts', (req, res) => res.json(db.contacts));

app.post('/api/contacts', (req, res) => {
  const phone = onlyDigits(req.body.phone);
  if (phone.length < 8) return res.status(400).json({ error: 'Número inválido. Usa código de país (ej: 56912345678)' });
  if (db.contacts.some((c) => c.phone === phone)) return res.status(400).json({ error: 'Ese número ya existe' });
  const c = { id: uid(), name: (req.body.name || '').trim() || phone, phone, tags: (req.body.tags || '').trim(), notes: (req.body.notes || '').trim(), createdAt: Date.now() };
  db.contacts.push(c);
  save();
  res.json(c);
});

app.put('/api/contacts/:id', (req, res) => {
  const c = db.contacts.find((x) => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: 'No existe' });
  const phone = req.body.phone != null ? onlyDigits(req.body.phone) : c.phone;
  if (phone.length < 8) return res.status(400).json({ error: 'Número inválido' });
  if (db.contacts.some((x) => x.phone === phone && x.id !== c.id)) return res.status(400).json({ error: 'Ese número ya existe' });
  Object.assign(c, {
    name: (req.body.name ?? c.name).trim() || phone,
    phone,
    tags: (req.body.tags ?? c.tags).trim(),
    notes: (req.body.notes ?? c.notes).trim(),
  });
  save();
  res.json(c);
});

app.delete('/api/contacts/:id', (req, res) => {
  db.contacts = db.contacts.filter((x) => x.id !== req.params.id);
  save();
  res.json({ ok: true });
});

// Importar: una línea por contacto "Nombre, Número" (o solo número)
app.post('/api/contacts/import', (req, res) => {
  const lines = String(req.body.text || '').split(/\r?\n/);
  let added = 0, skipped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const parts = line.split(/[,;\t]/).map((s) => s.trim());
    const phoneIdx = parts.findIndex((p) => onlyDigits(p).length >= 8);
    if (phoneIdx < 0) { skipped++; continue; }
    const phone = onlyDigits(parts[phoneIdx]);
    if (db.contacts.some((c) => c.phone === phone)) { skipped++; continue; }
    const name = parts.filter((_, i) => i !== phoneIdx)[0] || phone;
    const tags = parts.filter((_, i) => i !== phoneIdx)[1] || '';
    db.contacts.push({ id: uid(), name, phone, tags, notes: '', createdAt: Date.now() });
    added++;
  }
  save();
  res.json({ added, skipped });
});

// ---------- API: chats ----------
app.get('/api/chats', (req, res) => {
  const map = new Map();
  for (const m of db.messages) {
    const c = map.get(m.phone) || { phone: m.phone, unread: 0, last: null, pushName: null };
    if (!c.last || m.ts >= c.last.ts) c.last = m;
    if (m.dir === 'in' && !m.read) c.unread++;
    if (m.pushName) c.pushName = m.pushName;
    map.set(m.phone, c);
  }
  const chats = [...map.values()].map((c) => {
    const contact = db.contacts.find((x) => x.phone === c.phone);
    return { ...c, name: contact?.name || c.pushName || '+' + c.phone, contactId: contact?.id || null };
  });
  chats.sort((a, b) => b.last.ts - a.last.ts);
  res.json(chats);
});

app.get('/api/chats/:phone', (req, res) => {
  const phone = onlyDigits(req.params.phone);
  const msgs = db.messages.filter((m) => m.phone === phone).sort((a, b) => a.ts - b.ts);
  let changed = false;
  for (const m of msgs) if (m.dir === 'in' && !m.read) { m.read = true; changed = true; }
  if (changed) save();
  res.json(msgs);
});

app.post('/api/send', async (req, res) => {
  const text = String(req.body.text || '').trim();
  if (!text) return res.status(400).json({ error: 'El mensaje está vacío' });
  try {
    res.json(await sendText(req.body.phone, text));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- API: envío masivo ----------
let campaign = null;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fillTemplate = (t, c) => t
  .replace(/\{nombre\}/gi, c.name)
  .replace(/\{primer_nombre\}/gi, c.name.split(' ')[0])
  .replace(/\{numero\}/gi, c.phone);

app.get('/api/campaign', (req, res) => res.json(campaign));

app.post('/api/campaign', (req, res) => {
  if (campaign?.running) return res.status(400).json({ error: 'Ya hay un envío en curso' });
  if (wa.status !== 'conectado') return res.status(400).json({ error: 'Conecta WhatsApp primero' });
  const text = String(req.body.text || '').trim();
  const ids = new Set(req.body.contactIds || []);
  const list = db.contacts.filter((c) => ids.has(c.id));
  if (!text) return res.status(400).json({ error: 'Escribe el mensaje' });
  if (!list.length) return res.status(400).json({ error: 'Selecciona al menos un contacto' });
  const minDelay = Math.max(3, Number(req.body.minDelay) || 8);
  const maxDelay = Math.max(minDelay, Number(req.body.maxDelay) || 20);

  campaign = { running: true, total: list.length, sent: 0, failed: 0, current: null, nextAt: null, log: [], startedAt: Date.now() };
  io.emit('campaign', campaign);
  res.json(campaign);

  (async () => {
    for (let i = 0; i < list.length; i++) {
      if (!campaign.running) break;
      const c = list[i];
      campaign.current = c.name;
      campaign.nextAt = null;
      io.emit('campaign', campaign);
      try {
        await sendText(c.phone, fillTemplate(text, c));
        campaign.sent++;
        campaign.log.unshift({ name: c.name, phone: c.phone, ok: true, ts: Date.now() });
      } catch (e) {
        campaign.failed++;
        campaign.log.unshift({ name: c.name, phone: c.phone, ok: false, error: e.message, ts: Date.now() });
      }
      if (i < list.length - 1 && campaign.running) {
        const wait = (minDelay + Math.random() * (maxDelay - minDelay)) * 1000;
        campaign.nextAt = Date.now() + wait;
        io.emit('campaign', campaign);
        const end = Date.now() + wait;
        while (Date.now() < end && campaign.running) await sleep(250);
      }
    }
    campaign.running = false;
    campaign.current = null;
    campaign.nextAt = null;
    campaign.finishedAt = Date.now();
    io.emit('campaign', campaign);
  })();
});

app.post('/api/campaign/cancel', (req, res) => {
  if (campaign) campaign.running = false;
  io.emit('campaign', campaign);
  res.json({ ok: true });
});

io.on('connection', async (s) => {
  s.emit('status', wa);
  s.emit('access', await accessInfo());
  if (campaign) s.emit('campaign', campaign);
});

// ---------- Apagado automático por inactividad ----------
// Se apaga solo si: nadie tiene IsiSender abierto, no hay envío masivo en curso,
// no se está vinculando WhatsApp y pasaron IDLE_MINUTES desde la última actividad.
if (IDLE_MINUTES > 0) {
  setInterval(() => {
    if (io.engine.clientsCount > 0) { lastActivity = Date.now(); return; }
    if (campaign?.running || ['esperando-codigo', 'esperando-qr'].includes(wa.status)) { lastActivity = Date.now(); return; }
    if (Date.now() - lastActivity < IDLE_MINUTES * 60000) return;
    console.log('  Sin uso por ' + IDLE_MINUTES + ' min: apagando hasta la próxima visita.');
    try { sock?.end(undefined); } catch {}
    try { writeDb(); } catch {}
    setTimeout(() => process.exit(0), 1500);
  }, 30000);
}

server.listen(PORT, () => {
  console.log(`\n  IsiSender listo en  http://localhost:${PORT}`);
  if (!IS_CLOUD) for (const u of lanUrls()) console.log(`  Desde el teléfono (misma Wi-Fi):  ${u}`);
  console.log('  (deja esta ventana abierta mientras lo usas)\n');
  if (db.settings.tunnel) startTunnel();
  // Si ya había una sesión vinculada, reconecta sola
  if (fs.existsSync(path.join(AUTH_DIR, 'creds.json'))) {
    connectWhatsApp(null).catch((e) => setStatus({ status: 'error', error: e.message }));
  }
});
