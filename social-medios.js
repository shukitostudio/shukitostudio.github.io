// Chat Social: fotos, videos y audios. Todo se reduce en el teléfono ANTES de subirlo. Lo usa social.js.
(function () {
  var FOTO_LADO = 1600;                 // lado más largo de una foto, en píxeles
  var FOTO_MAX = 1.5 * 1024 * 1024;
  var VIDEO_SEG = 15;
  var VIDEO_MAX = 7.5 * 1024 * 1024;
  // Intentos para el video: si el primero queda muy pesado, se vuelve a preparar más pequeño.
  var VIDEO_INTENTOS = [
    { lado: 640, bits: 1200000, audio: 64000 },
    { lado: 480, bits: 550000, audio: 48000 }
  ];
  var AUDIO_SEG = 60;
  var AUDIO_MAX = 1.8 * 1024 * 1024;

  // Se prefiere MP4 con H.264 (se ve en iPhone y en Android); si el navegador no sabe grabarlo, WebM.
  var TIPOS_VIDEO = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp8,opus', 'video/webm'];
  var TIPOS_AUDIO = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  var ACEPTADOS = { video: ['video/mp4', 'video/webm'], audio: ['audio/mp4', 'audio/webm', 'audio/ogg'] };
  // El iPhone a veces entrega los .mov / HEVC sin tipo: se reconocen por la extensión.
  var EXT_VIDEO = /\.(mov|mp4|m4v|hevc|3gp|3g2|webm|mkv|qt)$/i;
  var EXT_FOTO = /\.(jpe?g|png|gif|webp|heic|heif|avif|bmp)$/i;

  function base(tipo) { return String(tipo || '').split(';')[0].trim().toLowerCase(); }
  function puedeGrabar() { return typeof window.MediaRecorder === 'function'; }
  function puedePrepararVideo() {
    return puedeGrabar() && typeof document.createElement('canvas').captureStream === 'function';
  }
  function elegirTipo(lista) {
    if (!puedeGrabar()) return null;
    for (var i = 0; i < lista.length; i++) {
      try { if (MediaRecorder.isTypeSupported(lista[i])) return lista[i]; } catch (e) { /* sigue */ }
    }
    return '';
  }
  function aBlob(lienzo, tipo, calidad) {
    return new Promise(function (ok) { lienzo.toBlob(function (b) { ok(b); }, tipo, calidad); });
  }
  // "pista": lo que pedía el botón ('video' o 'foto'), por si el teléfono no dice el tipo del archivo.
  function clase(archivo, pista) {
    var tipo = base(archivo && archivo.type), nombre = (archivo && archivo.name) || '';
    if (/^video\//.test(tipo)) return 'video';
    if (/^image\//.test(tipo)) return 'foto';
    if (!tipo || tipo === 'application/octet-stream') {
      if (EXT_VIDEO.test(nombre)) return 'video';
      if (EXT_FOTO.test(nombre)) return 'foto';
      if (pista) return pista;
    }
    return '';
  }

  /* ---------- Fotos ---------- */
  function reducirFoto(archivo) {
    return new Promise(function (ok, mal) {
      if (clase(archivo) !== 'foto') { mal('formato'); return; }
      var url = URL.createObjectURL(archivo);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) { mal('formato'); return; }
        var esc = Math.min(1, FOTO_LADO / Math.max(w, h));
        var cw = Math.max(1, Math.round(w * esc)), ch = Math.max(1, Math.round(h * esc));
        var lienzo = document.createElement('canvas');
        lienzo.width = cw; lienzo.height = ch;
        var ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#fff'; // las fotos con fondo transparente quedan con fondo blanco
        ctx.fillRect(0, 0, cw, ch);
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, 0, 0, cw, ch);
        var calidad = 0.82;
        (function probar() {
          aBlob(lienzo, 'image/webp', calidad).then(function (b) {
            if (!b || b.type !== 'image/webp') return aBlob(lienzo, 'image/jpeg', calidad);
            return b;
          }).then(function (b) {
            if (!b) { mal('formato'); return; }
            if (b.size > FOTO_MAX && calidad > 0.4) { calidad -= 0.12; probar(); return; }
            if (b.size > FOTO_MAX) { mal('grande'); return; }
            ok({ blob: b, mime: base(b.type), ancho: cw, alto: ch, dur: 0 });
          });
        })();
      };
      img.onerror = function () { URL.revokeObjectURL(url); mal('formato'); };
      img.src = url;
    });
  }

  /* ---------- Videos ----------
     Paso 1 (abrirVideo): se abre el video del teléfono (también .mov y HEVC del iPhone) y se muestra.
     Paso 2 (convertirVideo): al tocar "Enviar" se vuelve a grabar en tiempo real, a 640 px, como máximo
     15 segundos, en MP4 H.264. Tiene que empezar DENTRO del toque: Safari solo deja reproducir con
     sonido después de un toque (y en modo de bajo consumo, nada sin un toque). */
  // Duración del video si ya se conoce; 0 si todavía no (Safari a veces no la da hasta reproducir).
  function duracionDe(v) { return isFinite(v.duration) && v.duration > 0 ? v.duration : 0; }

  // "contenedor": donde se muestra la vista previa. El video se pone en la página desde el principio:
  // en el iPhone, Safari a veces no lee nada de un video que no está en pantalla.
  function abrirVideo(archivo, contenedor, pista) {
    return new Promise(function (ok, mal) {
      if (clase(archivo, pista) !== 'video') { mal('formato'); return; }
      var url = URL.createObjectURL(archivo);
      var v = document.createElement('video');
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.setAttribute('webkit-playsinline', '');
      v.preload = 'metadata';
      v.controls = true;
      v.muted = false;
      if (contenedor) contenedor.appendChild(v);
      var listo = false;
      function soltar() {
        v.removeAttribute('src');
        try { v.load(); } catch (e) { /* nada */ }
        URL.revokeObjectURL(url);
        if (v.parentNode) v.parentNode.removeChild(v);
      }
      function terminar() {
        if (listo) return;
        listo = true;
        clearTimeout(espera);
        ok({ video: v, url: url, dur: duracionDe(v), soltar: soltar, original: archivo });
      }
      // Si en 4 segundos Safari no dio la información, se sigue igual: se lee al tocar "Enviar".
      var espera = setTimeout(terminar, 4000);
      v.onerror = function () {
        if (listo) return;
        listo = true;
        clearTimeout(espera);
        soltar();
        mal('abrir');
      };
      v.onloadedmetadata = function () {
        if (duracionDe(v)) terminar(); else setTimeout(terminar, 1500);
      };
      v.src = url;
      try { v.load(); } catch (e) { /* nada */ }
    });
  }

  // Devuelve una promesa con .cancelar(). Llamar SIN esperas dentro del toque en "Enviar".
  function convertirVideo(abierto, inicio, alProgreso) {
    var v = abierto.video;
    var cancelado = false, actual = null;
    var promesa = new Promise(function (ok, mal) {
      var mime = elegirTipo(TIPOS_VIDEO);
      var total = duracionDe(v) || abierto.dur || 0;   // 0: todavía no se sabe
      if (mime === null || !puedePrepararVideo()) {
        // Navegador sin grabador: se manda el original solo si ya es MP4 corto y liviano.
        var o = abierto.original;
        if (base(o.type) === 'video/mp4' && o.size <= VIDEO_MAX && total && total <= VIDEO_SEG + 0.5) {
          ok({ blob: o, mime: 'video/mp4', ancho: v.videoWidth, alto: v.videoHeight, dur: Math.max(1, Math.round(total)) });
        } else mal('sin_grabador');
        return;
      }
      inicio = total ? Math.max(0, Math.min(inicio || 0, Math.max(0, total - 0.5))) : 0;
      var limite = total ? Math.min(VIDEO_SEG, total - inicio) : VIDEO_SEG;

      // Sonido: pasa del video al grabador sin salir por el altavoz. Se crea ahora (dentro del toque).
      var sonido = null;
      if (!v._sonido) {
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          var ac = new Ctx();
          var fuente = ac.createMediaElementSource(v);
          var destino = ac.createMediaStreamDestination();
          fuente.connect(destino);
          v._sonido = { ac: ac, destino: destino };
        } catch (e) { v._sonido = { ac: null, destino: null }; }
      }
      sonido = v._sonido;
      if (sonido.ac && sonido.ac.state === 'suspended') { try { sonido.ac.resume(); } catch (e) { /* nada */ } }
      if (!sonido.destino) v.muted = true;

      v.controls = false;
      v.loop = false;
      // play() en el mismo toque: así Safari lo permite (con sonido y en modo de bajo consumo).
      var primerPlay = v.play();

      function intento(n) {
        var ajustes = VIDEO_INTENTOS[n];
        actual = grabarTrozo(v, sonido, mime, ajustes, inicio, limite, n === 0 ? primerPlay : null, function (p) {
          if (alProgreso) alProgreso(p, n);
        });
        actual.then(function (res) {
          if (cancelado) return;
          if (res.blob.size > VIDEO_MAX && n + 1 < VIDEO_INTENTOS.length) { intento(n + 1); return; }
          if (res.blob.size > VIDEO_MAX) { mal('grande'); return; }
          res.cortado = (duracionDe(v) || total) > VIDEO_SEG + 0.5;
          ok(res);
        }, function (motivo) { if (!cancelado) mal(motivo); });
      }
      intento(0);
    });
    promesa.cancelar = function () {
      cancelado = true;
      if (actual && actual.cancelar) actual.cancelar();
    };
    return promesa;
  }

  function grabarTrozo(v, sonido, mime, ajustes, inicio, limite, yaReproduciendo, alProgreso) {
    var rec = null, terminado = false, cancelar = null;
    var p = new Promise(function (ok, mal) {
      // El lienzo y el grabador se arman cuando el video ya se reproduce: recién ahí Safari da su tamaño.
      var cw = 0, ch = 0, ctx = null;
      var trozos = [];
      var opciones = { videoBitsPerSecond: ajustes.bits, audioBitsPerSecond: ajustes.audio };
      if (mime) opciones.mimeType = mime;
      var vigia = null, ultimoTiempo = -1, quieto = 0, esperaTam = null;
      function armar() {
        var w = v.videoWidth, h = v.videoHeight;
        var esc = Math.min(1, ajustes.lado / Math.max(w, h));
        cw = Math.max(2, Math.round(w * esc / 2) * 2); ch = Math.max(2, Math.round(h * esc / 2) * 2);
        var lienzo = document.createElement('canvas');
        lienzo.width = cw; lienzo.height = ch;
        ctx = lienzo.getContext('2d');
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, cw, ch);
        var flujo = lienzo.captureStream(30);
        if (sonido && sonido.destino) sonido.destino.stream.getAudioTracks().forEach(function (pista) { flujo.addTrack(pista); });
        try { rec = new MediaRecorder(flujo, opciones); } catch (e) {
          try { delete opciones.mimeType; rec = new MediaRecorder(flujo, opciones); } catch (e2) { return false; }
        }
        rec.ondataavailable = function (e) { if (e.data && e.data.size) trozos.push(e.data); };
        rec.onerror = function () { salir('sin_grabador'); };
        rec.onstop = alParar;
        return true;
      }

      function salir(motivo, res) {
        if (terminado) return;
        terminado = true;
        clearInterval(vigia);
        clearTimeout(esperaTam);
        document.removeEventListener('visibilitychange', alOcultar);
        v.removeEventListener('ended', parar);
        try { v.pause(); } catch (e) { /* nada */ }
        if (motivo) {
          try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* nada */ }
          mal(motivo);
        } else ok(res);
      }
      cancelar = function () { salir('cancelado'); };
      function alOcultar() { if (document.visibilityState === 'hidden') salir('interrumpido'); }
      document.addEventListener('visibilitychange', alOcultar);

      function alParar() {
        if (terminado) return;
        var tipo = base(rec.mimeType || mime || 'video/webm');
        var dur = Math.max(1, Math.round(Math.min(limite, (v.currentTime || 0) - inicio)));
        if (ACEPTADOS.video.indexOf(tipo) < 0) { salir('formato'); return; }
        var blob = new Blob(trozos, { type: tipo });
        if (!blob.size) { salir('formato'); return; }
        salir(null, { blob: blob, mime: tipo, ancho: cw, alto: ch, dur: dur });
      }
      function parar() {
        if (rec && rec.state === 'recording') { try { v.pause(); } catch (e) { /* nada */ } rec.stop(); }
      }
      var pedir = typeof v.requestVideoFrameCallback === 'function'
        ? function (f) { v.requestVideoFrameCallback(f); }
        : function (f) { requestAnimationFrame(f); };
      function dibujar() {
        if (terminado || !rec || rec.state !== 'recording') return;
        ctx.drawImage(v, 0, 0, cw, ch);
        var avance = (v.currentTime - inicio) / limite;
        if (alProgreso) alProgreso(Math.max(0, Math.min(1, avance)));
        if (v.currentTime >= inicio + limite - 0.02 || v.ended) { parar(); return; }
        pedir(dibujar);
      }
      function empezar() {
        if (terminado) return;
        if (!v.videoWidth || !v.videoHeight) {
          // Todavía sin imagen: se espera un poco (máximo 5 segundos) antes de avisar.
          if (!esperaTam) {
            var alTener = function () { v.removeEventListener('loadeddata', alTener); v.removeEventListener('resize', alTener); empezar(); };
            v.addEventListener('loadeddata', alTener);
            v.addEventListener('resize', alTener);
            esperaTam = setTimeout(function () { if (!v.videoWidth) salir('abrir'); }, 5000);
          }
          return;
        }
        clearTimeout(esperaTam);
        if (rec) return; // ya empezó
        // Ahora sí se sabe cuánto dura: el trozo no pasa del final ni de 15 segundos.
        var total = duracionDe(v);
        if (total) limite = Math.max(0.5, Math.min(limite, total - inicio));
        if (!armar()) { salir('sin_grabador'); return; }
        // Sin "timeslice": Safari arma mejor el MP4 si lo entrega entero al final.
        try { rec.start(); } catch (e) { salir('sin_grabador'); return; }
        ctx.drawImage(v, 0, 0, cw, ch);
        pedir(dibujar);
        v.addEventListener('ended', parar);
        // Si el video deja de avanzar (por ejemplo, el teléfono lo pausó), se avisa en vez de quedarse colgado.
        vigia = setInterval(function () {
          if (v.currentTime >= inicio + limite - 0.05) { parar(); return; }
          if (v.currentTime === ultimoTiempo) { quieto++; if (quieto >= 8) salir('atascado'); }
          else { quieto = 0; ultimoTiempo = v.currentTime; }
          if (v.paused && !v.ended && !terminado) { var r = v.play(); if (r && r.catch) r.catch(function () { /* el vigía avisa */ }); }
        }, 1000);
      }
      function reproducir(promesa) {
        // Si el teléfono no empieza a reproducir en 12 segundos, se avisa en vez de quedarse esperando.
        var arranque = setTimeout(function () { if (!rec) salir('reproducir'); }, 12000);
        Promise.resolve(promesa).then(function () { clearTimeout(arranque); empezar(); }, function (e) {
          clearTimeout(arranque);
          // Sin permiso para el sonido: se intenta sin sonido.
          if (e && e.name === 'NotAllowedError' && !v.muted) {
            v.muted = true;
            v.play().then(empezar, function () { salir('reproducir'); });
          } else salir('reproducir');
        });
      }
      if (yaReproduciendo) {
        // Primer intento: play() ya se llamó dentro del toque. Se vuelve al inicio del trozo si hace falta.
        if (Math.abs(v.currentTime - inicio) > 0.3) v.currentTime = inicio;
        reproducir(yaReproduciendo);
      } else {
        // Otro intento: el video ya se reprodujo con un toque, así que se puede volver a reproducir.
        try { v.pause(); } catch (e) { /* nada */ }
        var listo = function () { v.removeEventListener('seeked', listo); reproducir(v.play()); };
        v.addEventListener('seeked', listo);
        v.currentTime = inicio;
      }
    });
    p.cancelar = function () { if (cancelar) cancelar(); };
    return p;
  }

  /* ---------- Audios: se graban con el micrófono, como máximo 1 minuto ---------- */
  function crearGrabadora(alTick, alLimite) {
    var rec = null, flujo = null, trozos = [], inicio = 0, reloj = null, mime = '';
    function apagar() {
      clearInterval(reloj);
      if (flujo) flujo.getTracks().forEach(function (p) { p.stop(); });
      flujo = null;
    }
    return {
      iniciar: function () {
        if (!puedeGrabar() || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return Promise.reject('sin_grabador');
        return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }).then(function (s) {
          flujo = s;
          mime = elegirTipo(TIPOS_AUDIO) || '';
          var opciones = { audioBitsPerSecond: 32000 };
          if (mime) opciones.mimeType = mime;
          rec = new MediaRecorder(s, opciones);
          trozos = [];
          rec.ondataavailable = function (e) { if (e.data && e.data.size) trozos.push(e.data); };
          rec.start(500);
          inicio = Date.now();
          reloj = setInterval(function () {
            var seg = (Date.now() - inicio) / 1000;
            if (alTick) alTick(seg);
            if (seg >= AUDIO_SEG && alLimite) alLimite();
          }, 250);
        }, function (e) {
          apagar();
          throw (e && e.name === 'NotAllowedError') ? 'permiso' : 'sin_grabador';
        });
      },
      detener: function () {
        return new Promise(function (ok, mal) {
          if (!rec || rec.state === 'inactive') { apagar(); mal('vacio'); return; }
          clearInterval(reloj);
          var dur = Math.max(1, Math.min(AUDIO_SEG, Math.round((Date.now() - inicio) / 1000)));
          rec.onstop = function () {
            apagar();
            var tipo = base(rec.mimeType || mime || 'audio/webm');
            if (ACEPTADOS.audio.indexOf(tipo) < 0) { mal('formato'); return; }
            var blob = new Blob(trozos, { type: tipo });
            if (!blob.size) { mal('vacio'); return; }
            if (blob.size > AUDIO_MAX) { mal('grande'); return; }
            ok({ blob: blob, mime: tipo, dur: dur, ancho: 0, alto: 0 });
          };
          rec.stop();
        });
      },
      cancelar: function () {
        try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* nada */ }
        apagar();
      }
    };
  }

  window.socialMedios = {
    clase: clase,
    reducirFoto: reducirFoto,
    abrirVideo: abrirVideo,
    convertirVideo: convertirVideo,
    crearGrabadora: crearGrabadora,
    puedeGrabar: puedeGrabar,
    VIDEO_SEG: VIDEO_SEG,
    AUDIO_SEG: AUDIO_SEG
  };
})();
