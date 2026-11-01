# Seguridad

## Secretos

- NUNCA guardar secretos en `.md` ni en el código (ni contraseñas de prueba si valen en producción).
- Producción: `wrangler secret put NOMBRE` (quedan cifradas en Cloudflare; no se pueden leer después, solo reemplazar).
- Local: `.dev.vars` (excluido de git; existe `.dev.vars.example` como plantilla).
- Secretos del proyecto (valores NO aquí):
  - **Producción** (verificado con `wrangler secret list` el 2026-10-26): `ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`, `VERIFY_TOKEN`. **No** hay `WHATSAPP_TOKEN` ni `APP_SECRET` mientras WhatsApp siga desactivado.
  - **Local** (`.dev.vars`, fuera de git): los cuatro anteriores y, para pruebas, `APP_SECRET` y `WHATSAPP_TOKEN` del número de test de Meta.
- **`SESSION_SECRET` es obligatorio**: el código lanza error si falta (sin secreto por defecto). Configurar en `.dev.vars` y en producción con `wrangler secret put SESSION_SECRET`.

## Autenticación de paneles

- Cookie `sid=<role>.<exp>.<sig>`; `sig = HMAC-SHA256(SESSION_SECRET, "<role>.<exp>")`. Verificar con `safeEqual` (comparación en tiempo constante).
- Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (12 h); `Secure` solo si la petición es https.
- `/admin` exige rol admin; `/recepcion` admite staff o admin. Páginas GET sin permiso → página de login (con "Contraseña"); POST sin permiso → 401.
- Login: comprobación de `Origin` contra el host de la petición (403 si difiere) ANTES de tocar la contraseña; bloqueo 429 tras 5 fallos en 15 min por IP (`login_attempts`); fallo registrado y limpieza de intentos al acertar.
- **CSRF en mutaciones**: todas las rutas POST que modifican datos (`/nueva`, `/cita/`, `/ajustes`) validan `Origin` con `badOrigin()` (además de `SameSite=Strict`).

## Rate-limit de paneles

- Ventana deslizante de 60 s en `rate_limits` (una fila por petición aceptada; clave + instante).
- Clave: `s:<cookie sid completa>` si hay sesión válida (cada sesión su propio cubo → el staff que comparte IP no se pisa); si no, `i:<IP>` (`CF-Connecting-IP`, o `local` en desarrollo).
- Límites: **120 peticiones/min por sesión** y **60/min por IP** → 429 con `Retry-After: 60` y página propia.
- Se aplica a TODAS las rutas de panel (login, logout, `/qr`, agenda, etc.) antes de cualquier lógica; cookies falsificadas caen en el cubo de IP (no se puede rotar cubo cambiando la cookie).
- Las peticiones rechazadas NO insertan fila (no alargan su propia ventana); el cron purga filas de más de 10 min.
- Verificado en e2e (último resultado: **189/189, 0 fallidas, 2026-10-30**): sesión agotada → 429; IP agotada en `/qr` → 429. Los informes (`/admin/informes*`) exigen rol admin (Recepción recibe la página de login).

## Webhook de WhatsApp

- GET: verificar `hub.verify_token` contra `VERIFY_TOKEN` con `safeEqual`.
- POST: verificar `X-Hub-Signature-256 = sha256=HMAC(APP_SECRET, cuerpo)` con comparación en tiempo constante; sin `APP_SECRET` configurado se avisa por log y no se valida (modo desarrollo).
- Deduplicación por `message.id` en `processed_messages` (reintentos de Meta no duplican citas).
- **Procesamiento seguro (versión actual, 2026-10-26)**: `markMessageSeen` reclama el `wamid` con `INSERT OR IGNORE` **antes** de procesar el mensaje, y `forgetMessage` lo libera si el procesamiento o el envío fallan. Así un reintento de Meta se vuelve a procesar en vez de ignorarse. (Decisión anterior, FASE 1: marcar después de procesar, para no perder mensajes si fallaba el envío; esa decisión se cambió el 2026-10-26 porque, al marcar al final y ignorar el resultado, los reintentos se descartaban de todos modos. Ver `DECISIONES.md`.)

## Paneles

- CSP estricta en todo HTML (ver `NORMAS_DE_CODIGO.md`). La base es `default-src 'none'` sin `script-src`; **solo dos páginas** permiten un script inline estático con su propia CSP: el formulario de cita (`CSP_FORM`, selector de huecos con `connect-src 'self'` para `/slots`) y la agenda (`CSP_AGENDA`, refresco automático con `connect-src 'self'` para `/agenda-json`). El resto de páginas no permite JS.
- Todo contenido dinámico escapado con `esc()`.
- SQL solo parametrizado; búsqueda resistente a inyección (verificado en e2e con `' OR 1=1 --`).
- Autorización por recurso: borrar/restaurar solo admin (rutas inexistentes bajo `/recepcion` → 404); ajustes e historial solo admin.
- Cancelación de clientes por WhatsApp: solo citas propias (`getOwn`/`cancelOwn` filtran por teléfono).
- Auditoría de toda mutación (`audit_log`) como disuasión y para reconstruir quién hizo qué.

## Validaciones de citas (FASE 1)

- **Fechas pasadas**: `validate()` rechaza citas con fecha anterior a hoy (comparación con `nowLocal(env.SALON_TZ)`).
- **Alineación a `slotMinutes`**: la hora de la cita debe ser múltiplo del intervalo configurado (ej. 15 min).
- **Horarios y vacaciones por peluquero**: se respetan tanto en bot como en paneles.

## WhatsApp y recordatorios (FASE 1)

- **Envío simulado vs real**: `SendResult` incluye `simulated: boolean`. En modo consola (sin `WHATSAPP_TOKEN`) devuelve `{ok: true, simulated: true}`.
- **Recordatorios no falsos**: en modo simulado **no** se marca `reminder_sent = 1`; se logea como simulado. Si luego se activa el token, los recordatorios pendientes se enviarán.

## Cosas a vigilar

- Si se pierde una contraseña de panel: regenerar con `wrangler secret put ADMIN_PASSWORD` / `STAFF_PASSWORD` (no está copiada en ningún sitio).
- `SESSION_SECRET` compromise ⇒ regenerar (invalida todas las sesiones).
- Activar `APP_SECRET` en producción en cuanto se conecte WhatsApp real.
- Producción tiene los secretos de panel (`ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`, `VERIFY_TOKEN`), así que el login remoto funciona; lo que no tiene es `WHATSAPP_TOKEN`/`APP_SECRET` porque WhatsApp está desactivado. No se puede ejecutar la suite e2e completa contra producción (crea datos y necesita secretos de prueba locales).
