import type { Appt, Env } from "./types.ts";
import { fmtDay, hhmm, parseDT, startOfDay } from "./time.ts";
import { sendTemplate, type SendResult } from "./whatsapp.ts";

export type NoticeAppt = Pick<Appt, "id" | "phone" | "service_id" | "service_name" | "stylist" | "starts_at">;

export type TemplateSender = (
  env: Env, to: string, name: string, lang: string, params: string[],
) => Promise<SendResult>;

export function cancellationParams(a: NoticeAppt): string[] {
  const start = parseDT(a.starts_at);
  return [a.service_name, fmtDay(startOfDay(start)), hhmm(start)];
}

export function updateParams(a: NoticeAppt): string[] {
  return [...cancellationParams(a), a.stylist];
}

/** Parámetros para la plantilla de confirmación de reserva: servicio, fecha, hora, peluquero. */
export function creationParams(a: NoticeAppt): string[] {
  return [...cancellationParams(a), a.stylist];
}

export function changedForNotice(before: NoticeAppt, after: NoticeAppt): boolean {
  return before.starts_at !== after.starts_at
    || before.service_id !== after.service_id
    || before.stylist !== after.stylist;
}

async function notify(
  env: Env, appt: NoticeAppt, template: string, lang: string, params: string[],
  label: string, send: TemplateSender,
): Promise<SendResult | null> {
  if (!template || !lang) {
    console.log(`[aviso ${label}] omitido: plantilla o idioma sin configurar (cita ${appt.id})`);
    return null;
  }
  if (!appt.phone.trim()) {
    console.log(`[aviso ${label}] omitido: la cita ${appt.id} no tiene teléfono de cliente`);
    return null;
  }
  let result: SendResult;
  try {
    result = await send(env, appt.phone, template, lang, params);
  } catch {
    console.error(`[aviso ${label}] error de envío con la plantilla "${template}" (cita ${appt.id})`);
    return { ok: false, simulated: false };
  }
  if (!result.ok) {
    console.error(`[aviso ${label}] Meta rechazó la plantilla "${template}" (cita ${appt.id})`);
  } else if (result.simulated) {
    console.log(`[aviso ${label} simulado] plantilla "${template}" (cita ${appt.id})`);
  }
  return result;
}

export function notifyCancellation(
  env: Env, appt: NoticeAppt, send: TemplateSender = sendTemplate,
): Promise<SendResult | null> {
  return notify(env, appt, env.CANCEL_TEMPLATE, env.CANCEL_TEMPLATE_LANG,
    cancellationParams(appt), "cancelación", send);
}

export function notifyUpdate(
  env: Env, appt: NoticeAppt, send: TemplateSender = sendTemplate,
): Promise<SendResult | null> {
  return notify(env, appt, env.UPDATE_TEMPLATE, env.UPDATE_TEMPLATE_LANG,
    updateParams(appt), "actualización", send);
}

/**
 * Avisa de que una cita acaba de crearse desde un panel.
 * Se envía una única vez, tras guardar correctamente. No se envía si la creación falla,
 * si no hay teléfono de cliente o si la plantilla no está configurada.
 */
export function notifyCreation(
  env: Env, appt: NoticeAppt, send: TemplateSender = sendTemplate,
): Promise<SendResult | null> {
  return notify(env, appt, env.CREATE_TEMPLATE, env.CREATE_TEMPLATE_LANG,
    creationParams(appt), "creación", send);
}
