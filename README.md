# IsiSender

CRM para enviar y recibir mensajes de WhatsApp, vinculado como "dispositivo vinculado".

**Funciona por uso:** se enciende cuando alguien abre el enlace (unos segundos) y se apaga
solo tras 10 minutos sin nadie conectado y sin envíos en curso. Los mensajes que lleguen
mientras está apagado los entrega WhatsApp al volver a encenderse.

## Publicar en Fly.io (pagas solo el tiempo encendido)

1. Sube el contenido de esta carpeta a un repositorio **privado** de GitHub.
2. Crea tu cuenta en fly.io (pide tarjeta) y en el panel elige **Launch an App → desde GitHub**
   y selecciona el repositorio. Fly lee `fly.toml` y crea el disco `/data` automáticamente.
   - Si el nombre `isisender` está tomado, elige otro (ej: `isisender-tunombre`).
3. En **Secrets** de la app agrega `ADMIN_PASSWORD` = tu contraseña de administrador.
4. Abre `https://<nombre-de-tu-app>.fly.dev`, entra con tu contraseña y vincula WhatsApp
   en la pestaña "Conexión".
5. En "Enlaces para clientes" crea el enlace y envíaselo a tu cliente: entra sin contraseña.

## Ajustes

- `IDLE_MINUTES` (en `fly.toml`): minutos sin uso antes de apagarse. `0` = siempre encendido.
- Si pasan más de ~2 semanas sin abrirlo, WhatsApp puede desvincular el dispositivo:
  basta con volver a vincularlo en "Conexión".
