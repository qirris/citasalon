/**
 * Conversación de WhatsApp: un autómata de estados con botones y listas.
 *
 *   MENU -> SERVICE -> STYLIST -> DAY -> TIME -> NAME -> CONFIRM    (reservar)
 *   MENU -> CANCEL_PICK -> CANCEL_CONFIRM                           (cancelar / reprogramar)
 *   MENU -> RESCHED_PICK -> RESCHED_CONFIRM -> RESCHED_DAY -> RESCHED_TIME -> RESCHED_FINAL
 *
 * `STYLIST` permite elegir peluquero o "me da igual" (se asigna el primero libre).
 * Todo funciona también si el cliente escribe en vez de pulsar ("tinte", "Ana", "mañana", "17:30").
 *
 * IMPORTANTE: este módulo NO escribe en D1. Solo lee disponibilidad y citas para construir
 * la respuesta y, cuando hay que modificar algo, devuelve un `Intent`. El Consumer es quien
 * valida el bloqueo, ejecuta la intención, guarda la sesión y encola la respuesta.
 */
import * as db from "./db.ts";
import type { Intent } from "./types.ts";
import { daysWithAvailability, freeSlots, stylistSpans, workingStylists } from "./availability.ts";
import { loadSettings } from "./config.ts";
import type { Appt, BotMessage, Env, Service, Settings } from "./types.ts";
import {
  DAYS, addDays, dayStr, fmtDay, hhmm, iso, parseDT, parseDay, shortDay, startOfDay,
} from "./time.ts";

const GREETINGS = new Set(["hola", "buenas", "buenos dias", "buenas tardes", "buenas noches", "hey", "hi",
  "menu", "inicio", "empezar", "ayuda", "0"]);
const YES = new Set(["si", "s", "vale", "ok", "okey", "confirmo", "confirmar", "correcto", "dale", "claro",
  "perfecto", "yes", "de acuerdo", "adelante", "por supuesto"]);
const NO = new Set(["no", "nop", "nope", "no gracias", "nada", "descartar"]);
const MAX_LIST_ROWS = 10;   // límite de WhatsApp
const ANY_STYLIST_WORDS = ["me da igual", "el primero", "cualquiera", "indiferente", "lo que sea", "any"];

export interface BotSession {
  state: string;
  data: Record<string, any>;
  expired?: boolean;
  /** WAMID del mensaje que se está procesando (lo pone el Consumer; no se guarda en la sesión). */
  wamid?: string;
}

export interface BotResult {
  replies: BotMessage[];
  state: string;
  data: Record<string, any>;
  intent: Intent | null;
}

interface Ctx {
  env: Env; db: D1Database; s: Settings;
  phone: string; text: string; low: string; profile: string | null; now: Date;
  data: Record<string, any>; payload: string | null;
  session: BotSession;
}
type Result = [BotMessage[], string, Record<string, any>, Intent | null];

// ------------------------------------------------------------------ mensajes
const buttons = (body: string, ...opts: [string, string][]): BotMessage =>
  ({ type: "buttons", body, buttons: opts.map(([id, title]) => ({ id, title })) });
const choose = (body: string, button: string, rows: { id: string; title: string; description?: string }[], section = "Opciones"): BotMessage =>
  ({ type: "list", body, button, section, rows });

/** Texto plano de un mensaje (para pruebas y consola) */
export function asText(m: BotMessage): string {
  if (typeof m === "string") return m;
  if (m.type === "buttons") return `${m.body}\n\n${m.buttons.map((b) => `[${b.title}]`).join("  ")}`;
  return `${m.body}\n\n${m.rows.map((r, i) => `${i + 1}. ${r.title}${r.description ? ` (${r.description})` : ""}`).join("\n")}`;
}

// ------------------------------------------------------------------ utilidades
export function norm(text: string): string {
  return (text ?? "").toLowerCase().normalize("NFD").replace(/\p{Mn}/gu, "")
    .replace(/[^a-z0-9:. ]/g, " ").replace(/\s+/g, " ").replace(/^[ .:]+|[ .:]+$/g, "");
}

const isYes = (low: string, raw: string) => YES.has(low) || raw.includes("👍");
const isNo = (low: string) => NO.has(low);

export function cleanName(raw: string): string | null {
  const name = (raw ?? "").replace(/[^\p{L}\p{N}_\s'’.-]/gu, "").replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 40 || /^\d+$/.test(name)) return null;
  if (name === name.toLowerCase() || name === name.toUpperCase()) {
    return name.toLowerCase().replace(/(^|[\s'’.-])(\p{L})/gu, (_, a, b) => a + b.toUpperCase());
  }
  return name;
}

function hoursText(s: Settings): string {
  const names = DAYS.map((d) => d.charAt(0).toUpperCase() + d.slice(1));
  return names.map((n, i) => {
    const spans = s.hours[i] ?? [];
    return `${n}: ${spans.length ? spans.map(([a, b]) => `${a}-${b}`).join(" y ") : "cerrado"}`;
  }).join("\n");
}

const payloadValue = (c: Ctx, prefix: string) =>
  c.payload && c.payload.startsWith(prefix) ? c.payload.slice(prefix.length) : null;

/** Sí/no por botón (`prefix`yes / `prefix`no) o escrito. null = no se entiende */
function answer(c: Ctx, prefix: string): boolean | null {
  const v = payloadValue(c, prefix);
  if (v === "yes" || v === "no") return v === "yes";
  if (isYes(c.low, c.text)) return true;
  if (isNo(c.low)) return false;
  return null;
}

const serviceById = (s: Settings, id: string): Service | undefined => s.services.find((x) => x.id === id);
const activeServices = (s: Settings): Service[] => s.services.filter((x) => x.active !== false);

/** Peluqueros con algún tramo de trabajo semanal (los que no tienen horario no se ofrecen). */
export function bookableStylists(s: Settings): string[] {
  return s.stylists.filter((st) => {
    for (let wd = 0; wd < 7; wd++) if (stylistSpans(s, st, wd).length) return true;
    return false;
  });
}

// ------------------------------------------------------------------ constructores de mensajes
const msgMenu = (s: Settings) => buttons(
  `¡Hola! 👋 Soy el asistente de *${s.salonName}*.\n¿Qué quieres hacer?`,
  ["menu:book", "Reservar cita"], ["menu:manage", "Mis citas"], ["menu:info", "Horario y dirección"]);

const msgInfo = (s: Settings) => buttons(
  `📍 *${s.salonName}*\n${s.address}\n📞 ${s.phone}\n\n🕒 *Horario*\n${hoursText(s)}`,
  ["menu:book", "Reservar cita"], ["menu:manage", "Mis citas"]);

const msgServices = (s: Settings) => choose("¿Qué servicio quieres?", "Ver servicios",
  activeServices(s).map((v) => ({ id: `svc:${v.id}`, title: v.name, description: `${v.minutes} min · ${v.price}` })), "Servicios");

function msgStylists(s: Settings, data: Record<string, any>): BotMessage {
  const all = bookableStylists(s);
  const page = Math.max(0, Number(data.stylist_page ?? 0));
  const perPage = 8;
  const pages = Math.max(1, Math.ceil(all.length / perPage));
  const current = page % pages;
  const rows: { id: string; title: string; description?: string }[] = all.slice(current * perPage, (current + 1) * perPage)
    .map((st) => ({ id: `stylist:${st}`, title: st }));
  rows.push({ id: "stylist:__any__", title: "Me da igual", description: "El primero disponible" });
  if (all.length > perPage) rows.push({ id: "stylist:more", title: "Ver más peluqueros" });
  return choose(`¿Con qué peluquero te gustaría reservar?\nTambién puedes escribir su nombre o *me da igual*.`,
    "Ver peluqueros", rows, "Peluqueros");
}

const withStylist = (stylist?: string | null) => stylist ? ` con *${stylist}*` : "";

const msgDays = (svc: Service, days: Date[], now: Date, stylist?: string | null) => choose(
  `Perfecto: *${svc.name}* (${svc.minutes} min, ${svc.price})${withStylist(stylist)}.\n¿Qué día te viene bien?`, "Ver días",
  days.map((d) => ({ id: `day:${dayStr(d)}`, title: shortDay(d, now) })), "Días disponibles");

function msgTimes(day: Date, slots: Date[], now: Date, data: Record<string, any>): BotMessage {
  const morning = slots.filter((x) => x.getUTCHours() < 14);
  const afternoon = slots.filter((x) => x.getUTCHours() >= 14);
  const label = fmtDay(day, now);
  const hint = "También puedes escribirme la hora, por ejemplo *17:30*.";
  const period: string | null = data.period ?? null;
  const stylist = data.stylist ? ` con *${data.stylist}*` : "";

  if (period === null && morning.length && afternoon.length) {
    return buttons(`Hay horas libres para *${label}*${stylist}.\n¿Prefieres por la mañana o por la tarde?\n${hint}`,
      ["period:am", "Mañana"], ["period:pm", "Tarde"]);
  }
  const usePm = (period === "pm" && afternoon.length > 0) || !morning.length;
  const subset = usePm ? afternoon : morning;
  const name = usePm ? "tarde" : "mañana";
  const other = usePm ? morning : afternoon;
  const [otherId, otherName] = usePm ? ["period:am", "mañana"] : ["period:pm", "tarde"];

  let rows: { id: string; title: string; description?: string }[];
  if (subset.length > MAX_LIST_ROWS) {           // más horas de las que caben: paginamos
    const perPage = MAX_LIST_ROWS - 1;
    const pages = Math.ceil(subset.length / perPage);
    const page = (data.page ?? 0) % pages;
    rows = subset.slice(page * perPage, (page + 1) * perPage).map((x) => ({ id: `time:${iso(x)}`, title: hhmm(x) }));
    rows.push({ id: "more", title: "Ver más horas" });
  } else {
    rows = subset.map((x) => ({ id: `time:${iso(x)}`, title: hhmm(x) }));
    if (other.length && rows.length < MAX_LIST_ROWS) rows.push({ id: otherId, title: `Ver horas de ${otherName}` });
  }
  return choose(`Horas libres de ${name} para *${label}*${stylist}.\n${hint}`, "Ver horas", rows, `Horas de ${name}`);
}

const msgName = (dflt: string | null): BotMessage => dflt
  ? buttons(`¿Pongo la cita a nombre de *${dflt}*?`, ["name:yes", "Sí, ese nombre"], ["name:other", "Otro nombre"])
  : "¿A nombre de quién pongo la cita? Escríbeme el nombre.";

const msgConfirm = (svc: Service, start: Date, name: string, stylist?: string | null) => buttons(
  `Revisa tu cita:\n\n💇 ${svc.name} (${svc.price})\n📅 ${fmtDay(start)}\n🕒 ${hhmm(start)}${withStylist(stylist)}\n👤 ${name}\n\n¿La confirmo?`,
  ["confirm:yes", "✅ Confirmar"], ["confirm:no", "❌ Descartar"]);

const msgManage = (appts: Appt[]) => choose("Tus próximas citas. Toca la que quieras gestionar.", "Ver citas",
  appts.map((a) => {
    const d = parseDT(a.starts_at);
    const t = `${shortDay(d, addDays(d, 9999))}, ${hhmm(d)}`;   // sin "Hoy/Mañana": el título ya lleva la fecha
    return { id: `appt:${a.id}`, title: t, description: `${a.service_name} · ${a.stylist}` };
  }), "Mis citas");

const msgCancelConfirm = (a: Appt) => buttons(
  `¿Qué quieres hacer con *${a.service_name}* el ${fmtDay(parseDT(a.starts_at))} a las ${hhmm(parseDT(a.starts_at))}?`,
  ["cancel:yes", "Sí, cancelar"], ["resched:yes", "Reprogramar"], ["cancel:no", "No, mantenerla"]);

const msgReschedConfirm = (a: Appt) => buttons(
  `Has elegido *${a.service_name}* el ${fmtDay(parseDT(a.starts_at))} a las ${hhmm(parseDT(a.starts_at))}.\n¿Quieres reprogramarla?`,
  ["resched:yes", "Reprogramar"], ["resched:no", "Dejarla igual"]);

const msgReschedDays = (a: Appt, days: Date[], now: Date) => choose(
  `Nueva fecha para *${a.service_name}*${withStylist(a.stylist)}.\n¿Qué día te viene bien?`, "Ver días",
  days.map((d) => ({ id: `day:${dayStr(d)}`, title: shortDay(d, now) })), "Días disponibles");

const msgReschedFinal = (a: Appt, start: Date) => buttons(
  `Vas a cambiar tu cita:\n\n💇 ${a.service_name}\n📅 Antes: ${fmtDay(parseDT(a.starts_at))} a las ${hhmm(parseDT(a.starts_at))}\n` +
  `📅 Ahora: ${fmtDay(start)} a las ${hhmm(start)}${withStylist(a.stylist)}\n\n¿Confirmo el cambio?`,
  ["resched:yes", "✅ Confirmar cambio"], ["resched:no", "❌ Dejarlo igual"]);

// Respuestas de éxito: se envían después de que el Consumer haya persistido la intención.
const msgBooked = (svc: Service, start: Date, name: string, stylist?: string | null) => buttons(
  `✅ *Cita confirmada*, ${name}.\n\n💇 ${svc.name}\n📅 ${fmtDay(start)}\n🕒 ${hhmm(start)}${withStylist(stylist)}\n\n` +
  `Te esperamos. Si necesitas cambiarla, entra en *Mis citas*.`,
  ["menu:manage", "Mis citas"], ["menu:book", "Otra cita"]);

const msgCancelled = (a: Appt) => buttons(
  `✅ Cita cancelada: *${a.service_name}* el ${fmtDay(parseDT(a.starts_at))} a las ${hhmm(parseDT(a.starts_at))}.\n` +
  `El hueco vuelve a estar libre.`,
  ["menu:book", "Reservar otra"]);

const msgRescheduled = (a: Appt, start: Date) => buttons(
  `✅ Cita cambiada.\n\n💇 ${a.service_name}\n📅 ${fmtDay(start)} a las ${hhmm(start)}${withStylist(a.stylist)}\n\n` +
  `La anterior queda liberada.`,
  ["menu:manage", "Mis citas"]);

// ------------------------------------------------------------------ selección por texto
const pickIndex = (low: string, size: number) => (/^\d+$/.test(low) && +low >= 1 && +low <= size ? +low - 1 : null);

export function pickService(s: Settings, low: string): Service | null {
  const list = activeServices(s);
  const idx = pickIndex(low, list.length);
  if (idx !== null) return list[idx];
  if (low.length < 4) return null;
  const hits = list.filter((v) => norm(v.name).includes(low) || low.includes(norm(v.name)));
  return hits.length === 1 ? hits[0] : null;
}

export function pickStylist(s: Settings, low: string): { name: string | null } | null {
  if (ANY_STYLIST_WORDS.some((w) => low.includes(w))) return { name: null };
  const list = bookableStylists(s);
  const exact = list.find((st) => norm(st) === low);
  if (exact) return { name: exact };
  const hits = list.filter((st) => norm(st).includes(low) || low.includes(norm(st)));
  return hits.length === 1 ? { name: hits[0] } : null;
}

export function pickDay(low: string, days: Date[], now: Date): Date | null {
  const idx = pickIndex(low, days.length);
  if (idx !== null) return days[idx];
  if (/^\d+$/.test(low)) return days.find((d) => d.getUTCDate() === +low) ?? null;
  const today = startOfDay(now);
  const find = (t: Date) => days.find((d) => dayStr(d) === dayStr(t)) ?? null;
  if (low.includes("pasado manana")) return find(addDays(today, 2));
  if (low.includes("manana")) return find(addDays(today, 1));
  if (low.includes("hoy")) return find(today);
  for (let i = 0; i < 7; i++) {
    if (low.includes(norm(DAYS[i]))) return days.find((d) => (d.getUTCDay() + 6) % 7 === i) ?? null;
  }
  return null;
}

export function pickTime(low: string, day: Date, slots: Date[]): Date | null {
  let h: number, mi: number;
  let m = low.match(/(\d{1,2})\s*[:.h]\s*(\d{2})/);
  if (m) { h = +m[1]; mi = +m[2]; }
  else {
    m = low.match(/\b(\d{1,2})\s*(?:h|horas?)?\b/);
    if (!m) return null;
    h = +m[1]; mi = 0;
  }
  const candidates: [number, number][] = [[h, mi]];
  if (h < 12) candidates.push([h + 12, mi]);          // "a las 5" -> 17:00
  for (const [hh, mm] of candidates) {
    if (hh < 24 && mm < 60) {
      const t = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hh, mm));
      const hit = slots.find((x) => x.getTime() === t.getTime());
      if (hit) return hit;
    }
  }
  return null;
}

// ------------------------------------------------------------------ manejadores de estado
const noSlotsLeft = (s: Settings): Result =>
  [[`Lo siento, ya no quedan huecos. Llámanos al ${s.phone}.`], "MENU", {}, null];

async function startBooking(c: Ctx): Promise<Result> {
  const active = await db.futureAppointments(c.db, c.phone, c.now);
  if (active.length >= c.s.maxActive) {
    return [[buttons(`Ya tienes ${active.length} citas reservadas. Cancela alguna antes de pedir otra.`,
      ["menu:manage", "Mis citas"])], "MENU", {}, null];
  }
  if (!activeServices(c.s).length) {
    return [[`Ahora mismo no hay servicios disponibles. Llámanos al ${c.s.phone}.`], "MENU", {}, null];
  }
  return [[msgServices(c.s)], "SERVICE", {}, null];
}

async function startManage(c: Ctx): Promise<Result> {
  const appts = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
  if (!appts.length) return [[buttons("No tienes citas próximas.", ["menu:book", "Reservar cita"])], "MENU", {}, null];
  return [[msgManage(appts)], "CANCEL_PICK", { ids: appts.map((a) => a.id) }, null];
}

async function hMenu(c: Ctx): Promise<Result> {
  const low = c.low;
  if (low === "2" || low.includes("mis citas") || low.includes("mi cita")) return startManage(c);
  if (low === "3" || ["horario", "direccion", "ubicacion", "donde", "abierto"].some((w) => low.includes(w))) {
    return [[msgInfo(c.s)], "MENU", {}, null];
  }
  if (low === "1" || ["reserv", "cita", "pedir", "agendar", "turno"].some((w) => low.includes(w))) return startBooking(c);
  return [["No te he entendido bien. Escribe *hola* para ver el menú."], "MENU", {}, null];
}

async function hService(c: Ctx): Promise<Result> {
  const sid = payloadValue(c, "svc:");
  const svc = sid ? activeServices(c.s).find((x) => x.id === sid) : pickService(c.s, c.low);
  if (!svc) return [["No te he entendido. Elige un servicio de la lista:", msgServices(c.s)], "SERVICE", {}, null];
  if (bookableStylists(c.s).length) {
    return [[msgStylists(c.s, {})], "STYLIST", { service_id: svc.id, stylist_page: 0 }, null];
  }
  const days = await daysWithAvailability(c.db, c.s, svc.minutes, c.now);
  if (!days.length) {
    return [[`Ahora mismo no tengo huecos libres en los próximos ${c.s.maxDaysAhead} días. Llámanos al ${c.s.phone} y lo miramos.`], "MENU", {}, null];
  }
  return [[msgDays(svc, days, c.now)], "DAY", { service_id: svc.id, days: days.map(dayStr), stylist: null }, null];
}

async function hStylist(c: Ctx): Promise<Result> {
  const { data, s } = c;
  const svc = serviceById(s, data.service_id);
  if (!svc) return [["Ha cambiado la carta de servicios, empecemos de nuevo.", msgMenu(s)], "MENU", {}, null];

  const p = payloadValue(c, "stylist:");
  if (p === "more") {
    const next = Number(data.stylist_page ?? 0) + 1;
    data.stylist_page = next;
    return [[msgStylists(s, data)], "STYLIST", data, null];
  }
  let chosen: { name: string | null } | null;
  if (p === "__any__") chosen = { name: null };
  else if (p !== null) chosen = bookableStylists(s).includes(p) ? { name: p } : null;
  else chosen = pickStylist(s, c.low);

  if (!chosen) return [["No te he entendido. Elige un peluquero de la lista:", msgStylists(s, data)], "STYLIST", data, null];

  const only = chosen.name ?? undefined;
  const days = await daysWithAvailability(c.db, s, svc.minutes, c.now, only);
  if (!days.length) {
    const who = chosen.name ? `${chosen.name} no tiene huecos` : "No hay huecos";
    return [[`${who} para *${svc.name}* en los próximos días. Elige otro peluquero o llámanos al ${s.phone}.`,
      msgStylists(s, data)], "STYLIST", data, null];
  }
  return [[msgDays(svc, days, c.now, chosen.name)], "DAY",
    { service_id: svc.id, days: days.map(dayStr), stylist: chosen.name }, null];
}

async function hDay(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const svc = serviceById(s, data.service_id)!;
  const only = data.stylist ?? undefined;
  let days: Date[] = (data.days as string[]).map(parseDay);
  const isoDay = payloadValue(c, "day:");
  const day = isoDay ? ((data.days as string[]).includes(isoDay) ? parseDay(isoDay) : null) : pickDay(c.low, days, now);
  if (!day) return [["No te he entendido. Elige un día de la lista:", msgDays(svc, days, now, data.stylist)], "DAY", data, null];

  const slots = await freeSlots(c.db, s, day, svc.minutes, now, undefined, only);
  if (!slots.length) {                               // alguien se llevó los últimos huecos mientras tanto
    days = await daysWithAvailability(c.db, s, svc.minutes, now, only);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Ese día se acaba de llenar. Elige otro:", msgDays(svc, days, now, data.stylist)], "DAY", data, null];
  }
  Object.assign(data, { day: dayStr(day), period: null, page: 0 });
  return [[msgTimes(day, slots, now, data)], "TIME", data, null];
}

async function hTime(c: Ctx): Promise<Result> {
  const { data, now, s, low } = c;
  const svc = serviceById(s, data.service_id)!;
  const only = data.stylist ?? undefined;
  const day = parseDay(data.day);
  const slots = await freeSlots(c.db, s, day, svc.minutes, now, undefined, only);
  if (!slots.length) {
    const days = await daysWithAvailability(c.db, s, svc.minutes, now, only);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Ese día se acaba de llenar. Elige otro:", msgDays(svc, days, now, data.stylist)], "DAY", data, null];
  }

  const p = c.payload;
  const morning = slots.filter((x) => x.getUTCHours() < 14);
  const afternoon = slots.filter((x) => x.getUTCHours() >= 14);
  if (p?.startsWith("period:")) {
    Object.assign(data, { period: p.split(":")[1], page: 0 });
    return [[msgTimes(day, slots, now, data)], "TIME", data, null];
  }
  if (p === "more") {
    data.page = (data.page ?? 0) + 1;
    return [[msgTimes(day, slots, now, data)], "TIME", data, null];
  }
  if (!p && !/\d/.test(low)) {                        // "por la tarde", "mañana"
    for (const [word, period, has] of [["tarde", "pm", afternoon], ["manana", "am", morning]] as const) {
      if (low.includes(word) && has.length) {
        Object.assign(data, { period, page: 0 });
        return [[msgTimes(day, slots, now, data)], "TIME", data, null];
      }
    }
  }

  let start: Date | null;
  if (p?.startsWith("time:")) {
    const chosen = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.slice(5)) ? parseDT(p.slice(5)) : null;
    start = chosen ? slots.find((x) => x.getTime() === chosen.getTime()) ?? null : null;
  } else {
    start = pickTime(low, day, slots);
  }
  if (!start) {
    return [["Esa hora no está libre o no la he entendido. Elige una de la lista:", msgTimes(day, slots, now, data)], "TIME", data, null];
  }
  data.start = iso(start);
  const dflt = (await db.lastNameFor(c.db, c.phone)) ?? cleanName(c.profile ?? "");
  data.default_name = dflt;
  return [[msgName(dflt)], "NAME", data, null];
}

async function hName(c: Ctx): Promise<Result> {
  const { data, low, payload: p } = c;
  const dflt: string | null = data.default_name ?? null;
  if (p === "name:other" || (p === "name:yes" && !dflt)) {
    data.default_name = null;
    return [["Vale, escríbeme el nombre para la cita."], "NAME", data, null];
  }
  let name: string | null;
  if (p === "name:yes" || (dflt && isYes(low, c.text))) name = dflt;
  else if (isYes(low, c.text) || isNo(low)) {
    data.default_name = null;
    return [["Vale, escríbeme el nombre para la cita."], "NAME", data, null];
  } else {
    name = cleanName(c.text);
    if (!name) return [["No he entendido el nombre. Escríbelo otra vez, por favor."], "NAME", data, null];
  }
  data.name = name;
  const svc = serviceById(c.s, data.service_id)!;
  return [[msgConfirm(svc, parseDT(data.start), name!, data.stylist)], "CONFIRM", data, null];
}

async function hConfirm(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const svc = serviceById(s, data.service_id)!;
  const start = parseDT(data.start);
  const ans = answer(c, "confirm:");
  if (ans === false) return [["Sin problema, no he reservado nada."], "MENU", {}, null];
  if (ans === null) return [[msgConfirm(svc, start, data.name, data.stylist)], "CONFIRM", data, null];

  const startDay = startOfDay(start);
  const only = data.stylist ?? undefined;
  const stillFree = (await freeSlots(c.db, s, startDay, svc.minutes, now, undefined, only))
    .some((x) => x.getTime() === start.getTime());

  if (!stillFree) {
    const slots = await freeSlots(c.db, s, startDay, svc.minutes, now, undefined, only);
    if (slots.length) {
      Object.assign(data, { day: dayStr(startDay), period: null, page: 0 });
      return [["Uy, ese hueco se acaba de ocupar. Elige otra hora:", msgTimes(startDay, slots, now, data)], "TIME", data, null];
    }
    const days = await daysWithAvailability(c.db, s, svc.minutes, now, only);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Uy, ese hueco se acaba de ocupar y ese día ya no queda nada. Elige otro día:", msgDays(svc, days, now, data.stylist)], "DAY", data, null];
  }

  const working = workingStylists(s, startDay, start, svc.minutes);
  const stylists = data.stylist ? working.filter((st) => st === data.stylist) : working;
  if (!stylists.length) {
    const days = await daysWithAvailability(c.db, s, svc.minutes, now, only);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Ese peluquero ya no tiene ese hueco. Elige otro día:", msgDays(svc, days, now, data.stylist)], "DAY", data, null];
  }

  // Alternativas por si el hueco se ocupa entre esta comprobación y el INSERT del Consumer.
  const alternatives = (await freeSlots(c.db, s, startDay, svc.minutes, now, undefined, only))
    .filter((x) => x.getTime() !== start.getTime());
  const fallbackData = alternatives.length
    ? { ...data, day: dayStr(startDay), period: null, page: 0 }
    : { ...data, days: (await daysWithAvailability(c.db, s, svc.minutes, now, only)).map(dayStr) };

  return [[], "MENU", {}, {
    type: "CREATE_APPOINTMENT",
    payload: {
      phone: c.phone,
      name: data.name,
      service: svc,
      start: iso(start),
      stylists,
      stylist: data.stylist ?? undefined,
      source: "whatsapp",
      sourceWamid: c.session.wamid ?? "",
      now: iso(now),
    },
    onSuccess: {
      state: "MENU",
      data: {},
      replies: [msgBooked(svc, start, data.name, data.stylist)],
    },
    onFailure: alternatives.length
      ? {
        state: "TIME",
        data: fallbackData,
        replies: ["Uy, ese hueco se acaba de ocupar. Elige otra hora:", msgTimes(startDay, alternatives, now, fallbackData)],
      }
      : {
        state: "DAY",
        data: fallbackData,
        replies: ["Uy, ese hueco se acaba de ocupar y ese día ya no queda nada. Elige otro día:",
          msgDays(svc, ((fallbackData as { days?: string[] }).days ?? []).map(parseDay), now, data.stylist)],
      },
  }];
}

async function hCancelPick(c: Ctx): Promise<Result> {
  const ids: number[] = c.data.ids;
  let id: number | null = null;
  const raw = payloadValue(c, "appt:");
  if (raw !== null) id = /^\d+$/.test(raw) && ids.includes(+raw) ? +raw : null;
  else { const i = pickIndex(c.low, ids.length); id = i !== null ? ids[i] : null; }
  if (id === null) return [["No te he entendido. Elige una cita de la lista:", ...(await startManage(c))[0]], "CANCEL_PICK", c.data, null];
  const appt = await db.getOwn(c.db, id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  return [[msgCancelConfirm(appt)], "CANCEL_CONFIRM", { id }, null];
}

async function hCancelConfirm(c: Ctx): Promise<Result> {
  if (c.payload === "resched:yes" || (!c.payload && c.low.includes("reprogram"))) {
    return beginReschedule(c, c.data.id);
  }
  const ans = answer(c, "cancel:");
  if (ans === true) {
    const appt = await db.getOwn(c.db, c.data.id, c.phone);
    if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
    return [[], "MENU", {}, {
      type: "CANCEL_APPOINTMENT",
      payload: { id: c.data.id, phone: c.phone, now: iso(c.now) },
      onSuccess: { state: "MENU", data: {}, replies: [msgCancelled(appt)] },
      onFailure: { state: "MENU", data: {}, replies: ["Esa cita ya no estaba activa."] },
    }];
  }
  if (ans === false) return [["Perfecto, tu cita sigue en pie. 👍"], "MENU", {}, null];
  const appt = await db.getOwn(c.db, c.data.id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  return [[msgCancelConfirm(appt)], "CANCEL_CONFIRM", c.data, null];
}

async function rescheduleDays(c: Ctx, appt: Appt): Promise<Date[]> {
  return daysWithAvailability(c.db, c.s, apptServiceMinutes(c.s, appt), c.now, appt.stylist, appt.id);
}

const apptServiceMinutes = (s: Settings, appt: Appt): number =>
  serviceById(s, appt.service_id)?.minutes ??
  Math.max(5, Math.round((parseDT(appt.ends_at).getTime() - parseDT(appt.starts_at).getTime()) / 60000));

async function beginReschedule(c: Ctx, id: number): Promise<Result> {
  const appt = await db.getOwn(c.db, id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  const days = await rescheduleDays(c, appt);
  if (!days.length) {
    return [[`No hay huecos disponibles para reprogramar *${appt.service_name}*. Llámanos al ${c.s.phone}.`], "MENU", {}, null];
  }
  return [[msgReschedDays(appt, days, c.now)], "RESCHED_DAY",
    { resched_id: appt.id, service_id: appt.service_id, stylist: appt.stylist, days: days.map(dayStr) }, null];
}

async function reschedPickAfterConflict(c: Ctx, message: string): Promise<Result> {
  const appts = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
  return [[message, ...(appts.length ? [msgManage(appts)] : [])], "RESCHED_PICK", { ids: appts.map((a) => a.id) }, null];
}

async function hReschedPick(c: Ctx): Promise<Result> {
  const ids: number[] = c.data.ids ?? (await db.futureAppointments(c.db, c.phone, c.now)).map((a) => a.id);
  let id: number | null = null;
  const raw = payloadValue(c, "appt:");
  if (raw !== null) id = /^\d+$/.test(raw) && ids.includes(+raw) ? +raw : null;
  else { const i = pickIndex(c.low, ids.length); id = i !== null ? ids[i] : null; }
  if (id === null) {
    const appts = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
    if (!appts.length) return [["No tienes citas próximas."], "MENU", {}, null];
    return [["No te he entendido. Elige una cita de la lista:", msgManage(appts)], "RESCHED_PICK",
      { ids: appts.map((a) => a.id) }, null];
  }
  const appt = await db.getOwn(c.db, id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  return [[msgReschedConfirm(appt)], "RESCHED_CONFIRM", { id }, null];
}

async function hReschedConfirm(c: Ctx): Promise<Result> {
  const ans = answer(c, "resched:");
  if (ans === true) return beginReschedule(c, c.data.id);
  if (ans === false) return [["Perfecto, tu cita sigue como estaba. 👍"], "MENU", {}, null];
  const appt = await db.getOwn(c.db, c.data.id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  return [[msgReschedConfirm(appt)], "RESCHED_CONFIRM", c.data, null];
}

async function hReschedDay(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const svc = serviceById(s, data.service_id);
  if (!svc) return [["Ha cambiado la carta de servicios, empecemos de nuevo.", msgMenu(s)], "MENU", {}, null];
  let days: Date[] = (data.days as string[]).map(parseDay);
  const isoDay = payloadValue(c, "day:");
  const day = isoDay ? ((data.days as string[]).includes(isoDay) ? parseDay(isoDay) : null) : pickDay(c.low, days, now);
  if (!day) {
    const current = await db.getOwn(c.db, data.resched_id, c.phone);
    return [["No te he entendido. Elige un día de la lista:",
      current ? msgReschedDays(current, days, now) : msgMenu(s)], "RESCHED_DAY", data, null];
  }

  const slots = await freeSlots(c.db, s, day, svc.minutes, now, data.resched_id, data.stylist);
  if (!slots.length) {
    days = await daysWithAvailability(c.db, s, svc.minutes, now, data.stylist, data.resched_id);
    if (!days.length) return [["No hay huecos disponibles para reprogramar esa cita."], "MENU", {}, null];
    data.days = days.map(dayStr);
    const appt = await db.getOwn(c.db, data.resched_id, c.phone);
    return [["Ese día se acaba de llenar. Elige otro:", appt ? msgReschedDays(appt, days, now) : msgMenu(s)],
      "RESCHED_DAY", data, null];
  }
  Object.assign(data, { day: dayStr(day), period: null, page: 0 });
  const appt = await db.getOwn(c.db, data.resched_id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  return [[msgTimes(day, slots, now, data)], "RESCHED_TIME", data, null];
}

async function hReschedTime(c: Ctx): Promise<Result> {
  const { data, now, s, low } = c;
  const svc = serviceById(s, data.service_id);
  const appt = await db.getOwn(c.db, data.resched_id, c.phone);
  if (!svc || !appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  const day = parseDay(data.day);
  const slots = await freeSlots(c.db, s, day, svc.minutes, now, data.resched_id, data.stylist);
  if (!slots.length) {
    const days = await daysWithAvailability(c.db, s, svc.minutes, now, data.stylist, data.resched_id);
    if (!days.length) return [["No hay huecos disponibles para reprogramar esa cita."], "MENU", {}, null];
    data.days = days.map(dayStr);
    return [["Ese día se acaba de llenar. Elige otro:", msgReschedDays(appt, days, now)], "RESCHED_DAY", data, null];
  }

  const p = c.payload;
  const morning = slots.filter((x) => x.getUTCHours() < 14);
  const afternoon = slots.filter((x) => x.getUTCHours() >= 14);
  if (p?.startsWith("period:")) {
    Object.assign(data, { period: p.split(":")[1], page: 0 });
    return [[msgTimes(day, slots, now, data)], "RESCHED_TIME", data, null];
  }
  if (p === "more") {
    data.page = (data.page ?? 0) + 1;
    return [[msgTimes(day, slots, now, data)], "RESCHED_TIME", data, null];
  }
  if (!p && !/\d/.test(low)) {
    for (const [word, period, has] of [["tarde", "pm", afternoon], ["manana", "am", morning]] as const) {
      if (low.includes(word) && has.length) {
        Object.assign(data, { period, page: 0 });
        return [[msgTimes(day, slots, now, data)], "RESCHED_TIME", data, null];
      }
    }
  }

  let start: Date | null;
  if (p?.startsWith("time:")) {
    const chosen = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.slice(5)) ? parseDT(p.slice(5)) : null;
    start = chosen ? slots.find((x) => x.getTime() === chosen.getTime()) ?? null : null;
  } else {
    start = pickTime(low, day, slots);
  }
  if (!start) {
    return [["Esa hora no está libre o no la he entendido. Elige una de la lista:", msgTimes(day, slots, now, data)], "RESCHED_TIME", data, null];
  }
  data.new_start = iso(start);
  return [[msgReschedFinal(appt, start)], "RESCHED_FINAL", data, null];
}

async function hReschedFinal(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const appt = await db.getOwn(c.db, data.resched_id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}, null];
  const svc = serviceById(s, data.service_id) ?? {
    id: appt.service_id, name: appt.service_name,
    minutes: apptServiceMinutes(s, appt), price: "",
  };
  const start = parseDT(data.new_start);
  const ans = answer(c, "resched:");
  if (ans === false) return [["Perfecto, tu cita sigue como estaba. 👍"], "MENU", {}, null];
  if (ans === null) return [[msgReschedFinal(appt, start)], "RESCHED_FINAL", data, null];

  const stillFree = (await freeSlots(c.db, s, startOfDay(start), svc.minutes, now, appt.id, appt.stylist))
    .some((x) => x.getTime() === start.getTime());
  if (!stillFree) {
    return reschedPickAfterConflict(c, "Ese hueco ya no está disponible. La cita sigue en su hora original. Elige de nuevo:");
  }

  const future = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
  return [[], "MENU", {}, {
    type: "UPDATE_APPOINTMENT",
    payload: {
      id: appt.id,
      phone: appt.phone,
      name: appt.name,
      service: svc,
      stylist: appt.stylist,
      start: iso(start),
      notes: appt.notes ?? "",
      now: iso(now),
      sourceWamid: c.session.wamid ?? "",
    },
    onSuccess: { state: "MENU", data: {}, replies: [msgRescheduled(appt, start)] },
    onFailure: {
      state: "RESCHED_PICK",
      data: { ids: future.map((a) => a.id) },
      replies: ["Ese hueco ya no está disponible; la cita sigue en su hora original. Elige de nuevo:",
        ...(future.length ? [msgManage(future)] : [])],
    },
  }];
}

const HANDLERS: Record<string, (c: Ctx) => Promise<Result>> = {
  MENU: hMenu, SERVICE: hService, STYLIST: hStylist, DAY: hDay, TIME: hTime, NAME: hName, CONFIRM: hConfirm,
  CANCEL_PICK: hCancelPick, CANCEL_CONFIRM: hCancelConfirm,
  RESCHED_PICK: hReschedPick, RESCHED_CONFIRM: hReschedConfirm,
  RESCHED_DAY: hReschedDay, RESCHED_TIME: hReschedTime, RESCHED_FINAL: hReschedFinal,
};

// Botones que tienen sentido en cada estado. Si el cliente toca un botón de un mensaje viejo
// no lo interpretamos: le volvemos a mostrar el paso actual.
const EXPECTED: Record<string, string[]> = {
  MENU: [], SERVICE: ["svc:"], STYLIST: ["stylist:"], DAY: ["day:"],
  TIME: ["period:", "time:", "more"], NAME: ["name:"], CONFIRM: ["confirm:"],
  CANCEL_PICK: ["appt:"], CANCEL_CONFIRM: ["cancel:", "resched:"],
  RESCHED_PICK: ["appt:"], RESCHED_CONFIRM: ["resched:"],
  RESCHED_DAY: ["day:", "period:", "more"], RESCHED_TIME: ["period:", "time:", "more"],
  RESCHED_FINAL: ["resched:"],
};
// Estados que dependen de un `service_id` ya elegido. OJO: SERVICE elige el servicio,
// así que no puede estar aquí (si no, se reiniciaría la conversación nada más empezar).
const BOOKING_STATES = new Set(["STYLIST", "DAY", "TIME", "NAME", "CONFIRM",
  "RESCHED_DAY", "RESCHED_TIME", "RESCHED_FINAL"]);

async function reprompt(c: Ctx, state: string): Promise<BotMessage[]> {
  const { data, now, s } = c;
  switch (state) {
    case "SERVICE": return [msgServices(s)];
    case "STYLIST": return [msgStylists(s, data)];
    case "DAY": return [msgDays(serviceById(s, data.service_id)!, (data.days as string[]).map(parseDay), now, data.stylist)];
    case "TIME": {
      const day = parseDay(data.day);
      const slots = await freeSlots(c.db, s, day, serviceById(s, data.service_id)!.minutes, now, undefined, data.stylist);
      return slots.length ? [msgTimes(day, slots, now, data)] : [msgMenu(s)];
    }
    case "NAME": return [msgName(data.default_name ?? null)];
    case "CONFIRM": return [msgConfirm(serviceById(s, data.service_id)!, parseDT(data.start), data.name, data.stylist)];
    case "CANCEL_PICK": return (await startManage(c))[0];
    case "CANCEL_CONFIRM": {
      const a = await db.getOwn(c.db, data.id, c.phone);
      return a ? [msgCancelConfirm(a)] : [msgMenu(s)];
    }
    case "RESCHED_PICK": {
      const appts = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
      return appts.length ? [msgManage(appts)] : [msgMenu(s)];
    }
    case "RESCHED_CONFIRM": {
      const a = await db.getOwn(c.db, data.id, c.phone);
      return a ? [msgReschedConfirm(a)] : [msgMenu(s)];
    }
    case "RESCHED_DAY": {
      const appt = await db.getOwn(c.db, data.resched_id, c.phone);
      return appt ? [msgReschedDays(appt, (data.days as string[]).map(parseDay), now)] : [msgMenu(s)];
    }
    case "RESCHED_TIME": {
      const day = parseDay(data.day);
      const svc = serviceById(s, data.service_id);
      if (!svc) return [msgMenu(s)];
      const slots = await freeSlots(c.db, s, day, svc.minutes, now, data.resched_id, data.stylist);
      return slots.length ? [msgTimes(day, slots, now, data)] : [msgMenu(s)];
    }
    case "RESCHED_FINAL": {
      const a = await db.getOwn(c.db, data.resched_id, c.phone);
      return a ? [msgReschedFinal(a, parseDT(data.new_start))] : [msgMenu(s)];
    }
    default: return [msgMenu(s)];
  }
}

// ------------------------------------------------------------------ punto de entrada
/**
 * Procesa lo que hizo el cliente y devuelve los mensajes, el nuevo estado y una intención
 * opcional. No escribe en D1: la sesión la carga y guarda el Consumer.
 *
 *   text     lo que escribió (o el título del botón que pulsó)
 *   payload  id del botón/fila pulsado, si pulsó uno
 *   session  sesión ya cargada (state/data) para mantener la función libre de escrituras
 */
export async function handleMessage(
  env: Env, phone: string, text: string, profile: string | null, now: Date,
  payload: string | null = null, session: BotSession = { state: "MENU", data: {} },
): Promise<BotResult> {
  const s = await loadSettings(env);
  let state = session.state || "MENU";
  let data: Record<string, any> = session.data ?? {};
  const low = norm(text);
  const expiredNotice: BotMessage[] = [];

  if (session.expired && !GREETINGS.has(low)) {
    expiredNotice.push("Tu conversación había caducado, empezamos de nuevo. 🙂");
    state = "MENU";
    data = {};
  }

  const c: Ctx = {
    env, db: env.DB, s, phone, text: text ?? "", low, profile, now,
    data, payload, session: { state, data, expired: session.expired, wamid: session.wamid },
  };

  // si el salón cambió la carta de servicios en mitad de una reserva, se reinicia
  if (BOOKING_STATES.has(state) && !serviceById(s, String(data.service_id ?? ""))) {
    return {
      replies: ["Ha cambiado la carta de servicios, empecemos de nuevo.", msgMenu(s)],
      state: "MENU", data: {}, intent: null,
    };
  }

  let replies: BotMessage[];
  let intent: Intent | null = null;

  if (payload === "menu:book") [replies, state, data, intent] = await startBooking(c);
  else if (payload === "menu:manage") [replies, state, data, intent] = await startManage(c);
  else if (payload === "menu:info") { [replies, state, data, intent] = [[msgInfo(s)], "MENU", {}, null]; }
  else if (payload && !(EXPECTED[state] ?? []).some((p) => payload.startsWith(p))) {
    replies = ["Ese botón ya no está activo 🙂", ...(await reprompt(c, state))];
    data = c.data;
    intent = null;
  }
  else if (!payload && GREETINGS.has(low)) { [replies, state, data, intent] = [[msgMenu(s)], "MENU", {}, null]; }
  else if (!payload && (low.includes("cancel") || low.includes("anular")) && low.includes("cita")) {
    [replies, state, data, intent] = await startManage(c);
  }
  else if (!payload && (low === "mis citas" || low === "mi cita")) { [replies, state, data, intent] = await startManage(c); }
  else if (!payload && state !== "MENU" && ["cancelar", "salir", "atras", "anular"].includes(low)) {
    [replies, state, data, intent] = [["Vale, lo dejamos aquí. Escribe *hola* cuando quieras volver a empezar."], "MENU", {}, null];
  }
  else if (!payload && state === "MENU" && ["cancelar", "anular"].includes(low)) { [replies, state, data, intent] = await startManage(c); }
  else [replies, state, data, intent] = await (HANDLERS[state] ?? hMenu)(c);

  return { replies: [...expiredNotice, ...replies], state, data, intent };
}
