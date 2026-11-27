# Publicar el chat Social (versión nueva)

Esta guía no tiene ninguna clave. Las claves se escriben solo en la terminal, cuando Cloudflare las pide.

## 1. Preparar Cloudflare (una sola vez, lo haces tú)

1. **Activar R2** en el panel de Cloudflare (R2 Object Storage). Pide una tarjeta, aunque los primeros 10 GB son gratis.
2. En una terminal, dentro de la carpeta `social-worker`:

   ```
   npx wrangler login
   npx wrangler r2 bucket create shukito-social-archivos
   npx wrangler r2 bucket lifecycle add shukito-social-archivos borrar-2-dias m/ --expire-days 2
   npx wrangler secret put ADMIN_CLAVE
   ```

   - `ADMIN_CLAVE`: tu clave de administrador. Que sea larga (12 caracteres o más) y distinta de la del grupo.
   - La clave del grupo (`CLAVE`) ya existe. Después se puede cambiar desde el panel de administrador.
3. **GIFs (Giphy)**: la clave de Giphy se guarda como secreto (nunca en la página ni en GitHub):

   ```
   npx wrangler secret put GIPHY_CLAVE
   ```

   Pega la clave (API Key) de tu app de Giphy cuando la pida. Sin este secreto el botón GIF muestra "Los GIFs todavía no están activados".
4. **Workers AI** (botón Traducir) no hay que activarlo aparte: viene con la cuenta y tiene un uso gratis por día.

## 2. Publicar (servidor y página seguidos, en pocos minutos)

La página vieja y el servidor nuevo no se entienden (ni al revés). Hay que publicar los dos seguidos.

1. Servidor, dentro de `social-worker`:

   ```
   npx wrangler deploy
   ```

2. Página, en la carpeta principal (rama `publicar`):

   ```
   git push
   ```

   GitHub Pages tarda 1 o 2 minutos en mostrarla.

## 3. Qué notarán los invitados

- Todos tienen que **crear su usuario otra vez**, una sola vez: nombre, avatar o foto, PIN y clave del grupo. Verán el aviso "Tu sesión terminó…".
- Los mensajes de las últimas 24 horas pasan al chat general.

## 4. Probar en teléfonos reales (lista corta)

En un iPhone (Safari) y en un Android (Chrome):

- [ ] Crear usuario con **foto de la galería** y con un avatar.
- [ ] Cambiar el estado y la foto.
- [ ] Contactos → abrir chat privado → escribir. El otro teléfono ve el asterisco rojo.
- [ ] **Foto** con la cámara y desde la galería.
- [ ] **Video** de la galería de más de 15 segundos: se corta a 15 y se ve en el otro teléfono (iPhone ↔ Android).
- [ ] **Audio**: el navegador pide el micrófono, se graba, se envía y se escucha en el otro teléfono.
- [ ] **Responder** (carita → Responder) a un texto, una foto y un GIF, en el general y en un privado. Tocar la cita lleva al mensaje original.
- [ ] **GIF**: abrir, ver los populares, buscar (por ejemplo "gato"), enviar. Se ve en el otro teléfono.
- [ ] **Traducir** un mensaje en español y uno en inglés.
- [ ] Sonido de mensaje con el chat cerrado. En computadora, también la notificación con la pestaña en segundo plano.
- [ ] Silenciar a una persona: no suena, pero sale el asterisco.
- [ ] Borrar un chat (solo para mí).
- [ ] Administrador: entrar, cambiar la clave del grupo, borrar un mensaje, sacar a un usuario de prueba.
- [ ] Modo día y noche, español e inglés.

## 5. Si algo sale mal

- **Apagar el chat al momento**: en `social.js`, línea 4, deja `var SOCIAL_SERVIDOR = '';` y publica la página con `git push`. El botón Social desaparece.
- **Volver a la versión anterior de la página**: la rama `respaldo-social-2026-11-21` tiene la página tal como estaba.
- **Volver al servidor anterior no sirve de mucho**: la base de datos ya cambió de formato. La versión anterior no reconocería los usuarios nuevos y los invitados tendrían que entrar de nuevo. Es mejor apagar el chat y corregir.
