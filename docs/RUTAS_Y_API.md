# Rutas y API

Inventario de las rutas HTTP que sirve el Worker. Verificado contra `src/index.ts` y `src/panels.ts` el 2026-10-29.

- Ninguna ruta es multi-tenant: **un despliegue atiende a un solo salón**.
- Todos los paneles responden HTML (salvo las rutas JSON indicadas) con `cache-control: no-store`.
- Los formularios mutantes usan `POST` + redirección `303` con `?ok=…` y validan `Origin` (CSRF).

## Rutas públicas

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` | `/health` | `{"ok":true}`. Útil para comprobaciones y CI. |
| `GET` | `/webhook` | Verificación del webhook de Meta (`hub.verify_token` contra `VERIFY_TOKEN`). |
| `POST` | `/webhook` | Recepción de mensajes de WhatsApp; valida `X-Hub-Signature-256` si existe `APP_SECRET`. |
| `GET` | `/manifest.json` | Manifest PWA generado con los datos del salón. |
| `GET` | `/icon-192.png`, `/icon-512.png` | Iconos PWA (hoy placeholders de 1×1 px). |
| `GET` | `/qr` | Cartel público con QR hacia `wa.me`. |
| `GET` | `/qr-recepcion` | Cartel de recepción con QR a `/recepcion` del host actual. |
| `GET` | `/` | Redirige a `/admin/`. |

## Paneles: rutas comunes

Sustituye `{base}` por `/admin` o `/recepcion`.

| Método | Ruta | Permiso | Qué hace |
|---|---|---|---|
| `GET` | `{base}/login` | Público | Formulario de acceso. |
| `POST` | `{base}/login` | Público | Valida contraseña, crea cookie de sesión y redirige. |
| `POST` | `{base}/logout` | Sesión | Cierra sesión. |
| `GET` | `{base}/` o `{base}` | Admin / staff | Agenda del día (`?date=AAAA-MM-DD`, `?stylist=`, `?cancelled=1` solo admin). |
| `GET` | `{base}/agenda-json` | Admin / staff | JSON de la agenda para el refresco automático (mismos filtros que la agenda). |
| `GET` | `{base}/nueva` | Admin / staff | Formulario de cita nueva. |
| `POST` | `{base}/nueva` | Admin / staff | Crea cita. `303` si va bien; `409` si solapa; `422` si los datos no son válidos. |
| `GET` | `{base}/slots` | Admin / staff | JSON `{ slots: ["HH:MM", …] }` para el selector de huecos. Parámetros: `date`, `service_id`, `stylist`, `exclude`. |
| `GET` | `{base}/citas` | Admin / staff | Buscador por nombre o teléfono (`?q=`). |
| `GET` | `{base}/cita/{id}` | Admin / staff | Formulario de edición de la cita. |
| `POST` | `{base}/cita/{id}` | Admin / staff | Guarda cambios de la cita. |
| `GET` | `{base}/cita/{id}/realizada` | Admin / staff | Confirmación «¿Marcar como realizada?». |
| `POST` | `{base}/cita/{id}/realizada` | Admin / staff | Marca la cita como `done`. |
| `GET` | `{base}/cita/{id}/cancelar` | Admin / staff | Confirmación de cancelación. |
| `POST` | `{base}/cita/{id}/cancelar` | Admin / staff | Cancela la cita. |
| `GET` | `{base}/servicios` | Admin / staff | Listado de servicios (activos e inactivos). |
| `GET` / `POST` | `{base}/servicios/nuevo` | Admin / staff | Alta de servicio. |
| `GET` / `POST` | `{base}/servicios/{id}` | Admin / staff | Edición de servicio. |
| `POST` | `{base}/servicios/{id}/activar` | Admin / staff | Activa el servicio. |
| `POST` | `{base}/servicios/{id}/desactivar` | Admin / staff | Desactiva el servicio (no lo borra). |
| `GET` / `POST` | `{base}/servicios/{id}/borrar` | Admin / staff | Borra el servicio solo si no tiene citas y no es el último. `409` si no se puede. |
| `GET` | `{base}/peluqueros` | Admin / staff | Listado de peluqueros. |
| `GET` / `POST` | `{base}/peluqueros/nuevo` | Admin / staff | Alta de peluquero. |
| `GET` | `{base}/peluqueros/{nombre}/horario` | Admin / staff | Editor de horario semanal del peluquero. |
| `POST` | `{base}/peluqueros/{nombre}/horario` | Admin / staff | Guarda horario semanal. |
| `GET` | `{base}/peluqueros/{nombre}/ausencias` | Admin / staff | Ausencias/vacaciones del peluquero. |
| `POST` | `{base}/peluqueros/{nombre}/ausencias/dia` | Admin / staff | Añade una ausencia de un día. |
| `POST` | `{base}/peluqueros/{nombre}/ausencias/periodo` | Admin / staff | Añade un periodo de ausencia. |
| `POST` | `{base}/peluqueros/{nombre}/ausencias/borrar` | Admin / staff | Borra una ausencia. |

## Rutas exclusivas de `/admin`

| Método | Ruta | Qué hace |
|---|---|---|
| `GET` / `POST` | `/admin/cita/{id}/restaurar` | `GET` muestra una página de confirmación **sin modificar datos**; `POST` restaura la cita cancelada si el hueco sigue libre (`409` si está ocupado). Solo admin. El enlace de confirmación está en la página de **edición** de la cita (`src/panels.ts:2480`), no en la agenda; la agenda usa formularios `POST` con CSRF. |
| `GET` / `POST` | `/admin/cita/{id}/borrar` | Borrado definitivo con confirmación. |
| `GET` | `/admin/ajustes` | Formulario de ajustes del salón. |
| `POST` | `/admin/ajustes` | Guarda ajustes (`422` con errores concretos). |
| `GET` | `/admin/historial` | Últimas 200 acciones de `audit_log`. |
| `GET` | `/admin/informes` | Informe por periodo (`?from=`, `?to=`). |
| `GET` | `/admin/informes.csv` | Export CSV del mismo periodo. |

Bajo `/recepcion`, las rutas de admin (restaurar, borrar, ajustes, informes e historial) **no están disponibles para sesiones de recepción** y devuelven `404`. Una sesión de **admin** conserva su rol aunque navegue bajo `/recepcion`, así que esas rutas siguen funcionando para ella: el control se basa en el rol de la sesión, no en el prefijo de la URL.

## Parámetros de consulta relevantes

| Parámetro | Dónde | Efecto |
|---|---|---|
| `date=AAAA-MM-DD` | Agenda | Día mostrado. Si no es válido, cae al día de hoy. |
| `stylist=<nombre>` | Agenda y `agenda-json` | Filtra por peluquero (el nombre visible es el identificador). |
| `cancelled=1` | Agenda de `/admin` | Muestra también las citas canceladas. |
| `q=<texto>` | `/citas` | Busca en nombre y teléfono. |
| `from`, `to` | `/admin/informes*` | Rango del informe. |
| `ok`, `err`, `msg` | Varias | Mensajes flash por redirección. |

## Respuestas y códigos

| Código | Significado |
|---|---|
| `200` | Correcto. |
| `303` | Acción completada; redirección con `?ok=`. |
| `401` | `POST` sin sesión válida. |
| `404` | Recurso o ruta inexistente (incluye rutas de admin bajo recepción para sesiones de recepción). |
| `409` | Conflicto: solape de cita, restaurar sobre hueco ocupado, borrar servicio con citas. |
| `422` | Datos no válidos; se vuelve a mostrar el formulario con errores. |
| `429` | Rate-limit o bloqueo de login (`Retry-After: 60`). |
| `500` | Error no controlado (se registra en el log del Worker). |

## Cabeceras de seguridad

- HTML de paneles: CSP restrictiva por página (`CSP`, `CSP_FORM` y `CSP_AGENDA`), `frame-ancestors 'none'`, `base-uri 'none'`. La CSP base incluye `manifest-src 'self'` para que el manifest de la PWA de recepción no quede bloqueado por `default-src 'none'`; `CSP_FORM` y `CSP_AGENDA` lo heredan al derivarse de `CSP`.
- `cache-control: no-store` en todas las respuestas HTML de panel y en los JSON de agenda/huecos.
- Cookies de sesión: `HttpOnly; SameSite=Strict; Path=/`, `Secure` cuando la petición es HTTPS.

Ver `../instrucciones/SEGURIDAD.md` para el detalle de sesiones, CSRF y rate-limit.
