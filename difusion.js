// ─── MÓDULO DIFUSIÓN MASIVA ────────────────────────────────────────────────
// Gestiona la cola de envío con:
//  - delay aleatorio entre mensajes (anti-bloqueo de WhatsApp)
//  - pausa / cancelación
//  - log de resultados (enviado / error)
//  - persistencia simple en difusion_log.json
const fs = require('fs');
const path = require('path');
const { aplicarPlantilla } = require('./clientes');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const LOG_FILE = path.join(DATA_DIR, 'difusion_log.json');

const estado = {
  activo: false,
  pausado: false,
  total: 0,
  enviados: 0,
  errores: 0,
  actual: 0,
  inicio: null,
  fin: null,
  plantilla: '',
  resultados: [], // {telefono, nombre, ok, error, fecha}
  cancelado: false,
};

function cargarLog() {
  try {
    if (fs.existsSync(LOG_FILE)) return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8'));
  } catch {}
  return [];
}
function guardarLogHistorico(entry) {
  try {
    const h = cargarLog();
    h.push(entry);
    // conservar últimos 2000
    while (h.length > 2000) h.shift();
    fs.writeFileSync(LOG_FILE, JSON.stringify(h, null, 2));
  } catch (e) { console.error('No se pudo guardar difusion_log:', e.message); }
}

function getEstado() {
  return { ...estado, resultados: estado.resultados.slice(-100) };
}

function getHistorico() {
  return cargarLog().slice(-200).reverse();
}

// Delay aleatorio entre mensajes para no parecer spam.
// Recomendado: 8-20s entre mensajes en cuentas nuevas, 4-10s en cuentas con antigüedad.
function delayRandom(minS = 6, maxS = 14) {
  const ms = (minS + Math.random() * (maxS - minS)) * 1000;
  return new Promise(r => setTimeout(r, ms));
}

// Inicia difusión. `enviarFn(jid, texto)` es la función real de Baileys (inyectada desde index.js).
async function iniciarDifusion(clientes, plantilla, enviarFn, opts = {}) {
  if (estado.activo) throw new Error('Ya hay una difusión en curso.');
  const { minDelayS = 6, maxDelayS = 14, testMode = false } = opts;

  estado.activo = true;
  estado.pausado = false;
  estado.cancelado = false;
  estado.total = clientes.length;
  estado.enviados = 0;
  estado.errores = 0;
  estado.actual = 0;
  estado.inicio = new Date().toISOString();
  estado.fin = null;
  estado.plantilla = plantilla;
  estado.resultados = [];

  console.log(`📣 Difusión iniciada: ${clientes.length} destinatarios`);

  const lista = testMode ? clientes.slice(0, 1) : clientes;

  for (let i = 0; i < lista.length; i++) {
    if (estado.cancelado) { console.log('🛑 Difusión cancelada por el usuario'); break; }
    while (estado.pausado && !estado.cancelado) {
      await new Promise(r => setTimeout(r, 1000));
    }
    if (estado.cancelado) break;

    const c = lista[i];
    estado.actual = i + 1;
    const texto = aplicarPlantilla(plantilla, c);
    const jid = c.telefono.replace(/\D/g, '') + '@s.whatsapp.net';
    try {
      await enviarFn(jid, texto);
      estado.enviados++;
      estado.resultados.push({ telefono: c.telefono, nombre: c.nombre, ok: true, fecha: new Date().toISOString() });
      console.log(`✅ [${estado.actual}/${estado.total}] enviado a ${c.nombre} (+${c.telefono})`);
    } catch (e) {
      estado.errores++;
      estado.resultados.push({ telefono: c.telefono, nombre: c.nombre, ok: false, error: e.message, fecha: new Date().toISOString() });
      console.error(`❌ [${estado.actual}/${estado.total}] error con +${c.telefono}: ${e.message}`);
    }

    // No esperar después del último
    if (i < lista.length - 1) await delayRandom(minDelayS, maxDelayS);
  }

  estado.activo = false;
  estado.pausado = false;
  estado.fin = new Date().toISOString();
  guardarLogHistorico({
    fecha: estado.inicio,
    total: estado.total,
    enviados: estado.enviados,
    errores: estado.errores,
    cancelado: estado.cancelado,
    plantilla: plantilla.slice(0, 500),
  });
  console.log(`🏁 Difusión terminada: ${estado.enviados} ok, ${estado.errores} errores`);
  return getEstado();
}

function pausar() { if (estado.activo) estado.pausado = true; return getEstado(); }
function reanudar() { estado.pausado = false; return getEstado(); }
function cancelar() { estado.cancelado = true; estado.pausado = false; return getEstado(); }

module.exports = { iniciarDifusion, pausar, reanudar, cancelar, getEstado, getHistorico };
