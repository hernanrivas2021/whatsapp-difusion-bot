# 📣 WhatsApp Difusión Bot

Bot de WhatsApp Business con **Baileys** (sin Chromium): escaneás el QR desde la web y enviás mensajes personalizados masivos a clientes cargados desde un **Google Sheets público**, con filtros por fechas y ordenamiento.

## ✨ Funciones

- 📱 Conexión por QR (WhatsApp Business) con reconexión automática + botón "Nuevo QR"
- 📊 Clientes desde Google Sheets público (sin API key) — columnas `telefono | nombre | fecha_sucedio | fecha_subida`
- 🔎 Filtros: buscador, rango fecha sucedió / fecha subida, orden por las 4 columnas, solo válidos
- ✉️ Plantilla personalizada con `{nombre} {telefono} {fecha_sucedio} {fecha_subida}` + vista previa
- 🚀 Envío masivo con delay aleatorio anti-bloqueo, pausar / seguir / cancelar, progreso y log
- 🖨️ Módulo fotocopiadora original conservado en `/` (pedidos, precios, horario)

## 🚀 Uso

```bash
npm install
cp .env.example .env   # completar SHEET_ID
node index.js
```

- Panel difusión: `http://localhost:5000/difusion`
- Panel fotocopiadora: `http://localhost:5000/`

### 1. Google Sheet

1. Compartir como **"Cualquiera con el enlace puede ver"**
2. Columnas (acepta tildes/mayúsculas): `telefono, nombre, fecha_sucedio, fecha_subida`
3. Copiar el ID del link `.../spreadsheets/d/ESTE_ID/edit` → pegarlo en el panel o en `.env` (`SHEET_ID`, `SHEET_GID`)

### 2. Enviar difusión

1. Escanear QR con WhatsApp Business
2. 📥 Cargar clientes → filtrar/ordenar (o tildar solo algunos)
3. Escribir plantilla → 👁 Vista previa → ☑ probar con 1 si querés
4. 📣 Enviar a filtrados (delays recomendados 6–14s; cuentas nuevas 10–20s)

## ⚙️ Config `.env`

```
SHEET_ID=ID_de_tu_sheet
SHEET_GID=0
PLANTILLA_DEFAULT=Hola {nombre} 👋, te contactamos por el caso del {fecha_sucedio}...
PORT=5000
PANEL_PASSWORD=  # vacío = panel abierto
BOT_NAME=DifusionBot
```

## 📁 Estructura

```
index.js               # servidor + WhatsApp + APIs
clientes.js            # lectura Google Sheets + filtros/plantilla
difusion.js            # cola de envío masivo
difusion-panel.html    # panel web difusión
flujoFotocopiadora.js  # flujo pedidos original
```

## ⚠️ Anti-bloqueo

WhatsApp Business banea el spam. No enviar más de ~200–300/día por número, usar delays, y probar siempre con 1 contacto primero.

## 🔌 APIs

- `GET /api/config` / `POST /api/config`
- `POST /api/clientes/recargar` / `GET /api/clientes?buscar=&desdeSucedio=&hastaSucedio=&desdeSubida=&hastaSubida=&orden=&dir=`
- `POST /api/clientes/preview`
- `POST /api/difusion/iniciar` / `pausar` / `reanudar` / `cancelar` / `GET /api/difusion/estado`
