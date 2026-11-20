// Chat Social de Shukito Studio (solo para invitados).
// Para APAGAR el botón en la página: deja SOCIAL_SERVIDOR vacío así: var SOCIAL_SERVIDOR = '';
(function () {
  var SOCIAL_SERVIDOR = 'https://shukito-social.shukitostudio.workers.dev';

  // Al probar en la computadora (localhost) se usa el servidor de prueba local.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) SOCIAL_SERVIDOR = 'http://127.0.0.1:8787';

  var CLAVE_LOCAL = 'shukito-social';
  var MAX_LARGO = 500;

  var $ = function (id) { return document.getElementById(id); };
  var t = function (clave, datos) {
    var s = (window.shukitoTexto ? window.shukitoTexto(clave) : '') || '';
    if (datos) for (var k in datos) s = s.split('{' + k + '}').join(datos[k]);
    return s;
  };
  var idioma = function () { return window.shukitoIdioma ? window.shukitoIdioma() : 'es'; };

  /* ---------- Privacidad (funciona aunque el chat esté apagado) ---------- */
  var priv = $('privacidad-social');
  function abrirPrivacidad(e) {
    if (e) e.preventDefault();
    priv.hidden = false;
    $('priv-cerrar').focus();
  }
  function cerrarPrivacidad() {
    priv.hidden = true;
    if (location.hash === '#privacidad-social') history.replaceState(null, '', location.pathname + location.search);
  }
  var enlacesPriv = document.querySelectorAll('[data-abrir-privacidad]');
  for (var i = 0; i < enlacesPriv.length; i++) enlacesPriv[i].addEventListener('click', abrirPrivacidad);
  $('priv-cerrar').addEventListener('click', cerrarPrivacidad);
  priv.addEventListener('click', function (e) { if (e.target === priv) cerrarPrivacidad(); });
  if (location.hash === '#privacidad-social') abrirPrivacidad();

  if (!SOCIAL_SERVIDOR) return; // chat apagado: el botón queda escondido

  var URL_WS = SOCIAL_SERVIDOR.replace(/^http/, 'ws') + '/ws';

  /* ---------- Sesión guardada en el teléfono ---------- */
  function leerSesion() {
    try { var s = JSON.parse(localStorage.getItem(CLAVE_LOCAL) || 'null'); return s && s.token ? s : null; } catch (e) { return null; }
  }
  function guardarSesion(s) { try { localStorage.setItem(CLAVE_LOCAL, JSON.stringify(s)); } catch (e) { /* nada */ } }
  function borrarSesion() { try { localStorage.removeItem(CLAVE_LOCAL); } catch (e) { /* nada */ } }

  var raiz = $('social');
  var boton = $('btn-social');
  var formEntrar = $('social-entrar');
  var chat = $('social-chat');
  var lista = $('social-mensajes');
  var caja = $('social-texto');
  var botonEnviar = $('social-enviar');
  var estadoTxt = $('social-estado');
  var avisoEscribe = $('social-escribiendo');
  var contador = $('social-contador');

  boton.hidden = false;

  var sesion = leerSesion();
  var ws = null, reintento = 0, temporizador = null, latido = null;
  var mensajes = [];          // {id, nombre, texto, ts}
  var pendientes = {};        // cid -> nodo de la burbuja
  var usuarios = [];          // {n, leido, enLinea}
  var escribiendo = {};       // nombre -> hora límite
  var horas = 24;
  var abierto = false;
  var ultimoAvisoEscribe = 0;
  var ultimoEnvio = 0;

  /* ---------- Abrir / cerrar ---------- */
  function abrir() {
    if (abierto) return;
    abierto = true;
    raiz.hidden = false;
    document.documentElement.classList.add('social-abierto');
    history.pushState({ social: 1 }, '');
    if (sesion) { mostrarChat(); conectar(); } else { mostrarEntrar(); }
  }
  function cerrar(desdeAtras) {
    if (!abierto) return;
    abierto = false;
    raiz.hidden = true;
    document.documentElement.classList.remove('social-abierto');
    desconectar();
    if (!desdeAtras && history.state && history.state.social) history.back();
    boton.focus();
  }
  boton.addEventListener('click', abrir);
  $('social-cerrar').addEventListener('click', function () { cerrar(false); });
  window.addEventListener('popstate', function () { if (abierto) cerrar(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!priv.hidden) cerrarPrivacidad(); else if (abierto) cerrar(false);
  });

  function mostrarEntrar(error) {
    chat.hidden = true;
    formEntrar.hidden = false;
    $('social-salir').hidden = true;
    estadoTxt.textContent = '';
    $('social-error').textContent = error || '';
    setTimeout(function () { $('social-nombre').focus(); }, 50);
  }
  function mostrarChat() {
    formEntrar.hidden = true;
    chat.hidden = false;
    $('social-salir').hidden = false;
    estadoTxt.textContent = t('socialConectando');
  }

  /* ---------- Entrar con nombre y clave ---------- */
  formEntrar.addEventListener('submit', function (e) {
    e.preventDefault();
    var nombre = $('social-nombre').value.trim();
    var clave = $('social-clave').value;
    var error = $('social-error');
    if (!/^[A-Za-z0-9]{3,16}$/.test(nombre)) { error.textContent = t('socialErrNombre'); $('social-nombre').focus(); return; }
    if (!clave) { $('social-clave').focus(); return; }
    var b = $('social-boton-entrar');
    b.disabled = true;
    b.firstElementChild.textContent = t('socialEntrando');
    error.textContent = '';
    fetch(SOCIAL_SERVIDOR + '/entrar', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nombre: nombre, clave: clave })
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (res.ok && res.d.token) {
        sesion = { token: res.d.token, nombre: res.d.nombre };
        guardarSesion(sesion);
        $('social-clave').value = '';
        mostrarChat();
        conectar();
        return;
      }
      var d = res.d || {};
      if (d.error === 'bloqueado') error.textContent = t('socialErrBloqueado', { m: Math.max(1, Math.ceil((d.espera || 600) / 60)) });
      else if (d.error === 'clave') error.textContent = t('socialErrClave', { n: d.quedan });
      else if (d.error === 'en_uso') error.textContent = t('socialErrEnUso');
      else if (d.error === 'nombre') error.textContent = t('socialErrNombre');
      else error.textContent = t('socialErrRed');
      $('social-clave').value = '';
    }).catch(function () {
      error.textContent = t('socialErrRed');
    }).then(function () {
      b.disabled = false;
      b.firstElementChild.textContent = t('socialEntrar');
    });
  });

  $('social-salir').addEventListener('click', function () {
    if (!window.confirm(t('socialSalirConfirmar'))) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'salir' }));
    terminarSesion('');
  });

  function terminarSesion(error) {
    borrarSesion();
    sesion = null;
    desconectar();
    mensajes = []; usuarios = []; pendientes = {};
    lista.textContent = '';
    $('social-usuarios').textContent = '';
    mostrarEntrar(error);
  }

  /* ---------- Conexión ---------- */
  function conectar() {
    if (!sesion || (ws && ws.readyState <= 1)) return;
    clearTimeout(temporizador);
    estadoTxt.textContent = t('socialConectando');
    botonEnviar.disabled = true;
    try { ws = new WebSocket(URL_WS); } catch (e) { reconectar(); return; }
    ws.onopen = function () {
      ws.send(JSON.stringify({ t: 'auth', token: sesion.token }));
    };
    ws.onmessage = function (ev) {
      var m; try { m = JSON.parse(ev.data); } catch (e) { return; }
      recibir(m);
    };
    ws.onclose = function (ev) {
      clearInterval(latido);
      ws = null;
      if (ev.code === 4001) return; // sesión inválida: ya se mostró el aviso
      if (abierto && sesion) reconectar();
    };
  }
  function reconectar() {
    estadoTxt.textContent = t('socialConectando');
    botonEnviar.disabled = true;
    reintento = Math.min(reintento + 1, 6);
    temporizador = setTimeout(conectar, Math.min(1000 * Math.pow(1.7, reintento), 15000));
  }
  function desconectar() {
    clearTimeout(temporizador);
    clearInterval(latido);
    if (ws) { ws.onclose = null; try { ws.close(1000); } catch (e) { /* nada */ } ws = null; }
  }
  // Al volver a la página en el teléfono, reconectar enseguida.
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && abierto && sesion) { reintento = 0; conectar(); marcarLeido(); }
  });

  /* ---------- Mensajes del servidor ---------- */
  function recibir(m) {
    if (m.t === 'hola') {
      reintento = 0;
      horas = m.horas || 24;
      sesion.nombre = m.yo;
      mensajes = m.mensajes || [];
      pendientes = {};
      pintarTodo();
      botonEnviar.disabled = !caja.value.trim();
      clearInterval(latido);
      latido = setInterval(function () { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);
      marcarLeido();
    } else if (m.t === 'sesion_invalida') {
      terminarSesion(t('socialErrSesion'));
    } else if (m.t === 'estado') {
      usuarios = m.usuarios || [];
      pintarUsuarios();
      actualizarMarcas();
    } else if (m.t === 'msg') {
      var mm = m.m;
      if (mensajes.some(function (x) { return x.id === mm.id; })) return;
      mensajes.push(mm);
      delete escribiendo[mm.nombre];
      pintarEscribiendo();
      var nodo = m.cid && pendientes[m.cid];
      if (nodo) { delete pendientes[m.cid]; nodo.remove(); }
      agregarBurbuja(mm, true);
      if (mm.nombre !== sesion.nombre) marcarLeido();
    } else if (m.t === 'leido') {
      for (var i = 0; i < usuarios.length; i++) if (usuarios[i].n === m.n) usuarios[i].leido = m.id;
      actualizarMarcas();
    } else if (m.t === 'escribiendo') {
      escribiendo[m.n] = Date.now() + 3500;
      pintarEscribiendo();
      setTimeout(pintarEscribiendo, 3600);
    } else if (m.t === 'purga') {
      mensajes = m.desde == null ? [] : mensajes.filter(function (x) { return x.id >= m.desde; });
      pintarTodo();
    } else if (m.t === 'error') {
      var p = m.cid && pendientes[m.cid];
      if (p) { delete pendientes[m.cid]; p.remove(); }
      mostrarAviso(m.e === 'rapido' ? t('socialErrRapido') : m.e === 'largo' ? t('socialErrLargo') : '');
    }
  }

  function mostrarAviso(texto) {
    if (!texto) return;
    avisoEscribe.textContent = texto;
    avisoEscribe.classList.add('es-aviso');
    setTimeout(function () { avisoEscribe.classList.remove('es-aviso'); pintarEscribiendo(); }, 2500);
  }

  /* ---------- Dibujar (siempre con textContent: el texto nunca se interpreta como código) ---------- */
  function hora(ts) {
    try { return new Date(ts).toLocaleTimeString(idioma() === 'en' ? 'en-US' : 'es', { hour: '2-digit', minute: '2-digit' }); }
    catch (e) { var d = new Date(ts); return d.getHours() + ':' + ('0' + d.getMinutes()).slice(-2); }
  }

  function pintarTodo() {
    lista.textContent = '';
    if (!mensajes.length) {
      var v = document.createElement('p');
      v.className = 'social-vacio';
      v.textContent = t('socialVacio', { h: horas });
      lista.appendChild(v);
    }
    for (var i = 0; i < mensajes.length; i++) agregarBurbuja(mensajes[i], false);
    for (var c in pendientes) lista.appendChild(pendientes[c]);
    bajar(true);
  }

  function crearBurbuja(nombre, texto, ts, mio) {
    var fila = document.createElement('div');
    fila.className = 'social-fila ' + (mio ? 'mia' : 'otra');
    var b = document.createElement('div');
    b.className = 'social-burbuja';
    if (!mio) {
      var autor = document.createElement('span');
      autor.className = 'social-autor';
      autor.textContent = nombre;
      b.appendChild(autor);
    }
    var cuerpo = document.createElement('span');
    cuerpo.className = 'social-cuerpo';
    cuerpo.textContent = texto;
    b.appendChild(cuerpo);
    var pie = document.createElement('span');
    pie.className = 'social-pie';
    var h = document.createElement('time');
    h.textContent = hora(ts);
    pie.appendChild(h);
    if (mio) {
      var marca = document.createElement('span');
      marca.className = 'social-marca';
      pie.appendChild(marca);
    }
    b.appendChild(pie);
    fila.appendChild(b);
    return fila;
  }

  function agregarBurbuja(m, animar) {
    var vacio = lista.querySelector('.social-vacio');
    if (vacio) vacio.remove();
    var mio = sesion && m.nombre === sesion.nombre;
    var cerca = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 120;
    var fila = crearBurbuja(m.nombre, m.texto, m.ts, mio);
    fila.setAttribute('data-id', m.id);
    var primerPendiente = lista.querySelector('.social-fila.pendiente');
    lista.insertBefore(fila, primerPendiente);
    if (mio) ponerMarca(fila, m.id);
    if (animar && (mio || cerca)) bajar(false);
  }

  function ponerMarca(fila, id) {
    var marca = fila.querySelector('.social-marca');
    if (!marca) return;
    var otros = usuarios.filter(function (u) { return u.n !== sesion.nombre; });
    var todos = otros.length > 0 && otros.every(function (u) { return u.leido >= id; });
    marca.textContent = todos ? '✓✓' : '✓';
    marca.classList.toggle('leido', todos);
    marca.setAttribute('aria-label', todos ? t('socialLeido') : t('socialEnviado'));
    marca.title = marca.getAttribute('aria-label');
  }

  function actualizarMarcas() {
    var filas = lista.querySelectorAll('.social-fila.mia[data-id]');
    for (var i = 0; i < filas.length; i++) ponerMarca(filas[i], Number(filas[i].getAttribute('data-id')));
  }

  function pintarUsuarios() {
    var ul = $('social-usuarios');
    ul.textContent = '';
    var orden = usuarios.slice().sort(function (a, b) { return (b.enLinea - a.enLinea) || a.n.localeCompare(b.n); });
    var cuantos = 0;
    for (var i = 0; i < orden.length; i++) {
      var u = orden[i];
      if (u.enLinea) cuantos++;
      var li = document.createElement('li');
      li.className = u.enLinea ? 'en-linea' : '';
      var punto = document.createElement('span');
      punto.className = 'social-punto';
      punto.setAttribute('aria-hidden', 'true');
      li.appendChild(punto);
      li.appendChild(document.createTextNode(u.n + (u.n === sesion.nombre ? ' (' + t('socialTu') + ')' : '')));
      ul.appendChild(li);
    }
    estadoTxt.textContent = t('socialEnLineaCuenta', { n: cuantos });
  }

  function pintarEscribiendo() {
    if (avisoEscribe.classList.contains('es-aviso')) return;
    var ahora = Date.now();
    var nombres = [];
    for (var n in escribiendo) { if (escribiendo[n] > ahora) nombres.push(n); else delete escribiendo[n]; }
    if (!nombres.length) { avisoEscribe.textContent = ''; return; }
    var juntos = nombres.length === 1 ? nombres[0] : nombres.slice(0, -1).join(', ') + t('socialY') + nombres[nombres.length - 1];
    avisoEscribe.textContent = t(nombres.length === 1 ? 'socialEscribiendo1' : 'socialEscribiendoVarios', { a: juntos });
  }

  function bajar(inmediato) {
    lista.scrollTo({ top: lista.scrollHeight, behavior: inmediato ? 'auto' : 'smooth' });
  }

  function marcarLeido() {
    if (!abierto || document.visibilityState !== 'visible' || !ws || ws.readyState !== 1 || !mensajes.length) return;
    ws.send(JSON.stringify({ t: 'leido', id: mensajes[mensajes.length - 1].id }));
  }

  /* ---------- Escribir y enviar ---------- */
  function largo(s) { return Array.from(s).length; }
  function ajustarCaja() {
    caja.style.height = 'auto';
    caja.style.height = Math.min(caja.scrollHeight, 130) + 'px';
    var n = largo(caja.value);
    contador.textContent = n > MAX_LARGO - 80 ? (MAX_LARGO - n) + '' : '';
    contador.classList.toggle('excedido', n > MAX_LARGO);
    botonEnviar.disabled = !caja.value.trim() || n > MAX_LARGO || !ws || ws.readyState !== 1;
  }
  caja.addEventListener('input', function () {
    ajustarCaja();
    var ahora = Date.now();
    if (caja.value && ahora - ultimoAvisoEscribe > 2000 && ws && ws.readyState === 1) {
      ultimoAvisoEscribe = ahora;
      ws.send(JSON.stringify({ t: 'escribiendo' }));
    }
  });
  // En la computadora, Enter envía y Shift+Enter hace salto de línea. En el teléfono, Enter es salto de línea.
  caja.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && window.matchMedia('(hover: hover) and (pointer: fine)').matches) {
      e.preventDefault();
      enviar();
    }
  });
  $('social-form').addEventListener('submit', function (e) { e.preventDefault(); enviar(); });

  function enviar() {
    var texto = caja.value.trim();
    if (!texto || !ws || ws.readyState !== 1) return;
    if (largo(texto) > MAX_LARGO) { mostrarAviso(t('socialErrLargo')); return; }
    var ahora = Date.now();
    if (ahora - ultimoEnvio < 1000) { mostrarAviso(t('socialErrRapido')); return; }
    ultimoEnvio = ahora;
    var cid = ahora.toString(36) + Math.random().toString(36).slice(2, 7);
    var fila = crearBurbuja(sesion.nombre, texto, ahora, true);
    fila.classList.add('pendiente');
    var marca = fila.querySelector('.social-marca');
    marca.textContent = '🕓';
    marca.setAttribute('aria-label', t('socialPendiente'));
    var vacio = lista.querySelector('.social-vacio');
    if (vacio) vacio.remove();
    lista.appendChild(fila);
    pendientes[cid] = fila;
    ws.send(JSON.stringify({ t: 'msg', texto: texto, cid: cid }));
    caja.value = '';
    ajustarCaja();
    caja.focus();
    bajar(false);
  }

  // Cambio de idioma: rehacer los textos dinámicos.
  document.addEventListener('shukito-idioma', function () {
    if (!abierto) return;
    if (sesion && !chat.hidden && ws && ws.readyState === 1) { pintarTodo(); pintarUsuarios(); pintarEscribiendo(); }
    else if (!chat.hidden) estadoTxt.textContent = t('socialConectando');
  });

  // Abrir directo con la dirección .../#social
  if (location.hash === '#social') { history.replaceState(null, '', location.pathname + location.search); abrir(); }
})();
