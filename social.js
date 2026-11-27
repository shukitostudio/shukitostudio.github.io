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
  var botonMuroMenu = $('social-muro-menu');
  var botonVolver = $('social-volver');
  var botonMenuChat = botonSala; // el botón que abrió el menú del chat (el de la lista o el del muro)
  var ventanaAdmin = $('social-ventana-admin');
  var paneles = { chats: panelChats, contactos: panelContactos, admin: panelAdmin };
  var botonesPanel = { chats: botonChats, contactos: botonContactos };

  boton.hidden = false;

  var sesion = leerSesion();
  var CLAVE_BLOQUEO = 'shukito-social-bloqueo';
  var bloqueado = !!sesion && leer(CLAVE_BLOQUEO) === '1'; // después de la X: el chat pide el PIN
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
  var traducciones = {};      // id del mensaje -> {a: 'es' | 'en', texto}
  var verTraduccion = {};     // id -> true si se está mostrando la traducción
  var traduciendo = {};       // id -> true mientras se espera la traducción
  var respuesta = null;       // mensaje al que se está respondiendo: {sala, id, n, x, tp, dur, archivo, gif}
  var errorPendiente = '';    // aviso de sesión terminada mientras el chat estaba cerrado
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
  // Última vez conectado (el servidor solo la manda si la persona no está en línea).
  function vistoDe(nombreMinus) {
    for (var i = 0; i < usuarios.length; i++) if (minus(usuarios[i].n) === nombreMinus) return Number(usuarios[i].visto) || 0;
    return 0;
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

  /* ---------- iPhone (Safari) ----------
     En el iPhone el teclado NO encoge la pantalla: la página sigue midiendo lo mismo y Safari solo la
     desplaza para que se vea el campo. Por eso el chat sigue a la "parte visible" (visualViewport) y la
     página de atrás se deja quieta. Solo se activa en iPhone: en Android y en computadora no cambia nada. */
  var esIPhone = /iPhone|iPod/.test(navigator.userAgent);
  var vv = window.visualViewport;
  var scrollGuardado = 0;
  var tecladoAbierto = false;
  var altoCompleto = 0;
  if (esIPhone) document.documentElement.classList.add('social-ios');

  function iphoneAntes() {
    if (!esIPhone) return;
    // La página se fija en su sitio (position: fixed) y se recuerda dónde estaba para volver igual.
    scrollGuardado = window.pageYOffset || 0;
    document.body.style.top = -scrollGuardado + 'px';
  }
  function iphoneAjustar() {
    if (!esIPhone || !abierto) return;
    var alto = vv ? vv.height : window.innerHeight;
    var arriba = vv ? vv.offsetTop : 0;
    raiz.style.height = Math.round(alto) + 'px';
    raiz.style.top = Math.round(arriba) + 'px';
    var foco = document.activeElement;
    var escribiendo = !!foco && raiz.contains(foco) && /^(INPUT|TEXTAREA)$/.test(foco.tagName);
    // Altura "sin teclado": la más grande vista (el iPhone a veces también encoge innerHeight).
    altoCompleto = Math.max(altoCompleto, window.innerHeight, document.documentElement.clientHeight);
    var teclado = !!(escribiendo && vv && altoCompleto - vv.height > 120);
    document.documentElement.classList.toggle('social-teclado', teclado);
    // Al salir el teclado, el último mensaje sigue a la vista.
    if (teclado && !tecladoAbierto && !chat.hidden) setTimeout(function () { bajar(true); }, 0);
    tecladoAbierto = teclado;
  }
  function iphoneDespues() {
    if (!esIPhone) return;
    tecladoAbierto = false;
    raiz.style.height = '';
    raiz.style.top = '';
    document.documentElement.classList.remove('social-teclado');
    document.body.style.top = '';
    restaurarScroll();
    // Al volver atrás, el navegador puede mover la página después: se reafirma un instante más tarde.
    setTimeout(function () { if (!abierto) restaurarScroll(); }, 150);
  }
  function restaurarScroll() {
    if (Math.abs((window.pageYOffset || 0) - scrollGuardado) < 2) return;
    // La página tiene desplazamiento suave: se apaga un instante para volver al mismo sitio sin animación.
    var raizDoc = document.documentElement;
    raizDoc.style.scrollBehavior = 'auto';
    window.scrollTo(0, scrollGuardado);
    raizDoc.style.scrollBehavior = '';
  }
  if (esIPhone) {
    // Mientras el teclado sale, cambia o se cierra, se mide en cada cuadro durante ~0,8 s.
    var seguirHasta = 0, siguiendo = false;
    var reajustar = function () {
      seguirHasta = Date.now() + 800;
      if (siguiendo) return;
      siguiendo = true;
      (function paso() {
        iphoneAjustar();
        if (Date.now() < seguirHasta && abierto) requestAnimationFrame(paso); else siguiendo = false;
      })();
    };
    window.addEventListener('orientationchange', function () { altoCompleto = 0; });
    if (vv) { vv.addEventListener('resize', reajustar); vv.addEventListener('scroll', iphoneAjustar); }
    window.addEventListener('resize', iphoneAjustar);
    window.addEventListener('orientationchange', function () { setTimeout(iphoneAjustar, 300); });
    document.addEventListener('focusin', reajustar);
    document.addEventListener('focusout', reajustar);
  }

  /* ---------- Abrir / cerrar ---------- */
  function abrir() {
    if (abierto) return;
    abierto = true;
    // Primero el historial: así el navegador guarda la posición real de la página (antes de fijarla).
    history.pushState({ social: 1 }, '');
    iphoneAntes();
    raiz.hidden = false;
    document.documentElement.classList.add('social-abierto');
    iphoneAjustar();
    if (sesion && bloqueado) { mostrarCandado(); conectar(); }
    else if (sesion) { mostrarChat(); conectar(); marcarLeido(); actualizarAsterisco(); }
    else { mostrarEntrar(errorPendiente); errorPendiente = ''; }
  }
  function cerrar(desdeAtras) {
    if (!abierto) return;
    abierto = false;
    cerrarMenu(false);
    cerrarVentanaAvatar();
    cerrarVentanaAdmin();
    cerrarVentanaPin();
    cancelarEstado();
    cerrarPanel(false);
    cerrarMenuChat(false);
    cancelarGrabacion();   // apaga el micrófono si estaba grabando
    cerrarVentanaMedio();
    cerrarVisor();
    cerrarSelectorReaccion();
    cerrarMenuAdjuntar(false);
    cerrarGifs(false);
    cerrarStickers(false);
    cancelarRespuesta();
    raiz.hidden = true;
    document.documentElement.classList.remove('social-abierto');
    iphoneDespues();
    // La conexión sigue abierta: así llegan los avisos de mensajes nuevos mientras la página está abierta.
    actualizarAsterisco();
    if (!desdeAtras && history.state && history.state.social) history.back();
    boton.focus();
  }
  boton.addEventListener('click', abrir);
  // La X es una salida de emergencia: cierra el chat, cierra la sesión en este teléfono y borra de la
  // pantalla todo lo que se veía. Para volver hay que entrar otra vez con el PIN y la clave del grupo.
  // La X es una salida de emergencia: vuelve a la página principal y borra de la pantalla lo que se veía.
  // La sesión sigue abierta, pero el chat queda con candado (también al recargar): para volver se pide el
  // PIN. Con un PIN equivocado solo se ve una pantalla vacía. Mientras tanto no hay avisos de mensajes.
  function salidaEmergencia() {
    if (sesion) { bloqueado = true; guardar(CLAVE_BLOQUEO, '1'); }
    cerrar(false);
    if (!bloqueado) return;
    lista.textContent = '';
    caja.value = '';
    ajustarCaja();
    $('social-medio-texto').value = '';
    ['social-lista-chats', 'social-lista-contactos', 'social-admin-usuarios', 'social-admin-chats', 'social-medio-previa',
      'social-muro-avatar', 'social-muro-nombre', 'social-muro-estado', 'social-muro-presencia',
      'social-sala-avatar', 'social-sala-nombre', 'social-sala-detalle', 'social-mi-avatar-img', 'social-mi-nombre',
      'social-mi-estado', 'social-escribiendo', 'social-estado'].forEach(function (id) {
      var el = $(id);
      if (!el) return;
      el.textContent = '';
      if (/avatar/.test(id)) el.style.background = '';
    });
    actualizarAsterisco();
  }

  // ---------- Candado (después de la X) ----------
  var candado = $('social-candado'), falso = $('social-falso');
  var esperaCandado = null;
  function mostrarCandado() {
    formEntrar.hidden = true;
    chat.hidden = true;
    barraPerfil.hidden = true;
    falso.hidden = true;
    candado.hidden = false;
    estadoTxt.textContent = '';
    ponerVista();
    $('social-candado-pin').value = '';
    $('social-candado-error').textContent = '';
    $('social-candado-entrar').disabled = false;
    setTimeout(function () { if (!candado.hidden) $('social-candado-pin').focus(); }, 50);
  }
  function mostrarFalso() {
    clearTimeout(esperaCandado);
    candado.hidden = true;
    falso.hidden = false;
    $('social-candado-pin').value = '';
  }
  function desbloqueado(ok) {
    clearTimeout(esperaCandado);
    if (!bloqueado || candado.hidden) return;
    if (!ok) { mostrarFalso(); return; }
    bloqueado = false;
    quitar(CLAVE_BLOQUEO);
    candado.hidden = true;
    mostrarChat();
    abrirPanel('chats');   // se ve la lista: la conversación se busca ahí
    actualizarAsterisco();
  }
  $('social-candado-pin').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
  candado.addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('social-candado-pin').value;
    if (!/^[0-9]{4,6}$/.test(pin)) { mostrarFalso(); return; }
    if (!ws || ws.readyState !== 1) { $('social-candado-error').textContent = t('socialErrRed'); conectar(); return; }
    $('social-candado-error').textContent = '';
    $('social-candado-entrar').disabled = true;
    ws.send(JSON.stringify({ t: 'desbloquear', pin: pin }));
    esperaCandado = setTimeout(function () {
      $('social-candado-entrar').disabled = false;
      $('social-candado-error').textContent = t('socialErrRed');
    }, 10000);
  });
  $('social-cerrar').addEventListener('click', salidaEmergencia);
  window.addEventListener('popstate', function () { if (abierto) cerrar(true); });
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (!priv.hidden) cerrarPrivacidad();
    else if (!ventanaAvatar.hidden) cerrarVentanaAvatar();
    else if (!ventanaPin.hidden) cerrarVentanaPin();
    else if (!ventanaAdmin.hidden) cerrarVentanaAdmin();
    else if (!$('social-visor').hidden) cerrarVisor();
    else if (!$('social-ventana-medio').hidden) cerrarVentanaMedio();
    else if (!$('social-grabando').hidden) cancelarGrabacion();
    else if (!menu.hidden) cerrarMenu(true);
    else if (!selector.hidden) cerrarSelectorReaccion(true);
    else if (!ventanaGifs.hidden) cerrarGifs(true);
    else if (!ventanaStickers.hidden) cerrarStickers(true);
    else if (!menuAdjuntar.hidden) cerrarMenuAdjuntar(true);
    else if (!menuChat.hidden) cerrarMenuChat(true);
    else if (!$('social-estado-form').hidden) cancelarEstado();
    else if (panel) cerrarPanel(true);
    else if (respuesta && abierto && !chat.hidden) cancelarRespuesta(true);
    else if (abierto) cerrar(false);
  });

  function mostrarEntrar(error) {
    chat.hidden = true;
    barraPerfil.hidden = true;
    formEntrar.hidden = false;
    candado.hidden = true;
    falso.hidden = true;
    ponerVista();
    estadoTxt.textContent = '';
    var ultimo = leer(CLAVE_NOMBRE);
    if (ultimo && !$('social-nombre').value) $('social-nombre').value = ultimo;
    ponerModo(ultimo ? 'entrar' : modo);
    $('social-error').textContent = error || '';
    setTimeout(function () { (ultimo ? $('social-pin') : $('social-nombre')).focus(); }, 50);
  }
  function mostrarChat() {
    formEntrar.hidden = true;
    candado.hidden = true;
    falso.hidden = true;
    chat.hidden = false;
    barraPerfil.hidden = false;
    ponerVista();
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
        // Al entrar se ve la lista de chats: la conversación se busca ahí (nunca se abre sola).
        abrirPanel('chats');
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
    cerrarVentanaPin();
    cerrarVentanaMedio();
    cancelarGrabacion();
    cerrarVisor();
    soltarArchivos();
    soltarStickers();
    traducciones = {}; verTraduccion = {}; traduciendo = {};
    reaccionesDe = {};
    bloqueado = false;
    quitar(CLAVE_BLOQUEO);
    cerrarSelectorReaccion();
    cerrarMenuAdjuntar(false);
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
    // Si el chat está cerrado, el aviso se muestra al abrirlo.
    if (abierto) mostrarEntrar(error); else errorPendiente = error || '';
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
  // Dos vistas: la lista (mi perfil, Chats y Contactos) o la conversación (el muro de la otra persona).
  function ponerVista() {
    raiz.classList.toggle('en-conversacion', !panel && !chat.hidden);
  }
  function abrirPanel(cual) {
    cerrarMenu(false);
    cerrarMenuChat(false);
    cerrarSelectorReaccion();
    cerrarMenuAdjuntar(false);
    cancelarEstado();
    panel = cual;
    ponerVista();
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
    ponerVista();
    cerrarMenu(false);
    cerrarMenuChat(false);
    for (var p in paneles) paneles[p].hidden = true;
    for (var b in botonesPanel) {
      botonesPanel[b].setAttribute('aria-expanded', 'false');
      botonesPanel[b].classList.remove('activo');
    }
    if (devolverFoco) botonVolver.focus();
    marcarLeido();
  }
  botonChats.addEventListener('click', function () { if (panel === 'chats') cerrarPanel(true); else abrirPanel('chats'); });
  botonContactos.addEventListener('click', function () { if (panel === 'contactos') cerrarPanel(true); else abrirPanel('contactos'); });
  botonVolver.addEventListener('click', function () { abrirPanel('chats'); });
  ponerVista();

  function abrirSala(sala) {
    datosSala(sala);
    var cambio = sala !== salaActual;
    salaActual = sala;
    cerrarPanel(false);
    pintarCabeceraSala();
    if (cambio) {
      caja.value = '';
      cancelarRespuesta();
      cerrarGifs(false);
      cerrarStickers(false);
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
    pintarMuro();
  }

  // 8:42 AM (también en español, como pidió Shukito).
  function hora12(d) {
    var h = d.getHours(), m = ('0' + d.getMinutes()).slice(-2);
    return ((h % 12) || 12) + ':' + m + ' ' + (h < 12 ? 'AM' : 'PM');
  }
  function textoUltimaVez(ts) {
    var d = new Date(ts), ahora = new Date();
    var hoy = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate()).getTime();
    var ayer = new Date(ahora.getFullYear(), ahora.getMonth(), ahora.getDate() - 1).getTime();
    var h = hora12(d);
    if (ts >= hoy) return t('socialUltVezHoy', { h: h });
    if (ts >= ayer) return t('socialUltVezAyer', { h: h });
    var opciones = { day: 'numeric', month: 'short' };
    if (d.getFullYear() !== ahora.getFullYear()) opciones.year = 'numeric';
    var f;
    try { f = d.toLocaleDateString(idioma() === 'en' ? 'en-US' : 'es', opciones).replace('.', ''); }
    catch (e) { f = d.getDate() + '/' + (d.getMonth() + 1); }
    return t('socialUltVezFecha', { f: f, h: h });
  }

  // Muro de arriba en la conversación: foto grande, nombre, estado y "En línea" o "Últ. vez…".
  function pintarMuro() {
    var foto = $('social-muro-foto'), estado = $('social-muro-estado'), presencia = $('social-muro-presencia');
    pintarAvatarSala($('social-muro-avatar'), salaActual);
    $('social-muro-nombre').textContent = nombreSala(salaActual);
    $('social-muro-silencio').hidden = !salaSilenciada(salaActual);
    botonMuroMenu.setAttribute('aria-label', botonSala.getAttribute('aria-label') || '');
    foto.classList.remove('en-linea', 'grupo');
    presencia.classList.remove('en-linea');
    if (salaActual === GENERAL) {
      var total = Object.keys(perfiles).length;
      var cuantos = usuarios.filter(function (u) { return u.enLinea; }).length;
      foto.classList.add('grupo');
      estado.textContent = total === 1 ? t('socialMiembros1') : t('socialMiembros', { n: total });
      estado.hidden = false;
      presencia.textContent = ws && ws.readyState === 1 ? t('socialEnLineaCuenta', { n: cuantos }) : '';
      presencia.classList.toggle('en-linea', cuantos > 0);
      return;
    }
    var otro = otroDe(salaActual), p = perfilDe(otro), conectado = enLinea(otro), visto = vistoDe(otro);
    estado.textContent = (p && p.estado) || '';
    estado.hidden = !(p && p.estado);
    foto.classList.toggle('en-linea', conectado);
    presencia.classList.toggle('en-linea', conectado);
    presencia.textContent = conectado ? t('socialEnLineaAhora') : visto ? textoUltimaVez(visto) : t('socialDesconectado');
  }
  // "Hoy" pasa a "ayer" a medianoche: se repinta cada minuto mientras el chat está abierto.
  setInterval(function () { if (abierto && sesion && !panel) pintarMuro(); }, 60000);

  // Un chat se está "viendo" si el chat Social está abierto, sin panel encima, en esa sala y con la página visible.
  function salaVista(sala) {
    return abierto && !bloqueado && !chat.hidden && !panel && document.visibilityState === 'visible' && sala === salaActual;
  }
  function totalNoLeidos() {
    var n = 0;
    for (var s in chats) if (!salaVista(s)) n += noLeidos(s);
    return n;
  }
  // Asterisco rojo en el botón Chats y en el botón Social de la portada; número en el título de la pestaña.
  function actualizarAsterisco() {
    var total = sesion && !bloqueado ? totalNoLeidos() : 0;
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
      var filaU = filaAdmin(null, n, p.n, enLinea(n) ? t('socialEnLineaAhora') : t('socialDesconectado'),
        t('socialAdminSacar'), t('socialAdminSacarEtiqueta', { n: p.n }), function () {
          if (!window.confirm(t('socialAdminSacarConfirmar', { n: p.n }))) return;
          if (ws && ws.readyState === 1) ws.send(JSON.stringify({ t: 'admin_sacar', n: p.n }));
        }, enLinea(n));
      // Restablecer el PIN (para quien lo olvidó)
      var bPin = document.createElement('button');
      bPin.type = 'button';
      bPin.className = 'social-boton secundario chico';
      bPin.textContent = t('socialAdminPin');
      bPin.setAttribute('aria-label', t('socialAdminPinEtiqueta', { n: p.n }));
      bPin.addEventListener('click', function () { abrirVentanaPin(p.n, bPin); });
      filaU.insertBefore(bPin, filaU.lastChild);
      ulU.appendChild(filaU);
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

  // Ventana para restablecer el PIN de alguien (solo administrador).
  var ventanaPin = $('social-ventana-pin');
  var pinDe = '', pinVolverA = null;
  function abrirVentanaPin(nombre, desde) {
    pinDe = nombre;
    pinVolverA = desde || null;
    $('social-ventana-pin-titulo').textContent = t('socialAdminPinEtiqueta', { n: nombre });
    $('social-admin-pin-nuevo').value = '';
    $('social-admin-pin-error').textContent = '';
    $('social-admin-pin-guardar').disabled = false;
    ventanaPin.hidden = false;
    $('social-admin-pin-nuevo').focus();
  }
  function cerrarVentanaPin() {
    if (ventanaPin.hidden) return;
    ventanaPin.hidden = true;
    $('social-admin-pin-nuevo').value = '';
    if (pinVolverA && pinVolverA.isConnected) pinVolverA.focus();
    pinVolverA = null;
  }
  $('social-admin-pin-nuevo').addEventListener('input', function () { this.value = this.value.replace(/\D/g, '').slice(0, 6); });
  $('social-admin-pin-cancelar').addEventListener('click', cerrarVentanaPin);
  ventanaPin.addEventListener('click', function (e) { if (e.target === ventanaPin) cerrarVentanaPin(); });
  $('social-form-pin').addEventListener('submit', function (e) {
    e.preventDefault();
    var pin = $('social-admin-pin-nuevo').value;
    if (!/^[0-9]{4,6}$/.test(pin)) { $('social-admin-pin-error').textContent = t('socialErrPin'); $('social-admin-pin-nuevo').focus(); return; }
    if (!ws || ws.readyState !== 1) { $('social-admin-pin-error').textContent = t('socialErrRed'); return; }
    $('social-admin-pin-error').textContent = '';
    $('social-admin-pin-guardar').disabled = true;
    ws.send(JSON.stringify({ t: 'admin_pin', n: pinDe, pin: pin }));
  });

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
    if (!sesion || bloqueado || minus(m.nombre) === yoMinus()) return;
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
  // El mismo menú sirve para el botón de la lista y para el ⋮ del muro: se mueve junto al botón que lo abre.
  function abrirMenuChat(desde) {
    if (!sesion) return;
    cerrarMenu(false);
    pintarMenuChat();
    botonMenuChat = desde || botonSala;
    if (menuChat.parentNode !== botonMenuChat.parentNode) botonMenuChat.parentNode.appendChild(menuChat);
    menuChat.classList.toggle('desde-muro', botonMenuChat === botonMuroMenu);
    menuChat.hidden = false;
    botonMenuChat.setAttribute('aria-expanded', 'true');
    menuChat.querySelector('button:not([hidden])').focus();
  }
  function cerrarMenuChat(devolverFoco) {
    if (menuChat.hidden) return;
    menuChat.hidden = true;
    botonMenuChat.setAttribute('aria-expanded', 'false');
    if (devolverFoco) botonMenuChat.focus();
  }
  botonSala.addEventListener('click', function () { if (menuChat.hidden) abrirMenuChat(botonSala); else cerrarMenuChat(true); });
  botonMuroMenu.addEventListener('click', function () { if (menuChat.hidden) abrirMenuChat(botonMuroMenu); else cerrarMenuChat(true); });
  document.addEventListener('click', function (e) {
    if (!menuChat.hidden && !menuChat.contains(e.target) && !botonMenuChat.contains(e.target)) cerrarMenuChat(false);
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
    if (m.tipo === 'sticker') return '✨ ' + t('socialStickerNombre');
    if (m.tipo === 'foto') return '📷 ' + t('socialFotoNombre');
    if (m.tipo === 'video') return '🎥 ' + t('socialVideoNombre') + ' (' + duracion(m.dur) + ')';
    return '🎤 ' + t('socialAudioNombre') + ' (' + duracion(m.dur) + ')';
  }
  // Texto corto de un mensaje para la lista de chats y las notificaciones.
  function resumen(m) {
    if (m.gif) return '🎞️ ' + t('socialGifNombre') + (m.texto ? ' ' + m.texto : '');
    if (!m.archivo) return m.texto;
    return etiquetaMedio(m) + (m.texto ? ' ' + m.texto : '');
  }
  function errorMedio(motivo) {
    return t({
      sin_archivos: 'socialErrSinArchivos', grande: 'socialErrGrande', muchos: 'socialErrMuchos',
      tipo: 'socialErrFormato', formato: 'socialErrFormato', largo: 'socialErrLargoMedio',
      sesion: 'socialErrSesion', permiso: 'socialErrMicrofono', sin_grabador: 'socialErrSinGrabador',
      reproducir: 'socialErrVideoReproducir', vacio: 'socialErrFormato', abrir: 'socialErrVideoAbrir',
      interrumpido: 'socialErrVideoInterrumpido', atascado: 'socialErrVideoAtascado'
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
      if (tipo === 'sticker') {
        el = document.createElement('img');
        el.alt = t('socialStickerNombre');
        el.src = url;
      } else if (tipo === 'foto') {
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
    var resp = respuestaPara(sala);
    if (resp) cancelarRespuesta();
    setTimeout(function () {
      if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
      ultimoEnvio = Date.now();
      var cid = ultimoEnvio.toString(36) + Math.random().toString(36).slice(2, 7);
      var datos = { t: 'msg', sala: sala, texto: texto || '', archivo: clave, cid: cid };
      if (resp) datos.resp = resp.id;
      ws.send(JSON.stringify(datos));
    }, espera);
  }

  // --- Foto o video: elegir, reducir, ver antes de enviar ---
  var ventanaMedio = $('social-ventana-medio');
  var conversion = null;        // preparación de un video en curso (tiene .cancelar())
  function estadoMedio(texto) { $('social-medio-estado').textContent = texto || ''; }
  // Barra de progreso (null la esconde).
  function barraMedio(p) {
    var barra = $('social-medio-barra');
    barra.hidden = p === null;
    if (p === null) return;
    var n = Math.round(Math.max(0, Math.min(1, p)) * 100);
    $('social-medio-barra-relleno').style.width = n + '%';
    barra.setAttribute('aria-valuenow', String(n));
  }
  function abrirVentanaMedio(tipo) {
    cerrarMenu(false);
    cerrarMenuChat(false);
    $('social-ventana-medio-titulo').textContent = t(tipo === 'video' ? 'socialEnviarVideo' : 'socialEnviarFoto');
    $('social-medio-previa').textContent = '';
    $('social-medio-texto').value = caja.value.trim();
    $('social-medio-error').textContent = '';
    $('social-medio-enviar').disabled = true;
    $('social-medio-trozo').hidden = true;
    $('social-medio-consejo').hidden = true;
    barraMedio(null);
    ventanaMedio.hidden = false;
    $('social-medio-cancelar').focus();
  }
  function cerrarVentanaMedio() {
    preparando = null;
    if (conversion) { conversion.cancelar(); conversion = null; }
    if (subida) subida.abort();
    if (medioPendiente) {
      if (medioPendiente.url) URL.revokeObjectURL(medioPendiente.url);
      if (medioPendiente.abierto) {
        var son = medioPendiente.abierto.video._sonido;
        if (son && son.ac) { try { son.ac.close(); } catch (e) { /* nada */ } }
        medioPendiente.abierto.soltar();
      }
    }
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

  // Menú del clip: galería, tomar foto, grabar video (solo en pantallas táctiles) y audio.
  var menuAdjuntar = $('social-menu-adjuntar');
  var botonAdjuntar = $('social-adjuntar');
  var esTactil = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
  Array.prototype.forEach.call(menuAdjuntar.querySelectorAll('.solo-tactil'), function (b) { b.hidden = !esTactil; });
  function abrirMenuAdjuntar() {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    cerrarMenuChat(false);
    cerrarSelectorReaccion();
    menuAdjuntar.hidden = false;
    botonAdjuntar.setAttribute('aria-expanded', 'true');
    menuAdjuntar.querySelector('button:not([hidden])').focus();
  }
  function cerrarMenuAdjuntar(devolverFoco) {
    if (menuAdjuntar.hidden) return;
    menuAdjuntar.hidden = true;
    botonAdjuntar.setAttribute('aria-expanded', 'false');
    if (devolverFoco) botonAdjuntar.focus();
  }
  botonAdjuntar.addEventListener('click', function () { if (menuAdjuntar.hidden) abrirMenuAdjuntar(); else cerrarMenuAdjuntar(true); });
  document.addEventListener('click', function (e) {
    if (!menuAdjuntar.hidden && !menuAdjuntar.contains(e.target) && !botonAdjuntar.contains(e.target)) cerrarMenuAdjuntar(false);
  });
  menuAdjuntar.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(menuAdjuntar.querySelectorAll('button:not([hidden])'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') cerrarMenuAdjuntar(false);
  });
  // El selector de archivos se abre dentro del mismo toque (si no, el teléfono lo bloquea).
  // [botón del menú, selector de archivos, qué se pidió (por si el teléfono no dice el tipo del archivo)]
  [['social-op-galeria', 'social-archivo', 'foto'], ['social-op-galeria-video', 'social-galeria-video', 'video'],
    ['social-op-camara-foto', 'social-camara-foto', 'foto'], ['social-op-camara-video', 'social-camara-video', 'video']]
    .forEach(function (par) {
      $(par[0]).addEventListener('click', function () { cerrarMenuAdjuntar(false); $(par[1]).click(); });
      $(par[1]).addEventListener('change', function () {
        var archivo = this.files && this.files[0];
        this.value = '';
        if (archivo) elegirArchivo(archivo, par[2]);
      });
    });
  $('social-op-audio').addEventListener('click', function () { cerrarMenuAdjuntar(false); $('social-microfono').click(); });

  function elegirArchivo(archivo, pista) {
    if (!M) return;
    var tipo = M.clase(archivo, pista);
    if (!tipo) { mostrarAviso(t('socialErrFormato')); return; }
    abrirVentanaMedio(tipo);
    var marca = {};
    preparando = marca;
    var sala = salaActual;
    var previa = $('social-medio-previa');
    if (tipo === 'foto') {
      estadoMedio(t('socialPreparando'));
      M.reducirFoto(archivo).then(function (res) {
        if (preparando !== marca) return;
        preparando = null;
        res.tipo = 'foto';
        res.sala = sala;
        res.url = URL.createObjectURL(res.blob);
        medioPendiente = res;
        var img = document.createElement('img');
        img.alt = t('socialVistaPrevia');
        img.src = res.url;
        previa.appendChild(img);
        estadoMedio(tamano(res.blob.size));
        $('social-medio-enviar').disabled = false;
      }).catch(function (motivo) {
        if (preparando !== marca) return;
        preparando = null;
        estadoMedio('');
        $('social-medio-error').textContent = errorMedio(motivo);
      });
      return;
    }
    // Video: primero se muestra tal cual; se prepara al tocar "Enviar" (ver más abajo).
    estadoMedio(t('socialAbriendoVideo'));
    M.abrirVideo(archivo, previa, pista).then(function (ab) {
      if (preparando !== marca) { ab.soltar(); return; }
      preparando = null;
      var medio = { tipo: 'video', sala: sala, abierto: ab, inicio: 0 };
      medioPendiente = medio;
      var v = ab.video;
      v.className = 'social-previa-video';
      var seg = M.VIDEO_SEG;
      var trozo = $('social-medio-trozo'), desde = $('social-medio-desde');
      function pintarTrozo() {
        var total = ab.dur, a = medio.inicio, b = Math.min(total, a + seg);
        $('social-medio-trozo-texto').textContent = t('socialVideoTrozo', { a: duracion(Math.floor(a)), b: duracion(Math.round(b)) });
      }
      // Con la duración conocida: si pasa de 15 s, se elige el trozo. Si Safari aún no la dio, se espera
      // a que la dé (por ejemplo, al tocar play en la vista previa); si no, se envían los primeros 15 s.
      function conDuracion() {
        if (medioPendiente !== medio || medio.blob) return;
        if (!ab.dur && isFinite(v.duration) && v.duration > 0) ab.dur = v.duration;
        var largo = ab.dur > seg + 0.5;
        trozo.hidden = !largo || !!conversion;
        if (largo) {
          desde.max = String(Math.max(0, Math.floor((ab.dur - seg) * 2) / 2));
          if (Number(desde.value) > Number(desde.max)) desde.value = desde.max;
          desde.oninput = function () {
            medio.inicio = Number(desde.value) || 0;
            try { v.pause(); v.currentTime = medio.inicio; } catch (e) { /* nada */ }
            pintarTrozo();
          };
          pintarTrozo();
        }
        estadoMedio(ab.dur
          ? t('socialVideoListo', { d: duracion(Math.round(Math.min(ab.dur, seg))) })
          : t('socialVideoListoSinDur', { s: seg }));
      }
      if (!ab.dur) v.addEventListener('durationchange', function () { if (!conversion) conDuracion(); });
      desde.value = '0';
      conDuracion();
      $('social-medio-consejo').textContent = t('socialVideoConsejo');
      $('social-medio-consejo').hidden = false;
      $('social-medio-enviar').disabled = false;
    }).catch(function (motivo) {
      if (preparando !== marca) return;
      preparando = null;
      estadoMedio('');
      $('social-medio-error').textContent = errorMedio(motivo);
    });
  }

  function subirYEnviar(medio, texto) {
    estadoMedio(t('socialSubiendo', { p: 0 }));
    barraMedio(0);
    subirArchivo(medio, function (p) { estadoMedio(t('socialSubiendo', { p: Math.round(p * 100) })); barraMedio(p); }).then(function (clave) {
      enviarConArchivo(clave, texto, medio.sala);
      if (texto && caja.value.trim() === texto) { caja.value = ''; ajustarCaja(); }
      cerrarVentanaMedio();
    }).catch(function (motivo) {
      if (motivo === 'cancelado') return;
      falloMedio(motivo);
    });
  }
  function falloMedio(motivo) {
    estadoMedio('');
    barraMedio(null);
    $('social-medio-error').textContent = errorMedio(motivo);
    $('social-medio-enviar').disabled = false;
    var m = medioPendiente;
    if (m && m.abierto && !m.blob) {
      m.abierto.video.controls = true;
      $('social-medio-trozo').hidden = !(m.abierto.dur > M.VIDEO_SEG + 0.5);
    }
  }
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
    if (medio.blob) { subirYEnviar(medio, texto); return; }
    // Video: se prepara AHORA, dentro del toque (Safari solo deja reproducir así). Sin esperas antes de esto.
    $('social-medio-trozo').hidden = true;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); // cierra el teclado
    estadoMedio(t('socialPreparandoVideo', { p: 0 }));
    barraMedio(0);
    var conv = M.convertirVideo(medio.abierto, medio.inicio, function (p, intento) {
      if (conversion !== conv) return;
      estadoMedio(t(intento ? 'socialReduciendoMas' : 'socialPreparandoVideo', { p: Math.round(p * 100) }));
      barraMedio(p);
    });
    conversion = conv;
    conv.then(function (res) {
      if (conversion !== conv) return;
      conversion = null;
      medio.blob = res.blob; medio.mime = res.mime; medio.ancho = res.ancho; medio.alto = res.alto; medio.dur = res.dur;
      subirYEnviar(medio, texto);
    }, function (motivo) {
      if (conversion !== conv) return;
      conversion = null;
      if (motivo !== 'cancelado') falloMedio(motivo);
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

  /* ---------- Traducir ---------- */
  function alternarTraduccion(id) {
    if (verTraduccion[id]) delete verTraduccion[id];
    else if (traducciones[id]) verTraduccion[id] = true;
    else if (!traduciendo[id]) {
      if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
      traduciendo[id] = true;
      // Al idioma de la página; si el mensaje ya está en ese idioma, el servidor lo traduce al otro.
      ws.send(JSON.stringify({ t: 'traducir', id: id, a: idioma() === 'en' ? 'en' : 'es' }));
    }
    var fila = lista.querySelector('.social-fila[data-id="' + Number(id) + '"]');
    if (fila) pintarTraduccion(fila, id);
  }

  function pintarTraduccion(fila, id) {
    var boton = fila.querySelector('.social-traducir');
    var bloque = fila.querySelector('.social-traduccion');
    var tr = traducciones[id];
    if (verTraduccion[id] && tr) {
      if (!bloque) {
        bloque = document.createElement('span');
        bloque.className = 'social-traduccion';
        var etiqueta = document.createElement('span');
        etiqueta.className = 'social-traduccion-etiqueta';
        var texto = document.createElement('span');
        texto.className = 'social-traduccion-texto';
        bloque.appendChild(etiqueta);
        bloque.appendChild(texto);
        var burbuja = fila.querySelector('.social-burbuja');
        burbuja.insertBefore(bloque, burbuja.querySelector('.social-pie'));
      }
      bloque.setAttribute('lang', tr.a);
      bloque.querySelector('.social-traduccion-etiqueta').textContent = t(tr.a === 'en' ? 'socialTraducidoEn' : 'socialTraducidoEs');
      bloque.querySelector('.social-traduccion-texto').textContent = tr.texto;
    } else if (bloque) {
      bloque.remove();
    }
    if (!boton) return;
    boton.textContent = t(verTraduccion[id] && tr ? 'socialVerOriginal' : traduciendo[id] ? 'socialTraduciendo' : 'socialTraducir');
    boton.disabled = !!traduciendo[id];
  }

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
    $('social-gif').disabled = true;
    $('social-sticker').disabled = true;
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
      reaccionesDe = {};
      (m.reacciones || []).forEach(function (x) { ponerReaccion(x.id, x.n, x.e); });
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
      else if (m.accion === 'pin') { cerrarVentanaPin(); avisoAdmin(t('socialAdminPinOk', { n: m.n })); }
      else if (m.accion === 'chat') avisoAdmin(t('socialAdminChatBorradoOk'));
      else if (m.accion === 'mensaje') mostrarAviso(t('socialAdminMsgBorradoOk'));
    } else if (m.t === 'borrado') {
      var cb = chats[m.sala];
      if (cb) cb.mensajes = cb.mensajes.filter(function (x) { return x.id !== m.id; });
      if (respuesta && respuesta.id === m.id) cancelarRespuesta();
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
    } else if (m.t === 'traduccion') {
      traducciones[m.id] = { a: m.a, texto: m.texto };
      delete traduciendo[m.id];
      verTraduccion[m.id] = true;
      var filaT = lista.querySelector('.social-fila[data-id="' + Number(m.id) + '"]');
      if (filaT) pintarTraduccion(filaT, m.id);
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
      if (!bloqueado) estadoTxt.textContent = t('socialEnLineaCuenta', { n: cuantos });
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
    } else if (m.t === 'desbloqueo') {
      desbloqueado(!!m.ok);
    } else if (m.t === 'reaccion') {
      ponerReaccion(m.id, m.n, m.e);
      if ((m.sala || GENERAL) === salaActual) {
        var filaR = lista.querySelector('.social-fila[data-id="' + Number(m.id) + '"]');
        var cercaR = lista.scrollHeight - lista.scrollTop - lista.clientHeight < 120;
        if (filaR) { pintarReacciones(filaR, m.id); if (cercaR && !filaR.nextElementSibling) bajar(false); }
      }
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
      if (p) {
        delete pendientes[m.cid]; p.fila.remove();
        // El texto no se pierde: vuelve a la caja (si no se escribió otra cosa mientras tanto).
        if (p.texto && !caja.value.trim() && p.sala === salaActual) { caja.value = p.texto; ajustarCaja(); }
      }
      mostrarAviso(m.e === 'rapido' ? t('socialErrRapido') : m.e === 'largo' ? t('socialErrLargo')
        : m.e === 'estado_largo' ? t('socialErrEstado') : m.e === 'avatar' ? t('socialErrFoto')
        : m.e === 'sala' ? t('socialErrSala') : m.e === 'archivo' ? t('socialErrArchivo')
        : m.e === 'traducir' ? t('socialErrTraducir') : m.e === 'traducir_limite' ? t('socialErrTraducirLimite')
        : m.e === 'sin_traductor' ? t('socialErrSinTraductor') : m.e === 'responder' ? t('socialErrResponder')
        : m.e === 'gif' ? t('socialErrGif') : m.e === 'sticker' ? t('socialErrSticker') : '');
      if (m.id && traduciendo[m.id]) {
        delete traduciendo[m.id];
        var filaE = lista.querySelector('.social-fila[data-id="' + Number(m.id) + '"]');
        if (filaE) pintarTraduccion(filaE, m.id);
      }
      // Errores del administrador
      var minutosA = Math.max(1, Math.ceil((m.espera || 600) / 60));
      if (m.e === 'admin_pin') { $('social-admin-pin-error').textContent = t('socialErrPin'); $('social-admin-pin-guardar').disabled = false; }
      if (!ventanaPin.hidden) $('social-admin-pin-guardar').disabled = false;
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
    cerrarSelectorReaccion();
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
    if (medio && medio.cita) b.appendChild(crearCita(medio.cita));
    if (medio && medio.gif) { b.appendChild(crearGif(medio.gif)); fila.classList.add('con-gif'); }
    if (medio && medio.archivo) b.appendChild(crearMedio(medio));
    if (medio && medio.stickerLocal) b.appendChild(crearStickerLocal(medio.stickerLocal, medio.ancho, medio.alto));
    if (medio && (medio.tipo === 'sticker' || medio.stickerLocal)) fila.classList.add('con-sticker');
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
    if (m.texto) {
      // Traducir (español <-> inglés)
      var traducir = document.createElement('button');
      traducir.type = 'button';
      traducir.className = 'social-traducir';
      traducir.addEventListener('click', function () { alternarTraduccion(m.id); });
      fila.querySelector('.social-pie').insertBefore(traducir, fila.querySelector('.social-pie').firstChild);
      pintarTraduccion(fila, m.id);
    }
    var primerPendiente = lista.querySelector('.social-fila.pendiente');
    if (m.id) { prepararReaccion(fila, m.id); pintarReacciones(fila, m.id); }
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

  /* ---------- Reacciones 👍 ❤️ 😢 😡 (una por persona y mensaje) ---------- */
  var REACCIONES = ['👍', '❤️', '😢', '😡', '😂'];
  var reaccionesDe = {};        // id del mensaje -> {nombre en minúsculas: {n, e}}
  var selector = $('social-reaccionar');
  var selectorId = 0, selectorFila = null;

  function ponerReaccion(id, nombre, e) {
    var r = reaccionesDe[id] || (reaccionesDe[id] = {});
    if (e) r[minus(nombre)] = { n: nombre, e: e }; else delete r[minus(nombre)];
  }
  function miReaccion(id) {
    var x = reaccionesDe[id] && reaccionesDe[id][yoMinus()];
    return x ? x.e : '';
  }
  function reaccionar(id, e) {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    ws.send(JSON.stringify({ t: 'reaccion', id: id, e: e }));
  }

  // Debajo de la burbuja: una pastilla por reacción con su contador. La mía, resaltada.
  function pintarReacciones(fila, id) {
    var b = fila.querySelector('.social-burbuja');
    var vieja = fila.querySelector('.social-reacciones');
    if (vieja) vieja.remove();
    var r = reaccionesDe[id] || {}, grupos = {}, hay = false;
    for (var k in r) (grupos[r[k].e] = grupos[r[k].e] || []).push(r[k].n);
    var mia = miReaccion(id);
    var cajaR = document.createElement('div');
    cajaR.className = 'social-reacciones';
    REACCIONES.forEach(function (e) {
      var nombres = grupos[e];
      if (!nombres) return;
      hay = true;
      var chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'social-reaccion' + (e === mia ? ' es-mia' : '');
      chip.setAttribute('aria-pressed', e === mia ? 'true' : 'false');
      var em = document.createElement('span');
      em.className = 'social-reaccion-emoji';
      em.setAttribute('aria-hidden', 'true');
      em.textContent = e;
      var n = document.createElement('span');
      n.className = 'social-reaccion-n';
      n.setAttribute('aria-hidden', 'true');
      n.textContent = nombres.length;
      chip.appendChild(em);
      chip.appendChild(n);
      chip.setAttribute('aria-label', t('socialReaccionEtiqueta', { e: e, n: nombres.length, quien: nombres.join(', ') })
        + ' ' + t(e === mia ? 'socialReaccionQuitar' : 'socialReaccionPoner'));
      chip.title = nombres.join(', ');
      chip.addEventListener('click', function () { reaccionar(id, e); });
      cajaR.appendChild(chip);
    });
    fila.classList.toggle('con-reacciones', hay);
    if (hay) b.appendChild(cajaR);
  }

  // Botoncito con una carita en cada mensaje (junto a la hora): abre la barra de reacciones.
  var botonCaritaActivo = null;
  var CARITA = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="12.5" r="8" fill="none" stroke="currentColor" stroke-width="1.9"/>'
    + '<circle cx="8.4" cy="10.6" r="1.2" fill="currentColor"/><circle cx="13.6" cy="10.6" r="1.2" fill="currentColor"/>'
    + '<path d="M7.6 14.4c.9 1.5 2 2.2 3.4 2.2s2.5-.7 3.4-2.2" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>'
    + '<path d="M20 1.8v5M17.5 4.3h5" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>';
  function prepararReaccion(fila, id) {
    var pie = fila.querySelector('.social-pie');
    var bt = document.createElement('button');
    bt.type = 'button';
    bt.className = 'social-carita';
    bt.setAttribute('aria-haspopup', 'menu');
    bt.setAttribute('aria-expanded', 'false');
    bt.setAttribute('aria-controls', 'social-reaccionar');
    bt.setAttribute('aria-label', t('socialReaccionar'));
    bt.title = t('socialReaccionar');
    bt.innerHTML = CARITA;
    bt.addEventListener('click', function () {
      if (botonCaritaActivo === bt) cerrarSelectorReaccion(true);
      else abrirSelectorReaccion(fila, id, bt);
    });
    pie.insertBefore(bt, pie.querySelector('time'));
  }

  function abrirSelectorReaccion(fila, id, bt) {
    if (!fila.isConnected) return;
    cerrarSelectorReaccion();
    cerrarMenuAdjuntar(false);
    cerrarGifs(false);
    cerrarStickers(false);
    selectorId = id;
    selectorFila = fila;
    botonCaritaActivo = bt;
    bt.setAttribute('aria-expanded', 'true');
    fila.classList.add('reaccionando');
    var mia = miReaccion(id);
    Array.prototype.forEach.call(selector.querySelectorAll('[data-e]'), function (bt) {
      bt.setAttribute('aria-checked', bt.getAttribute('data-e') === mia ? 'true' : 'false');
    });
    selector.hidden = false;
    // Arriba de la burbuja; si no cabe, debajo. Alineado al lado de la burbuja.
    var vista = selector.parentNode.getBoundingClientRect();
    var r = fila.querySelector('.social-burbuja').getBoundingClientRect();
    var ancho = selector.offsetWidth, alto = selector.offsetHeight;
    var arriba = r.top - vista.top - alto - 8;
    if (arriba < 4) arriba = Math.min(r.bottom - vista.top + 8, vista.height - alto - 4);
    var izq = fila.classList.contains('mia') ? r.right - vista.left - ancho : r.left - vista.left;
    izq = Math.max(6, Math.min(izq, vista.width - ancho - 6));
    selector.style.top = Math.round(arriba) + 'px';
    selector.style.left = Math.round(izq) + 'px';
    (selector.querySelector('[aria-checked="true"]') || selector.querySelector('button')).focus({ preventScroll: true });
  }
  function cerrarSelectorReaccion(devolverFoco) {
    if (selector.hidden) return;
    selector.hidden = true;
    if (selectorFila) selectorFila.classList.remove('reaccionando');
    var bt = botonCaritaActivo;
    if (bt) bt.setAttribute('aria-expanded', 'false');
    selectorId = 0;
    selectorFila = null;
    botonCaritaActivo = null;
    if (devolverFoco && bt && bt.isConnected) bt.focus({ preventScroll: true });
  }
  selector.addEventListener('click', function (e) {
    var bt = e.target.closest('button');
    if (!bt) return;
    var id = selectorId;
    cerrarSelectorReaccion();
    if (bt.getAttribute('data-accion') === 'responder') { empezarRespuesta(id); return; }
    reaccionar(id, bt.getAttribute('data-e'));
  });
  selector.addEventListener('keydown', function (e) {
    var items = Array.prototype.slice.call(selector.querySelectorAll('button'));
    var i = items.indexOf(document.activeElement);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length].focus(); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
    else if (e.key === 'Tab') cerrarSelectorReaccion();
  });
  document.addEventListener('pointerdown', function (e) {
    if (!selector.hidden && !selector.contains(e.target) && !(botonCaritaActivo && botonCaritaActivo.contains(e.target))) cerrarSelectorReaccion();
  });
  lista.addEventListener('scroll', function () { cerrarSelectorReaccion(); }, { passive: true });

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
    if (!abierto || bloqueado || chat.hidden || panel || document.visibilityState !== 'visible' || !ws || ws.readyState !== 1) return;
    var u = ultimo(salaActual);
    if (!u || leidoPor(salaActual, yoMinus()) >= u.id) { actualizarAsterisco(); return; }
    ponerLectura(salaActual, sesion.nombre, u.id);
    ws.send(JSON.stringify({ t: 'leido', sala: salaActual, id: u.id }));
    actualizarAsterisco();
  }

  // Burbuja gris con 🕓 mientras el servidor confirma el mensaje.
  function ponerPendiente(cid, texto, medio) {
    var fila = crearBurbuja(sesion.nombre, texto, Date.now(), true, false, medio);
    fila.classList.add('pendiente');
    var marca = fila.querySelector('.social-marca');
    marca.textContent = '🕓';
    marca.setAttribute('aria-label', t('socialPendiente'));
    var vacio = lista.querySelector('.social-vacio');
    if (vacio) vacio.remove();
    lista.appendChild(fila);
    pendientes[cid] = { fila: fila, sala: salaActual };
    return fila;
  }

  /* ---------- Responder a un mensaje ---------- */
  var cajaRespuesta = $('social-respuesta');
  function buscarMensaje(sala, id) {
    var l = datosSala(sala).mensajes;
    for (var i = 0; i < l.length; i++) if (l[i].id === id) return l[i];
    return null;
  }
  function nombreCita(n) {
    if (minus(n) === yoMinus()) return t('socialCitaTu');
    var p = perfilDe(minus(n));
    return p ? p.n : n;
  }
  // "📷 Foto · texto", "🎞️ GIF" o solo el texto.
  function etiquetaCita(c) {
    var medio = c.tp === 'gif' ? '🎞️ ' + t('socialGifNombre') : c.tp ? etiquetaMedio({ tipo: c.tp, dur: c.dur || 0 }) : '';
    return medio && c.x ? medio + ' · ' + c.x : (medio || c.x || '');
  }
  function empezarRespuesta(id) {
    var m = buscarMensaje(salaActual, id);
    if (!m) return;
    cerrarGifs(false);
    respuesta = {
      sala: salaActual, id: m.id, n: m.nombre, x: Array.from(m.texto || '').slice(0, 120).join(''),
      tp: m.gif ? 'gif' : (m.tipo || ''), dur: m.dur || 0, archivo: m.archivo || '', gif: m.gif || null
    };
    pintarRespuesta();
    caja.focus();
  }
  // Lo que se muestra en la burbuja pendiente (y lo que se manda: solo el id).
  function respuestaPara(sala) {
    if (!respuesta || respuesta.sala !== sala) return null;
    var r = { id: respuesta.id, n: respuesta.n, x: respuesta.x };
    if (respuesta.tp) r.tp = respuesta.tp;
    if (respuesta.dur) r.dur = respuesta.dur;
    return r;
  }
  function cancelarRespuesta(devolverFoco) {
    if (!respuesta) return;
    respuesta = null;
    pintarRespuesta();
    if (devolverFoco) caja.focus();
  }
  function pintarRespuesta() {
    cajaRespuesta.hidden = !respuesta;
    var mini = $('social-respuesta-mini');
    mini.textContent = '';
    mini.hidden = true;
    if (!respuesta) return;
    var r = respuesta;
    $('social-respuesta-titulo').textContent = minus(r.n) === yoMinus() ? t('socialRespondiendoATi') : t('socialRespondiendoA', { n: nombreCita(r.n) });
    $('social-respuesta-texto').textContent = etiquetaCita(r);
    var ponerMini = function (url) {
      if (respuesta !== r) return;
      var img = document.createElement('img');
      img.alt = '';
      img.referrerPolicy = 'no-referrer';
      img.src = url;
      mini.textContent = '';
      mini.appendChild(img);
      mini.hidden = false;
    };
    if (r.gif && gifPermitido(r.gif.u)) ponerMini(r.gif.u);
    else if ((r.tp === 'foto' || r.tp === 'sticker') && r.archivo) cargarArchivo(r.archivo).then(ponerMini, function () { /* sin miniatura */ });
  }
  $('social-respuesta-cancelar').addEventListener('click', function () { cancelarRespuesta(true); });

  // La cita arriba de la burbuja: al tocarla, el chat va al mensaje original y lo resalta.
  function crearCita(c) {
    var bt = document.createElement('button');
    bt.type = 'button';
    bt.className = 'social-cita';
    var n = document.createElement('span');
    n.className = 'social-cita-nombre';
    n.textContent = nombreCita(c.n);
    var x = document.createElement('span');
    x.className = 'social-cita-texto';
    x.textContent = etiquetaCita(c);
    bt.appendChild(n);
    bt.appendChild(x);
    bt.setAttribute('aria-label', t('socialCitaDe', { n: nombreCita(c.n), x: etiquetaCita(c) }));
    bt.addEventListener('click', function () { irAMensaje(c.id); });
    return bt;
  }
  function irAMensaje(id) {
    var fila = lista.querySelector('.social-fila[data-id="' + Number(id) + '"]');
    if (!fila) { mostrarAviso(t('socialCitaNoEsta')); return; }
    var quieto = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var dif = fila.getBoundingClientRect().top - lista.getBoundingClientRect().top;
    var arriba = lista.scrollTop + dif - Math.max(0, (lista.clientHeight - fila.offsetHeight) / 2);
    lista.scrollTo({ top: Math.max(0, arriba), behavior: quieto ? 'auto' : 'smooth' });
    fila.classList.remove('resaltada');
    void fila.offsetWidth; // para que la animación vuelva a empezar
    fila.classList.add('resaltada');
    clearTimeout(fila._resalte);
    fila._resalte = setTimeout(function () { fila.classList.remove('resaltada'); }, 1800);
  }

  /* ---------- GIFs (Giphy, a través de nuestro servidor) ---------- */
  var ventanaGifs = $('social-gifs');
  var botonGif = $('social-gif');
  var buscadorGif = $('social-gifs-buscar');
  var listaGifs = $('social-gifs-lista');
  var gifsGuardados = {};     // búsqueda -> {ts, lista}
  var gifPedido = 0, gifEspera = null;
  var ES_LOCAL = /^(localhost|127\.0\.0\.1)$/.test(location.hostname);
  // Solo imágenes de Giphy (y, al probar en la computadora, los dibujos de prueba del servidor local).
  function gifPermitido(u) {
    u = String(u || '');
    return /^https:\/\/(?:media[0-9]?|i)\.giphy\.com\/media\/(?:v1\.[A-Za-z0-9_=-]+\/)?[A-Za-z0-9]+\/[A-Za-z0-9_.-]+$/.test(u)
      || (ES_LOCAL && /^data:image\/svg\+xml;base64,[A-Za-z0-9+/=]+$/.test(u));
  }
  function crearGif(g) {
    var c = document.createElement('div');
    c.className = 'social-medio gif';
    if (g.w && g.h) c.style.aspectRatio = g.w + ' / ' + g.h;
    if (!gifPermitido(g.u)) {
      var espera = document.createElement('span');
      espera.className = 'social-medio-espera';
      espera.textContent = '🎞️ ' + t('socialGifNombre');
      c.appendChild(espera);
      return c;
    }
    var img = document.createElement('img');
    img.alt = t('socialGifNombre');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.referrerPolicy = 'no-referrer';
    img.src = g.u;
    c.appendChild(img);
    return c;
  }
  function estadoGifs(texto) { $('social-gifs-estado').textContent = texto || ''; }
  function abrirGifs() {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    cerrarMenuAdjuntar(false);
    cerrarSelectorReaccion();
    cerrarMenuChat(false);
    cerrarStickers(false);
    ventanaGifs.hidden = false;
    botonGif.setAttribute('aria-expanded', 'true');
    buscadorGif.value = '';
    cargarGifs('');
    // En el teléfono no se abre el teclado enseguida: taparía los GIFs.
    if (esTactil) $('social-gifs-cerrar').focus(); else buscadorGif.focus();
    bajar(true);
  }
  function cerrarGifs(devolverFoco) {
    if (ventanaGifs.hidden) return;
    ventanaGifs.hidden = true;
    botonGif.setAttribute('aria-expanded', 'false');
    clearTimeout(gifEspera);
    gifPedido++;
    listaGifs.textContent = '';
    estadoGifs('');
    if (devolverFoco) botonGif.focus();
  }
  botonGif.addEventListener('click', function () { if (ventanaGifs.hidden) abrirGifs(); else cerrarGifs(true); });
  $('social-gifs-cerrar').addEventListener('click', function () { cerrarGifs(true); });
  buscadorGif.addEventListener('input', function () {
    clearTimeout(gifEspera);
    gifEspera = setTimeout(function () { cargarGifs(buscadorGif.value); }, 500);
  });
  buscadorGif.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    clearTimeout(gifEspera);
    cargarGifs(buscadorGif.value);
    if (esTactil) buscadorGif.blur(); // esconde el teclado para ver los resultados
  });
  function cargarGifs(q) {
    q = String(q || '').trim().toLowerCase().slice(0, 50);
    var clave = q ? idioma() + ':' + q : 'top';
    var guardado = gifsGuardados[clave];
    if (guardado && Date.now() - guardado.ts < 10 * 60 * 1000) { pintarGifs(guardado.lista, q); return; }
    var n = ++gifPedido;
    estadoGifs(t('socialGifCargando'));
    var datos = 'q=' + encodeURIComponent(q) + '&idioma=' + (idioma() === 'en' ? 'en' : 'es');
    fetch(SOCIAL_SERVIDOR + '/gifs?' + datos, {
      headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : '') },
      cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw (d && d.error) || 'gif_red';
        return d;
      });
    }).then(function (d) {
      if (n !== gifPedido) return;
      var l = (d.gifs || []).filter(function (g) { return g && g.id && gifPermitido(g.url) && gifPermitido(g.previa); });
      gifsGuardados[clave] = { ts: Date.now(), lista: l };
      pintarGifs(l, q);
    }).catch(function (e) {
      if (n !== gifPedido) return;
      listaGifs.textContent = '';
      estadoGifs(t(e === 'gif_limite' ? 'socialErrGifLimite' : e === 'sin_gifs' ? 'socialErrSinGifs' : e === 'gif_clave' ? 'socialErrGifClave'
        : e === 'sesion' ? 'socialErrSesion' : 'socialErrGifRed'));
    });
  }
  function pintarGifs(l, q) {
    listaGifs.textContent = '';
    listaGifs.scrollTop = 0;
    estadoGifs(l.length ? (q ? '' : t('socialGifPopulares')) : q ? t('socialGifNada', { q: q }) : t('socialErrGifRed'));
    l.forEach(function (g) {
      var bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'social-gif-item';
      bt.setAttribute('aria-label', t('socialGifEnviar') + (g.titulo ? ': ' + g.titulo : ''));
      var img = document.createElement('img');
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.referrerPolicy = 'no-referrer';
      img.src = g.previa;
      bt.appendChild(img);
      bt.addEventListener('click', function () { enviarGif(g); });
      listaGifs.appendChild(bt);
    });
  }
  // El servidor acepta un mensaje por segundo: si hace falta, se espera un poco antes de enviar.
  function enviarGif(g) {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    var sala = salaActual;
    var resp = respuestaPara(sala);
    cerrarGifs(false);
    cancelarRespuesta();
    var espera = Math.max(0, 1000 - (Date.now() - ultimoEnvio));
    ultimoEnvio = Date.now() + espera;
    var cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    var fila = ponerPendiente(cid, '', { gif: { u: g.url, w: g.ancho, h: g.alto }, cita: resp });
    bajar(false);
    botonGif.focus({ preventScroll: true });
    setTimeout(function () {
      if (!ws || ws.readyState !== 1) { delete pendientes[cid]; fila.remove(); mostrarAviso(t('socialErrRed')); return; }
      var datos = { t: 'msg', sala: sala, texto: '', gif: g.id, cid: cid };
      if (resp) datos.resp = resp.id;
      ws.send(JSON.stringify(datos));
    }, espera);
  }

  /* ---------- Stickers personales (solo los ve su dueño; duran mientras exista la cuenta) ---------- */
  var STICKER_LADO = 512, STICKER_MAX = 500 * 1024;
  var ventanaStickers = $('social-stickers');
  var botonSticker = $('social-sticker');
  var listaStickers = $('social-stickers-lista');
  var botonEditarStickers = $('social-stickers-editar');
  var entradaSticker = $('social-sticker-archivo');
  var misStickers = null;       // [{clave, ancho, alto}] o null si todavía no se cargaron
  var maxStickers = 60;
  var editandoStickers = false;
  var subiendoSticker = false;
  var stickersCargados = {};    // clave -> promesa de la dirección local (blob:)
  var pedidoStickers = 0;

  function estadoStickers(texto) { $('social-stickers-estado').textContent = texto || ''; }
  function cargarSticker(clave) {
    if (!stickersCargados[clave]) {
      stickersCargados[clave] = fetch(SOCIAL_SERVIDOR + '/sticker/' + clave, {
        headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : '') }, cache: 'no-store'
      }).then(function (r) { if (!r.ok) throw r.status; return r.blob(); })
        .then(function (b) { return URL.createObjectURL(b); });
      stickersCargados[clave].catch(function () { delete stickersCargados[clave]; });
    }
    return stickersCargados[clave];
  }
  function soltarStickers() {
    for (var c in stickersCargados) stickersCargados[c].then(function (u) { URL.revokeObjectURL(u); }, function () { /* nada */ });
    stickersCargados = {};
    misStickers = null;
  }
  function pedirStickers() {
    var n = ++pedidoStickers;
    if (!misStickers) estadoStickers(t('socialStickersCargando'));
    return fetch(SOCIAL_SERVIDOR + '/stickers', {
      headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : '') }, cache: 'no-store'
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw (d && d.error) || 'red'; return d; });
    }).then(function (d) {
      if (n !== pedidoStickers) return;
      misStickers = (d.stickers || []).filter(function (x) { return x && /^[a-f0-9]{40}$/.test(x.clave); });
      maxStickers = d.max || 60;
      pintarStickers();
    }).catch(function (e) {
      if (n !== pedidoStickers) return;
      estadoStickers(t(e === 'sesion' ? 'socialErrSesion' : 'socialErrStickers'));
    });
  }
  function abrirStickers() {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    cerrarMenuAdjuntar(false);
    cerrarSelectorReaccion();
    cerrarMenuChat(false);
    cerrarGifs(false);
    editandoStickers = false;
    ventanaStickers.hidden = false;
    botonSticker.setAttribute('aria-expanded', 'true');
    pintarStickers();
    pedirStickers();
    $('social-stickers-cerrar').focus();
    bajar(true);
  }
  function cerrarStickers(devolverFoco) {
    if (ventanaStickers.hidden) return;
    ventanaStickers.hidden = true;
    botonSticker.setAttribute('aria-expanded', 'false');
    editandoStickers = false;
    estadoStickers('');
    if (devolverFoco) botonSticker.focus();
  }
  botonSticker.addEventListener('click', function () { if (ventanaStickers.hidden) abrirStickers(); else cerrarStickers(true); });
  $('social-stickers-cerrar').addEventListener('click', function () { cerrarStickers(true); });
  botonEditarStickers.addEventListener('click', function () {
    editandoStickers = !editandoStickers;
    pintarStickers();
    estadoStickers(editandoStickers ? t('socialStickerEditando') : '');
  });

  function pintarStickers() {
    var lista = misStickers || [];
    var lleno = lista.length >= maxStickers;
    ventanaStickers.classList.toggle('editando', editandoStickers);
    botonEditarStickers.textContent = t(editandoStickers ? 'socialStickerListo' : 'socialStickerEditar');
    botonEditarStickers.setAttribute('aria-pressed', editandoStickers ? 'true' : 'false');
    botonEditarStickers.hidden = !lista.length && !editandoStickers;
    $('social-stickers-cuenta').textContent = misStickers ? t('socialStickerCuenta', { n: lista.length, max: maxStickers }) : '';
    listaStickers.textContent = '';
    // Primero el "+" (si no está editando)
    if (!editandoStickers) {
      var mas = document.createElement('button');
      mas.type = 'button';
      mas.className = 'social-sticker-mas';
      mas.setAttribute('aria-label', t('socialStickerAnadir'));
      mas.title = t('socialStickerAnadir');
      mas.disabled = subiendoSticker || !misStickers;
      mas.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/></svg>';
      mas.addEventListener('click', function () {
        if (lleno) { estadoStickers(t('socialErrStickerLleno')); return; }
        entradaSticker.value = '';
        entradaSticker.click();
      });
      listaStickers.appendChild(mas);
    }
    if (misStickers && !lista.length && !editandoStickers) estadoStickers(t('socialStickersVacio'));
    lista.forEach(function (st) {
      var celda = document.createElement('div');
      celda.className = 'social-sticker-celda';
      var bt = document.createElement('button');
      bt.type = 'button';
      bt.className = 'social-sticker-item';
      bt.setAttribute('aria-label', t('socialStickerEnviar'));
      bt.disabled = editandoStickers;
      var img = document.createElement('img');
      img.alt = '';
      bt.appendChild(img);
      cargarSticker(st.clave).then(function (u) { img.src = u; }, function () { celda.classList.add('error'); });
      bt.addEventListener('click', function () { if (!editandoStickers) enviarSticker(st); });
      celda.appendChild(bt);
      if (editandoStickers) {
        var x = document.createElement('button');
        x.type = 'button';
        x.className = 'social-sticker-quitar';
        x.setAttribute('aria-label', t('socialStickerQuitar'));
        x.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7l10 10M17 7L7 17" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/></svg>';
        x.addEventListener('click', function () { borrarSticker(st, x); });
        celda.appendChild(x);
      }
      listaStickers.appendChild(celda);
    });
  }

  function borrarSticker(st, boton) {
    boton.disabled = true;
    fetch(SOCIAL_SERVIDOR + '/sticker/' + st.clave, {
      method: 'DELETE', headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : '') }
    }).then(function (r) {
      if (!r.ok && r.status !== 404) throw r.status;
      misStickers = (misStickers || []).filter(function (x) { return x.clave !== st.clave; });
      if (stickersCargados[st.clave]) {
        stickersCargados[st.clave].then(function (u) { URL.revokeObjectURL(u); }, function () { /* nada */ });
        delete stickersCargados[st.clave];
      }
      if (!misStickers.length) editandoStickers = false;
      pintarStickers();
      estadoStickers(t('socialStickerBorrado'));
      var siguiente = listaStickers.querySelector('.social-sticker-quitar') || botonEditarStickers;
      if (!siguiente.hidden) siguiente.focus();
    }).catch(function () { boton.disabled = false; estadoStickers(t('socialErrRed')); });
  }

  // Reduce a 512 × 512 como máximo conservando la transparencia (WebP; si el navegador no sabe, PNG).
  // Un archivo que ya es pequeño se sube tal cual (así un GIF o WebP animado sigue animado).
  function tipoDe(archivo) {
    var t2 = String(archivo.type || '').toLowerCase();
    if (/^image\/(png|webp|gif)$/.test(t2)) return t2;
    var m = /\.(png|webp|gif)$/i.exec(archivo.name || '');
    return m ? 'image/' + m[1].toLowerCase() : '';
  }
  function prepararSticker(archivo) {
    return new Promise(function (ok, mal) {
      var tipo = tipoDe(archivo);
      if (!tipo) { mal('sticker_formato'); return; }
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onerror = function () { URL.revokeObjectURL(url); mal('sticker_formato'); };
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { mal('sticker_formato'); return; }
        if (w <= STICKER_LADO && h <= STICKER_LADO && archivo.size <= STICKER_MAX) { ok({ blob: archivo, mime: tipo }); return; }
        var pasos = [[STICKER_LADO, 0.9], [STICKER_LADO, 0.75], [420, 0.75], [360, 0.7], [300, 0.65], [256, 0.6]];
        (function probar(i) {
          if (i >= pasos.length) { mal('sticker_grande'); return; }
          var escala = Math.min(1, pasos[i][0] / Math.max(w, h));
          var lienzo = document.createElement('canvas');
          lienzo.width = Math.max(1, Math.round(w * escala));
          lienzo.height = Math.max(1, Math.round(h * escala));
          var ctx = lienzo.getContext('2d');
          ctx.clearRect(0, 0, lienzo.width, lienzo.height);
          ctx.imageSmoothingQuality = 'high';
          ctx.drawImage(img, 0, 0, lienzo.width, lienzo.height);
          lienzo.toBlob(function (b) {
            var tipoB = b && b.type;
            var listo = function (b2) {
              if (b2 && b2.size <= STICKER_MAX) ok({ blob: b2, mime: b2.type });
              else probar(i + 1);
            };
            if (b && tipoB === 'image/webp') listo(b);
            else lienzo.toBlob(listo, 'image/png'); // Safari antiguo no sabe hacer WebP
          }, 'image/webp', pasos[i][1]);
        })(0);
      };
      img.src = url;
    });
  }

  entradaSticker.addEventListener('change', function () {
    var archivo = entradaSticker.files && entradaSticker.files[0];
    entradaSticker.value = '';
    if (!archivo) return;
    subiendoSticker = true;
    pintarStickers();
    estadoStickers(t('socialStickerPreparando'));
    prepararSticker(archivo).then(function (res) {
      estadoStickers(t('socialStickerSubiendo'));
      return fetch(SOCIAL_SERVIDOR + '/sticker', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + (sesion ? sesion.token : ''), 'Content-Type': res.mime },
        body: res.blob
      }).then(function (r) {
        return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw (d && d.error) || 'red'; return d; });
      });
    }).then(function (d) {
      subiendoSticker = false;
      misStickers = [d.sticker].concat(misStickers || []);
      maxStickers = d.max || maxStickers;
      pintarStickers();
      estadoStickers(t('socialStickerAnadido'));
    }).catch(function (e) {
      subiendoSticker = false;
      pintarStickers();
      estadoStickers(t({
        sticker_formato: 'socialErrStickerFormato', tipo: 'socialErrStickerFormato', sticker_grande: 'socialErrStickerGrande',
        grande: 'socialErrStickerGrande', stickers_lleno: 'socialErrStickerLleno', sticker_lado: 'socialErrStickerLado',
        muchos: 'socialErrMuchos', sesion: 'socialErrSesion', sin_archivos: 'socialErrSinArchivos'
      }[e] || 'socialErrRed'));
    });
  });

  // Burbuja pendiente: el sticker se ve enseguida desde la copia que ya está en el teléfono.
  function crearStickerLocal(url, ancho, alto) {
    var c = document.createElement('div');
    c.className = 'social-medio sticker';
    if (ancho && alto) c.style.aspectRatio = ancho + ' / ' + alto;
    var img = document.createElement('img');
    img.alt = t('socialStickerNombre');
    img.src = url;
    c.appendChild(img);
    return c;
  }
  function enviarSticker(st) {
    if (!ws || ws.readyState !== 1) { mostrarAviso(t('socialErrRed')); return; }
    var sala = salaActual;
    var resp = respuestaPara(sala);
    cerrarStickers(false);
    cancelarRespuesta();
    var espera = Math.max(0, 1000 - (Date.now() - ultimoEnvio));
    ultimoEnvio = Date.now() + espera;
    var cid = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    cargarSticker(st.clave).then(function (url) {
      var fila = ponerPendiente(cid, '', { stickerLocal: url, ancho: st.ancho, alto: st.alto, cita: resp });
      bajar(false);
      setTimeout(function () {
        if (!ws || ws.readyState !== 1) { delete pendientes[cid]; fila.remove(); mostrarAviso(t('socialErrRed')); return; }
        var datos = { t: 'msg', sala: sala, texto: '', sticker: st.clave, cid: cid };
        if (resp) datos.resp = resp.id;
        ws.send(JSON.stringify(datos));
      }, espera);
    }, function () { mostrarAviso(t('socialErrSticker')); });
    botonSticker.focus({ preventScroll: true });
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
    $('social-gif').disabled = !conectado;
    $('social-sticker').disabled = !conectado;
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
    var resp = respuestaPara(salaActual);
    ponerPendiente(cid, texto, resp ? { cita: resp } : null);
    pendientes[cid].texto = texto;
    var datos = { t: 'msg', sala: salaActual, texto: texto, cid: cid };
    if (resp) datos.resp = resp.id;
    ws.send(JSON.stringify(datos));
    cancelarRespuesta();
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
    pintarRespuesta();
    if (!ventanaGifs.hidden) cargarGifs(buscadorGif.value);
    if (!ventanaStickers.hidden) pintarStickers();
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
