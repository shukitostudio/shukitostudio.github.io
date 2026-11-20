// Chat Social de Shukito Studio: un solo chat de grupo para unos pocos invitados.
// Worker + un Durable Object ("SalaSocial") con WebSocket. La clave vive en el secreto CLAVE.
import { DurableObject } from "cloudflare:workers";

const NOMBRE_VALIDO = /^[A-Za-z0-9]{3,16}$/;
const MAX_LARGO = 500;          // caracteres por mensaje
const INTENTOS_MAX = 5;         // intentos fallidos de clave por IP...
const INTENTOS_VENTANA = 10 * 60 * 1000; // ...cada 10 minutos
const ESPERA_ENTRE_MENSAJES = 1000;      // un mensaje por segundo
const LIMPIEZA_CADA = 60 * 60 * 1000;    // revisar mensajes viejos cada hora

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

    if (url.pathname === "/entrar" && request.method === "POST") {
      const cuerpo = (await request.text()).slice(0, 2000);
      cabeceras.delete("Content-Length");
      const r = await sala.fetch(new Request("https://sala/entrar", { method: "POST", headers: cabeceras, body: cuerpo }));
      return new Response(r.body, { status: r.status, headers: { ...Object.fromEntries(r.headers), ...cors(origen) } });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Se espera WebSocket", { status: 426 });
      return sala.fetch(new Request("https://sala/ws", { headers: cabeceras }));
    }

    return new Response("No encontrado", { status: 404 });
  },
};

async function sha256(texto) {
  const datos = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(texto));
  return [...new Uint8Array(datos)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tokenNuevo() {
  const b = new Uint8Array(32);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export class SalaSocial extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.ultimoEnvio = new Map();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS mensajes (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, texto TEXT NOT NULL, ts INTEGER NOT NULL)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS usuarios (
      nombre TEXT PRIMARY KEY COLLATE NOCASE, token TEXT NOT NULL UNIQUE, clave_hash TEXT NOT NULL,
      visto INTEGER NOT NULL, leido INTEGER NOT NULL DEFAULT 0)`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS intentos (ip TEXT NOT NULL, ts INTEGER NOT NULL)`);
    // Responde "pong" a los "ping" del teléfono sin despertar al servidor.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  horas() { return Math.max(1, Number(this.env.HORAS_MENSAJES) || 24); }
  maxMensajes() { return Math.max(1, Number(this.env.MAX_MENSAJES) || 200); }
  diasSesion() { return Math.max(1, Number(this.env.DIAS_SESION) || 30); }

  limpiar() {
    const ahora = Date.now();
    this.sql.exec("DELETE FROM mensajes WHERE ts < ?", ahora - this.horas() * 3600 * 1000);
    this.sql.exec("DELETE FROM mensajes WHERE id NOT IN (SELECT id FROM mensajes ORDER BY id DESC LIMIT ?)", this.maxMensajes());
    this.sql.exec("DELETE FROM usuarios WHERE visto < ?", ahora - this.diasSesion() * 86400 * 1000);
    this.sql.exec("DELETE FROM intentos WHERE ts < ?", ahora - INTENTOS_VENTANA);
  }

  async programarLimpieza() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + LIMPIEZA_CADA);
  }

  async alarm() {
    this.limpiar();
    const fila = this.sql.exec("SELECT MIN(id) AS m, COUNT(*) AS c FROM mensajes").one();
    // "desde": el mensaje más viejo que queda (null = ya no queda ninguno).
    this.enviarATodos({ t: "purga", desde: fila.c ? fila.m : null });
    if (fila.c > 0 || this.ctx.getWebSockets().length > 0) await this.ctx.storage.setAlarm(Date.now() + LIMPIEZA_CADA);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const ip = request.headers.get("X-Social-IP") || "desconocida";
    if (url.pathname === "/entrar") return this.entrar(request, ip);
    if (url.pathname === "/ws") {
      const par = new WebSocketPair();
      this.ctx.acceptWebSocket(par[1]);
      par[1].serializeAttachment({ nombre: null });
      return new Response(null, { status: 101, webSocket: par[0] });
    }
    return new Response("No encontrado", { status: 404 });
  }

  async entrar(request, ip) {
    let datos;
    try { datos = await request.json(); } catch (e) { datos = null; }
    this.limpiar();
    const ahora = Date.now();
    const fallidos = this.sql.exec("SELECT COUNT(*) AS c, MIN(ts) AS primero FROM intentos WHERE ip = ?", ip).one();
    if (fallidos.c >= INTENTOS_MAX) {
      const espera = Math.ceil((fallidos.primero + INTENTOS_VENTANA - ahora) / 1000);
      return json({ error: "bloqueado", espera: Math.max(1, espera) }, 429);
    }

    if (!datos) return json({ error: "datos" }, 400);
    const nombre = String((datos && datos.nombre) || "").trim();
    const clave = String((datos && datos.clave) || "");

    if (!this.env.CLAVE) return json({ error: "sin_clave" }, 500);
    const a = new TextEncoder().encode(await sha256(clave));
    const b = new TextEncoder().encode(await sha256(this.env.CLAVE));
    if (!crypto.subtle.timingSafeEqual(a, b)) {
      this.sql.exec("INSERT INTO intentos (ip, ts) VALUES (?, ?)", ip, ahora);
      const quedan = INTENTOS_MAX - (fallidos.c + 1);
      if (quedan <= 0) return json({ error: "bloqueado", espera: Math.ceil(INTENTOS_VENTANA / 1000) }, 429);
      return json({ error: "clave", quedan }, 401);
    }

    if (!NOMBRE_VALIDO.test(nombre)) return json({ error: "nombre" }, 400);
    const existe = this.sql.exec("SELECT nombre FROM usuarios WHERE nombre = ?", nombre).toArray();
    if (existe.length) return json({ error: "en_uso" }, 409);

    const token = tokenNuevo();
    this.sql.exec("INSERT INTO usuarios (nombre, token, clave_hash, visto, leido) VALUES (?, ?, ?, ?, ?)",
      nombre, token, await sha256(this.env.CLAVE), ahora, 0);
    this.sql.exec("DELETE FROM intentos WHERE ip = ?", ip);
    return json({ token, nombre });
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

  estado(sin) {
    const enLinea = new Set();
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sin) continue;
      const a = ws.deserializeAttachment();
      if (a && a.nombre) enLinea.add(a.nombre);
    }
    const usuarios = this.sql.exec("SELECT nombre, leido FROM usuarios ORDER BY nombre").toArray()
      .map((u) => ({ n: u.nombre, leido: u.leido, enLinea: enLinea.has(u.nombre) }));
    return { t: "estado", usuarios };
  }

  async webSocketMessage(ws, crudo) {
    if (typeof crudo !== "string" || crudo.length > 4000) return;
    let m;
    try { m = JSON.parse(crudo); } catch (e) { return; }
    if (!m || typeof m !== "object") return;
    const yo = ws.deserializeAttachment() || {};

    if (!yo.nombre) {
      if (m.t !== "auth") return;
      const fila = this.sql.exec("SELECT nombre, clave_hash FROM usuarios WHERE token = ?", String(m.token || "")).toArray()[0];
      const claveActual = this.env.CLAVE ? await sha256(this.env.CLAVE) : "";
      if (!fila || fila.clave_hash !== claveActual) {
        // Token desconocido, vencido o la clave cambió: hay que volver a entrar.
        if (fila) this.sql.exec("DELETE FROM usuarios WHERE nombre = ?", fila.nombre);
        this.enviar(ws, { t: "sesion_invalida" });
        ws.close(4001, "sesion");
        return;
      }
      this.limpiar();
      this.sql.exec("UPDATE usuarios SET visto = ? WHERE nombre = ?", Date.now(), fila.nombre);
      ws.serializeAttachment({ nombre: fila.nombre });
      const mensajes = this.sql.exec("SELECT id, nombre, texto, ts FROM mensajes ORDER BY id").toArray();
      this.enviar(ws, { t: "hola", yo: fila.nombre, mensajes, horas: this.horas() });
      this.enviarATodos(this.estado());
      await this.programarLimpieza();
      return;
    }

    if (m.t === "msg") {
      const ahora = Date.now();
      const antes = this.ultimoEnvio.get(yo.nombre) || 0;
      if (ahora - antes < ESPERA_ENTRE_MENSAJES) { this.enviar(ws, { t: "error", e: "rapido", cid: m.cid }); return; }
      // Quita caracteres de control (deja saltos de línea) y espacios sobrantes.
      let texto = String(m.texto || "").replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, "").replace(/\n{3,}/g, "\n\n").trim();
      if (!texto) return;
      if ([...texto].length > MAX_LARGO) { this.enviar(ws, { t: "error", e: "largo", cid: m.cid }); return; }
      this.ultimoEnvio.set(yo.nombre, ahora);
      const id = this.sql.exec("INSERT INTO mensajes (nombre, texto, ts) VALUES (?, ?, ?) RETURNING id", yo.nombre, texto, ahora).one().id;
      this.sql.exec("UPDATE usuarios SET visto = ?, leido = MAX(leido, ?) WHERE nombre = ?", ahora, id, yo.nombre);
      this.limpiar();
      this.enviarATodos({ t: "msg", m: { id, nombre: yo.nombre, texto, ts: ahora }, cid: m.cid, de: yo.nombre });
      this.enviarATodos({ t: "leido", n: yo.nombre, id });
      await this.programarLimpieza();
      return;
    }

    if (m.t === "escribiendo") {
      this.enviarATodos({ t: "escribiendo", n: yo.nombre }, ws);
      return;
    }

    if (m.t === "leido") {
      const maximo = this.sql.exec("SELECT COALESCE(MAX(id), 0) AS m FROM mensajes").one().m;
      const id = Math.min(Math.floor(Number(m.id) || 0), maximo); // no se puede "leer" un mensaje que aún no existe
      if (id <= 0) return;
      this.sql.exec("UPDATE usuarios SET leido = MAX(leido, ?), visto = ? WHERE nombre = ?", id, Date.now(), yo.nombre);
      const nuevo = this.sql.exec("SELECT leido FROM usuarios WHERE nombre = ?", yo.nombre).toArray()[0];
      if (nuevo) this.enviarATodos({ t: "leido", n: yo.nombre, id: nuevo.leido });
      return;
    }

    if (m.t === "salir") {
      // Borra el nombre: queda libre para otra persona.
      this.sql.exec("DELETE FROM usuarios WHERE nombre = ?", yo.nombre);
      ws.serializeAttachment({ nombre: null });
      ws.close(1000, "salir");
      this.enviarATodos(this.estado(ws));
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
