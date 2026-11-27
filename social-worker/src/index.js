// Chat Social de Shukito Studio: chat general y chats privados para unos pocos invitados.
// Worker + un Durable Object ("SalaSocial") con WebSocket. La clave del grupo vive en el secreto CLAVE.
import { DurableObject } from "cloudflare:workers";

const NOMBRE_VALIDO = /^[A-Za-z0-9]{3,16}$/;
const PIN_VALIDO = /^[0-9]{4,6}$/;
const AVATAR_PREDEF = /^e:(?:[0-9]|1[01])$/;            // 12 avatares dibujados en la página
const AVATAR_FOTO = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_AVATAR = 40000;       // caracteres de la foto (ya reducida a 128 px en el teléfono)
const MAX_ESTADO = 60;          // caracteres del estado
const MAX_LARGO = 500;          // caracteres por mensaje
const MAX_CUERPO = 50000;       // bytes que se aceptan al registrarse o entrar
const MAX_WS = 50000;           // caracteres por mensaje de WebSocket
const INTENTOS_MAX = 5;         // intentos fallidos por IP...
const INTENTOS_VENTANA = 10 * 60 * 1000; // ...cada 10 minutos
const PIN_FALLOS_MAX = 5;       // PIN equivocado 5 veces seguidas...
const PIN_BLOQUEO = 60 * 60 * 1000;      // ...bloquea esa cuenta 1 hora
const PIN_VUELTAS = 100000;     // PBKDF2
const ESPERA_ENTRE_MENSAJES = 1000;      // un mensaje por segundo
const ESPERA_ENTRE_PERFILES = 2000;      // un cambio de perfil cada 2 segundos
const LIMPIEZA_CADA = 60 * 60 * 1000;    // revisar mensajes viejos cada hora
const ADMIN_FALLOS_MAX = 10;             // clave de administrador mal escrita 10 veces (desde cualquier lugar)...
const ADMIN_BLOQUEO = 60 * 60 * 1000;    // ...bloquea la entrada de administrador 1 hora
const MIN_CLAVE_GRUPO = 6;
const MAX_CLAVE_GRUPO = 64;

// ---------- Fotos, videos y audios (guardados en R2, binding ARCHIVOS) ----------
// Llegan ya reducidos desde el teléfono. Aquí solo se revisa el tipo y el tamaño.
const ARCHIVO_TIPOS = {
  foto: { tipos: ["image/webp", "image/jpeg"], max: 2 * 1024 * 1024, dur: 0 },
  audio: { tipos: ["audio/webm", "audio/ogg", "audio/mp4"], max: 2 * 1024 * 1024, dur: 60 },
  video: { tipos: ["video/webm", "video/mp4"], max: 8 * 1024 * 1024, dur: 15 },
};
const SUBIDAS_MAX = 30;                    // archivos por persona...
const SUBIDAS_VENTANA = 10 * 60 * 1000;    // ...cada 10 minutos
const SIN_USAR_HORAS = 1;                  // un archivo subido que no se envió se borra a la hora
const CLAVE_ARCHIVO = /^[a-f0-9]{40}$/;
const MAX_SUBIDA = 8 * 1024 * 1024;        // el más grande de todos (video)

// ---------- Stickers personales (R2, prefijo "s/") ----------
// Se guardan con el prefijo "s/" a propósito: la regla del bucket que borra a los 2 días solo mira "m/".
// Duran mientras exista la cuenta: se borran al tocar la X, al borrar la cuenta o cuando la cuenta caduca.
// Al enviar uno al chat se hace una copia en "m/" que sigue las reglas de los mensajes (24 horas).
const STICKER_MAX = 500 * 1024;            // bytes por sticker (ya reducido en el teléfono)
const STICKER_LADO = 520;                  // píxeles como máximo por lado (512 y un poco de margen)
const STICKERS_POR_PERSONA = 60;
const STICKER_SUBIDAS_MAX = 30;            // stickers nuevos por persona...
const STICKER_SUBIDAS_VENTANA = 10 * 60 * 1000; // ...cada 10 minutos

// Tipo y tamaño leídos de los propios bytes (no de lo que diga el teléfono). null si no es PNG, GIF o WebP.
function leerImagen(buf) {
  const b = new Uint8Array(buf);
  const dv = new DataView(buf);
  const ascii = (i, n) => String.fromCharCode(...b.subarray(i, i + n));
  if (b.length > 24 && b[0] === 0x89 && ascii(1, 3) === "PNG" && ascii(12, 4) === "IHDR") {
    return { mime: "image/png", ancho: dv.getUint32(16), alto: dv.getUint32(20) };
  }
  if (b.length > 10 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) {
    return { mime: "image/gif", ancho: dv.getUint16(6, true), alto: dv.getUint16(8, true) };
  }
  if (b.length > 30 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") {
    const tipo = ascii(12, 4);
    if (tipo === "VP8X") return { mime: "image/webp", ancho: 1 + (b[24] | b[25] << 8 | b[26] << 16), alto: 1 + (b[27] | b[28] << 8 | b[29] << 16) };
    if (tipo === "VP8L" && b[20] === 0x2f) {
      const v = dv.getUint32(21, true);
      return { mime: "image/webp", ancho: 1 + (v & 0x3fff), alto: 1 + ((v >> 14) & 0x3fff) };
    }
    if (tipo === "VP8 " && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
      return { mime: "image/webp", ancho: dv.getUint16(26, true) & 0x3fff, alto: dv.getUint16(28, true) & 0x3fff };
    }
  }
  return null;
}

// ---------- Reacciones a los mensajes ----------
const REACCIONES = ["👍", "❤️", "😢", "😡", "😂"];

// ---------- GIFs (Giphy; la clave vive en el secreto GIPHY_CLAVE y la página nunca la ve) ----------
// La clave gratis ("beta") de Giphy permite unas 100 llamadas por hora: por eso cada búsqueda se guarda un rato
// y se comparte entre todos, y el servidor nunca hace más de GIF_LLAMADAS_HORA llamadas por hora.
const GIF_CLASIFICACION = "pg";            // Giphy devuelve G y PG (nada de PG-13 ni R)
const GIF_CLASES_OK = ["g", "pg"];
const GIF_POR_PAGINA = 24;
const GIF_MAX_BUSQUEDA = 50;               // caracteres de lo que se busca
const GIF_GUARDAR = 30 * 60 * 1000;        // una búsqueda se reutiliza durante 30 minutos
const GIF_LLAMADAS_HORA = 90;              // tope del servidor (deja margen bajo el límite de Giphy)
const GIF_BUSQUEDAS_MAX = 25;              // búsquedas por persona...
const GIF_BUSQUEDAS_VENTANA = 10 * 60 * 1000; // ...cada 10 minutos
const GIF_VALIDO_HORAS = 24;               // un GIF mostrado en el buscador se puede enviar durante 24 horas
const GIF_ID = /^[A-Za-z0-9]{4,40}$/;
// Giphy ahora pone un trozo "v1.xxxx" antes del id: https://media3.giphy.com/media/v1.Y2lk.../ID/200w.webp
const GIF_URL = /^https:\/\/(?:media[0-9]?|i)\.giphy\.com\/media\/(?:v1\.[A-Za-z0-9_=-]{1,400}\/)?([A-Za-z0-9]{4,40})\/[A-Za-z0-9_.-]{1,40}$/;

// ---------- Responder a un mensaje ----------
const MAX_CITA = 120;                      // caracteres del texto citado que se guardan

// ---------- Traducir (Workers AI, binding AI) ----------
const MODELO_TRADUCIR = "@cf/meta/m2m100-1.2b";
const TRADUCCIONES_MAX = 40;               // traducciones nuevas por persona...
const TRADUCCIONES_VENTANA = 10 * 60 * 1000; // ...cada 10 minutos (las ya guardadas no cuentan)

function origenPermitido(request, env) {
  const origen = request.headers.get("Origin") || "";
  const lista = String(env.ORIGENES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.includes(origen) ? origen : null;
}

function cors(origen) {
  return {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tipo, X-Duracion, X-Ancho, X-Alto",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin, Authorization",
  };
}

function json(datos, estado, extra) {
  return new Response(JSON.stringify(datos), {
    status: estado || 200,
    headers: { "Content-Type": "application/json; charset=utf-8", ...(extra || {}) },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origen = origenPermitido(request, env);
    if (!origen) return new Response("No permitido", { status: 403 });

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(origen) });

    const sala = env.SALA.get(env.SALA.idFromName("sala-principal"));
    // La IP la pone Cloudflare; se pasa al Durable Object en una cabecera propia (no la del visitante).
    const cabeceras = new Headers(request.headers);
    cabeceras.set("X-Social-IP", request.headers.get("CF-Connecting-IP") || "desconocida");

    if ((url.pathname === "/entrar" || url.pathname === "/registrar") && request.method === "POST") {
      const cuerpo = (await request.text()).slice(0, MAX_CUERPO);
      cabeceras.delete("Content-Length");
      const r = await sala.fetch(new Request("https://sala" + url.pathname, { method: "POST", headers: cabeceras, body: cuerpo }));
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...cors(origen) } });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Se espera WebSocket", { status: 426 });
      return sala.fetch(new Request("https://sala/ws", { headers: cabeceras }));
    }

    // Subir un archivo (cuerpo = el archivo) o bajarlo. Siempre con el token de la sesión en Authorization.
    const esSubir = url.pathname === "/subir" && request.method === "POST";
    const bajar = /^\/archivo\/([a-f0-9]{40})$/.exec(url.pathname);
    const gifs = url.pathname === "/gifs" && request.method === "GET";
    // Stickers: /stickers (lista), /sticker (subir), /sticker/<clave> (ver o borrar).
    const subirSticker = url.pathname === "/sticker" && request.method === "POST";
    const stickers = (url.pathname === "/stickers" && request.method === "GET")
      || (/^\/sticker\/[a-f0-9]{40}$/.test(url.pathname) && (request.method === "GET" || request.method === "DELETE"));
    if (esSubir || gifs || subirSticker || stickers || (bajar && request.method === "GET")) {
      const conCors = (r) => {
        const h = new Headers(r.headers);
        for (const [k, v] of Object.entries(cors(origen))) h.set(k, v);
        return new Response(r.body, { status: r.status, headers: h });
      };
      let cuerpo;
      if (esSubir) {
        // Se revisa el tamaño declarado y se lee entero aquí (como máximo 8 MB) antes de pasarlo.
        const declarado = Number(request.headers.get("Content-Length") || 0);
        if (!declarado) return conCors(json({ error: "vacio" }, 411));
        if (declarado > MAX_SUBIDA) return conCors(json({ error: "grande" }, 413));
        cuerpo = await request.arrayBuffer();
        if (cuerpo.byteLength > MAX_SUBIDA) return conCors(json({ error: "grande" }, 413));
        cabeceras.set("Content-Length", String(cuerpo.byteLength));
      }
      if (subirSticker) {
        const declarado = Number(request.headers.get("Content-Length") || 0);
        if (!declarado) return conCors(json({ error: "vacio" }, 411));
        if (declarado > STICKER_MAX) return conCors(json({ error: "sticker_grande" }, 413));
        cuerpo = await request.arrayBuffer();
        if (cuerpo.byteLength > STICKER_MAX) return conCors(json({ error: "sticker_grande" }, 413));
        cabeceras.set("Content-Length", String(cuerpo.byteLength));
      }
      const r = await sala.fetch(new Request("https://sala" + url.pathname + (gifs ? url.search : ""), {
        method: request.method, headers: cabeceras, body: cuerpo,
      }));
      return conCors(r);
    }

    return new Response("No encontrado", { status: 404 });
  },
};

const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const deHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

async function sha256(texto) {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto)));
}

function aleatorio(bytes) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return hex(b);
}

async function hashPin(pin, sal) {
  const base = await crypto.subtle.importKey("raw", new TextEncoder().encode(pin), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: deHex(sal), iterations: PIN_VUELTAS }, base, 256);
  return hex(bits);
}

function iguales(a, b) {
  const x = new TextEncoder().encode(a), y = new TextEncoder().encode(b);
  return x.length === y.length && crypto.subtle.timingSafeEqual(x, y);
}

function avatarValido(a) {
  return typeof a === "string" && (AVATAR_PREDEF.test(a) || (a.length <= MAX_AVATAR && AVATAR_FOTO.test(a)));
}

// ---------- Salas ----------
// "general" es el chat de todos. Un chat privado se llama "p:ana:beto" (los dos nombres en minúsculas, en orden).
const SALA_PRIVADA = /^p:([a-z0-9]{3,16}):([a-z0-9]{3,16})$/;
function salaPrivada(a, b) { return "p:" + [a.toLowerCase(), b.toLowerCase()].sort().join(":"); }
function miembros(sala) {
  const m = SALA_PRIVADA.exec(sala);
  return m ? [m[1], m[2]] : null;
}
function esMiembro(sala, nombre) {
  if (sala === "general") return true;
  const m = miembros(sala);
  return !!m && m.includes(String(nombre).toLowerCase());
}

// Un mensaje como lo recibe el teléfono (los datos del archivo solo si lleva uno).
function paraEnviar(x) {
  const m = { id: x.id, sala: x.sala, nombre: x.nombre, texto: x.texto, ts: x.ts };
  if (x.archivo) { m.archivo = x.archivo; m.tipo = x.tipo; m.dur = x.dur; m.ancho = x.ancho; m.alto = x.alto; }
  const gif = leerJson(x.gif), cita = leerJson(x.cita);
  if (gif) m.gif = gif;
  if (cita) m.cita = cita;
  return m;
}
function leerJson(s) {
  if (!s) return null;
  if (typeof s === "object") return s;
  try { return JSON.parse(s); } catch (e) { return null; }
}

// Quita caracteres de control y espacios sobrantes. "lineas" deja saltos de línea.
function limpiarTexto(s, lineas) {
  s = String(s || "");
  s = lineas ? s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n")
             : s.replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ");
  return s.trim();
}

export class SalaSocial extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ultimoEnvio = new Map();
    this.ultimoPerfil = new Map();
    this.ultimoEscribiendo = new Map();
    this.traduccionesRecientes = new Map(); // nombre -> horas de sus últimas traducciones
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, texto TEXT NOT NULL, ts INTEGER NOT NULL,
      sala TEXT NOT NULL DEFAULT 'general')`);
    // Mensajes de antes de los chats privados: todos eran del chat general.
    const tablaMensajes = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mensajes'").one();
    if (!String(tablaMensajes.sql).includes("sala")) this.sql.exec("ALTER TABLE mensajes ADD COLUMN sala TEXT NOT NULL DEFAULT 'general'");
    this.sql.exec("CREATE INDEX IF NOT EXISTS mensajes_sala ON mensajes (sala, id)");
    // Mensajes con foto, video o audio: la clave del archivo en R2 y sus datos.
    const columnas = String(this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mensajes'").one().sql);
    if (!columnas.includes("archivo")) {
      this.sql.exec("ALTER TABLE mensajes ADD COLUMN archivo TEXT");
      this.sql.exec("ALTER TABLE mensajes ADD COLUMN tipo TEXT");
      this.sql.exec("ALTER TABLE mensajes ADD COLUMN dur INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("ALTER TABLE mensajes ADD COLUMN ancho INTEGER NOT NULL DEFAULT 0");
      this.sql.exec("ALTER TABLE mensajes ADD COLUMN alto INTEGER NOT NULL DEFAULT 0");
    }
    // GIF (dirección en Giphy y tamaño) y cita del mensaje al que responde (copia corta, por si el original se borra).
    const columnas2 = String(this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mensajes'").one().sql);
    if (!columnas2.includes("gif")) this.sql.exec("ALTER TABLE mensajes ADD COLUMN gif TEXT");
    if (!columnas2.includes("cita")) this.sql.exec("ALTER TABLE mensajes ADD COLUMN cita TEXT");
    // Stickers de cada persona (el archivo está en R2 como "s/<clave>").
    this.sql.exec(`CREATE TABLE IF NOT EXISTS stickers (
      clave TEXT PRIMARY KEY, nombre TEXT NOT NULL COLLATE NOCASE, mime TEXT NOT NULL, tam INTEGER NOT NULL,
      ancho INTEGER NOT NULL, alto INTEGER NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS stickers_nombre ON stickers (nombre, ts)");
    // GIFs que el servidor mostró en el buscador (ya filtrados G/PG): solo estos se pueden enviar.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS gifs (
      id TEXT PRIMARY KEY, url TEXT NOT NULL, previa TEXT NOT NULL, ancho INTEGER NOT NULL, alto INTEGER NOT NULL, ts INTEGER NOT NULL)`);
    this.gifGuardados = new Map();   // búsqueda -> {ts, lista}
    this.gifLlamadas = [];           // horas de las llamadas a Giphy (última hora)
    this.gifBusquedas = new Map();   // nombre -> horas de sus búsquedas
    // Archivos subidos. "mensaje" queda vacío hasta que se envía el mensaje que lo lleva.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS archivos (
      clave TEXT PRIMARY KEY, nombre TEXT NOT NULL COLLATE NOCASE, tipo TEXT NOT NULL, mime TEXT NOT NULL,
      tam INTEGER NOT NULL, dur INTEGER NOT NULL, ancho INTEGER NOT NULL, alto INTEGER NOT NULL,
      ts INTEGER NOT NULL, mensaje INTEGER)`);
    // Hasta qué mensaje leyó cada persona en cada chat.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS lecturas (
      nombre TEXT NOT NULL COLLATE NOCASE, sala TEXT NOT NULL, id INTEGER NOT NULL, PRIMARY KEY (nombre, sala))`);
    // Versión 1 de "usuarios" (sin PIN ni perfil): se reemplaza. Los invitados vuelven a crear su usuario una vez.
    const vieja = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usuarios'").toArray()[0];
    if (vieja && !String(vieja.sql).includes("pin_hash")) this.sql.exec("DROP TABLE usuarios");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usuarios (
      nombre TEXT PRIMARY KEY COLLATE NOCASE, pin_hash TEXT NOT NULL, pin_sal TEXT NOT NULL,
      avatar TEXT NOT NULL, estado TEXT NOT NULL DEFAULT '', creado INTEGER NOT NULL, visto INTEGER NOT NULL,
      fallos INTEGER NOT NULL DEFAULT 0, bloqueo INTEGER NOT NULL DEFAULT 0)`);
    // Una sesión por teléfono o computadora. Solo se guarda el hash del token.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS sesiones (
      token_hash TEXT PRIMARY KEY, nombre TEXT NOT NULL COLLATE NOCASE, visto INTEGER NOT NULL,
      admin INTEGER NOT NULL DEFAULT 0)`);
    const tablaSesiones = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sesiones'").one();
    if (!String(tablaSesiones.sql).includes("admin")) this.sql.exec("ALTER TABLE sesiones ADD COLUMN admin INTEGER NOT NULL DEFAULT 0");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intentos (ip TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intentos_admin (ts INTEGER NOT NULL)`);
    // Ajustes que el administrador cambia desde la página (por ejemplo, la clave del grupo, guardada cifrada).
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ajustes (clave TEXT PRIMARY KEY, valor TEXT NOT NULL)`);
    // Lo que cada persona silenció: un chat ("sala") o a alguien ("persona").
    this.sql.exec(`CREATE TABLE IF NOT EXISTS silencios (
      nombre TEXT NOT NULL COLLATE NOCASE, tipo TEXT NOT NULL, valor TEXT NOT NULL COLLATE NOCASE,
      PRIMARY KEY (nombre, tipo, valor))`);
    // "Borrar chat" (solo para mí): esa persona deja de ver los mensajes de ese chat hasta el id "hasta".
    this.sql.exec(`CREATE TABLE IF NOT EXISTS ocultos (
      nombre TEXT NOT NULL COLLATE NOCASE, sala TEXT NOT NULL, hasta INTEGER NOT NULL, PRIMARY KEY (nombre, sala))`);
    // Traducciones ya hechas: se reutilizan y se borran junto con su mensaje.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS traducciones (
      id INTEGER NOT NULL, idioma TEXT NOT NULL, texto TEXT NOT NULL, PRIMARY KEY (id, idioma))`);
    // Reacciones: una por persona y mensaje. Se borran junto con su mensaje.
    this.sql.exec(`CREATE TABLE IF NOT EXISTS reacciones (
      id INTEGER NOT NULL, nombre TEXT NOT NULL COLLATE NOCASE, emoji TEXT NOT NULL, PRIMARY KEY (id, nombre))`);
    // Responde "pong" a los "ping" del teléfono sin despertar al servidor.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  horas() { return Math.max(1, Number(this.env.HORAS_MENSAJES) || 24); }
  maxMensajes() { return Math.max(1, Number(this.env.MAX_MENSAJES) || 200); }
  diasSesion() { return Math.max(1, Number(this.env.DIAS_SESION) || 30); }

  limpiar() {
    const ahora = Date.now();
    const limite = ahora - this.diasSesion() * 86400 * 1000;
    this.sql.exec("DELETE FROM mensajes WHERE ts < ?", ahora - this.horas() * 3600 * 1000);
    // Como máximo "MAX_MENSAJES" por chat (los más nuevos).
    this.sql.exec(`DELETE FROM mensajes WHERE id IN (SELECT id FROM (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY sala ORDER BY id DESC) AS n FROM mensajes) WHERE n > ?)`, this.maxMensajes());
    this.sql.exec("DELETE FROM sesiones WHERE visto < ?", limite);
    this.sql.exec("DELETE FROM usuarios WHERE visto < ?", limite);
    this.sql.exec("DELETE FROM sesiones WHERE nombre NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("DELETE FROM lecturas WHERE nombre NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("DELETE FROM ocultos WHERE nombre NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("DELETE FROM silencios WHERE nombre NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("DELETE FROM silencios WHERE tipo = 'persona' AND valor NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("UPDATE archivos SET ts = 0 WHERE mensaje IS NULL AND nombre NOT IN (SELECT nombre FROM usuarios)");
    // Chats privados de alguien que ya no existe: se borran (así nadie que use ese nombre después los ve).
    const existen = new Set(this.sql.exec("SELECT nombre FROM usuarios").toArray().map((u) => u.nombre.toLowerCase()));
    const salas = this.sql.exec("SELECT DISTINCT sala FROM mensajes WHERE sala <> 'general'").toArray().map((f) => f.sala)
      .concat(this.sql.exec("SELECT DISTINCT sala FROM lecturas WHERE sala <> 'general'").toArray().map((f) => f.sala))
      .concat(this.sql.exec("SELECT DISTINCT sala FROM ocultos WHERE sala <> 'general'").toArray().map((f) => f.sala))
      .concat(this.sql.exec("SELECT DISTINCT valor AS sala FROM silencios WHERE tipo = 'sala' AND valor <> 'general'").toArray().map((f) => f.sala));
    for (const sala of new Set(salas)) {
      const m = miembros(sala);
      if (m && m.every((n) => existen.has(n))) continue;
      this.sql.exec("DELETE FROM mensajes WHERE sala = ?", sala);
      this.sql.exec("DELETE FROM lecturas WHERE sala = ?", sala);
      this.sql.exec("DELETE FROM ocultos WHERE sala = ?", sala);
      this.sql.exec("DELETE FROM silencios WHERE tipo = 'sala' AND valor = ?", sala);
    }
    this.sql.exec("DELETE FROM intentos WHERE ts < ?", ahora - INTENTOS_VENTANA);
    this.sql.exec("DELETE FROM traducciones WHERE id NOT IN (SELECT id FROM mensajes)");
    this.sql.exec("DELETE FROM reacciones WHERE id NOT IN (SELECT id FROM mensajes)");
    this.sql.exec("DELETE FROM reacciones WHERE nombre NOT IN (SELECT nombre FROM usuarios)");
    this.sql.exec("DELETE FROM gifs WHERE ts < ?", ahora - GIF_VALIDO_HORAS * 3600 * 1000);
  }

  // ---------- GIFs ----------
  // GIF_PRUEBA="1" (solo al probar en la computadora) no llama a Giphy: devuelve dibujos de prueba.
  gifsDePrueba(q) {
    const colores = ["#3a8ee6", "#e6a23a", "#5fbf6a", "#d9534f", "#9b6bd6", "#2bb5b5"];
    const nombre = (q || "top").replace(/[^A-Za-z0-9 ]/g, "").slice(0, 12);
    const lista = [];
    for (let i = 0; i < 12; i++) {
      const alto = [150, 200, 120, 180][i % 4];
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="${alto}"><rect width="200" height="${alto}" fill="${colores[i % 6]}"/>`
        + `<text x="100" y="${alto / 2}" font-family="sans-serif" font-size="22" fill="#fff" text-anchor="middle">${nombre} ${i + 1}</text></svg>`;
      const url = "data:image/svg+xml;base64," + btoa(svg);
      lista.push({ id: "prueba" + nombre.replace(/ /g, "").slice(0, 10) + i, url, previa: url, ancho: 200, alto, titulo: nombre + " " + (i + 1) });
    }
    return lista;
  }

  // Lo que se guarda de cada GIF de Giphy: una versión de 200 px de ancho (webp si hay) y su tamaño.
  gifDeGiphy(g) {
    if (!g || !GIF_ID.test(String(g.id || "")) || !GIF_CLASES_OK.includes(String(g.rating || "").toLowerCase())) return null;
    const im = g.images || {};
    const limpia = (u) => String(u || "").split("?")[0];
    const fw = im.fixed_width || {}, fws = im.fixed_width_downsampled || fw;
    const url = limpia(fw.webp || fw.url), previa = limpia(fws.webp || fws.url || url);
    const ancho = Math.round(Number(fw.width) || 0), alto = Math.round(Number(fw.height) || 0);
    // Las dos direcciones tienen que ser de Giphy y de este mismo GIF.
    const a = GIF_URL.exec(url), b = GIF_URL.exec(previa);
    if (!a || !b || a[1] !== g.id || b[1] !== g.id || !ancho || !alto || ancho > 2000 || alto > 2000) return null;
    const titulo = limpiarTexto(g.title, false).replace(/\s*GIF\b.*$/i, "").slice(0, 80);
    return { id: g.id, url, previa, ancho, alto, titulo };
  }

  async buscarGifs(request, url) {
    const nombre = await this.usuarioDe(request);
    if (!nombre) return json({ error: "sesion" }, 401);
    const prueba = this.env.GIF_PRUEBA === "1";
    if (!this.env.GIPHY_CLAVE && !prueba) return json({ error: "sin_gifs" }, 503);
    const q = limpiarTexto(url.searchParams.get("q"), false).toLowerCase().slice(0, GIF_MAX_BUSQUEDA);
    const idioma = url.searchParams.get("idioma") === "en" ? "en" : "es";
    const clave = q ? "b:" + idioma + ":" + q : "top";
    const ahora = Date.now();
    let guardado = this.gifGuardados.get(clave);
    if (!guardado || ahora - guardado.ts > GIF_GUARDAR) {
      // Solo las búsquedas nuevas (no guardadas) cuentan para el límite de cada persona y del servidor.
      const mias = (this.gifBusquedas.get(nombre) || []).filter((h) => ahora - h < GIF_BUSQUEDAS_VENTANA);
      if (mias.length >= GIF_BUSQUEDAS_MAX) return json({ error: "gif_limite" }, 429);
      this.gifLlamadas = this.gifLlamadas.filter((h) => ahora - h < 3600 * 1000);
      if (this.gifLlamadas.length >= GIF_LLAMADAS_HORA) return json({ error: "gif_limite" }, 429);
      mias.push(ahora);
      this.gifBusquedas.set(nombre, mias);
      this.gifLlamadas.push(ahora);
      let lista;
      if (prueba) lista = this.gifsDePrueba(q);
      else {
        const p = new URLSearchParams({ api_key: this.env.GIPHY_CLAVE, limit: String(GIF_POR_PAGINA), rating: GIF_CLASIFICACION, bundle: "messaging_non_clips" });
        if (q) { p.set("q", q); p.set("lang", idioma); }
        let r;
        try {
          r = await fetch("https://api.giphy.com/v1/gifs/" + (q ? "search" : "trending") + "?" + p.toString(), {
            headers: { "User-Agent": "shukito-social/1.0", Accept: "application/json" },
          });
        } catch (e) { console.log("Giphy: sin conexión", String(e)); return json({ error: "gif_red" }, 502); }
        if (!r.ok) {
          // Se anota para verlo con "npx wrangler tail" (la clave nunca se anota).
          let detalle = "";
          try { detalle = (await r.text()).slice(0, 300); } catch (e) { /* nada */ }
          console.log("Giphy respondió", r.status, detalle);
          if (r.status === 429) return json({ error: "gif_limite" }, 429);
          if (r.status === 401 || r.status === 403) return json({ error: "gif_clave" }, 502);
          return json({ error: "gif_red" }, 502);
        }
        let d;
        try { d = await r.json(); } catch (e) { return json({ error: "gif_red" }, 502); }
        const recibidos = Array.isArray(d && d.data) ? d.data : [];
        lista = recibidos.map((g) => this.gifDeGiphy(g)).filter(Boolean);
        if (recibidos.length && !lista.length) console.log("Giphy: ningún GIF pasó el filtro", recibidos.length);
      }
      guardado = { ts: ahora, lista };
      this.gifGuardados.set(clave, guardado);
      if (this.gifGuardados.size > 300) this.gifGuardados.delete(this.gifGuardados.keys().next().value);
    }
    for (const g of guardado.lista) {
      this.sql.exec(`INSERT INTO gifs (id, url, previa, ancho, alto, ts) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET url = excluded.url, previa = excluded.previa, ancho = excluded.ancho, alto = excluded.alto, ts = excluded.ts`,
        g.id, g.url, g.previa, g.ancho, g.alto, ahora);
    }
    return json({ gifs: guardado.lista });
  }

  // Traduce con Workers AI. TRADUCTOR_PRUEBA="1" (solo al probar en la computadora) no llama a nadie.
  async traducirTexto(texto, de, a) {
    if (this.env.TRADUCTOR_PRUEBA === "1") return "[" + a + "] " + texto;
    const r = await this.env.AI.run(MODELO_TRADUCIR, { text: texto, source_lang: de, target_lang: a });
    return String((r && r.translated_text) || "").trim().slice(0, 2000);
  }

  // Un chat al que "yo" puede escribir: el general, o uno privado con otra persona que existe.
  salaPermitida(sala, yo) {
    if (sala === "general") return true;
    if (typeof sala !== "string" || !esMiembro(sala, yo)) return false;
    const [a, b] = miembros(sala);
    if (a === b || sala !== salaPrivada(a, b)) return false; // un solo nombre por pareja: "p:ana:beto", nunca "p:beto:ana"
    const otro = a === yo.toLowerCase() ? b : a;
    return this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", otro).toArray().length > 0;
  }

  marcarLeido(nombre, sala, id) {
    this.sql.exec(`INSERT INTO lecturas (nombre, sala, id) VALUES (?, ?, ?)
      ON CONFLICT (nombre, sala) DO UPDATE SET id = MAX(id, excluded.id)`, nombre, sala, id);
    return this.sql.exec("SELECT id FROM lecturas WHERE nombre = ? AND sala = ?", nombre, sala).one().id;
  }

  async programarLimpieza() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + LIMPIEZA_CADA);
  }

  async alarm() {
    this.limpiar();
    await this.limpiarArchivos();
    const fila = this.sql.exec("SELECT COUNT(*) AS c FROM mensajes").one();
    const archivos = this.sql.exec("SELECT COUNT(*) AS c FROM archivos").one();
    // Cada teléfono borra los mensajes más viejos que "corte" y deja como máximo "max" por chat.
    this.enviarATodos({ t: "purga", corte: Date.now() - this.horas() * 3600 * 1000, max: this.maxMensajes() });
    if (fila.c > 0 || archivos.c > 0 || this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + LIMPIEZA_CADA);
  }

  // Borra de R2 los archivos cuyo mensaje ya no existe (se borró solo, lo borró el administrador...)
  // y los que se subieron pero nunca se enviaron.
  // Stickers de cuentas que ya no existen (borradas, sacadas o caducadas).
  async limpiarStickers() {
    const sobran = this.sql.exec("SELECT clave FROM stickers WHERE nombre NOT IN (SELECT nombre FROM usuarios) LIMIT 500")
      .toArray().map((f) => f.clave);
    if (!sobran.length) return;
    if (this.env.ARCHIVOS) {
      try { await this.env.ARCHIVOS.delete(sobran.map((c) => "s/" + c)); } catch (e) { return; }
    }
    for (const c of sobran) this.sql.exec("DELETE FROM stickers WHERE clave = ?", c);
  }

  // ---------- Stickers ----------
  listaStickers(nombre) {
    return this.sql.exec("SELECT clave, ancho, alto FROM stickers WHERE nombre = ? ORDER BY ts DESC", nombre).toArray()
      .map((f) => ({ clave: f.clave, ancho: f.ancho, alto: f.alto }));
  }

  async subirSticker(request) {
    const nombre = await this.usuarioDe(request);
    if (!nombre) return json({ error: "sesion" }, 401);
    if (!this.env.ARCHIVOS) return json({ error: "sin_archivos" }, 503);
    const ahora = Date.now();
    const cuantos = this.sql.exec("SELECT COUNT(*) AS c FROM stickers WHERE nombre = ?", nombre).one().c;
    if (cuantos >= STICKERS_POR_PERSONA) return json({ error: "stickers_lleno" }, 409);
    const recientes = this.sql.exec("SELECT COUNT(*) AS c FROM stickers WHERE nombre = ? AND ts > ?", nombre, ahora - STICKER_SUBIDAS_VENTANA).one().c;
    if (recientes >= STICKER_SUBIDAS_MAX) return json({ error: "muchos" }, 429);
    const datos = await request.arrayBuffer();
    if (!datos.byteLength) return json({ error: "vacio" }, 400);
    if (datos.byteLength > STICKER_MAX) return json({ error: "sticker_grande" }, 413);
    const img = leerImagen(datos);
    if (!img || !img.ancho || !img.alto) return json({ error: "sticker_formato" }, 415);
    if (img.ancho > STICKER_LADO || img.alto > STICKER_LADO) return json({ error: "sticker_lado" }, 400);
    const clave = aleatorio(20);
    await this.env.ARCHIVOS.put("s/" + clave, datos, { httpMetadata: { contentType: img.mime } });
    this.sql.exec("INSERT INTO stickers (clave, nombre, mime, tam, ancho, alto, ts) VALUES (?, ?, ?, ?, ?, ?, ?)",
      clave, nombre, img.mime, datos.byteLength, img.ancho, img.alto, ahora);
    return json({ sticker: { clave, ancho: img.ancho, alto: img.alto }, total: cuantos + 1, max: STICKERS_POR_PERSONA });
  }

  // Solo la dueña o el dueño del sticker puede verlo o borrarlo desde su colección.
  async verSticker(request, clave, borrar) {
    const nombre = await this.usuarioDe(request);
    if (!nombre) return json({ error: "sesion" }, 401);
    const f = this.sql.exec("SELECT mime FROM stickers WHERE clave = ? AND nombre = ?", clave, nombre).toArray()[0];
    if (!f) return json({ error: "no_existe" }, 404);
    if (borrar) {
      if (this.env.ARCHIVOS) await this.env.ARCHIVOS.delete("s/" + clave);
      this.sql.exec("DELETE FROM stickers WHERE clave = ?", clave);
      return json({ ok: true });
    }
    const obj = this.env.ARCHIVOS ? await this.env.ARCHIVOS.get("s/" + clave) : null;
    if (!obj) return json({ error: "no_existe" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": f.mime, "Content-Length": String(obj.size), "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Content-Disposition": "inline",
      },
    });
  }

  async limpiarArchivos() {
    await this.limpiarStickers();
    const limite = Date.now() - SIN_USAR_HORAS * 3600 * 1000;
    const sobran = this.sql.exec(`SELECT clave FROM archivos
      WHERE (mensaje IS NULL AND ts < ?) OR (mensaje IS NOT NULL AND mensaje NOT IN (SELECT id FROM mensajes))
      LIMIT 500`, limite).toArray().map((f) => f.clave);
    if (!sobran.length) return;
    if (this.env.ARCHIVOS) {
      try { await this.env.ARCHIVOS.delete(sobran.map((c) => "m/" + c)); } catch (e) { return; } // se reintenta en la próxima limpieza
    }
    for (const c of sobran) this.sql.exec("DELETE FROM archivos WHERE clave = ?", c);
  }

  // Quién es, a partir del token en "Authorization: Bearer ...".
  async usuarioDe(request) {
    const m = /^Bearer ([a-f0-9]{64})$/.exec(request.headers.get("Authorization") || "");
    if (!m) return null;
    const f = this.sql.exec(`SELECT u.nombre AS nombre FROM sesiones s JOIN usuarios u ON u.nombre = s.nombre
      WHERE s.token_hash = ?`, await sha256(m[1])).toArray()[0];
    return f ? f.nombre : null;
  }

  async subir(request) {
    const nombre = await this.usuarioDe(request);
    if (!nombre) return json({ error: "sesion" }, 401);
    if (!this.env.ARCHIVOS) return json({ error: "sin_archivos" }, 503);
    const tipo = request.headers.get("X-Tipo") || "";
    const reglas = ARCHIVO_TIPOS[tipo];
    const mime = String(request.headers.get("Content-Type") || "").split(";")[0].trim().toLowerCase();
    if (!reglas || !reglas.tipos.includes(mime)) return json({ error: "tipo" }, 415);
    const declarado = Number(request.headers.get("Content-Length") || 0);
    if (declarado > reglas.max) return json({ error: "grande" }, 413);
    const ahora = Date.now();
    const recientes = this.sql.exec("SELECT COUNT(*) AS c FROM archivos WHERE nombre = ? AND ts > ?", nombre, ahora - SUBIDAS_VENTANA).one().c;
    if (recientes >= SUBIDAS_MAX) return json({ error: "muchos" }, 429);
    const datos = await request.arrayBuffer();
    if (!datos.byteLength) return json({ error: "vacio" }, 400);
    if (datos.byteLength > reglas.max) return json({ error: "grande" }, 413);
    const entero = (h, max) => Math.max(0, Math.min(max, Math.round(Number(request.headers.get(h)) || 0)));
    const dur = entero("X-Duracion", 600), ancho = entero("X-Ancho", 10000), alto = entero("X-Alto", 10000);
    if (reglas.dur && dur > reglas.dur + 1) return json({ error: "largo" }, 400);
    const clave = aleatorio(20);
    await this.env.ARCHIVOS.put("m/" + clave, datos, { httpMetadata: { contentType: mime } });
    this.sql.exec(`INSERT INTO archivos (clave, nombre, tipo, mime, tam, dur, ancho, alto, ts, mensaje)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`, clave, nombre, tipo, mime, datos.byteLength, dur, ancho, alto, ahora);
    await this.programarLimpieza();
    return json({ clave });
  }

  // Solo quien puede ver el mensaje (está en ese chat y no lo borró para sí) puede bajar su archivo.
  async bajar(request, clave) {
    const nombre = await this.usuarioDe(request);
    if (!nombre) return json({ error: "sesion" }, 401);
    const a = this.sql.exec(`SELECT a.mime AS mime, m.id AS id, m.sala AS sala FROM archivos a
      JOIN mensajes m ON m.id = a.mensaje WHERE a.clave = ?`, clave).toArray()[0];
    if (!a || !esMiembro(a.sala, nombre)) return json({ error: "no_existe" }, 404);
    const oculto = this.sql.exec("SELECT hasta FROM ocultos WHERE nombre = ? AND sala = ?", nombre, a.sala).toArray()[0];
    if (oculto && a.id <= oculto.hasta) return json({ error: "no_existe" }, 404);
    const obj = this.env.ARCHIVOS ? await this.env.ARCHIVOS.get("m/" + clave) : null;
    if (!obj) return json({ error: "no_existe" }, 404);
    return new Response(obj.body, {
      headers: {
        "Content-Type": a.mime,
        "Content-Length": String(obj.size),
        // Sin caché del navegador: cada pedido se revisa con la sesión (la página guarda el archivo en memoria).
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
      },
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ip = request.headers.get("X-Social-IP") || "desconocida";
    if (url.pathname === "/entrar" || url.pathname === "/registrar") {
      let datos;
      try { datos = await request.json(); } catch (e) { datos = null; }
      return url.pathname === "/registrar" ? this.registrar(datos, ip) : this.entrar(datos, ip);
    }
    if (url.pathname === "/ws") {
      const par = new WebSocketPair();
      this.ctx.acceptWebSocket(par[1]);
      par[1].serializeAttachment({ nombre: null, ip });
      return new Response(null, { status: 101, webSocket: par[0] });
    }
    if (url.pathname === "/subir" && request.method === "POST") return this.subir(request);
    const bajar = /^\/archivo\/([a-f0-9]{40})$/.exec(url.pathname);
    if (bajar && request.method === "GET") return this.bajar(request, bajar[1]);
    if (url.pathname === "/gifs" && request.method === "GET") return this.buscarGifs(request, url);
    if (url.pathname === "/sticker" && request.method === "POST") return this.subirSticker(request);
    if (url.pathname === "/stickers" && request.method === "GET") {
      const nombre = await this.usuarioDe(request);
      if (!nombre) return json({ error: "sesion" }, 401);
      return json({ stickers: this.listaStickers(nombre), max: STICKERS_POR_PERSONA });
    }
    const st = /^\/sticker\/([a-f0-9]{40})$/.exec(url.pathname);
    if (st && (request.method === "GET" || request.method === "DELETE")) return this.verSticker(request, st[1], request.method === "DELETE");
    return new Response("No encontrado", { status: 404 });
  }

  // ---------- Registro y entrada ----------
  fallidosDe(ip) {
    return this.sql.exec("SELECT COUNT(*) AS c, MIN(ts) AS primero FROM intentos WHERE ip = ?", ip).one();
  }

  // Anota un intento fallido. Devuelve cuántos le quedan a esa IP.
  fallar(ip, ahora) {
    this.sql.exec("INSERT INTO intentos (ip, ts) VALUES (?, ?)", ip, ahora);
    return INTENTOS_MAX - this.fallidosDe(ip).c;
  }

  // Revisa el bloqueo por IP y la clave del grupo. Devuelve una respuesta de error, o null si todo bien.
  async revisarClave(datos, ip, ahora) {
    const fallidos = this.fallidosDe(ip);
    if (fallidos.c >= INTENTOS_MAX) {
      const espera = Math.ceil((fallidos.primero + INTENTOS_VENTANA - ahora) / 1000);
      return json({ error: "bloqueado", espera: Math.max(1, espera) }, 429);
    }
    if (!datos || typeof datos !== "object") return json({ error: "datos" }, 400);
    const bien = await this.claveGrupoBien(String(datos.clave || ""));
    if (bien === null) return json({ error: "sin_clave" }, 500);
    if (!bien) {
      const quedan = this.fallar(ip, ahora);
      if (quedan <= 0) return json({ error: "bloqueado", espera: Math.ceil(INTENTOS_VENTANA / 1000) }, 429);
      return json({ error: "clave", quedan }, 401);
    }
    return null;
  }

  ajuste(clave) {
    const f = this.sql.exec("SELECT valor FROM ajustes WHERE clave = ?", clave).toArray()[0];
    return f ? f.valor : null;
  }
  ponerAjuste(clave, valor) {
    this.sql.exec("INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT (clave) DO UPDATE SET valor = excluded.valor", clave, valor);
  }

  // Clave del grupo: la que puso el administrador en la página o, si no puso ninguna, el secreto CLAVE.
  // Devuelve true, false, o null si no hay ninguna clave configurada.
  async claveGrupoBien(clave) {
    const hash = this.ajuste("grupo_hash"), sal = this.ajuste("grupo_sal");
    if (hash && sal) return iguales(await hashPin(clave, sal), hash);
    if (!this.env.CLAVE) return null;
    return iguales(await sha256(clave), await sha256(this.env.CLAVE));
  }

  // Marca guardada en la sesión del administrador: cambia si cambia la clave de administrador.
  async marcaAdmin() {
    return "a:" + (await sha256("admin:" + String(this.env.ADMIN_CLAVE || ""))).slice(0, 24);
  }

  async nuevaSesion(nombre, ahora) {
    const token = aleatorio(32);
    this.sql.exec("INSERT INTO sesiones (token_hash, nombre, visto) VALUES (?, ?, ?)", await sha256(token), nombre, ahora);
    return token;
  }

  async registrar(datos, ip) {
    this.limpiar();
    const ahora = Date.now();
    const error = await this.revisarClave(datos, ip, ahora);
    if (error) return error;

    const nombre = String(datos.nombre || "").trim();
    const pin = String(datos.pin || "");
    const avatar = datos.avatar;
    if (!NOMBRE_VALIDO.test(nombre)) return json({ error: "nombre" }, 400);
    if (!PIN_VALIDO.test(pin)) return json({ error: "pin" }, 400);
    if (!avatarValido(avatar)) return json({ error: "avatar" }, 400);
    if (this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", nombre).toArray().length) return json({ error: "en_uso" }, 409);

    const sal = aleatorio(16);
    this.sql.exec(`INSERT INTO usuarios (nombre, pin_hash, pin_sal, avatar, estado, creado, visto)
      VALUES (?, ?, ?, ?, '', ?, ?)`, nombre, await hashPin(pin, sal), sal, avatar, ahora, ahora);
    this.sql.exec("DELETE FROM intentos WHERE ip = ?", ip);
    const token = await this.nuevaSesion(nombre, ahora);
    this.enviarATodos({ t: "perfil", p: { n: nombre, avatar, estado: "" } });
    return json({ token, nombre });
  }

  async entrar(datos, ip) {
    this.limpiar();
    const ahora = Date.now();
    const error = await this.revisarClave(datos, ip, ahora);
    if (error) return error;

    const nombre = String(datos.nombre || "").trim();
    const pin = String(datos.pin || "");
    const u = NOMBRE_VALIDO.test(nombre)
      ? this.sql.exec("SELECT nombre, pin_hash, pin_sal, fallos, bloqueo FROM usuarios WHERE nombre = ?", nombre).toArray()[0]
      : null;
    if (u && u.bloqueo > ahora) return json({ error: "cuenta_bloqueada", espera: Math.ceil((u.bloqueo - ahora) / 1000) }, 429);

    const bien = u && PIN_VALIDO.test(pin) && iguales(await hashPin(pin, u.pin_sal), u.pin_hash);
    if (!bien) {
      const quedanIp = this.fallar(ip, ahora);
      let quedan = quedanIp;
      if (u) {
        const fallos = u.fallos + 1;
        if (fallos >= PIN_FALLOS_MAX) {
          this.sql.exec("UPDATE usuarios SET fallos = 0, bloqueo = ? WHERE nombre = ?", ahora + PIN_BLOQUEO, u.nombre);
          return json({ error: "cuenta_bloqueada", espera: Math.ceil(PIN_BLOQUEO / 1000) }, 429);
        }
        this.sql.exec("UPDATE usuarios SET fallos = ? WHERE nombre = ?", fallos, u.nombre);
        quedan = Math.min(quedanIp, PIN_FALLOS_MAX - fallos);
      }
      if (quedanIp <= 0) return json({ error: "bloqueado", espera: Math.ceil(INTENTOS_VENTANA / 1000) }, 429);
      return json({ error: "credenciales", quedan }, 401);
    }

    this.sql.exec("UPDATE usuarios SET fallos = 0, bloqueo = 0, visto = ? WHERE nombre = ?", ahora, u.nombre);
    this.sql.exec("DELETE FROM intentos WHERE ip = ?", ip);
    const token = await this.nuevaSesion(u.nombre, ahora);
    return json({ token, nombre: u.nombre });
  }

  // ---------- WebSocket ----------
  enviar(ws, datos) { try { ws.send(JSON.stringify(datos)); } catch (e) { /* conexión cerrada */ } }

  enviarATodos(datos, excepto) {
    const texto = JSON.stringify(datos);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excepto) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.nombre) continue;
      try { ws.send(texto); } catch (e) { /* conexión cerrada */ }
    }
  }

  // Envía a todas las conexiones de una persona (su teléfono, su computadora...).
  enviarAUsuario(nombre, datos) {
    const texto = JSON.stringify(datos);
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.nombre || a.nombre.toLowerCase() !== nombre.toLowerCase()) continue;
      try { ws.send(texto); } catch (e) { /* conexión cerrada */ }
    }
  }

  silenciosDe(nombre) {
    return this.sql.exec("SELECT tipo, valor FROM silencios WHERE nombre = ?", nombre).toArray()
      .map((s) => ({ tipo: s.tipo, valor: s.valor }));
  }

  // Envía solo a quienes están en ese chat (en el general, a todos).
  enviarASala(sala, datos, excepto) {
    const texto = JSON.stringify(datos);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === excepto) continue;
      const a = ws.deserializeAttachment();
      if (!a || !a.nombre || !esMiembro(sala, a.nombre)) continue;
      try { ws.send(texto); } catch (e) { /* conexión cerrada */ }
    }
  }

  estado(sin) {
    const enLinea = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sin) continue;
      const a = ws.deserializeAttachment();
      if (a && a.nombre) enLinea.add(a.nombre.toLowerCase());
    }
    // "visto": la última vez que estuvo conectado (para "Últ. vez hoy a las…"). Solo si no está en línea.
    const usuarios = this.sql.exec("SELECT nombre, visto FROM usuarios ORDER BY nombre").toArray()
      .map((u) => enLinea.has(u.nombre.toLowerCase())
        ? { n: u.nombre, enLinea: true }
        : { n: u.nombre, enLinea: false, visto: u.visto });
    return { t: "estado", usuarios };
  }

  perfiles() {
    return this.sql.exec("SELECT nombre, avatar, estado FROM usuarios ORDER BY nombre").toArray()
      .map((u) => ({ n: u.nombre, avatar: u.avatar, estado: u.estado }));
  }

  // Cierra todas las conexiones de un usuario (por ejemplo, al borrar su cuenta).
  cerrarDe(nombre, codigo, motivo) {
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || !a.nombre || a.nombre.toLowerCase() !== nombre.toLowerCase()) continue;
      this.enviar(ws, { t: "sesion_invalida", motivo });
      ws.serializeAttachment({ nombre: null });
      try { ws.close(codigo, motivo); } catch (e) { /* ya cerrada */ }
    }
  }

  // Protección contra quien manda mensajes sin parar: más de 40 cada 10 segundos se ignoran.
  demasiado(ws) {
    if (!this.ritmo) this.ritmo = new WeakMap();
    const ahora = Date.now();
    const r = this.ritmo.get(ws) || { desde: ahora, n: 0 };
    if (ahora - r.desde > 10000) { r.desde = ahora; r.n = 0; }
    r.n++;
    this.ritmo.set(ws, r);
    return r.n > 40;
  }

  async webSocketMessage(ws, crudo) {
    if (typeof crudo !== "string" || crudo.length > MAX_WS) return;
    let m;
    try { m = JSON.parse(crudo); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const yo = ws.deserializeAttachment() || {};
    if (this.demasiado(ws)) return;

    if (!yo.nombre) {
      if (m.t !== "auth") return;
      const hash = await sha256(String(m.token || ""));
      const fila = this.sql.exec(`SELECT u.nombre AS nombre, s.admin AS admin FROM sesiones s
        JOIN usuarios u ON u.nombre = s.nombre WHERE s.token_hash = ?`, hash).toArray()[0];
      if (!fila) {
        // Token desconocido o vencido: hay que volver a entrar.
        this.sql.exec("DELETE FROM sesiones WHERE token_hash = ?", hash);
        this.enviar(ws, { t: "sesion_invalida" });
        ws.close(4001, "sesion");
        return;
      }
      this.limpiar();
      const ahora = Date.now();
      this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", ahora, fila.nombre);
      this.sql.exec("UPDATE sesiones SET visto = ? WHERE token_hash = ?", ahora, hash);
      // Sigue siendo administrador solo si la clave de administrador no cambió desde que entró.
      const admin = !!this.env.ADMIN_CLAVE && String(fila.admin) === await this.marcaAdmin();
      ws.serializeAttachment({ nombre: fila.nombre, ses: hash, ip: yo.ip, admin });
      // Solo los chats donde está esta persona: el general y sus privados.
      // Sin los mensajes de los chats que esta persona borró para sí.
      const ocultos = new Map(this.sql.exec("SELECT sala, hasta FROM ocultos WHERE nombre = ?", fila.nombre).toArray()
        .map((o) => [o.sala, o.hasta]));
      const mensajes = this.sql.exec("SELECT id, sala, nombre, texto, ts, archivo, tipo, dur, ancho, alto, gif, cita FROM mensajes ORDER BY id").toArray()
        .filter((x) => esMiembro(x.sala, fila.nombre) && x.id > (ocultos.get(x.sala) || 0)).map(paraEnviar);
      const lecturas = this.sql.exec("SELECT nombre, sala, id FROM lecturas").toArray()
        .filter((x) => esMiembro(x.sala, fila.nombre)).map((x) => ({ n: x.nombre, sala: x.sala, id: x.id }));
      const visibles = new Set(mensajes.map((x) => x.id));
      const reacciones = this.sql.exec("SELECT id, nombre, emoji FROM reacciones").toArray()
        .filter((x) => visibles.has(x.id)).map((x) => ({ id: x.id, n: x.nombre, e: x.emoji }));
      this.enviar(ws, { t: "hola", yo: fila.nombre, mensajes, lecturas, perfiles: this.perfiles(), horas: this.horas(), admin,
        silencios: this.silenciosDe(fila.nombre), reacciones });
      this.enviarATodos(this.estado());
      await this.programarLimpieza();
      return;
    }

    if (m.t === "msg") {
      const ahora = Date.now();
      const antes = this.ultimoEnvio.get(yo.nombre) || 0;
      if (ahora - antes < ESPERA_ENTRE_MENSAJES) { this.enviar(ws, { t: "error", e: "rapido", cid: m.cid }); return; }
      const sala = m.sala === undefined ? "general" : m.sala;
      if (!this.salaPermitida(sala, yo.nombre)) { this.enviar(ws, { t: "error", e: "sala", cid: m.cid }); return; }
      const texto = limpiarTexto(m.texto, true);
      // Archivo ya subido por esta misma persona y todavía sin enviar.
      let arch = null;
      if (m.archivo !== undefined) {
        arch = CLAVE_ARCHIVO.test(String(m.archivo || ""))
          ? this.sql.exec("SELECT clave, tipo, dur, ancho, alto FROM archivos WHERE clave = ? AND nombre = ? AND mensaje IS NULL",
            m.archivo, yo.nombre).toArray()[0]
          : null;
        if (!arch) { this.enviar(ws, { t: "error", e: "archivo", cid: m.cid }); return; }
      }
      // GIF: solo uno que este servidor mostró en el buscador (así siempre es G o PG).
      let gif = null;
      if (m.gif !== undefined) {
        const g = GIF_ID.test(String(m.gif || ""))
          ? this.sql.exec("SELECT url, ancho, alto FROM gifs WHERE id = ?", m.gif).toArray()[0] : null;
        if (!g || arch) { this.enviar(ws, { t: "error", e: "gif", cid: m.cid }); return; }
        gif = { u: g.url, w: g.ancho, h: g.alto };
      }
      // Responder: el mensaje original tiene que estar en este mismo chat y verlo quien responde.
      let cita = null;
      if (m.resp !== undefined) {
        const o = Number.isInteger(m.resp)
          ? this.sql.exec("SELECT id, sala, nombre, texto, tipo, gif, dur FROM mensajes WHERE id = ?", m.resp).toArray()[0] : null;
        const oculto = o && this.sql.exec("SELECT hasta FROM ocultos WHERE nombre = ? AND sala = ?", yo.nombre, sala).toArray()[0];
        if (!o || o.sala !== sala || (oculto && o.id <= oculto.hasta)) { this.enviar(ws, { t: "error", e: "responder", cid: m.cid }); return; }
        cita = { id: o.id, n: o.nombre, x: [...String(o.texto || "")].slice(0, MAX_CITA).join("") };
        if (o.gif) cita.tp = "gif"; else if (o.tipo) { cita.tp = o.tipo; if (o.dur) cita.dur = o.dur; }
      }
      // Sticker de mi colección: se copia a "m/" como un archivo más del mensaje (se borra con él a las 24 horas).
      if (m.sticker !== undefined) {
        const st = CLAVE_ARCHIVO.test(String(m.sticker || ""))
          ? this.sql.exec("SELECT clave, mime, tam, ancho, alto FROM stickers WHERE clave = ? AND nombre = ?", m.sticker, yo.nombre).toArray()[0]
          : null;
        if (!st || arch || gif || !this.env.ARCHIVOS) { this.enviar(ws, { t: "error", e: "sticker", cid: m.cid }); return; }
        this.ultimoEnvio.set(yo.nombre, ahora); // antes de esperar a R2, para que no se cuelen envíos seguidos
        const obj = await this.env.ARCHIVOS.get("s/" + st.clave);
        if (!obj) { this.enviar(ws, { t: "error", e: "sticker", cid: m.cid }); return; }
        const datos = await obj.arrayBuffer();
        const copia = aleatorio(20);
        await this.env.ARCHIVOS.put("m/" + copia, datos, { httpMetadata: { contentType: st.mime } });
        this.sql.exec(`INSERT INTO archivos (clave, nombre, tipo, mime, tam, dur, ancho, alto, ts, mensaje)
          VALUES (?, ?, 'sticker', ?, ?, 0, ?, ?, ?, NULL)`, copia, yo.nombre, st.mime, datos.byteLength, st.ancho, st.alto, Date.now());
        arch = { clave: copia, tipo: "sticker", dur: 0, ancho: st.ancho, alto: st.alto };
      }
      if (!texto && !arch && !gif) return;
      if ([...texto].length > MAX_LARGO) { this.enviar(ws, { t: "error", e: "largo", cid: m.cid }); return; }
      this.ultimoEnvio.set(yo.nombre, ahora);
      const id = this.sql.exec(`INSERT INTO mensajes (sala, nombre, texto, ts, archivo, tipo, dur, ancho, alto, gif, cita)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`, sala, yo.nombre, texto, ahora,
        arch ? arch.clave : null, arch ? arch.tipo : null, arch ? arch.dur : 0, arch ? arch.ancho : 0, arch ? arch.alto : 0,
        gif ? JSON.stringify(gif) : null, cita ? JSON.stringify(cita) : null).one().id;
      if (arch) this.sql.exec("UPDATE archivos SET mensaje = ? WHERE clave = ?", id, arch.clave);
      this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", ahora, yo.nombre);
      this.marcarLeido(yo.nombre, sala, id);
      this.limpiar();
      const nuevo = paraEnviar({ id, sala, nombre: yo.nombre, texto, ts: ahora,
        archivo: arch && arch.clave, tipo: arch && arch.tipo, dur: arch ? arch.dur : 0, ancho: arch ? arch.ancho : 0, alto: arch ? arch.alto : 0,
        gif, cita });
      this.enviarASala(sala, { t: "msg", m: nuevo, cid: m.cid });
      this.enviarASala(sala, { t: "leido", n: yo.nombre, sala, id });
      await this.limpiarArchivos();
      await this.programarLimpieza();
      return;
    }

    if (m.t === "perfil") {
      const ahora = Date.now();
      if (ahora - (this.ultimoPerfil.get(yo.nombre) || 0) < ESPERA_ENTRE_PERFILES) { this.enviar(ws, { t: "error", e: "rapido" }); return; }
      const cambios = [], valores = [];
      if (m.estado !== undefined) {
        const estado = limpiarTexto(m.estado, false);
        if ([...estado].length > MAX_ESTADO) { this.enviar(ws, { t: "error", e: "estado_largo" }); return; }
        cambios.push("estado = ?"); valores.push(estado);
      }
      if (m.avatar !== undefined) {
        if (!avatarValido(m.avatar)) { this.enviar(ws, { t: "error", e: "avatar" }); return; }
        cambios.push("avatar = ?"); valores.push(m.avatar);
      }
      if (!cambios.length) return;
      this.ultimoPerfil.set(yo.nombre, ahora);
      this.sql.exec(`UPDATE usuarios SET ${cambios.join(", ")}, visto = ? WHERE nombre = ?`, ...valores, ahora, yo.nombre);
      const p = this.sql.exec("SELECT nombre, avatar, estado FROM usuarios WHERE nombre = ?", yo.nombre).toArray()[0];
      if (p) this.enviarATodos({ t: "perfil", p: { n: p.nombre, avatar: p.avatar, estado: p.estado } });
      return;
    }

    if (m.t === "escribiendo") {
      const ahoraE = Date.now();
      if (ahoraE - (this.ultimoEscribiendo.get(yo.nombre) || 0) < 1000) return;
      this.ultimoEscribiendo.set(yo.nombre, ahoraE);
      const sala = m.sala === undefined ? "general" : m.sala;
      if (!this.salaPermitida(sala, yo.nombre)) return;
      this.enviarASala(sala, { t: "escribiendo", n: yo.nombre, sala }, ws);
      return;
    }

    if (m.t === "leido") {
      const sala = m.sala === undefined ? "general" : m.sala;
      if (!this.salaPermitida(sala, yo.nombre)) return;
      const maximo = this.sql.exec("SELECT COALESCE(MAX(id), 0) AS m FROM mensajes WHERE sala = ?", sala).one().m;
      const id = Math.min(Math.floor(Number(m.id) || 0), maximo); // no se puede "leer" un mensaje que aún no existe
      if (id <= 0) return;
      this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", Date.now(), yo.nombre);
      this.enviarASala(sala, { t: "leido", n: yo.nombre, sala, id: this.marcarLeido(yo.nombre, sala, id) });
      return;
    }

    if (m.t === "silenciar") {
      const tipo = m.tipo === "persona" ? "persona" : m.tipo === "sala" ? "sala" : null;
      if (!tipo) return;
      let valor = String(m.valor || "");
      if (tipo === "sala" && !this.salaPermitida(valor, yo.nombre)) return;
      if (tipo === "persona") {
        const u = this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", valor).toArray()[0];
        if (!u || u.nombre.toLowerCase() === yo.nombre.toLowerCase()) return;
        valor = u.nombre;
      }
      if (m.activo) this.sql.exec("INSERT OR IGNORE INTO silencios (nombre, tipo, valor) VALUES (?, ?, ?)", yo.nombre, tipo, valor);
      else this.sql.exec("DELETE FROM silencios WHERE nombre = ? AND tipo = ? AND valor = ?", yo.nombre, tipo, valor);
      this.enviarAUsuario(yo.nombre, { t: "silencios", lista: this.silenciosDe(yo.nombre) });
      return;
    }

    if (m.t === "traducir") {
      // Traduce un mensaje que esta persona puede ver al idioma pedido (español o inglés).
      const id = Math.floor(Number(m.id) || 0);
      let a = m.a === "en" ? "en" : "es";
      const msg = this.sql.exec("SELECT id, sala, texto FROM mensajes WHERE id = ?", id).toArray()[0];
      const oculto = msg && this.sql.exec("SELECT hasta FROM ocultos WHERE nombre = ? AND sala = ?", yo.nombre, msg.sala).toArray()[0];
      if (!msg || !msg.texto || !esMiembro(msg.sala, yo.nombre) || (oculto && msg.id <= oculto.hasta)) {
        this.enviar(ws, { t: "error", e: "traducir", id });
        return;
      }
      const guardada = (idioma) => this.sql.exec("SELECT texto FROM traducciones WHERE id = ? AND idioma = ?", id, idioma).toArray()[0];
      let lista = guardada(a);
      if (lista) { this.enviar(ws, { t: "traduccion", id, a, texto: lista.texto }); return; }
      if (!this.env.AI && this.env.TRADUCTOR_PRUEBA !== "1") { this.enviar(ws, { t: "error", e: "sin_traductor", id }); return; }
      const ahora = Date.now();
      const recientes = (this.traduccionesRecientes.get(yo.nombre) || []).filter((x) => x > ahora - TRADUCCIONES_VENTANA);
      if (recientes.length >= TRADUCCIONES_MAX) { this.enviar(ws, { t: "error", e: "traducir_limite", id }); return; }
      recientes.push(ahora);
      this.traduccionesRecientes.set(yo.nombre, recientes);
      const soloLetras = (x) => x.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
      const igual = (x, y) => soloLetras(x) === soloLetras(y);
      let texto;
      try {
        texto = await this.traducirTexto(msg.texto, a === "es" ? "en" : "es", a);
        // Si el mensaje ya estaba en ese idioma, se traduce al otro.
        if (!texto || igual(texto, msg.texto)) {
          const otro = a === "es" ? "en" : "es";
          lista = guardada(otro);
          texto = lista ? lista.texto : await this.traducirTexto(msg.texto, a, otro);
          a = otro;
        }
      } catch (e) {
        this.enviar(ws, { t: "error", e: "traducir", id });
        return;
      }
      if (!texto) { this.enviar(ws, { t: "error", e: "traducir", id }); return; }
      // El mensaje pudo borrarse mientras se traducía.
      if (this.sql.exec("SELECT id FROM mensajes WHERE id = ?", id).toArray().length) {
        this.sql.exec("INSERT OR REPLACE INTO traducciones (id, idioma, texto) VALUES (?, ?, ?)", id, a, texto);
      }
      this.enviar(ws, { t: "traduccion", id, a, texto });
      return;
    }

    if (m.t === "desbloquear") {
      // Después de la X (salida de emergencia), el chat se vuelve a abrir con el PIN de esta cuenta.
      // La respuesta solo dice sí o no (ni cuántos intentos quedan ni si hay bloqueo): con un no, el
      // teléfono muestra una pantalla vacía. 5 errores bloquean la cuenta 1 hora, como al entrar.
      const ahora = Date.now();
      const pin = String(m.pin || "");
      const u = this.sql.exec("SELECT nombre, pin_hash, pin_sal, fallos, bloqueo FROM usuarios WHERE nombre = ?", yo.nombre).toArray()[0];
      let bien = false;
      if (u && u.bloqueo <= ahora) {
        bien = PIN_VALIDO.test(pin) && iguales(await hashPin(pin, u.pin_sal), u.pin_hash);
        if (bien) this.sql.exec("UPDATE usuarios SET fallos = 0 WHERE nombre = ?", u.nombre);
        else if (u.fallos + 1 >= PIN_FALLOS_MAX) this.sql.exec("UPDATE usuarios SET fallos = 0, bloqueo = ? WHERE nombre = ?", ahora + PIN_BLOQUEO, u.nombre);
        else this.sql.exec("UPDATE usuarios SET fallos = ? WHERE nombre = ?", u.fallos + 1, u.nombre);
      }
      this.enviar(ws, { t: "desbloqueo", ok: bien });
      return;
    }

    if (m.t === "reaccion") {
      // Una reacción por persona y mensaje. La misma otra vez (o "") la quita; otra distinta la cambia.
      const id = Math.floor(Number(m.id) || 0);
      const msg = this.sql.exec("SELECT id, sala FROM mensajes WHERE id = ?", id).toArray()[0];
      const oculto = msg && this.sql.exec("SELECT hasta FROM ocultos WHERE nombre = ? AND sala = ?", yo.nombre, msg.sala).toArray()[0];
      if (!msg || !esMiembro(msg.sala, yo.nombre) || (oculto && msg.id <= oculto.hasta)) return;
      const pedido = REACCIONES.includes(m.e) ? m.e : "";
      const antes = this.sql.exec("SELECT emoji FROM reacciones WHERE id = ? AND nombre = ?", id, yo.nombre).toArray()[0];
      const e = antes && antes.emoji === pedido ? "" : pedido;
      if (e) {
        this.sql.exec(`INSERT INTO reacciones (id, nombre, emoji) VALUES (?, ?, ?)
          ON CONFLICT (id, nombre) DO UPDATE SET emoji = excluded.emoji`, id, yo.nombre, e);
      } else {
        this.sql.exec("DELETE FROM reacciones WHERE id = ? AND nombre = ?", id, yo.nombre);
      }
      this.enviarASala(msg.sala, { t: "reaccion", sala: msg.sala, id, n: yo.nombre, e });
      return;
    }

    if (m.t === "ocultar_chat") {
      // Borrar chat solo para mí: dejo de ver lo que hay hasta ahora. Lo nuevo sí llega.
      const sala = String(m.sala || "");
      if (!this.salaPermitida(sala, yo.nombre)) return;
      const hasta = this.sql.exec("SELECT COALESCE(MAX(id), 0) AS m FROM mensajes WHERE sala = ?", sala).one().m;
      this.sql.exec(`INSERT INTO ocultos (nombre, sala, hasta) VALUES (?, ?, ?)
        ON CONFLICT (nombre, sala) DO UPDATE SET hasta = MAX(hasta, excluded.hasta)`, yo.nombre, sala, hasta);
      if (hasta > 0) this.enviarASala(sala, { t: "leido", n: yo.nombre, sala, id: this.marcarLeido(yo.nombre, sala, hasta) });
      this.enviarAUsuario(yo.nombre, { t: "chat_oculto", sala, hasta });
      return;
    }

    if (m.t === "salir") {
      // Cierra la sesión de este teléfono. La cuenta sigue: se vuelve a entrar con nombre y PIN.
      this.sql.exec("DELETE FROM sesiones WHERE token_hash = ?", yo.ses || "");
      ws.serializeAttachment({ nombre: null });
      ws.close(1000, "salir");
      this.enviarATodos(this.estado(ws));
      return;
    }

    if (m.t === "borrar_cuenta") {
      // Borra la cuenta y todas sus sesiones. El nombre queda libre.
      this.sql.exec("DELETE FROM sesiones WHERE nombre = ?", yo.nombre);
      this.sql.exec("DELETE FROM usuarios WHERE nombre = ?", yo.nombre);
      this.limpiar(); // también borra sus chats privados y lo que leyó
      this.cerrarDe(yo.nombre, 4001, "cuenta_borrada");
      this.enviarATodos({ t: "perfil_borrado", n: yo.nombre });
      this.enviarATodos(this.estado());
      await this.limpiarArchivos();
      return;
    }

    if (typeof m.t === "string" && m.t.startsWith("admin_")) await this.mensajeAdmin(ws, yo, m);
  }

  // ---------- Administrador ----------
  // Lo que el panel de administrador muestra de los chats privados: quiénes y cuántos mensajes, nunca el texto.
  datosAdmin() {
    const chats = this.sql.exec(`SELECT sala, COUNT(*) AS cuantos, MAX(ts) AS ultimo FROM mensajes
      GROUP BY sala ORDER BY ultimo DESC`).toArray()
      .map((c) => ({ sala: c.sala, miembros: miembros(c.sala), cuantos: c.cuantos, ultimo: c.ultimo }));
    return { t: "admin_datos", chats, clavePropia: !!this.ajuste("grupo_hash") };
  }

  responderAdmin(ws, datos) {
    this.enviar(ws, datos);
    this.enviar(ws, this.datosAdmin());
  }

  async mensajeAdmin(ws, yo, m) {
    const ahora = Date.now();

    if (m.t === "admin_entrar") {
      if (!this.env.ADMIN_CLAVE) { this.enviar(ws, { t: "error", e: "sin_admin" }); return; }
      // Bloqueo por IP (el mismo de la clave del grupo) y bloqueo general de la entrada de administrador.
      const ip = yo.ip || "desconocida";
      const fallidos = this.fallidosDe(ip);
      this.sql.exec("DELETE FROM intentos_admin WHERE ts < ?", ahora - ADMIN_BLOQUEO);
      const generales = this.sql.exec("SELECT COUNT(*) AS c, MIN(ts) AS primero FROM intentos_admin").one();
      if (fallidos.c >= INTENTOS_MAX || generales.c >= ADMIN_FALLOS_MAX) {
        const hasta = fallidos.c >= INTENTOS_MAX ? fallidos.primero + INTENTOS_VENTANA : generales.primero + ADMIN_BLOQUEO;
        this.enviar(ws, { t: "error", e: "admin_bloqueado", espera: Math.max(1, Math.ceil((hasta - ahora) / 1000)) });
        return;
      }
      if (!iguales(await sha256(String(m.clave || "")), await sha256(this.env.ADMIN_CLAVE))) {
        this.sql.exec("INSERT INTO intentos_admin (ts) VALUES (?)", ahora);
        const quedan = this.fallar(ip, ahora);
        this.enviar(ws, { t: "error", e: "admin_clave", quedan: Math.max(0, Math.min(quedan, ADMIN_FALLOS_MAX - generales.c - 1)) });
        return;
      }
      this.sql.exec("UPDATE sesiones SET admin = ? WHERE token_hash = ?", await this.marcaAdmin(), yo.ses || "");
      ws.serializeAttachment({ ...yo, admin: true });
      this.responderAdmin(ws, { t: "admin", activo: true });
      return;
    }

    if (!yo.admin) { this.enviar(ws, { t: "error", e: "no_admin" }); return; }

    if (m.t === "admin_salir") {
      this.sql.exec("UPDATE sesiones SET admin = 0 WHERE token_hash = ?", yo.ses || "");
      ws.serializeAttachment({ ...yo, admin: false });
      this.enviar(ws, { t: "admin", activo: false });
      return;
    }

    if (m.t === "admin_datos") { this.enviar(ws, this.datosAdmin()); return; }

    if (m.t === "admin_clave") {
      const nueva = String(m.clave || "");
      if (nueva.length < MIN_CLAVE_GRUPO || nueva.length > MAX_CLAVE_GRUPO || /[\u0000-\u001F\u007F]/.test(nueva)) {
        this.enviar(ws, { t: "error", e: "clave_corta" });
        return;
      }
      const sal = aleatorio(16);
      this.ponerAjuste("grupo_sal", sal);
      this.ponerAjuste("grupo_hash", await hashPin(nueva, sal));
      // Las personas que ya entraron siguen dentro; la clave nueva se pide al crear usuario o entrar en otro teléfono.
      this.responderAdmin(ws, { t: "admin_ok", accion: "clave" });
      return;
    }

    if (m.t === "admin_pin") {
      // Restablecer el PIN de alguien que lo olvidó. El PIN viejo no se puede ver (solo se guarda su hash):
      // el administrador pone uno nuevo y se lo da en persona. La cuenta y sus chats se conservan, y se quita
      // el bloqueo por PIN equivocado. Las sesiones abiertas siguen (así sirve también para el candado de la X).
      const u = this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", String(m.n || "")).toArray()[0];
      if (!u) { this.enviar(ws, { t: "error", e: "no_existe" }); return; }
      const pin = String(m.pin || "");
      if (!PIN_VALIDO.test(pin)) { this.enviar(ws, { t: "error", e: "admin_pin" }); return; }
      const sal = aleatorio(16);
      this.sql.exec("UPDATE usuarios SET pin_hash = ?, pin_sal = ?, fallos = 0, bloqueo = 0 WHERE nombre = ?",
        await hashPin(pin, sal), sal, u.nombre);
      this.responderAdmin(ws, { t: "admin_ok", accion: "pin", n: u.nombre });
      return;
    }

    if (m.t === "admin_sacar") {
      const u = this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", String(m.n || "")).toArray()[0];
      if (!u) { this.enviar(ws, { t: "error", e: "no_existe" }); return; }
      if (u.nombre.toLowerCase() === yo.nombre.toLowerCase()) { this.enviar(ws, { t: "error", e: "no_a_ti" }); return; }
      this.sql.exec("DELETE FROM sesiones WHERE nombre = ?", u.nombre);
      this.sql.exec("DELETE FROM usuarios WHERE nombre = ?", u.nombre);
      this.limpiar(); // también borra sus chats privados
      this.cerrarDe(u.nombre, 4001, "sacado");
      this.enviarATodos({ t: "perfil_borrado", n: u.nombre });
      this.enviarATodos(this.estado());
      await this.limpiarArchivos();
      this.responderAdmin(ws, { t: "admin_ok", accion: "sacar", n: u.nombre });
      return;
    }

    if (m.t === "admin_borrar_msg") {
      // Solo mensajes que el administrador puede ver: los del general y los de sus propios chats privados.
      const msg = this.sql.exec("SELECT id, sala FROM mensajes WHERE id = ?", Math.floor(Number(m.id) || 0)).toArray()[0];
      if (!msg || !esMiembro(msg.sala, yo.nombre)) { this.enviar(ws, { t: "error", e: "no_existe" }); return; }
      this.sql.exec("DELETE FROM mensajes WHERE id = ?", msg.id);
      this.enviarASala(msg.sala, { t: "borrado", sala: msg.sala, id: msg.id });
      await this.limpiarArchivos();
      this.responderAdmin(ws, { t: "admin_ok", accion: "mensaje" });
      return;
    }

    if (m.t === "admin_borrar_chat") {
      // Cualquier chat, también los privados de otros (se borran sin leerlos).
      const sala = String(m.sala || "");
      if (sala !== "general" && !miembros(sala)) { this.enviar(ws, { t: "error", e: "no_existe" }); return; }
      this.sql.exec("DELETE FROM mensajes WHERE sala = ?", sala);
      this.sql.exec("DELETE FROM lecturas WHERE sala = ?", sala);
      this.enviarASala(sala, { t: "chat_borrado", sala, por: "admin" });
      await this.limpiarArchivos();
      this.responderAdmin(ws, { t: "admin_ok", accion: "chat" });
    }
  }

  // Al desconectarse se guarda la hora: es la "última vez" que ven los demás.
  marcarSalida(ws) {
    const a = ws.deserializeAttachment();
    if (a && a.nombre) this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", Date.now(), a.nombre);
  }

  async webSocketClose(ws, codigo) {
    try { ws.close(codigo === 1005 ? 1000 : codigo, "adios"); } catch (e) { /* ya cerrada */ }
    this.marcarSalida(ws);
    this.enviarATodos(this.estado(ws), ws);
  }

  async webSocketError(ws) {
    this.marcarSalida(ws);
    this.enviarATodos(this.estado(ws), ws);
  }
}
