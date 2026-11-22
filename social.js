// Chat Social de Shukito Studio (solo para invitados): chat general y chats privados.
// Para APAGAR el botón en la página: deja SOCIAL_SERVIDOR vacío así: var SOCIAL_SERVIDOR = '';
(function () {
  var SOCIAL_SERVIDOR = 'https://shukito-social.shukitostudio.workers.dev';

  // Al probar en la computadora (localhost) se usa el servidor de prueba local.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) SOCIAL_SERVIDOR = 'http://127.0.0.1:8787';

  var CLAVE_LOCAL = 'shukito-social';
  var CLAVE_NOMBRE = 'shukito-social-nombre'; // último nombre usado (para la pestaña "Ya tengo usuario")
  var MAX_LARGO = 500;
  var MAX_ESTADO = 60;
  var GENERAL = 'general';

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

  if (!SOCIAL_SERVIDOR || !window.socialAvatares) return; // chat apagado: el botón queda escondido

  var URL_WS = SOCIAL_SERVIDOR.replace(/^http/, 'ws') + '/ws';
  var pintarAvatar = window.socialAvatares.pintar;

  /* ---------- Datos guardados en el teléfono ---------- */
  function leer(clave) { try { return localStorage.getItem(clave); } catch (e) { return null; } }
  function guardar(clave, valor) { try { localStorage.setItem(clave, valor); } catch (e) { /* nada */ } }
  function quitar(clave) { try { localStorage.removeItem(clave); } catch (e) { /* nada */ } }
  function leerSesion() {
    try { var s = JSON.parse(leer(CLAVE_LOCAL) || 'null'); return s && s.token ? s : null; } catch (e) { return null; }
  }

  var raiz = $('social');
  var boton = $('btn-social');
  var formEntrar = $('social-entrar');
  var barraPerfil = $('social-perfil');
  var chat = $('social-chat');
  var lista = $('social-mensajes');
  var caja = $('social-texto');
  var botonEnviar = $('social-enviar');
  var estadoTxt = $('social-estado');
  var avisoEscribe = $('social-escribiendo');
  var contador = $('social-contador');
  var menu = $('social-menu');
  var botonMenu = $('social-menu-boton');
  var ventanaAvatar = $('social-ventana-avatar');
  var botonChats = $('social-boton-chats');
  var botonContactos = $('social-boton-contactos');
  var panelChats = $('social-panel-chats');
  var panelContactos = $('social-panel-contactos');
  var panelAdmin = $('social-panel-admin');
  var menuChat = $('social-menu-chat');
  var botonSala = $('social-sala-boton');
  var ventanaAdmin = $('social-ventana-admin');
  var paneles = { chats: panelChats, contactos: panelContactos, admin: panelAdmin };
  var botonesPanel = { chats: botonChats, contactos: botonContactos };

  boton.hidden = false;

  var sesion = leerSesion();
  var ws = null, reintento = 0, temporizador = null, latido = null;
  var chats = {};             // sala -> {mensajes: [{id, sala, nombre, texto, ts}], escribiendo: {nombre: hora límite}}
  var lecturas = {};          // sala -> {nombre en minúsculas: último id leído}
  var pendientes = {};        // cid -> {fila, sala}
  var usuarios = [];          // {n, enLinea}
  var perfiles = {};          // nombre en minúsculas -> {n, avatar, estado}
  var salaActual = GENERAL;
  var panel = null;           // null, 'chats' o 'contactos'
  var horas = 24;
  var abierto = false;
  var ultimoAvisoEscribe = 0;
  var ultimoEnvio = 0;
  var modo = 'nuevo';         // 'nuevo' (crear usuario) o 'entrar' (ya tengo usuario)
  var avatarElegido = 'e:0';  // en el registro
  var avatarNuevo = null;     // en la ventana de cambiar avatar
  var esAdmin = false;        // esta sesión entró con la clave de administrador
  var datosAdmin = null;      // {chats: [{sala, miembros, cuantos, ultimo}], clavePropia}
  var silencios = { sala: {}, persona: {} }; // lo que silencié (se guarda en el servidor)
  var CLAVE_AVISOS = 'shukito-social-avisos';
  var avisos = (function () {     // ajustes de este teléfono: sonido y notificaciones del navegador
    try { var a = JSON.parse(leer(CLAVE_AVISOS) || 'null'); if (a) return { sonido: a.sonido !== false, notif: !!a.notif }; } catch (e) { /* nada */ }
    return { sonido: true, notif: false };
  })();
  var ultimoSonido = 0;
  var audio = null;

  /* ---------- Salas ---------- */
  function minus(n) { return String(n || '').toLowerCase(); }
  function yoMinus() { return sesion ? minus(sesion.nombre) : ''; }
  function salaCon(nombre) { return 'p:' + [yoMinus(), minus(nombre)].sort().join(':'); }
  function otroDe(sala) {
    var m = /^p:([a-z0-9]+):([a-z0-9]+)$/.exec(sala);
    if (!m) return null;
    return m[1] === yoMinus() ? m[2] : m[1];
  }
  function perfilDe(nombreMinus) { return perfiles[nombreMinus] || null; }
  function enLinea(nombreMinus) {
    for (var i = 0; i < usuarios.length; i++) if (minus(usuarios[i].n) === nombreMinus) return !!usuarios[i].enLinea;
    return false;
  }
  function nombreSala(sala) {
    if (sala === GENERAL) return t('socialGeneral');
    var p = perfilDe(otroDe(sala));
    return p ? p.n : otroDe(sala);
  }
  function datosSala(sala) {
    if (!chats[sala]) chats[sala] = { mensajes: [], escribiendo: {} };
    return chats[sala];
  }
  function leidoPor(sala, nombreMinus) { return (lecturas[sala] && lecturas[sala][nombreMinus]) || 0; }
  function ponerLectura(sala, nombre, id) {
    if (!lecturas[sala]) lecturas[sala] = {};
    var n = minus(nombre);
    lecturas[sala][n] = Math.max(lecturas[sala][n] || 0, id);
  }
  function noLeidos(sala) {
    var c = chats[sala];
    if (!c) return 0;
    var desde = leidoPor(sala, yoMinus()), cuenta = 0;
    for (var i = 0; i < c.mensajes.length; i++) {
      if (c.mensajes[i].id > desde && minus(c.mensajes[i].nombre) !== yoMinus()) cuenta++;
    }
    return cuenta;
  }
  function pintarAvatarSala(el, sala) {
    if (sala === GENERAL) {
      el.textContent = '';
      el.style.background = '';
      el.classList.add('es-foto', 'es-grupo');
      var img = document.createElement('img');
      img.alt = '';
      img.src = 'assets/logo.webp';
      el.appendChild(img);
      return;
    }
    el.classList.remove('es-grupo');
    var otro = otroDe(sala), p = perfilDe(otro);
    pintarAvatar(el, p && p.avatar, p ? p.n : otro);
  }

  /* ---------- Avatares del registro y del perfil ---------- */
  var selectorRegistro = window.socialAvatares.crearSelector($('social-avatares'), t,
    function (a) { avatarElegido = a; }, function (txt) { $('social-error').textContent = txt; });
  selectorRegistro.elegir(avatarElegido);
  var selectorCambiar = window.socialAvatares.crearSelector($('social-avatares-cambiar'), t,
    function (a) { avatarNuevo = a; }, function (txt) { $('social-ventana-error').textContent = txt; });

  /* ---------- Abrir / cerrar ---------- */
  function abrir() {
    if (abierto) return;
    abierto = true;
    raiz.hidden = false;
    document.documentElement.classList.add('social-abierto');
    history.pushState({ social: 1 }, '');
    if (sesion) { mostrarChat(); conectar(); marcarLeido(); actualizarAsterisco(); } else { mostrarEntrar(); }
  }
  function cerrar(desdeAtras) {
    if (!abierto) return;
    abierto = false;
    cerrarMenu(false);
    cerrarVentanaAvatar();
    cerrarVentanaAdmin();
    cancelarEstado();
    cerrarPanel(false);
    cerrarMenuChat(false);
    raiz.hidden = true;
    document.documentElement.classList.remove('social-abierto');
    // La conexión sigue abierta: así llegan los avisos de mensajes nuevos mientras la página está abierta.
    actualizarAsterisco();
    if (!desdeAtras && history.state && history.state.social) history.back();
    boton.focus();
  }
  boton.addEventListener('click', abrir);
  $('social-cerrar').addEventListener('click', function () { cerrar(false); });
  window.addEventListener('popstate', function () { if (abierto) cerrar(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!priv.hidden) cerrarPrivacidad();
    else if (!ventanaAvatar.hidden) cerrarVentanaAvatar();
    else if (!ventanaAdmin.hidden) cerrarVentanaAdmin();
    else if (!$('social-visor').hidden) cerrarVisor();
    else if (!$('social-ventana-medio').hidden) cerrarVentanaMedio();
    else if (!$('social-grabando').hidden) cancelarGrabacion();
    else if (!menu.hidden) cerrarMenu(true);
    else if (!menuChat.hidden) cerrarMenuChat(true);
    else if (!$('social-estado-form').hidden) cancelarEstado();
    else if (panel) cerrarPanel(true);
    else if (abierto) cerrar(false);
  });

  function mostrarEntrar(error) {
    chat.hidden = true;
    barraPerfil.hidden = true;
    formEntrar.hidden = false;
    estadoTxt.textContent = '';
    var ultimo = leer(CLAVE_NOMBRE);
    if (ultimo && !$('social-nombre').value) $('social-nombre').value = ultimo;
    ponerModo(ultimo ? 'entrar' : modo);
    $('social-error').textContent = error || '';
    setTimeout(function () { (ultimo ? $('social-pin') : $('social-nombre')).focus(); }, 50);
  }
  function mostrarChat() {
    formEntrar.hidden = true;
    chat.hidden = false;
    barraPerfil.hidden = false;
    pintarPerfil();
    pintarCabeceraSala();
    // Si ya estaba conectado (con el chat cerrado), la pantalla ya tiene todo: solo hay que dibujarlo.
    if (ws && ws.readyState === 1) {
      estadoTxt.textContent = t('socialEnLineaCuenta', { n: usuarios.filter(function (u) { return u.enLinea; }).length });
      pintarTodo();
    } else {
      estadoTxt.textContent = t('socialConectando');
    }
    ajustarCaja();
  }

  /* ---------- Crear usuario o entrar ---------- */
  function ponerModo(nuevo) {
    modo = nuevo;
    $('social-modo-nuevo').setAttribute('aria-selected', modo === 'nuevo' ? 'true' : 'false');
    $('social-modo-entrar').setAttribute('aria-selected', modo === 'entrar' ? 'true' : 'false');
    $('social-elegir').hidden = modo !== 'nuevo';
    $('social-pin-nota').hidden = modo !== 'nuevo';
    var etiqueta = $('social-boton-entrar').firstElementChild;
    etiqueta.setAttribute('data-i', modo === 'nuevo' ? 'socialCrear' : 'socialEntrar');
    etiqueta.textContent = t(modo === 'nuevo' ? 'socialCrear' : 'socialEntrar');
    $('social-error').textContent = '';
  }
  $('social-modo-nuevo').addEventListener('click', function () { ponerModo('nuevo'); $('social-nombre').focus(); });
  $('social-modo-entrar').addEventListener('click', function () { ponerModo('entrar'); $('social-nombre').focus(); });
  $('social-pin').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });

  formEntrar.addEventListener('submit', function (e) {
    e.preventDefault();
    var nombre = $('social-nombre').value.trim();
    var pin = $('social-pin').value;
    var clave = $('social-clave').value;
    var error = $('social-error');
    if (!/^[A-Za-z0-9]{3,16}$/.test(nombre)) { error.textContent = t('socialErrNombre'); $('social-nombre').focus(); return; }
    if (!/^[0-9]{4,6}$/.test(pin)) { error.textContent = t('socialErrPin'); $('social-pin').focus(); return; }
    if (!clave) { error.textContent = t('socialErrFaltaClave'); $('social-clave').focus(); return; }
    var b = $('social-boton-entrar');
    var etiqueta = b.firstElementChild;
    b.disabled = true;
    etiqueta.textContent = t('socialEntrando');
    error.textContent = '';
    var datos = { nombre: nombre, pin: pin, clave: clave };
    if (modo === 'nuevo') datos.avatar = avatarElegido;
    fetch(SOCIAL_SERVIDOR + (modo === 'nuevo' ? '/registrar' : '/entrar'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(datos)
    }).then(function (r) {
      return r.json().then(function (d) { return { ok: r.ok, d: d }; });
    }).then(function (res) {
      if (res.ok && res.d.token) {
        sesion = { token: res.d.token, nombre: res.d.nombre };
        guardar(CLAVE_LOCAL, JSON.stringify(sesion));
        guardar(CLAVE_NOMBRE, res.d.nombre);
        $('social-clave').value = '';
        $('social-pin').value = '';
        salaActual = GENERAL;
        mostrarChat();
        conectar();
        return;
      }
      var d = res.d || {};
      var minutos = Math.max(1, Math.ceil((d.espera || 600) / 60));
      if (d.error === 'bloqueado') error.textContent = t('socialErrBloqueado', { m: minutos });
      else if (d.error === 'cuenta_bloqueada') error.textContent = t('socialErrCuentaBloqueada', { m: minutos });
      else if (d.error === 'clave') error.textContent = t('socialErrClave', { n: d.quedan });
      else if (d.error === 'credenciales') error.textContent = t('socialErrCredenciales', { n: d.quedan });
      else if (d.error === 'en_uso') error.textContent = t('socialErrEnUso');
      else if (d.error === 'nombre') error.textContent = t('socialErrNombre');
      else if (d.error === 'pin') error.textContent = t('socialErrPin');
      else if (d.error === 'avatar') error.textContent = t('socialErrAvatar');
      else error.textContent = t('socialErrRed');
      $('social-clave').value = '';
      if (d.error === 'credenciales') $('social-pin').value = '';
    }).catch(function () {
      error.textContent = t('socialErrRed');
    }).then(function () {
      b.disabled = false;
      etiqueta.textContent = t(modo === 'nuevo' ? 'socialCrear' : 'socialEntrar');
    });
  });

  function terminarSesion(error) {
    quitar(CLAVE_LOCAL);
    sesion = null;
    desconectar();
    cerrarMenu(false);
    cerrarVentanaAvatar();
    cerrarVentanaAdmin();
    cerrarVentanaMedio();
    cancelarGrabacion();
    cerrarVisor();
    soltarArchivos();
    cancelarEstado();
    cerrarPanel(false);
    chats = {}; lecturas = {}; usuarios = []; pendientes = {}; perfiles = {};
    esAdmin = false; datosAdmin = null;
    silencios = { sala: {}, persona: {} };
    cerrarMenuChat(false);
    pintarAdmin();
    salaActual = GENERAL;
    lista.textContent = '';
    actualizarAsterisco();
    if (abierto) mostrarEntrar(error);
  }

  /* ---------- Barra de perfil ---------- */
  function miPerfil() {
    return (sesion && perfiles[yoMinus()]) || { n: sesion ? sesion.nombre : '', avatar: '', estado: '' };
  }
  function pintarPerfil() {
    if (!sesion) return;
    var p = miPerfil();
    pintarAvatar($('social-mi-avatar-img'), p.avatar, p.n);
    $('social-mi-nombre').textContent = p.n;
    var e = $('social-mi-estado');
    e.textContent = p.estado || t('socialSinEstado');
    e.classList.toggle('vacio', !p.estado);
  }

  // Estado: se toca el texto y se escribe ahí mismo.
  var formEstado = $('social-estado-form');
  var cajaEstado = $('social-estado-caja');
  function editarEstado() {
    if (!ws || ws.readyState !== 1) return;
    cerrarMenu(false);
    cajaEstado.value = miPerfil().estado || '';
    $('social-mi-estado').hidden = true;
    formEstado.hidden = false;
    cajaEstado.focus();
    cajaEstado.select();
  }
  function cancelarEstado() {
    if (formEstado.hidden) return;
    formEstado.hidden = true;
    $('social-mi-estado').hidden = false;
  }
  function guardarEstado() {
    if (formEstado.hidden) return;
    var nuevo = cajaEstado.value.replace(/\s+/g, ' ').trim();
    if (Array.from(nuevo).length > MAX_ESTADO) nuevo = Array.from(nuevo).slice(0, MAX_ESTADO).join('');
    cancelarEstado();
    if (nuevo === (miPerfil().estado || '')) return;
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'perfil', estado: nuevo }));
      // Se muestra enseguida; el servidor lo confirma con "perfil".
      var p = miPerfil();
      perfiles[yoMinus()] = { n: p.n, avatar: p.avatar, estado: nuevo };
      pintarPerfil();
    }
  }
  $('social-mi-estado').addEventListener('click', editarEstado);
  $('social-op-estado').addEventListener('click', editarEstado);
  formEstado.addEventListener('submit', function (e) { e.preventDefault(); guardarEstado(); $('social-mi-estado').focus(); });
  cajaEstado.addEventListener('blur', guardarEstado);

  // Menú de tres puntos
  function abrirMenu() {
    menu.hidden = false;
    botonMenu.setAttribute('aria-expanded', 'true');
    menu.querySelector('button').focus();
  }
  function cerrarMenu(devolverFoco) {
    if (menu.hidden) return;
    menu.hidden = true;
    botonMenu.setAttribute('aria-expanded', 'false');
    if (devolverFoco) botonMenu.focus();
  }
  botonMenu.addEventListener('click', function () { if (menu.hidden) abrirMenu(); else cerrarMenu(true); });
  document.addEventListener('click', function (e) {
    if (!menu.hidden && !menu.contains(e.target) && !botonMenu.contains(e.target)) cerrarMenu(false);
  });
  menu.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menu.querySelectorAll('button'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') cerrarMenu(false);
  });

  // Cambiar foto o avatar
  function abrirVentanaAvatar() {
    cerrarMenu(false);
    if (!ws || ws.readyState !== 1) return;
    avatarNuevo = null;
    selectorCambiar.elegir(miPerfil().avatar);
    $('social-ventana-error').textContent = '';
    ventanaAvatar.hidden = false;
    var marcado = ventanaAvatar.querySelector('[aria-checked="true"]');
    (marcado || $('social-avatar-guardar')).focus();
  }
  function cerrarVentanaAvatar() {
    if (ventanaAvatar.hidden) return;
    ventanaAvatar.hidden = true;
    if (abierto && !barraPerfil.hidden) $('social-mi-avatar').focus();
  }
  $('social-mi-avatar').addEventListener('click', abrirVentanaAvatar);
  $('social-op-avatar').addEventListener('click', abrirVentanaAvatar);
  $('social-avatar-cancelar').addEventListener('click', cerrarVentanaAvatar);
  ventanaAvatar.addEventListener('click', function (e) { if (e.target === ventanaAvatar) cerrarVentanaAvatar(); });
  $('social-avatar-guardar').addEventListener('click', function () {
    if (avatarNuevo && avatarNuevo !== miPerfil().avatar && ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ t: 'perfil', avatar: avatarNuevo }));
      var p = miPerfil();
      perfiles[yoMinus()] = { n: p.n, avatar: avatarNuevo, estado: p.estado };
      pintarPerfil();
      refrescarAvatares(yoMinus());
    }
    cerrarVentanaAvatar();
  });

  $('social-op-salir').addEventListener('click', function () {
    cerrarMenu(false);
    if (!window.confirm(t('socialSalirConfirmar'))) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'salir' }));
    terminarSesion('');
  });
  $('social-op-borrar').addEventListener('click', function () {
    cerrarMenu(false);
    if (!window.confirm(t('socialBorrarConfirmar'))) return;
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    ws.send(JSON.stringify({ t: 'borrar_cuenta' }));
    quitar(CLAVE_NOMBRE);
    $('social-nombre').value = '';
    modo = 'nuevo';
    terminarSesion(t('socialCuentaBorrada'));
  });

  /* ---------- Chats y contactos ---------- */
  function abrirPanel(cual) {
    cerrarMenu(false);
    cancelarEstado();
    panel = cual;
    for (var p in paneles) paneles[p].hidden = p !== cual;
    for (var b in botonesPanel) {
      botonesPanel[b].setAttribute('aria-expanded', b === cual ? 'true' : 'false');
      botonesPanel[b].classList.toggle('activo', b === cual);
    }
    refrescarListas();
    if (cual === 'admin') {
      $('social-admin-aviso').textContent = '';
      if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_datos' }));
      $('social-admin-cerrar').focus();
      return;
    }
    var primero = paneles[cual].querySelector('button');
    if (primero) primero.focus();
  }
  function cerrarPanel(devolverFoco) {
    if (!panel) return;
    var antes = panel;
    panel = null;
    for (var p in paneles) paneles[p].hidden = true;
    for (var b in botonesPanel) {
      botonesPanel[b].setAttribute('aria-expanded', 'false');
      botonesPanel[b].classList.remove('activo');
    }
    if (devolverFoco) (botonesPanel[antes] || botonMenu).focus();
    marcarLeido();
  }
  botonChats.addEventListener('click', function () { if (panel === 'chats') cerrarPanel(true); else abrirPanel('chats'); });
  botonContactos.addEventListener('click', function () { if (panel === 'contactos') cerrarPanel(true); else abrirPanel('contactos'); });

  function abrirSala(sala) {
    datosSala(sala);
    var cambio = sala !== salaActual;
    salaActual = sala;
    cerrarPanel(false);
    pintarCabeceraSala();
    if (cambio) {
      caja.value = '';
      ajustarCaja();
      pintarTodo();
    }
    pintarEscribiendo();
    marcarLeido();
    actualizarAsterisco();
    caja.focus();
  }

  function pintarCabeceraSala() {
    if (!sesion) return;
    pintarAvatarSala($('social-sala-avatar'), salaActual);
    $('social-sala-nombre').textContent = nombreSala(salaActual);
    var callado = salaSilenciada(salaActual);
    $('social-sala-silencio').hidden = !callado;
    botonSala.setAttribute('aria-label', t('socialOpcionesChat', { n: nombreSala(salaActual) }) + (callado ? ' (' + t('socialSilenciado') + ')' : ''));
    var detalle = $('social-sala-detalle');
    detalle.classList.remove('en-linea');
    if (salaActual === GENERAL) {
      var total = Object.keys(perfiles).length;
      detalle.textContent = total === 1 ? t('socialMiembros1') : t('socialMiembros', { n: total });
    } else {
      var otro = otroDe(salaActual), p = perfilDe(otro), conectado = enLinea(otro);
      detalle.textContent = conectado ? t('socialEnLineaAhora') : (p && p.estado) || t('socialDesconectado');
      detalle.classList.toggle('en-linea', conectado);
    }
  }

  // Un chat se está "viendo" si el chat Social está abierto, sin panel encima, en esa sala y con la página visible.
  function salaVista(sala) {
    return abierto && !panel && document.visibilityState === 'visible' && sala === salaActual;
  }
  function totalNoLeidos() {
    var n = 0;
    for (var s in chats) if (!salaVista(s)) n += noLeidos(s);
    return n;
  }
  // Asterisco rojo en el botón Chats y en el botón Social de la portada; número en el título de la pestaña.
  function actualizarAsterisco() {
    var total = sesion ? totalNoLeidos() : 0;
    var hay = total > 0;
    $('social-asterisco-chats').hidden = !hay;
    $('social-asterisco-portada').hidden = !hay;
    botonChats.setAttribute('aria-label', t('socialChats') + (hay ? ' — ' + t('socialHayNoLeidos') : ''));
    boton.setAttribute('aria-label', t('socialBoton') + (hay ? ' — ' + t('socialHayNoLeidos') : ''));
    var base = t('metaTitulo');
    if (base) document.title = (hay ? '(' + total + ') ' : '') + base;
  }

  function ultimo(sala) {
    var c = chats[sala];
    return c && c.mensajes.length ? c.mensajes[c.mensajes.length - 1] : null;
  }

  function filaLista(avatarSala, avatarNombre, titulo, linea2, extra) {
    var li = document.createElement('li');
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'social-item';
    var av = document.createElement('span');
    av.className = 'social-avatar';
    av.setAttribute('aria-hidden', 'true');
    if (avatarSala) pintarAvatarSala(av, avatarSala);
    else { var p = perfilDe(avatarNombre); pintarAvatar(av, p && p.avatar, p ? p.n : avatarNombre); }
    var cajaAv = document.createElement('span');
    cajaAv.className = 'social-item-avatar';
    cajaAv.appendChild(av);
    if (extra && extra.punto !== undefined) {
      var punto = document.createElement('span');
      punto.className = 'social-punto' + (extra.punto ? ' si' : '');
      cajaAv.appendChild(punto);
    }
    b.appendChild(cajaAv);
    var textos = document.createElement('span');
    textos.className = 'social-item-textos';
    var arriba = document.createElement('span');
    arriba.className = 'social-item-arriba';
    var nom = document.createElement('strong');
    nom.textContent = titulo;
    arriba.appendChild(nom);
    if (extra && extra.silencio) {
      var sil = document.createElement('span');
      sil.className = 'social-silencio';
      sil.setAttribute('aria-hidden', 'true');
      sil.textContent = '🔕';
      arriba.appendChild(sil);
    }
    if (extra && extra.hora) {
      var h = document.createElement('time');
      h.textContent = extra.hora;
      arriba.appendChild(h);
    }
    textos.appendChild(arriba);
    var abajo = document.createElement('span');
    abajo.className = 'social-item-abajo';
    abajo.textContent = linea2;
    textos.appendChild(abajo);
    b.appendChild(textos);
    if (extra && extra.asterisco) {
      var a = document.createElement('span');
      a.className = 'social-asterisco';
      a.setAttribute('aria-hidden', 'true');
      a.textContent = '*';
      b.appendChild(a);
    }
    if (extra && extra.etiqueta) b.setAttribute('aria-label', extra.etiqueta);
    if (extra && extra.actual) b.setAttribute('aria-current', 'true');
    li.appendChild(b);
    return { li: li, boton: b };
  }

  function pintarListaChats() {
    var ul = $('social-lista-chats');
    ul.textContent = '';
    datosSala(GENERAL);
    var salas = Object.keys(chats).filter(function (s) {
      return s === GENERAL || s === salaActual || chats[s].mensajes.length > 0;
    });
    salas.sort(function (a, b) {
      var ua = ultimo(a), ub = ultimo(b);
      return ((ub ? ub.ts : 0) - (ua ? ua.ts : 0)) || (a === GENERAL ? -1 : b === GENERAL ? 1 : 0);
    });
    salas.forEach(function (sala) {
      var u = ultimo(sala), linea = t('socialSinMensajes');
      if (u) {
        var deMi = minus(u.nombre) === yoMinus();
        linea = deMi ? t('socialTuPrefijo') + resumen(u) : sala === GENERAL ? u.nombre + ': ' + resumen(u) : resumen(u);
      }
      var cuantos = noLeidos(sala);
      var titulo = nombreSala(sala);
      var f = filaLista(sala, null, titulo, linea, {
        hora: u ? hora(u.ts) : '',
        asterisco: cuantos > 0,
        silencio: salaSilenciada(sala),
        actual: sala === salaActual,
        etiqueta: titulo + (salaSilenciada(sala) ? ' (' + t('socialSilenciado') + ')' : '')
          + (cuantos ? ', ' + t('socialNoLeidosN', { n: cuantos }) : '') + '. ' + linea
      });
      f.boton.addEventListener('click', function () { abrirSala(sala); });
      ul.appendChild(f.li);
    });
  }

  function pintarListaContactos() {
    var ul = $('social-lista-contactos');
    ul.textContent = '';
    var otros = Object.keys(perfiles).filter(function (n) { return n !== yoMinus(); }).map(function (n) {
      return { minus: n, p: perfiles[n], conectado: enLinea(n) };
    });
    otros.sort(function (a, b) { return (b.conectado - a.conectado) || a.p.n.localeCompare(b.p.n); });
    if (!otros.length) {
      var v = document.createElement('li');
      v.className = 'social-lista-vacia';
      v.textContent = t('socialSinContactos');
      ul.appendChild(v);
      return;
    }
    otros.forEach(function (o) {
      var linea = o.p.estado || (o.conectado ? t('socialEnLineaAhora') : t('socialDesconectado'));
      var f = filaLista(null, o.minus, o.p.n, linea, {
        punto: o.conectado,
        silencio: !!silencios.persona[o.minus],
        etiqueta: t('socialHablarCon', { n: o.p.n }) + ' (' + (o.conectado ? t('socialEnLineaAhora') : t('socialDesconectado')) + ')'
          + (o.p.estado ? '. ' + o.p.estado : '')
      });
      f.boton.addEventListener('click', function () { abrirSala(salaCon(o.p.n)); });
      ul.appendChild(f.li);
    });
  }

  function refrescarListas() {
    if (panel === 'chats') pintarListaChats();
    else if (panel === 'contactos') pintarListaContactos();
    else if (panel === 'admin') pintarPanelAdmin();
  }

  /* ---------- Administrador ---------- */
  function pintarAdmin() {
    $('social-insignia-admin').hidden = !esAdmin;
    $('social-op-admin').textContent = t(esAdmin ? 'socialAdminPanel' : 'socialAdminEntrarMenu');
    $('social-op-admin').setAttribute('data-i', esAdmin ? 'socialAdminPanel' : 'socialAdminEntrarMenu');
    $('social-op-admin-salir').hidden = !esAdmin;
    if (!esAdmin && panel === 'admin') cerrarPanel(false);
  }

  function abrirVentanaAdmin() {
    cerrarMenu(false);
    if (!ws || ws.readyState !== 1) return;
    $('social-admin-clave').value = '';
    $('social-admin-error').textContent = '';
    ventanaAdmin.hidden = false;
    $('social-admin-clave').focus();
  }
  function cerrarVentanaAdmin() {
    if (ventanaAdmin.hidden) return;
    ventanaAdmin.hidden = true;
    $('social-admin-clave').value = '';
    if (abierto && !barraPerfil.hidden) botonMenu.focus();
  }
  $('social-op-admin').addEventListener('click', function () {
    if (esAdmin) { cerrarMenu(false); abrirPanel('admin'); } else abrirVentanaAdmin();
  });
  $('social-op-admin-salir').addEventListener('click', function () {
    cerrarMenu(false);
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_salir' }));
  });
  $('social-admin-cancelar').addEventListener('click', cerrarVentanaAdmin);
  ventanaAdmin.addEventListener('click', function (e) { if (e.target === ventanaAdmin) cerrarVentanaAdmin(); });
  $('social-form-admin').addEventListener('submit', function (e) {
    e.preventDefault();
    var clave = $('social-admin-clave').value;
    if (!clave) { $('social-admin-clave').focus(); return; }
    if (!ws || ws.readyState !== 1) { $('social-admin-error').textContent = t('socialErrRed'); return; }
    $('social-admin-error').textContent = '';
    ws.send(JSON.stringify({ t: 'admin_entrar', clave: clave }));
  });
  $('social-admin-cerrar').addEventListener('click', function () { cerrarPanel(true); });

  function avisoAdmin(texto, esError) {
    var a = $('social-admin-aviso');
    a.textContent = texto || '';
    a.classList.toggle('es-error', !!esError);
  }

  $('social-admin-form-clave').addEventListener('submit', function (e) {
    e.preventDefault();
    var nueva = $('social-admin-clave-nueva').value;
    if (nueva.length < 6) { avisoAdmin(t('socialAdminErrClaveCorta'), true); $('social-admin-clave-nueva').focus(); return; }
    if (!window.confirm(t('socialAdminClaveConfirmar', { c: nueva }))) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_clave', clave: nueva }));
  });

  function nombreVisible(minusculas) {
    var p = perfilDe(minusculas);
    return p ? p.n : minusculas;
  }

  function pintarPanelAdmin() {
    if (!esAdmin) return;
    var estadoClave = $('social-admin-clave-estado');
    estadoClave.textContent = !datosAdmin ? '' : t(datosAdmin.clavePropia ? 'socialAdminClavePropia' : 'socialAdminClaveCloudflare');

    // Usuarios: todos menos yo, con botón para sacarlos.
    var ulU = $('social-admin-usuarios');
    ulU.textContent = '';
    var otros = Object.keys(perfiles).filter(function (n) { return n !== yoMinus(); }).sort();
    if (!otros.length) {
      var v = document.createElement('li');
      v.className = 'social-lista-vacia';
      v.textContent = t('socialSinContactos');
      ulU.appendChild(v);
    }
    otros.forEach(function (n) {
      var p = perfiles[n];
      ulU.appendChild(filaAdmin(null, n, p.n, enLinea(n) ? t('socialEnLineaAhora') : t('socialDesconectado'),
        t('socialAdminSacar'), t('socialAdminSacarEtiqueta', { n: p.n }), function () {
          if (!window.confirm(t('socialAdminSacarConfirmar', { n: p.n }))) return;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_sacar', n: p.n }));
        }, enLinea(n)));
    });

    // Chats con mensajes. De los privados solo se ve quiénes y cuántos mensajes.
    var ulC = $('social-admin-chats');
    ulC.textContent = '';
    var lista3 = datosAdmin ? datosAdmin.chats : [];
    if (!lista3.length) {
      var v2 = document.createElement('li');
      v2.className = 'social-lista-vacia';
      v2.textContent = t('socialAdminSinChats');
      ulC.appendChild(v2);
    }
    lista3.forEach(function (c) {
      var titulo = c.sala === GENERAL ? t('socialGeneral')
        : c.miembros ? t('socialAdminChatDe', { a: nombreVisible(c.miembros[0]), b: nombreVisible(c.miembros[1]) }) : c.sala;
      var detalle = t(c.cuantos === 1 ? 'socialAdminMensajes1' : 'socialAdminMensajes', { n: c.cuantos }) + ' · ' + hora(c.ultimo);
      ulC.appendChild(filaAdmin(c.sala, null, titulo, detalle, t('socialAdminBorrar'), t('socialAdminBorrarChatEtiqueta', { c: titulo }), function () {
        if (!window.confirm(t('socialAdminBorrarChatConfirmar', { c: titulo }))) return;
        if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_borrar_chat', sala: c.sala }));
      }));
    });
  }

  function filaAdmin(sala, nombreMinus, titulo, detalle, textoBoton, etiquetaBoton, alTocar, punto) {
    var li = document.createElement('li');
    li.className = 'social-admin-fila';
    var cajaAv = document.createElement('span');
    cajaAv.className = 'social-item-avatar';
    var av = document.createElement('span');
    av.className = 'social-avatar';
    av.setAttribute('aria-hidden', 'true');
    if (sala === GENERAL) pintarAvatarSala(av, GENERAL);
    else if (nombreMinus) { var p = perfilDe(nombreMinus); pintarAvatar(av, p && p.avatar, titulo); }
    else { av.textContent = '🔒'; av.style.background = '#5d6676'; }
    cajaAv.appendChild(av);
    if (punto !== undefined) {
      var pt = document.createElement('span');
      pt.className = 'social-punto' + (punto ? ' si' : '');
      cajaAv.appendChild(pt);
    }
    li.appendChild(cajaAv);
    var textos = document.createElement('span');
    textos.className = 'social-item-textos';
    var a = document.createElement('strong');
    a.textContent = titulo;
    var d = document.createElement('span');
    d.className = 'social-item-abajo';
    d.textContent = detalle;
    textos.appendChild(a);
    textos.appendChild(d);
    li.appendChild(textos);
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'social-boton peligro chico';
    b.textContent = textoBoton;
    b.setAttribute('aria-label', etiquetaBoton);
    b.addEventListener('click', alTocar);
    li.appendChild(b);
    return li;
  }

  function borrarMensaje(id) {
    if (!esAdmin || !window.confirm(t('socialAdminBorrarMsgConfirmar'))) return;
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_borrar_msg', id: id }));
  }

  /* ---------- Silenciar ---------- */
  function ponerSilencios(lista4) {
    silencios = { sala: {}, persona: {} };
    (lista4 || []).forEach(function (s) {
      if (s.tipo === 'sala') silencios.sala[s.valor] = true;
      else if (s.tipo === 'persona') silencios.persona[minus(s.valor)] = true;
    });
  }
  // Un chat está en silencio si lo silencié, o si es privado con alguien que silencié.
  function salaSilenciada(sala) {
    if (silencios.sala[sala]) return true;
    var otro = otroDe(sala);
    return !!(otro && silencios.persona[otro]);
  }
  function mensajeSilenciado(m) {
    return salaSilenciada(m.sala) || !!silencios.persona[minus(m.nombre)];
  }
  function silenciar(tipo, valor, activo) {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    ws.send(JSON.stringify({ t: 'silenciar', tipo: tipo, valor: valor, activo: activo }));
  }

  /* ---------- Avisos de mensajes nuevos ---------- */
  function guardarAvisos() { guardar(CLAVE_AVISOS, JSON.stringify(avisos)); }
  function puedeNotificar() { return 'Notification' in window; }

  // Dos notas cortas, hechas con el navegador (no hace falta ningún archivo de sonido).
  function sonar() {
    try {
      if (!audio) {
        var Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        audio = new Ctx();
      }
      if (audio.state === 'suspended') audio.resume();
      var t0 = audio.currentTime + 0.01;
      [880, 1320].forEach(function (frec, i) {
        var o = audio.createOscillator(), g = audio.createGain(), ini = t0 + i * 0.12;
        o.type = 'sine';
        o.frequency.value = frec;
        g.gain.setValueAtTime(0.0001, ini);
        g.gain.exponentialRampToValueAtTime(0.16, ini + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, ini + 0.18);
        o.connect(g);
        g.connect(audio.destination);
        o.start(ini);
        o.stop(ini + 0.2);
      });
    } catch (e) { /* sin sonido */ }
  }
  // Los navegadores solo dejan sonar después de que la persona toca la página: se prepara al primer toque.
  document.addEventListener('pointerdown', function preparar() {
    document.removeEventListener('pointerdown', preparar);
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (Ctx && !audio) audio = new Ctx();
      if (audio && audio.state === 'suspended') audio.resume();
    } catch (e) { /* nada */ }
  });

  function avisar(m) {
    if (!sesion || minus(m.nombre) === yoMinus()) return;
    if (salaVista(m.sala) || mensajeSilenciado(m)) return;
    var ahora = Date.now();
    if (avisos.sonido && ahora - ultimoSonido > 1500) { ultimoSonido = ahora; sonar(); }
    if (avisos.notif && document.visibilityState !== 'visible' && puedeNotificar() && Notification.permission === 'granted') {
      try {
        var titulo = m.sala === GENERAL ? t('socialNotifGeneral', { n: m.nombre }) : m.nombre;
        var n = new Notification(titulo, { body: Array.from(resumen(m)).slice(0, 140).join(''), tag: 'shukito-' + m.sala, icon: 'assets/logo.webp' });
        n.onclick = function () {
          window.focus();
          abrir();
          abrirSala(m.sala);
          n.close();
        };
      } catch (e) { /* algunos teléfonos solo permiten notificaciones con la página instalada (etapa 5) */ }
    }
  }

  function pintarAjustesAvisos() {
    var s = $('social-op-sonido'), n = $('social-op-notif');
    s.setAttribute('aria-checked', avisos.sonido ? 'true' : 'false');
    n.hidden = !puedeNotificar();
    var activas = avisos.notif && puedeNotificar() && Notification.permission === 'granted';
    n.setAttribute('aria-checked', activas ? 'true' : 'false');
  }
  $('social-op-sonido').addEventListener('click', function () {
    avisos.sonido = !avisos.sonido;
    guardarAvisos();
    pintarAjustesAvisos();
    if (avisos.sonido) sonar(); // para que se escuche cómo suena
  });
  $('social-op-notif').addEventListener('click', function () {
    if (!puedeNotificar()) return;
    if (avisos.notif && Notification.permission === 'granted') {
      avisos.notif = false;
      guardarAvisos();
      pintarAjustesAvisos();
      return;
    }
    cerrarMenu(true);
    if (Notification.permission === 'denied') { mostrarAviso(t('socialNotifBloqueadas')); return; }
    var pedir = Notification.requestPermission(function () { /* navegadores viejos usan esta forma */ });
    Promise.resolve(pedir).then(function () {
      avisos.notif = Notification.permission === 'granted';
      guardarAvisos();
      pintarAjustesAvisos();
      mostrarAviso(t(avisos.notif ? 'socialNotifActivadas' : 'socialNotifBloqueadas'));
    });
  });
  pintarAjustesAvisos();

  /* ---------- Menú del chat abierto: silenciar y borrar ---------- */
  function pintarMenuChat() {
    var otro = otroDe(salaActual);
    var opChat = $('social-op-silenciar-chat'), opPersona = $('social-op-silenciar-persona'), opBorrar = $('social-op-borrar-chat');
    opChat.textContent = t(salaActual === GENERAL ? 'socialSilenciarGeneral' : 'socialSilenciarChat');
    opChat.setAttribute('aria-checked', silencios.sala[salaActual] ? 'true' : 'false');
    opPersona.hidden = !otro;
    if (otro) {
      opPersona.textContent = t('socialSilenciarPersona', { n: nombreSala(salaActual) });
      opPersona.setAttribute('aria-checked', silencios.persona[otro] ? 'true' : 'false');
    }
    opBorrar.textContent = t('socialBorrarChat');
  }
  function abrirMenuChat() {
    if (!sesion) return;
    cerrarMenu(false);
    pintarMenuChat();
    menuChat.hidden = false;
    botonSala.setAttribute('aria-expanded', 'true');
    menuChat.querySelector('button:not([hidden])').focus();
  }
  function cerrarMenuChat(devolverFoco) {
    if (menuChat.hidden) return;
    menuChat.hidden = true;
    botonSala.setAttribute('aria-expanded', 'false');
    if (devolverFoco) botonSala.focus();
  }
  botonSala.addEventListener('click', function () { if (menuChat.hidden) abrirMenuChat(); else cerrarMenuChat(true); });
  document.addEventListener('click', function (e) {
    if (!menuChat.hidden && !menuChat.contains(e.target) && !botonSala.contains(e.target)) cerrarMenuChat(false);
  });
  menuChat.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menuChat.querySelectorAll('button:not([hidden])'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') cerrarMenuChat(false);
  });
  $('social-op-silenciar-chat').addEventListener('click', function () {
    silenciar('sala', salaActual, !silencios.sala[salaActual]);
    cerrarMenuChat(true);
  });
  $('social-op-silenciar-persona').addEventListener('click', function () {
    var otro = otroDe(salaActual);
    if (otro) silenciar('persona', nombreSala(salaActual), !silencios.persona[otro]);
    cerrarMenuChat(true);
  });
  $('social-op-borrar-chat').addEventListener('click', function () {
    cerrarMenuChat(true);
    var nombre = nombreSala(salaActual);
    if (!window.confirm(t(salaActual === GENERAL ? 'socialBorrarGeneralConfirmar' : 'socialBorrarChatConfirmar', { n: nombre }))) return;
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    ws.send(JSON.stringify({ t: 'ocultar_chat', sala: salaActual }));
  });

  /* ---------- Fotos, videos y audios ---------- */
  var M = window.socialMedios || null;
  var archivosCargados = {};    // clave -> promesa de la dirección local (blob:) del archivo
  var medioPendiente = null;    // foto o video listo para enviar: {blob, mime, tipo, dur, ancho, alto, url, sala}
  var preparando = null;        // marca del trabajo de reducción en curso
  var subida = null;            // subida en curso (XMLHttpRequest)
  var grabadora = null;         // grabación de audio en curso
  var salaGrabacion = GENERAL;

  function duracion(seg) {
    seg = Math.max(0, Math.round(seg || 0));
    return Math.floor(seg / 60) + ':' + ('0' + (seg % 60)).slice(-2);
  }
  function etiquetaMedio(m) {
    if (m.tipo === 'foto') return '📷 ' + t('socialFotoNombre');
    if (m.tipo === 'video') return '🎥 ' + t('socialVideoNombre') + ' (' + duracion(m.dur) + ')';
    return '🎤 ' + t('socialAudioNombre') + ' (' + duracion(m.dur) + ')';
  }
  // Texto corto de un mensaje para la lista de chats y las notificaciones.
  function resumen(m) {
    if (!m.archivo) return m.texto;
    return etiquetaMedio(m) + (m.texto ? ' ' + m.texto : '');
  }
  function errorMedio(motivo) {
    return t({
      sin_archivos: 'socialErrSinArchivos', grande: 'socialErrGrande', muchos: 'socialErrMuchos',
      tipo: 'socialErrFormato', formato: 'socialErrFormato', largo: 'socialErrLargoMedio',
      sesion: 'socialErrSesion', permiso: 'socialErrMicrofono', sin_grabador: 'socialErrSinGrabador',
      reproducir: 'socialErrFormato', vacio: 'socialErrFormato'
    }[motivo] || 'socialErrRed');
  }

  // Baja el archivo con el token de la sesión (nunca en la dirección) y lo guarda en memoria.
  function cargarArchivo(clave) {
    if (!archivosCargados[clave]) {
      archivosCargados[clave] = fetch(SOCIAL_SERVIDOR + '/archivo/' + clave, {
        headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : '') },
        cache: 'no-store'
      }).then(function (r) {
        if (!r.ok) throw r.status;
        return r.blob();
      }).then(function (b) {
        return URL.createObjectURL(b);
      });
      archivosCargados[clave].catch(function () { delete archivosCargados[clave]; });
    }
    return archivosCargados[clave];
  }
  function soltarArchivos() {
    for (var c in archivosCargados) archivosCargados[c].then(function (u) { URL.revokeObjectURL(u); }, function () { /* nada */ });
    archivosCargados = {};
  }

  // Los archivos se bajan solo cuando su mensaje está a la vista (o cerca).
  var observador = 'IntersectionObserver' in window ? new IntersectionObserver(function (entradas) {
    entradas.forEach(function (e) {
      if (!e.isIntersecting) return;
      observador.unobserve(e.target);
      mostrarMedio(e.target);
    });
  }, { root: lista, rootMargin: '400px 0px' }) : null;

  function crearMedio(m) {
    var caja = document.createElement('div');
    caja.className = 'social-medio ' + m.tipo;
    if (m.tipo !== 'audio' && m.ancho && m.alto) caja.style.aspectRatio = m.ancho + ' / ' + m.alto;
    caja.setAttribute('data-archivo', m.archivo);
    caja.setAttribute('data-tipo', m.tipo);
    caja.setAttribute('data-de', m.nombre || '');
    var espera = document.createElement('span');
    espera.className = 'social-medio-espera';
    espera.textContent = etiquetaMedio(m);
    caja.appendChild(espera);
    if (observador) observador.observe(caja); else setTimeout(function () { mostrarMedio(caja); }, 0);
    return caja;
  }

  function mostrarMedio(caja) {
    var clave = caja.getAttribute('data-archivo'), tipo = caja.getAttribute('data-tipo');
    var espera = caja.querySelector('.social-medio-espera');
    cargarArchivo(clave).then(function (url) {
      var el;
      if (tipo === 'foto') {
        el = document.createElement('button');
        el.type = 'button';
        el.className = 'social-medio-boton';
        el.setAttribute('aria-label', t('socialVerFoto', { n: caja.getAttribute('data-de') }));
        var img = document.createElement('img');
        img.alt = '';
        img.src = url;
        el.appendChild(img);
        el.addEventListener('click', function () { abrirVisor(url); });
      } else {
        el = document.createElement(tipo === 'video' ? 'video' : 'audio');
        el.controls = true;
        el.preload = 'metadata';
        el.setAttribute('playsinline', '');
        el.src = url;
      }
      caja.textContent = '';
      caja.appendChild(el);
    }).catch(function () {
      if (!espera) return;
      espera.textContent = t('socialErrCargar');
      espera.classList.add('error');
      espera.setAttribute('role', 'button');
      espera.tabIndex = 0;
      var reintentar = function () {
        espera.textContent = t('socialCargando');
        espera.classList.remove('error');
        espera.removeAttribute('role');
        espera.onclick = espera.onkeydown = null;
        mostrarMedio(caja);
      };
      espera.onclick = reintentar;
      espera.onkeydown = function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); reintentar(); } };
    });
  }

  // Foto en grande
  function abrirVisor(url) {
    $('social-visor-img').src = url;
    $('social-visor').hidden = false;
    $('social-visor-cerrar').focus();
  }
  function cerrarVisor() {
    if ($('social-visor').hidden) return;
    $('social-visor').hidden = true;
    $('social-visor-img').removeAttribute('src');
  }
  $('social-visor-cerrar').addEventListener('click', cerrarVisor);
  $('social-visor').addEventListener('click', function (e) { if (e.target === this) cerrarVisor(); });

  // Sube el archivo. Devuelve la clave que el servidor le dio.
  function subirArchivo(medio, alProgreso) {
    return new Promise(function (ok, mal) {
      var x = new XMLHttpRequest();
      subida = x;
      x.open('POST', SOCIAL_SERVIDOR + '/subir');
      x.setRequestHeader('Authorization', 'Bearer ' + sesion.token);
      x.setRequestHeader('Content-Type', medio.mime);
      x.setRequestHeader('X-Tipo', medio.tipo);
      x.setRequestHeader('X-Duracion', String(medio.dur || 0));
      x.setRequestHeader('X-Ancho', String(medio.ancho || 0));
      x.setRequestHeader('X-Alto', String(medio.alto || 0));
      x.upload.onprogress = function (e) { if (e.lengthComputable && alProgreso) alProgreso(e.loaded / e.total); };
      x.onload = function () {
        subida = null;
        var d = {};
        try { d = JSON.parse(x.responseText); } catch (e) { /* nada */ }
        if (x.status === 200 && d.clave) ok(d.clave); else mal(d.error || 'red');
      };
      x.onerror = function () { subida = null; mal('red'); };
      x.onabort = function () { subida = null; mal('cancelado'); };
      x.send(medio.blob);
    });
  }

  // El servidor acepta un mensaje por segundo: si hace falta, se espera un poco antes de enviar.
  function enviarConArchivo(clave, texto, sala) {
    var espera = Math.max(0, 1000 - (Date.now() - ultimoEnvio));
    setTimeout(function () {
      if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
      ultimoEnvio = Date.now();
      var cid = ultimoEnvio.toString(36) + Math.random().toString(36).slice(2, 7);
      ws.send(JSON.stringify({ t: 'msg', sala: sala, texto: texto || '', archivo: clave, cid: cid }));
    }, espera);
  }

  // --- Foto o video: elegir, reducir, ver antes de enviar ---
  var ventanaMedio = $('social-ventana-medio');
  function estadoMedio(texto) { $('social-medio-estado').textContent = texto || ''; }
  function abrirVentanaMedio(tipo) {
    cerrarMenu(false);
    cerrarMenuChat(false);
    $('social-ventana-medio-titulo').textContent = t(tipo === 'video' ? 'socialEnviarVideo' : 'socialEnviarFoto');
    $('social-medio-previa').textContent = '';
    $('social-medio-texto').value = caja.value.trim();
    $('social-medio-error').textContent = '';
    $('social-medio-enviar').disabled = true;
    ventanaMedio.hidden = false;
    $('social-medio-cancelar').focus();
  }
  function cerrarVentanaMedio() {
    preparando = null;
    if (subida) subida.abort();
    if (medioPendiente && medioPendiente.url) URL.revokeObjectURL(medioPendiente.url);
    medioPendiente = null;
    if (ventanaMedio.hidden) return;
    ventanaMedio.hidden = true;
    $('social-medio-previa').textContent = '';
    if (abierto && !chat.hidden) $('social-adjuntar').focus();
  }
  function tamano(bytes) {
    if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + ' KB';
    return (bytes / 1024 / 1024).toFixed(1).replace('.', idioma() === 'en' ? '.' : ',') + ' MB';
  }

  $('social-adjuntar').addEventListener('click', function () {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    $('social-archivo').click();
  });
  $('social-archivo').addEventListener('change', function () {
    var archivo = this.files && this.files[0];
    this.value = '';
    if (!archivo || !M) return;
    var esVideo = /^video\//.test(archivo.type), esFoto = /^image\//.test(archivo.type);
    if (!esVideo && !esFoto) { mostrarAviso(t('socialErrFormato')); return; }
    var tipo = esVideo ? 'video' : 'foto';
    abrirVentanaMedio(tipo);
    estadoMedio(t(esVideo ? 'socialPreparandoVideo' : 'socialPreparando', { p: 0 }));
    var marca = {};
    preparando = marca;
    var sala = salaActual;
    var trabajo = esFoto ? M.reducirFoto(archivo)
      : M.reducirVideo(archivo, function (p) { if (preparando === marca) estadoMedio(t('socialPreparandoVideo', { p: Math.round(p * 100) })); });
    trabajo.then(function (res) {
      if (preparando !== marca) return;
      preparando = null;
      res.tipo = tipo;
      res.sala = sala;
      res.url = URL.createObjectURL(res.blob);
      medioPendiente = res;
      var previa = $('social-medio-previa');
      var el = document.createElement(esFoto ? 'img' : 'video');
      if (esFoto) el.alt = t('socialVistaPrevia');
      else { el.controls = true; el.setAttribute('playsinline', ''); el.preload = 'metadata'; }
      el.src = res.url;
      previa.appendChild(el);
      var nota = tamano(res.blob.size) + (esVideo ? ' · ' + duracion(res.dur) : '');
      if (res.cortado) nota += ' · ' + t('socialVideoCortado', { s: M.VIDEO_SEG });
      estadoMedio(nota);
      $('social-medio-enviar').disabled = false;
      $('social-medio-texto').focus();
    }).catch(function (motivo) {
      if (preparando !== marca) return;
      preparando = null;
      estadoMedio('');
      $('social-medio-error').textContent = errorMedio(motivo);
    });
  });
  $('social-medio-cancelar').addEventListener('click', cerrarVentanaMedio);
  ventanaMedio.addEventListener('click', function (e) { if (e.target === ventanaMedio) cerrarVentanaMedio(); });
  $('social-form-medio').addEventListener('submit', function (e) {
    e.preventDefault();
    var medio = medioPendiente;
    if (!medio || subida) return;
    var texto = $('social-medio-texto').value.trim();
    if (Array.from(texto).length > MAX_LARGO) { $('social-medio-error').textContent = t('socialErrLargo'); return; }
    $('social-medio-enviar').disabled = true;
    $('social-medio-error').textContent = '';
    estadoMedio(t('socialSubiendo', { p: 0 }));
    subirArchivo(medio, function (p) { estadoMedio(t('socialSubiendo', { p: Math.round(p * 100) })); }).then(function (clave) {
      enviarConArchivo(clave, texto, medio.sala);
      if (texto && caja.value.trim() === texto) { caja.value = ''; ajustarCaja(); }
      cerrarVentanaMedio();
    }).catch(function (motivo) {
      if (motivo === 'cancelado') return;
      estadoMedio('');
      $('social-medio-error').textContent = errorMedio(motivo);
      $('social-medio-enviar').disabled = false;
    });
  });

  // --- Audio: grabar con el micrófono (máximo 1 minuto) ---
  function mostrarGrabando(si) {
    $('social-grabando').hidden = !si;
    $('social-form').hidden = si;
    contador.hidden = si;
    $('social-grabando-enviar').disabled = false;
    $('social-grabando-cancelar').disabled = false;
    $('social-grabando-estado').textContent = '';
  }
  function cancelarGrabacion() {
    if (grabadora) { grabadora.cancelar(); grabadora = null; }
    if (subida && $('social-grabando').hidden === false) subida.abort();
    if (!$('social-grabando').hidden) { mostrarGrabando(false); $('social-microfono').focus(); }
  }
  function enviarGrabacion() {
    if (!grabadora) return;
    var g = grabadora, sala = salaGrabacion;
    grabadora = null;
    $('social-grabando-enviar').disabled = true;
    $('social-grabando-estado').textContent = t('socialSubiendo', { p: 0 });
    g.detener().then(function (res) {
      res.tipo = 'audio';
      return subirArchivo(res, function (p) { $('social-grabando-estado').textContent = t('socialSubiendo', { p: Math.round(p * 100) }); });
    }).then(function (clave) {
      enviarConArchivo(clave, '', sala);
      mostrarGrabando(false);
      caja.focus();
    }).catch(function (motivo) {
      mostrarGrabando(false);
      if (motivo !== 'cancelado') mostrarAviso(errorMedio(motivo));
    });
  }
  $('social-microfono').addEventListener('click', function () {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    if (!M || !M.puedeGrabar()) { mostrarAviso(t('socialErrSinGrabador')); return; }
    salaGrabacion = salaActual;
    var maximo = duracion(M.AUDIO_SEG);
    $('social-grabando-tiempo').textContent = '0:00 / ' + maximo;
    mostrarGrabando(true);
    $('social-grabando-estado').textContent = t('socialGrabando');
    grabadora = M.crearGrabadora(function (seg) {
      $('social-grabando-tiempo').textContent = duracion(Math.floor(Math.min(seg, M.AUDIO_SEG))) + ' / ' + maximo;
    }, enviarGrabacion);
    var esta = grabadora;
    $('social-grabando-enviar').focus();
    grabadora.iniciar().catch(function (motivo) {
      if (grabadora !== esta) return;
      grabadora = null;
      mostrarGrabando(false);
      mostrarAviso(errorMedio(motivo));
    });
  });
  $('social-grabando-cancelar').addEventListener('click', cancelarGrabacion);
  $('social-grabando-enviar').addEventListener('click', enviarGrabacion);

  /* ---------- Conexión ---------- */
  function conectar() {
    if (!sesion || (ws && ws.readyState <= 1)) return;
    clearTimeout(temporizador);
    estadoTxt.textContent = t('socialConectando');
    botonEnviar.disabled = true;
    $('social-adjuntar').disabled = true;
    $('social-microfono').disabled = true;
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
      if (sesion) reconectar();
    };
  }
  function reconectar() {
    estadoTxt.textContent = t('socialConectando');
    botonEnviar.disabled = true;
    $('social-adjuntar').disabled = true;
    $('social-microfono').disabled = true;
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
    if (document.visibilityState === 'visible' && sesion) { reintento = 0; conectar(); marcarLeido(); }
    actualizarAsterisco();
  });

  /* ---------- Mensajes del servidor ---------- */
  function ponerPerfil(p) {
    if (!p || !p.n) return;
    perfiles[minus(p.n)] = { n: p.n, avatar: p.avatar, estado: p.estado || '' };
  }

  function recibir(m) {
    if (m.t === 'hola') {
      reintento = 0;
      horas = m.horas || 24;
      sesion.nombre = m.yo;
      perfiles = {};
      (m.perfiles || []).forEach(ponerPerfil);
      // Se conservan los chats privados abiertos sin mensajes, si la otra persona sigue existiendo.
      var antes = chats;
      chats = {};
      for (var s in antes) if (s === GENERAL || perfilDe(otroDe(s))) datosSala(s);
      lecturas = {};
      (m.mensajes || []).forEach(function (x) { datosSala(x.sala || GENERAL).mensajes.push(x); });
      (m.lecturas || []).forEach(function (x) { ponerLectura(x.sala, x.n, x.id); });
      datosSala(GENERAL);
      if (!chats[salaActual]) salaActual = GENERAL;
      pendientes = {};
      esAdmin = !!m.admin;
      ponerSilencios(m.silencios);
      pintarAdmin();
      pintarPerfil();
      pintarCabeceraSala();
      pintarTodo();
      refrescarListas();
      ajustarCaja();
      clearInterval(latido);
      latido = setInterval(function () { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);
      marcarLeido();
      actualizarAsterisco();
    } else if (m.t === 'sesion_invalida') {
      if (m.motivo === 'sacado') { quitar(CLAVE_NOMBRE); $('social-nombre').value = ''; modo = 'nuevo'; }
      terminarSesion(t(m.motivo === 'cuenta_borrada' ? 'socialCuentaBorrada' : m.motivo === 'sacado' ? 'socialSacado' : 'socialErrSesion'));
    } else if (m.t === 'admin') {
      esAdmin = !!m.activo;
      pintarAdmin();
      pintarTodo();
      if (esAdmin) { cerrarVentanaAdmin(); abrirPanel('admin'); avisoAdmin(t('socialAdminBienvenida')); }
      else mostrarAviso(t('socialAdminFuera'));
    } else if (m.t === 'admin_datos') {
      datosAdmin = { chats: m.chats || [], clavePropia: !!m.clavePropia };
      if (panel === 'admin') pintarPanelAdmin();
    } else if (m.t === 'admin_ok') {
      if (m.accion === 'clave') { $('social-admin-clave-nueva').value = ''; avisoAdmin(t('socialAdminClaveCambiada')); }
      else if (m.accion === 'sacar') avisoAdmin(t('socialAdminSacadoOk', { n: m.n }));
      else if (m.accion === 'chat') avisoAdmin(t('socialAdminChatBorradoOk'));
      else if (m.accion === 'mensaje') mostrarAviso(t('socialAdminMsgBorradoOk'));
    } else if (m.t === 'borrado') {
      var cb = chats[m.sala];
      if (cb) cb.mensajes = cb.mensajes.filter(function (x) { return x.id !== m.id; });
      if (m.sala === salaActual) {
        var filaB = lista.querySelector('.social-fila[data-id="' + Number(m.id) + '"]');
        if (filaB) filaB.remove();
        if (!datosSala(salaActual).mensajes.length) pintarTodo();
      }
      refrescarListas();
      actualizarAsterisco();
    } else if (m.t === 'silencios') {
      ponerSilencios(m.lista);
      pintarCabeceraSala();
      pintarMenuChat();
      refrescarListas();
    } else if (m.t === 'chat_oculto') {
      // "Borrar chat" (solo para mí), hecho aquí o en otro teléfono de la misma cuenta.
      var co = chats[m.sala];
      if (co) co.mensajes = co.mensajes.filter(function (x) { return x.id > m.hasta; });
      if (m.hasta) ponerLectura(m.sala, sesion.nombre, m.hasta);
      if (co && m.sala !== GENERAL && !co.mensajes.length && m.sala !== salaActual) delete chats[m.sala];
      if (m.sala === salaActual) pintarTodo();
      refrescarListas();
      actualizarAsterisco();
    } else if (m.t === 'chat_borrado') {
      if (m.sala === GENERAL) datosSala(GENERAL).mensajes = [];
      else { delete chats[m.sala]; delete lecturas[m.sala]; }
      if (m.sala === salaActual) {
        if (m.sala === GENERAL) pintarTodo(); else abrirSala(GENERAL);
        if (!esAdmin) mostrarAviso(t('socialChatBorradoAdmin'));
      }
      refrescarListas();
      actualizarAsterisco();
    } else if (m.t === 'estado') {
      usuarios = m.usuarios || [];
      var cuantos = usuarios.filter(function (u) { return u.enLinea; }).length;
      estadoTxt.textContent = t('socialEnLineaCuenta', { n: cuantos });
      pintarCabeceraSala();
      refrescarListas();
      actualizarMarcas();
    } else if (m.t === 'perfil') {
      ponerPerfil(m.p);
      if (m.p && minus(m.p.n) === yoMinus()) pintarPerfil();
      if (m.p) refrescarAvatares(minus(m.p.n));
      pintarCabeceraSala();
      refrescarListas();
    } else if (m.t === 'perfil_borrado') {
      var quien = minus(m.n);
      delete perfiles[quien];
      for (var sala in chats) {
        if (otroDe(sala) === quien) { delete chats[sala]; delete lecturas[sala]; }
      }
      if (!chats[salaActual]) abrirSala(GENERAL);
      pintarCabeceraSala();
      refrescarListas();
      actualizarAsterisco();
    } else if (m.t === 'msg') {
      var mm = m.m;
      mm.sala = mm.sala || GENERAL;
      var c = datosSala(mm.sala);
      if (c.mensajes.some(function (x) { return x.id === mm.id; })) return;
      c.mensajes.push(mm);
      delete c.escribiendo[mm.nombre];
      var pend = m.cid && pendientes[m.cid];
      if (pend) { delete pendientes[m.cid]; pend.fila.remove(); }
      if (mm.sala === salaActual) {
        pintarEscribiendo();
        agregarBurbuja(mm, true);
        if (minus(mm.nombre) !== yoMinus()) marcarLeido();
      }
      avisar(mm);
      actualizarAsterisco();
      refrescarListas();
    } else if (m.t === 'leido') {
      ponerLectura(m.sala || GENERAL, m.n, m.id);
      if ((m.sala || GENERAL) === salaActual) actualizarMarcas();
      actualizarAsterisco();
      if (panel === 'chats') pintarListaChats();
    } else if (m.t === 'escribiendo') {
      var cs = datosSala(m.sala || GENERAL);
      cs.escribiendo[m.n] = Date.now() + 3500;
      pintarEscribiendo();
      setTimeout(pintarEscribiendo, 3600);
    } else if (m.t === 'purga') {
      for (var sp in chats) {
        var lista2 = chats[sp].mensajes.filter(function (x) { return x.ts >= m.corte; });
        if (m.max && lista2.length > m.max) lista2 = lista2.slice(-m.max);
        chats[sp].mensajes = lista2;
      }
      pintarTodo();
      refrescarListas();
      actualizarAsterisco();
    } else if (m.t === 'error') {
      var p = m.cid && pendientes[m.cid];
      if (p) { delete pendientes[m.cid]; p.fila.remove(); }
      mostrarAviso(m.e === 'rapido' ? t('socialErrRapido') : m.e === 'largo' ? t('socialErrLargo')
        : m.e === 'estado_largo' ? t('socialErrEstado') : m.e === 'avatar' ? t('socialErrFoto')
        : m.e === 'sala' ? t('socialErrSala') : m.e === 'archivo' ? t('socialErrArchivo') : '');
      // Errores del administrador
      var minutosA = Math.max(1, Math.ceil((m.espera || 600) / 60));
      if (m.e === 'admin_clave') $('social-admin-error').textContent = t('socialAdminErrClave', { n: m.quedan });
      else if (m.e === 'admin_bloqueado') $('social-admin-error').textContent = t('socialErrBloqueado', { m: minutosA });
      else if (m.e === 'sin_admin') $('social-admin-error').textContent = t('socialAdminErrSinClave');
      else if (m.e === 'clave_corta') avisoAdmin(t('socialAdminErrClaveCorta'), true);
      else if (m.e === 'no_a_ti') avisoAdmin(t('socialAdminErrATi'), true);
      else if (m.e === 'no_existe') { avisoAdmin(t('socialAdminErrNoExiste'), true); if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_datos' })); }
      else if (m.e === 'no_admin') { esAdmin = false; pintarAdmin(); pintarTodo(); }
      if (m.e === 'admin_clave' || m.e === 'admin_bloqueado') { $('social-admin-clave').value = ''; $('social-admin-clave').focus(); }
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
    var c = datosSala(salaActual);
    if (!c.mensajes.length) {
      var v = document.createElement('p');
      v.className = 'social-vacio';
      v.textContent = salaActual === GENERAL ? t('socialVacio', { h: horas }) : t('socialVacioPrivado', { n: nombreSala(salaActual), h: horas });
      lista.appendChild(v);
    }
    for (var i = 0; i < c.mensajes.length; i++) agregarBurbuja(c.mensajes[i], false);
    for (var cid in pendientes) if (pendientes[cid].sala === salaActual) lista.appendChild(pendientes[cid].fila);
    bajar(true);
  }

  // En el chat general, los mensajes de otros llevan su avatar y su nombre.
  function crearBurbuja(nombre, texto, ts, mio, conAutor, medio) {
    var fila = document.createElement('div');
    fila.className = 'social-fila ' + (mio ? 'mia' : 'otra');
    if (conAutor) {
      var av = document.createElement('span');
      av.className = 'social-avatar mini';
      av.setAttribute('aria-hidden', 'true');
      av.setAttribute('data-avatar-de', minus(nombre));
      var p = perfilDe(minus(nombre));
      pintarAvatar(av, p && p.avatar, nombre);
      fila.appendChild(av);
    }
    var b = document.createElement('div');
    b.className = 'social-burbuja';
    if (conAutor) {
      var autor = document.createElement('span');
      autor.className = 'social-autor';
      autor.textContent = nombre;
      b.appendChild(autor);
    }
    if (medio && medio.archivo) b.appendChild(crearMedio(medio));
    if (texto) {
      var cuerpo = document.createElement('span');
      cuerpo.className = 'social-cuerpo';
      cuerpo.textContent = texto;
      b.appendChild(cuerpo);
    }
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

  function refrescarAvatares(nombreMinus) {
    var p = perfilDe(nombreMinus);
    var avs = lista.querySelectorAll('[data-avatar-de]');
    for (var i = 0; i < avs.length; i++) {
      if (avs[i].getAttribute('data-avatar-de') === nombreMinus) pintarAvatar(avs[i], p && p.avatar, p ? p.n : nombreMinus);
    }
  }

  function agregarBurbuja(m, animar) {
    var vacio = lista.querySelector('.social-vacio');
    if (vacio) vacio.remove();
    var mio = sesion && minus(m.nombre) === yoMinus();
    var cerca = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 120;
    var fila = crearBurbuja(m.nombre, m.texto, m.ts, mio, !mio && salaActual === GENERAL, m);
    fila.setAttribute('data-id', m.id);
    if (esAdmin) {
      // Papelera del administrador en cada mensaje guardado.
      var papelera = document.createElement('button');
      papelera.type = 'button';
      papelera.className = 'social-papelera';
      papelera.setAttribute('aria-label', t('socialAdminBorrarMsg'));
      papelera.title = t('socialAdminBorrarMsg');
      papelera.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
      papelera.addEventListener('click', function () { borrarMensaje(m.id); });
      fila.querySelector('.social-pie').insertBefore(papelera, fila.querySelector('.social-pie').firstChild);
    }
    var primerPendiente = lista.querySelector('.social-fila.pendiente');
    lista.insertBefore(fila, primerPendiente);
    if (mio) ponerMarca(fila, m.id);
    if (animar && (mio || cerca)) bajar(false);
  }

  // ✓ enviado, ✓✓ azul: leído (en el general, por todos los demás).
  function ponerMarca(fila, id) {
    var marca = fila.querySelector('.social-marca');
    if (!marca) return;
    var otros = salaActual === GENERAL
      ? Object.keys(perfiles).filter(function (n) { return n !== yoMinus(); })
      : [otroDe(salaActual)];
    var todos = otros.length > 0 && otros.every(function (n) { return leidoPor(salaActual, n) >= id; });
    marca.textContent = todos ? '✓✓' : '✓';
    marca.classList.toggle('leido', todos);
    marca.setAttribute('aria-label', todos ? t(salaActual === GENERAL ? 'socialLeido' : 'socialLeidoPrivado') : t('socialEnviado'));
    marca.title = marca.getAttribute('aria-label');
  }

  function actualizarMarcas() {
    var filas = lista.querySelectorAll('.social-fila.mia[data-id]');
    for (var i = 0; i < filas.length; i++) ponerMarca(filas[i], Number(filas[i].getAttribute('data-id')));
  }

  function pintarEscribiendo() {
    if (avisoEscribe.classList.contains('es-aviso')) return;
    var esc = datosSala(salaActual).escribiendo;
    var ahora = Date.now();
    var nombres = [];
    for (var n in esc) { if (esc[n] > ahora) nombres.push(n); else delete esc[n]; }
    if (!nombres.length) { avisoEscribe.textContent = ''; return; }
    var juntos = nombres.length === 1 ? nombres[0] : nombres.slice(0, -1).join(', ') + t('socialY') + nombres[nombres.length - 1];
    avisoEscribe.textContent = t(nombres.length === 1 ? 'socialEscribiendo1' : 'socialEscribiendoVarios', { a: juntos });
  }

  function bajar(inmediato) {
    lista.scrollTo({ top: lista.scrollHeight, behavior: inmediato ? 'auto' : 'smooth' });
  }

  // Marca como leído el chat abierto (solo si se está viendo: página visible y sin panel encima).
  function marcarLeido() {
    if (!abierto || panel || document.visibilityState !== 'visible' || !ws || ws.readyState !== 1) return;
    var u = ultimo(salaActual);
    if (!u || leidoPor(salaActual, yoMinus()) >= u.id) { actualizarAsterisco(); return; }
    ponerLectura(salaActual, sesion.nombre, u.id);
    ws.send(JSON.stringify({ t: 'leido', sala: salaActual, id: u.id }));
    actualizarAsterisco();
  }

  /* ---------- Escribir y enviar ---------- */
  function largo(s) { return Array.from(s).length; }
  function ajustarCaja() {
    caja.style.height = 'auto';
    var borde = caja.offsetHeight - caja.clientHeight; // el borde no cuenta en scrollHeight
    var alto = caja.scrollHeight + borde;
    caja.style.height = Math.min(alto, 130) + 'px';
    caja.style.overflowY = alto > 130 ? 'auto' : 'hidden';
    var n = largo(caja.value);
    contador.textContent = n > MAX_LARGO - 80 ? (MAX_LARGO - n) + '' : '';
    contador.classList.toggle('excedido', n > MAX_LARGO);
    var conectado = !!ws && ws.readyState === 1;
    botonEnviar.disabled = !caja.value.trim() || n > MAX_LARGO || !conectado;
    $('social-adjuntar').disabled = !conectado;
    $('social-microfono').disabled = !conectado;
  }
  caja.addEventListener('input', function () {
    ajustarCaja();
    var ahora = Date.now();
    if (caja.value && ahora - ultimoAvisoEscribe > 2000 && ws && ws.readyState === 1) {
      ultimoAvisoEscribe = ahora;
      ws.send(JSON.stringify({ t: 'escribiendo', sala: salaActual }));
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
    var fila = crearBurbuja(sesion.nombre, texto, ahora, true, false);
    fila.classList.add('pendiente');
    var marca = fila.querySelector('.social-marca');
    marca.textContent = '🕓';
    marca.setAttribute('aria-label', t('socialPendiente'));
    var vacio = lista.querySelector('.social-vacio');
    if (vacio) vacio.remove();
    lista.appendChild(fila);
    pendientes[cid] = { fila: fila, sala: salaActual };
    ws.send(JSON.stringify({ t: 'msg', sala: salaActual, texto: texto, cid: cid }));
    caja.value = '';
    ajustarCaja();
    caja.focus();
    bajar(false);
  }

  // Cambio de idioma: rehacer los textos dinámicos.
  document.addEventListener('shukito-idioma', function () {
    selectorRegistro.etiquetas();
    selectorCambiar.etiquetas();
    var etiqueta = $('social-boton-entrar').firstElementChild;
    if (!$('social-boton-entrar').disabled) etiqueta.textContent = t(modo === 'nuevo' ? 'socialCrear' : 'socialEntrar');
    pintarAdmin();
    pintarAjustesAvisos();
    actualizarAsterisco();
    if (!abierto) return;
    if (sesion && !chat.hidden) { pintarPerfil(); pintarCabeceraSala(); }
    if (sesion && !chat.hidden && ws && ws.readyState === 1) {
      pintarTodo(); refrescarListas(); pintarEscribiendo();
      estadoTxt.textContent = t('socialEnLineaCuenta', { n: usuarios.filter(function (u) { return u.enLinea; }).length });
    } else if (!chat.hidden) estadoTxt.textContent = t('socialConectando');
  });

  // Con sesión guardada, conectar enseguida (aunque el chat esté cerrado) para avisar de mensajes nuevos.
  if (sesion) conectar();

  // Abrir directo con la dirección .../#social
  if (location.hash === '#social') { history.replaceState(null, '', location.pathname + location.search); abrir(); }
})();
