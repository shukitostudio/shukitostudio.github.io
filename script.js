(function () {
  var root = document.documentElement;
  var guardado = function (clave) {
    try { return localStorage.getItem(clave); } catch (e) { return null; }
  };
  var guardar = function (clave, valor) {
    try { localStorage.setItem(clave, valor); } catch (e) { /* sin almacenamiento: no pasa nada */ }
  };

  /* ---------- Modo día / noche ---------- */
  var temaGuardado = guardado('shukito-tema');
  var pref = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var tema = temaGuardado === 'dia' || temaGuardado === 'noche'
    ? temaGuardado
    : (pref && pref.matches ? 'dia' : 'noche');

  var idioma = guardado('shukito-idioma');
  if (idioma !== 'es' && idioma !== 'en') {
    idioma = (navigator.language || 'es').toLowerCase().indexOf('es') === 0 ? 'es' : 'en';
  }

  function t(clave) { return (TEXTOS[idioma] && TEXTOS[idioma][clave]) || ''; }

  function aplicarTema() {
    root.setAttribute('data-tema', tema);
    var boton = document.getElementById('btn-tema');
    if (boton) {
      boton.querySelector('[data-tema-etiqueta]').textContent = tema === 'noche' ? t('pieModoDia') : t('pieModoNoche');
      boton.setAttribute('aria-pressed', tema === 'dia' ? 'true' : 'false');
      boton.querySelector('.ico-sol').hidden = tema === 'dia';
      boton.querySelector('.ico-luna').hidden = tema === 'noche';
    }
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', tema === 'dia' ? '#7ec0e8' : '#14193a');
  }

  /* ---------- Idioma ---------- */
  function aplicarIdioma() {
    root.setAttribute('lang', idioma);
    var nodos = document.querySelectorAll('[data-i]');
    for (var i = 0; i < nodos.length; i++) nodos[i].textContent = t(nodos[i].getAttribute('data-i'));
    var alts = document.querySelectorAll('[data-alt]');
    for (var j = 0; j < alts.length; j++) alts[j].setAttribute('alt', t(alts[j].getAttribute('data-alt')));
    var caps = document.querySelectorAll('img[data-captura]');
    for (var k = 0; k < caps.length; k++) {
      caps[k].src = 'assets/captura' + caps[k].getAttribute('data-captura') + '-' + idioma + '.webp';
    }
    document.title = t('metaTitulo');
    var d = document.querySelector('meta[name="description"]');
    if (d) d.setAttribute('content', t('metaDescripcion'));
    var botones = document.querySelectorAll('[data-lang]');
    for (var m = 0; m < botones.length; m++) {
      botones[m].setAttribute('aria-pressed', botones[m].getAttribute('data-lang') === idioma ? 'true' : 'false');
    }
    aplicarTema();
  }

  document.getElementById('btn-tema').addEventListener('click', function () {
    tema = tema === 'noche' ? 'dia' : 'noche';
    guardar('shukito-tema', tema);
    aplicarTema();
  });

  var selector = document.querySelectorAll('[data-lang]');
  for (var n = 0; n < selector.length; n++) {
    selector[n].addEventListener('click', function () {
      idioma = this.getAttribute('data-lang');
      guardar('shukito-idioma', idioma);
      aplicarIdioma();
    });
  }

  // Si no hay elección guardada, seguir los cambios del teléfono.
  if (pref && pref.addEventListener) {
    pref.addEventListener('change', function (e) {
      if (!guardado('shukito-tema')) { tema = e.matches ? 'dia' : 'noche'; aplicarTema(); }
    });
  }

  // Logo: si no existe logo.png se muestra el texto "Shukito Studio".
  var logo = document.getElementById('logo-img');
  var cartel = document.querySelector('.cartel-logo');
  if (logo) {
    logo.addEventListener('load', function () { cartel.classList.add('con-logo'); });
    logo.addEventListener('error', function () { logo.remove(); });
    logo.src = 'assets/logo.webp';
  }

  aplicarIdioma();
})();
