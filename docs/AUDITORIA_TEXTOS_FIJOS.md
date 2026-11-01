# Auditoría de textos fijos

Fecha: 2026-10-23  
Ámbito: Bot de WhatsApp, recordatorios, validaciones, paneles `/admin`/`/recepcion`, PWA y QR de recepción.  
Sin cambios en `src/` ni `test/` durante esta auditoría.

## 1) Conversación de WhatsApp (`src/bot.ts`)

| Texto / concepto | Ubicación | Destinatario | Común / personalizable | Notas |
|---|---|---|---|---|
| Bienvenida: `¡Hola! Soy el asistente de *${s.salonName}*. ¿Qué quieres hacer?` | `bot.ts:86` | Cliente | Mixto | Usa `s.salonName` (editable en Ajustes). Botones/menu común. |
| Menú: "Reservar cita", "Mis citas", "Horario y dirección" | `bot.ts:87,91,219,222` | Cliente | Común estructura; datos vía `s` | Lógica común. |
| Info del salón: `*${s.salonName}*\n${s.address}\n📞 ${s.phone}\n\n⏰ *Horario*\n${hoursText(s)}` | `bot.ts:90` + `hoursText()` | Cliente | Personalizable via Ajustes/Settings | Dirección/teléfono/horario provienen de `Settings`. |
| Flujo reserva: pedir nombre, confirmar datos, confirmación final | `bot.ts:132-354` | Cliente | Estructura común | Usa `svc.name/price`, `stylist`, fecha/hora. Textos funcionales comunes. |
| Cancelación propia: listar citas, confirmar cancelación | `bot.ts:139,146,357-378` | Cliente | Común | Usa datos de cita. |
| Mensajes de error/aviso: "Ya tienes X citas reservadas...", "No tienes citas próximas...", "No te he entendido...", etc. | `bot.ts:204,212,363,375-376,378` | Cliente | Mayormente comunes | Algunos son transaccionales; no requieren personalización por salón. |

## 2) Recordatorios (`src/reminders.ts`, `src/whatsapp.ts`)

| Texto / concepto | Ubicación | Destinatario | Común / personalizable | Notas |
|---|---|---|---|---|
| Texto del recordatorio (modo consola/simulado): `¡Hola ${a.name}, te recordamos tu cita de *${a.service_name}* ${day} a las ${hour} en ${s.salonName}.\nSi no puedes venir, cancélala desde *Mis citas* para liberar el hueco.` | `reminders.ts:19-20` | Cliente | Mixto | Usa `s.salonName`. Plantilla sugerida en comentario para Meta (`reminders.ts:16`). En producción con WhatsApp real se debería usar una plantilla aprobada por Meta (`whatsapp.ts:73`). El texto actual está en español y es razonablemente genérico. |
| Comportamiento en modo consola: marca como enviado solo si es real; si simulado no marca como enviado | `reminders.ts:21-23`, `whatsapp.ts:6-9` | Sistema/logs | Común | Correcto para desarrollo. |

## 3) Validaciones y errores en paneles (`src/panels.ts`)

| Texto / concepto | Ubicación | Destinatario | Común / personalizable | Notas |
|---|---|---|---|---|
| Login: "Introduce la contraseña para entrar en el panel.", "Contraseña incorrecta." | `panels.ts:203,206,721` | Staff/Admin | Común | Genérico. |
| Errores de formulario de cita: fecha/hora/servicio/nombre/teléfono inválidos | `panels.ts:394-400` | Staff/Admin | Común | Reglas de validación, no texto de marca. |
| Reglas de negocio: "No se pueden crear citas en fechas pasadas.", `maxDaysAhead`, solapado con otro peluquero ("Esa hora se solapa...") | `panels.ts:407,411,779` | Staff/Admin | Común estructura; límites vienen de `Settings` | `maxDaysAhead` es configurable vía Ajustes (numérico). |
| Errores de Ajustes: formatos de horario/tramos, fechas de cierre/vacaciones, `sessionTtlMinutes` inválido | `panels.ts:469,480,498,510,537` | Admin | Común | Validación técnica. |
| Errores de borrado/restauración: "No se puede restaurar", confirmación de borrado irreversible | `panels.ts:924,937` | Admin | Común | Genéricos. |
| Mensajes flash: `?ok=...` y `?err=...` manejados por el router | `panels.ts` (uso general) | Staff/Admin | Común | Genéricos. |

## 4) Paneles UI (`src/panels.ts`)

| Texto / concepto | Ubicación | Destinatario | Común / personalizable | Notas |
|---|---|---|---|---|
| Navegación, títulos, botones comunes ("Cerrar sesión", "Nueva cita", "Guardar ajustes", etc.) | `panels.ts` (múltiples) | Staff/Admin | Mayormente común | Estructura de UI común. |
| Datos mostrados: nombre del salón, dirección, teléfono, servicios, peluqueros | Provenientes de `Settings` | Staff/Admin/Cliente | Personalizable vía Ajustes | Ya configurables. |
| Informes, historial, auditoría | `panels.ts` | Admin/Staff según rol | Común | Funcionalidad común. |

## 5) PWA y QR de recepción (`src/pwa.ts`, `src/index.ts`)

| Texto / concepto | Ubicación | Destinatario | Común / personalizable | Notas |
|---|---|---|---|---|
| Manifest PWA: `name`, `short_name`, `description` | `pwa.ts:4-23` (usa `s.salonName`) | Cliente/PWA | Personalizable | Ya usa nombre del salón. |
| Página QR recepción: título "Recepción — Personal", texto explicativo, nota "Requiere contraseña de recepción...", pie "Imprime este código..." | `pwa.ts:71-82` | Personal | Mayormente común | Usa `s.salonName/address/phone`. Los textos son instrucciones operativas genéricas. |
| Rutas públicas: `/manifest.json`, `/icon-*.png`, `/qr-recepcion` | `index.ts:88-106` | Público | Común | Sin datos de marca hardcodeados. |

## Conclusión sobre personalización

### Realmente necesario personalizar (ya soportado o prioritario)
- **Identidad**: `SALON_NAME`, dirección, teléfono → ya en `Settings`/Ajustes y usados por bot, paneles, PWA, QR.
- **Servicios**: nombres, duración, precio → ya configurables en Ajustes.
- **Personal/horarios**: peluqueros, horarios por peluquero, vacaciones → ya implementado.
- **Reglas de reserva**: `maxDaysAhead`, `minNoticeMinutes`, `slotMinutes`, `maxActive` → ya configurables.
- **Recordatorios**: si se pasa a plantillas aprobadas por Meta, el texto/plantilla deberá ajustarse al salón (y a las reglas de Meta). Hoy en modo consola usa un texto genérico con `s.salonName`.

### Común al producto (mantener fijo por ahora)
- Estructura del flujo conversacional, botones, estados.
- Mensajes de validación del panel, errores técnicos, mensajes de confirmación/cancelación.
- Textos de UI del panel (navegación, títulos genéricos).
- Textos operativos de QR/PWA (instrucciones genéricas).

### Notas importantes
- No hay sistema centralizado de "textos/i18n" hoy. Los textos están distribuidos en `src/bot.ts`, `src/reminders.ts`, `src/panels.ts`, `src/pwa.ts`.
- La personalización masiva de textos no es necesaria para el núcleo; lo verdaderamente necesario ya está cubierto por `Settings`.
- Si en el futuro se quiere personalizar todos los mensajes del bot, convendría extraerlos a un módulo de configuración de textos, pero **no es requisito para ponerlo en marcha con un salón real** (basta con ajustar nombre/dirección/teléfono/servicios/horarios).
- No se han modificado textos ni código. Esta auditoría es puramente informativa.
