# Memoria del proyecto

Archivo de memoria del proyecto. Actualízalo tras cada avance importante.
Regla: NO guardar aquí contraseñas, tokens ni ningún secreto (los secretos viven en Cloudflare y en `.dev.vars`, que no se sube a git).

## 1. Objetivo y alcance

Bot de reservas de peluquería por WhatsApp + panel de administración completo (modo oscuro/claro con sidebar, CRUD, auditoría), desplegado en Cloudflare Workers con base de datos D1.

- Idioma de todo: español (UI, respuestas del bot, documentación).
- Regla dada por el usuario: implementar directamente en el repo SIN romper la funcionalidad existente del bot.
- Regla del usuario: por ahora NO activar la parte de WhatsApp en producción (sin `WHATSAPP_TOKEN` ni `APP_SECRET`; el bot funciona en "modo consola": registra las respuestas en los logs de Cloudflare en lugar de enviarlas).

## 2. Estado actual

**COMPLETADO y DESPLEGADO en producción** (2026-10-19):

- URL de producción: `https://<tu-worker>.workers.dev`
- Rutas activas: `/health`, `/webhook`, `/admin`, `/recepcion`, `/qr`
- `npm run check` (tsc --noEmit): limpio.
- `npm run e2e` (test/e2e.mjs): **57/57 pruebas correctas** (local, con `npm run dev`).
- Verificado en vivo tras el despliegue: `/health` → `{"ok":true}`; `/qr` muestra SVG + título; `/admin` pide contraseña con CSP; login con la contraseña de admin → 303.

## 3. Tecnologías y arquitectura

- Cloudflare Worker (TypeScript estricto, módulos ES2022, imports con extensión `.ts`).
- D1 (SQLite) con binding `DB`. Base de datos `citasalon`, id `<DATABASE_ID>` (región WEUR).
- Cron `*/10 * * * *` (recordatorios + limpieza).
- Sin frontend JS: los paneles son HTML server-side con formularios (CSP `default-src 'none'`).
- QR generado con la librería `uqr` (SVG inline).
- Sin framework: enrutador manual en `src/panels.ts`.

### Archivos fuente (`src/`)

| Archivo | Función |
|---|---|
| `index.ts` | Entrada del Worker: `/health`, `/webhook` (firma HMAC), paneles, cron; normaliza el teléfono de WhatsApp |
| `panels.ts` | Todas las rutas de `/admin`, `/recepcion`, `/qr` (HTML, login, agenda, CRUD, ajustes, historial) |
| `bot.ts` | Autómata de estados de la conversación (MENU→SERVICE→DAY→TIME→NAME→CONFIRM; cancelación) |
| `db.ts` | Capa D1: sesiones, citas (con choques atómicos), auditoría, intentos de login, búsqueda |
| `config.ts` | `loadSettings`/`saveSettings` (tabla `settings`) + valores por defecto |
| `availability.ts` | `freeSlots` y `daysWithAvailability` |
| `auth.ts` | HMAC (`hmacHex`, `safeEqual`), cookies de sesión firmadas `sid=<role>.<exp>.<sig>` |
| `phone.ts` | `normalizePhone` (+34…), `displayPhone` |
| `time.ts` | Fechas "de pared" (UTC = hora local del salón), textos en español |
| `whatsapp.ts` | Envío a la Graph API (modo consola sin token) |
| `reminders.ts` | Recordatorios 24 h antes (cron) |
| `types.ts` | `Env`, `Settings`, `Appt`, etc. |

### Otros archivos clave

- `schema.sql` — esquema D1 (tablas: appointments, sessions, processed_messages, settings, audit_log, login_attempts). Ejecutable varias veces.
- `test/e2e.mjs` — prueba de extremo a extremo completa (es la especificación real del panel).
- `.dev.vars` — secretos locales de prueba (NO subir a git; existe `.dev.vars.example`).
- `setup.ps1` / `instalar.bat` — instalación interactiva en Cloudflare.
- `wrangler.jsonc` — vars no secretas del salón y binding D1.

## 4. Instrucciones y restricciones

Del usuario (permanentes):

1. Trabajar en español siempre (respuestas, UI, docs).
2. No romper el bot existente; los cambios deben ser compatibles.
3. El panel no usa JavaScript en el navegador (formularios puros).
4. `test/e2e.mjs` es la especificación exacta del comportamiento esperado del panel.
5. NO activar WhatsApp en producción hasta que el usuario lo pida (falta `WHATSAPP_TOKEN` y `APP_SECRET`; luego, poner la URL del webhook en Meta).
6. Sistema de memoria: mantener `memoria.md` e `instrucciones/*.md` actualizados (ver `instrucciones/INSTRUCCIONES_GENERALES.md`).
7. No inventar información ni marcar como terminado algo no verificado.

Ver también: `instrucciones/NORMAS_DE_CODIGO.md`, `instrucciones/SEGURIDAD.md`, `instrucciones/PRUEBAS.md`, `instrucciones/DECISIONES.md`.

## 5. Funcionalidades implementadas

- Bot WhatsApp: reserva con botones/listas o texto libre ("corte mujer", "por la tarde", "a las 5"), cancelación propia desde "Mis citas", límite de citas por cliente, aviso de horario/dirección.
- Disponibilidad: huecos según horario del salón, minutos por tramo, días cerrados, antelación mínima, máximo de días por delante, evitando choques por peluquero.
- Panel `/admin` (solo rol admin): agenda diaria con estadísticas y toggle de canceladas, crear/editar/cancelar/restaurar/borrar citas (borrar y restaurar solo admin), buscador, ajustes completos, historial de auditoría.
- Panel `/recepcion` (rol staff o admin): agenda, crear/editar/cancelar; NO puede borrar/restaurar/ajustes/historial (esas rutas devuelven 404 o la página de login de admin).
- `/qr` público: cartel con código QR a wa.me + datos del salón.
- Seguridad: sesiones firmadas HMAC 12 h, cookies HttpOnly/SameSite=Strict, bloqueo 15 min tras 5 fallos de login (429), comparación de contraseñas con HMAC constante, CSRF por comprobación de Origin, CSP restrictiva, SQL parametrizado, sin `<script>` en el panel.
- Auditoría: cada acción registra quién (Cliente (WhatsApp)/Recepción/Admin), qué (crear/editar/cancelar/restaurar/borrar/ajustes) y detalle.
- Normalización de teléfonos españoles en panel Y en el webhook de WhatsApp (clave para que coincidan sesiones, citas y ediciones).

## 6. Cambios realizados

En el repositorio `C:\Users\<usuario>\Documents\NEGOCIOS\bot\citasalon`:

- **Creados**: `src/auth.ts`, `src/config.ts`, `src/availability.ts`, `src/phone.ts`, `src/panels.ts` (estos tres primeros faltaban y el proyecto ni compilaba).
- **Modificados**: `src/index.ts` (rutas de panel vía `handlePanel`, normalización de teléfono, import de los módulos nuevos), `wrangler.jsonc` (database_id real de la D1 creada en producción).
- **No tocados**: `bot.ts`, `db.ts`, `time.ts`, `types.ts`, `whatsapp.ts`, `reminders.ts`, `test/e2e.mjs`, `schema.sql`.
- **Creados (documentación)**: `memoria.md`, `AGENTS.md`, `instrucciones/` (ver sección 11).


## 7. Decisiones tomadas

- **Sesión `sid=<role>.<exp>.<sig>`** firmada con HMAC-SHA256 y `SESSION_SECRET` (sin tabla de sesiones de panel): simple, revocable expirando, verificable sin consulta a BD.
- **`safeEqual(secret, a, b)`** calcula HMAC de ambos lados y compara en tiempo constante (así se comparan contraseñas y tokens sin filtrar longitud).
- **Febras "de pared"**: un `Date` cuyos campos UTC representan la hora local del salón; se guardan como texto `AAAA-MM-DDTHH:MM`. Evita líos de zonas horarias.
- **Choques de cita atómicos**: el INSERT/UPDATE lleva la comprobación dentro de la propia sentencia SQL (`NOT EXISTS ...`); D1 escribe de una en una, así dos personas no pueden coger el mismo hueco.
- **Roles de panel en la cookie** (admin/staff) en vez de filas en BD: los únicos usuarios son los del salón.
- **Panel sin JavaScript**: formularios HTML + redirecciones 303 con `?ok=...` para mensajes de éxito. Más simple, más seguro, y así lo exige la prueba e2e.
- **Normalizar el teléfono en el webhook** (no solo en el panel): si un panel cambia el teléfono de una cita a `+34…`, las próximas interacciones de ese cliente por WhatsApp (que llegan como `34…`) siguen encontrando su sesión y sus citas.
- **Defaults de configuración**: servicios `corte_mujer` (45′), `corte_hombre` (30′), `tinte` (90′); peluqueros Ana y Luis; horario 10:00-20:00 lunes-sábado, domingo cerrado; 15 min por hueco; 30 días por delante; antelación mínima 60 min; 5 citas máximas por cliente.

## 8. Pruebas verificadas

- `npm run check` → sin errores TypeScript (verificado 2026-10-19 tras cada cambio).
- `npm run e2e` → **57/57** (2026-10-19): bots, login/roles/forged-cookie/CSRF, agenda, CRUD completo, conflictos 409, validaciones 422, ajustes + efecto en el bot, historial, CSP, bloqueo 429, logout.
- Producción (2026-10-19): `/health`, `/qr`, `/admin` y login real con la contraseña de admin generada (303) — verificado con Invoke-WebRequest.
- Procedimiento local reproducible: `npx wrangler d1 execute citasalon --local --file=schema.sql`, `npm run dev` (puerto 8787), `npm run e2e`.

## 9. Errores y problemas pendientes

Solucionados (documentados en `instrucciones/DECISIONES.md`): compilación por módulos faltantes; mezcla `||`/`??`; tipos de formularios en `panels.ts`; database_id ficticio en `wrangler.jsonc`.

Pendientes/riesgos:

1. **WhatsApp no activado** (decisión del usuario): falta `WHATSAPP_TOKEN` (obligatorio para enviar) y `APP_SECRET` (firma de webhooks, recomendado). Hasta entonces el bot está en modo consola. Luego hay que configurar la URL del webhook en Meta.
2. **Variables de ejemplo en producción**: `wrangler.jsonc` sigue con "Peluqueria Ejemplo", dirección y teléfono de ejemplo, y `WHATSAPP_NUMBER=<NUMERO_DE_PRUEBA>` (número ficticio). Deben cambiarse a los datos reales del salón (afectan a `/qr`, mensajes del bot y avisos).
3. **README sin actualizar**: describe el proyecto pero no documenta las rutas de los paneles ni el sistema de memoria.
4. **Sin git**: el proyecto no es un repositorio git; no hay historial de versiones ni `.git` que proteja los cambios.
5. `dev.log` y `.wrangler/` son residuos locales (ignorables; `.gitignore` ya existe).
6. Recordatorio: las contraseñas de los paneles generadas durante el despliegue se le dieron al usuario en el chat; NO están guardadas en ningún `.md` (regla de seguridad). Si las pierde, se regeneran con `npx wrangler secret put ADMIN_PASSWORD` / `STAFF_PASSWORD`.

## 10. Próximos pasos

Cuando el usuario lo pida:

1. Activar WhatsApp: `npx wrangler secret put WHATSAPP_TOKEN` (+ `APP_SECRET`) y configurar el webhook en Meta (`https://<tu-worker>.workers.dev/webhook`, token `<VERIFY_TOKEN_DE_PRUEBA>`).
2. Cambiar las vars de salón reales (`SALON_NAME`, `SALON_ADDRESS`, `SALON_PHONE`, `WHATSAPP_NUMBER`, `WHATSAPP_PHONE_ID`) y redesplegar.
3. Opcional: poner los datos reales vía `/admin/ajustes` (nombre, dirección, teléfono, servicios, peluqueros, horarios).
4. Opcional: documentar los paneles en el README; inicializar git.
5. Opcional: revisar el aspecto visual de los paneles en el navegador (el e2e valida contenido, no el diseño).

## 11. Historial de actualizaciones

- **2026-10-19** — Revisión completa del proyecto; creación de `src/auth.ts` (HMAC y sesiones).
- **2026-10-19** — Creación de `src/phone.ts`, `src/config.ts` (settings + defaults), `src/availability.ts` (huecos libres).
- **2026-10-19** — Creación de `src/panels.ts` (rutas completas de `/admin`, `/recepcion`, `/qr`); cableado en `index.ts`; normalización de teléfono en el webhook.
- **2026-10-19** — `npm run check` limpio; esquema aplicado a D1 local; e2e **57/57**.
- **2026-10-19** — Despliegue en producción: D1 creada (id `<DATABASE_ID>`, WEUR) + esquema; worker publicado; secretos ADMIN_PASSWORD/STAFF_PASSWORD/SESSION_SECRET/VERIFY_TOKEN subidos (valores NO documentados aquí); verificación en vivo correcta. `wrangler.jsonc` actualizado con el database_id real.
- **2026-10-19** — Usuario decide NO activar WhatsApp por ahora.
- **2026-10-19** — Instalado el sistema de memoria persistente: `memoria.md`, `AGENTS.md`, `instrucciones/` (sin tocar código funcional).
- **2026-10-19** — Se documentó el sistema de trabajo interno del proyecto.
