<div align="center">

# CitaSalón

### Las reservas llegan por WhatsApp. El salón las gestiona desde su agenda.

Bot de citas para peluquerías con paneles de administración y recepción, disponibilidad por profesional y recordatorios.

[![CI](https://github.com/qirris/citasalon/actions/workflows/ci.yml/badge.svg)](https://github.com/qirris/citasalon/actions/workflows/ci.yml)
![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat&logo=typescript&logoColor=white)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare_Workers-F38020?style=flat&logo=cloudflare&logoColor=white)
![Node.js 24+](https://img.shields.io/badge/Node.js-24%2B-339933?style=flat&logo=nodedotjs&logoColor=white)

[Capturas](#así-se-ve) · [Funcionalidades](#qué-puedes-hacer) · [Arranque local](#probar-en-local) · [Arquitectura](#cómo-funciona) · [Documentación](#documentación)

</div>

![Agenda real de CitaSalón en escritorio: citas, filtros por peluquero, estados y próximas reservas](docs/capturas/agenda-escritorio.jpg)

<p align="center"><sub>Captura real de la aplicación en local. Todos los nombres y las citas son ficticios.</sub></p>

## Qué puedes hacer

| Para el cliente | Para el salón |
| --- | --- |
| Reservar desde WhatsApp con botones o texto libre. | Consultar la agenda diaria y semanal, con filtros por peluquero. |
| Elegir servicio, profesional, día y hora disponible. | Crear, editar, cancelar y marcar citas como realizadas. |
| Consultar, reprogramar y cancelar sus propias citas. | Configurar servicios, precios, horarios, descansos y ausencias. |
| Recibir recordatorios y avisos mediante plantillas de Meta. | Consultar informes por periodo, exportar CSV y revisar el historial. |

La disponibilidad tiene en cuenta la duración del servicio, el horario de cada peluquero, sus ausencias y las citas existentes. Las reservas vuelven a comprobarse al confirmar para evitar solapes.

## Así se ve

Las imágenes se han tomado del código de este repositorio ejecutándose en un navegador, con una D1 local de demostración. Puedes pulsarlas para verlas a tamaño completo.

### Recepción desde el móvil

Agenda con navegación por fechas, filtro por profesional y tarjetas de citas con acciones rápidas.

<table>
  <tr>
    <th>Agenda y filtros</th>
    <th>Tarjetas de citas</th>
  </tr>
  <tr>
    <td align="center"><a href="docs/capturas/recepcion-movil.jpg"><img src="docs/capturas/recepcion-movil.jpg" width="280" alt="Captura real de recepción en móvil: fecha, filtros y estadísticas"></a></td>
    <td align="center"><a href="docs/capturas/recepcion-tarjetas.jpg"><img src="docs/capturas/recepcion-tarjetas.jpg" width="280" alt="Captura real de las tarjetas de citas en móvil, con servicio, profesional, origen y acciones"></a></td>
  </tr>
</table>

### Crear una cita

El formulario muestra los huecos disponibles para el servicio, el profesional y la fecha elegidos.

![Formulario real de nueva cita con selección de huecos y datos de cliente de demostración](docs/capturas/nueva-cita.jpg)

### Informes del salón

Resumen por fechas, desglose por profesional y servicio, y descarga en CSV. Los importes se calculan con el precio actual de los servicios; no representan cobros ni facturas.

![Informe real de CitaSalón con citas e importes de demostración, desglosados por peluquero y servicio](docs/capturas/informes.jpg)

## Cómo funciona

```mermaid
flowchart LR
    Cliente[Cliente en WhatsApp] --> Meta[WhatsApp Cloud API]
    Meta --> Webhook[Webhook del Worker]
    Webhook --> Inbox[(Inbox en D1)]
    Webhook -. recuperación .-> Cola[Cloudflare Queues]
    Inbox --> Consumer[Consumer y bot]
    Cola --> Consumer
    Consumer --> Datos[(Citas y sesiones en D1)]
    Consumer --> Outbox[(Outbox en D1)]
    Outbox --> Meta
    Personal[Administración y recepción] --> Panel[Panel web del Worker]
    Panel --> Datos
    Cron[Cron cada 10 minutos] --> Consumer
    Cron --> Recordatorios[Recordatorios y limpieza]
```

El Inbox deduplica los mensajes por WAMID y conserva el orden por teléfono. El Consumer guarda los cambios de negocio, la sesión y las respuestas en una operación atómica; el Outbox gestiona los envíos y sus reintentos. La cola y el cron permiten recuperar trabajo pendiente.

**Una instalación por salón:** cada peluquería utiliza su propio Worker, D1, cola y secretos. El proyecto no es multi-tenant.

| Capa | Tecnología |
| --- | --- |
| Aplicación | TypeScript en Cloudflare Workers |
| Persistencia y mensajería | D1 (SQLite), Inbox/Outbox y Cloudflare Queues |
| Conversación | WhatsApp Cloud API de Meta |
| Paneles | HTML generado en servidor, formularios y redirecciones 303 |
| Experiencia web | Vistas de escritorio y móvil, temas claro/oscuro y manifest PWA |
| Herramientas | Wrangler, GitHub Actions, Node.js, PowerShell y scripts Python para backups |

## Probar en local

Necesitas **Node.js 24 o superior** y npm. No hace falta conectar WhatsApp para explorar los paneles.

```powershell
git clone https://github.com/qirris/citasalon.git
cd citasalon
npm ci
Copy-Item .dev.vars.example .dev.vars
```

Configura en `.dev.vars` las contraseñas locales `ADMIN_PASSWORD` y `STAFF_PASSWORD`, y un `SESSION_SECRET` de al menos 32 caracteres. La plantilla es solo para desarrollo; utiliza valores propios antes de desplegar.

```powershell
# Crea el esquema en la base local, sin acceder a la D1 remota.
npx wrangler d1 execute citasalon --local --file=schema.sql
npm run dev
```

Abre [administración](http://localhost:8787/admin) o [recepción](http://localhost:8787/recepcion) e introduce la contraseña correspondiente. Una instalación nueva arranca sin citas; los datos de las capturas son de demostración.

| Ruta | Acceso | Uso |
| --- | --- | --- |
| `/admin` | Administrador | Agenda, citas, servicios, personal, ajustes, informes e historial. |
| `/recepcion` | Recepción o administrador | Trabajo diario con agenda, citas, servicios y personal. |
| `/qr` | Público | Cartel con QR para iniciar la conversación de WhatsApp. |
| `/qr-recepcion` | Público | Cartel de acceso al panel de recepción. |
| `/health` | Público | Comprobación del Worker. |

Sin `WHATSAPP_TOKEN`, los mensajes quedan en **modo consola**. Para enviar mensajes reales hacen falta la configuración de Meta, sus credenciales y las plantillas que se vayan a utilizar. La entrega real por Meta sigue pendiente de una verificación completa; consulta los [pendientes](instrucciones/TAREAS_PENDIENTES.md).

## Seguridad y operación

- Sesiones firmadas con HMAC-SHA256 y cookies `HttpOnly` / `SameSite=Strict`.
- Validación de `Origin`, políticas CSP por página y SQL parametrizado.
- Roles separados, bloqueo de login y límites de peticiones por sesión e IP.
- Validación de firma del webhook mediante `APP_SECRET` cuando está configurado.
- Copias manuales de D1 con validación, cifrado AES-256-GCM y herramientas de restauración aislada.

Los secretos se guardan en `.dev.vars` para desarrollo o con `wrangler secret put` en producción. Cada instalación debe aportar su propia configuración. El repositorio contiene ejemplos, no credenciales de una instalación real.

La PWA incluye manifest e iconos; **no incorpora funcionamiento offline**. Antes de instalar en un salón real, sigue la [puesta en marcha](docs/PUESTA_EN_MARCHA.md) y su checklist.

## Verificación

```powershell
npm run check      # Comprobación de tipos
npm run test:all   # Pruebas unitarias y auxiliares
```

La [CI](https://github.com/qirris/citasalon/actions/workflows/ci.yml) ejecuta esas comprobaciones y valida la sintaxis de `setup.ps1` en cada push a `master` y en pull requests.

El E2E comprueba el bot y los paneles contra Wrangler local. Su última ejecución documentada fue **189/189, sin fallos, el 30 de octubre de 2026**; no es una verificación de la entrega de mensajes en producción.

> `npm run e2e` **vacía las tablas de la D1 local** antes de comenzar y necesita el servidor local en ejecución. Ejecútalo únicamente en una base de pruebas cuyos datos puedas descartar. Los resultados y límites de las verificaciones están en [memoria.md](memoria.md).

<details>
<summary><strong>Mapa del código</strong></summary>

| Archivo | Responsabilidad |
| --- | --- |
| [`src/index.ts`](src/index.ts) | Webhook, rutas públicas, cola y tareas programadas. |
| [`src/bot.ts`](src/bot.ts) | Estados de conversación y selección de respuestas e intenciones. |
| [`src/consumer.ts`](src/consumer.ts) | Procesamiento del Inbox, bloqueo por teléfono, transacciones y Outbox. |
| [`src/db.ts`](src/db.ts) | Acceso a D1, citas, sesiones y auditoría. |
| [`src/availability.ts`](src/availability.ts) | Horarios y cálculo de huecos disponibles. |
| [`src/panels.ts`](src/panels.ts) | Paneles, formularios, agenda e informes. |
| [`src/auth.ts`](src/auth.ts) | Sesiones, HMAC y validación de origen. |
| [`src/whatsapp.ts`](src/whatsapp.ts) | Envío de mensajes por Meta. |
| [`src/reminders.ts`](src/reminders.ts) / [`src/notices.ts`](src/notices.ts) | Recordatorios y avisos de citas. |
| [`src/config.ts`](src/config.ts) | Configuración del salón y valores por defecto. |
| [`src/pwa.ts`](src/pwa.ts) | Manifest, iconos y cartel de recepción. |
| [`schema.sql`](schema.sql) / [`migrations/`](migrations/) | Esquema completo y migraciones para instalaciones existentes. |

</details>

## Documentación

| Quiero… | Leer |
| --- | --- |
| Orientarme en el proyecto | [Índice de documentación](docs/INDICE_DOCUMENTACION.md) |
| Instalarlo para un salón | [Puesta en marcha](docs/PUESTA_EN_MARCHA.md) |
| Personalizar servicios, personal y horarios | [Configuración de una peluquería real](docs/CONFIGURACION_PELUQUERIA_REAL.md) y [plantillas de datos](datos-salon/) |
| Consultar rutas y permisos | [Rutas y API](docs/RUTAS_Y_API.md) |
| Entender las tablas | [Modelo de datos](docs/MODELO_DE_DATOS.md) |
| Desplegar, hacer backups o restaurar | [Operación y despliegue](docs/OPERACION_Y_DESPLIEGUE.md) |
| Contribuir o continuar el desarrollo | [AGENTS.md](AGENTS.md), [memoria](memoria.md) y [tareas pendientes](instrucciones/TAREAS_PENDIENTES.md) |

<sub>Las capturas muestran la interfaz real con datos ficticios. [Detalles de las capturas](docs/capturas/README.md).</sub>
