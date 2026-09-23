require('dotenv').config(); // carga variables desde .env automáticamente
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, downloadMediaMessage } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const Groq = require('groq-sdk');
const express = require('express');
const pino = require('pino');
const qrcode = require('qrcode');
const fs = require('fs');
const path = require('path');
const flujo = require('./flujoFotocopiadora');
const { PDFDocument } = require('pdf-lib');
const clientesMod = require('./clientes');
const difusion = require('./difusion');
// ─── DATOS PERSISTENTES ───────────────────────────────────────────────────────
// Por defecto se guardan junto al código. Para hosting con disco efímero
// (Railway/Render), seteá DATA_DIR al path del volumen (ej: /app/data)
// y montá ahí el Volume: persiste sesión WhatsApp, adjuntos y pedidos.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const AUTH_DIR = path.join(DATA_DIR, 'auth_info');
if (!fs.existsSync(DATA_DIR)) {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { console.error('No se pudo crear DATA_DIR:', e.message); }
}
// ─── DIFUSIÓN MASIVA (Google Sheets + WhatsApp) ─────────────────────────────
let SHEET_ID = process.env.SHEET_ID || '';
let SHEET_GID = process.env.SHEET_GID || '0';
let clientesCache = [];       // última lista cargada del Sheet
let clientesCacheFecha = null;
const PLANTILLA_DEFAULT = process.env.PLANTILLA_DEFAULT ||
  'Hola {nombre} 👋, te contactamos por el caso del {fecha_sucedio} (registrado el {fecha_subida}). Queríamos contarte las novedades. ¡Gracias por tu confianza!';
// Auto-actualización del Sheet: cada N minutos recarga la caché en segundo plano
// para que lo que cambies en el Excel se refleje solo. 0 = desactivado.
const SHEET_REFRESH_MIN = Number(process.env.SHEET_REFRESH_MIN || 2);
async function refrescarCacheAuto(origen = 'auto') {
  if (!SHEET_ID) return;
  if (difusion.getEstado().activo) return; // no tocar la caché durante un envío
  try {
    const lista = await clientesMod.fetchClientes(SHEET_ID, SHEET_GID);
    clientesCache = lista;
    clientesCacheFecha = new Date().toISOString();
    console.log(`🔄 [${origen}] Clientes actualizados: ${lista.length} filas`);
  } catch (e) {
    console.error(`🔄 [${origen}] No se pudo actualizar el Sheet:`, e.message);
  }
}
if (SHEET_REFRESH_MIN > 0) {
  setTimeout(() => refrescarCacheAuto('inicio'), 10000); // primera carga a los 10s
  setInterval(() => refrescarCacheAuto('auto'), Math.max(1, SHEET_REFRESH_MIN) * 60000);
  console.log(`🔄 Auto-refresh del Sheet cada ${SHEET_REFRESH_MIN} min`);
}
// No necesitamos pendingAttachments, usamos la sesión directamente

// Delay aleatorio para simular respuesta humana (anti-detección de bot)
const delay = ms => new Promise(res => setTimeout(res, ms));

// Calcula un delay realista según el largo del mensaje (simula tiempo de tipeo).
// ~50ms por caracter + jitter aleatorio. Limitado entre 1.2s y 8s.
function delayHumano(mensaje) {
  const texto = typeof mensaje === 'string' ? mensaje : '';
  const base = 800 + texto.length * 50;
  const jitter = Math.random() * 1500;
  const total = Math.min(8000, Math.max(1200, base + jitter));
  return delay(total);
}

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const GROQ_API_KEY = process.env.GROQ_API_KEY || '';
const BOT_NAME = process.env.BOT_NAME || 'AsistenteIA';
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT ||
  'Eres un asistente amigable y útil. Respondes siempre en el mismo idioma que te hablan. Eres conciso pero completo en tus respuestas.';

// ─── GROQ CLIENT ──────────────────────────────────────────────────────────────
const groq = new Groq({ apiKey: GROQ_API_KEY });
const conversaciones = new Map();

async function preguntarIA(userId, mensaje) {
  if (!conversaciones.has(userId)) conversaciones.set(userId, []);
  const historial = conversaciones.get(userId);
  historial.push({ role: 'user', content: mensaje });
  if (historial.length > 20) historial.splice(0, historial.length - 20);

  try {
    const respuesta = await groq.chat.completions.create({
      model: 'llama3-8b-8192',
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...historial],
      max_tokens: 200,
      temperature: 0.7,
    });
    const texto = respuesta.choices[0]?.message?.content || 'Sin respuesta.';
    historial.push({ role: 'assistant', content: texto });
    return texto;
  } catch (err) {
    console.error('❌ Groq error:', err.message);
    return '⚠️ Error al procesar tu mensaje. Intenta de nuevo.';
  }
}

// ─── ESTADO COMPARTIDO ────────────────────────────────────────────────────────
const lidToPhone = new Map(); // mapea @lid IDs al número real de teléfono
let qrImageBase64 = null;
let botStatus = 'desconectado';
let stats = { recibidos: 0, respondidos: 0, usuarios: new Set(), inicio: new Date() };
let sock = null;
let socketGen = 0;            // identificador de la instancia activa
const enviadosPorBot = new Set(); // IDs de mensajes que envió el bot (para evitar bucles)
let iniciando = false;        // candado para evitar arranques en paralelo
let reconnectTimer = null;    // único timer de reconexión

async function enviarMensaje(jid, content, options) {
  // Simular humano: "escribiendo…" + delay proporcional al largo del mensaje
  const textoMensaje = (content && (content.text || content.caption)) || '';
  try { await sock.sendPresenceUpdate('composing', jid); } catch {}
  await delayHumano(textoMensaje);
  try { await sock.sendPresenceUpdate('paused', jid); } catch {}

  const r = await sock.sendMessage(jid, content, options);
  if (r?.key?.id) {
    enviadosPorBot.add(r.key.id);
    if (enviadosPorBot.size > 500) {
      const it = enviadosPorBot.values();
      for (let i = 0; i < 100; i++) enviadosPorBot.delete(it.next().value);
    }
  }
  return r;
}

function programarReconexion(ms = 3000) {
  if (reconnectTimer) return; // ya hay una reconexión programada
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    iniciarBot();
  }, ms);
}

// Pedidos confirmados (en memoria + persistencia simple en disco)
const PEDIDOS_FILE = path.join(DATA_DIR, 'pedidos.json');
let pedidos = [];
try {
  if (fs.existsSync(PEDIDOS_FILE)) {
    pedidos = JSON.parse(fs.readFileSync(PEDIDOS_FILE, 'utf8'));
  }
} catch (e) {
  console.error('No se pudo cargar pedidos.json:', e.message);
}
function guardarPedidos() {
  try { fs.writeFileSync(PEDIDOS_FILE, JSON.stringify(pedidos, null, 2)); }
  catch (e) { console.error('No se pudo guardar pedidos.json:', e.message); }
}

// ─── EXPRESS (panel web) ──────────────────────────────────────────────────────
const app = express();
// Adjuntos: carpeta y ruta de servicio
const ATTACHMENTS_DIR = path.join(DATA_DIR, 'attachments');
if (!fs.existsSync(ATTACHMENTS_DIR)) {
  try { fs.mkdirSync(ATTACHMENTS_DIR, { recursive: true }); } catch (e) { console.error('No se pudo crear attachments/:', e.message); }
}
app.use('/attachments', express.static(ATTACHMENTS_DIR));
app.use(express.json());
const PORT = process.env.PORT || 5000;

// ─── AUTENTICACIÓN DEL PANEL ──────────────────────────────────────────────────
// Definí la contraseña en la variable de entorno PANEL_PASSWORD.
// Si no está definida, el panel queda abierto (solo para desarrollo local).
const PANEL_PASSWORD = process.env.PANEL_PASSWORD || '';

function requireAuth(req, res, next) {
  if (!PANEL_PASSWORD) return next(); // sin contraseña configurada, acceso libre
  // Rutas públicas: ping y nada más
  if (req.path === '/ping') return next();
  // Verificar cookie de sesión
  const cookie = req.headers.cookie || '';
  const token = cookie.split(';').map(c => c.trim()).find(c => c.startsWith('panel_token='));
  if (token && token.split('=')[1] === PANEL_PASSWORD) return next();
  // Verificar login por POST /api/login
  if (req.method === 'POST' && req.path === '/api/login') return next();
  // Todo lo demás: redirigir al login si es GET HTML, o 401 si es API
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>Login — Panel</title>
<style>*{box-sizing:border-box}body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:2rem;border-radius:12px;box-shadow:0 2px 12px #0002;width:320px}
h2{margin:0 0 1.5rem;font-size:1.2rem}input{width:100%;padding:.7rem 1rem;border:1px solid #ddd;border-radius:8px;font-size:1rem;margin-bottom:1rem}
button{width:100%;padding:.75rem;background:#25d366;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer;font-weight:600}
button:hover{background:#1ebe5d}.err{color:#c00;font-size:.9rem;margin-top:.5rem}</style></head>
<body><div class="card"><h2>🔐 Panel WhatsApp Bot</h2>
<form id="f"><input type="password" id="pw" placeholder="Contraseña" autofocus/>
<button type="submit">Entrar</button><p class="err" id="err"></p></form></div>
<script>document.getElementById('f').onsubmit=async e=>{e.preventDefault();
const r=await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:document.getElementById('pw').value})});
const d=await r.json();if(d.ok){location.reload()}else{document.getElementById('err').textContent='Contraseña incorrecta'}}</script>
</body></html>`);
  }
  return res.status(401).json({ error: 'No autorizado' });
}

app.post('/api/login', (req, res) => {
  if (!PANEL_PASSWORD || req.body?.password === PANEL_PASSWORD) {
    res.setHeader('Set-Cookie', `panel_token=${PANEL_PASSWORD}; Path=/; HttpOnly; SameSite=Strict`);
    return res.json({ ok: true });
  }
  res.status(401).json({ ok: false });
});

app.use(requireAuth);
// ─────────────────────────────────────────────────────────────────────────────

const PAGE = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${BOT_NAME}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Segoe UI', sans-serif; background: #0d1117; color: #e6edf3; min-height: 100vh; padding: 30px 16px; }
    .wrap { max-width: 880px; margin: 0 auto; }
    h1 { font-size: 2rem; color: #25D366; margin-bottom: 6px; text-align: center; }
    .subtitle { color: #8b949e; margin-bottom: 30px; font-size: 0.9rem; text-align: center; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 20px; }
    @media (min-width: 720px) { .grid { grid-template-columns: 1fr 1fr; } .full { grid-column: 1 / -1; } }
    .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 24px; }
    .card h2 { color: #25D366; font-size: 1rem; margin-bottom: 16px; text-transform: uppercase; letter-spacing: 1px; display: flex; justify-content: space-between; align-items: center; }
    .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #21262d; font-size: 0.9rem; }
    .stat:last-child { border-bottom: none; }
    .val { color: #25D366; font-weight: bold; }
    .status-ok { color: #25D366; } .status-wait { color: #f0883e; } .status-off { color: #f85149; }
    .qr-box { text-align: center; }
    .qr-box img { border-radius: 12px; border: 4px solid #25D366; max-width: 240px; width: 100%; margin: 12px 0; }
    .steps { list-style: none; counter-reset: steps; text-align: left; margin: 8px 0; }
    .steps li { counter-increment: steps; padding: 6px 0 6px 28px; position: relative; font-size: 0.85rem; color: #c9d1d9; }
    .steps li::before { content: counter(steps); position: absolute; left: 0; background: #25D366; color: #000; border-radius: 50%; width: 20px; height: 20px; font-size: 0.75rem; font-weight: bold; display: flex; align-items: center; justify-content: center; }
    .connected-msg { text-align: center; padding: 20px; }
    .connected-msg .icon { font-size: 3rem; }
    .connected-msg p { color: #8b949e; margin-top: 8px; }
    button { background: #25D366; color: #000; border: 0; border-radius: 8px; padding: 10px 16px; font-weight: bold; cursor: pointer; font-size: 0.9rem; }
    button:hover { filter: brightness(1.1); }
    button.danger { background: #f85149; color: #fff; }
    button.ghost { background: transparent; color: #8b949e; border: 1px solid #30363d; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .pedido { background: #0d1117; border: 1px solid #30363d; border-radius: 10px; padding: 14px; margin-bottom: 12px; }
    .pedido-primero { border-color: #25D366; box-shadow: 0 0 0 1px #25D36655; }
    .cola-pos { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 0.75rem; font-weight: bold; margin-right: 8px; background: #21262d; color: #c9d1d9; border: 1px solid #30363d; }
    .cola-primero { background: #25D366; color: #000; border-color: #25D366; }
    .pedido-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; }
    .pedido-num { color: #25D366; font-weight: bold; font-size: 0.9rem; }
    .pedido-fecha { color: #8b949e; font-size: 0.75rem; }
    .pedido-detalle { font-size: 0.85rem; color: #c9d1d9; line-height: 1.5; margin-bottom: 10px; }
    .pedido-detalle strong { color: #e6edf3; }
    .pedido-total { color: #25D366; font-weight: bold; font-size: 1rem; margin: 6px 0; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 10px; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.5px; margin-left: 6px; }
    .badge-pendiente { background: #f0883e; color: #000; }
    .badge-listo { background: #25D366; color: #000; }
    .badge-entregado { background: #6e7681; color: #fff; }
    .empty { text-align: center; color: #8b949e; padding: 30px 10px; font-size: 0.9rem; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .updated { font-size: 0.7rem; color: #6e7681; text-align: center; margin-top: 16px; }
    .precios-grid { display: grid; grid-template-columns: 1fr; gap: 10px; }
    @media (min-width: 600px) { .precios-grid { grid-template-columns: 1fr 1fr; } }
    .precio-row { display: flex; align-items: center; justify-content: space-between; padding: 8px 12px; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; }
    .precio-row label { font-size: 0.85rem; color: #c9d1d9; }
    textarea { width: 100%; background: #0d1117; border: 1px solid #30363d; border-radius: 8px; color: #c9d1d9; padding: 10px 12px; font-size: 0.9rem; font-family: inherit; resize: vertical; box-sizing: border-box; }
    textarea:focus { outline: none; border-color: #25D366; }
    .precio-row .input-wrap { display: flex; align-items: center; gap: 4px; }
    .precio-row span { color: #8b949e; font-size: 0.85rem; }
    .precio-row input { background: #161b22; border: 1px solid #30363d; color: #e6edf3; padding: 6px 8px; border-radius: 6px; width: 90px; font-size: 0.9rem; text-align: right; }
    .precio-row input:focus { outline: none; border-color: #25D366; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>🤖 ${BOT_NAME}</h1>
    <p class="subtitle">Panel de control · Fotocopiadora · <a href="/difusion" style="color:#25D366;font-weight:bold;">📣 Ir al panel de Difusión masiva →</a></p>

    <div class="grid">
      <div class="card">
        <h2>📊 Estado</h2>
        <div id="stats"></div>
      </div>

      <div class="card qr-box">
        <h2>📱 WhatsApp <button class="ghost" onclick="desvincular()" style="font-size:0.7rem;padding:4px 10px;">🔄 Generar nuevo QR</button></h2>
        <div id="qr"></div>
      </div>

      <div class="card full">
        <h2>
          <span>🧾 Pedidos <span id="pedidosCount" class="val"></span></span>
          <button class="ghost" onclick="limpiarEntregados()" style="font-size:0.7rem;padding:4px 10px;">🗑️ Limpiar entregados</button>
        </h2>
        <div id="pedidos"></div>
      </div>

      <div class="card full">
        <h2>
          <span>🕒 Horario de atención</span>
          <button class="ghost" onclick="restablecerHorario()" style="font-size:0.7rem;padding:4px 10px;">↺ Restablecer</button>
        </h2>
        <textarea id="horarioInput" rows="2" placeholder="Ej: Lunes a Viernes de 9 a 18 · Sábados de 9 a 13"></textarea>
        <div class="row" style="margin-top:10px;">
          <button onclick="guardarHorario()">💾 Guardar horario</button>
          <span id="horarioMsg" style="font-size:0.8rem;color:#8b949e;align-self:center;"></span>
        </div>
        <p style="font-size:0.75rem;color:#8b949e;margin-top:8px;">Este horario se muestra en el mensaje de bienvenida del bot.</p>
      </div>

      <div class="card full">
        <h2 style="cursor:pointer;user-select:none;" onclick="togglePrecios()">
          <span><span id="preciosCaret">▶</span> 💵 Precios</span>
          <button class="ghost" onclick="event.stopPropagation(); restablecerPrecios()" style="font-size:0.7rem;padding:4px 10px;">↺ Restablecer</button>
        </h2>
        <div id="preciosBody" style="display:none;">
          <div id="precios"></div>
          <div class="row" style="margin-top:14px;">
            <button onclick="guardarPrecios()">💾 Guardar precios</button>
            <span id="preciosMsg" style="font-size:0.8rem;color:#8b949e;align-self:center;"></span>
          </div>
        </div>
      </div>
    </div>

    <p class="updated" id="updated"></p>
  </div>

<script>
function fmt(n) { return new Intl.NumberFormat('es-AR').format(n); }

function pintarStats(s) {
  const cls = s.botStatus === 'conectado' ? 'status-ok' : s.botStatus === 'esperando_qr' ? 'status-wait' : 'status-off';
  document.getElementById('stats').innerHTML = \`
    <div class="stat"><span>Estado</span><span class="val \${cls}">\${s.botStatus.toUpperCase().replace('_',' ')}</span></div>
    <div class="stat"><span>Uptime</span><span class="val">\${s.uptimeMin} min</span></div>
    <div class="stat"><span>Mensajes recibidos</span><span class="val">\${s.recibidos}</span></div>
    <div class="stat"><span>Mensajes respondidos</span><span class="val">\${s.respondidos}</span></div>
    <div class="stat"><span>Usuarios únicos</span><span class="val">\${s.usuarios}</span></div>
    <div class="stat"><span>Pedidos pendientes</span><span class="val">\${s.pendientes}</span></div>
  \`;
}

function pintarQR(s) {
  const c = document.getElementById('qr');
  if (s.botStatus === 'conectado') {
    c.innerHTML = '<div class="connected-msg"><div class="icon">✅</div><p>WhatsApp conectado.<br>El bot está activo y respondiendo.</p></div>';
  } else if (s.qr) {
    c.innerHTML = \`
      <img src="\${s.qr}" alt="QR Code">
      <ol class="steps">
        <li>Abrí WhatsApp en tu teléfono</li>
        <li>Tocá los 3 puntos → <strong>Dispositivos vinculados</strong></li>
        <li>Tocá <strong>Vincular un dispositivo</strong></li>
        <li>Escaneá este código QR</li>
      </ol>\`;
  } else {
    c.innerHTML = '<div class="connected-msg"><div class="icon">⏳</div><p>Generando código QR...<br>Esperá unos segundos.</p></div>';
  }
}

function pintarPedidos(pedidos) {
  const c = document.getElementById('pedidos');
  const pendientes = pedidos.filter(p => p.estado === 'pendiente');
  const enCola = pedidos.filter(p => p.estado !== 'entregado');
  document.getElementById('pedidosCount').textContent = enCola.length ? \`(\${enCola.length})\` : '';
  if (!pedidos.length) {
    c.innerHTML = '<div class="empty">Todavía no hay pedidos confirmados.</div>';
    return;
  }
  // Cola por orden de llegada: el más antiguo pendiente es el #1
  const ordenCola = pendientes.slice().sort((a,b) => new Date(a.fecha) - new Date(b.fecha));
  const posiciones = {};
  ordenCola.forEach((p, i) => { posiciones[p.id] = i + 1; });

  c.innerHTML = pedidos.slice().sort((a,b) => new Date(a.fecha) - new Date(b.fecha)).map(p => {
    const fecha = new Date(p.fecha).toLocaleString('es-AR');
    const servicios = { copias:'🖨️ Fotocopias', impresiones:'📄 Impresiones', escaneos:'🔍 Escaneos', encuadernacion:'📚 Encuadernación' };
    const detalles = [];
    if (p.cantidad) detalles.push(\`<strong>\${p.cantidad}</strong> \${p.servicio==='escaneos'?'págs':'hojas'}\`);
    if (p.color) detalles.push(p.color === 'color' ? '🌈 Color' : '⚫ B/N');
    if (p.tamano) detalles.push(p.tamano.toUpperCase());
    if (p.caras) detalles.push(p.caras === 'dos' ? 'Doble faz' : 'Una cara');
    if (p.encuadernacion && p.encuadernacion !== 'ninguna') detalles.push('📚 ' + p.encuadernacion);
    detalles.push('🏪 Retira en local');
    const badge = p.estado === 'listo' ? '<span class="badge badge-listo">Listo</span>'
                : p.estado === 'entregado' ? '<span class="badge badge-entregado">Entregado</span>'
                : '<span class="badge badge-pendiente">Pendiente</span>';
    const acciones = p.estado === 'pendiente'
      ? \`<button onclick="marcarListo('\${p.id}')">📢 Avisar que está listo</button>\`
      : p.estado === 'listo'
        ? \`<button onclick="marcarEntregado('\${p.id}')" class="ghost">✅ Marcar entregado</button>\`
        : \`<button onclick="eliminarPedido('\${p.id}')" class="danger">🗑️ Eliminar</button>\`;
    const tel = p.telefono || (p.userId || '').split('@')[0].split(':')[0].replace(/\D/g, '');
    const pos = posiciones[p.id];
    const colaTag = pos
      ? \`<span class=\"cola-pos cola-\${pos===1?'primero':'normal'}\">\${pos===1?'🥇':pos===2?'🥈':pos===3?'🥉':'#'+pos} en la cola</span>\`
      : '';
    // Adjuntos: generar HTML si hay attachments en el pedido (sin template literals anidados)
    let attachHtml = '';
    if (p.attachment && p.attachment.length) {
      attachHtml = '<div class="adjuntos" style="margin-top:6px;">';
      p.attachment.forEach(a => {
        if (a.url && a.url.startsWith('/attachments/')) {
          if (a.mime && a.mime.startsWith('image/')) {
            attachHtml += '<a href="' + a.url + '" target="_blank"><img src="' + a.url + '" alt="' + (a.name||'adjunto') + '" style="max-height:120px; border:1px solid #333; margin:6px 6px 0 0;"/></a>';
          } else {
            attachHtml += '<a href="' + a.url + '" target="_blank">' + (a.name || 'Archivo adjunto') + '</a> ';
          }
        } else {
          attachHtml += '<a href="' + (a.url || '#') + '" target="_blank">' + (a.name || 'Archivo adjunto') + '</a> ';
        }
      });
      attachHtml += '</div>';
    }
    return \`
      <div class=\"pedido \${pos===1?'pedido-primero':''}\">
        <div class=\"pedido-head\">
          <span class=\"pedido-num\">\${colaTag} #\${p.numero} · \${p.nombre || 'Sin nombre'} \${badge}</span>
          <span class=\"pedido-fecha\">\${fecha}</span>
        </div>
        <div class=\"pedido-detalle\">
          \${servicios[p.servicio] || p.servicio} · \${detalles.join(' · ')}<br>
          📞 +\${tel}
        </div>
        \${attachHtml}
        <div class=\"pedido-total\">💵 $\${fmt(p.total)}</div>
        <div class=\"row\">\${acciones}</div>
      </div>\`;
  }).join('');
}

const ETIQUETAS_PRECIOS = {
  copia_bn: { label: '🖨️ Copia B/N', sufijo: '/ hoja' },
  copia_color: { label: '🌈 Copia Color', sufijo: '/ hoja' },
  impresion_bn: { label: '📄 Impresión B/N', sufijo: '/ hoja' },
  impresion_color: { label: '📄 Impresión Color', sufijo: '/ hoja' },
  escaneo: { label: '🔍 Escaneo', sufijo: '/ página' },
  encuadernacion_espiral: { label: '📚 Encuadernación Espiral', sufijo: '' },
  encuadernacion_anillado: { label: '📚 Encuadernación Anillado', sufijo: '' },
  encuadernacion_termico: { label: '📚 Encuadernación Térmica', sufijo: '' },
};

function togglePrecios() {
  const body = document.getElementById('preciosBody');
  const caret = document.getElementById('preciosCaret');
  const abierto = body.style.display !== 'none';
  body.style.display = abierto ? 'none' : 'block';
  caret.textContent = abierto ? '▶' : '▼';
}

let preciosLocal = null;

function pintarPrecios(precios) {
  preciosLocal = { ...precios };
  const c = document.getElementById('precios');
  const orden = ['copia_bn','copia_color','impresion_bn','impresion_color','escaneo','encuadernacion_espiral','encuadernacion_anillado','encuadernacion_termico'];
  c.innerHTML = '<div class="precios-grid">' + orden.map(k => {
    const e = ETIQUETAS_PRECIOS[k] || { label: k, sufijo: '' };
    return \`<div class="precio-row">
      <label>\${e.label}</label>
      <div class="input-wrap">
        <span>$</span>
        <input type="number" min="0" step="1" id="precio_\${k}" value="\${precios[k] ?? 0}">
        <span>\${e.sufijo}</span>
      </div>
    </div>\`;
  }).join('') + '</div>';
}

async function guardarPrecios() {
  const orden = Object.keys(ETIQUETAS_PRECIOS);
  const body = {};
  for (const k of orden) {
    const el = document.getElementById('precio_' + k);
    if (el) body[k] = Number(el.value);
  }
  const r = await fetch('/api/precios', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body) });
  const d = await r.json();
  const msg = document.getElementById('preciosMsg');
  if (d.ok) {
    msg.textContent = '✅ Precios guardados';
    msg.style.color = '#25D366';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } else {
    msg.textContent = '⚠️ Error al guardar';
    msg.style.color = '#f85149';
  }
}

async function restablecerPrecios() {
  if (!confirm('¿Restablecer los precios a los valores iniciales?')) return;
  const r = await fetch('/api/precios/reset', { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    pintarPrecios(d.precios);
    const msg = document.getElementById('preciosMsg');
    msg.textContent = '↺ Precios restablecidos';
    msg.style.color = '#25D366';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  }
}

async function guardarHorario() {
  const texto = document.getElementById('horarioInput').value;
  const r = await fetch('/api/horario', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto })
  });
  const d = await r.json();
  const msg = document.getElementById('horarioMsg');
  if (d.ok) {
    msg.textContent = '✅ Horario guardado';
    msg.style.color = '#25D366';
    document.getElementById('horarioInput').value = d.horario;
    setTimeout(() => { msg.textContent = ''; }, 3000);
  } else {
    msg.textContent = '⚠️ Error al guardar';
    msg.style.color = '#f85149';
  }
}

async function restablecerHorario() {
  if (!confirm('¿Restablecer el horario por defecto?')) return;
  const r = await fetch('/api/horario/reset', { method: 'POST' });
  const d = await r.json();
  if (d.ok) {
    document.getElementById('horarioInput').value = d.horario;
    const msg = document.getElementById('horarioMsg');
    msg.textContent = '↺ Horario restablecido';
    msg.style.color = '#25D366';
    setTimeout(() => { msg.textContent = ''; }, 3000);
  }
}

let preciosCargados = false;
let horarioCargado = false;
async function refresh() {
  try {
    const r = await fetch('/api/state');
    const data = await r.json();
    pintarStats(data);
    pintarQR(data);
    pintarPedidos(data.pedidos);
    if (!preciosCargados && data.precios) { pintarPrecios(data.precios); preciosCargados = true; }
    if (!horarioCargado && data.horario !== undefined) {
      document.getElementById('horarioInput').value = data.horario;
      horarioCargado = true;
    }
    document.getElementById('updated').textContent = 'Actualizado: ' + new Date().toLocaleTimeString();
  } catch (e) {
    document.getElementById('updated').textContent = '⚠️ Sin conexión con el servidor...';
  }
}

async function marcarListo(id) {
  if (!confirm('¿Avisar al cliente que su pedido está listo para retirar?')) return;
  const r = await fetch('/api/pedidos/' + id + '/listo', { method: 'POST' });
  const d = await r.json();
  if (d.ok) { refresh(); } else { alert('Error: ' + (d.error || 'no se pudo enviar')); }
}

async function marcarEntregado(id) {
  await fetch('/api/pedidos/' + id + '/entregado', { method: 'POST' });
  refresh();
}

async function eliminarPedido(id) {
  if (!confirm('¿Eliminar este pedido del panel? (no se puede deshacer)')) return;
  await fetch('/api/pedidos/' + id, { method: 'DELETE' });
  refresh();
}

async function limpiarEntregados() {
  if (!confirm('¿Eliminar todos los pedidos entregados del panel?')) return;
  const r = await fetch('/api/pedidos/entregados', { method: 'DELETE' });
  const d = await r.json();
  if (d.ok) refresh();
}

async function desvincular() {
  if (!confirm('Esto cierra la sesión actual y genera un QR nuevo. ¿Continuar?')) return;
  await fetch('/api/desvincular', { method: 'POST' });
  setTimeout(refresh, 1500);
}

refresh();
setInterval(refresh, 4000);
</script>
</body>
</html>`;

app.get('/', (req, res) => res.send(PAGE));

app.get('/api/state', (req, res) => {
  const uptimeMin = Math.floor((new Date() - stats.inicio) / 60000);
  res.json({
    botStatus,
    qr: qrImageBase64,
    uptimeMin,
    recibidos: stats.recibidos,
    respondidos: stats.respondidos,
    usuarios: stats.usuarios.size,
    pendientes: pedidos.filter(p => p.estado === 'pendiente').length,
    pedidos,
    precios: flujo.getPreciosPlano(),
    horario: flujo.getHorario(),
  });
});

// ─── API DIFUSIÓN MASIVA (clientes desde Google Sheets) ─────────────────────
app.get('/api/config', (req, res) => {
  res.json({ ok: true, sheetId: SHEET_ID, sheetGid: SHEET_GID, plantillaDefault: PLANTILLA_DEFAULT, totalCache: clientesCache.length, cacheFecha: clientesCacheFecha });
});

app.post('/api/config', (req, res) => {
  if (typeof req.body?.sheetId === 'string') SHEET_ID = req.body.sheetId.trim();
  if (typeof req.body?.sheetGid === 'string') SHEET_GID = req.body.sheetGid.trim() || '0';
  console.log('⚙️ Config difusión:', { SHEET_ID, SHEET_GID });
  res.json({ ok: true, sheetId: SHEET_ID, sheetGid: SHEET_GID });
});

// Carga el Sheet y lo guarda en caché
app.post('/api/clientes/recargar', async (req, res) => {
  try {
    if (typeof req.body?.sheetId === 'string' && req.body.sheetId.trim()) SHEET_ID = req.body.sheetId.trim();
    if (typeof req.body?.sheetGid === 'string' && req.body.sheetGid.trim()) SHEET_GID = req.body.sheetGid.trim();
    const lista = await clientesMod.fetchClientes(SHEET_ID, SHEET_GID);
    clientesCache = lista;
    clientesCacheFecha = new Date().toISOString();
    const validos = lista.filter(c => c.telefono_valido).length;
    console.log(`📥 Clientes cargados: ${lista.length} filas (${validos} válidos)`);
    res.json({ ok: true, total: lista.length, validos, invalidos: lista.length - validos, cacheFecha: clientesCacheFecha, clientes: lista.slice(0, 500) });
  } catch (e) {
    console.error('Error cargando clientes:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Lista con filtros + orden (usa caché; si viene ?recargar=1, recarga primero)
app.get('/api/clientes', async (req, res) => {
  try {
    if (req.query.recargar === '1' || !clientesCache.length) {
      if (!SHEET_ID && req.query.sheetId) SHEET_ID = String(req.query.sheetId);
      if (req.query.gid) SHEET_GID = String(req.query.gid);
      if (SHEET_ID) {
        clientesCache = await clientesMod.fetchClientes(SHEET_ID, SHEET_GID);
        clientesCacheFecha = new Date().toISOString();
      }
    }
    const filtrados = clientesMod.filtrarOrdenar(clientesCache, {
      buscar: req.query.buscar || '',
      desdeSucedio: req.query.desdeSucedio || '',
      hastaSucedio: req.query.hastaSucedio || '',
      desdeSubida: req.query.desdeSubida || '',
      hastaSubida: req.query.hastaSubida || '',
      soloValidos: req.query.soloValidos !== '0',
      orden: req.query.orden || 'fecha_subida',
      dir: req.query.dir || 'desc',
    });
    res.json({ ok: true, total: clientesCache.length, filtrados: filtrados.length, cacheFecha: clientesCacheFecha, clientes: filtrados.slice(0, 1000) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Vista previa del mensaje personalizado para un cliente
app.post('/api/clientes/preview', (req, res) => {
  const { plantilla = '', cliente = {} } = req.body || {};
  res.json({ ok: true, texto: clientesMod.aplicarPlantilla(plantilla, cliente) });
});

// ─── Control de envío masivo ────────────────────────────────────────────────
app.get('/api/difusion/estado', (req, res) => res.json({ ok: true, botStatus, ...difusion.getEstado() }));
app.get('/api/difusion/historico', (req, res) => res.json({ ok: true, historico: difusion.getHistorico() }));

app.post('/api/difusion/iniciar', async (req, res) => {
  if (!sock || botStatus !== 'conectado') return res.status(503).json({ ok: false, error: 'Bot no conectado. Escaneá el QR primero.' });
  const { plantilla = '', filtros = {}, telefonos = null, minDelayS = 6, maxDelayS = 14, testMode = false } = req.body || {};
  if (!plantilla.trim()) return res.status(400).json({ ok: false, error: 'La plantilla del mensaje está vacía.' });
  try {
    if (!clientesCache.length && SHEET_ID) {
      clientesCache = await clientesMod.fetchClientes(SHEET_ID, SHEET_GID);
      clientesCacheFecha = new Date().toISOString();
    }
    let lista = clientesMod.filtrarOrdenar(clientesCache, { soloValidos: true, orden: 'fecha_subida', dir: 'desc', ...filtros });
    if (Array.isArray(telefonos) && telefonos.length) {
      const set = new Set(telefonos.map(t => String(t).replace(/\D/g, '')));
      lista = lista.filter(c => set.has(c.telefono));
    }
    if (!lista.length) return res.status(400).json({ ok: false, error: 'No hay destinatarios con esos filtros.' });
    res.json({ ok: true, total: lista.length, mensaje: `Difusión iniciada para ${lista.length} contactos.` });
    // Enviar en segundo plano (no bloquear la respuesta)
    difusion.iniciarDifusion(lista, plantilla, async (jid, texto) => {
      await enviarMensaje(jid, { text: texto });
    }, { minDelayS: Number(minDelayS) || 6, maxDelayS: Number(maxDelayS) || 14, testMode: !!testMode })
      .catch(e => console.error('Difusión error:', e.message));
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/difusion/pausar', (req, res) => res.json({ ok: true, ...difusion.pausar() }));
app.post('/api/difusion/reanudar', (req, res) => res.json({ ok: true, ...difusion.reanudar() }));
app.post('/api/difusion/cancelar', (req, res) => res.json({ ok: true, ...difusion.cancelar() }));

// Panel de difusión (QR + tabla + filtros + envío)
app.get('/difusion', (req, res) => res.sendFile(path.join(__dirname, 'difusion-panel.html')));

app.get('/api/horario', (req, res) => res.json({ ok: true, horario: flujo.getHorario() }));

app.post('/api/horario', (req, res) => {
  try {
    const texto = (req.body && typeof req.body.texto === 'string') ? req.body.texto : '';
    const actualizado = flujo.setHorario(texto);
    console.log('🕒 Horario actualizado:', actualizado);
    res.json({ ok: true, horario: actualizado });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/horario/reset', (req, res) => {
  const actualizado = flujo.setHorario(flujo.HORARIO_DEFAULT);
  res.json({ ok: true, horario: actualizado });
});

app.get('/api/precios', (req, res) => res.json({ ok: true, precios: flujo.getPreciosPlano() }));

app.post('/api/precios', (req, res) => {
  try {
    const actualizados = flujo.setPrecios(req.body || {});
    console.log('💵 Precios actualizados:', actualizados);
    res.json({ ok: true, precios: actualizados });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/precios/reset', (req, res) => {
  try {
    const actualizados = flujo.setPrecios(flujo.PRECIOS_DEFAULT);
    console.log('↺ Precios restablecidos a valores por defecto');
    res.json({ ok: true, precios: actualizados });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pedidos/:id/listo', async (req, res) => {
  const p = pedidos.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
  if (!sock || botStatus !== 'conectado') return res.status(503).json({ ok: false, error: 'Bot no conectado' });
  try {
    const mensaje = `✅ *¡Tu pedido #${p.numero} está listo!*\n\nHola ${p.nombre || ''} 👋\nTu pedido ya está terminado, ya podés retirarlo en el local. 🏪\n\nTotal: *$${p.total.toLocaleString('es-AR')}*\n\n¡Gracias por elegirnos! 🙌`;
    await enviarMensaje(p.userId, { text: mensaje });
    p.estado = 'listo';
    p.avisado = new Date().toISOString();
    guardarPedidos();
    console.log(`📢 Aviso enviado al cliente del pedido #${p.numero}`);
    res.json({ ok: true });
  } catch (e) {
    console.error('Error avisando:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.post('/api/pedidos/:id/entregado', (req, res) => {
  const p = pedidos.find(x => x.id === req.params.id);
  if (!p) return res.status(404).json({ ok: false });
  p.estado = 'entregado';
  p.entregado = new Date().toISOString();
  guardarPedidos();
  res.json({ ok: true });
});

app.delete('/api/pedidos/entregados', (req, res) => {
  const antes = pedidos.length;
  pedidos = pedidos.filter(p => p.estado !== 'entregado');
  guardarPedidos();
  const eliminados = antes - pedidos.length;
  console.log(`🗑️ ${eliminados} pedido(s) entregado(s) eliminado(s)`);
  res.json({ ok: true, eliminados });
});

app.delete('/api/pedidos/:id', (req, res) => {
  const idx = pedidos.findIndex(x => x.id === req.params.id);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Pedido no encontrado' });
  const [eliminado] = pedidos.splice(idx, 1);
  guardarPedidos();
  console.log(`🗑️ Pedido #${eliminado.numero} eliminado`);
  res.json({ ok: true });
});

app.post('/api/desvincular', async (req, res) => {
  try {
    // Invalidar el socket actual
    socketGen++;
    const viejo = sock;
    sock = null;
    if (viejo) {
      try { viejo.ev.removeAllListeners(); } catch (e) {}
      try { await viejo.logout(); } catch (e) {}
      try { viejo.end?.(new Error('manual logout')); } catch (e) {}
    }
    // Borrar credenciales para forzar QR nuevo
    try {
      const dir = AUTH_DIR;
      if (fs.existsSync(dir)) {
        for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
      }
    } catch (e) { console.error('No se pudo limpiar auth_info:', e.message); }
    botStatus = 'desconectado';
    qrImageBase64 = null;
    console.log('🔌 Sesión desvinculada manualmente. Iniciando bot de nuevo...');
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    programarReconexion(1500);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/ping', (req, res) => res.json({ status: 'ok', botStatus, uptime: process.uptime() }));

app.listen(PORT, () => console.log(`🌐 Panel web activo en puerto ${PORT}`));

// ─── WHATSAPP CON BAILEYS ─────────────────────────────────────────────────────
async function iniciarBot() {
  if (iniciando) {
    console.log('⏭️  Ya hay un arranque en curso, ignorando...');
    return;
  }
  iniciando = true;

  // Cerrar y limpiar el socket anterior si existe
  if (sock) {
    const viejo = sock;
    sock = null;
    try { viejo.ev.removeAllListeners(); } catch (e) {}
    try { viejo.end?.(new Error('reinicio')); } catch (e) {}
  }

  const miGen = ++socketGen;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    const nuevoSock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['AsistenteIA', 'Chrome', '1.0'],
    });
    sock = nuevoSock;

    // Helper: solo procesar eventos del socket vigente
    const esVigente = () => miGen === socketGen && sock === nuevoSock;

    nuevoSock.ev.on('connection.update', async (update) => {
      if (!esVigente()) return; // ignorar eventos de sockets viejos
      // Liberar el candado en el primer evento real (qr, open o close)
      if (iniciando) iniciando = false;
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        const esNuevo = botStatus !== 'esperando_qr';
        botStatus = 'esperando_qr';
        if (esNuevo) console.log('\n📱 QR generado — escanéalo en el panel web\n');
        else console.log('🔄 QR rotado (esperando escaneo...)');
        try { qrImageBase64 = await qrcode.toDataURL(qr); }
        catch (e) { console.error('Error generando QR imagen:', e); }
      }

      if (connection === 'close') {
        const code = lastDisconnect?.error instanceof Boom ? lastDisconnect.error.output?.statusCode : null;
        const loggedOut = code === DisconnectReason.loggedOut;
        botStatus = 'desconectado';
        qrImageBase64 = null;
        try { nuevoSock.ev.removeAllListeners(); } catch (e) {}
        if (sock === nuevoSock) sock = null;

        if (loggedOut) {
          try {
            const dir = AUTH_DIR;
            if (fs.existsSync(dir)) {
              for (const f of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, f));
            }
          } catch (e) { /* ignorar */ }
          console.log('📵 Sesión cerrada (logout). Generando QR nuevo...');
          programarReconexion(2000);
        } else {
          console.log('📵 Desconectado. Reconectando en 3s... (code:', code, ')');
          programarReconexion(3000);
        }
      }

      if (connection === 'open') {
        botStatus = 'conectado';
        qrImageBase64 = null;
        console.log(`\n✅ WhatsApp conectado! Bot "${BOT_NAME}" activo.\n`);
      }
    });

    nuevoSock.ev.on('creds.update', saveCreds);

    // Mapear @lid → número real de teléfono.
    // Baileys emite contacts.upsert con los datos reales al recibir el primer mensaje de cada contacto.
    nuevoSock.ev.on('contacts.upsert', (contacts) => {
      if (!esVigente()) return;
      for (const c of contacts) {
        console.log('[DEBUG contacts.upsert]', JSON.stringify(c));
        const jid = c.id || '';
        // El número puede estar en el JID si es @s.whatsapp.net
        if (jid.includes('@s.whatsapp.net')) {
          const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (phone.length >= 10) {
            lidToPhone.set(jid, phone);
            // Si tiene lid asociado, mapear lid → teléfono también
            if (c.lid) lidToPhone.set(c.lid, phone);
          }
        }
        // Si el contacto en sí es un @lid pero tiene campo lid con el JID real
        if (jid.includes('@lid') && c.lid && c.lid.includes('@s.whatsapp.net')) {
          const phone = c.lid.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (phone.length >= 10) lidToPhone.set(jid, phone);
        }
      }
    });
    // contacts.update también puede traer el mapeo lid↔jid
    nuevoSock.ev.on('contacts.update', (updates) => {
      if (!esVigente()) return;
      for (const c of updates) {
        console.log('[DEBUG contacts.update]', JSON.stringify(c));
        const jid = c.id || '';
        if (jid.includes('@s.whatsapp.net')) {
          const phone = jid.split('@')[0].split(':')[0].replace(/\D/g, '');
          if (phone.length >= 10) {
            lidToPhone.set(jid, phone);
            if (c.lid) lidToPhone.set(c.lid, phone);
          }
        }
      }
    });

    nuevoSock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (!esVigente()) return;
      console.log(`🔔 messages.upsert (type=${type}, count=${messages.length})`);
      if (type !== 'notify' && type !== 'append') return;
      // Capturar ecos fromMe con @s.whatsapp.net para mapear @lid → teléfono real.
      // Estos mensajes llegan cuando el bot responde — su remoteJid tiene el número real.
      for (const m of messages) {
        if (m.key?.fromMe && m.key?.remoteJid?.endsWith('@s.whatsapp.net')) {
          const num = m.key.remoteJid.split('@')[0].replace(/\D/g, '');
          if (num.length >= 10) {
            // Buscar si hay algún @lid en lidToPhone sin número asignado todavía
            // Guardamos el último número visto para asignarlo al próximo @lid que llegue
            lidToPhone.set('__last_phone__', num);
          }
        }
      }

      for (const msg of messages) {
        const from = msg.key.remoteJid;
        const fromMe = !!msg.key.fromMe;
        // Resolver número real de teléfono desde el JID.
        // Si es @s.whatsapp.net el número está directo en el JID.
        // Si es @lid (ID anónimo de WhatsApp), lo buscamos en el mapa
        // que se llena automáticamente con el evento contacts.upsert.
        const resolverTelefono = () => {
          // Caso 1: JID normal con número de teléfono directo
          if (from && from.includes('@s.whatsapp.net')) {
            const num = from.split('@')[0].split(':')[0].replace(/\D/g, '');
            lidToPhone.set(from, num); // cachear para usos futuros
            return num;
          }
          // Caso 2: ya lo resolvimos antes
          const cached = lidToPhone.get(from);
          if (cached) return cached;
          // Caso 3: usar el último número real visto en los ecos fromMe @s.whatsapp.net
          const lastPhone = lidToPhone.get('__last_phone__');
          if (lastPhone && lastPhone.length >= 10) {
            lidToPhone.set(from, lastPhone); // asociar definitivamente este @lid al número
            return lastPhone;
          }
          // Caso 4: participant (grupos)
          const participant = msg.key?.participant;
          if (participant && participant.includes('@s.whatsapp.net')) {
            const num = participant.split('@')[0].split(':')[0].replace(/\D/g, '');
            if (num.length >= 10) { lidToPhone.set(from, num); return num; }
          }
          return (from || '').split('@')[0].split(':')[0].replace(/\D/g, '');
        };
        // Resolver y cachear el teléfono ni bien llega el mensaje (no solo al confirmar pedido)
        const telefonoCacheado = resolverTelefono();
        if (telefonoCacheado && telefonoCacheado.length >= 10) {
          lidToPhone.set(from, telefonoCacheado);
        }
        const tipos = msg.message ? Object.keys(msg.message).join(',') : 'sin-message';
        console.log(`   → from=${from} fromMe=${fromMe} tipos=${tipos}`);

        if (!msg.message) continue;
        if (!from || from === 'status@broadcast') continue;
        const isGroup = from.endsWith('@g.us');
        // Si es @lid, el número real de teléfono NO está en el JID.
        // Lo obtenemos del eco fromMe que Baileys envía en paralelo con JID @s.whatsapp.net.
        // Ese eco tiene from=NUMERO@s.whatsapp.net y fromMe=true — lo capturamos en phoneByLid.
        if (from.endsWith('@lid') && !lidToPhone.has(from)) {
          // Buscar en los mensajes del mismo batch si hay uno @s.whatsapp.net fromMe
          const ecoReal = messages.find(m =>
            m !== msg &&
            m.key?.fromMe === true &&
            m.key?.remoteJid?.endsWith('@s.whatsapp.net')
          );
          if (ecoReal) {
            const num = ecoReal.key.remoteJid.split('@')[0].replace(/\D/g, '');
            if (num.length >= 10) lidToPhone.set(from, num);
          }
        }

        // Desempaquetar mensajes envueltos (efímeros, vista única, etc.)
        const inner = msg.message?.ephemeralMessage?.message
          || msg.message?.viewOnceMessage?.message
          || msg.message?.viewOnceMessageV2?.message
          || msg.message?.documentWithCaptionMessage?.message
          || msg.message;

        let texto = inner?.conversation
          || inner?.extendedTextMessage?.text
          || inner?.imageMessage?.caption
          || inner?.videoMessage?.caption
          || '';

        // Si llega adjunto (imagen, pdf, etc.), descárgalo y asócialo al pedido en curso
        const hasMedia = inner?.imageMessage || inner?.documentMessage || inner?.videoMessage;
        if (hasMedia) {
          try {
            // Usar la función importada downloadMediaMessage de Baileys
            const buffer = await downloadMediaMessage(msg, 'buffer', {}).catch(e => null);
            if (!buffer) {
              console.log('⚠️ No se pudo descargar media - método no disponible');
              continue;
            }
            let mime = inner?.imageMessage?.mimetype || inner?.documentMessage?.mimetype || inner?.videoMessage?.mimetype || '';
            // Si es PDF, contar páginas usando pdf-lib
            let pdfPages = 0;
            if (mime === 'application/pdf' || (inner?.documentMessage?.fileName || '').endsWith('.pdf')) {
              try {
                const loadedPdf = await PDFDocument.load(buffer);
                pdfPages = loadedPdf.getPageCount();
                if (typeof pdfPages !== 'number' || pdfPages < 0) pdfPages = 0;
                console.log(`📎 PDF detectado: ${pdfPages} páginas`);
              } catch (e) {
                console.log('⚠️ No se pudo leer páginas del PDF:', e.message);
              }
              // Guardar páginas en la sesión si existe
              const sesForPages = flujo.obtenerSesion(from);
              if (sesForPages) {
                sesForPages.pedido.pdfPages = pdfPages;
                flujo.guardarSesion(from, sesForPages);
              }
            }
            // Intentar obtener extensión del nombre original del archivo
            let ext = 'bin';
            const originalName = inner?.documentMessage?.fileName || inner?.imageMessage?.fileName || '';
            if (originalName && originalName.includes('.')) {
              ext = originalName.split('.').pop().split('?')[0].split(';')[0];
            } else if (mime) {
              const parts = mime.split('/');
              if (parts.length > 1) ext = parts[1].split(';')[0];
            }
            const name = `attachment_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
            const fullPath = path.join(ATTACHMENTS_DIR, name);
            fs.writeFileSync(fullPath, buffer);
            const url = '/attachments/' + name;
            // Asociar adjunto a pedido actual si hay sesión de flujo
            const ses = flujo.obtenerSesion(from);
            console.log(`📎 Adjuntando archivo: from=${from}, sesion=${ses ? 'SÍ (paso: ' + ses.paso + ')' : 'NO'}`);
            if (ses) {
              flujo.guardarAdjunto(from, { url, mime, name });
              console.log(`📎 Adjunto guardado en sesión: ${name}, mime=${mime}`);
              // Si está en paso de pedir archivo, avanzar según el tipo de archivo
              if (ses.paso === 'pedir_archivo') {
                // Verificar si es PDF con páginas contadas para impresiones
                if (ses.pedido.servicio === 'impresiones' && ses.pedido.pdfPages && ses.pedido.pdfPages > 0) {
                  ses.paso = 'copias_pdf';
                  flujo.guardarSesion(from, ses);
                  await enviarMensaje(from, { text: `📄 El PDF tiene ${ses.pedido.pdfPages} página(s). ¿Cuántas copias querés?\n\n_Ej: 2_` }, { quoted: msg });
                  continue;
                } else if (ses.pedido.servicio === 'encuadernacion') {
                  ses.paso = 'encuadernacion';
                  flujo.guardarSesion(from, ses);
                  const nextMsg = flujo.pedirEncuadernacion();
                  await enviarMensaje(from, { text: '📎 Archivo recibido. ' + nextMsg }, { quoted: msg });
                  continue;
                } else {
                  ses.paso = 'cantidad';
                  flujo.guardarSesion(from, ses);
                  const nextMsg = flujo.pedirCantidad();
                  await enviarMensaje(from, { text: '📎 Archivo recibido. ' + nextMsg }, { quoted: msg });
                  continue;
                }
              }
            } else {
              // Si no hay sesión activa, buscar el pedido pendiente más reciente de este usuario y adjuntarle el archivo
              console.log(`📎 No hay sesión activa, buscando pedido reciente para: ${from}`);
              const pedidosUsuario = pedidos.filter(p => p.userId === from && p.estado === 'pendiente');
              console.log(`📎 Pedidos pendientes encontrados: ${pedidosUsuario.length}`);
              const pedidoReciente = pedidosUsuario
                .sort((a, b) => new Date(b.fecha) - new Date(a.fecha))[0];
              if (pedidoReciente) {
                console.log(`📎 Adjuntando a pedido #${pedidoReciente.numero}`);
                pedidoReciente.attachment = (pedidoReciente.attachment || []).concat([{ url, mime, name }]);
                guardarPedidos();
                await enviarMensaje(from, { text: '📎 Archivo recibido y adjuntado a tu pedido #' + pedidoReciente.numero }, { quoted: msg });
                continue;
              } else {
                console.log(`📎 No se encontró pedido pendiente para: ${from}`);
              }
            }
          } catch (e) {
            console.error('Error descargando adjunto:', e?.message);
          }
        }

        // Si el mensaje fue enviado por el bot mismo, lo ignoramos (evita bucles).
        // Mensajes propios escritos desde el teléfono SÍ se procesan normalmente.
        if (fromMe && enviadosPorBot.has(msg.key.id)) {
          console.log(`⏭️  Mensaje propio del bot ignorado (eco)`);
          continue;
        }

        if (!texto.trim()) {
          console.log(`📭 Mensaje sin texto de ${from} (tipos: ${Object.keys(inner || {}).join(',')})`);
          continue;
        }

        // En grupos solo responde si usan !ia o /ia
        if (isGroup) {
          const lower = texto.toLowerCase();
          if (!lower.startsWith('!ia') && !lower.startsWith('/ia')) continue;
        }

        stats.recibidos++;
        stats.usuarios.add(from);
        console.log(`📨 [${new Date().toLocaleTimeString()}] ${from}: ${texto.substring(0, 60)}`);

        const lower = texto.toLowerCase().trim();
        if (lower === '!reset' || lower === '/reset') {
          conversaciones.delete(from);
          await enviarMensaje(from, { text: '🔄 Conversación reiniciada. ¡Hola! ¿En qué puedo ayudarte?' }, { quoted: msg });
          continue;
        }
        if (lower === '!ayuda' || lower === '/ayuda') {
          const ayuda = `🤖 *${BOT_NAME} - Comandos:*\n\n📋 *menu* → Hacer un pedido (fotocopias, impresiones, escaneos, encuadernación)\n✏️ Cualquier otro texto → la IA responde\n🔄 *!reset* → Borra el historial\n❌ *cancelar* → Sale del pedido en curso\n❓ *!ayuda* → Este mensaje\n\n_En grupos usa: !ia [pregunta]_`;
          await enviarMensaje(from, { text: ayuda }, { quoted: msg });
          continue;
        }

        // ─── FLUJO FOTOCOPIADORA ─────────────────────────────────────────
        const sesionFlujo = flujo.obtenerSesion(from);
        if (sesionFlujo || flujo.esDisparador(texto)) {
          const r = await flujo.manejar(from, texto, sesionFlujo);
          await enviarMensaje(from, { text: r.respuesta }, { quoted: msg });
          stats.respondidos++;
    if (r.terminado && r.pedido) {
      const numero = r.numero || String(Date.now()).slice(-6);
      const nuevo = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        numero,
        estado: 'pendiente',
        userId: from,
        telefono: resolverTelefono(),
        ...r.pedido,
      };
      pedidos.push(nuevo);
      guardarPedidos();
      console.log(`🆕 Pedido #${numero} agregado al panel`);
    }
          console.log(`📋 [flujo] paso=${sesionFlujo?.paso || 'inicio'} ${r.terminado ? '→ terminado' : ''}`);
          continue;
        }

        // Respuesta IA
        const respuesta = await preguntarIA(from, texto);
        await enviarMensaje(from, { text: respuesta }, { quoted: msg });
        stats.respondidos++;
        console.log(`✅ Respondido`);
      }
    });

    // NO liberar iniciando aquí — se libera en el primer connection.update
    // para evitar que un segundo iniciarBot() corra antes de que llegue el QR.
  } catch (err) {
    console.error('❌ Error iniciando bot:', err.message);
    iniciando = false;
    programarReconexion(5000);
  }
}

iniciarBot().catch(console.error);
