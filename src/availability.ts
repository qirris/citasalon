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

/** Peluqueros que trabajan ese día en ese tramo concreto (horario propio/general y sin ausencia). */
export function workingStylists(s: Settings, day: Date, start: Date, minutes: number): string[] {
  const wd = weekday(day);
  const ds = dayStr(day);
  const end = start.getTime() + minutes * 60000;
  return s.stylists.filter((st) => !stylistClosed(s, st, ds) &&
    stylistSpans(s, st, wd).some(([a, b]) =>
      atTime(day, a).getTime() <= start.getTime() && end <= atTime(day, b).getTime()));
}

/**
 * Huecos libres de un día: empieza en hora redonda del horario y cabe el servicio completo.
 * `excludeApptId` ignora una cita (para editar su horario) y `onlyStylist` limita el cálculo
 * a un peluquero concreto (si no existe, no hay huecos).
 */
export async function freeSlots(
  db: D1Database, s: Settings, day: Date, minutes: number, now: Date,
  excludeApptId?: number, onlyStylist?: string,
): Promise<Date[]> {
  const wd = weekday(day);
  const ds = dayStr(day);
  if (s.closedDates.includes(ds)) return [];
  const rows = await db.prepare(
    "SELECT id, stylist, starts_at, ends_at FROM appointments WHERE status IN ('confirmed', 'done') AND starts_at < ? AND ends_at > ?",
  ).bind(`${ds}T23:59`, `${ds}T00:00`)
    .all<{ id: number; stylist: string; starts_at: string; ends_at: string }>();
  const busy = rows.results
    .filter((a) => excludeApptId === undefined || a.id !== excludeApptId)
    .map((a) => ({ st: a.stylist, from: parseDT(a.starts_at).getTime(), to: parseDT(a.ends_at).getTime() }));
  const earliest = addMin(now, s.minNoticeMinutes).getTime();
  const starts = new Set<number>();
  const stylists = onlyStylist ? s.stylists.filter((st) => st === onlyStylist) : s.stylists;
  for (const st of stylists) {
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

/**
 * Próximos días con algún hueco libre para un servicio de `minutes` minutos.
 * Con `onlyStylist`, solo cuenta la disponibilidad de ese peluquero.
 */
export async function daysWithAvailability(
  db: D1Database, s: Settings, minutes: number, now: Date, onlyStylist?: string, excludeApptId?: number,
): Promise<Date[]> {
  const days: Date[] = [];
  const today = startOfDay(now);
  for (let i = 0; i < s.maxDaysAhead; i++) {
    const day = addDays(today, i);
    if ((await freeSlots(db, s, day, minutes, now, excludeApptId, onlyStylist)).length) days.push(day);
  }
  return days;
}
