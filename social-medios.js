// Chat Social: fotos, videos y audios. Todo se reduce en el teléfono ANTES de subirlo. Lo usa social.js.
(function () {
  var FOTO_LADO = 1600;                 // lado más largo de una foto, en píxeles
  var FOTO_MAX = 1.5 * 1024 * 1024;
  var VIDEO_LADO = 640;                 // lado más largo de un video
  var VIDEO_SEG = 15;
  var VIDEO_MAX = 7.5 * 1024 * 1024;
  var AUDIO_SEG = 60;
  var AUDIO_MAX = 1.8 * 1024 * 1024;

  // Se prefiere MP4 (se ve en iPhone y en Android); si el navegador no sabe grabarlo, WebM.
  var TIPOS_VIDEO = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4',
    'video/webm;codecs=vp8,opus', 'video/webm'];
  var TIPOS_AUDIO = ['audio/mp4;codecs=mp4a.40.2', 'audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
  var ACEPTADOS = { video: ['video/mp4', 'video/webm'], audio: ['audio/mp4', 'audio/webm', 'audio/ogg'] };

  function base(tipo) { return String(tipo || '').split(';')[0].trim().toLowerCase(); }
  function puedeGrabar() { return typeof window.MediaRecorder === 'function'; }
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

  /* ---------- Fotos ---------- */
  function reducirFoto(archivo) {
    return new Promise(function (ok, mal) {
      if (!/^image\//.test(archivo.type || '')) { mal('formato'); return; }
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

  /* ---------- Videos: se vuelven a grabar a 640 px y como máximo 15 segundos ---------- */
  function reducirVideo(archivo, alProgreso) {
    return new Promise(function (ok, mal) {
      var mime = elegirTipo(TIPOS_VIDEO);
      var lienzoPrueba = document.createElement('canvas');
      if (mime === null || typeof lienzoPrueba.captureStream !== 'function') { mal('sin_grabador'); return; }
      var url = URL.createObjectURL(archivo);
      var v = document.createElement('video');
      v.playsInline = true;
      v.setAttribute('playsinline', '');
      v.preload = 'auto';
      // Fuera de la pantalla: algunos navegadores solo reproducen videos que están en la página.
      v.style.cssText = 'position:fixed;left:-9999px;top:0;width:2px;height:2px;opacity:0;pointer-events:none';
      document.body.appendChild(v);
      var rec = null, ac = null, terminado = false, seguridad = null;

      function limpiar() {
        clearTimeout(seguridad);
        try { v.pause(); } catch (e) { /* nada */ }
        v.removeAttribute('src');
        try { v.load(); } catch (e) { /* nada */ }
        v.remove();
        URL.revokeObjectURL(url);
        if (ac) { try { ac.close(); } catch (e) { /* nada */ } }
      }
      function fallar(motivo) {
        if (terminado) return;
        terminado = true;
        try { if (rec && rec.state !== 'inactive') { rec.onstop = null; rec.stop(); } } catch (e) { /* nada */ }
        limpiar();
        mal(motivo);
      }

      v.onerror = function () { fallar('formato'); };
      v.onloadedmetadata = function () {
        var total = isFinite(v.duration) && v.duration > 0 ? v.duration : VIDEO_SEG;
        var limite = Math.min(total, VIDEO_SEG);
        var w = v.videoWidth, h = v.videoHeight;
        if (!w || !h) { fallar('formato'); return; }
        var esc = Math.min(1, VIDEO_LADO / Math.max(w, h));
        var cw = Math.max(2, Math.round(w * esc / 2) * 2), ch = Math.max(2, Math.round(h * esc / 2) * 2);
        var lienzo = document.createElement('canvas');
        lienzo.width = cw; lienzo.height = ch;
        var ctx = lienzo.getContext('2d');
        var flujo = lienzo.captureStream(30);
        // El sonido del video pasa por el grabador sin salir por el altavoz.
        try {
          var Ctx = window.AudioContext || window.webkitAudioContext;
          ac = new Ctx();
          var fuente = ac.createMediaElementSource(v);
          var destino = ac.createMediaStreamDestination();
          fuente.connect(destino);
          destino.stream.getAudioTracks().forEach(function (pista) { flujo.addTrack(pista); });
          if (ac.state === 'suspended') ac.resume();
        } catch (e) { ac = null; v.muted = true; }

        var trozos = [];
        var opciones = { videoBitsPerSecond: 1000000, audioBitsPerSecond: 64000 };
        if (mime) opciones.mimeType = mime;
        try { rec = new MediaRecorder(flujo, opciones); } catch (e) { fallar('sin_grabador'); return; }
        rec.ondataavailable = function (e) { if (e.data && e.data.size) trozos.push(e.data); };
        rec.onstop = function () {
          if (terminado) return;
          terminado = true;
          var tipo = base(rec.mimeType || mime || 'video/webm');
          var dur = Math.max(1, Math.round(Math.min(v.currentTime || limite, limite)));
          limpiar();
          if (ACEPTADOS.video.indexOf(tipo) < 0) { mal('formato'); return; }
          var blob = new Blob(trozos, { type: tipo });
          if (!blob.size) { mal('formato'); return; }
          if (blob.size > VIDEO_MAX) { mal('grande'); return; }
          ok({ blob: blob, mime: tipo, ancho: cw, alto: ch, dur: dur, cortado: total > VIDEO_SEG + 0.5 });
        };
        function parar() {
          if (rec && rec.state !== 'inactive') { try { v.pause(); } catch (e) { /* nada */ } rec.stop(); }
        }
        var pedir = typeof v.requestVideoFrameCallback === 'function'
          ? function (f) { v.requestVideoFrameCallback(f); }
          : function (f) { requestAnimationFrame(f); };
        function dibujar() {
          if (terminado || !rec || rec.state === 'inactive') return;
          ctx.drawImage(v, 0, 0, cw, ch);
          if (alProgreso) alProgreso(Math.min(1, v.currentTime / limite));
          if (v.currentTime >= limite || v.ended) { parar(); return; }
          pedir(dibujar);
        }
        v.onended = parar;
        v.ontimeupdate = function () { if (v.currentTime >= limite) parar(); };
        rec.start(500);
        var p = v.play();
        if (p && p.catch) {
          p.catch(function () {
            // Sin permiso para reproducir con sonido: se intenta sin sonido.
            v.muted = true;
            v.play().catch(function () { fallar('reproducir'); });
          });
        }
        pedir(dibujar);
        seguridad = setTimeout(parar, (limite + 20) * 1000);
      };
      v.src = url;
    });
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
    reducirFoto: reducirFoto,
    reducirVideo: reducirVideo,
    crearGrabadora: crearGrabadora,
    puedeGrabar: puedeGrabar,
    VIDEO_SEG: VIDEO_SEG,
    AUDIO_SEG: AUDIO_SEG
  };
})();
