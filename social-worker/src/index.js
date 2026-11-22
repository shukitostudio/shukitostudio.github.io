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

function origenPermitido(request, env) {
  const origen = request.headers.get("Origin") || "";
  const lista = String(env.ORIGENES || "").split(",").map((s) => s.trim()).filter(Boolean);
  return lista.includes(origen) ? origen : null;
}

function cors(origen) {
  return {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
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
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, texto TEXT NOT NULL, ts INTEGER NOT NULL,
      sala TEXT NOT NULL DEFAULT 'general')`);
    // Mensajes de antes de los chats privados: todos eran del chat general.
    const tablaMensajes = this.sql.exec("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'mensajes'").one();
    if (!String(tablaMensajes.sql).includes("sala")) this.sql.exec("ALTER TABLE mensajes ADD COLUMN sala TEXT NOT NULL DEFAULT 'general'");
    this.sql.exec("CREATE INDEX IF NOT EXISTS mensajes_sala ON mensajes (sala, id)");
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
    // Chats privados de alguien que ya no existe: se borran (así nadie que use ese nombre después los ve).
    const existen = new Set(this.sql.exec("SELECT nombre FROM usuarios").toArray().map((u) => u.nombre.toLowerCase()));
    const salas = this.sql.exec("SELECT DISTINCT sala FROM mensajes WHERE sala <> 'general'").toArray().map((f) => f.sala)
      .concat(this.sql.exec("SELECT DISTINCT sala FROM lecturas WHERE sala <> 'general'").toArray().map((f) => f.sala));
    for (const sala of new Set(salas)) {
      const m = miembros(sala);
      if (m && m.every((n) => existen.has(n))) continue;
      this.sql.exec("DELETE FROM mensajes WHERE sala = ?", sala);
      this.sql.exec("DELETE FROM lecturas WHERE sala = ?", sala);
    }
    this.sql.exec("DELETE FROM intentos WHERE ts < ?", ahora - INTENTOS_VENTANA);
  }

  // Un chat al que "yo" puede escribir: el general, o uno privado con otra persona que existe.
  salaPermitida(sala, yo) {
    if (sala === "general") return true;
    if (typeof sala !== "string" || !esMiembro(sala, yo)) return false;
    const [a, b] = miembros(sala);
    if (a === b) return false;
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
    const fila = this.sql.exec("SELECT COUNT(*) AS c FROM mensajes").one();
    // Cada teléfono borra los mensajes más viejos que "corte" y deja como máximo "max" por chat.
    this.enviarATodos({ t: "purga", corte: Date.now() - this.horas() * 3600 * 1000, max: this.maxMensajes() });
    if (fila.c > 0 || this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + LIMPIEZA_CADA);
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
    const usuarios = this.sql.exec("SELECT nombre FROM usuarios ORDER BY nombre").toArray()
      .map((u) => ({ n: u.nombre, enLinea: enLinea.has(u.nombre.toLowerCase()) }));
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

  async webSocketMessage(ws, crudo) {
    if (typeof crudo !== "string" || crudo.length > MAX_WS) return;
    let m;
    try { m = JSON.parse(crudo); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const yo = ws.deserializeAttachment() || {};

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
      const admin = !!fila.admin && !!this.env.ADMIN_CLAVE;
      ws.serializeAttachment({ nombre: fila.nombre, ses: hash, ip: yo.ip, admin });
      // Solo los chats donde está esta persona: el general y sus privados.
      const mensajes = this.sql.exec("SELECT id, sala, nombre, texto, ts FROM mensajes ORDER BY id").toArray()
        .filter((x) => esMiembro(x.sala, fila.nombre));
      const lecturas = this.sql.exec("SELECT nombre, sala, id FROM lecturas").toArray()
        .filter((x) => esMiembro(x.sala, fila.nombre)).map((x) => ({ n: x.nombre, sala: x.sala, id: x.id }));
      this.enviar(ws, { t: "hola", yo: fila.nombre, mensajes, lecturas, perfiles: this.perfiles(), horas: this.horas(), admin });
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
      if (!texto) return;
      if ([...texto].length > MAX_LARGO) { this.enviar(ws, { t: "error", e: "largo", cid: m.cid }); return; }
      this.ultimoEnvio.set(yo.nombre, ahora);
      const id = this.sql.exec("INSERT INTO mensajes (sala, nombre, texto, ts) VALUES (?, ?, ?, ?) RETURNING id",
        sala, yo.nombre, texto, ahora).one().id;
      this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", ahora, yo.nombre);
      this.marcarLeido(yo.nombre, sala, id);
      this.limpiar();
      this.enviarASala(sala, { t: "msg", m: { id, sala, nombre: yo.nombre, texto, ts: ahora }, cid: m.cid });
      this.enviarASala(sala, { t: "leido", n: yo.nombre, sala, id });
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
      this.sql.exec("UPDATE sesiones SET admin = 1 WHERE token_hash = ?", yo.ses || "");
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
      this.responderAdmin(ws, { t: "admin_ok", accion: "sacar", n: u.nombre });
      return;
    }

    if (m.t === "admin_borrar_msg") {
      // Solo mensajes que el administrador puede ver: los del general y los de sus propios chats privados.
      const msg = this.sql.exec("SELECT id, sala FROM mensajes WHERE id = ?", Math.floor(Number(m.id) || 0)).toArray()[0];
      if (!msg || !esMiembro(msg.sala, yo.nombre)) { this.enviar(ws, { t: "error", e: "no_existe" }); return; }
      this.sql.exec("DELETE FROM mensajes WHERE id = ?", msg.id);
      this.enviarASala(msg.sala, { t: "borrado", sala: msg.sala, id: msg.id });
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
      this.responderAdmin(ws, { t: "admin_ok", accion: "chat" });
    }
  }

  async webSocketClose(ws, codigo) {
    try { ws.close(codigo === 1005 ? 1000 : codigo, "adios"); } catch (e) { /* ya cerrada */ }
    this.enviarATodos(this.estado(ws), ws);
  }

  async webSocketError(ws) {
    this.enviarATodos(this.estado(ws), ws);
  }
}
