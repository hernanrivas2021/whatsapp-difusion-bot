// ─── MÓDULO CLIENTES (Google Sheets público) ───────────────────────────────
// Lee un Google Sheets compartido como "cualquiera con el enlace puede ver"
// sin necesidad de API keys, usando exportación CSV (gviz).
//
// Columnas esperadas (flexible con tildes/mayúsculas):
//   telefono | nombre | fecha_sucedio | fecha_subida
// Ejemplos aceptados: "Teléfono", "TELEFONO", "telefono", "numero", "whatsapp", etc.
//
// Uso:
//   const { fetchClientes, filtrarOrdenar } = require('./clientes');
//   const clientes = await fetchClientes(SHEET_ID);

const SHEET_ID_DEFAULT = process.env.SHEET_ID || '';
const SHEET_GID_DEFAULT = process.env.SHEET_GID || '0';

// Normaliza encabezados: minúsculas, sin tildes, sin espacios extra
function normKey(k) {
  return String(k || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, '_');
}

// Mapea encabezado real -> campo canónico
function mapearCampo(keyNorm) {
  if (['telefono', 'telefonos', 'numero', 'numero_telefono', 'celular', 'whatsapp', 'tel', 'phone', 'movil'].includes(keyNorm)) return 'telefono';
  if (['nombre', 'nombres', 'cliente', 'nombre_cliente', 'name', 'contacto'].includes(keyNorm)) return 'nombre';
  if (['fecha_sucedio', 'fecha_que_sucedio', 'fecha_suceso', 'fecha_evento', 'fecha_hecho', 'sucedio', 'fecha'].includes(keyNorm)) return 'fecha_sucedio';
  if (['fecha_subida', 'fecha_de_subida', 'fecha_carga', 'subida', 'fecha_registro', 'creado', 'fecha_alta'].includes(keyNorm)) return 'fecha_subida';
  return null;
}

// Limpia teléfono: solo dígitos. Requiere >=10 dígitos para ser válido en WhatsApp.
// No inventamos código país: si el sheet trae 549..., se respeta. Si trae local 10 dígitos, se usa tal cual.
function normalizarTelefono(raw) {
  if (raw == null) return '';
  let d = String(raw).replace(/\D/g, '');
  // Quitar ceros iniciales tipo "015" -> dejar resto
  // (común en Argentina al copiar de Excel)
  return d;
}

function telefonoValido(tel) {
  return /^\d{10,15}$/.test(tel || '');
}

// Parser CSV simple pero robusto (comillas, comas dentro de comillas, \r\n)
function parseCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let enComillas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    const next = texto[i + 1];
    if (enComillas) {
      if (c === '"' && next === '"') { campo += '"'; i++; }
      else if (c === '"') { enComillas = false; }
      else { campo += c; }
    } else {
      if (c === '"') { enComillas = true; }
      else if (c === ',') { fila.push(campo); campo = ''; }
      else if (c === '\n') { fila.push(campo); filas.push(fila); fila = []; campo = ''; }
      else if (c === '\r') { /* ignorar, el \n cierra */ }
      else { campo += c; }
    }
  }
  fila.push(campo);
  filas.push(fila);
  // Eliminar filas totalmente vacías
  return filas.filter(f => f.some(c => String(c).trim() !== ''));
}

function filasAClientes(filas) {
  if (!filas.length) return [];
  const headers = filas[0].map(normKey);
  const idxMap = {}; // campoCanonico -> indice columna
  headers.forEach((h, i) => {
    const campo = mapearCampo(h);
    if (campo && idxMap[campo] === undefined) idxMap[campo] = i;
  });
  const out = [];
  for (let r = 1; r < filas.length; r++) {
    const f = filas[r];
    const get = (campo) => (idxMap[campo] !== undefined ? String(f[idxMap[campo]] || '').trim() : '');
    const telefono = normalizarTelefono(get('telefono'));
    const nombre = get('nombre');
    const fecha_sucedio = get('fecha_sucedio');
    const fecha_subida = get('fecha_subida');
    if (!telefono && !nombre) continue; // fila vacía
    out.push({
      id: r, // nro de fila (1-based sin header => r)
      fila: r + 1, // fila real en el Sheet
      telefono,
      telefono_valido: telefonoValido(telefono),
      nombre,
      fecha_sucedio,
      fecha_subida,
      // fechas parseadas para ordenar/filtrar (null si no parseable)
      _fs: parseFecha(fecha_sucedio),
      _fu: parseFecha(fecha_subida),
    });
  }
  return out;
}

// Acepta "2026-09-20", "20/09/2026", "20-09-2026", "20/09/26", ISO con hora, etc.
function parseFecha(s) {
  if (!s) return null;
  s = String(s).trim();
  if (!s) return null;
  // ISO directo
  let d = new Date(s);
  if (!isNaN(d)) {
    // Evitar que "25" o "2026" se interpreten raro: exigir al menos día/mes/año o ISO
    if (/^\d{4}-\d{2}-\d{2}/.test(s) || s.includes('/') || s.includes('-')) return d;
  }
  // dd/mm/aaaa o dd-mm-aaaa
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (m) {
    let [_, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = '20' + yyyy;
    d = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
    if (!isNaN(d)) return d;
  }
  return null;
}

function buildCsvUrl(sheetId, gid = '0') {
  // gviz CSV: funciona con sheets públicos sin API key
  return `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`;
}

async function fetchClientes(sheetId = SHEET_ID_DEFAULT, gid = SHEET_GID_DEFAULT) {
  if (!sheetId) throw new Error('Falta SHEET_ID. Configuralo en .env o en el panel (SHEET_ID).');
  const url = buildCsvUrl(sheetId, gid);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`No se pudo leer el Sheet (HTTP ${res.status}). Revisá que el link sea "cualquiera con el enlace puede ver".`);
  }
  const texto = await res.text();
  if (/^<!DOCTYPE|<html/i.test(texto.slice(0, 200))) {
    throw new Error('Google devolvió HTML en vez de CSV. El Sheet no es público o el ID/GID es incorrecto.');
  }
  const filas = parseCSV(texto);
  return filasAClientes(filas);
}

// Filtros + ordenamiento (se usa también en frontend, pero el backend lo aplica para el envío)
function filtrarOrdenar(clientes, opts = {}) {
  const {
    buscar = '',           // texto libre en nombre o teléfono
    desdeSucedio = '',     // YYYY-MM-DD
    hastaSucedio = '',
    desdeSubida = '',
    hastaSubida = '',
    soloValidos = true,
    orden = 'fecha_subida', // telefono|nombre|fecha_sucedio|fecha_subida
    dir = 'desc',           // asc|desc
  } = opts;

  const b = String(buscar).trim().toLowerCase();
  const dSs = desdeSucedio ? new Date(desdeSucedio + 'T00:00:00') : null;
  const hSs = hastaSucedio ? new Date(hastaSucedio + 'T23:59:59') : null;
  const dSu = desdeSubida ? new Date(desdeSubida + 'T00:00:00') : null;
  const hSu = hastaSubida ? new Date(hastaSubida + 'T23:59:59') : null;

  let out = clientes.filter(c => {
    if (soloValidos && !c.telefono_valido) return false;
    if (b && !(c.nombre.toLowerCase().includes(b) || c.telefono.includes(b.replace(/\D/g, '')))) return false;
    if (dSs && !(c._fs && c._fs >= dSs)) return false;
    if (hSs && !(c._fs && c._fs <= hSs)) return false;
    if (dSu && !(c._fu && c._fu >= dSu)) return false;
    if (hSu && !(c._fu && c._fu <= hSu)) return false;
    return true;
  });

  const keyFn = (c) => {
    if (orden === 'nombre') return c.nombre.toLowerCase();
    if (orden === 'telefono') return c.telefono;
    if (orden === 'fecha_sucedio') return c._fs ? c._fs.getTime() : (dir === 'asc' ? Infinity : -Infinity);
    return c._fu ? c._fu.getTime() : (dir === 'asc' ? Infinity : -Infinity);
  };
  out.sort((a, b2) => {
    const ka = keyFn(a), kb = keyFn(b2);
    if (ka < kb) return dir === 'asc' ? -1 : 1;
    if (ka > kb) return dir === 'asc' ? 1 : -1;
    return 0;
  });
  return out;
}

// Aplica plantilla: reemplaza {nombre}, {telefono}, {fecha_sucedio}, {fecha_subida}
function aplicarPlantilla(plantilla, cliente) {
  return String(plantilla || '')
    .replace(/\{nombre\}/gi, cliente.nombre || '')
    .replace(/\{telefono\}/gi, cliente.telefono || '')
    .replace(/\{fecha_sucedio\}/gi, cliente.fecha_sucedio || '')
    .replace(/\{fecha_subida\}/gi, cliente.fecha_subida || '');
}

module.exports = {
  fetchClientes,
  filtrarOrdenar,
  aplicarPlantilla,
  parseCSV,
  filasAClientes,
  normalizarTelefono,
  telefonoValido,
  parseFecha,
  buildCsvUrl,
};
