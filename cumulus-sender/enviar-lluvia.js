// Agente CumulusMX -> Render: lluvia mensual + historial detallado.
// Requiere Node.js 18 o superior.
// Configura CUMULUS_PUSH_TOKEN como variable de entorno; debe coincidir con Render.

const fs = require('fs');
const path = require('path');

const CUMULUS_URL = (process.env.CUMULUS_URL || 'http://127.0.0.1:8998').replace(/\/+$/, '');
const RENDER_URL = (process.env.RENDER_URL || 'https://estacion100.onrender.com').replace(/\/+$/, '');
const TOKEN = process.env.CUMULUS_PUSH_TOKEN || '';
const DATA_DIR = process.env.CUMULUS_DATA_DIR || 'C:\\CumulusMX\\data';
const INTERVAL_MS = 1 * 60 * 1000;
const HISTORY_BATCH_SIZE = 500;

if (!TOKEN) {
  console.error('Falta CUMULUS_PUSH_TOKEN. Debe coincidir con la variable configurada en Render.');
  process.exit(1);
}

function numero(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function fechaLog(texto) {
  // CumulusMX: DD/MM/YY HH:mm
  const m = String(texto || '').trim().match(/^(\d{2})\/(\d{2})\/(\d{2,4})\s+(\d{2}:\d{2}(?::\d{2})?)/);
  if (!m) return null;
  let year = Number(m[3]);
  if (m[3].length === 2) year += year >= 70 ? 1900 : 2000;
  const fecha = `${year}-${m[2]}-${m[1]}`;
  return { year, fecha, hora: m[4].length === 5 ? `${m[4]}:00` : m[4] };
}

function parsearLinea(linea) {
  const campos = String(linea).trim().split(',');
  if (campos.length < 11) return null;
  const f = fechaLog(campos[0]);
  if (!f) return null;

  // Formato CumulusMX: fecha/hora, timestamp, temp, humedad, rocío,
  // velocidad viento, racha, rumbo, tasa lluvia, lluvia hoy, presión...
  return {
    year: f.year,
    registro: {
      fecha: f.fecha,
      hora: f.hora,
      temperatura: numero(campos[2]),
      humedad: numero(campos[3]),
      viento: numero(campos[5]),
      racha: numero(campos[6]),
      lluvia: numero(campos[9]),
      presion: numero(campos[10])
    }
  };
}

async function leerMes(year, month) {
  const url = `${CUMULUS_URL}/api/tags/process.txt`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Accept': 'text/plain,text/html,*/*' },
    body: `<#MonthRainfall y="${year}" m="${month}">`,
    signal: AbortSignal.timeout(8000)
  });
  const text = (await response.text()).trim();
  if (!response.ok) throw new Error(`CumulusMX HTTP ${response.status}: ${text.slice(0, 120)}`);
  const match = text.replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  if (!match) throw new Error(`No se pudo interpretar MonthRainfall: ${text}`);
  const value = Number(match[0]);
  if (!Number.isFinite(value) || value < 0) throw new Error(`Lluvia no válida: ${text}`);
  return Number(value.toFixed(2));
}

async function leerActual() {
  const url = `${CUMULUS_URL}/api/tags/process.json?temp&hum&dew&wind&gust&bearing&rrate&rfall&press&solar&uv&latesttime`;
  const response = await fetch(url, { headers: { Accept: 'application/json,text/plain,*/*' }, signal: AbortSignal.timeout(8000) });
  const body = await response.text();
  if (!response.ok) throw new Error(`CumulusMX actual HTTP ${response.status}: ${body.slice(0, 160)}`);
  let d;
  try { d = JSON.parse(body); } catch { throw new Error(`CumulusMX no devolvió JSON: ${body.slice(0, 120)}`); }
  const pick = (...keys) => { for (const k of keys) if (d[k] !== undefined && d[k] !== null && d[k] !== '') return d[k]; return null; };
  return {
    temperatura: numero(pick('temp', 'temperature', 'outTemp')),
    humedad: numero(pick('hum', 'humidity', 'outHumidity')),
    puntoRocio: numero(pick('dew', 'dewpoint', 'dewPoint')),
    viento: numero(pick('wind', 'windspeed', 'windSpeed')),
    racha: numero(pick('gust', 'windgust', 'windGust')),
    direccion: numero(pick('bearing', 'winddir', 'windDirection')),
    tasaLluvia: numero(pick('rrate', 'rainrate', 'rainRate')),
    lluviaHoy: numero(pick('rfall', 'raintoday', 'rainToday')),
    presion: numero(pick('press', 'pressure', 'barometer')),
    solar: numero(pick('solar', 'solarRad', 'solarRadiation')),
    uv: numero(pick('uv', 'UV', 'uvIndex')),
    hora: String(pick('latesttime', 'time', 'dateTime') || new Date().toLocaleString('es-ES'))
  };
}

async function enviarActual() {
  const datos = await leerActual();
  if (datos.temperatura === null && datos.humedad === null && datos.viento === null) throw new Error('CumulusMX no devolvió valores actuales reconocibles.');
  const response = await fetch(`${RENDER_URL}/api/cumulus/current`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'x-cumulus-token': TOKEN },
    body: JSON.stringify(datos), signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Render actual HTTP ${response.status}: ${body.slice(0, 180)}`);
  console.log(`${new Date().toLocaleString('es-ES')} | Datos actuales enviados: T=${datos.temperatura}, H=${datos.humedad}, viento=${datos.viento}`);
}

async function enviarLluvia(year, month, total_mm) {
  const response = await fetch(`${RENDER_URL}/api/cumulus/lluvia`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cumulus-token': TOKEN },
    body: JSON.stringify({ year, month, total_mm }),
    signal: AbortSignal.timeout(15000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Render lluvia HTTP ${response.status}: ${body.slice(0, 180)}`);
}

async function enviarLoteHistorial(year, datos) {
  const response = await fetch(`${RENDER_URL}/api/cumulus/historial`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-cumulus-token': TOKEN },
    body: JSON.stringify({ year, datos }),
    signal: AbortSignal.timeout(30000)
  });
  const body = await response.text();
  if (!response.ok) throw new Error(`Render historial HTTP ${response.status}: ${body.slice(0, 250)}`);
  let result;
  try { result = JSON.parse(body); } catch { result = { respuesta: body }; }
  console.log(`${new Date().toLocaleString('es-ES')} | Historial ${year}: ${result.recibidos ?? datos.length} registros enviados; total en Render: ${result.total ?? '?'}`);
}

function listarArchivosLog() {
  if (!fs.existsSync(DATA_DIR)) throw new Error(`No existe la carpeta de logs: ${DATA_DIR}`);
  return fs.readdirSync(DATA_DIR)
    .filter(name => /^\d{6}log\.txt$/i.test(name))
    .sort()
    .map(name => path.join(DATA_DIR, name));
}

function cargarHistorial({ soloReciente = false } = {}) {
  const porAnio = new Map();
  const corte = new Date();
  corte.setDate(corte.getDate() - 2);
  const corteISO = `${corte.getFullYear()}-${String(corte.getMonth() + 1).padStart(2, '0')}-${String(corte.getDate()).padStart(2, '0')}`;

  for (const archivo of listarArchivosLog()) {
    const texto = fs.readFileSync(archivo, 'utf8');
    for (const linea of texto.split(/\r?\n/)) {
      const parsed = parsearLinea(linea);
      if (!parsed) continue;
      if (soloReciente && parsed.registro.fecha < corteISO) continue;
      if (!porAnio.has(parsed.year)) porAnio.set(parsed.year, []);
      porAnio.get(parsed.year).push(parsed.registro);
    }
  }

  for (const [year, rows] of porAnio) {
    const unicos = new Map();
    for (const row of rows) unicos.set(`${row.fecha} ${row.hora}`, row);
    porAnio.set(year, Array.from(unicos.values()).sort((a, b) =>
      `${a.fecha} ${a.hora}`.localeCompare(`${b.fecha} ${b.hora}`)
    ));
  }
  return porAnio;
}

async function sincronizarHistorial(soloReciente = false) {
  try {
    const porAnio = cargarHistorial({ soloReciente });
    if (!porAnio.size) {
      console.log(`No se encontraron registros ${soloReciente ? 'recientes' : 'históricos'} en ${DATA_DIR}`);
      return;
    }
    for (const [year, rows] of porAnio) {
      for (let i = 0; i < rows.length; i += HISTORY_BATCH_SIZE) {
        await enviarLoteHistorial(year, rows.slice(i, i + HISTORY_BATCH_SIZE));
      }
      console.log(`Historial local ${year}: ${rows.length} registros leídos.`);
    }
  } catch (err) {
    console.error(`Error al sincronizar historial: ${err.message}`);
  }
}

async function cicloLluvia() {
  const now = new Date();
  const year = now.getFullYear();
  for (let month = 1; month <= now.getMonth() + 1; month++) {
    try {
      const total_mm = await leerMes(year, month);
      await enviarLluvia(year, month, total_mm);
      console.log(`${new Date().toLocaleString('es-ES')} | ${year}-${String(month).padStart(2, '0')}: ${total_mm} mm enviado a Render`);
    } catch (err) {
      console.error(`${year}-${String(month).padStart(2, '0')}: ${err.message}`);
    }
  }
}

async function main() {
  console.log(`Agente CumulusMX iniciado. Origen: ${CUMULUS_URL} | Destino: ${RENDER_URL}`);
  console.log(`Carpeta de logs: ${DATA_DIR}`);
  try { await enviarActual(); } catch (err) { console.error(`Actuales: ${err.message}`); }

  // Primera ejecución: enviar todo el historial disponible.
  await sincronizarHistorial(false);
  await cicloLluvia();

  // Cada 1 minuto: mantener la lluvia mensual y actualizar los últimos 3 días.
  setInterval(async () => {
    try { await enviarActual(); } catch (err) { console.error(`Actuales: ${err.message}`); }
    await cicloLluvia();
    await sincronizarHistorial(true);
  }, INTERVAL_MS);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});


