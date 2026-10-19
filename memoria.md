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
- `npm run e2e` (test/e2e.mjs): **70/70 pruebas correctas** (local, con `npm run dev`).
- CI en GitHub Actions (`.github/workflows/ci.yml`): en cada push a `master`, PR o a mano, comprueba tipos y ejecuta el e2e completo contra un Worker local.
- Verificado en vivo tras el despliegue: `/health` → `{"ok":true}`; `/qr` muestra SVG + título; `/admin` pide contraseña con CSP; login con la contraseña de admin → 303.
- Rate-limit activo en producción (429 con `Retry-After` tras 120/min por sesión o 60/min por IP).

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

- `schema.sql` — esquema D1 (tablas: appointments, sessions, processed_messages, settings, audit_log, login_attempts, rate_limits). Ejecutable varias veces.
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
- **Horarios por peluquero**: cada peluquero puede tener su propio horario semanal (en `Ajustes → «Horario de <peluquero>»`); si rellena algún día, los vacíos son su día libre, y si lo deja todo vacío sigue el horario general del salón. Además, vacaciones/festivos propios por peluquero (`sc|…`) y días cerrados del salón. Se aplica tanto al bot (huecos ofrecidos) como a la validación de los paneles.
- Panel `/admin` (solo rol admin): agenda diaria con estadísticas y toggle de canceladas, crear/editar/cancelar/restaurar/borrar citas (borrar y restaurar solo admin), buscador, ajustes completos, historial de auditoría.
- Informes (`/admin/informes`, solo admin): resumen por rango de fechas de citas, canceladas, ingresos estimados (con el precio actual de cada servicio) y horas reservadas, desglosado por peluquero y por servicio; descarga del periodo en CSV (`/admin/informes.csv`).
- Panel `/recepcion` (rol staff o admin): agenda, crear/editar/cancelar; NO puede borrar/restaurar/ajustes/historial (esas rutas devuelven 404 o la página de login de admin).
- `/qr` público: cartel con código QR a wa.me + datos del salón.
- Seguridad: sesiones firmadas HMAC 12 h, cookies HttpOnly/SameSite=Strict, bloqueo 15 min tras 5 fallos de login (429), comparación de contraseñas con HMAC constante, CSRF por comprobación de Origin, CSP restrictiva, SQL parametrizado, sin `<script>` en el panel.
- Rate-limit deslizante 60 s en TODAS las rutas de panel: 120/min por sesión (clave `s:<sid>`), 60/min por IP (clave `i:<ip>`); 429 con `Retry-After: 60`; cookies falsificadas caen en el cubo de IP; purga en cron.
- Auditoría: cada acción registra quién (Cliente (WhatsApp)/Recepción/Admin), qué (crear/editar/cancelar/restaurar/borrar/ajustes) y detalle.
- Normalización de teléfonos españoles en panel Y en el webhook de WhatsApp (clave para que coincidan sesiones, citas y ediciones).

## 6. Cambios realizados

En el repositorio `C:\Users\<usuario>\Documents\NEGOCIOS\bot\citasalon`:

- **Creados**: `src/auth.ts`, `src/config.ts`, `src/availability.ts`, `src/phone.ts`, `src/panels.ts` (estos tres primeros faltaban y el proyecto ni compilaba).
- **Modificados**: `src/index.ts` (rutas de panel vía `handlePanel`, normalización de teléfono, import de los módulos nuevos), `wrangler.jsonc` (database_id real de la D1 creada en producción), `src/db.ts` (+`rateLimited` y purga de `rate_limits` en cleanup), `src/panels.ts` (+`rateGate`/`tooManyPage`, gancho al inicio de `handlePanel`), `schema.sql` (+tabla `rate_limits`), `package.json` (scripts `backup` y reset e2e con `rate_limits`), `test/e2e.mjs` (+2 pruebas de rate-limit).
- **No tocados**: `bot.ts`, `time.ts`, `types.ts`, `whatsapp.ts`, `reminders.ts`, `availability.ts`, `config.ts`, `auth.ts`, `phone.ts`.
- **Creados (documentación)**: `memoria.md`, `AGENTS.md`, `instrucciones/` (ver sección 11).
- **Añadido (automatización)**: `.github/workflows/backup.yml` — exporta la D1 remota cada día (03:00 UTC) o a mano y sube el resultado como artefacto de GitHub (30 días, nunca al repo por los datos personales); requiere los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID`.
- **Ampliado (informes)**: `src/db.ts` (+`appointmentsInRange`), `src/panels.ts` (+enlace «Informes» en la navegación de admin, `reportRange`, `informesBody`, export CSV con `csvResponse` y helpers `euro`/`parsePrice`/`priceOf`/`durationMin`), `test/e2e.mjs` (+4 pruebas de informes y CSV).
- **Corregido (revisión visual)**: `src/config.ts` — `salonName`/`address`/`phone` se guardaban con `JSON.stringify` (añadían comillas) pero se leían en crudo, así que tras guardar Ajustes el nombre aparecía como `"Salón Nuevo"` (con comillas) en paneles, cartel QR y mensajes del bot; ahora se leen con un parseo seguro (`s()`, JSON.parse con respaldo al valor crudo, compatible con datos ya guardados). `src/panels.ts` — CSS: scroll vertical en la barra lateral, contraste del subtítulo de marca (`#94a3b8`), `aria-label` en el selector de fecha; `test/e2e.mjs` — 2 guardas de regresión nuevas.
- **Añadido (horarios por peluquero)**: `src/types.ts` (+`stylistHours`, `stylistClosedDates` en `Settings`), `src/config.ts` (persistencia y defaults de los dos campos nuevos), `src/availability.ts` (+helpers `stylistSpans`/`stylistClosed`; `freeSlots` ahora calcula la unión de huecos por peluquero aplicando su horario y sus vacaciones), `src/panels.ts` (`validate()` usa el horario del peluquero concreto o «algún peluquero libre»; `parseSettings` lee los campos `sh|<peluquero>|<día>` y `sc|<peluquero>`; el formulario de Ajustes muestra una tarjeta «Horario de <peluquero>» por cada peluquero), `test/e2e.mjs` (+6 pruebas: guardado, render, validación por peluquero, vacaciones y efecto en el bot).
- **Añadido (CI)**: `.github/workflows/ci.yml` — en push a `master`, PR o a mano: `npm ci`, `npm run check`, crea `.dev.vars` con valores de prueba, aplica `schema.sql` a la D1 local, arranca `wrangler dev` en segundo plano, espera a `/health` y ejecuta `npm run e2e`.
- **Creado (plantillas de datos)**: carpeta `datos-salon/` con `LEEME.md`, `01-salon.md`, `02-peluqueros.md` y `03-servicios.md` — plantillas para que el salón rellene nombre/dirección/teléfono, tipo de peluquería, peluqueros con sus horarios y vacaciones, y servicios con duración y precio (con el mismo formato que usa el panel).


## 7. Decisiones tomadas

- **Sesión `sid=<role>.<exp>.<sig>`** firmada con HMAC-SHA256 y `SESSION_SECRET` (sin tabla de sesiones de panel): simple, revocable expirando, verificable sin consulta a BD.
- **`safeEqual(secret, a, b)`** calcula HMAC de ambos lados y compara en tiempo constante (así se comparan contraseñas y tokens sin filtrar longitud).
- **Febras "de pared"**: un `Date` cuyos campos UTC representan la hora local del salón; se guardan como texto `AAAA-MM-DDTHH:MM`. Evita líos de zonas horarias.
- **Choques de cita atómicos**: el INSERT/UPDATE lleva la comprobación dentro de la propia sentencia SQL (`NOT EXISTS ...`); D1 escribe de una en una, así dos personas no pueden coger el mismo hueco.
- **Roles de panel en la cookie** (admin/staff) en vez de filas en BD: los únicos usuarios son los del salón.
- **Panel sin JavaScript**: formularios HTML + redirecciones 303 con `?ok=...` para mensajes de éxito. Más simple, más seguro, y así lo exige la prueba e2e.
- **Normalizar el teléfono en el webhook** (no solo en el panel): si un panel cambia el teléfono de una cita a `+34…`, las próximas interacciones de ese cliente por WhatsApp (que llegan como `34…`) siguen encontrando su sesión y sus citas.
- **Defaults de configuración**: servicios `corte_mujer` (45′), `corte_hombre` (30′), `tinte` (90′); peluqueros Ana y Luis; horario 10:00-20:00 lunes-sábado, domingo cerrado; 15 min por hueco; 30 días por delante; antelación mínima 60 min; 5 citas máximas por cliente.
- **Rate-limit: por sesión con IP de respaldo**: la clave es la cookie `sid` completa si la sesión es válida (cada sesión su propio cubo), si no la IP. Así el staff que comparte NAT no se pisa y una cookie falsificada no permite rotar cubo. Ventana deslizante contando filas (<60 s), una inserción por petición aceptada, sin inserción al bloquear (el atacante no alarga su propia ventana).

## 8. Pruebas verificadas

- `npm run check` → sin errores TypeScript (verificado 2026-10-19 tras cada cambio).
- `npm run e2e` → **70/70** (2026-10-19): bots, login/roles/forged-cookie/CSRF, agenda, CRUD completo, conflictos 409, validaciones 422, ajustes + efecto en el bot, horarios y vacaciones por peluquero (validación de paneles y efecto en el bot), historial, CSP, bloqueo 429, logout, rate-limit por sesión e IP, informes (ingresos del periodo, desglose por servicio, acceso solo admin) y export CSV, y 2 guardas de regresión (los ajustes se guardan sin comillas sobrantes; el cartel QR muestra el nombre limpio).
- Producción (2026-10-19): `/health`, `/qr`, `/admin` y login real con la contraseña de admin generada (303) — verificado con Invoke-WebRequest. Rate-limit verificado en vivo (2 pruebas de e2e remotas pasan: 429 por sesión y por IP).
- NOTA: el e2e completo contra producción falla en login/CRUD porque la producción NO tiene secretos de panel ni `APP_SECRET` (decisión del usuario de no activar WhatsApp); es esperado, no una regresión. El e2e completo es contra local.
- Procedimiento local reproducible: `npx wrangler d1 execute citasalon --local --file=schema.sql`, `npm run dev` (puerto 8787), `npm run e2e`.
- CI: `.github/workflows/ci.yml` reproduce ese procedimiento en un runner de GitHub (Ubuntu + Node 22) en cada push/PR; sin coste relevante (repos privados tienen 2.000 min/mes gratis y cada ejecución dura ~2 min).
- Backup verificado: `npm run backup` exporta el D1 remoto a `backups/backup.sql` (carpeta fuera de git). Automatizado con `.github/workflows/backup.yml` (diario + manual, artefacto de 30 días); pendiente solo de que el usuario añada los secretos de GitHub.

## 9. Errores y problemas pendientes

Solucionados (documentados en `instrucciones/DECISIONES.md`): compilación por módulos faltantes; mezcla `||`/`??`; tipos de formularios en `panels.ts`; database_id ficticio en `wrangler.jsonc`; y comillas sobrantes en nombre/dirección/teléfono tras guardar Ajustes (bug detectado en la revisión visual, corregido en `config.ts`).

Pendientes/riesgos:

1. **WhatsApp no activado** (decisión del usuario): falta `WHATSAPP_TOKEN` (obligatorio para enviar) y `APP_SECRET` (firma de webhooks, recomendado). Hasta entonces el bot está en modo consola. Luego hay que configurar la URL del webhook en Meta.
2. **Variables de ejemplo en producción**: `wrangler.jsonc` sigue con "Peluqueria Ejemplo", dirección y teléfono de ejemplo, y `WHATSAPP_NUMBER=<NUMERO_DE_PRUEBA>` (número ficticio). Deben cambiarse a los datos reales del salón (afectan a `/qr`, mensajes del bot y avisos).
3. **Producción sin secretos de panel**: `ADMIN_PASSWORD`/`STAFF_PASSWORD`/`SESSION_SECRET`/`VERIFY_TOKEN` NO están puestos con `wrangler secret put` en el worker remoto (solo en `.dev.vars` local). Por eso el e2e remoto falla en login. Cuando el usuario quiera usar los paneles en producción: `npx wrangler secret put ADMIN_PASSWORD` etc.
4. `dev.log`, `dev-server.log`, `dev-err.log`, `dev-server.pid` y `.wrangler/` son residuos locales (ignorables; `.gitignore` ya existe).
5. Recordatorio: las contraseñas de los paneles generadas durante el despliegue se le dieron al usuario en el chat; NO están guardadas en ningún `.md` (regla de seguridad). Si las pierde, se regeneran con `npx wrangler secret put ADMIN_PASSWORD` / `STAFF_PASSWORD`.

## 10. Próximos pasos

Cuando el usuario lo pida:

1. Activar WhatsApp: `npx wrangler secret put WHATSAPP_TOKEN` (+ `APP_SECRET`) y configurar el webhook en Meta (`https://<tu-worker>.workers.dev/webhook`, token `<VERIFY_TOKEN_DE_PRUEBA>`).
2. Cambiar las vars de salón reales (`SALON_NAME`, `SALON_ADDRESS`, `SALON_PHONE`, `WHATSAPP_NUMBER`, `WHATSAPP_PHONE_ID`) y redesplegar.
3. Poner los secretos de panel en producción (`ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`, `VERIFY_TOKEN`) para que los paneles funcionen en el worker remoto.
4. Opcional: poner los datos reales vía `/admin/ajustes` (nombre, dirección, teléfono, servicios, peluqueros, horarios).
5. Activar el backup automático en GitHub: añadir los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` (el workflow `.github/workflows/backup.yml` ya está creado).

## 11. Historial de actualizaciones

- **2026-10-19** — Revisión completa del proyecto; creación de `src/auth.ts` (HMAC y sesiones).
- **2026-10-19** — Creación de `src/phone.ts`, `src/config.ts` (settings + defaults), `src/availability.ts` (huecos libres).
- **2026-10-19** — Creación de `src/panels.ts` (rutas completas de `/admin`, `/recepcion`, `/qr`); cableado en `index.ts`; normalización de teléfono en el webhook.
- **2026-10-19** — `npm run check` limpio; esquema aplicado a D1 local; e2e **57/57**.
- **2026-10-19** — Despliegue en producción: D1 creada (id `<DATABASE_ID>`, WEUR) + esquema; worker publicado; secretos ADMIN_PASSWORD/STAFF_PASSWORD/SESSION_SECRET/VERIFY_TOKEN subidos (valores NO documentados aquí); verificación en vivo correcta. `wrangler.jsonc` actualizado con el database_id real.
- **2026-10-19** — Usuario decide NO activar WhatsApp por ahora.
- **2026-10-19** — Instalado el sistema de memoria persistente: `memoria.md`, `AGENTS.md`, `instrucciones/` (sin tocar código funcional).
- **2026-10-19** — Se documentó el sistema de trabajo interno del proyecto.
- **2026-10-19** — Inicializado repositorio git (commit inicial `3b69ee1`, 32 ficheros). README actualizado: paneles, pruebas, variables opcionales y sistema de memoria (commit `b244c3a`). Revisión visual de paneles pendiente.
- **2026-10-19** — Repositorio subido a GitHub: https://github.com/tu-usuario/citasalon (privado, rama `master`, 3 commits). `gh` instalado y autenticado con la cuenta `qirris`.
- **2026-10-19** — Renombrado el repo en GitHub a `bot-whatsapp` (https://github.com/tu-usuario/citasalon); remote local actualizado; commits de memoria y de GitHub push (`c0ffbf6`).
- **2026-10-19** — Backup de D1: script `npm run backup` (exporta a `backups/backup.sql`, carpeta fuera de git por privacidad de teléfonos); commit `326c8c1`.
- **2026-10-19** — Rate-limit por sesión e IP: tabla `rate_limits` (ventana deslizante 60 s, 120/min sesión, 60/min IP), `db.rateLimited`, `rateGate`/`tooManyPage` en `panels.ts` (aplica a login, logout, `/qr` y todas las rutas de panel), purga en cron, +2 pruebas e2e (**59/59**), esquema aplicado a D1 remoto y desplegado (versión `f37b500e`). Rate-limit verificado en vivo en producción (las 2 pruebas remotas pasan); el resto del e2e remoto falla por falta de secretos de panel en producción (esperado, documentado).
- **2026-10-19** — Revisión visual de los paneles (capturas con Edge headless + revisión del HTML/CSS generado). Mejoras de CSS: scroll en la barra lateral, contraste del subtítulo de marca y `aria-label` en el selector de fecha. Bug funcional detectado y corregido: los campos de texto de Ajustes se mostraban con comillas sobrantes tras guardarlas (`config.ts`). Añadidas 2 guardas de regresión al e2e (**60/60**). `npm run check` limpio; desplegado (versión `ac97fb1e`); commit `1be0854`.
- **2026-10-19** — Backup automático: `.github/workflows/backup.yml` (diario 03:00 UTC + manual) exporta la D1 remota como artefacto de GitHub (30 días, nunca al repo). Pendiente de que el usuario añada los secretos `CLOUDFLARE_API_TOKEN` y `CLOUDFLARE_ACCOUNT_ID` en GitHub.
- **2026-10-19** — Nueva función: Informes (`/admin/informes`, solo admin) con totales, ingresos estimados, horas reservadas y desglose por peluquero/servicio sobre un rango de fechas, más exportación CSV (`/admin/informes.csv`). `npm run check` limpio; e2e **64/64**; desplegado (versión `d65501c1`).
- **2026-10-19** — Horarios por peluquero (cada peluquero puede tener su propio horario semanal y sus vacaciones; el bot y los paneles lo respetan). CI en GitHub Actions (`.github/workflows/ci.yml`). Plantillas de datos del salón en `datos-salon/`. `npm run check` limpio; e2e **70/70**.
