# Arquitectura

## Qué es

Bot de reservas de peluquería por WhatsApp + paneles web (admin y recepción) + cartel QR, en UN SOLO Worker de Cloudflare con D1 (SQLite).

```
WhatsApp ──POST firmado──▶ /webhook ──▶ bot.ts (autómata de estados)
Meta verifica ──GET──▶ /webhook?hub.verify_token=...
Personal ──▶ /admin y /recepcion ──▶ panels.ts (HTML server-side; dos scripts inline acotados)
Clientes ──▶ /qr (cartel con QR a wa.me)
Cron */10 ──▶ reminders.ts (recordatorios 24 h) + db.cleanup
```

## Flujo de una reserva (bot)

`MENU → SERVICE → STYLIST → DAY → TIME → NAME → CONFIRM`, y `MENU → CANCEL_PICK → CANCEL_CONFIRM` para cancelar. Desde `CANCEL_CONFIRM` el botón «Reprogramar» (`resched:yes`) continúa con `RESCHED_DAY → RESCHED_TIME → RESCHED_CONFIRM`, conservando la cita elegida. El paso `STYLIST` (elección de peluquero) se añadió el 2026-10-26: el cliente elige entre los peluqueros con horario semanal (o «Me da igual / el primero disponible») y la elección se respeta en días, horas, confirmación y la cita final.
Todo funciona también con texto libre ("corte mujer", "por la tarde", "a las 5"). El estado de la conversación vive en la tabla `sessions` (clave: teléfono normalizado).

## Capas

| Módulo | Responsabilidad |
|---|---|
| `index.ts` | Enrutado (`/health`, `/webhook`, paneles), verificación HMAC de Meta, normalización de teléfono, cron |
| `panels.ts` | Todo el HTML/CRUD de los paneles; valida, usa `db.*` y escribe auditoría |
| `bot.ts` | Mensajes y transiciones; usa `availability.ts`, `db.*`, `loadSettings` |
| `db.ts` | Única capa SQL; choques de citas atómicos (comprobación dentro del INSERT/UPDATE) |
| `availability.ts` | `freeSlots` / `daysWithAvailability` (horario general + horario propio y vacaciones por peluquero + citas existentes + antelación); helpers `stylistSpans`/`stylistClosed` |
| `config.ts` | Settings de la BD (tabla `settings`) con defaults en código |
| `auth.ts` | HMAC, cookies de sesión firmadas, comprobación de Origin |
| `phone.ts` | Normalización `346…` → `+346…` y formato de display |
| `time.ts` | Fechas "de pared" (UTC = hora local del salón), textos en español |
| `whatsapp.ts` | Graph API; si no hay token, solo logea ("modo consola") |

## Modelo de datos (D1)

- `appointments` — citas (status `confirmed`/`done`/`cancelled`, source whatsapp/admin/staff, choques por stylist+tramo).
- `sessions` — estado de conversación por teléfono (TTL desde settings, limpieza en cron).
- `processed_messages` — deduplicación de webhooks de Meta (idempotencia).
- `settings` — pares clave/valor JSON (servicios, peluqueros, horario general, `stylistHours`/`stylistClosedDates` por peluquero, reglas).
- `audit_log` — quién hizo qué (role whatsapp/staff/admin, action crear/editar/cancelar/restaurar/borrar/ajustes).
- `login_attempts` — intentos fallidos por IP (bloqueo 15 min).
- `rate_limits` — una fila por petición de panel aceptada (clave `s:<sid>` o `i:<ip>` + instante con segundos); ventana deslizante 60 s, 120/min por sesión y 60/min por IP; purga en cron (>10 min).

## Fechas "de pared"

Un `Date` cuyos campos UTC representan la hora local del salón; se persiste como texto `AAAA-MM-DDTHH:MM`. Nunca usar timestamps reales con zona: complican horarios de apertura y DST. Ver `time.ts` y `DECISIONES.md`.

## Paneles

- `/admin` — solo rol admin. Agenda (+canceladas, estadísticas), CRUD completo (borrar/restaurar solo aquí), `/admin/citas` (buscador), `/admin/informes` (+`/admin/informes.csv`, ingresos y desglose por periodo), `/admin/ajustes`, `/admin/historial`.
- `/recepcion` — rol staff o admin. Agenda, crear/editar/cancelar. `borrar`/`restaurar` bajo `/recepcion` devuelven 404 a propósito.
- `/qr` — público.
- Login propio por base (`/admin/login`, `/recepcion/login`) con contraseñas distintas (`ADMIN_PASSWORD`, `STAFF_PASSWORD`).
- HTML server-side + formularios + 303 con `?ok=…` para flashes. **Solo dos scripts inline estáticos**, en sus propias páginas y con su propia CSP: el selector de huecos del formulario de cita (`CSP_FORM`, con `connect-src 'self'` para `/slots`) y el refresco automático de la agenda (`CSP_AGENDA`, con `connect-src 'self'` para `/agenda-json`). El resto de páginas no permite JS. Si se añade otra página con JS en el futuro, hay que darle su propia CSP con el `connect-src` que necesite y escapar siempre los datos que vengan de clientes.

## Configuración

- Producción: vars no secretas en `wrangler.jsonc`; secretos con `wrangler secret` (WhatsApp, contraseñas, `SESSION_SECRET`, `VERIFY_TOKEN`, `APP_SECRET`).
- Local: `.dev.vars` (ya existe con valores de prueba; no commitear). La BD local se crea con `schema.sql`.
