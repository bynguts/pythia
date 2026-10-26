import { useEffect, useState } from "react";
import { CalendarDays, CloudRain, Map as MapIcon, MessageCircle, Radio, Scale } from "lucide-react";
import { apiGet } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { StatusDot } from "../../shared/ui/StatusDot.jsx";
import { Tag } from "../../shared/ui/Tag.jsx";
import { WhatsAppIntegration } from "./WhatsAppIntegration.jsx";

// Where a pilot request goes; without it the Join pilot button is not shown.
const CONTACT_URL = import.meta.env.VITE_CONTACT_URL || "";

function fill(template, values) {
  return Object.entries(values).reduce((text, [key, v]) => text.replaceAll(`{${key}}`, v), template);
}

// wave13 Settings, Integrations (T6NMuR). A status comes from the endpoint that reads the
// integration; one that cannot be read shows a grey dot, never "connected".
export function IntegrationsPanel({ canManage, openWhatsApp, onToggleWhatsApp, onOpenData }) {
  const { t } = useLanguage();
  // Each status arrives on its own: a slow gateway must not hold the others at "Checking".
  const [whatsapp, setWhatsapp] = useState(undefined);
  const [tomorrow, setTomorrow] = useState(undefined);
  const [events, setEvents] = useState(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    const load = (path, set) =>
      apiGet(path, { signal }).then(set, (error) => error?.name !== "AbortError" && set(null));
    load("/whatsapp/status", setWhatsapp);
    load("/forecast/tomorrow", setTomorrow);
    load("/events/official", setEvents);
    return () => controller.abort();
  }, []);

  const weather = tomorrow?.drivers?.find((driver) => driver.kind === "weather");
  const eventCount = Array.isArray(events) ? events.length : null;

  const whatsappStatus =
    whatsapp === undefined
      ? { tone: "idle", text: t("s5_set_checking") }
      : !whatsapp
        ? { tone: "idle", text: t("s5_set_unreadable") }
        : whatsapp.connected
          ? {
              tone: "ok",
              text:
                whatsapp.alert_group?.source && whatsapp.alert_group.source !== "placeholder"
                  ? t("s5_set_wa_connected_group")
                  : t("s5_set_wa_connected"),
            }
          : { tone: "danger", text: t("s5_set_wa_not_connected") };
  const weatherStatus =
    tomorrow === undefined
      ? { tone: "idle", text: t("s5_set_checking") }
      : !weather
        ? { tone: "idle", text: t("s5_set_unreadable") }
        : weather.source === "open-meteo"
          ? { tone: "ok", text: t("s5_set_connected") }
          : { tone: "warn", text: t("s5_set_weather_fallback") };
  const eventsStatus =
    events === undefined
      ? { tone: "idle", text: t("s5_set_checking") }
      : eventCount == null
        ? { tone: "idle", text: t("s5_set_unreadable") }
        : { tone: "ok", text: fill(t("s5_set_events_loaded"), { n: eventCount }) };

  const rows = [
    {
      id: "whatsapp",
      icon: MessageCircle,
      name: t("s5_set_wa_name"),
      desc: t("s5_set_wa_desc"),
      status: whatsappStatus,
      action: (
        <Button
          size="sm"
          aria-expanded={openWhatsApp}
          aria-controls="st-whatsapp-panel"
          onClick={onToggleWhatsApp}
          data-testid="settings-whatsapp-manage"
        >
          {t("s5_set_manage")}
        </Button>
      ),
    },
    {
      id: "weather",
      icon: CloudRain,
      name: t("s5_set_weather_name"),
      desc: t("s5_set_weather_desc"),
      status: weatherStatus,
      action: (
        <Button size="sm" onClick={onOpenData}>
          {t("s5_set_details")}
        </Button>
      ),
    },
    {
      id: "events",
      icon: CalendarDays,
      name: t("s5_set_events_name"),
      desc: t("s5_set_events_desc"),
      status: eventsStatus,
      action: (
        <Button size="sm" onClick={onOpenData}>
          {t("s5_set_details")}
        </Button>
      ),
    },
    {
      id: "osm",
      icon: MapIcon,
      name: t("s5_set_osm_name"),
      desc: t("s5_set_osm_desc"),
      status: { tone: "idle", text: t("s5_set_osm_status") },
      action: (
        <Button size="sm" onClick={onOpenData}>
          {t("s5_set_details")}
        </Button>
      ),
    },
    {
      id: "gps",
      soon: true,
      icon: Radio,
      name: t("s5_set_gps_name"),
      desc: t("s5_set_gps_desc"),
    },
    {
      id: "weighbridge",
      soon: true,
      icon: Scale,
      name: t("s5_set_wb_name"),
      desc: t("s5_set_wb_desc"),
    },
  ];

  return (
    <div className="st-group" data-testid="settings-integrations">
      <header className="st-head">
        <h2>{t("s5_set_int_title")}</h2>
        <p>{t("s5_set_int_sub")}</p>
      </header>
      <ul className="st-list">
        {rows.map((row) => (
          <li key={row.id} className="st-int" data-testid={`integration-${row.id}`}>
            <span className={`st-int-icon${row.soon ? " is-soon" : ""}`} aria-hidden="true">
              <row.icon size={18} />
            </span>
            <span className="st-int-text">
              <strong>{row.name}</strong>
              <small>{row.desc}</small>
            </span>
            {row.soon ? (
              <>
                <Tag tone="soon" className="st-soon">
                  {t("s5_set_soon")}
                </Tag>
                {CONTACT_URL && (
                  <Button size="sm" onClick={() => window.open(CONTACT_URL, "_blank", "noopener,noreferrer")}>
                    {t("s5_set_join_pilot")}
                  </Button>
                )}
              </>
            ) : (
              <>
                <StatusDot tone={row.status.tone}>{row.status.text}</StatusDot>
                {row.action}
              </>
            )}
          </li>
        ))}
      </ul>
      {openWhatsApp && (
        <div id="st-whatsapp-panel" className="st-embed">
          <WhatsAppIntegration canManage={canManage} />
        </div>
      )}
    </div>
  );
}
