export interface Env {
  DB: D1Database;
  // variables (wrangler.jsonc)
  SALON_NAME: string;
  SALON_ADDRESS: string;
  SALON_PHONE: string;
  SALON_TZ: string;
  WHATSAPP_PHONE_ID: string;
  WHATSAPP_NUMBER: string;
  GRAPH_VERSION: string;
  REMINDER_TEMPLATE: string;
  REMINDER_TEMPLATE_LANG: string;
  // secretos (wrangler secret)
  WHATSAPP_TOKEN?: string;
  VERIFY_TOKEN?: string;
  APP_SECRET?: string;
  ADMIN_PASSWORD?: string;
  STAFF_PASSWORD?: string;
  SESSION_SECRET?: string;
}

export interface Service {
  id: string;
  name: string;
  minutes: number;
  price: string;
}

export interface Settings {
  salonName: string;
  address: string;
  phone: string;
  services: Service[];
  stylists: string[];
  /** día de la semana (0 = lunes ... 6 = domingo) -> tramos ["10:00","14:00"] */
  hours: Record<number, [string, string][]>;
  closedDates: string[];
  slotMinutes: number;
  maxDaysAhead: number;
  minNoticeMinutes: number;
  maxActive: number;
  sessionTtlMinutes: number;
}

export interface Appt {
  id: number;
  phone: string;
  name: string;
  service_id: string;
  service_name: string;
  stylist: string;
  starts_at: string;
  ends_at: string;
  status: "confirmed" | "cancelled";
  reminder_sent: number;
  source: "whatsapp" | "admin" | "staff";
  notes: string;
  created_at: string;
  updated_at: string;
}

export type Role = "admin" | "staff";

/** Mensajes que puede enviar el bot */
export type BotMessage =
  | string
  | { type: "buttons"; body: string; buttons: { id: string; title: string }[] }
  | {
      type: "list";
      body: string;
      button: string;
      section: string;
      rows: { id: string; title: string; description?: string }[];
    };
