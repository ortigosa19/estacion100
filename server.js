// server.js — sesión única + APIs Weather.com (WU) + lluvia YTD por meses
// Node >=18 (fetch nativo). Listo para Railway.

// Carga variables locales; Railway proporciona las suyas directamente.
require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
app.set('trust proxy', 1);

/* ============ CORS ============ */
const ALLOWED = (process.env.CORS_ORIGINS || '')
  .split(',')
  .map(s => s.trim().replace(/\/+$/, ''))
  .filter(Boolean);

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);
    if (ALLOWED.length === 0) return cb(null, true);
    const ok = ALLOWED.includes(origin.replace(/\/+$/, ''));
    cb(ok ? null : new Error('Not allowed by CORS'), ok);
  },
  credentials: true
}));
app.options('*', cors());
app.use((req,res,next)=>{ res.header('Vary','Origin'); next(); });

/* ============ Carpetas ============ */
const DB_DIR = path.join(__dirname, 'db');
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });

/* ============ Body + estáticos ============ */
app.use(express.urlencoded({ extended: true }));
app.use(express.json({ limit: '12mb' }));


/* ============ Usuarios, sesiones y administración ============ */
const session = require('express-session');
const crypto = require('crypto');
const USERS_FILE = path.join(DB_DIR, 'usuarios.json');
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');

function loadUsers() {
  try {
    const data = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
    return Array.isArray(data) ? data : [];
  } catch { return []; }
}
function saveUsers(users) {
  const tmp = USERS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(users, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, USERS_FILE);
}
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makePassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  return { salt, passwordHash: hashPassword(password, salt) };
}
function validPassword(user, password) {
  if (!user || !user.salt || !user.passwordHash) return false;
  const actual = Buffer.from(hashPassword(password, user.salt), 'hex');
  const expected = Buffer.from(user.passwordHash, 'hex');
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function ensureAdmin() {
  const users = loadUsers();
  if (!users.some(u => u.username.toLowerCase() === 'admin')) {
    const password = process.env.ADMIN_PASSWORD || '1234';
    users.push({ username: 'admin', role: 'admin', ...makePassword(password), activeSession: null, createdAt: new Date().toISOString() });
    saveUsers(users);
    console.log('Usuario administrador inicial creado: admin. Cambia ADMIN_PASSWORD en el entorno antes de publicar si deseas otra clave.');
  }
}
ensureAdmin();

app.use(session({
  name: 'alfarnate.sid',
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: (process.env.NODE_ENV === 'production' && process.env.COOKIE_SAMESITE === 'none') ? 'none' : 'lax',
    secure: process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== 'false',
  }
}));

function currentUser(req) {
  if (!req.session || !req.session.user) return null;
  const users = loadUsers();
  const user = users.find(u => u.username === req.session.user.username);
  if (!user || user.activeSession !== req.sessionID) return null;
  return { username: user.username, role: user.role };
}
function requireLogin(req, res, next) {
  const user = currentUser(req);
  if (!user) {
    if (req.path.startsWith('/api/')) return res.status(401).json({ error: 'no_session', redirect: '/login.html' });
    return res.redirect('/login.html');
  }
  req.user = user;
  next();
}
function requireAdmin(req, res, next) {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: 'no_session' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'admin_only' });
  req.user = user;
  next();
}

// Las rutas de autenticación y el agente meteorológico siguen disponibles sin sesión.
app.use((req, res, next) => {
  const p = req.path;
  if (p === '/admin.html') return requireAdmin(req, res, next);
  if (p === '/login.html' || p === '/api/auth/login' || p === '/api/auth/logout' ||
      p === '/api/auth/me' || p === '/health' || p === '/salud' ||
      p === '/api/cumulus/lluvia' || p === '/api/cumulus/test' ||
      p === '/api/cumulus/historial' ||
      p.startsWith('/assets/') || p === '/favicon.ico') return next();
  return requireLogin(req, res, next);
});
app.use(express.static(PUBLIC_DIR));

app.post('/api/auth/login', (req, res, next) => {
  const username = String(req.body?.username || req.body?.usuario || '').trim();
  const users = loadUsers();
  const user = users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user) return res.status(401).json({ error: 'user_not_found', detalle: 'Ese usuario no está registrado.' });
  // Regenerar la sesión y revocar cualquier sesión anterior del mismo usuario.
  req.session.regenerate(err => {
    if (err) return next(err);
    const latest = loadUsers();
    const index = latest.findIndex(u => u.username === user.username);
    if (index < 0) return res.status(401).json({ error: 'user_missing' });
    latest[index].activeSession = req.sessionID;
    saveUsers(latest);
    req.session.user = { username: user.username, role: user.role };
    req.session.save(err2 => {
      if (err2) return next(err2);
      res.json({ ok: true, user: { username: user.username, role: user.role }, redirect: user.role === 'admin' ? '/admin.html' : '/inicio' });
    });
  });
});

app.post('/api/auth/logout', (req, res) => {
  const username = req.session?.user?.username;
  if (username) {
    const users = loadUsers();
    const user = users.find(u => u.username === username);
    if (user && user.activeSession === req.sessionID) { user.activeSession = null; saveUsers(users); }
  }
  req.session.destroy(() => {
    res.clearCookie('alfarnate.sid');
    res.json({ ok: true, redirect: '/login.html' });
  });
});

app.get('/api/auth/me', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, user });
});

app.get('/api/admin/users', requireAdmin, (_req, res) => {
  res.json({ users: loadUsers().map(u => ({ username: u.username, role: u.role, createdAt: u.createdAt })) });
});
app.post('/api/admin/users', requireAdmin, (req, res) => {
  const username = String(req.body?.username || '').trim();
  const role = req.body?.role === 'admin' ? 'admin' : 'user';
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(username)) return res.status(400).json({ error: 'username_invalid', detalle: 'El usuario debe tener 3-32 caracteres: letras, números, punto, guion o guion bajo.' });
  const users = loadUsers();
  if (users.some(u => u.username.toLowerCase() === username.toLowerCase())) return res.status(409).json({ error: 'user_exists' });
  // Se conserva un hash aleatorio solo por compatibilidad con el formato de usuarios anterior.
  users.push({ username, role, ...makePassword(crypto.randomBytes(32).toString('hex')), activeSession: null, createdAt: new Date().toISOString() });
  saveUsers(users);
  res.status(201).json({ ok: true });
});
app.delete('/api/admin/users/:username', requireAdmin, (req, res) => {
  const target = decodeURIComponent(req.params.username);
  if (target.toLowerCase() === 'admin' || target === req.user.username) return res.status(400).json({ error: 'cannot_delete_account' });
  const users = loadUsers();
  const nextUsers = users.filter(u => u.username !== target);
  if (nextUsers.length === users.length) return res.status(404).json({ error: 'user_not_found' });
  saveUsers(nextUsers);
  res.json({ ok: true });
});
app.post('/api/auth/change-password', requireLogin, (req, res) => {
  const oldPassword = String(req.body?.oldPassword || '');
  const newPassword = String(req.body?.newPassword || '');
  if (newPassword.length < 4 || newPassword.length > 200) return res.status(400).json({ error: 'password_invalid', detalle: 'La nueva contraseña debe tener al menos 4 caracteres.' });
  const users = loadUsers();
  const user = users.find(u => u.username === req.user.username);
  if (!validPassword(user, oldPassword)) return res.status(401).json({ error: 'old_password_invalid' });
  Object.assign(user, makePassword(newPassword));
  saveUsers(users);
  res.json({ ok: true });
});

/* ============ Healthcheck ============ */
app.get('/health', (_,res)=>res.status(200).send('OK'));
app.get('/salud',  (_,res)=>res.status(200).send('OK'));

/* ============ Páginas protegidas ============ */
app.get('/', (req, res) => {
  const user = currentUser(req);
  if (!user) return res.redirect('/login.html');
  if (user.role === 'admin') return res.redirect('/admin.html');
  return res.sendFile(path.join(PUBLIC_DIR, 'inicio.html'));
});
app.get('/inicio', requireLogin, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'inicio.html')));
app.get('/admin.html', requireAdmin, (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));
app.get('/verificar-sesion', (req, res) => res.json({ activo: !!currentUser(req), usuario: currentUser(req) }));

/* ============ Historial URL (front lo usa) ============ */
const HISTORIAL_FALLBACK = 'https://prueba2-production-50d4.up.railway.app/';
app.get('/historial-url', (req, res) => {
  res.json({ url: process.env.HISTORIAL_URL || HISTORIAL_FALLBACK });
});

/* ============ Proxies Weather.com PWS ============ */
const UA = process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';

app.get('/api/weather/current', async (req, res) => {
  try {
    const apiKey = process.env.WEATHER_API_KEY || process.env.WU_API_KEY;
    const stationId = req.query.stationId || process.env.WU_STATION_ID;
    const units = req.query.units || 'm';
    if (!apiKey || !stationId) return res.status(400).json({ error:'config_missing', detalle:'Faltan WEATHER_API_KEY/WU_API_KEY o WU_STATION_ID' });

    const url = new URL('https://api.weather.com/v2/pws/observations/current');
    url.searchParams.set('stationId', stationId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('units', units);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('numericPrecision', 'decimal');

    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept':'application/json,text/plain,*/*', 'Accept-Language':'es-ES,es;q=0.9' }});
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const body = await r.text();
    if (!r.ok) { console.error('Upstream /current', r.status, ct, body.slice(0,300)); return res.status(r.status).json({ error:'weather.com denied', status:r.status }); }
    if (!ct.includes('application/json')) return res.status(502).json({ error:'Invalid response from weather.com' });
    res.set('Cache-Control','public, max-age=60').type('application/json').send(body);
  } catch (e) { console.error(e); res.status(500).json({ error:'Weather proxy failed' }); }
});

app.get('/api/weather/history', async (req, res) => {
  try {
    const apiKey = process.env.WEATHER_API_KEY || process.env.WU_API_KEY;
    const stationId = req.query.stationId || process.env.WU_STATION_ID;
    const { startDate, endDate } = req.query;
    const units = req.query.units || 'm';
    if (!apiKey || !stationId) return res.status(400).json({ error:'config_missing', detalle:'Faltan WEATHER_API_KEY/WU_API_KEY o WU_STATION_ID' });
    if (!startDate || !endDate) return res.status(400).json({ error:'params_missing', detalle:'startDate y endDate son obligatorios (YYYYMMDD)' });

    const url = new URL('https://api.weather.com/v2/pws/history/daily');
    url.searchParams.set('stationId', stationId);
    url.searchParams.set('format', 'json');
    url.searchParams.set('units', units);
    url.searchParams.set('startDate', startDate);
    url.searchParams.set('endDate', endDate);
    url.searchParams.set('apiKey', apiKey);
    url.searchParams.set('numericPrecision', 'decimal');

    const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept':'application/json,text/plain,*/*', 'Accept-Language':'es-ES,es;q=0.9' }});
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const body = await r.text();
    if (!r.ok) { console.error('Upstream /history', r.status, ct, body.slice(0,300)); return res.status(r.status).json({ error:'weather.com denied', status:r.status }); }
    if (!ct.includes('application/json')) return res.status(502).json({ error:'Invalid response from weather.com' });
    res.set('Cache-Control','public, max-age=300').type('application/json').send(body);
  } catch (e) { console.error(e); res.status(500).json({ error:'Weather history proxy failed' }); }
});

/* ============ Diagnóstico CumulusMX ============ */
app.get('/api/cumulus/test', async (_req, res) => {
  const base = (process.env.CUMULUS_URL || 'http://localhost:8998').replace(/\/+$/, '');
  const url = `${base}/api/tags/process.json?rc&rmonth`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { 'Accept': 'application/json,text/plain,*/*' }
    });
    const body = await r.text();

    return res.status(r.ok ? 200 : 502).json({
      ok: r.ok,
      cumulus_url: base,
      endpoint: url,
      http: r.status,
      respuesta: body
    });
  } catch (e) {
    return res.status(502).json({
      ok: false,
      cumulus_url: base,
      endpoint: url,
      error: String(e.message || e),
      detalle: 'El servidor no puede alcanzar CumulusMX. Si este servidor está en Railway, localhost NO es el PC donde está CumulusMX.'
    });
  } finally {
    clearTimeout(timeout);
  }
});

/* ============ Recepción segura de lluvia enviada por el PC CumulusMX ============ */
const RAIN_CACHE_FILE = path.join(DB_DIR, 'lluvia-cumulus.json');
function readRainCache() {
  try { return JSON.parse(fs.readFileSync(RAIN_CACHE_FILE, 'utf8')); }
  catch { return {}; }
}
function writeRainCache(data) {
  fs.writeFileSync(RAIN_CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
}
app.post('/api/cumulus/lluvia', (req, res) => {
  const expected = process.env.CUMULUS_PUSH_TOKEN;
  const supplied = String(req.get('x-cumulus-token') || req.body?.token || '');
  if (!expected) return res.status(503).json({ error: 'push_not_configured', detalle: 'Falta configurar CUMULUS_PUSH_TOKEN en Render.' });
  if (supplied.length !== expected.length || supplied !== expected) return res.status(401).json({ error: 'unauthorized' });
  const year = Number(req.body?.year);
  const month = Number(req.body?.month);
  const total = Number(req.body?.total_mm);
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12 || !Number.isFinite(total) || total < 0 || total > 10000) {
    return res.status(400).json({ error: 'invalid_data', detalle: 'Se requiere year, month y total_mm válidos.' });
  }
  const cache = readRainCache();
  const key = `${year}-${String(month).padStart(2, '0')}`;
  cache[key] = { year, month, total_mm: Number(total.toFixed(2)), recibido: new Date().toISOString(), origen: 'CumulusMX PC' };
  try { writeRainCache(cache); }
  catch (e) { return res.status(500).json({ error: 'save_failed', detalle: String(e.message || e) }); }
  return res.json({ ok: true, guardado: key, total_mm: cache[key].total_mm });
});

app.get('/api/cumulus/lluvia', (_req, res) => {
  const cache = readRainCache();
  res.json({ ok: true, datos: Object.values(cache).sort((a, b) => a.year - b.year || a.month - b.month) });
});

/* ============ Historial detallado enviado por CumulusMX ============ */
const HISTORY_DIR = path.join(DB_DIR, 'cumulus-historial');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
function historyFile(year) { return path.join(HISTORY_DIR, `historial-${year}.json`); }
function readHistory(year) {
  try { const d = JSON.parse(fs.readFileSync(historyFile(year), 'utf8')); return Array.isArray(d) ? d : []; }
  catch { return []; }
}
app.post('/api/cumulus/historial', (req, res) => {
  const expected = process.env.CUMULUS_PUSH_TOKEN;
  const supplied = String(req.get('x-cumulus-token') || req.body?.token || '');
  if (!expected) return res.status(503).json({ error: 'push_not_configured', detalle: 'Falta configurar CUMULUS_PUSH_TOKEN en Render.' });
  if (supplied.length !== expected.length || supplied !== expected) return res.status(401).json({ error: 'unauthorized' });
  const year = Number(req.body?.year);
  const rows = req.body?.datos;
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Array.isArray(rows) || rows.length > 50000) {
    return res.status(400).json({ error: 'invalid_data', detalle: 'Se requiere un año válido y un array datos (máximo 50000 registros).' });
  }
  const valid = rows.filter(x => x && /^\d{4}-\d{2}-\d{2}$/.test(String(x.fecha || '')) && String(x.fecha).startsWith(`${year}-`) && /^\d{2}:\d{2}(?::\d{2})?$/.test(String(x.hora || '')))
    .map(x => ({ fecha: String(x.fecha), hora: String(x.hora), temperatura: numOrNull(x.temperatura), lluvia: numOrNull(x.lluvia), viento: numOrNull(x.viento), racha: numOrNull(x.racha), humedad: numOrNull(x.humedad), presion: numOrNull(x.presion) }));
  function numOrNull(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
  if (!valid.length && rows.length) return res.status(400).json({ error: 'no_valid_records', detalle: 'No se reconocieron registros válidos.' });
  try {
    const byKey = new Map(readHistory(year).map(x => [`${x.fecha} ${x.hora}`, x]));
    for (const row of valid) byKey.set(`${row.fecha} ${row.hora}`, row);
    const all = Array.from(byKey.values()).sort((a,b) => `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`));
    fs.writeFileSync(historyFile(year), JSON.stringify(all), 'utf8');
    return res.json({ ok: true, year, recibidos: valid.length, total: all.length });
  } catch (e) { return res.status(500).json({ error: 'save_failed', detalle: String(e.message || e) }); }
});
app.get('/api/cumulus/historial', (req, res) => {
  const year = Number(req.query.year);
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return res.status(400).json({ error: 'year_invalid', detalle: 'Indica year=AAAA.' });
  const datos = readHistory(year);
  res.set('Cache-Control', 'no-store').json({ ok: true, year, desde: `${year}-01-01`, hasta: `${year}-12-31`, total: datos.length, datos });
});

/* ============ Lluvia mensual desde CumulusMX ============ */
app.get('/api/lluvia/mensual', async (req, res) => {
  try {
    const base = (process.env.CUMULUS_URL || 'http://localhost:8998').replace(/\/+$/, '');
    const year = Number(req.query.year);
    const month = Number(req.query.month);

    if (!Number.isInteger(year) || year < 2000 || year > 2100 ||
        !Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ error: 'params_invalid', detalle: 'year y month son obligatorios y válidos' });
    }

    // Primero usa el dato enviado por el PC de la estación; así Render no necesita
    // acceder directamente al localhost del otro ordenador.
    const cache = readRainCache();
    const cached = cache[`${year}-${String(month).padStart(2, '0')}`];
    if (cached) return res.json({ ...cached, origen: 'CumulusMX PC', modo: 'recibido' });

    // CumulusMX expone oficialmente MonthRainfall y permite indicar año y mes.
    // Usamos POST a process.txt para evitar problemas de codificación del webtag.
    const tagUrl = `${base}/api/tags/process.txt`;
    const tagBody = `<#MonthRainfall y="${year}" m="${month}">`;

    // CumulusMX admite POST en /api/tags/process.txt para procesar
    // webtags con parámetros (por ejemplo MonthRainfall y=AAAA m=MM).
    // Añadimos timeout y devolvemos el motivo real del fallo para poder
    // distinguir "Cumulus apagado" de un valor inválido.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);

    let tagResponse;
    try {
      tagResponse = await fetch(tagUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Accept': 'text/plain,text/html,*/*'
        },
        body: tagBody,
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }

    const tagText = (await tagResponse.text()).trim();
    if (!tagResponse.ok) {
      return res.status(502).json({
        error: 'cumulus_unavailable',
        detalle: `CumulusMX respondió HTTP ${tagResponse.status}`,
        cumulus_url: base
      });
    }

    // El valor devuelto por CumulusMX está en la unidad de lluvia configurada.
    const total = Number(String(tagText).replace(',', '.').replace(/[^0-9.+-]/g, ''));
    if (!Number.isFinite(total)) {
      return res.status(502).json({
        error: 'cumulus_invalid_value',
        detalle: `CumulusMX devolvió: ${tagText}`
      });
    }

    return res.json({
      year,
      month,
      total_mm: Number(total.toFixed(2)),
      origen: 'CumulusMX MonthRainfall'
    });
  } catch (e) {
    console.error('Error /api/lluvia/mensual:', e);
    return res.status(502).json({
      error: 'cumulus_connection_failed',
      detalle: String(e.message || e)
    });
  }
});

/* ============ Lluvia acumulada desde el 1 de enero hasta hoy ============ */
/*
  Usa los totales mensuales que envía el agente local de CumulusMX.
  Suma enero hasta el mes actual, sin depender de Weather Underground.
*/
app.get('/api/lluvia/total/year', (req, res) => {
  try {
    // Fecha actual de la estación en España, evitando desfases por UTC en Render.
    const fechaLocal = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Madrid',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
    const [yearText, monthText, dayText] = fechaLocal.split('-');
    const year = Number(yearText);
    const currentMonth = Number(monthText);
    const pad = (n) => String(n).padStart(2, '0');

    const cache = readRainCache();
    const meses = [];
    let total = 0;

    for (let month = 1; month <= currentMonth; month++) {
      const key = `${year}-${pad(month)}`;
      const dato = cache[key];
      if (dato && Number.isFinite(Number(dato.total_mm))) {
        const mm = Number(dato.total_mm);
        total += mm;
        meses.push({ year, month, total_mm: mm, recibido: dato.recibido || null });
      }
    }

    const respuesta = {
      year,
      desde: `${year}-01-01`,
      hasta: `${year}-${pad(currentMonth)}-${dayText}`,
      total_mm: Number(total.toFixed(2)),
      meses_con_datos: meses.length,
      meses_esperados: currentMonth,
      meses_faltantes: Array.from({ length: currentMonth }, (_, i) => i + 1)
        .filter(month => !cache[`${year}-${pad(month)}`]),
      origen: 'Suma mensual de CumulusMX'
    };

    if (req.query.debug === '1') respuesta.meses = meses;
    res.set('Cache-Control', 'no-store').json(respuesta);
  } catch (e) {
    console.error('Error /api/lluvia/total/year:', e);
    res.status(500).json({ error: 'calc_failed', detalle: String(e.message || e) });
  }
});


/* ============ Índice UV estimado de Open-Meteo ============ */
// La estación WH1080 SE no mide UV. Se obtiene un valor estimado para Alfarnate.
app.get('/api/uv/current', async (_req, res) => {
  try {
    const lat = Number(process.env.UV_LAT || 36.985);
    const lon = Number(process.env.UV_LON || -4.223);
    const url = new URL('https://api.open-meteo.com/v1/forecast');
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    url.searchParams.set('current', 'uv_index');
    url.searchParams.set('timezone', 'Europe/Madrid');

    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    const body = await r.text();
    if (!r.ok) {
      console.error('Open-Meteo UV:', r.status, body.slice(0, 300));
      return res.status(502).json({ error: 'uv_unavailable' });
    }
    const data = JSON.parse(body);
    const uv = data?.current?.uv_index;
    res.set('Cache-Control', 'no-store').json({
      uv: Number.isFinite(Number(uv)) ? Number(uv) : null,
      origen: 'Open-Meteo (estimado)',
      time: data?.current?.time || null
    });
  } catch (e) {
    console.error('Error /api/uv/current:', e);
    res.status(500).json({ error: 'uv_failed' });
  }
});

/* ============ Arranque ============ */
const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`🚀 http://0.0.0.0:${PORT} — listo (rutas: /verificar-sesion, /api/weather/*, /api/lluvia/total/year)`)
);








