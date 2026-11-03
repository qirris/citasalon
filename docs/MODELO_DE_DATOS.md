# Modelo de datos

Esquema real de la base D1 (SQLite). Fuente: `schema.sql`, `migrations/` y consultas de `src/db.ts` (revisado el 2026-11-03).

`schema.sql` es el esquema completo e idempotente (`CREATE TABLE/INDEX IF NOT EXISTS`) para una instalación nueva: incluye tablas base y Fase 2 (Inbox, Outbox, secuencias, bloqueos, guards y `source_wamid`). Se puede aplicar varias veces sin borrar datos. **En una D1 nueva no ejecutes después las migraciones `0001`–`0004`**: duplicarían cambios ya presentes (y `ALTER TABLE` de `0001` fallaría si la columna existe). Las migraciones solo se usan para actualizar bases creadas con una versión anterior.

## `appointments` — citas

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | Identificador interno. |
| `phone` | TEXT | Teléfono normalizado (`+34…`) o vacío. |
| `name` | TEXT | Nombre del cliente. |
| `service_id` | TEXT | ID del servicio en el momento de la cita. |
| `service_name` | TEXT | Nombre del servicio **congelado** para el historial. |
| `stylist` | TEXT | Nombre visible del peluquero (es también su identificador). |
| `starts_at` | TEXT | `AAAA-MM-DDTHH:MM` en hora local del salón. |
| `ends_at` | TEXT | Igual, calculado con la duración del servicio. |
| `status` | TEXT | `confirmed` \| `cancelled` \| `done`. Por defecto `confirmed`. |
| `reminder_sent` | INTEGER | `1` solo si el recordatorio se envió de verdad; en modo consola no se marca. |
| `source` | TEXT | `whatsapp` \| `admin` \| `staff`. |
| `notes` | TEXT | Notas libres (pueden venir del cliente por WhatsApp). |
| `created_at`, `updated_at` | TEXT | Marcas de tiempo. |

Índices: `idx_app_start (starts_at)`, `idx_app_phone (phone)`.

Reglas asociadas:

- Las citas `confirmed` y `done` **bloquean** su tramo; `cancelled` lo libera.
- Los solapes se comprueban **por peluquero** dentro del propio `INSERT`/`UPDATE` (D1 serializa escrituras).
- No hay borrado en cascada: borrar un servicio está bloqueado si tiene citas; se recomienda desactivarlo.
- No se purgan citas automáticamente.

## `sessions` — conversaciones de WhatsApp

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | TEXT PK | Teléfono normalizado. |
| `state` | TEXT | Estado del autómata (`MENU`, `SERVICE`, `STYLIST`, `DAY`, `TIME`, `NAME`, `CONFIRM`, …). |
| `data` | TEXT | JSON con la selección en curso (servicio, peluquero, día, hora, nombre…). |
| `updated_at` | TEXT | Última actividad. |

- TTL por defecto: **720 minutos** (`settings.sessionTtlMinutes`, interno; no se edita desde Ajustes).
- El cron borra sesiones con más de **1 día** de antigüedad.

## `inbox_messages` — mensajes entrantes (Fase 2)

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | `wamid` de Meta. **Es la deduplicación**: una entrega repetida no crea fila. |
| `phone` | TEXT | Teléfono normalizado (el webhook usa `+34…`). |
| `payload` | TEXT | JSON `{ msg, profile }` tal como llegó. |
| `sequence` | INTEGER | Secuencia **por teléfono** (`MAX+1` dentro del `INSERT`). |
| `status` | TEXT | `PENDING` \| `QUEUED` \| `FAILED` \| `COMPLETED` \| `DEAD`. |
| `attempts` | INTEGER | Intentos de procesamiento (migración 0003). |
| `next_attempt_at` | TEXT | Próximo reintento; `NULL` = ya toca o terminal. |
| `last_error` | TEXT | Último error (recortado a 300). |
| `created_at`, `updated_at` | TEXT | Marcas de tiempo. |

Índices: `idx_inbox_phone_seq (phone, sequence)` UNIQUE, `idx_inbox_status (status, next_attempt_at)`, `idx_inbox_phone_status (phone, status, sequence)`.

- Solo se procesa el **primer** mensaje no terminado de cada teléfono (`firstUnfinishedInbox`); los siguientes se aplazan.
- `FAILED` reintenta con backoff 1/2/4/8 min (tope 30) y tras **5 intentos** pasa a `DEAD`, que sale del orden y ya no se reintenta; el cliente recibe un aviso.
- `COMPLETED` se conserva **7 días**; `DEAD`, **30**.

## `phone_sequences` — orden por teléfono

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | TEXT PK | Teléfono. |
| `last_processed_seq` | INTEGER | Última secuencia cerrada; se actualiza con `MAX()` en el commit atómico. |
| `last_published_seq` | INTEGER | Reservado para publicación; hoy no se usa en el flujo. |

## `sent_messages` — Outbox de respuestas

| Columna | Tipo | Notas |
|---|---|---|
| `wamid_origin` | TEXT | WAMID del mensaje que originó la respuesta (o `error:<wamid>` para avisos). |
| `message_index` | INTEGER | Índice de la respuesta dentro de ese mensaje. |
| `dest_phone` | TEXT | Destinatario. |
| `payload` | TEXT | JSON del mensaje (texto, botones o lista). |
| `status` | TEXT | `PENDING` \| `SENDING` \| `SENT` \| `FAILED` \| `UNKNOWN`. |
| `meta_status` | TEXT | Acuse de Meta: `sent`, `delivered`, `read`, `failed`… |
| `wamid_sent` | TEXT | WAMID que devolvió Meta al aceptar el envío. |
| `attempts` | INTEGER | Intentos de entrega. |
| `next_attempt_at` | TEXT | Próximo reintento; `NULL` en `FAILED`/`UNKNOWN` = terminal. |
| `last_error` | TEXT | Último error (recortado). |
| `created_at`, `updated_at` | TEXT | Marcas de tiempo. |

PK: `(wamid_origin, message_index)`.

- `UNKNOWN` = no hubo código HTTP (red/timeout): el resultado es incierto y se reintenta. `FAILED` = Meta devolvió error.
- Backoff 1/2/4/8 min hasta 5 intentos; después queda terminal (el cron no lo reenvía) para revisión manual.
- Un `SENDING` con más de 2 minutos se considera huérfano: pasa a `UNKNOWN` con reintento inmediato.
- `SENT` se conserva **30 días**.

## `phone_locks` — exclusión por teléfono

| Columna | Tipo | Notas |
|---|---|---|
| `phone` | TEXT PK | Teléfono bloqueado. |
| `worker_id` | TEXT | UUID de la ejecución que lo tomó; `''` al liberar. |
| `fencing_token` | INTEGER | **Monotónico**: se incrementa en cada adquisición y nunca se reinicia al liberar. |
| `expires_at` | TEXT | Caducidad (30 s por defecto), en ISO completo. |

- Para escribir hay que pasar `assertLock(phone, worker_id, token)`: si otro worker tomó el bloqueo, el token viejo ya no vale.
- Al liberar no se borra la fila (`expires_at` a 1970) para no reiniciar el token; el cron borra los liberados con más de 1 día.

## `processed_messages` — legado de idempotencia

| Columna | Tipo | Notas |
|---|---|---|
| `id` | TEXT PK | `wamid` del mensaje de Meta. |
| `created_at` | TEXT | Momento en que se reclamó. |

- **Ya no se usa**: la deduplicación real vive en `inbox_messages`. Se conserva por compatibilidad y el cron la limpia a los 3 días. `markMessageSeen`/`forgetMessage` son código muerto pendiente de retirar.

## `settings` — configuración del salón

Tabla clave/valor; el valor es JSON.

| Clave | Contenido | Valor por defecto en código |
|---|---|---|
| `services` | Lista de servicios (`id`, `name`, `minutes`, `price`, `active`). | 3 servicios de ejemplo. |
| `stylists` | Lista de nombres de peluqueros. | `Ana`, `Luis`. |
| `hours` | Horario general por día (`0`=lunes … `6`=domingo, vía `weekday()` de `time.ts`), con tramos. | 10:00–20:00 de lunes a sábado; domingo cerrado. |
| `stylistHours` | Horario propio por peluquero y día. | Vacío (todos siguen el general). |
| `stylistClosedDates` | Fechas de ausencia por peluquero. | Vacío. |
| `closedDates` | Días cerrados de todo el salón. | Vacío. |
| `slotMinutes` | Minutos entre huecos ofrecidos. | `15`. |
| `maxDaysAhead` | Días máximos por delante. | `30`. |
| `minNoticeMinutes` | Antelación mínima para reservar. | `60`. |
| `maxActive` | Máximo de citas activas por teléfono. | `5`. |
| `sessionTtlMinutes` | TTL de la conversación de WhatsApp. | `720`. |

Además, `salonName`, `address`, `phone` y otros datos de identidad se cargan con valores por defecto desde `wrangler.jsonc` (`SALON_*`) y se pueden sobrescribir desde Ajustes.

Reglas de horarios:

- Si un peluquero tiene **algún** día definido en `stylistHours`, los días que deje vacíos son su día libre (su horario reemplaza al general).
- Si no tiene ninguno, sigue el horario general.
- Una ausencia en `stylistClosedDates` elimina su disponibilidad ese día.

## `audit_log` — auditoría

| Columna | Tipo | Notas |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `at` | TEXT | Fecha y hora. |
| `role` | TEXT | `whatsapp` \| `staff` \| `admin`. |
| `action` | TEXT | `crear`, `editar`, `cancelar`, `realizada`, `restaurar`, `borrar`, `ajustes`, acciones de servicios/peluqueros… |
| `appt_id` | INTEGER | Cita afectada, si aplica. |
| `detail` | TEXT | Detalle legible. |

- La UI muestra los últimos **200** registros.
- El cron conserva **365 días**.
- Toda mutación (bot y paneles) escribe aquí.

## `login_attempts` — intentos de acceso

| Columna | Tipo | Notas |
|---|---|---|
| `ip` | TEXT | IP (`CF-Connecting-IP`) o `local`. |
| `at` | TEXT | Instante del intento fallido. |

- Bloqueo tras **5 fallos en 15 minutos** por IP.
- Se limpian los intentos al acertar y por cron a las **24 horas**.

## `rate_limits` — rate-limit de paneles

| Columna | Tipo | Notas |
|---|---|---|
| `key` | TEXT | `s:<cookie sid>` si hay sesión, `i:<IP>` si no. |
| `at` | TEXT | Instante de la petición aceptada. |

- Ventana deslizante de **60 segundos**: **120/min por sesión** y **60/min por IP**.
- Las peticiones rechazadas no insertan fila.
- El cron purga filas con más de **10 minutos**.

## Retención (cron cada 10 minutos)

| Dato | Se conserva |
|---|---|
| `processed_messages` (legado) | 3 días |
| `inbox_messages` `COMPLETED` | 7 días |
| `inbox_messages` `DEAD` | 30 días |
| `sent_messages` `SENT` | 30 días |
| `phone_locks` liberados/caducados | 1 día |
| `sessions` | 1 día |
| `login_attempts` | 1 día |
| `rate_limits` | 10 minutos |
| `audit_log` | 365 días |
| `appointments` | Sin purga automática |
| `settings` | Sin purga automática |

## Relaciones

No hay claves foráneas declaradas. Las relaciones son lógicas:

- `appointments.service_id` → `settings.services[].id` (puede quedar huérfano si el servicio se elimina; por eso se bloquea el borrado con citas).
- `appointments.stylist` → `settings.stylists[]` (por nombre visible).
- `sessions.phone` y `appointments.phone` → teléfono normalizado.
- `audit_log.appt_id` → `appointments.id` (puede apuntar a una cita ya borrada; el detalle conserva el nombre y la fecha).

## Copias y datos personales

- La base contiene **nombres y teléfonos de clientes**: los backups no se suben al repositorio.
- `npm run backup` exporta a `backups/backup.sql` (fuera de git); `node scripts/encrypt-backup.mjs backups/backup.sql` genera el `.sql.enc` cifrado.
- El workflow `.github/workflows/backup.yml` sube **solo** el artefacto cifrado `.sql.enc` durante 30 días y borra el SQL en claro al terminar.
- No existe borrado por cliente ni política de retención de citas implementada; ver pendientes legales en `CONFIGURACION_PELUQUERIA_REAL.md`.

Ver `RUTAS_Y_API.md` para las operaciones que modifican estos datos.
