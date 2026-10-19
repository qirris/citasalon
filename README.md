# Bot de citas por WhatsApp — citasalon

Bot que permite a los clientes reservar, consultar y cancelar citas desde WhatsApp. Corre en Cloudflare Workers sin servidor propio.

```
Cliente ──WhatsApp──► Meta ──webhook──► Cloudflare Worker ──► D1 (citas)
                                            │
                                            └─ cron cada 10 min: recordatorios 24 h antes
```

---

## Qué hace cada archivo

### `src/index.ts`
Punto de entrada del Worker. Gestiona dos cosas:
- **`/webhook`** — recibe los mensajes de WhatsApp que envía Meta, los procesa y responde.
- **Cron cada 10 min** — lanza los recordatorios y limpia datos antiguos de la base de datos.

### `src/bot.ts`
Lógica principal del bot. Interpreta lo que escribe el cliente (texto libre o botones) y decide qué responder. Maneja el flujo completo: menú de bienvenida, selección de servicio, peluquero, fecha y hora, confirmación, consulta de citas y cancelación.

### `src/db.ts`
Todas las operaciones con la base de datos D1 de Cloudflare: crear citas, buscarlas, actualizarlas, cancelarlas, marcar mensajes como vistos y limpiar registros antiguos.

### `src/reminders.ts`
Busca las citas de las próximas 24 horas y envía un recordatorio por WhatsApp al cliente. Solo recuerda citas reservadas con más de 24 horas de antelación y que tienen teléfono.

### `src/whatsapp.ts`
Funciones para enviar mensajes a través de la API de WhatsApp (Meta Graph API): texto libre, mensajes con botones, listas y plantillas.

### `src/availability.ts`
Calcula los huecos libres de cada peluquero para un día dado, teniendo en cuenta las citas ya existentes y el horario configurado.

### `src/config.ts`
Carga y guarda la configuración del salón desde la base de datos: nombre, teléfono, servicios, peluqueros, horario y festivos.

### `src/time.ts`
Utilidades de fechas y horas: convertir zonas horarias, formatear horas, sumar minutos, validar fechas, etc.

### `src/types.ts`
Tipos TypeScript compartidos por todos los módulos: `Appt`, `Service`, `Settings`, `Env`, `Role`, etc.

### `src/panels.ts`
Todas las rutas de los paneles web (`/admin`, `/recepcion`, `/qr`): login, agenda, CRUD de citas, buscador, ajustes y historial de auditoría. HTML server-side sin JavaScript en el navegador.

### `src/auth.ts`
Autenticación de los paneles: cookies de sesión firmadas con HMAC-SHA256, comparación en tiempo constante de contraseñas y tokens.

### `src/phone.ts`
Normalización de teléfonos españoles a formato `+34…` (usada en el panel y en el webhook de WhatsApp).

---

## Paneles web

Además del bot, el Worker sirve tres rutas web:

| Ruta | Rol | Qué hace |
|---|---|---|
| `/admin` | admin | Agenda diaria con estadísticas, crear/editar/cancelar/restaurar/borrar citas, buscador, ajustes completos del salón, historial de auditoría |
| `/recepcion` | staff o admin | Agenda, crear/editar/cancelar citas. No puede borrar, restaurar, ver ajustes ni historial |
| `/qr` | público | Cartel con código QR hacia wa.me con los datos del salón |

Los paneles son formularios HTML + redirecciones 303, sin JavaScript en el navegador (más seguros y sin dependencias). Seguridad: cookies HttpOnly/SameSite=Strict, bloqueo de login tras 5 fallos, rate-limit por sesión e IP (120/min y 60/min, ventana de 60 s), CSRF por comprobación de Origin, CSP restrictiva y SQL parametrizado.

Las contraseñas de los paneles se configuran como secretos (`ADMIN_PASSWORD` y `STAFF_PASSWORD`) con `npx wrangler secret put`.

---

## Pruebas

```powershell
npm run check   # TypeScript en modo estricto (sin emitir)
npm run dev     # terminal 1: servidor local en el puerto 8787
npm run e2e     # terminal 2: prueba de extremo a extremo (59 pruebas)
npm run backup  # exporta una copia de la D1 de producción a backups/backup.sql
```

`test/e2e.mjs` es la especificación real del panel: cubre el bot, login y roles, agenda, CRUD completo, conflictos de horario, validaciones, ajustes, historial, CSP, bloqueo de login y rate-limit por sesión e IP.

---

## Sistema de memoria del proyecto

Este proyecto usa el documentación interna del proyecto:

- **`memoria.md`** — memoria viva: estado, decisiones, pruebas verificadas, pendientes e historial. Se actualiza tras cada avance importante.
- **`AGENTS.md`** — punto de entrada: orden de lectura obligatoria y reglas duras.
- **`instrucciones/`** — reglas permanentes por tema: arquitectura, normas de código, seguridad, pruebas, decisiones y tareas pendientes.

Al trabajar en el proyecto, se leen `memoria.md` y `AGENTS.md` antes de tocar nada y documenta los cambios al terminar cada tarea. Los secretos nunca se guardan en estos archivos.

---

## Variables de entorno necesarias

Copia `.dev.vars.example` como `.dev.vars` para desarrollo local.

| Variable | Qué es | Necesaria? |
|---|---|---|
| `SESSION_SECRET` | Secreto para firmar las sesiones de los paneles (32+ caracteres) | Sí |
| `VERIFY_TOKEN` | Token para verificar el webhook con Meta | Para el bot |
| `WHATSAPP_TOKEN` | Token de acceso a la API de WhatsApp | Para enviar mensajes reales |
| `APP_SECRET` | Clave secreta de la app de Meta (valida la firma de cada webhook) | Recomendado |

Sin `WHATSAPP_TOKEN` el bot funciona en **modo consola**: registra en los logs de Cloudflare lo que habría enviado, sin conectarse a WhatsApp.

Las variables no secretas (nombre del salón, zona horaria, número de WhatsApp…) están en `wrangler.jsonc`.

---

## Arrancar en local

```powershell
npm install
Copy-Item .dev.vars.example .dev.vars
npx wrangler d1 execute citasalon --local --file=schema.sql
npm run dev   # arranca en http://localhost:8787
```

Sin token de WhatsApp el bot no envía nada: escribe en la consola lo que habría enviado.

## Publicar en Cloudflare

```powershell
npx wrangler deploy
```

O haz doble clic en `instalar.bat` para el proceso guiado completo.

