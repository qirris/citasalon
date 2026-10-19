/**
 * Fechas "de pared": un Date cuyos campos UTC representan la hora local del salón.
 * Así 10:00 en Madrid es siempre 10:00, sin líos de zonas horarias ni de horario de verano.
 * Se guardan como texto 'AAAA-MM-DDTHH:MM'.
 */
export const DAYS = ["lunes", "martes", "miércoles", "jueves", "viernes", "sábado", "domingo"];
export const MONTHS = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto",
  "septiembre", "octubre", "noviembre", "diciembre"];
export const DAYS_SHORT = ["lun", "mar", "mié", "jue", "vie", "sáb", "dom"];
export const MONTHS_SHORT = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"];

export function nowLocal(tz: string): Date {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const n = (t: string) => Number(parts.find((p) => p.type === t)!.value);
  return new Date(Date.UTC(n("year"), n("month") - 1, n("day"), n("hour"), n("minute"), n("second")));
}

export const iso = (d: Date): string => d.toISOString().slice(0, 16);
export const dayStr = (d: Date): string => d.toISOString().slice(0, 10);
export const parseDT = (s: string): Date => new Date(`${s}:00Z`);
export const parseDay = (s: string): Date => new Date(`${s}T00:00:00Z`);
export const addMin = (d: Date, m: number): Date => new Date(d.getTime() + m * 60000);
export const addDays = (d: Date, n: number): Date => new Date(d.getTime() + n * 86400000);
/** lunes = 0 ... domingo = 6 */
export const weekday = (d: Date): number => (d.getUTCDay() + 6) % 7;
export const startOfDay = (d: Date): Date => parseDay(dayStr(d));
export const hhmm = (d: Date): string => iso(d).slice(11, 16);

export const isValidDay = (s: string): boolean =>
  /^\d{4}-\d{2}-\d{2}$/.test(s) && dayStr(parseDay(s)) === s;
export const isValidTime = (s: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

/** "10:00" en el día `day` */
export function atTime(day: Date, hm: string): Date {
  const [h, m] = hm.split(":").map(Number);
  return new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), h, m));
}

export function fmtDay(d: Date, today?: Date): string {
  const base = `${DAYS[weekday(d)]} ${d.getUTCDate()} de ${MONTHS[d.getUTCMonth()]}`;
  if (today) {
    if (dayStr(d) === dayStr(today)) return `hoy, ${base}`;
    if (dayStr(d) === dayStr(addDays(today, 1))) return `mañana, ${base}`;
  }
  return base;
}

export function shortDay(d: Date, today: Date): string {
  const base = `${DAYS_SHORT[weekday(d)]} ${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]}`;
  if (dayStr(d) === dayStr(today)) return `Hoy, ${base}`;
  if (dayStr(d) === dayStr(addDays(today, 1))) return `Mañana, ${base}`;
  return base.charAt(0).toUpperCase() + base.slice(1);
}
