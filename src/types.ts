export interface Env {
  DB: D1Database;
  // variables (wrangler.jsonc)
  DEBUG: string;
  SALON_NAME: string;
  SALON_ADDRESS: string;
  SALON_PHONE: string;
  SALON_TZ: string;
  WHATSAPP_PHONE_ID: string;
  WHATSAPP_NUMBER: string;
  GRAPH_VERSION: string;
  REMINDER_TEMPLATE: string;
  REMINDER_TEMPLATE_LANG: string;
  CANCEL_TEMPLATE: string;
  CANCEL_TEMPLATE_LANG: string;
  UPDATE_TEMPLATE: string;
  UPDATE_TEMPLATE_LANG: string;
  CREATE_TEMPLATE: string;
  CREATE_TEMPLATE_LANG: string;
  // secretos (wrangler secret)
  WHATSAPP_TOKEN?: string;
  VERIFY_TOKEN?: string;
  APP_SECRET?: string;
  ADMIN_PASSWORD?: string;
  STAFF_PASSWORD?: string;
  SESSION_SECRET?: string;
  /** Cola local de WhatsApp (se configura en wrangler.jsonc; no se crea ningún recurso remoto). */
  WHATSAPP_QUEUE?: Queue<InboxJob>;
  /** Solo pruebas locales: "1" fuerza el modo consola y evita cualquier llamada a Meta. */
  WHATSAPP_CONSOLE?: string;
  /** Solo pruebas locales: "0" desactiva el drenaje en línea del webhook (deja actuar a la cola). */
  INLINE_DRAIN?: string;
}

export interface InboxJob {
  id: string;
}

/**
 * Resultado que el Consumer persiste cuando ejecuta (o rechaza) una intención. El bot no
 * escribe en D1: entrega la respuesta ya construida junto al estado de sesión que toca.
 */
export interface IntentOutcome {
  state: string;
  data: Record<string, any>;
  replies: BotMessage[];
}

export type Intent = (
  | {
      type: "CREATE_APPOINTMENT";
      payload: {
        phone: string;
        name: string;
        service: Service;
        start: string;             // ISO local 'AAAA-MM-DDTHH:MM'
        stylists: string[];
        stylist?: string;
        source: "whatsapp";
        /** WAMID que originó la reserva: evita duplicados si el mensaje se reintenta. */
        sourceWamid: string;
        now: string;
      };
    }
  | {
      type: "CANCEL_APPOINTMENT";
      payload: { id: number; phone: string; now: string };
    }
  | {
      type: "UPDATE_APPOINTMENT";
      payload: {
        id: number;
        phone: string;
        name: string;
        service: Service;
        stylist: string;
        start: string;
        notes: string;
        now: string;
        sourceWamid: string;
      };
    }
) & {
  onSuccess: IntentOutcome;
  onFailure: IntentOutcome;
};

export interface Service {
  id: string;
  name: string;
  minutes: number;
  price: string;
  /** `false` = servicio retirado: no se ofrece en el bot ni en citas nuevas, pero su historial se conserva. */
  active?: boolean;
}

export interface Settings {
  salonName: string;
  address: string;
  phone: string;
  services: Service[];
  stylists: string[];
  /** día de la semana (0 = lunes ... 6 = domingo) -> tramos ["10:00","14:00"] */
  hours: Record<number, [string, string][]>;
  /** horario propio de cada peluquero; si falta un día, se usa `hours` */
  stylistHours: Record<string, Record<number, [string, string][]>>;
  /** vacaciones/festivos propios de cada peluquero (AAAA-MM-DD) */
  stylistClosedDates: Record<string, string[]>;
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
  status: "confirmed" | "cancelled" | "done";
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
