import type { Env, Service, Settings } from "./types.ts";

const DEFAULT_SERVICES: Service[] = [
  { id: "corte_mujer", name: "Corte mujer", minutes: 45, price: "25 €" },
  { id: "corte_hombre", name: "Corte hombre", minutes: 30, price: "15 €" },
  { id: "tinte", name: "Tinte", minutes: 90, price: "35 €" },
];

const WEEK_HOURS: [string, string][] = [["10:00", "20:00"]];
const DEFAULT_HOURS: Record<number, [string, string][]> = {
  0: WEEK_HOURS, 1: WEEK_HOURS, 2: WEEK_HOURS, 3: WEEK_HOURS, 4: WEEK_HOURS, 5: WEEK_HOURS, 6: [],
};

export async function loadSettings(env: Env): Promise<Settings> {
  const rows = await env.DB.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(rows.results.map((r) => [r.key, r.value]));
  const j = <T,>(k: string, d: T): T => {
    try { const v = map.get(k); return v === undefined ? d : (JSON.parse(v) as T); } catch { return d; }
  };
  const n = (k: string, d: number) => {
    const v = Number(map.get(k));
    return map.has(k) && Number.isFinite(v) ? v : d;
  };
  const s = (k: string, d: string) => {
    const v = map.get(k);
    if (v === undefined) return d;
    try { const p = JSON.parse(v); return typeof p === "string" ? p : v; } catch { return v; }
  };
  return {
    salonName: s("salonName", env.SALON_NAME),
    address: s("address", env.SALON_ADDRESS),
    phone: s("phone", env.SALON_PHONE),
    services: j("services", DEFAULT_SERVICES),
    stylists: j("stylists", ["Ana", "Luis"]),
    hours: j("hours", DEFAULT_HOURS),
    closedDates: j("closedDates", []),
    slotMinutes: n("slotMinutes", 15),
    maxDaysAhead: n("maxDaysAhead", 30),
    minNoticeMinutes: n("minNoticeMinutes", 60),
    maxActive: n("maxActive", 5),
    sessionTtlMinutes: n("sessionTtlMinutes", 720),
  };
}

export async function saveSettings(db: D1Database, s: Settings): Promise<void> {
  const kv: [string, string][] = [
    ["salonName", JSON.stringify(s.salonName)],
    ["address", JSON.stringify(s.address)],
    ["phone", JSON.stringify(s.phone)],
    ["services", JSON.stringify(s.services)],
    ["stylists", JSON.stringify(s.stylists)],
    ["hours", JSON.stringify(s.hours)],
    ["closedDates", JSON.stringify(s.closedDates)],
    ["slotMinutes", JSON.stringify(s.slotMinutes)],
    ["maxDaysAhead", JSON.stringify(s.maxDaysAhead)],
    ["minNoticeMinutes", JSON.stringify(s.minNoticeMinutes)],
    ["maxActive", JSON.stringify(s.maxActive)],
    ["sessionTtlMinutes", JSON.stringify(s.sessionTtlMinutes)],
  ];
  await db.batch(kv.map(([key, value]) =>
    db.prepare("INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .bind(key, value)));
}
