import * as db from "./db.ts";
import { loadSettings } from "./config.ts";
import { nowLocal, fmtDay, hhmm, parseDT, startOfDay } from "./time.ts";
import type { Env } from "./types.ts";
import { sendTemplate, sendText } from "./whatsapp.ts";

/** Envía los recordatorios pendientes (citas en las próximas 24 h). Devuelve cuántos envió. */
export async function runReminders(env: Env, now: Date = nowLocal(env.SALON_TZ)): Promise<number> {
  const s = await loadSettings(env);
  let sent = 0;
  for (const a of await db.dueReminders(env.DB, now)) {
    const start = parseDT(a.starts_at);
    const day = fmtDay(startOfDay(start), startOfDay(now));
    const hour = hhmm(start);
    const result = env.REMINDER_TEMPLATE
      // Plantilla sugerida: "Hola {{1}}, te recordamos tu cita de {{2}} el {{3}} a las {{4}}. Si no puedes venir, responde CANCELAR."
      ? await sendTemplate(env, a.phone, env.REMINDER_TEMPLATE, env.REMINDER_TEMPLATE_LANG || "es", [a.name, a.service_name, day, hour])
      : await sendText(env, a.phone,
          `⏰ Hola ${a.name}, te recordamos tu cita de *${a.service_name}* ${day} a las ${hour} en ${s.salonName}.\n` +
          "Si no puedes venir, escribe *cancelar* para liberar el hueco.");
    if (result.ok && !result.simulated) { await db.markReminderSent(env.DB, a.id); sent++; }
    else if (result.simulated) { console.log(`[recordatorio simulado] No se marca como enviado: cita ${a.id}`); }
    else console.warn(`No se pudo enviar el recordatorio de la cita ${a.id}`);
  }
  return sent;
}
