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

## Panel sin JavaScript

Formularios + redirecciones 303 con `?ok=…`. Más seguro (CSP `default-src 'none'` sin `unsafe-inline` de scripts), accesible, y es lo que exige `test/e2e.mjs`. Sin embargo hay que confirmar acciones destructivas con páginas GET de confirmación.

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

## Sin git (estado actual)

El proyecto nunca se inicializó como repositorio. Riesgo: sin historial ni rollback. Inicializar git queda como pendiente opcional del usuario (no se hace sin pedirlo).

---

## Historial de decisiones

- 2026-10-19: todas las anteriores, tomadas al construir los paneles y el sistema de sesiones sobre el bot existente.
