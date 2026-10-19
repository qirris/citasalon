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

---

## Variables de entorno necesarias

Copia `.dev.vars.example` como `.dev.vars` para desarrollo local.

| Variable | Qué es |
|---|---|
| `VERIFY_TOKEN` | Token para verificar el webhook con Meta |
| `APP_SECRET` | Clave secreta de la app de Meta (valida la firma de cada mensaje) |
| `WHATSAPP_TOKEN` | Token de acceso a la API de WhatsApp |
| `SESSION_SECRET` | Secreto para firmar sesiones (32+ caracteres) |

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

