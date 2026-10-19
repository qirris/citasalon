import { addDays, addMin, atTime, dayStr, parseDT, startOfDay, weekday } from "./time.ts";
import type { Settings } from "./types.ts";

/** Huecos libres de un día: empieza en hora redonda del horario y cabe el servicio completo. */
export async function freeSlots(
  db: D1Database, s: Settings, day: Date, minutes: number, now: Date,
): Promise<Date[]> {
  const spans = s.hours[weekday(day)] ?? [];
  if (!spans.length || s.closedDates.includes(dayStr(day))) return [];
  const dayStart = dayStr(day);
  const rows = await db.prepare(
    "SELECT stylist, starts_at, ends_at FROM appointments WHERE status='confirmed' AND starts_at < ? AND ends_at > ?",
  ).bind(`${dayStart}T23:59`, `${dayStart}T00:00`)
    .all<{ stylist: string; starts_at: string; ends_at: string }>();
  const busy = rows.results.map((a) => ({ st: a.stylist, from: parseDT(a.starts_at).getTime(), to: parseDT(a.ends_at).getTime() }));
  const earliest = addMin(now, s.minNoticeMinutes).getTime();
  const slots: Date[] = [];
  for (const [from, to] of spans) {
    const open = atTime(day, from).getTime();
    const close = atTime(day, to).getTime();
    for (let t = open; t + minutes * 60000 <= close; t += s.slotMinutes * 60000) {
      if (t < earliest) continue;
      const end = t + minutes * 60000;
      if (s.stylists.some((st) => !busy.some((b) => b.st === st && b.from < end && b.to > t))) slots.push(new Date(t));
    }
  }
  return slots;
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
