# Tareas pendientes

Estado: núcleo funcional y verificado. El repositorio se ha preparado como pieza de portfolio **privada** (2026-11-04): renombrado a **CitaSalón** (`citasalon`), sin identificadores de Cloudflare ni de Meta en el historial ni en los archivos versionados y con la configuración real de la instalación en `wrangler.local.jsonc` (fuera de Git). La personalización de una peluquería real está **aplazada** hasta tener cliente y datos.

Última revisión: **2026-11-04** (sanitización, renombrado a CitaSalón y limpieza del historial; `npm run check` limpio y **95/95 pruebas en verde**). El e2e sigue en **189/189, exit 0** del 2026-10-30, no re-ejecutado.

Criterio: no marcar `[x]` sin haberlo hecho y verificado. Las tareas de personalización no son «pendientes de código»: dependen de datos y decisiones del propietario.

---

## 1. Pendientes reales del núcleo (sin depender de un salón)

### 1.1 Verificación y cierre

- [x] ~~**Fase 2: Inbox duradero, Consumer, orden, bloqueos y Outbox.**~~ **Completada el 2026-11-01.** `inbox_messages` deduplica por WAMID y asigna secuencia por teléfono; el Consumer bloquea el teléfono con fencing token, respeta el orden (`firstUnfinishedInbox`), ejecuta la intención del bot y hace un `commit` atómico de sesión + Outbox + secuencia + cierre; el Outbox entrega con `PENDING/SENDING/SENT/FAILED/UNKNOWN`, backoff y recuperación, y el Inbox reintenta y acaba en `DEAD` con aviso. Migración `0003_inbox_retry_columns.sql` aplicada a la D1 local (backup previo `backups/d1-local-20261101-120336.sql`), datos intactos. Pruebas nuevas contra SQLite real: `npm test` **46/46**; `npm run check` limpio. **No** se ejecutó e2e ni se llamó a Meta; sin commit ni deploy.

- [x] ~~**Ejecutar `npm run e2e` completo** cuando el usuario lo autorice (borra las tablas de la D1 local).~~ **Hecho el 2026-10-30: 175/175 correctas, 0 fallidas, exit 0** contra `wrangler dev --test-scheduled --local` y la D1 local. Confirmados los 4 fallos de la Fase 2 (cancelación desde «Mis citas» y hueco libre, ingresos 80 €, navegación con «Peluqueros», mensaje de horarios) y también restauración `GET`/`POST`, permisos, CSRF (`403`), hueco ocupado (`409`) y validaciones (`422`). La **reprogramación** no tenía caso en el e2e: se verificó aparte (cita 33, 10:00 → 16:00, mismo `id`, auditoría `whatsapp/editar`). El 2026-10-30 se añadió su caso al e2e; la **primera ejecución dio 175/177, 2 fallidas (exit 1)** por el selector de servicio. Tras corregirlo, la segunda dio **188/189, 1 fallida (exit 1)** por el conteo de tarjetas. Corregido también (`split('<article class="appt-card">').slice(1)`), la tercera dio **189/189, 0 fallidas, exit 0**, con la reprogramación **14/14**. `git status --short` quedó igual (35 entradas). Los `401/190` de WhatsApp del log no afectan a la suite, pero el envío real por Meta sigue sin verificarse.
- [x] ~~**Ajustar el conteo de «sin duplicados» de la prueba e2e de reprogramación y re-ejecutar.**~~ **Hecho el 2026-10-30**: `split('<article class="appt-card">').slice(1)` (descarta la plantilla JS del refresco y el trozo previo con la fila de tabla) y `npm run e2e` → **189/189, 0 fallidas, exit 0**, reprogramación **14/14**. Sin pendientes de esta prueba.
- [x] **Restauración Segura en Sandbox de D1**: Implementado módulo `src/restore-sandbox.ts` y pruebas unitarias (`test/restore-sandbox.test.mjs`) para validar volcado cifrado y ejecutarlo en una base SQLite temporal de pruebas aislada.
- [x] **Validador de Instalación de Salón**: Creado `src/salon-validator.ts` y `test/salon-validator.test.mjs` para validar la integridad de la configuración comercial y técnica previa al despliegue.
- [x] **Suite Total de Pruebas**: 95/95 pruebas (`npm test` 51/51 + `test:aux` 44/44), incluyendo cifrado/descifrado real del workflow, manipulación de ciphertext/authTag/IV/checksum, migraciones con datos e instalación con nombres propios.
- [x] **Commit, push y deploy** de los cambios posteriores a `7c939d7`. **Hecho el 2026-11-03:** commit `9dbb58a` en `origin/master`, CI en verde y `wrangler deploy` correcto (versión `<VERSION_DEPLOYADA>`). Verificadas en producción `/health`, `/manifest.json`, iconos 192/512, `/qr-recepcion`, `/qr`, `/recepcion` y `/admin` (200).
- [x] **Demostración en local**: `npm run dev` en `http://127.0.0.1:8787` y `schema.sql` aplicado a la D1 local (sin migraciones ni cambios remotos). Verificadas 200 en `/health`, `/manifest.json`, `/qr`, `/qr-recepcion`, `/recepcion` y `/admin`. La D1 local queda sin citas (0), con los valores por defecto de `wrangler.jsonc`.
- [ ] **Datos de demostración (opcional)**: si se quiere enseñar la agenda con citas, crear 2–3 citas de ejemplo en la D1 **local** (nunca en producción) o cargarlas desde `/admin`.
- [x] **Sanitizar el repositorio para portfolio (2026-11-04)**: sustituidos por marcadores la URL del Worker, `database_id`, Phone ID/WABA/App ID, IDs de plantillas, números de prueba, túneles y credenciales de prueba; renombrado a CitaSalón y configuración real movida a `wrangler.local.jsonc` (ignorado por Git). Verificado con `npm run check` y 95/95 pruebas.
- [x] ~~**Limpiar el historial de Git**~~ **Hecho el 2026-11-04:** reescrito con `git filter-repo` y backup mirror previo; eliminados de todos los commits la URL del Worker, `database_id`, Phone ID/WABA/App ID, IDs de plantillas, número de prueba, túneles, cuenta de Cloudflare, credenciales de prueba y rutas locales. Verificado con `git log -S`.
- [ ] **Confirmar la entrega real por Meta** (webhook firmado y envío real). Las pruebas del 2026-10-26 usaron webhook firmado y, en parte, `[modo consola]`; no se envió nada a la API de Meta desde el entorno aislado.
- [ ] **Ejercitar la pausa del refresco con pestaña oculta** en un navegador real (`document.hidden`). En headless la pestaña siempre está visible.

### 1.2 Fallos detectados, no reproducidos o no corregidos

- [x] **`manifest-src` bloqueado en `/recepcion`** (preexistente): el layout enlaza `/manifest.json`, pero la CSP base no declara `manifest-src` y el navegador bloquea el manifest. Arreglo de una línea (`manifest-src 'self'` en la CSP de recepción). Afecta a la instalación PWA de recepción, no al panel. **Corregido el 2026-10-30 (Fase 1)**: añadido `manifest-src 'self'` a la CSP base, heredado por `CSP_FORM`/`CSP_AGENDA`; cubierto por pruebas e2e de la CSP de recepción y del formulario. Verificado estáticamente (`npm run check`); `npm run e2e` **no ejecutado** (pendiente de autorización).
- [x] **Enlace «Restaurar» de la agenda**: `src/panels.ts` (~línea 2480) genera un `<a href="…/cita/{id}/restaurar">Restaurar</a>`, pero la ruta solo acepta **POST** (~línea 2546). Leído en el código el 2026-10-29; no reproducido en navegador ni corregido. Debe verificarse y, si procede, convertir el enlace en formulario POST con CSRF. **Resuelto el 2026-10-30 (Fase 1)**: el enlace está en la página de edición; `GET` muestra confirmación sin mutar y `POST` restaura solo si la cita sigue cancelada, con CSRF, permisos de admin y `409` si el hueco está ocupado. Añadidas pruebas de regresión (Fase 1.1); verificadas estáticamente, **no ejecutadas** con `npm run e2e`.
- [x] **Cancelación desde «Mis citas» inalcanzable** (detectado por el e2e del 2026-10-30, 171/175): `menu:manage` abría `RESCHED_PICK`, así que pulsar una cita iniciaba la reprogramación y `cancel:yes` se rechazaba; `CANCEL_PICK`/`CANCEL_CONFIRM` nunca se usaban. **Corregido en la Fase 2**: la lista abre `CANCEL_PICK`, la cita lleva a la confirmación de cancelación y esa confirmación incluye «Reprogramar» (`resched:yes`), que reutiliza `beginReschedule()`. **Confirmado con `npm run e2e` el 2026-10-30: 175/175, exit 0**.
- [ ] **Guarda adicional por teléfono en `createAppointment`** (opcional, riesgo residual): hoy solo evita solapes por peluquero. El Inbox deduplica por WAMID y el bloqueo por teléfono serializa los mensajes de un mismo cliente, así que los reintentos y las entregas simultáneas ya no compiten; aun así, dos confirmaciones **distintas** del mismo teléfono para la misma hora podrían, en teoría, reservar con peluqueros distintos. No ha ocurrido.
- [ ] **Código obsoleto de idempotencia**: `markMessageSeen`/`forgetMessage` y la tabla `processed_messages` ya no se usan (el Inbox es la fuente de verdad). Retirarlos o dejar documentado por qué se conservan.

### 1.3 Fase 3 — puesta en producción y verificación real

- [x] ~~Crear la cola remota antes de desplegar.~~ **Hecho**: `whatsapp-inbox` existe desde el 2026-11-01 y se verificó con `wrangler queues list` el 2026-11-03. Para un salón nuevo, crear una cola propia con nombre único (`setup.ps1` la crea).
- [ ] Probar el `queue()` real de Wrangler con la cola local (hoy las pruebas ejercitan `drainInbox`, no el consumidor de cola).
- [ ] Verificar la entrega real por Meta y los acuses (`sent/delivered/read/failed`) actualizando `meta_status`, sin duplicar mensajes.
- [ ] Verificación integrada de Inbox/Outbox sobre una **copia** de la D1 y, si se autoriza, e2e completo.
- [ ] Observabilidad: contar `DEAD`, `FAILED` y `UNKNOWN`, decidir alertas y retirar los `[DIAG]`.
- [ ] Aplicar a una D1 remota **nueva** `schema.sql` (esquema completo, incluye Inbox/Outbox). **No aplicar después las migraciones `0001`–`0004`**: ya están incluidas. En una base antigua, aplicar solo las migraciones pendientes en orden; ver `../docs/OPERACION_Y_DESPLIEGUE.md`.

---

## 2. WhatsApp (requiere autorización expresa)

- [ ] **Token permanente**: usar un System User token del Business Manager (o, como mínimo, uno de App Dashboard). El token de usuario caduca y el bot deja de responder aunque el resto esté bien. Guardarlo solo en `.dev.vars` o como secreto de Cloudflare, nunca en documentos. **2026-10-30:** el token que se hubiera compartido se considera expuesto; hay que generar uno **nuevo** en Meta y sustituir a mano la línea `WHATSAPP_TOKEN=` de `.dev.vars` (no se ha sobrescrito el archivo). Después hay que **reiniciar** `wrangler dev`.
- [ ] **Activar WhatsApp en producción** solo cuando el usuario lo decida: `WHATSAPP_TOKEN`, `APP_SECRET`, webhook de Meta y número verificado. Hoy producción está en modo consola y no valida la firma.
- [x] **Plantillas de cancelación y modificación: integración en el código (2026-10-30)**. Implementadas en `src/notices.ts` y conectadas en `src/panels.ts`: cancelar desde admin/recepción dispara `aviso_cita_cancelada` solo si la cancelación se guardó; editar dispara `aviso_cita_actualizada` solo si la edición se guardó y cambió fecha/hora, servicio o peluquero. Los avisos usan el teléfono del cliente y no se envían si falta teléfono o configuración. Un rechazo de Meta se registra sin datos personales y no deshace el cambio. Pruebas simuladas: `npm run test:notices` (13/13).
  - `aviso_cita_cancelada`: «Hola, te informamos de que tu cita de {{1}}, prevista para el {{2}} a las {{3}}, ha sido cancelada. Si necesitas otra fecha, puedes escribirnos para reservar de nuevo.» → parámetros en orden: servicio, fecha, hora.
  - `aviso_cita_actualizada`: «Hola, te informamos de que tu cita se ha actualizado correctamente. Servicio: {{1}} Nueva fecha: {{2}} Nueva hora: {{3}} Peluquero/a: {{4}} Si tienes alguna duda, responde a este mensaje.» → parámetros en orden: servicio, fecha, hora, peluquero.
- [x] **Configuración de las plantillas confirmada con Meta (2026-10-30)**. Nombres exactos: `aviso_cita_cancelada` y `aviso_cita_actualizada`; idioma `es_ES` en ambas (`CANCEL_TEMPLATE_LANG`/`UPDATE_TEMPLATE_LANG` en `wrangler.jsonc`). IDs de Meta conservados como referencia documental: `<ID_PLANTILLA_CANCELACION>` (cancelación) y `<ID_PLANTILLA_ACTUALIZACION>` (actualización); `sendTemplate()` sigue usando el **nombre**, no el ID. Los parámetros de `src/notices.ts` coinciden con las plantillas: 3 para cancelación (servicio, fecha, hora) y 4 para actualización (servicio, fecha, hora, peluquero).
- [x] **Confirmación de reserva creada desde panel: integración en el código (2026-10-31)**. `src/notices.ts` añade `creationParams` (servicio, fecha, hora, peluquero) y `notifyCreation`, reutilizando `notify()` y `sendTemplate()`. `src/panels.ts` la llama una sola vez en `createAppt`, después de guardar y auditar, tanto para `/admin/nueva` como para `/recepcion/nueva`. Configurada con la plantilla aprobada en Meta `confirmacion_reserva_peluqueria` (`es_ES`, ID: `<ID_PLANTILLA_CONFIRMACION>`). Pruebas simuladas: `npm test` (**51/51**).
- [x] **Aprobación en Meta de la plantilla `confirmacion_reserva_peluqueria`** (completada). ID: `<ID_PLANTILLA_CONFIRMACION>`, idioma `es_ES`, 4 parámetros en orden: servicio, fecha, hora, peluquero.
- [ ] **Verificar la entrega real** de las plantillas por WhatsApp con un número de prueba (token válido, número verificado y webhook estable). Hasta entonces los avisos están implementados y probados de forma simulada, pero no verificados en producción.
- [ ] **URL estable**: si se sigue probando en local, usar un túnel con nombre o desplegar; el túnel rápido cambia de URL y hay que actualizarla en Meta (suscripción de la app **y** override del número). **Último túnel usado (2026-10-30, ya no válido):** `https://<subdominio-efimero>.trycloudflare.com/webhook`. Los túneles rápidos cambian de URL en cada arranque. Handshake local y por túnel comprobados; **falta pegar la URL en Meta**.

## PRUEBAS PENDIENTES CUANDO TENGAMOS ACCESO AL MÓVIL

- [ ] Enviar un único «Hola» y comprobar que llega una sola bienvenida.
- [ ] Enviar un mensaje no reconocido y comprobar que no se repite el saludo.
- [ ] Escribir «menú» y comprobar que recupera las opciones.
- [ ] Iniciar una reserva y comprobar que se conserva el estado.
- [ ] Dejar la conversación inactiva y comprobar que no llegan mensajes espontáneos.
- [ ] Comprobar una reserva, una modificación y una cancelación reales.
- [ ] Cuando Meta apruebe `confirmacion_reserva_peluqueria`, activar la configuración y comprobar la confirmación de una nueva cita.
- [ ] Implementar un recordatorio único después de 15 minutos de inactividad.
- [ ] Retirar los registros temporales `[DIAG]` cuando terminemos la depuración.
- [ ] Realizar las pruebas reales de WhatsApp cuando vuelva a tener acceso al móvil.
- [ ] Activar la plantilla de confirmación de creación cuando Meta la apruebe.

---

## 3. Personalización de un salón real

No hay cliente todavía y no se inventan datos. El procedimiento completo, las decisiones del propietario y la checklist están en `../docs/CONFIGURACION_PELUQUERIA_REAL.md`; las plantillas de datos, en `../datos-salon/`.

Resumen de lo que falta:

- [ ] Identidad: nombre comercial, nombre corto de la PWA, logo/iconos definitivos del salón (hoy hay PNG reales 192/512 genéricos, no placeholders 1×1) y decisión sobre colores.
- [ ] Establecimiento: dirección, teléfono público, zona horaria, horario general, descansos, días cerrados y vacaciones.
- [ ] Personal: peluqueros, horarios/vacaciones individuales y decisión sobre especialidades por peluquero.
- [ ] Servicios: `id`, nombre, duración y precio reales; condiciones especiales si las hubiera.
- [ ] Reservas: `slotMinutes`, `maxDaysAhead`, `minNoticeMinutes`, `maxActive` y textos del bot/paneles.
- [ ] Legal/operativo: aviso de privacidad, conservación de datos, borrado por cliente, titularidad de Cloudflare/Meta y dominio final.
- [ ] Verificación 7.3 de la guía: check, e2e, `/health`, `/qr`, PWA, login, cita real, recordatorio, historial y restauración de backup.

---

## 4. Puesta en producción

Solo cuando el propietario lo autorice. La secuencia de comandos está en `../docs/PUESTA_EN_MARCHA.md`; el resumen es:

- [ ] Crear/elegir cuenta de Cloudflare y D1 del salón.
- [ ] Aplicar `schema.sql` a la D1 **nueva** (esquema completo; no hay migración automática) y **no** ejecutar después `0001`–`0004`. Solo en bases creadas con una versión anterior se aplican las migraciones pendientes, en orden y comprobando el estado.
- [ ] Crear una cola **propia** para el salón (`npx wrangler queues create <nombre>-inbox`) y poner el mismo nombre en las dos entradas de `wrangler.jsonc`; no la compartas con otra peluquería (se mezclarían mensajes). `setup.ps1` lo hace automáticamente.
- [ ] Rellenar `wrangler.jsonc` con datos reales y `database_id` (o usar `setup.ps1`, que pide nombres de Worker, D1 y cola, crea los recursos y actualiza `wrangler.jsonc`).
- [ ] Configurar secretos de panel (`ADMIN_PASSWORD`, `STAFF_PASSWORD`, `SESSION_SECRET`, `VERIFY_TOKEN`) y, solo si se activa WhatsApp, `APP_SECRET`/`WHATSAPP_TOKEN`.
- [ ] `npm run deploy`, anotar URL y configurar Meta si aplica.
- [ ] Regenerar `public/qr-recepcion.svg` si cambia el dominio.
- [ ] Añadir secretos de GitHub para el backup (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `BACKUP_ENCRYPTION_KEY`) y ejecutar el workflow una vez.
- [ ] Probar la restauración real del primer `.sql.enc` en una D1 local aislada (`../docs/OPERACION_Y_DESPLIEGUE.md` §2).
- [ ] Ejecutar la checklist de `CONFIGURACION_PELUQUERIA_REAL.md` y entregar URLs/credenciales por canal seguro.

---

## 5. Mejoras opcionales

No son requisitos del núcleo.

- [ ] Tests unitarios de funciones puras (`cleanName`, `pickTime`, `pickDay`, `normalizePhone`, `freeSlots`).
- [ ] Accesibilidad formal (teclado, lector de pantalla, contraste AA).
- [ ] Monitorización, alertas y métricas de negocio.
- [ ] Runbook de restauración de backups y prueba periódica.
- [ ] Política de retención/borrado RGPD y minimización en backups.
- [ ] Service worker / funcionamiento offline para la PWA.
- [ ] Multi-sucursal o multi-tenant (hoy no existe).
- [ ] CRM/ficha de cliente, historial agregado y campañas.
- [ ] Pagos, señales, facturación o cobros.
- [ ] Lista de espera y avisos al propietario/personal.
- [ ] Servicios distintos por peluquero.
- [ ] Editor de colores, logo o textos desde el panel.
- [ ] Internacionalización (hoy todo en español).
- [ ] Convertir las pruebas de navegador (Chrome headless + CDP del 2026-10-26) en suite permanente del repo; hoy no están versionadas.

---

## 6. Qué NO repetir

- **No ejecutar `npm run e2e` sin autorización**: vacía las tablas de la D1 local.
- **No tocar** `.dev.vars`, `.wrangler/`, `node_modules/`, `backups/`, `.git/`, bases locales ni secretos.
- **No hacer commit, push ni deploy** sin petición expresa.
- **No volver atrás** estas decisiones ya verificadas: Inbox duradero con dedup por WAMID y orden por teléfono (Fase 2), CSP por página (`CSP_FORM`/`CSP_AGENDA`), estado `done` (Realizada), `workingStylists()` para asignar, desactivar servicios en vez de borrarlos, «Próximas citas» + `no-store`.
- **No marcar como terminado** algo no verificado, ni sumar cifras de pruebas de ejecuciones distintas (70, 85, 106, 154…).
- **No borrar el historial de `memoria.md`**: se conserva como trazabilidad aunque cite rutas o cifras antiguas.

## Histórico de tareas

El detalle cronológico de lo cerrado hasta la fecha (rondas de seguridad, agenda, huecos, peluqueros, bot, UI y verificaciones) está en `../memoria.md` §11.
