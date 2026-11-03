# Configuración de una peluquería real

Guía central para el día en que tengamos el primer salón cliente. Recoge **qué datos pedir**, **qué decisiones tomar**, **qué tareas técnicas hacer** y **qué verificar** antes de poner el bot en producción.

> Estado: documento de preparación. Todavía **no hay una peluquería concreta** y no se han inventado datos comerciales.
>
> Este documento no sustituye a `PUESTA_EN_MARCHA.md`: allí está la secuencia de comandos; aquí está la recopilación de información, las decisiones y la checklist de personalización.

## Cómo usar este documento

1. El propietario rellena las plantillas de `datos-salon/` (`01-salon.md`, `02-peluqueros.md`, `03-servicios.md`).
2. Con esos datos, completamos la checklist de este documento y resolvemos las decisiones pendientes.
3. Aplicamos los cambios técnicos en local, verificamos y solo después desplegamos.
4. Guardamos los secretos en Cloudflare; **nunca** en este documento, en `memoria.md` ni en el repositorio.

### Leyenda

| Código | Significado |
|---|---|
| **D** | Dato que debe facilitar el propietario. |
| **DEC** | Decisión que debe tomar el propietario (o el responsable del salón). |
| **T** | Tarea técnica que hacemos nosotros. |
| **V** | Verificación necesaria antes de producción. |

## Arquitectura actual y límites

- **Un salón = un Worker + una base D1 + un conjunto de secretos.** No existe multi-tenant ni `business_id`; dos salones en el mismo despliegue compartirían datos.
- Si el negocio tiene **varias sucursales**, la opción actual es un despliegue independiente por sucursal (mismo código, distinta D1, distintas variables y secretos). El multi-salón dentro de una sola instalación **no está implementado**.
- Los datos del salón se guardan en dos sitios:
  - `wrangler.jsonc` → variables no secretas que se leen al arrancar (`SALON_*`, `WHATSAPP_*`, etc.).
  - Tabla `settings` de D1 → datos editables desde `/admin/ajustes`.
- **Precedencia de Configuración:** Los valores en la base de datos D1 tienen **precedencia absoluta**.
  - Si una clave (ej. `salonName`) existe en D1, se ignorará siempre el valor de `wrangler.jsonc`.
  - Si la clave **no existe** en D1 (tabla vacía al inicio), se utiliza el valor de la variable de entorno.
  - Una clave en D1 que contenga un valor vacío sigue teniendo precedencia (se usará el valor vacío).
- Los secretos viven en Cloudflare (`wrangler secret put`) o en `.dev.vars` para local. **No se copian en este documento.**
- El panel es HTML server-side sin JavaScript de aplicación. Solo hay dos excepciones acotadas, cada una en su página y con su propia CSP: el selector de huecos del formulario de cita (`CSP_FORM`) y el refresco automático de la agenda (`CSP_AGENDA`). Los textos y colores están en el código y no tienen editor visual.

---

## 1. Identidad y apariencia

| Elemento | Tipo | Dónde se configura | Notas / verificación |
|---|---|---|---|
| Nombre comercial exacto | **D** + **DEC** | `SALON_NAME` en `wrangler.jsonc` y `/admin/ajustes` | Debe ser el nombre que el propietario quiere ver en WhatsApp, paneles, QR y PWA. La versión de `/admin/ajustes` manda sobre la variable de entorno. **V:** no queda “Peluqueria Ejemplo”. |
| Nombre corto para la PWA | **DEC** | `src/pwa.ts` (`short_name`) | Hoy se genera automáticamente recortando `salonName` a 12 caracteres. Si el propietario quiere otro, hay que tocar código. **V:** revisar `/manifest.json`. |
| Logo del salón | **D** | No hay campo de logo en la aplicación | El panel no muestra logo; solo usa el nombre. Si se quiere logo en cabecera o login, es un cambio de código no implementado. |
| Iconos PWA 192×192 y 512×512 | **D** + **T** | `src/pwa.ts` (`ICON_192_BASE64`, `ICON_512_BASE64`) | Los actuales son PNG reales de 192×192 y 512×512 (genéricos, no el logo del salón). Sustituir por el logo cuadrado, con margen seguro para `maskable`, y actualizar `public/icon-192.png`/`icon-512.png` (las pruebas comparan ambos). **V:** `/icon-192.png` y `/icon-512.png` devuelven PNG con las dimensiones correctas y coinciden con `public/`. |
| Favicon / icono de pestaña | **T** | `src/index.ts` y `panels.ts` | Se reutilizan los mismos PNG. No hay `apple-touch-icon` específico. |
| Colores de la interfaz | **DEC** + **T** | `src/panels.ts` (CSS) y `src/pwa.ts` (`theme_color`, `background_color`) | No hay editor de tema. Cambiar la paleta exige tocar CSS/código. Si el salón no exige marca propia, se puede mantener la paleta actual. |
| Imágenes, fondos o fotografías | **DEC** | No implementado | No hay subida de imágenes ni galería. No prometerlo sin desarrollo previo. |
| Textos de la aplicación | **DEC** + **T** | `src/bot.ts`, `src/reminders.ts`, `src/panels.ts`, `src/pwa.ts` | La interfaz y los mensajes están en español y escritos en el código. No hay plantillas editables desde el panel. Revisar nombres, tuteo y tono con el propietario. |
| Nombre en mensajes del bot | **D** | `settings.salonName` / `SALON_NAME` | Aparece en saludo, información del salón, confirmación y recordatorio. **V:** probar un mensaje de bienvenida y otro de confirmación. |
| Nombre en paneles y QR | **D** | `settings.salonName` / `SALON_NAME` | Aparece en títulos, cabecera, `/qr` y `/qr-recepcion`. **V:** revisar ambos carteles. |

### Pendiente de decisión

- ¿El salón quiere una identidad visual propia (logo, colores, tipografía) o acepta la plantilla actual?
- Si quiere logo en el panel, hay que añadir un campo/archivo y rutas; hoy no existe.
- Si quiere iconos PWA reales, necesitamos su logo cuadrado en buena resolución.

---

## 2. Información del establecimiento

| Elemento | Tipo | Dónde se configura | Notas / verificación |
|---|---|---|---|
| Dirección completa | **D** | `SALON_ADDRESS` y `/admin/ajustes` | Se muestra en el bot (`Horario y dirección`), panel, `/qr` y `/qr-recepcion`. **V:** revisar que no sea la dirección de ejemplo. |
| Teléfono público | **D** | `SALON_PHONE` y `/admin/ajustes` | Se muestra en el bot y en los carteles. Es informativo. **V:** probar el mensaje “Horario y dirección”. |
| Teléfono de WhatsApp | **D** | `WHATSAPP_NUMBER` en `wrangler.jsonc` | Se usa para generar el enlace `wa.me` del cartel `/qr`. Debe ser el número real de la cuenta de Business sin el símbolo `+`. |
| ID del teléfono (Meta) | **D** | `WHATSAPP_PHONE_ID` en `wrangler.jsonc` | Identificador técnico interno de Meta. No confundir con el número de teléfono. |
| Email, web o redes sociales | **DEC** | No implementado | Hoy el bot solo muestra dirección y teléfono. Añadirlos requiere código y revisar los textos. |
| Zona horaria | **D** + **DEC** | `SALON_TZ` en `wrangler.jsonc` | Por defecto `Europe/Madrid`. **No** se edita desde `/admin/ajustes`; cambiarla exige modificar configuración y desplegar. **V:** comprobar que “hoy/mañana” y las horas coinciden con el salón. |
| Horario general de apertura | **D** | `/admin/ajustes` → `hours` | Un tramo por día con formato `HH:MM-HH:MM`; varios tramos separados por ` y `. Día vacío = cerrado. **V:** el bot solo ofrece horas dentro del horario. |
| Descansos intradía | **D** | `/admin/ajustes` → tramos del día | No hay entidad de “descanso”; se representa partiendo el día en dos tramos (por ejemplo, `10:00-14:00 y 16:00-20:00`). **V:** comprobar que no se ofrecen horas durante el descanso. |
| Horario propio de cada peluquero | **D** | `/admin/ajustes` → tarjeta «Horario de <peluquero>» | Si se rellena algún día, los días vacíos son su día libre; si se deja todo vacío, sigue el horario general. **V:** crear una cita fuera de su horario y comprobar que se rechaza. |
| Vacaciones o festivos por peluquero | **D** | `/admin/ajustes` → «Vacaciones de <peluquero>» | Una fecha `AAAA-MM-DD` por línea. **V:** el bot no ofrece ese día para ese peluquero. |
| Días cerrados de todo el salón | **D** | `/admin/ajustes` → «Días cerrados» | Una fecha `AAAA-MM-DD` por línea. No hay festivos recurrentes automáticos. **V:** el bot no ofrece huecos ese día. |
| Sucursales | **DEC** | No implementado | Un despliegue por sucursal. Si el propietario tiene varias, decidir si se hacen instalaciones separadas. **V:** confirmar que no se comparten D1 ni secretos. |
| Mapa o enlace de ubicación | **DEC** | No implementado | Solo se muestra la dirección en texto. Añadir un enlace requiere código. |

### Pendiente de decisión

- ¿Horario de verano/invierno? Hoy se cambia a mano en Ajustes.
- ¿Festivos recurrentes (por ejemplo, todos los 25 de diciembre)? Hoy hay que añadir cada fecha.
- ¿Varias sucursales? Confirmar que se acepta una instalación independiente por sucursal.

---

## 3. Servicios y personal

| Elemento | Tipo | Dónde se configura | Notas / verificación |
|---|---|---|---|
| Lista de servicios | **D** | `/admin/ajustes` → `services` | Una línea por servicio: `id | nombre | minutos | precio`. **V:** el bot muestra exactamente esos servicios y precios. |
| Identificador interno (`id`) | **T** | `/admin/ajustes` | Sin espacios ni tildes, único y estable. No cambiarlo después si hay citas históricas: los informes y las citas guardan `service_id`/`service_name`. |
| Precio | **D** | `/admin/ajustes` | Es texto libre (`25 €`). Los informes usan el precio **actual** del servicio, no el precio histórico de la cita. **V:** revisar el informe con un servicio conocido. |
| Duración | **D** | `/admin/ajustes` | Minutos enteros; determina si el servicio cabe en un hueco. **V:** un servicio de 90 min no debe ofrecerse si solo quedan 45. |
| Condiciones, señales o packs | **DEC** | No implementado | No hay pagos, señales, bonos ni condiciones por servicio. No prometerlo sin desarrollo. |
| Nombres de peluqueros | **D** | `/admin/ajustes` → `stylists` | Lista separada por comas. Son solo nombres; no hay cuentas individuales ni IDs de empleado. **V:** aparecen en el formulario de cita y en los informes. |
| Horario y vacaciones por peluquero | **D** | `/admin/ajustes` | Ver sección 2. **V:** probar una cita con cada peluquero. |
| Servicios que realiza cada peluquero | **DEC** | No implementado | Hoy **todos** los peluqueros pueden realizar **todos** los servicios. Si el salón necesita especialidades, hay que añadir una relación peluquero-servicio. |
| Asignación de peluquero | **DEC** | Comportamiento actual (2026-10-26) | El **cliente elige** peluquero en el bot (paso `STYLIST`): se le ofrecen solo los peluqueros con horario semanal y una opción «Me da igual / el primero disponible»; la elección se respeta en días, horas, confirmación y la cita. Con «me da igual» se asigna el primero libre entre los que trabajan ese tramo exacto y no están ausentes. En los paneles se puede fijar uno al crear/editar. |
| Descansos o pausas | **D** | `/admin/ajustes` | Se representan partiendo el horario en tramos; no hay pausas configurables independientes. |
| Usuarios individuales de recepción | **DEC** | No implementado | Solo hay una contraseña compartida `STAFF_PASSWORD`; no hay usuarios ni auditoría por persona. |
| Comisiones, nóminas o productividad | **DEC** | No implementado | Los informes agrupan por peluquero, pero no calculan comisiones. |

### Pendiente de decisión

- ¿Todos los peluqueros hacen todos los servicios? Si no, hay que desarrollar la relación peluquero-servicio.
- ¿El cliente debe poder elegir peluquero en WhatsApp? **Ya puede** (paso `STYLIST`, 2026-10-26). Queda pendiente la relación servicio↔peluquero (hoy todos pueden hacer todos).
- ¿Se necesitan condiciones especiales (señal, cancelación tardía, descuentos)? Hoy no existen.

---

## 4. Reservas y comunicación

| Elemento | Tipo | Dónde se configura | Notas / verificación |
|---|---|---|---|
| Minutos por hueco | **D** + **DEC** | `/admin/ajustes` → `slotMinutes` | Entre 5 y 120. Define cada cuántos minutos se ofrecen horas. **V:** las horas ofrecidas son múltiplos de ese valor. |
| Días máximos por delante | **D** + **DEC** | `/admin/ajustes` → `maxDaysAhead` | Entre 1 y 90. **V:** el bot no ofrece días fuera del rango. |
| Antelación mínima | **D** + **DEC** | `/admin/ajustes` → `minNoticeMinutes` | Entre 0 y 10080 minutos. **V:** no se puede reservar con menos antelación. |
| Citas máximas por cliente | **D** + **DEC** | `/admin/ajustes` → `maxActive` | Entre 1 y 20 citas activas por teléfono. **V:** al superar el límite, el bot avisa. |
| Duración de la conversación | **T** | `settings.sessionTtlMinutes` | Existe en `Settings` y en `saveSettings`, pero **no hay campo en el formulario de Ajustes**. Por defecto 720 min. Si el propietario necesita cambiarlo, hoy hay que tocar código o la base de datos. |
| Mensaje de bienvenida y menú | **DEC** + **T** | `src/bot.ts` (`msgMenu`) | Texto fijo en español; incluye el nombre del salón. No hay plantillas editables. Revisar tono y palabras con el propietario. |
| Mensajes de servicio, día, hora, nombre y confirmación | **DEC** + **T** | `src/bot.ts` | Textos fijos. La confirmación incluye servicio, precio, fecha, hora, nombre, dirección y peluquero asignado. **V:** probar una reserva completa. |
| Mensajes de “Mis citas” y cancelación | **DEC** + **T** | `src/bot.ts` | El cliente solo ve y cancela sus propias citas; no puede modificar ni cancelar citas ajenas. La reprogramación de citas propias sí existe desde 2026-10-26 (ver la fila «Reprogramación desde WhatsApp»). **V:** cancelar una cita propia y comprobar que se libera el hueco. |
| Recordatorio automático | **DEC** | `src/reminders.ts` y `REMINDER_TEMPLATE` | Se envía a citas confirmadas en las próximas 24 h, reservadas con más de 24 h de antelación. Si no hay plantilla, se envía texto libre; fuera de la ventana de 24 h de Meta, el texto libre puede rechazarse. **V:** probar en local y, si hay WhatsApp real, con plantilla aprobada. |
| Plantilla de recordatorio de Meta | **DEC** + **T** | `REMINDER_TEMPLATE` y `REMINDER_TEMPLATE_LANG` en `wrangler.jsonc` | Si el salón quiere recordatorios fuera de la ventana de 24 h, se necesita una plantilla aprobada por Meta. **Nunca** guardar tokens en el repositorio. |
| Número de WhatsApp público | **D** | `WHATSAPP_NUMBER` en `wrangler.jsonc` | Se usa para el enlace `wa.me` del cartel `/qr`. Formato internacional sin `+` (por ejemplo, `34600111222`). **V:** el QR abre el número correcto. |
| ID del número de WhatsApp Business | **D** + **T** | `WHATSAPP_PHONE_ID` en `wrangler.jsonc` | Lo proporciona Meta. **V:** el envío real funciona con el número correcto. |
| App de Meta y webhook | **T** | Panel de Meta + secretos | Requiere app de WhatsApp Business, número verificado, URL de webhook `<tu-url>/webhook`, token de verificación y suscripción a `messages`. **V:** Meta valida el webhook y llega un mensaje real. |
| Token de verificación | **T** | `VERIFY_TOKEN` (secreto) | Lo elige el propietario o lo generamos; debe ser único y no estar publicado en la documentación. **No** usar valores por defecto. |
| App Secret de Meta | **T** | `APP_SECRET` (secreto) | Valida la firma `X-Hub-Signature-256`. Sin él, el webhook no valida la firma; no activar WhatsApp real sin este secreto. |
| Token de acceso de WhatsApp | **T** | `WHATSAPP_TOKEN` (secreto) | Sin él, el bot funciona en modo consola y no envía mensajes reales. |
| Textos del panel de administración y recepción | **DEC** + **T** | `src/panels.ts` | Etiquetas, avisos y páginas están en español y en el código. Revisar si el salón quiere otros nombres (por ejemplo, “Recepción” vs. “Mostrador”). |
| Avisos al propietario o al personal | **DEC** | No implementado | No hay notificación al propietario/personal de cita nueva o cancelada; solo la agenda y el historial. El aviso de confirmación implementado va al **cliente**. Si se quieren avisos internos, es desarrollo nuevo. |
| Reprogramación desde WhatsApp | **DEC** | **Implementado (2026-10-26; flujo ajustado el 2026-10-30)** | El cliente puede reprogramar sus propias citas desde WhatsApp («Mis citas» → `menu:manage` → `appt:<id>` → botón «Reprogramar» `resched:yes` → nuevo día/hora con `freeSlots()` excluyendo la cita → confirmación → revalidación en servidor). Se conservan servicio, peluquero y notas; un hueco ocupado no se ofrece y forzarlo se rechaza; un tercero que ocupe el hueco entre la elección y el confirmar produce «Ese hueco ya no está disponible» sin tocar la cita original. Ver `../memoria.md` §6 y `../instrucciones/TAREAS_PENDIENTES.md`. |
| Avisos de cancelación y actualización | **DEC** + **T** | `src/notices.ts`, `src/panels.ts`, `CANCEL_TEMPLATE`/`UPDATE_TEMPLATE` en `wrangler.jsonc` | Cancelar desde admin/recepción envía `aviso_cita_cancelada` (servicio, fecha, hora) solo si se guardó; editar envía `aviso_cita_actualizada` (servicio, fecha, hora, peluquero) solo si se guardó y cambió fecha/hora, servicio o peluquero. No se avisa en fallos ni `409`, ni se duplica. Configuración confirmada en Meta: idioma `es_ES`, IDs `<ID_PLANTILLA_CANCELACION>` (cancelación) y `<ID_PLANTILLA_ACTUALIZACION>` (actualización), conservados como referencia; `sendTemplate()` usa el nombre. La entrega real no está verificada. |
| Confirmación de reserva creada desde panel | **DEC** + **T** | `src/notices.ts`, `src/panels.ts`, `CREATE_TEMPLATE`/`CREATE_TEMPLATE_LANG` en `wrangler.jsonc` | Crear una cita desde admin o recepción envía una única confirmación al cliente (servicio, fecha, hora, peluquero) solo si la cita se guardó. Sin teléfono, sin plantilla configurada o con error de Meta la cita se guarda igual y no se envía nada. **La plantilla `aviso_cita_creada` todavía no existe en Meta**: `CREATE_TEMPLATE` está vacío a propósito. Pasos para activarla en «Plantilla de Meta pendiente». |

### Pendiente de decisión

- ¿Se activa WhatsApp desde el primer día o se empieza en modo consola?
- ¿Se usan recordatorios? ¿Con plantilla aprobada o solo texto libre?
- ¿Se quieren avisos al personal? Hoy no existen.
- ¿Se permite cancelar hasta el último momento? Hoy sí, sin límite.
- ~~¿Se quiere reprogramación desde el bot? Hoy no existe.~~ **Resuelto el 2026-10-26**: sí existe para citas propias (ver la fila «Reprogramación desde WhatsApp»).

---

## 5. Configuración técnica por establecimiento

### Variables no secretas (`wrangler.jsonc`)

| Variable | Para qué sirve | Se cambia por salón |
|---|---|---|
| `SALON_NAME` | Nombre por defecto del salón. | Sí |
| `SALON_ADDRESS` | Dirección por defecto. | Sí |
| `SALON_PHONE` | Teléfono público por defecto. | Sí |
| `SALON_TZ` | Zona horaria (`Europe/Madrid` por defecto). | Sí, si el salón está en otra zona |
| `WHATSAPP_PHONE_ID` | ID del número de WhatsApp Business. | Sí |
| `WHATSAPP_NUMBER` | Número para el enlace `wa.me` del QR. | Sí |
| `GRAPH_VERSION` | Versión de la Graph API de Meta. | Normalmente no |
| `REMINDER_TEMPLATE` | Nombre de la plantilla aprobada de recordatorio. | Solo si se usa plantilla |
| `REMINDER_TEMPLATE_LANG` | Idioma de la plantilla (`es` por defecto). | Solo si se usa plantilla |
| `CANCEL_TEMPLATE` | Nombre de la plantilla de cancelación (`aviso_cita_cancelada`). | Solo si se usa plantilla |
| `CANCEL_TEMPLATE_LANG` | Código de idioma registrado en Meta: `es_ES` (confirmado). | Sí |
| `UPDATE_TEMPLATE` | Nombre de la plantilla de actualización (`aviso_cita_actualizada`). | Solo si se usa plantilla |
| `UPDATE_TEMPLATE_LANG` | Código de idioma registrado en Meta: `es_ES` (confirmado). | Sí |
| `CREATE_TEMPLATE` | Nombre de la plantilla de confirmación de reserva (`aviso_cita_creada`). **Vacío hasta que Meta la apruebe**; con el nombre vacío no se envía nada. | Solo si se usa plantilla |
| `CREATE_TEMPLATE_LANG` | Idioma previsto para la confirmación: `es_ES`. | Sí, si Meta lo exige diferente |

IDs de Meta (referencia documental; **no** se envían a la API, que usa el nombre): `aviso_cita_cancelada` = `<ID_PLANTILLA_CANCELACION>`; `aviso_cita_actualizada` = `<ID_PLANTILLA_ACTUALIZACION>`. La confirmación `aviso_cita_creada` aún no tiene ID: está pendiente de crear y aprobar.

#### Plantilla de Meta pendiente: `aviso_cita_creada`

No existe todavía en Meta. Para activarla:

1. Crear en Meta (WhatsApp Manager → Plantillas de mensajes) una plantilla con:
   - **Nombre:** `aviso_cita_creada`
   - **Categoría:** Utilidad (UTILITY)
   - **Idioma:** Español (`es_ES`)
   - **Cuerpo** (4 parámetros, en este orden):
     ```
     ¡Hola! Tu cita se ha reservado correctamente.

     Servicio: {{1}}
     Fecha: {{2}}
     Hora: {{3}}
     Peluquero: {{4}}

     ¡Te esperamos!
     ```
   - Orden de parámetros que envía el código (`creationParams`): **1** servicio, **2** fecha, **3** hora, **4** peluquero. La fecha llega ya formateada en español (por ejemplo, «2 de noviembre») y la hora en `HH:MM`.
2. Esperar la aprobación de Meta (no se puede usar antes).
3. Cuando esté aprobada, poner en `wrangler.jsonc`:
   ```jsonc
   "CREATE_TEMPLATE": "aviso_cita_creada",
   "CREATE_TEMPLATE_LANG": "es_ES"
   ```
4. Desplegar (o reiniciar `wrangler dev`). Hasta ese momento el código omite el envío y la cita se crea con normalidad.

### Secretos (`wrangler secret put`)

| Secreto | Para qué sirve | Dónde se configura |
|---|---|---|
| `ADMIN_PASSWORD` | Entrada al panel `/admin`. | Cloudflare Worker (producción) y `.dev.vars` (local) |
| `STAFF_PASSWORD` | Entrada al panel `/recepcion`. | Cloudflare Worker y `.dev.vars` |
| `SESSION_SECRET` | Firma las cookies de sesión. Si falta, el login falla. | Cloudflare Worker y `.dev.vars` |
| `VERIFY_TOKEN` | Verificación del webhook de Meta. | Cloudflare Worker y `.dev.vars` |
| `APP_SECRET` | Validación de la firma de los webhooks de Meta. | Cloudflare Worker y `.dev.vars` |
| `WHATSAPP_TOKEN` | Envío real de mensajes por la API de WhatsApp. | Cloudflare Worker y `.dev.vars` |

> No guardar valores reales en este documento, en `memoria.md`, en el README ni en capturas. En local se usa `.dev.vars` (ignorado por git); en producción, `wrangler secret put`.

### Base de datos y despliegue

- **D1:** cada salón debe tener su propia base y su `database_id` en `wrangler.jsonc`. El esquema se aplica con `schema.sql` (idempotente).
- **Worker, D1 y cola:** cada salón tiene su **propio Worker, su propia D1 y su propia cola**. No compartas ninguno de los tres entre salones: se mezclarían datos y mensajes. `setup.ps1` pide nombres únicos y actualiza `wrangler.jsonc`; el esquema se aplica con `schema.sql` (idempotente).
- **Dominio:** se puede usar el subdominio `workers.dev` o un dominio propio. La URL final afecta al webhook de Meta, al QR de recepción y a los enlaces que se impriman.
- **QR de recepción estático:** `public/qr-recepcion.svg` contiene una URL de producción grabada. Si cambia el dominio o el salón, hay que regenerarlo. La ruta dinámica `/qr-recepcion` genera el QR con el host de la petición.
- **PWA:** el manifest se sirve en `/manifest.json`, con `start_url` y `scope` en `/recepcion/`. Los iconos son los de `src/pwa.ts`. No hay service worker ni funcionamiento offline.
- **Auditoría y retención:** `audit_log` se conserva 365 días; sesiones, mensajes procesados, intentos de login y rate-limit se limpian automáticamente. Las citas y los ajustes **no se purgan**.
- **Backups:** `npm run backup` exporta la D1 remota a `backups/backup.sql` (fuera de git) y `node scripts/encrypt-backup.mjs backups/backup.sql` genera `backups/backup.sql.enc`. El workflow de GitHub usa los secretos de repositorio `CLOUDFLARE_API_TOKEN` (permiso propuesto **Account > D1 > Read**, pendiente de confirmar con una ejecución real), `CLOUDFLARE_ACCOUNT_ID` y `BACKUP_ENCRYPTION_KEY`; valida el SQL ejecutándolo en una SQLite en memoria, lo cifra con AES-256-GCM, verifica el descifrado y sube **solo** el `.sql.enc` durante 30 días. **Todavía no existe una ejecución satisfactoria confirmada** y los secretos siguen pendientes. La restauración desde `.sql.enc` está documentada y probada en local (`docs/OPERACION_Y_DESPLIEGUE.md` §2); debe probarse con el primer artefacto real antes de confiar en ella.

### Archivos o apartados afectados por la personalización

| Archivo / apartado | Qué contiene |
|---|---|
| `wrangler.jsonc` | Variables no secretas y binding de D1. |
| `/admin/ajustes` | Nombre, dirección, teléfono, servicios, peluqueros, horarios, vacaciones, días cerrados y reglas. |
| `src/config.ts` | Valores por defecto si la tabla `settings` está vacía. |
| `src/bot.ts` | Textos y flujo del bot. |
| `src/reminders.ts` | Texto del recordatorio y uso de plantilla. |
| `src/panels.ts` | Textos, colores y estructura de los paneles. |
| `src/pwa.ts` | Manifest, iconos PWA y página del QR de recepción. |
| `public/qr-recepcion.svg` | QR estático de recepción con URL grabada. |
| `datos-salon/` | Plantillas para recoger los datos del propietario. |
| `docs/PUESTA_EN_MARCHA.md` | Secuencia técnica de instalación, D1, secretos, despliegue y webhook. |

---

## 6. Aspectos legales y operativos

| Elemento | Tipo | Estado actual / nota |
|---|---|---|
| Aviso de privacidad en el bot o en el panel | **DEC** + **T** | No implementado. Si el salón recoge datos personales (nombre, teléfono, notas), debe revisarse con el propietario y, si corresponde, con asesoría legal. |
| Base legal y consentimiento | **DEC** | No implementado. El bot no pide consentimiento explícito. |
| Política de conservación de citas | **DEC** | Las citas no se purgan automáticamente. Hay que decidir plazos y procedimiento. |
| Borrado de datos de un cliente | **DEC** + **T** | No hay función de borrado por teléfono ni por solicitud del interesado. Hoy requeriría intervención manual en D1. |
| Copias de seguridad | **DEC** + **T** | `npm run backup` y workflow de GitHub. Los backups contienen teléfonos y nombres; deben almacenarse de forma segura y con retención limitada. |
| Restauración de backup | **T** + **V** | No hay runbook automatizado. Antes de producción hay que documentar y probar una restauración en una D1 de prueba. |
| Titularidad de la cuenta de Cloudflare | **DEC** | Definir si la cuenta es del salón o del proveedor; afecta a accesos, facturación y portabilidad. |
| Titularidad de la app de Meta / WhatsApp | **DEC** | La app y el número deben quedar a nombre del salón o con acceso controlado. |
| Dominio y certificados | **DEC** | `workers.dev` funciona sin comprar dominio; un dominio propio requiere configurarlo y actualizar enlaces/QR. |
| Textos legales del QR o carteles | **DEC** | Revisar si deben incluir aviso de privacidad o condiciones de reserva. |

### Pendiente de decisión

- ¿Quién es el titular de la cuenta de Cloudflare y de la app de Meta?
- ¿Qué plazo de conservación de citas y backups acepta el salón?
- ¿Cómo se atenderá una solicitud de borrado de datos?
- ¿Se necesita aviso de privacidad visible en el bot o en el panel?

---

## 7. Checklist de incorporación

### 7.1 Antes de tocar código o configuración

- [ ] **D** Nombre comercial exacto y nombre corto deseado.
- [ ] **D** Logo cuadrado (si se quieren iconos PWA reales) o decisión de mantener placeholders.
- [ ] **D** Dirección completa y teléfono público.
- [ ] **D** Zona horaria y confirmación de que el salón está en España o en otra zona.
- [ ] **D** Horario general, descansos, días cerrados y vacaciones.
- [ ] **D** Lista de peluqueros y horario/vacaciones de cada uno.
- [ ] **D** Servicios con `id`, nombre, duración y precio.
- [ ] **D** Reglas de reserva: hueco, días por delante, antelación y máximo de citas.
- [ ] **D** Número de WhatsApp y ID del número de Business.
- [ ] **DEC** ¿WhatsApp real desde el primer día o modo consola?
- [ ] **DEC** ¿Recordatorios con plantilla o sin plantilla?
- [ ] **DEC** ¿Colores/logo propios o plantilla actual?
- [ ] **DEC** ¿Una sucursal o varias instalaciones?
- [ ] **DEC** ¿Aviso de privacidad y política de conservación?
- [ ] **DEC** Titularidad de Cloudflare y Meta.

### 7.2 Configuración técnica

- [ ] **T** Crear la D1 del salón y anotar su `database_id`.
- [ ] **T** Copiar `schema.sql` a la D1 (local y remota cuando corresponda).
- [ ] **T** Rellenar `wrangler.jsonc` con `SALON_*` y `WHATSAPP_*` reales; no dejar valores de ejemplo.
- [ ] **T** Configurar `SALON_TZ`.
- [ ] **T** Revisar `src/config.ts` solo si se quieren cambiar los valores por defecto.
- [ ] **T** Sustituir los iconos PWA si el propietario aporta logo.
- [ ] **T** Regenerar `public/qr-recepcion.svg` si cambia el dominio.
- [ ] **T** Revisar textos del bot y de los paneles con el propietario; cambiar solo lo acordado.
- [ ] **T** Configurar secretos en Cloudflare con `wrangler secret put` (sin escribirlos en el repo).
- [ ] **T** Configurar la app de Meta, el webhook y la suscripción a `messages` solo cuando se autorice.
- [ ] **T** Añadir secretos de GitHub para el backup.

### 7.3 Verificación antes de producción

- [ ] **V** `npm run check` limpio.
- [x] **V** `npm run e2e` en local con `.dev.vars` de prueba; último resultado **189/189, 0 fallidas, exit 0 (2026-10-30)**, incluida la reprogramación (14/14). La suite borra las tablas locales y requiere autorización.
- [ ] **V** `/health` devuelve `{"ok":true}`.
- [ ] **V** `/qr` muestra el nombre, dirección, teléfono y número correctos.
- [ ] **V** `/qr-recepcion` genera un QR que abre `/recepcion` del dominio correcto.
- [ ] **V** `/manifest.json` muestra el nombre correcto y referencia los dos iconos.
- [ ] **V** `/icon-192.png` y `/icon-512.png` devuelven PNG con dimensiones correctas.
- [ ] **V** Login de `/admin` con `ADMIN_PASSWORD` y de `/recepcion` con `STAFF_PASSWORD`.
- [ ] **V** Crear, editar y cancelar una cita de prueba en ambos paneles.
- [ ] **V** El bot (modo consola o real) ofrece los servicios, horarios y huecos correctos.
- [ ] **V** Una cita fuera de horario, en día cerrado o con peluquero de vacaciones se rechaza.
- [ ] **V** El recordatorio se genera para una cita a menos de 24 h y no se duplica.
- [ ] **V** El historial registra las acciones de la prueba.
- [ ] **V** El backup se genera y se puede restaurar en una D1 de prueba.
- [ ] **V** No queda ningún dato de ejemplo visible en `/qr`, paneles, PWA o mensajes.
- [ ] **V** No hay secretos en el repositorio ni en la documentación.

---

## 8. Funciones que hoy no existen y no deben prometerse sin desarrollo

- Multi-sucursal o multi-salón dentro de una misma instalación.
- Ficha de cliente, historial agregado por cliente o CRM.
- Pagos, señales, facturación o cobros.
- Servicios distintos por peluquero.
- Avisos al propietario o al personal cuando entra o se cancela una cita.
- Resúmenes diarios.
- Lista de espera, no-shows o estados adicionales de cita (aparte de `confirmed`, `cancelled` y `done`/Realizada, que ya existen).
- Recordatorios recurrentes o festivos automáticos.
- Service worker / funcionamiento offline.
- Editor de colores, logo o textos desde el panel.
- Política de privacidad, consentimiento y borrado por cliente.
- Monitorización con alertas o métricas de negocio.
- Tests unitarios y cobertura (solo hay e2e).

---

## 9. Orden recomendado el día que tengamos el salón

1. Recoger los datos con `datos-salon/` y completar la checklist 7.1.
2. Resolver las decisiones pendientes de las secciones 1–6.
3. Preparar una instalación local con datos de prueba y verificar 7.3.
4. Crear la D1 y el Worker del salón; aplicar el esquema.
5. Rellenar variables no secretas y revisar que no queden ejemplos.
6. Configurar secretos y desplegar solo cuando el propietario lo autorice.
7. Configurar Meta/WhatsApp si se ha decidido activarlo.
8. Hacer una reserva real de prueba y revisar el historial.
9. Entregar URLs, credenciales por canal seguro y confirmación del backup.
10. Actualizar `../memoria.md` y `../instrucciones/TAREAS_PENDIENTES.md` con los datos y verificaciones del salón.
