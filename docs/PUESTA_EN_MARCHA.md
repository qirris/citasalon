# Puesta en marcha — salón nuevo

Guía reproducible para dejar el sistema funcionando para una peluquería cliente.
Sigue los pasos **en orden**. Al final tendrás el bot, los paneles y el QR
operativos, con sus datos y contraseñas.

> Este documento es la **secuencia técnica de comandos**. La recopilación de
> datos, las decisiones del propietario y la checklist de personalización están
> en `CONFIGURACION_PELUQUERIA_REAL.md` (misma carpeta `docs/`).

> Regla de oro: **los secretos (contraseñas, tokens) nunca se escriben en un
> archivo del repositorio**. Se meterán con `wrangler secret put` o `secret bulk`,
> que los guarda cifrados en Cloudflare.

---

## 0. Antes de empezar: qué necesitas

**Del salón** (rellena con las plantillas de `datos-salon/`):

- [ ] Nombre exacto, dirección y teléfono → `datos-salon/01-salon.md`
- [ ] Tipo de peluquería → `datos-salon/01-salon.md`
- [ ] Nombres de peluqueros + horario general (y propio, si alguno lo tiene) + vacaciones → `datos-salon/02-peluqueros.md`
- [ ] Servicios con duración y precio + reglas de reserva → `datos-salon/03-servicios.md`

**Técnico** (lo gestionas tú):

- [ ] Node.js instalado (`winget install OpenJS.NodeJS.LTS`) y `npm install` hecho.
- [ ] Cuenta de Cloudflare (la misma de siempre o una nueva del salón).
- [ ] App de WhatsApp Business en Meta (con teléfono verificado). Solo si se va a activar WhatsApp (paso 6).
- [ ] Repositorio en GitHub para el backup (paso 8).

---

## 1. Instalar y entrar en Cloudflare

```powershell
npm install
npx wrangler login
```

**Vía rápida**: doble clic en `instalar.bat` (o `setup.ps1`). Hace los pasos 1,
3, 4, 5 y 6 de forma guiada: pide un **nombre de Worker, una D1 y una cola propios**
(no reutiliza los de otra peluquería), crea la **D1 nueva y vacía**, aplica
`schema.sql`, crea la cola, despliega, genera las contraseñas y te prepara la
URL/token para el paso 6. Si usas esta vía, puedes saltarte los pasos manuales
equivalentes, pero **sigue necesitando** los datos del salón (paso 2) y, si vas a
activar WhatsApp, el webhook en Meta (paso 6). El token de WhatsApp es opcional:
si lo dejas vacío, el bot queda en modo consola.

---

## 2. Configurar los datos del salón

Hay dos sitios, según el dato:

### 2a. Variables que van en `wrangler.jsonc` (antes de desplegar)

Edita `wrangler.jsonc` → `vars`:

| Variable | Qué poner |
|---|---|
| `SALON_NAME` | Nombre del salón |
| `SALON_ADDRESS` | Dirección completa |
| `SALON_PHONE` | Teléfono público del salón |
| `SALON_TZ` | Zona horaria (España: `Europe/Madrid`) |
| `WHATSAPP_PHONE_ID` | ID del número de WhatsApp Business (de Meta) |
| `WHATSAPP_NUMBER` | Número de WhatsApp en formato internacional sin `+` (ej. `34600111222`) |

> `GRAPH_VERSION`, `REMINDER_TEMPLATE` y `REMINDER_TEMPLATE_LANG` normalmente no
> se tocan (plantillas de recordatorio; déjalas vacías salvo que Meta te dé una).

### 2b. Datos que se cambian desde el panel (sin redeploy)

Todo lo de `datos-salon/` se copia en **`/admin/ajustes`** una vez el sistema
está en marcha (paso 7):

- Nombre, dirección y teléfono (además de en `wrangler.jsonc`; lo del panel manda).
- Servicios (una línea: `id | nombre | minutos | precio`).
- Peluqueros y **horario general** del salón.
- **Horario propio y vacaciones** de cada peluquero (tarjeta «Horario de <peluquero>»).
- Días cerrados del salón y reglas de reserva (hueco, días por delante, antelación, máximo de citas).

---

## 3. Base de datos D1

### Si la D1 ya existe en tu cuenta
Solo asegúrate de que el esquema está aplicado (sustituye `citasalon` por el nombre real de tu base):

```powershell
npx wrangler d1 execute citasalon --remote --file=schema.sql
```

### Si es un salón nuevo con Worker, D1 y cola propios

Cada peluquería debe tener su **propio Worker, su propia D1 y su propia cola**.
**No reutilices** los de otra instalación ni apliques `schema.sql` sobre una base
con datos: se mezclarían citas y mensajes.

Elige nombres únicos (solo minúsculas, números y guiones):

```powershell
npx wrangler d1 create salon-nombre-db
```

Copia el `database_id` que devuelve y pégalo en `wrangler.jsonc`
(`d1_databases[0].database_id`), junto con el nombre del Worker (`name`) y el de
la cola (`queues.producers[0].queue` y `queues.consumers[0].queue`). Luego aplica
el esquema completo (solo crea estructura; no borra datos):

```powershell
npx wrangler d1 execute salon-nombre-db --remote --file=schema.sql
```

`setup.ps1` hace todo esto automáticamente: pide los tres nombres, crea la D1 y la
cola, actualiza `wrangler.jsonc` y aborta si la D1 ya existe, para no tocar datos
de otra instalación.

> `schema.sql` es el esquema completo para una instalación nueva e idempotente
> (`CREATE ... IF NOT EXISTS`). **No ejecutes después las migraciones `0001`–`0004`**:
> ya están incluidas. Las migraciones solo se usan para actualizar una base creada
> con una versión anterior; ver `docs/OPERACION_Y_DESPLIEGUE.md`.

---

## 4. Secretos del panel y del bot

Con `wrangler secret put` (pide el valor y no se ve en pantalla):

```powershell
npx wrangler secret put ADMIN_PASSWORD     # contraseña del panel /admin (mín. 10)
npx wrangler secret put STAFF_PASSWORD     # contraseña del panel /recepcion
npx wrangler secret put SESSION_SECRET     # cadena aleatoria larga (32+ caracteres)
npx wrangler secret put VERIFY_TOKEN       # el token de verificación del webhook
```

- Genera `ADMIN_PASSWORD` y `STAFF_PASSWORD` **distintas** y **apúntalas en tu
  gestor de contraseñas** en el momento: no se vuelven a mostrar.
- `SESSION_SECRET`: cualquier cadena aleatoria larga (firma las sesiones).
- `VERIFY_TOKEN`: lo eliges tú; el mismo valor irá en Meta (paso 6).

Opcional pero atajo: `setup.ps1` genera contraseñas y sube todos los secretos de
una vez con `wrangler secret bulk`. Si no vas a activar WhatsApp todavía, deja
vacío el token de WhatsApp: el script no lo exige y el bot queda en modo consola.

---

## 5. Desplegar

Antes de desplegar, crea la cola de WhatsApp. **Una cola por instalación** (no la
compartas entre peluquerías: los mensajes se mezclarían). `setup.ps1` la crea con
el nombre que elijas; si lo haces a mano, usa un nombre único y actualízalo en
`wrangler.jsonc`:

```powershell
npx wrangler queues create salon-nombre-inbox
```

Después:

```powershell
npm run deploy
```

Anota la URL que sale: `https://<algo>.workers.dev`. Es la base de todo:

- Panel admin: `.../admin`
- Recepción: `.../recepcion`
- Cartel QR (para clientes): `.../qr`
- Salud (para comprobar): `.../health`

---

## 6. Activar WhatsApp (solo si el salón lo va a usar)

En el panel de Meta (WhatsApp → Configuración → Webhooks):

1. **URL de devolución de llamada**: `https://<tu-url>.workers.dev/webhook`
2. **Token de verificación**: el mismo que pusiste en `VERIFY_TOKEN` (paso 4).
3. Suscríbete al campo **`messages`**.
4. Sube además el token de la API como secreto:

```powershell
npx wrangler secret put APP_SECRET       # App Secret de Meta (valida la firma)
npx wrangler secret put WHATSAPP_TOKEN   # token EAA... de la API
```

Sin `WHATSAPP_TOKEN` el bot funciona en **modo consola**: registra en los logs lo
que habría enviado, sin enviar nada.

---

## 7. Comprobar que todo funciona

```powershell
# 1) El worker responde
Invoke-WebRequest -UseBasicParsing "https://<tu-url>.workers.dev/health"   # {"ok":true}

# 2) El cartel QR se genera
Invoke-WebRequest -UseBasicParsing "https://<tu-url>.workers.dev/qr"       # 200 + <svg>

# 3) Paneles
#    Abre .../admin, entra con ADMIN_PASSWORD y revisa/limpia la agenda.
#    Abre .../recepcion con STAFF_PASSWORD.
```

Prueba de punta a punta **en local** (no toca producción):

```powershell
npx wrangler d1 execute citasalon --local --file=schema.sql
npm run dev            # terminal 1 (http://localhost:8787)
npm run e2e            # terminal 2 -> último resultado: 189/189, 0 fallidas, exit 0 (2026-10-30)
```

> `npm run e2e` **borra las tablas de la D1 local** y necesita autorización. No se ejecuta contra producción. Si no se puede ejecutar, como mínimo `npm run check` y `node --check test/e2e.mjs`.

Prueba real: escribe al WhatsApp del salón, reserva una cita y comprueba que
aparece en `/admin`. Si activaste WhatsApp, mira también que llegue el mensaje.

---

## 8. Backup automático

**Estado:** el workflow está preparado y probado en local, pero **todavía no se ha verificado** con una ejecución real en GitHub Actions. Los secretos de GitHub siguen pendientes de configurar y no existe ningún artefacto generado por el workflow. La retención de 30 días está configurada; se confirmará cuando haya una ejecución correcta.

En GitHub → repositorio → *Settings* → *Secrets and variables* → *Actions* → **Repository secrets**, añade:

- `CLOUDFLARE_API_TOKEN` — token de API de Cloudflare. Permiso propuesto: **Account > D1 > Read**, con acceso a la cuenta donde está la base `citasalon`. Es el mínimo necesario para exportar, pero debe confirmarse en la primera ejecución real; si Wrangler devuelve un error de permisos, revisa el alcance del token y la cuenta.
- `CLOUDFLARE_ACCOUNT_ID` — ID de esa misma cuenta de Cloudflare.
- `BACKUP_ENCRYPTION_KEY` — contraseña larga y aleatoria (mínimo 16 caracteres; recomendado `openssl rand -base64 32`). Debe ser **independiente** de `ADMIN_PASSWORD`, `STAFF_PASSWORD` y `SESSION_SECRET`. Si se pierde, los backups cifrados no se podrán recuperar.

No los crees como *Environment secrets*: el workflow no declara `environment`, así que solo lee los secretos de repositorio.

El workflow `.github/workflows/backup.yml`:

- comprueba que los tres secretos existen y falla con un error explícito si falta alguno, antes de exportar nada;
- exporta la base remota `citasalon` a `backups/backup.sql` (el archivo está fuera de Git);
- valida el SQL con `scripts/validate-d1-backup.py` sobre una SQLite en memoria: debe ejecutarse completo, `PRAGMA integrity_check` debe devolver `ok` y debe existir de verdad la tabla `appointments`;
- cifra el SQL validado con AES-256-GCM mediante `scripts/encrypt-backup.mjs`, con IV aleatorio y SHA-256 de integridad embebidos en el propio archivo `.sql.enc`;
- descifra el artefacto y lo compara con el original (`cmp`) antes de publicar;
- sube **únicamente** `backups/backup.sql.enc`, con retención de 30 días;
- borra siempre el SQL en claro y la copia de verificación, incluso si falla un paso.

La validación detecta errores de sintaxis y truncamientos que rompen el SQL (por ejemplo, paréntesis o cadenas sin cerrar). **No puede garantizar que el archivo esté completo** si el corte cae justo entre dos sentencias válidas: el export de D1 no incluye un marcador final fiable (no usa `BEGIN`/`COMMIT`; empieza por `PRAGMA defer_foreign_keys=TRUE;`).

### Ejecución manual

1. GitHub → pestaña **Actions**.
2. Selecciona el workflow **Backup D1**.
3. Pulsa **Run workflow**.
4. Ejecuta sobre la rama **master**.
5. Abre la ejecución y comprueba los pasos **Comprobar variables necesarias**, **Exportar D1 (remoto)**, **Validar artefacto de backup**, **Cifrar backup** y **Verificar descifrado antes de publicar**.
6. En la página de la ejecución, entra en **Artifacts** y descarga `d1-backup-AAAA-MM-DD` (la fecha es la del día en UTC). Contiene un único archivo `.sql.enc`.
7. Comprueba que el `.enc` **no** contiene texto SQL legible y que el paso de limpieza se ha ejecutado.

**Privacidad:** el backup contiene nombres y teléfonos de clientes. El artefacto está cifrado con AES-256-GCM; el SQL en claro nunca se sube y se borra al terminar el workflow. Descarga el artefacto solo por canales seguros y no lo adjuntes a issues. El procedimiento de descifrado y restauración aislada está en `docs/OPERACION_Y_DESPLIEGUE.md` §2.

**Pendiente:** configurar los secretos, ejecutar el workflow y confirmar que el token tiene permisos suficientes, que la validación y el cifrado pasan y que el artefacto se descarga y se puede restaurar. Hasta entonces no se puede afirmar que el backup automático funcione en producción.

---

## 9. Entregables al cliente

- [ ] URL del cartel QR (`.../qr`) → para imprimir y ponerlo en el mostrador.
- [ ] Contraseñas de `/admin` y `/recepcion` (por un canal seguro, no por el repo).
- [ ] Número de WhatsApp del salón activo y probado.
- [ ] Confirmación de que los datos, horarios y servicios están puestos (2b).
- [ ] Aviso de que el backup diario está funcionando (8).

---

## Errores típicos

- **El login en producción falla** → faltan los secretos del paso 4 (sin
  `ADMIN_PASSWORD`/`SESSION_SECRET` en el worker remoto no hay sesión).
- **El bot no envía mensajes** → falta `WHATSAPP_TOKEN`, o el webhook de Meta no
  tiene la URL/token correctos (paso 6).
- **No aparecen huecos** → revisa horario del salón y el horario propio de cada
  peluquero, días cerrados y «antelación mínima» en Ajustes.
- **Un cliente no encuentra sus citas** → el teléfono debe coincidir con el de
  WhatsApp; el sistema normaliza los españoles a `+34…`, pero un número de otro
  país hay que revisarlo.
- **«nombre/dirección con comillas»** → no debería pasar (corregido); si lo ves,
  es señal de datos viejos, vuelve a guardar Ajustes.

---

## Checklist final (resumen)

1. [ ] Datos del salón recopilados (`datos-salon/`).
2. [ ] `wrangler.jsonc` con los datos reales.
3. [ ] D1 con el esquema aplicado.
4. [ ] Secretos de panel subidos.
5. [ ] `npm run deploy` y URLs anotadas.
6. [ ] Webhook de Meta configurado (+ `APP_SECRET`/`WHATSAPP_TOKEN` si aplica).
7. [ ] Comprobado `/health`, `/qr`, login y una reserva real.
8. [ ] Ajustes del panel rellenados (servicios, peluqueros, horarios, reglas).
9. [ ] Secretos de GitHub para el backup.
10. [ ] Entregables pasados al cliente.
