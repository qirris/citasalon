/**
 * Conversación de WhatsApp: un autómata de estados con botones y listas.
 *
 *   MENU -> SERVICE -> DAY -> TIME -> NAME -> CONFIRM        (reservar)
 *   MENU -> CANCEL_PICK -> CANCEL_CONFIRM                    (ver / cancelar citas)
 *
 * Todo funciona también si el cliente escribe en vez de pulsar ("tinte", "mañana", "17:30").
 */
import * as db from "./db.ts";
import { daysWithAvailability, freeSlots } from "./availability.ts";
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

interface Ctx {
  env: Env; db: D1Database; s: Settings;
  phone: string; text: string; low: string; profile: string | null; now: Date;
  data: Record<string, any>; payload: string | null;
}
type Result = [BotMessage[], string, Record<string, any>];

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

// ------------------------------------------------------------------ constructores de mensajes
const msgMenu = (s: Settings) => buttons(
  `¡Hola! 👋 Soy el asistente de *${s.salonName}*.\n¿Qué quieres hacer?`,
  ["menu:book", "Reservar cita"], ["menu:manage", "Mis citas"], ["menu:info", "Horario y dirección"]);

const msgInfo = (s: Settings) => buttons(
  `📍 *${s.salonName}*\n${s.address}\n📞 ${s.phone}\n\n🕒 *Horario*\n${hoursText(s)}`,
  ["menu:book", "Reservar cita"], ["menu:manage", "Mis citas"]);

const msgServices = (s: Settings) => choose("¿Qué servicio quieres?", "Ver servicios",
  s.services.map((v) => ({ id: `svc:${v.id}`, title: v.name, description: `${v.minutes} min · ${v.price}` })), "Servicios");

const msgDays = (svc: Service, days: Date[], now: Date) => choose(
  `Perfecto: *${svc.name}* (${svc.minutes} min, ${svc.price}).\n¿Qué día te viene bien?`, "Ver días",
  days.map((d) => ({ id: `day:${dayStr(d)}`, title: shortDay(d, now) })), "Días disponibles");

function msgTimes(day: Date, slots: Date[], now: Date, data: Record<string, any>): BotMessage {
  const morning = slots.filter((x) => x.getUTCHours() < 14);
  const afternoon = slots.filter((x) => x.getUTCHours() >= 14);
  const label = fmtDay(day, now);
  const hint = "También puedes escribirme la hora, por ejemplo *17:30*.";
  const period: string | null = data.period ?? null;

  if (period === null && morning.length && afternoon.length) {
    return buttons(`Hay horas libres para *${label}*.\n¿Prefieres por la mañana o por la tarde?\n${hint}`,
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
  return choose(`Horas libres de ${name} para *${label}*.\n${hint}`, "Ver horas", rows, `Horas de ${name}`);
}

const msgName = (dflt: string | null): BotMessage => dflt
  ? buttons(`¿Pongo la cita a nombre de *${dflt}*?`, ["name:yes", "Sí, ese nombre"], ["name:other", "Otro nombre"])
  : "¿A nombre de quién pongo la cita? Escríbeme el nombre.";

const msgConfirm = (svc: Service, start: Date, name: string) => buttons(
  `Revisa tu cita:\n\n💇 ${svc.name} (${svc.price})\n📅 ${fmtDay(start)}\n🕒 ${hhmm(start)}\n👤 ${name}\n\n¿La confirmo?`,
  ["confirm:yes", "✅ Confirmar"], ["confirm:no", "❌ Descartar"]);

const msgManage = (appts: Appt[]) => choose("Tus próximas citas. Toca la que quieras cancelar.", "Ver citas",
  appts.map((a) => {
    const d = parseDT(a.starts_at);
    const t = `${shortDay(d, addDays(d, 9999))}, ${hhmm(d)}`;   // sin "Hoy/Mañana": el título ya lleva la fecha
    return { id: `appt:${a.id}`, title: t, description: a.service_name };
  }), "Mis citas");

const msgCancelConfirm = (a: Appt) => buttons(
  `¿Cancelar *${a.service_name}* el ${fmtDay(parseDT(a.starts_at))} a las ${hhmm(parseDT(a.starts_at))}?`,
  ["cancel:yes", "Sí, cancelar"], ["cancel:no", "No, mantenerla"]);

// ------------------------------------------------------------------ selección por texto
const pickIndex = (low: string, size: number) => (/^\d+$/.test(low) && +low >= 1 && +low <= size ? +low - 1 : null);

export function pickService(s: Settings, low: string): Service | null {
  const idx = pickIndex(low, s.services.length);
  if (idx !== null) return s.services[idx];
  if (low.length < 4) return null;
  const hits = s.services.filter((v) => norm(v.name).includes(low) || low.includes(norm(v.name)));
  return hits.length === 1 ? hits[0] : null;
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
  [[`Lo siento, ya no quedan huecos. Llámanos al ${s.phone}.`], "MENU", {}];

async function startBooking(c: Ctx): Promise<Result> {
  const active = await db.futureAppointments(c.db, c.phone, c.now);
  if (active.length >= c.s.maxActive) {
    return [[buttons(`Ya tienes ${active.length} citas reservadas. Cancela alguna antes de pedir otra.`,
      ["menu:manage", "Mis citas"])], "MENU", {}];
  }
  return [[msgServices(c.s)], "SERVICE", {}];
}

async function startManage(c: Ctx): Promise<Result> {
  const appts = (await db.futureAppointments(c.db, c.phone, c.now)).slice(0, MAX_LIST_ROWS);
  if (!appts.length) return [[buttons("No tienes citas próximas.", ["menu:book", "Reservar cita"])], "MENU", {}];
  return [[msgManage(appts)], "CANCEL_PICK", { ids: appts.map((a) => a.id) }];
}

async function hMenu(c: Ctx): Promise<Result> {
  const low = c.low;
  if (low === "2" || low.includes("mis citas") || low.includes("mi cita")) return startManage(c);
  if (low === "3" || ["horario", "direccion", "ubicacion", "donde", "abierto"].some((w) => low.includes(w))) {
    return [[msgInfo(c.s)], "MENU", {}];
  }
  if (low === "1" || ["reserv", "cita", "pedir", "agendar", "turno"].some((w) => low.includes(w))) return startBooking(c);
  return [[msgMenu(c.s)], "MENU", {}];
}

async function hService(c: Ctx): Promise<Result> {
  const sid = payloadValue(c, "svc:");
  const svc = sid ? serviceById(c.s, sid) : pickService(c.s, c.low);
  if (!svc) return [["No te he entendido. Elige un servicio de la lista:", msgServices(c.s)], "SERVICE", c.data];
  const days = await daysWithAvailability(c.db, c.s, svc.minutes, c.now);
  if (!days.length) {
    return [[`Ahora mismo no tengo huecos libres en los próximos ${c.s.maxDaysAhead} días. Llámanos al ${c.s.phone} y lo miramos.`], "MENU", {}];
  }
  return [[msgDays(svc, days, c.now)], "DAY", { service_id: svc.id, days: days.map(dayStr) }];
}

async function hDay(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const svc = serviceById(s, data.service_id)!;
  let days: Date[] = (data.days as string[]).map(parseDay);
  const isoDay = payloadValue(c, "day:");
  const day = isoDay ? ((data.days as string[]).includes(isoDay) ? parseDay(isoDay) : null) : pickDay(c.low, days, now);
  if (!day) return [["No te he entendido. Elige un día de la lista:", msgDays(svc, days, now)], "DAY", data];

  const slots = await freeSlots(c.db, s, day, svc.minutes, now);
  if (!slots.length) {                               // alguien se llevó los últimos huecos mientras tanto
    days = await daysWithAvailability(c.db, s, svc.minutes, now);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Ese día se acaba de llenar. Elige otro:", msgDays(svc, days, now)], "DAY", data];
  }
  Object.assign(data, { day: dayStr(day), period: null, page: 0 });
  return [[msgTimes(day, slots, now, data)], "TIME", data];
}

async function hTime(c: Ctx): Promise<Result> {
  const { data, now, s, low } = c;
  const svc = serviceById(s, data.service_id)!;
  const day = parseDay(data.day);
  const slots = await freeSlots(c.db, s, day, svc.minutes, now);
  if (!slots.length) {
    const days = await daysWithAvailability(c.db, s, svc.minutes, now);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Ese día se acaba de llenar. Elige otro:", msgDays(svc, days, now)], "DAY", data];
  }

  const p = c.payload;
  const morning = slots.filter((x) => x.getUTCHours() < 14);
  const afternoon = slots.filter((x) => x.getUTCHours() >= 14);
  if (p?.startsWith("period:")) {
    Object.assign(data, { period: p.split(":")[1], page: 0 });
    return [[msgTimes(day, slots, now, data)], "TIME", data];
  }
  if (p === "more") {
    data.page = (data.page ?? 0) + 1;
    return [[msgTimes(day, slots, now, data)], "TIME", data];
  }
  if (!p && !/\d/.test(low)) {                        // "por la tarde", "mañana"
    for (const [word, period, has] of [["tarde", "pm", afternoon], ["manana", "am", morning]] as const) {
      if (low.includes(word) && has.length) {
        Object.assign(data, { period, page: 0 });
        return [[msgTimes(day, slots, now, data)], "TIME", data];
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
    return [["Esa hora no está libre o no la he entendido. Elige una de la lista:", msgTimes(day, slots, now, data)], "TIME", data];
  }
  data.start = iso(start);
  const dflt = (await db.lastNameFor(c.db, c.phone)) ?? cleanName(c.profile ?? "");
  data.default_name = dflt;
  return [[msgName(dflt)], "NAME", data];
}

async function hName(c: Ctx): Promise<Result> {
  const { data, low, payload: p } = c;
  const dflt: string | null = data.default_name ?? null;
  if (p === "name:other" || (p === "name:yes" && !dflt)) {
    data.default_name = null;
    return [["Vale, escríbeme el nombre para la cita."], "NAME", data];
  }
  let name: string | null;
  if (p === "name:yes" || (dflt && isYes(low, c.text))) name = dflt;
  else if (isYes(low, c.text) || isNo(low)) {
    data.default_name = null;
    return [["Vale, escríbeme el nombre para la cita."], "NAME", data];
  } else {
    name = cleanName(c.text);
    if (!name) return [["No he entendido el nombre. Escríbelo otra vez, por favor."], "NAME", data];
  }
  data.name = name;
  const svc = serviceById(c.s, data.service_id)!;
  return [[msgConfirm(svc, parseDT(data.start), name!)], "CONFIRM", data];
}

async function hConfirm(c: Ctx): Promise<Result> {
  const { data, now, s } = c;
  const svc = serviceById(s, data.service_id)!;
  const start = parseDT(data.start);
  const ans = answer(c, "confirm:");
  if (ans === false) return [["Sin problema, no he reservado nada."], "MENU", {}];
  if (ans === null) return [[msgConfirm(svc, start, data.name)], "CONFIRM", data];

  const startDay = startOfDay(start);
  const stillFree = (await freeSlots(c.db, s, startDay, svc.minutes, now)).some((x) => x.getTime() === start.getTime());
  const appt = stillFree
    ? await db.createAppointment(c.db, { phone: c.phone, name: data.name, service: svc, start, stylists: s.stylists, source: "whatsapp", now })
    : null;

  if (!appt) {
    const slots = await freeSlots(c.db, s, startDay, svc.minutes, now);
    if (slots.length) {
      Object.assign(data, { day: dayStr(startDay), period: null, page: 0 });
      return [["Uy, ese hueco se acaba de ocupar. Elige otra hora:", msgTimes(startDay, slots, now, data)], "TIME", data];
    }
    const days = await daysWithAvailability(c.db, s, svc.minutes, now);
    if (!days.length) return noSlotsLeft(s);
    data.days = days.map(dayStr);
    return [["Uy, ese hueco se acaba de ocupar y ese día ya no queda nada. Elige otro día:", msgDays(svc, days, now)], "DAY", data];
  }

  await db.audit(c.db, now, "whatsapp", "crear", appt.id, `${appt.name} · ${appt.service_name} · ${appt.starts_at} · ${appt.stylist}`);
  const text = `✅ *Cita confirmada*, ${appt.name}.\n\n💇 ${svc.name}\n📅 ${fmtDay(start)}\n🕒 ${hhmm(start)} con ${appt.stylist}\n📍 ${s.address}\n\n` +
    "Si no puedes venir, cancélala desde *Mis citas* para liberar el hueco. ¡Te esperamos!";
  return [[buttons(text, ["menu:manage", "Mis citas"])], "MENU", {}];
}

async function hCancelPick(c: Ctx): Promise<Result> {
  const ids: number[] = c.data.ids;
  let id: number | null = null;
  const raw = payloadValue(c, "appt:");
  if (raw !== null) id = /^\d+$/.test(raw) && ids.includes(+raw) ? +raw : null;
  else { const i = pickIndex(c.low, ids.length); id = i !== null ? ids[i] : null; }
  if (id === null) return [["No te he entendido. Elige una cita de la lista:", ...(await startManage(c))[0]], "CANCEL_PICK", c.data];
  const appt = await db.getOwn(c.db, id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}];
  return [[msgCancelConfirm(appt)], "CANCEL_CONFIRM", { id }];
}

async function hCancelConfirm(c: Ctx): Promise<Result> {
  const ans = answer(c, "cancel:");
  if (ans === true) {
    const appt = await db.getOwn(c.db, c.data.id, c.phone);
    const ok = await db.cancelOwn(c.db, c.data.id, c.phone, c.now);
    if (ok && appt) await db.audit(c.db, c.now, "whatsapp", "cancelar", appt.id, `${appt.name} · ${appt.starts_at}`);
    return [[ok ? "Cita cancelada. El hueco queda libre para otra persona. Escribe *hola* si quieres reservar otra."
      : "Esa cita ya no estaba activa."], "MENU", {}];
  }
  if (ans === false) return [["Perfecto, tu cita sigue en pie. 👍"], "MENU", {}];
  const appt = await db.getOwn(c.db, c.data.id, c.phone);
  if (!appt) return [["Esa cita ya no está activa."], "MENU", {}];
  return [[msgCancelConfirm(appt)], "CANCEL_CONFIRM", c.data];
}

const HANDLERS: Record<string, (c: Ctx) => Promise<Result>> = {
  MENU: hMenu, SERVICE: hService, DAY: hDay, TIME: hTime, NAME: hName, CONFIRM: hConfirm,
  CANCEL_PICK: hCancelPick, CANCEL_CONFIRM: hCancelConfirm,
};

// Botones que tienen sentido en cada estado. Si el cliente toca un botón de un mensaje viejo
// no lo interpretamos: le volvemos a mostrar el paso actual.
const EXPECTED: Record<string, string[]> = {
  MENU: [], SERVICE: ["svc:"], DAY: ["day:"], TIME: ["period:", "time:", "more"], NAME: ["name:"],
  CONFIRM: ["confirm:"], CANCEL_PICK: ["appt:"], CANCEL_CONFIRM: ["cancel:"],
};
const BOOKING_STATES = new Set(["DAY", "TIME", "NAME", "CONFIRM"]);

async function reprompt(c: Ctx, state: string): Promise<BotMessage[]> {
  const { data, now, s } = c;
  switch (state) {
    case "SERVICE": return [msgServices(s)];
    case "DAY": return [msgDays(serviceById(s, data.service_id)!, (data.days as string[]).map(parseDay), now)];
    case "TIME": {
      const day = parseDay(data.day);
      const slots = await freeSlots(c.db, s, day, serviceById(s, data.service_id)!.minutes, now);
      return slots.length ? [msgTimes(day, slots, now, data)] : [msgMenu(s)];
    }
    case "NAME": return [msgName(data.default_name ?? null)];
    case "CONFIRM": return [msgConfirm(serviceById(s, data.service_id)!, parseDT(data.start), data.name)];
    case "CANCEL_PICK": return (await startManage(c))[0];
    case "CANCEL_CONFIRM": {
      const a = await db.getOwn(c.db, data.id, c.phone);
      return a ? [msgCancelConfirm(a)] : [msgMenu(s)];
    }
    default: return [msgMenu(s)];
  }
}

// ------------------------------------------------------------------ punto de entrada
/**
 * Procesa lo que hizo el cliente y devuelve los mensajes a enviar.
 *   text     lo que escribió (o el título del botón que pulsó)
 *   payload  id del botón/fila pulsado, si pulsó uno
 */
export async function handleMessage(
  env: Env, phone: string, text: string, profile: string | null, now: Date, payload: string | null = null,
): Promise<BotMessage[]> {
  const s = await loadSettings(env);
  const session = (await db.getSession(env.DB, phone, now, s.sessionTtlMinutes)) ?? { state: "MENU", data: {} };
  let state = session.state;
  const c: Ctx = { env, db: env.DB, s, phone, text: text ?? "", low: norm(text), profile, now, data: session.data, payload };

  // si el salón cambió la carta de servicios en mitad de una reserva, se reinicia
  if ((BOOKING_STATES.has(state) || state === "CONFIRM") && !serviceById(s, c.data.service_id)) {
    await db.clearSession(env.DB, phone);
    return ["Ha cambiado la carta de servicios, empecemos de nuevo.", msgMenu(s)];
  }

  let replies: BotMessage[];
  let data: Record<string, any>;
  const low = c.low;

  if (payload === "menu:book") [replies, state, data] = await startBooking(c);
  else if (payload === "menu:manage") [replies, state, data] = await startManage(c);
  else if (payload === "menu:info") [replies, state, data] = [[msgInfo(s)], "MENU", {}];
  else if (payload && !EXPECTED[state].some((p) => payload.startsWith(p))) {
    replies = ["Ese botón ya no está activo 🙂", ...(await reprompt(c, state))];
    data = c.data;
  } else if (!payload && GREETINGS.has(low)) [replies, state, data] = [[msgMenu(s)], "MENU", {}];
  else if (!payload && (low.includes("cancel") || low.includes("anular")) && low.includes("cita")) [replies, state, data] = await startManage(c);
  else if (!payload && (low === "mis citas" || low === "mi cita")) [replies, state, data] = await startManage(c);
  else if (!payload && state !== "MENU" && ["cancelar", "salir", "atras", "anular"].includes(low)) {
    [replies, state, data] = [["Vale, lo dejamos aquí. Escribe *hola* cuando quieras volver a empezar."], "MENU", {}];
  } else if (!payload && state === "MENU" && ["cancelar", "anular"].includes(low)) [replies, state, data] = await startManage(c);
  else [replies, state, data] = await HANDLERS[state](c);

  if (state === "MENU") await db.clearSession(env.DB, phone);
  else await db.saveSession(env.DB, phone, state, data, now);
  return replies;
}
