# Tareas pendientes

Estado: proyecto funcional y desplegado; lo que queda depende de decisiones del usuario.

## En espera de decisión del usuario

1. **Activar WhatsApp en producción** (el usuario ha dicho explícitamente que NO por ahora):
   - `npx wrangler secret put WHATSAPP_TOKEN` (token EAA… de Meta; sin él el bot está en "modo consola").
   - `npx wrangler secret put APP_SECRET` (validación de firma de webhooks; recomendado).
   - En Meta: URL de devolución `https://<tu-worker>.workers.dev/webhook`, token de verificación `<VERIFY_TOKEN_DE_PRUEBA>`.
2. **Datos reales del salón**: `wrangler.jsonc` tiene valores de ejemplo ("Peluqueria Ejemplo", "Calle Ejemplo 1", "600 000 000", `WHATSAPP_NUMBER=<NUMERO_DE_PRUEBA>` ficticio, `WHATSAPP_PHONE_ID` de ejemplo). Cambiar y redeploy; el nombre/dirección/teléfono/servicios/horarios se pueden ajustar también desde `/admin/ajustes`.
3. **README**: no documenta los paneles (`/admin`, `/recepcion`, `/qr`) ni el sistema de memoria. Actualizar si el usuario lo pide.

## Opcionales / mejora continua

4. **Git**: inicializar repositorio y primer commit (protección de cambios; no hacer sin pedir).
5. **Revisión visual** de los paneles en navegador (el e2e valida contenido y estructura, no el diseño CSS).
6. Copia de seguridad periódica de D1 (`wrangler d1 export citasalon --remote --output backup.sql`).
7. Considerar rate-limit por usuario (no solo por IP) si algún día se expone a Internet con tráfico real de staff.

## Hecho recientemente (no repetir)

- [x] Módulos `auth.ts`, `config.ts`, `availability.ts`, `phone.ts`, `panels.ts`.
- [x] Rutas `/admin`, `/recepcion`, `/qr` + auditoría + seguridad (CSRF, bloqueo, CSP).
- [x] `npm run check` limpio; e2e 57/57.
- [x] D1 de producción creada (id `<DATABASE_ID>`) + esquema.
- [x] Worker publicado; secretos de panel/subida subidos (valores en manos del usuario).
- [x] Sistema de memoria (`memoria.md`, `AGENTS.md`, `instrucciones/`).
