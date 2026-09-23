const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const PRECIOS_FILE = path.join(DATA_DIR, 'precios.json');
const HORARIO_FILE = path.join(DATA_DIR, 'horario.json');

const HORARIO_DEFAULT = 'Lunes a Viernes de 9:00 a 18:00 · Sábados de 9:00 a 13:00';
let HORARIO_TEXTO = HORARIO_DEFAULT;
try {
  if (fs.existsSync(HORARIO_FILE)) {
    const cargado = JSON.parse(fs.readFileSync(HORARIO_FILE, 'utf8'));
    if (cargado && typeof cargado.texto === 'string') HORARIO_TEXTO = cargado.texto;
  } else {
    fs.writeFileSync(HORARIO_FILE, JSON.stringify({ texto: HORARIO_TEXTO }, null, 2));
  }
} catch (e) { console.error('No se pudo cargar horario.json:', e.message); }

function getHorario() { return HORARIO_TEXTO; }
function setHorario(texto) {
  if (typeof texto !== 'string') return HORARIO_TEXTO;
  HORARIO_TEXTO = texto.trim() || HORARIO_DEFAULT;
  try { fs.writeFileSync(HORARIO_FILE, JSON.stringify({ texto: HORARIO_TEXTO }, null, 2)); }
  catch (e) { console.error('No se pudo guardar horario.json:', e.message); }
  return HORARIO_TEXTO;
}

const PRECIOS_DEFAULT = {
  copia_bn: 50,
  copia_color: 200,
  impresion_bn: 100,
  impresion_color: 400,
  escaneo: 100,
  encuadernacion_espiral: 1500,
  encuadernacion_anillado: 2000,
  encuadernacion_termico: 3000,
  envio: 2500,
};

let PRECIOS_PLANO = { ...PRECIOS_DEFAULT };
try {
  if (fs.existsSync(PRECIOS_FILE)) {
    const cargado = JSON.parse(fs.readFileSync(PRECIOS_FILE, 'utf8'));
    PRECIOS_PLANO = { ...PRECIOS_DEFAULT, ...cargado };
  } else {
    fs.writeFileSync(PRECIOS_FILE, JSON.stringify(PRECIOS_PLANO, null, 2));
  }
} catch (e) { console.error('No se pudo cargar precios.json:', e.message); }

function getPrecios() {
  return {
    copia_bn: PRECIOS_PLANO.copia_bn,
    copia_color: PRECIOS_PLANO.copia_color,
    impresion_bn: PRECIOS_PLANO.impresion_bn,
    impresion_color: PRECIOS_PLANO.impresion_color,
    escaneo: PRECIOS_PLANO.escaneo,
    encuadernacion: {
      espiral: PRECIOS_PLANO.encuadernacion_espiral,
      anillado: PRECIOS_PLANO.encuadernacion_anillado,
      termico: PRECIOS_PLANO.encuadernacion_termico,
    },
    envio: PRECIOS_PLANO.envio,
  };
}

function setPrecios(nuevos) {
  for (const k of Object.keys(PRECIOS_DEFAULT)) {
    if (nuevos[k] !== undefined) {
      const n = Number(nuevos[k]);
      if (Number.isFinite(n) && n >= 0) PRECIOS_PLANO[k] = n;
    }
  }
  try { fs.writeFileSync(PRECIOS_FILE, JSON.stringify(PRECIOS_PLANO, null, 2)); }
  catch (e) { console.error('No se pudo guardar precios.json:', e.message); }
  return getPreciosPlano();
}

function getPreciosPlano() { return { ...PRECIOS_PLANO }; }

const sesiones = new Map();

const TIEMPO_EXPIRA_MS = 15 * 60 * 1000;

function ahora() { return Date.now(); }

function nuevaSesion() {
  return {
    paso: 'menu',
    pedido: {},
    creado: ahora(),
    actualizado: ahora(),
  };
}

function obtenerSesion(userId) {
  const s = sesiones.get(userId);
  if (!s) return null;
  if (ahora() - s.actualizado > TIEMPO_EXPIRA_MS) {
    sesiones.delete(userId);
    return null;
  }
  return s;
}

function guardarSesion(userId, sesion) {
  sesion.actualizado = ahora();
  sesiones.set(userId, sesion);
}

function cancelarSesion(userId) {
  sesiones.delete(userId);
}

// --- Adjuntos ---
// Guarda un adjunto asociado al pedido actual de la sesión del usuario
// info: { url, mime, nombre }
function guardarAdjunto(userId, info) {
  try {
    const sesion = obtenerSesion(userId);
    if (!sesion) return;
    const p = sesion.pedido || {};
    p.attachment = p.attachment || [];
    // Evita duplicados simples si se repite el mismo info.url
    if (!p.attachment.find(a => a.url === info.url)) {
      p.attachment.push(info);
    }
    sesion.pedido = p;
    guardarSesion(userId, sesion);
  } catch (e) {
    console.error('No se pudo guardar adjunto en pedido:', e?.message);
  }
}

function esDisparador(texto) {
  // Cualquier mensaje inicia el flujo si no hay sesión activa.
  return true;
}

function mensajeBienvenida() {
  return (
`👋 *¡Bienvenido a Fotocopiadora Express!*

🕒 *Horario de atención:*
${HORARIO_TEXTO}

¿Qué necesitás hoy? Respondé con el número:

*1.* 🖨️ Fotocopias
*2.* 📄 Impresiones
*3.* 🔍 Escaneos
*4.* 📚 Encuadernación
*5.* 💬 Hablar con humano

_Escribí *cancelar* en cualquier momento para salir._`
  );
}

function pedirCantidad() {
  return '🔢 ¿Cuántas hojas/páginas?\n\n_Respondé con un número (ej: 25)_';
}

function pedirColor() {
  return (
`🎨 ¿Blanco y negro o color?

*1.* ⚫ Blanco y negro
*2.* 🌈 Color`
  );
}

function pedirTamano() {
  return (
`📐 Tamaño de hoja:

*1.* A4 (carta)
*2.* A3 (doble carta)
*3.* Oficio`
  );
}

function pedirCaras() {
  return (
`📃 ¿Una o dos caras?

*1.* Una cara (simple)
*2.* Dos caras (doble faz)`
  );
}

function pedirEncuadernacion() {
  const P = getPrecios();
  return (
`📚 Tipo de encuadernación:

*1.* Espiral — $${P.encuadernacion.espiral}
*2.* Anillado — $${P.encuadernacion.anillado}
*3.* Térmico — $${P.encuadernacion.termico}
*4.* Sin encuadernación`
  );
}

function pedirNombre() {
  return '🙋 ¿A nombre de quién va el pedido?';
}

function calcularTotal(p) {
  const P = getPrecios();
  let total = 0;
  if (p.servicio === 'copias') {
    const precioUnit = p.color === 'color' ? P.copia_color : P.copia_bn;
    total += precioUnit * (p.cantidad || 0);
  } else if (p.servicio === 'impresiones') {
    const precioUnit = p.color === 'color' ? P.impresion_color : P.impresion_bn;
    total += precioUnit * (p.cantidad || 0);
  } else if (p.servicio === 'escaneos') {
    total += P.escaneo * (p.cantidad || 0);
  }
  if (p.encuadernacion && p.encuadernacion !== 'ninguna') {
    total += P.encuadernacion[p.encuadernacion] || 0;
  }
  return total;
}

function resumen(p) {
  const servicios = {
    copias: '🖨️ Fotocopias',
    impresiones: '📄 Impresiones',
    escaneos: '🔍 Escaneos',
    encuadernacion: '📚 Encuadernación',
  };
  const lineas = [
    '🧾 *Resumen del pedido*',
    '',
    `Cliente: *${p.nombre || '—'}*`,
    `Servicio: ${servicios[p.servicio] || p.servicio}`,
  ];
  if (p.cantidad) lineas.push(`Cantidad: ${p.cantidad} ${p.servicio === 'escaneos' ? 'páginas' : 'hojas'}`);
  if (p.color) lineas.push(`Color: ${p.color === 'color' ? '🌈 Color' : '⚫ Blanco y negro'}`);
  if (p.tamano) lineas.push(`Tamaño: ${p.tamano.toUpperCase()}`);
  if (p.caras) lineas.push(`Caras: ${p.caras === 'dos' ? 'Doble faz' : 'Una cara'}`);
  if (p.encuadernacion && p.encuadernacion !== 'ninguna') lineas.push(`Encuadernación: ${p.encuadernacion}`);
  lineas.push('Entrega: 🏪 Retiro en local');
  lineas.push('');
  lineas.push(`💵 *Total: $${calcularTotal(p).toLocaleString('es-AR')}*`);
  lineas.push('');
  lineas.push('Respondé:');
  lineas.push('*1.* ✅ Confirmar pedido');
  lineas.push('*2.* ❌ Cancelar');
  return lineas.join('\n');
}

function parseNumero(texto) {
  const n = parseInt(texto.trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function manejar(userId, texto, sesionExistente) {
  const t = texto.trim();
  const lower = t.toLowerCase();

  if (lower === 'cancelar' || lower === '!cancelar' || lower === '/cancelar') {
    cancelarSesion(userId);
    return { respuesta: '❌ Pedido cancelado. Escribí *menu* cuando quieras empezar de nuevo.', terminado: true };
  }

  let sesion = sesionExistente;
  if (!sesion) {
    sesion = nuevaSesion();
  }

  const p = sesion.pedido;

  switch (sesion.paso) {
    case 'menu': {
      if (t === '1') { p.servicio = 'copias'; sesion.paso = 'cantidad'; guardarSesion(userId, sesion); return { respuesta: pedirCantidad() }; }
      if (t === '2') { p.servicio = 'impresiones'; sesion.paso = 'pedir_archivo'; guardarSesion(userId, sesion); return { respuesta: '📎 Por favor, adjuntá el archivo (PDF, Word, imagen) que querés imprimir.' }; }
      if (t === '3') { p.servicio = 'escaneos'; sesion.paso = 'cantidad'; guardarSesion(userId, sesion); return { respuesta: pedirCantidad() }; }
      if (t === '4') { p.servicio = 'encuadernacion'; sesion.paso = 'pedir_archivo'; guardarSesion(userId, sesion); return { respuesta: '📎 Por favor, adjuntá el archivo que querés encuadernar.' }; }
      if (t === '5') { cancelarSesion(userId); return { respuesta: '👨‍💼 Te derivamos con un humano. Un asesor te va a escribir en breve.', terminado: true }; }
      guardarSesion(userId, sesion);
      return { respuesta: mensajeBienvenida() };
    }

    case 'pedir_archivo': {
      if (p.attachment && p.attachment.length > 0) {
        // Si es PDF con páginas contadas, preguntar copias
        if (p.servicio === 'impresiones' && p.pdfPages && p.pdfPages > 0) {
          sesion.paso = 'copias_pdf';
          guardarSesion(userId, sesion);
          return { respuesta: `📄 El PDF tiene ${p.pdfPages} página(s). ¿Cuántas copias querés?\n\n_Respondé con un número (ej: 2)_` };
        }
        // Para encuadernación u otros casos, continuar normalmente
        if (p.servicio === 'encuadernacion') {
          sesion.paso = 'encuadernacion';
          guardarSesion(userId, sesion);
          return { respuesta: pedirEncuadernacion() };
        } else {
          sesion.paso = 'cantidad';
          guardarSesion(userId, sesion);
          return { respuesta: pedirCantidad() };
        }
      } else {
        return { respuesta: '⚠️ Todavía no recibí el archivo. Por favor, adjuntalo antes de continuar.' };
      }
    }

    case 'copias_pdf': {
      const copias = parseNumero(t);
      if (!copias || copias < 1) return { respuesta: '⚠️ Necesito un número válido. ¿Cuántas copias?' };
      p.cantidad = p.pdfPages * copias; // Total hojas = páginas × copias
      p.copias = copias;
      // Continuar con el flujo normal (color, etc.)
      sesion.paso = 'color';
      guardarSesion(userId, sesion);
      return { respuesta: pedirColor() };
    }

    case 'cantidad': {
      const n = parseNumero(t);
      if (!n) return { respuesta: '⚠️ Necesito un número válido. ¿Cuántas hojas/páginas?' };
      p.cantidad = n;
      if (p.servicio === 'escaneos') {
        p.entrega = 'retiro';
        sesion.paso = 'nombre';
        guardarSesion(userId, sesion);
        return { respuesta: pedirNombre() };
      }
      sesion.paso = 'color';
      guardarSesion(userId, sesion);
      return { respuesta: pedirColor() };
    }

    case 'color': {
      if (t === '1') p.color = 'bn';
      else if (t === '2') p.color = 'color';
      else return { respuesta: '⚠️ Respondé *1* (B/N) o *2* (Color).' };
      sesion.paso = 'tamano';
      guardarSesion(userId, sesion);
      return { respuesta: pedirTamano() };
    }

    case 'tamano': {
      if (t === '1') p.tamano = 'a4';
      else if (t === '2') p.tamano = 'a3';
      else if (t === '3') p.tamano = 'oficio';
      else return { respuesta: '⚠️ Respondé *1*, *2* o *3*.' };
      sesion.paso = 'caras';
      guardarSesion(userId, sesion);
      return { respuesta: pedirCaras() };
    }

    case 'caras': {
      if (t === '1') p.caras = 'una';
      else if (t === '2') p.caras = 'dos';
      else return { respuesta: '⚠️ Respondé *1* (una cara) o *2* (doble faz).' };
      sesion.paso = 'preg_encuadernacion';
      guardarSesion(userId, sesion);
      return { respuesta: '📚 ¿Querés encuadernación?\n\n*1.* Sí\n*2.* No' };
    }

    case 'preg_encuadernacion': {
      if (t === '1') { sesion.paso = 'encuadernacion'; guardarSesion(userId, sesion); return { respuesta: pedirEncuadernacion() }; }
      if (t === '2') { p.encuadernacion = 'ninguna'; p.entrega = 'retiro'; sesion.paso = 'nombre'; guardarSesion(userId, sesion); return { respuesta: pedirNombre() }; }
      return { respuesta: '⚠️ Respondé *1* (sí) o *2* (no).' };
    }

    case 'encuadernacion': {
      if (t === '1') p.encuadernacion = 'espiral';
      else if (t === '2') p.encuadernacion = 'anillado';
      else if (t === '3') p.encuadernacion = 'termico';
      else if (t === '4') p.encuadernacion = 'ninguna';
      else return { respuesta: '⚠️ Respondé *1*, *2*, *3* o *4*.' };
      p.entrega = 'retiro';
      sesion.paso = 'nombre';
      guardarSesion(userId, sesion);
      return { respuesta: pedirNombre() };
    }

    case 'nombre': {
      if (t.length < 2) return { respuesta: '⚠️ Necesito un nombre válido.' };
      p.nombre = t;
      sesion.paso = 'confirmar';
      guardarSesion(userId, sesion);
      return { respuesta: resumen(p) };
    }

    case 'confirmar': {
      if (t === '1') {
        const total = calcularTotal(p);
        const pedidoFinal = { ...p, total, userId, fecha: new Date().toISOString() };
        cancelarSesion(userId);
        console.log('🧾 Pedido confirmado:', JSON.stringify(pedidoFinal));
        const necesitaArchivo = p.servicio === 'impresiones' || p.servicio === 'encuadernacion';
        const pedirArchivo = necesitaArchivo
          ? `\n\n📎 *Adjuntá el archivo* (PDF, Word o imagen) respondiendo a este mensaje para que podamos imprimirlo.`
          : `\n\n📎 Si tu pedido requiere un archivo digital, podés adjuntarlo respondiendo a este mensaje.`;
        const numero = Date.now().toString().slice(-6);
        return {
          respuesta: `✅ *¡Pedido confirmado!*\n\nNúmero: #${numero}\nTotal: *$${total.toLocaleString('es-AR')}*${pedirArchivo}\n\nTe avisamos cuando esté listo. ¡Gracias por elegirnos! 🙌`,
          terminado: true,
          numero,
          pedido: pedidoFinal,
        };
      }
      if (t === '2') {
        cancelarSesion(userId);
        return { respuesta: '❌ Pedido cancelado. Escribí *menu* cuando quieras empezar de nuevo.', terminado: true };
      }
      return { respuesta: '⚠️ Respondé *1* para confirmar o *2* para cancelar.' };
    }

    default:
      cancelarSesion(userId);
      return { respuesta: mensajeBienvenida() };
  }
}

module.exports = {
  esDisparador,
  obtenerSesion,
  manejar,
  mensajeBienvenida,
  cancelarSesion,
  getPrecios,
  getPreciosPlano,
  setPrecios,
  PRECIOS_DEFAULT,
  getHorario,
  setHorario,
  HORARIO_DEFAULT,
  guardarAdjunto,
  pedirCantidad,
  pedirEncuadernacion,
  guardarSesion,
};
