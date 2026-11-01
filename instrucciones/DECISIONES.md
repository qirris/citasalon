# Decisiones técnicas (y sus motivos)

Registro de por qué el código es así. No borrar decisiones antiguas; añadir nuevas al final con fecha.

## Sesiones de panel firmadas, sin tabla

Cookie `sid=<role>.<exp>.<sig>` con HMAC de `role.exp`. No hace falta tabla de sesiones: los únicos usuarios son el salón, el rol va en la cookie y expira en 12 h. Revocar = cambiar `SESSION_SECRET`.

## `safeEqual(secret, a, b)`

Compara `a` y `b` calculando HMAC de ambos con el secreto y comparando en tiempo constante. Se usa para contraseñas (`safeEqual(ADMIN_PASSWORD, input, ADMIN_PASSWORD)`), el token de verificación de Meta y la firma del webhook. Evita oracles de tiempo.

## Fechas "de pared"

`Date` con campos UTC = hora local del salón; persistencia como texto `AAAA-MM-DDTHH:MM`. Simplifica horarios de apertura, DST y comparisons; evita conversiones de zona en D1. Ver `time.ts`.

## Choques de cita dentro del SQL

`INSERT ... WHERE NOT EXISTS (... choque ...)` y `UPDATE ... AND NOT EXISTS (...)`: D1 serializa escrituras, así que dos reservas simultáneas no pueden coger el mismo hueco sin bloqueos externos. El panel recibe `clash` y responde 409 con "solapa".

## Normalizar el teléfono TAMBIÉN en el webhook

Meta manda `34611222333`; el panel guarda `+34611222333`. Si no se normalizara en el webhook, editar una cita en el panel rompería la relación con la sesión/Citas del cliente en WhatsApp. `phone.normalizePhone` aplica en ambos lados (fallback al original si no es normalizable, para no romper el bot con números extranjeros).

## Panel HTML server-side, sin JavaScript de aplicación

Formularios + redirecciones 303 con `?ok=…`. Más seguro y accesible, y es lo que exige `test/e2e.mjs`. La CSP base (`default-src 'none'`, sin `script-src`) no permite JS. **Excepciones acotadas** (2026-10-26): dos scripts inline estáticos, cada uno en su página y con su propia CSP:
- `CSP_FORM`: selector de huecos del formulario de cita, con `connect-src 'self'` para `/slots`.
- `CSP_AGENDA`: refresco automático de la agenda, con `connect-src 'self'` para `/agenda-json`.

Cualquier página nueva con JS necesita su propia CSP con el `connect-src` necesario y debe escapar siempre los datos de cliente. Sigue siendo necesario confirmar acciones destructivas con páginas GET de confirmación.

## Borrar/restaurar solo en `/admin`

Recepción cancela (reversible) pero no borra ni restaura. Bajo `/recepcion` esas rutas directamente no existen (404), no devuelven 403, para no revelar más superficie de la necesaria.

## Login con páginas distintas por base

`/admin/login` usa `ADMIN_PASSWORD`; `/recepcion/login` usa `STAFF_PASSWORD`. Staff que visita `/admin` ve el formulario de admin (puede entrar si conoce la contraseña de admin; el e2e solo exige que aparezca "Contraseña").

## Defaults de configuración en `config.ts`

Valores razonables de peluquería (servicios, horario 10-20 lun-sáb, 15 min por hueco…) para que el bot funcione sin tocar nada; todo editable desde `/admin/ajustes` sin redeploy.

## Horarios por peluquero: reemplazo, no fusión

Cada peluquero puede tener su horario semanal (`Settings.stylistHours[peluquero][día]`) y sus vacaciones (`Settings.stylistClosedDates[peluquero]`). Regla: si el peluquero tiene **algún** día definido, los días que deje vacíos son su día libre (su horario propio reemplaza al general); si no tiene ninguno, sigue el horario general del salón. Se eligió así (en vez de fusionar) para que sea predecible y para poder expresar "solo trabaja martes y jueves". Los campos del formulario se codifican como `sh|<peluquero>|<día 0-6>` y `sc|<peluquero>` (nombre con `encodeURIComponent`), de modo que el formulario de Ajustes (sin JS) puede enviarlos todos juntos.

## Auditoría como texto con roles legibles

`role` guarda `whatsapp|staff|admin`; la UI muestra "Cliente (WhatsApp)"/"Recepción"/"Admin" (exigido por el e2e). Toda mutación (bot y paneles) escribe auditoría.

## Git y publicación (estado real, 2026-10-29)

El proyecto **sí** es un repositorio git (rama `master`, remoto privado `https://github.com/tu-usuario/citasalon`). Hay cambios locales sin commit y archivos sin trackear de las rondas del 2026-10-25/26, y la versión publicada del Worker es anterior a esos cambios. Regla: **no hacer commit, push ni deploy sin que el usuario lo pida**. El historial de commits antiguos no sustituye a `memoria.md`; la memoria y el código local son la referencia del estado actual.

---

## Historial de decisiones

- 2026-10-19: todas las anteriores, tomadas al construir los paneles y el sistema de sesiones sobre el bot existente.
- 2026-10-22 (FASE 1):
  - **Eliminar secreto por defecto en sesiones**: `SESSION_SECRET` ahora es obligatorio; si falta, el sistema lanza error (evita sesiones predecibles). Antes usaba `"sin-secreto"` como fallback.
  - **CSRF en todas las mutaciones**: validación de `Origin` en `/nueva`, `/cita/`, `/ajustes` (además de login). Defiende contra CSRF aunque `SameSite=Strict` ya lo mitiga.
  - **Validación de fechas pasadas y `slotMinutes`**: el panel rechaza citas en el pasado y horas no alineadas al intervalo configurado.
  - **WhatsApp simulado distinguido**: `SendResult` con campo `simulated`. En modo consola no se marcan recordatorios como enviados.
  - **Mensajes marcados tras procesar**: `markMessageSeen` se ejecuta después del procesamiento completo (evita perder mensajes si falla el envío).
- 2026-10-23 (decisión técnica):
  - **`sessionTtlMinutes` se mantiene interno**: solo controla el tiempo de inactividad de las conversaciones de WhatsApp (`db.getSession` en `bot.ts` con valor por defecto 720 min). **No** afecta a las sesiones de `/admin`/`/recepcion`: esas usan cookies firmadas con caducidad fija de 12 h en `src/auth.ts` (`SESSION_MS`). Exponerlo en Ajustes induciría confusión y carece de necesidad operativa; se descarta añadirlo al formulario.
- 2026-10-23 (Fase 1: Peluqueros):
  - **Reutilizar `Settings.stylists` y mecanismos existentes**: la fase 1 de Peluqueros añade rutas de lectura/escritura en `/recepcion/peluqueros` sin modificar el modelo de datos, autenticación, CSRF, auditoría ni persistencia. Los peluqueros se guardan en `Settings.stylists` (array de strings, compatible con la arquitectura existente). Las validaciones (no vacío, sin duplicados case-insensitive) se aplican en servidor. La persistencia usa `loadSettings`/`saveSettings` existentes, conservando otros ajustes del salón. CSRF se protege con `badOrigin` check existente. Auditoría registra `crear_peluquero` en `audit_log`. No se añade gestión de horarios, ausencias ni desactivación en esta fase (futuras fases).
- 2026-10-23 (Editor de horarios de Peluqueros):
  - **Editor visual de horarios por peluquero en `/recepcion`**: implementación de la ruta `/recepcion/peluqueros/:name/horario` (GET y POST) usando `Settings.stylistHours`. Cada día de la semana permite configurar hasta dos franjas horarias (turno partido) mediante inputs nativos de tipo `time`, adaptados para uso móvil sin requerir sintaxis compleja. Validación en servidor estricta: formato correcto, hora inicial anterior a la final, y ausencia de solapamientos entre franjas del mismo día. Auditoría con acción `editar_horario_peluquero`. Integración directa con `freeSlots()` y validaciones de reservas existentes.
- 2026-10-23 (Verificación E2E de conservación de citas):
  - **Robustez en la preparación de pruebas E2E con estado compartido**: Al ejecutar pruebas de integración que acumulan datos en el mismo día (`DAY`) a lo largo de múltiples secciones de la suite, los tests dependientes de horarios y horas específicas deben configurar explícitamente el horario inicial del trabajador (evitando estados vacíos) y seleccionar horas libres que no colisionen con reservas previas de otras pruebas anteriores (ej. empleando `11:00` en vez de `10:00` y servicios válidos vigentes como `"corte"`). Esto garantiza que la aserción evalúe puramente la lógica de conservación de citas sin interferencias de datos residuales.
- 2026-10-23 (Inicialización robusta del selector de huecos):
  - **Inicialización determinista en cliente**: Para garantizar que los selectores de huecos se carguen correctamente incluso si el script JS se ejecuta antes de que el DOM esté completo, se implementó una inicialización robusta basada en `document.readyState` y el evento `DOMContentLoaded`. Además, se incorporó un contador de secuencia (`seq`) en la función de carga asíncrona para descartar respuestas `fetch` obsoletas ante cambios rápidos del usuario, previniendo condiciones de carrera en la interfaz.
- 2026-10-26 (Elección de peluquero en el bot):
  - **El cliente elige peluquero antes de la fecha**: se añade el estado `STYLIST` entre `SERVICE` y `DAY`. Motivo: el usuario comprobó que el bot no preguntaba y asignaba en silencio. Se reutiliza `freeSlots`/`daysWithAvailability` con `onlyStylist` (ya existían) en vez de duplicar lógica de disponibilidad.
  - **Solo se ofrecen peluqueros con horario semanal** (`bookableStylists`): no hay campo «activo» en `Settings`, así que un peluquero sin ningún tramo de trabajo se considera no disponible y no se muestra ni se asigna.
  - **«Me da igual» = `stylist: null`**: la asignación final sigue usando `workingStylists` (quien trabaja el tramo exacto y no está ausente). Esto conserva la garantía de la decisión anterior y evita asignar a alguien fuera de horario o ausente.
  - **La elección nunca se cambia en silencio**: si el peluquero elegido se queda sin huecos, se explica y se vuelve a mostrar la lista de peluqueros; no se sustituye automáticamente por otro.

## 2026-10-26 (decisiones verificadas en la ronda de panel y bot)

- **Idempotencia por `wamid` antes de procesar**: `processed_messages` se reclama con `INSERT OR IGNORE` **antes** de procesar el mensaje; si el envío falla, `forgetMessage` libera el id para que el reintento de Meta se procese en vez de descartarse. Ver A.2e/A.2c. La decisión FASE 1 de marcar tras procesar queda **superseded** (ver `SEGURIDAD.md`).
- **Estado `done` (Realizada)**: nuevo valor `done` en `Appt.status` (`src/types.ts`), comentario en `schema.sql`, `setStatus(..., "done", ...)` en `src/db.ts`. Botón «Marcar como realizada» con CSRF, página de confirmación GET, badge verde, clase `.realizada`, contadores en HTML/JS/`/agenda-json`/CSV e informes (ingresos = `confirmed` + `done`, sin duplicar ni como canceladas). ~~No se implementaron las plantillas de WhatsApp de cancelación/modificación (pendientes de autorización).~~ **Actualizado el 2026-10-30**: ambas plantillas están integradas en `src/notices.ts` y conectadas a cancelar/editar de los paneles; idioma `es_ES` confirmado en Meta (IDs `<ID_PLANTILLA_CANCELACION>` y `<ID_PLANTILLA_ACTUALIZACION>` como referencia); la entrega real no está verificada.
- **Filtros de agenda para `done`**: `freeSlots` y `createAppointment`/`updateAppointment` consultan `status IN ('confirmed','done')` para solapamientos; `appointmentsForDay` filtra `status != 'cancelled'` (las realizadas permanecen en la agenda de recepción).
- **CSP por página, no global**: cada página con JavaScript tiene su propia CSP. `CSP_FORM` (selector de huecos, `connect-src 'self'` para `/slots`) y `CSP_AGENDA` (refresco automático, `connect-src 'self'` para `/agenda-json`). La CSP base (`default-src 'none'`, sin `script-src`) sigue usándose en páginas sin JS. Regla: cualquier nueva página con JS necesita su CSP con el `connect-src` que necesite y **escapar siempre** los datos de cliente (nombre, notas) dentro del script.
- **`isValidDay` tolerante a fechas imposibles**: devuelve `false` (en vez de lanzar 500 por `toISOString()` sobre `Invalid Date`), cayendo al día de hoy como el código pretendía.
- 2026-10-29 (organización documental):
  - **Separar reglas de trabajo y guías para personas**: `instrucciones/` contiene solo reglas de trabajo; las guías (`PUESTA_EN_MARCHA.md`, `CONFIGURACION_PELUQUERIA_REAL.md`, `AUDITORIA_TEXTOS_FIJOS.md`) viven en `docs/`, junto al índice y las referencias técnicas.
  - **El histórico no se reescribe**: memorias antiguas, auditorías, correcciones y salidas de pruebas se conservan en `archivos_historicos/` con un `README.md` que explica rutas y cifras antiguas. El código antiguo sin proyecto ejecutable se conserva en `../versiones_anteriores/`.
