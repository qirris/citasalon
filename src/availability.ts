import { addDays, addMin, atTime, dayStr, parseDT, startOfDay, weekday } from "./time.ts";
import type { Settings } from "./types.ts";

/** Tramos de un peluquero en un día de la semana; si no tiene horario propio, usa el del salón. */
export function stylistSpans(s: Settings, stylist: string, wd: number): [string, string][] {
  const own = s.stylistHours?.[stylist];
  if (own && Object.keys(own).length) return own[wd] ?? [];
  return s.hours[wd] ?? [];
}

/** ¿El peluquero está de vacaciones/festivo ese día? */
export function stylistClosed(s: Settings, stylist: string, date: string): boolean {
  return (s.stylistClosedDates?.[stylist] ?? []).includes(date);
}

/** Huecos libres de un día: empieza en hora redonda del horario y cabe el servicio completo. */
export async function freeSlots(
  db: D1Database, s: Settings, day: Date, minutes: number, now: Date,
): Promise<Date[]> {
  const wd = weekday(day);
  const ds = dayStr(day);
  if (s.closedDates.includes(ds)) return [];
  const rows = await db.prepare(
    "SELECT stylist, starts_at, ends_at FROM appointments WHERE status='confirmed' AND starts_at < ? AND ends_at > ?",
  ).bind(`${ds}T23:59`, `${ds}T00:00`)
    .all<{ stylist: string; starts_at: string; ends_at: string }>();
  const busy = rows.results.map((a) => ({ st: a.stylist, from: parseDT(a.starts_at).getTime(), to: parseDT(a.ends_at).getTime() }));
  const earliest = addMin(now, s.minNoticeMinutes).getTime();
  const starts = new Set<number>();
  for (const st of s.stylists) {
    if (stylistClosed(s, st, ds)) continue;
    for (const [from, to] of stylistSpans(s, st, wd)) {
      const open = atTime(day, from).getTime();
      const close = atTime(day, to).getTime();
      for (let t = open; t + minutes * 60000 <= close; t += s.slotMinutes * 60000) {
        if (t < earliest) continue;
        const end = t + minutes * 60000;
        if (!busy.some((b) => b.st === st && b.from < end && b.to > t)) starts.add(t);
      }
    }
  }
  return [...starts].sort((a, b) => a - b).map((t) => new Date(t));
}

/** Próximos días con algún hueco libre para un servicio de `minutes` minutos. */
export async function daysWithAvailability(
  db: D1Database, s: Settings, minutes: number, now: Date,
): Promise<Date[]> {
  const days: Date[] = [];
  const today = startOfDay(now);
  for (let i = 0; i < s.maxDaysAhead; i++) {
    const day = addDays(today, i);
    if ((await freeSlots(db, s, day, minutes, now)).length) days.push(day);
  }
  return days;
}
