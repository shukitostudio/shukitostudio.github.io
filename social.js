// Chat Social de Shukito Studio (solo para invitados).
// Para APAGAR el botón en la página: deja SOCIAL_SERVIDOR vacío así: var SOCIAL_SERVIDOR = '';
(function () {
  var SOCIAL_SERVIDOR = 'https://shukito-social.shukitostudio.workers.dev';

  // Al probar en la computadora (localhost) se usa el servidor de prueba local.
  if (/^(localhost|127\.0\.0\.1)$/.test(location.hostname)) SOCIAL_SERVIDOR = 'http://127.0.0.1:8787';

  var CLAVE_LOCAL = 'shukito-social';
  var CLAVE_NOMBRE = 'shukito-social-nombre'; // último nombre usado (para la pestaña "Ya tengo usuario")
  var MAX_LARGO = 500;
  var MAX_ESTADO = 60;
  var MAX_AVATAR = 40000;
  var LADO_FOTO = 128;

  // Avatares dibujados: un animal y un color de fondo. Se guardan como "e:0" ... "e:11".
  var AVATARES = [
    ['🐵', '#c9822f'], ['🦊', '#e0662c'], ['🐔', '#d6a419'], ['🐱', '#8a6bd1'],
    ['🐶', '#3f8fd6'], ['🐼', '#4d5866'], ['🐸', '#3aa35b'], ['🐯', '#e08a1e'],
    ['🦁', '#b8722c'], ['🐨', '#7c8da3'], ['🐰', '#d46a9a'], ['🐧', '#2f6f8f']
  ];
  var FOTO_VALIDA = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

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

  boton.hidden = false;

  var sesion = leerSesion();
  var ws = null, reintento = 0, temporizador = null, latido = null;
  var mensajes = [];          // {id, nombre, texto, ts}
  var pendientes = {};        // cid -> nodo de la burbuja
  var usuarios = [];          // {n, leido, enLinea}
  var perfiles = {};          // nombre en minúsculas -> {n, avatar, estado}
  var escribiendo = {};       // nombre -> hora límite
  var horas = 24;
  var abierto = false;
  var ultimoAvisoEscribe = 0;
  var ultimoEnvio = 0;
  var modo = 'nuevo';         // 'nuevo' (crear usuario) o 'entrar' (ya tengo usuario)
  var avatarElegido = 'e:0';  // en el registro
  var avatarNuevo = null;     // en la ventana de cambiar avatar

  /* ---------- Avatares ---------- */
  // Dibuja un avatar dentro de "el". Las fotos solo se aceptan como imagen (data:image/webp o jpeg).
  function pintarAvatar(el, avatar, nombre) {
    el.textContent = '';
    el.style.background = '';
    el.classList.remove('es-foto');
    var m = /^e:(\d+)$/.exec(avatar || '');
    if (m && AVATARES[+m[1]]) {
      el.style.background = AVATARES[+m[1]][1];
      el.textContent = AVATARES[+m[1]][0];
    } else if (avatar && FOTO_VALIDA.test(avatar)) {
      var img = document.createElement('img');
      img.alt = '';
      img.src = avatar;
      el.appendChild(img);
      el.classList.add('es-foto');
    } else {
      el.style.background = '#6b7280';
      el.textContent = (nombre || '?').charAt(0).toUpperCase();
    }
  }

  // Cuadrícula de avatares + botón "Foto". alElegir(avatar) se llama con "e:N" o con la foto ya reducida.
  function crearSelector(contenedor, alElegir, errorEl) {
    contenedor.textContent = '';
    contenedor.setAttribute('role', 'radiogroup');
    var opciones = [];
    function marcar(op) {
      for (var i = 0; i < opciones.length; i++) {
        var si = opciones[i] === op;
        opciones[i].setAttribute('aria-checked', si ? 'true' : 'false');
        opciones[i].tabIndex = si ? 0 : -1;
      }
    }
    AVATARES.forEach(function (a, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'social-opcion';
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-label', t('socialAvatarN', { n: i + 1 }));
      var s = document.createElement('span');
      s.className = 'social-avatar';
      s.setAttribute('aria-hidden', 'true');
      pintarAvatar(s, 'e:' + i);
      b.appendChild(s);
      b.addEventListener('click', function () { marcar(b); alElegir('e:' + i); });
      contenedor.appendChild(b);
      opciones.push(b);
    });
    // Foto propia
    var entrada = document.createElement('input');
    entrada.type = 'file';
    entrada.accept = 'image/*';
    entrada.hidden = true;
    var bf = document.createElement('button');
    bf.type = 'button';
    bf.className = 'social-opcion foto';
    bf.setAttribute('role', 'radio');
    bf.setAttribute('aria-label', t('socialFoto'));
    var sf = document.createElement('span');
    sf.className = 'social-avatar';
    sf.setAttribute('aria-hidden', 'true');
    sf.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    bf.appendChild(sf);
    var etiqueta = document.createElement('span');
    etiqueta.className = 'social-opcion-texto';
    etiqueta.textContent = t('socialFoto');
    bf.appendChild(etiqueta);
    bf.addEventListener('click', function () { entrada.click(); });
    entrada.addEventListener('change', function () {
      var archivo = entrada.files && entrada.files[0];
      entrada.value = '';
      if (!archivo) return;
      if (errorEl) errorEl.textContent = '';
      reducirFoto(archivo).then(function (datos) {
        pintarAvatar(sf, datos);
        marcar(bf);
        alElegir(datos);
      }).catch(function () {
        if (errorEl) errorEl.textContent = t('socialErrFoto');
      });
    });
    contenedor.appendChild(bf);
    contenedor.appendChild(entrada);
    // Flechas para moverse entre opciones (como un grupo de radio).
    contenedor.addEventListener('keydown', function (e) {
      var i = opciones.concat([bf]).indexOf(document.activeElement);
      if (i < 0) return;
      var todos = opciones.concat([bf]);
      var paso = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!paso) return;
      e.preventDefault();
      var sig = todos[(i + paso + todos.length) % todos.length];
      sig.focus();
      if (sig !== bf) sig.click();
    });
    return {
      elegir: function (avatar) {
        var m = /^e:(\d+)$/.exec(avatar || '');
        if (m && opciones[+m[1]]) { marcar(opciones[+m[1]]); return; }
        if (avatar && FOTO_VALIDA.test(avatar)) { pintarAvatar(sf, avatar); marcar(bf); return; }
        marcar(opciones[0]);
      },
      etiquetas: function () {
        for (var i = 0; i < opciones.length; i++) opciones[i].setAttribute('aria-label', t('socialAvatarN', { n: i + 1 }));
        bf.setAttribute('aria-label', t('socialFoto'));
        etiqueta.textContent = t('socialFoto');
      }
    };
  }

  // Recorta la foto en cuadrado y la reduce a 128 px (WebP, o JPEG si el navegador no sabe hacer WebP).
  function reducirFoto(archivo) {
    return new Promise(function (ok, mal) {
      if (!/^image\//.test(archivo.type || 'image/')) { mal(); return; }
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var lado = Math.min(img.naturalWidth, img.naturalHeight);
        if (!lado) { mal(); return; }
        var lienzo = document.createElement('canvas');
        lienzo.width = lienzo.height = LADO_FOTO;
        var ctx = lienzo.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (img.naturalWidth - lado) / 2, (img.naturalHeight - lado) / 2, lado, lado, 0, 0, LADO_FOTO, LADO_FOTO);
        var calidad = 0.82, datos;
        do {
          datos = lienzo.toDataURL('image/webp', calidad);
          if (datos.indexOf('data:image/webp') !== 0) datos = lienzo.toDataURL('image/jpeg', calidad);
          calidad -= 0.12;
        } while (datos.length > MAX_AVATAR && calidad > 0.3);
        if (datos.length > MAX_AVATAR || !FOTO_VALIDA.test(datos)) { mal(); return; }
        ok(datos);
      };
      img.onerror = function () { URL.revokeObjectURL(url); mal(); };
      img.src = url;
    });
  }

  var selectorRegistro = crearSelector($('social-avatares'), function (a) { avatarElegido = a; }, $('social-error'));
  selectorRegistro.elegir(avatarElegido);
  var selectorCambiar = crearSelector($('social-avatares-cambiar'), function (a) { avatarNuevo = a; }, $('social-ventana-error'));

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
    cerrarMenu(false);
    cerrarVentanaAvatar();
    cancelarEstado();
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
    if (!priv.hidden) cerrarPrivacidad();
    else if (!ventanaAvatar.hidden) cerrarVentanaAvatar();
    else if (!menu.hidden) cerrarMenu(true);
    else if (!$('social-estado-form').hidden) cancelarEstado();
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
    estadoTxt.textContent = t('socialConectando');
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
    cancelarEstado();
    mensajes = []; usuarios = []; pendientes = {}; perfiles = {};
    lista.textContent = '';
    $('social-usuarios').textContent = '';
    if (abierto) mostrarEntrar(error);
  }

  /* ---------- Barra de perfil ---------- */
  function miPerfil() {
    return (sesion && perfiles[sesion.nombre.toLowerCase()]) || { n: sesion ? sesion.nombre : '', avatar: '', estado: '' };
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
      perfiles[sesion.nombre.toLowerCase()] = { n: p.n, avatar: p.avatar, estado: nuevo };
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
      perfiles[sesion.nombre.toLowerCase()] = { n: p.n, avatar: avatarNuevo, estado: p.estado };
      pintarPerfil();
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
  function ponerPerfil(p) {
    if (!p || !p.n) return;
    perfiles[p.n.toLowerCase()] = { n: p.n, avatar: p.avatar, estado: p.estado || '' };
  }

  function recibir(m) {
    if (m.t === 'hola') {
      reintento = 0;
      horas = m.horas || 24;
      sesion.nombre = m.yo;
      perfiles = {};
      (m.perfiles || []).forEach(ponerPerfil);
      pintarPerfil();
      mensajes = m.mensajes || [];
      pendientes = {};
      pintarTodo();
      botonEnviar.disabled = !caja.value.trim();
      clearInterval(latido);
      latido = setInterval(function () { if (ws && ws.readyState === 1) ws.send('ping'); }, 25000);
      marcarLeido();
    } else if (m.t === 'sesion_invalida') {
      terminarSesion(t(m.motivo === 'cuenta_borrada' ? 'socialCuentaBorrada' : 'socialErrSesion'));
    } else if (m.t === 'estado') {
      usuarios = m.usuarios || [];
      pintarUsuarios();
      actualizarMarcas();
    } else if (m.t === 'perfil') {
      ponerPerfil(m.p);
      if (sesion && m.p && m.p.n.toLowerCase() === sesion.nombre.toLowerCase()) pintarPerfil();
    } else if (m.t === 'perfil_borrado') {
      if (m.n) delete perfiles[m.n.toLowerCase()];
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
      mostrarAviso(m.e === 'rapido' ? t('socialErrRapido') : m.e === 'largo' ? t('socialErrLargo')
        : m.e === 'estado_largo' ? t('socialErrEstado') : m.e === 'avatar' ? t('socialErrFoto') : '');
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
    selectorRegistro.etiquetas();
    selectorCambiar.etiquetas();
    var etiqueta = $('social-boton-entrar').firstElementChild;
    if (!$('social-boton-entrar').disabled) etiqueta.textContent = t(modo === 'nuevo' ? 'socialCrear' : 'socialEntrar');
    if (!abierto) return;
    if (sesion && !chat.hidden) pintarPerfil();
    if (sesion && !chat.hidden && ws && ws.readyState === 1) { pintarTodo(); pintarUsuarios(); pintarEscribiendo(); }
    else if (!chat.hidden) estadoTxt.textContent = t('socialConectando');
  });

  // Abrir directo con la dirección .../#social
  if (location.hash === '#social') { history.replaceState(null, '', location.pathname + location.search); abrir(); }
})();
