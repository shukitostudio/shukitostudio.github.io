// Chat Social: avatares (animales dibujados o foto propia). Lo usa social.js.
(function () {
  var MAX_AVATAR = 40000;
  var LADO_FOTO = 128;

  // Avatares dibujados: un animal y un color de fondo. Se guardan como "e:0" ... "e:11".
  var AVATARES = [
    ['🐵', '#c9822f'], ['🦊', '#e0662c'], ['🐔', '#d6a419'], ['🐱', '#8a6bd1'],
    ['🐶', '#3f8fd6'], ['🐼', '#4d5866'], ['🐸', '#3aa35b'], ['🐯', '#e08a1e'],
    ['🦁', '#b8722c'], ['🐨', '#7c8da3'], ['🐰', '#d46a9a'], ['🐧', '#2f6f8f']
  ];
  var FOTO_VALIDA = /^data:image\/(?:webp|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

  // Dibuja un avatar dentro de "el". Las fotos solo se aceptan como imagen (data:image/webp o jpeg).
  function pintar(el, avatar, nombre) {
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

  // Cuadrícula de avatares + botón "Foto". alElegir(avatar) se llama con "e:N" o con la foto ya reducida.
  // t es la función de textos; alError(texto) muestra un error.
  function crearSelector(contenedor, t, alElegir, alError) {
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
      var s = document.createElement('span');
      s.className = 'social-avatar';
      s.setAttribute('aria-hidden', 'true');
      pintar(s, 'e:' + i);
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
    var sf = document.createElement('span');
    sf.className = 'social-avatar';
    sf.setAttribute('aria-hidden', 'true');
    sf.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 8h3l2-3h6l2 3h3v11H4z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="13" r="3.5" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
    bf.appendChild(sf);
    var etiqueta = document.createElement('span');
    etiqueta.className = 'social-opcion-texto';
    bf.appendChild(etiqueta);
    opciones.push(bf);
    bf.addEventListener('click', function () { entrada.click(); });
    entrada.addEventListener('change', function () {
      var archivo = entrada.files && entrada.files[0];
      entrada.value = '';
      if (!archivo) return;
      alError('');
      reducirFoto(archivo).then(function (datos) {
        pintar(sf, datos);
        marcar(bf);
        alElegir(datos);
      }).catch(function () { alError(t('socialErrFoto')); });
    });
    contenedor.appendChild(bf);
    contenedor.appendChild(entrada);
    // Flechas para moverse entre opciones (como un grupo de radio).
    contenedor.addEventListener('keydown', function (e) {
      var i = opciones.indexOf(document.activeElement);
      if (i < 0) return;
      var paso = (e.key === 'ArrowRight' || e.key === 'ArrowDown') ? 1 : (e.key === 'ArrowLeft' || e.key === 'ArrowUp') ? -1 : 0;
      if (!paso) return;
      e.preventDefault();
      var sig = opciones[(i + paso + opciones.length) % opciones.length];
      sig.focus();
      if (sig !== bf) sig.click();
    });
    function etiquetas() {
      for (var i = 0; i < AVATARES.length; i++) opciones[i].setAttribute('aria-label', t('socialAvatarN', { n: i + 1 }));
      bf.setAttribute('aria-label', t('socialFoto'));
      etiqueta.textContent = t('socialFoto');
    }
    etiquetas();
    return {
      elegir: function (avatar) {
        var m = /^e:(\d+)$/.exec(avatar || '');
        if (m && opciones[+m[1]] && +m[1] < AVATARES.length) { marcar(opciones[+m[1]]); return; }
        if (avatar && FOTO_VALIDA.test(avatar)) { pintar(sf, avatar); marcar(bf); return; }
        marcar(opciones[0]);
      },
      etiquetas: etiquetas
    };
  }

  window.socialAvatares = { pintar: pintar, crearSelector: crearSelector, reducirFoto: reducirFoto };
})();
