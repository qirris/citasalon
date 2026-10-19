# Seguridad

## Secretos

- NUNCA guardar secretos en `.md` ni en el código (ni contraseñas de prueba si valen en producción).
- Producción: `wrangler secret put NOMBRE` (quedan cifradas en Cloudflare; no se pueden leer después, solo reemplazar).
- Local: `.dev.vars` (excluido de git; existe `.dev.vars.example` como plantilla).
- Secretos actuales del proyecto (valores NO aquí): `WHATSAPP_TOKEN`, `VERIFY_TOKEN`, `APP_SECRET`, `ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`.

## Autenticación de paneles

- Cookie `sid=<role>.<exp>.<sig>`; `sig = HMAC-SHA256(SESSION_SECRET, "<role>.<exp>")`. Verificar con `safeEqual` (comparación en tiempo constante).
- Cookie: `HttpOnly; SameSite=Strict; Path=/; Max-Age=43200` (12 h); `Secure` solo si la petición es https.
- `/admin` exige rol admin; `/recepcion` admite staff o admin. Páginas GET sin permiso → página de login (con "Contraseña"); POST sin permiso → 401.
- Login: comprobación de `Origin` contra el host de la petición (403 si difiere) ANTES de tocar la contraseña; bloqueo 429 tras 5 fallos en 15 min por IP (`login_attempts`); fallo registrado y limpieza de intentos al acertar.

## Webhook de WhatsApp

- GET: verificar `hub.verify_token` contra `VERIFY_TOKEN` con `safeEqual`.
- POST: verificar `X-Hub-Signature-256 = sha256=HMAC(APP_SECRET, cuerpo)` con comparación en tiempo constante; sin `APP_SECRET` configurado se avisa por log y no se valida (modo desarrollo).
- Deduplicación por `message.id` en `processed_messages` (reintentos de Meta no duplican citas).

## Paneles

- CSP estricta en todo HTML (ver `NORMAS_DE_CODIGO.md`); sin `<script>` en absoluto.
- Todo contenido dinámico escapado con `esc()`.
- SQL solo parametrizado; búsqueda resistente a inyección (verificado en e2e con `' OR 1=1 --`).
- Autorización por recurso: borrar/restaurar solo admin (rutas inexistentes bajo `/recepcion` → 404); ajustes e historial solo admin.
- Cancelación de clientes por WhatsApp: solo citas propias (`getOwn`/`cancelOwn` filtran por teléfono).
- Auditoría de toda mutación (`audit_log`) como disuasión y para reconstruir quién hizo qué.

## Cosas a vigilar

- Si se pierde una contraseña de panel: regenerar con `wrangler secret put ADMIN_PASSWORD` / `STAFF_PASSWORD` (no está copiada en ningún sitio).
- `SESSION_SECRET` compromise ⇒ regenerar (invalida todas las sesiones).
- Activar `APP_SECRET` en producción en cuanto se conecte WhatsApp real.
- El proyecto NO está en git: no hay historial ni rollback fácil (ver pendientes).
