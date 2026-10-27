import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BellRing, MessageSquare, X } from "lucide-react";
import { useLanguage } from "../../shared/i18n/index.jsx";
import "./message-alert.css";

// Starts with "pythia_driver" so a sign-out or a truck change clears it with the rest.
const SEEN_PREFIX = "pythia_driver_seen_";

function readSeen(truckCode) {
  try {
    const raw = localStorage.getItem(`${SEEN_PREFIX}${truckCode}`);
    return raw === null ? null : new Set(JSON.parse(raw));
  } catch {
    return null;
  }
}

function writeSeen(truckCode, ids) {
  try {
    localStorage.setItem(`${SEEN_PREFIX}${truckCode}`, JSON.stringify([...ids]));
  } catch {
    // Without storage the banner shows again after a reload; nothing is lost.
  }
}

function notificationsSupported() {
  return typeof window !== "undefined" && "Notification" in window && "serviceWorker" in navigator;
}

// A system notification through the service worker registration, while the page is alive
// (open or in the background). Without a registration (none under automation) or without
// permission it does nothing: the banner and the tab badge still say it.
async function notify(title, body, tag) {
  if (!notificationsSupported() || Notification.permission !== "granted") return;
  try {
    const registration = await navigator.serviceWorker.getRegistration();
    await registration?.showNotification(title, {
      body,
      tag,
      icon: "/pythia-icon-192.png",
      data: { url: "/driver" },
    });
  } catch {
    // A refused or unsupported notification leaves the in-app banner as the alert.
  }
}

/**
 * Messages and instructions that reached this phone after the driver last looked: the ones
 * already there on the phone's first live read count as seen, so opening the app is quiet.
 * @param {string|undefined} truckCode
 * @param {{ list: any[], liveAt: number|null }} feed  useDispatchInstructions
 */
export function useMessageAlerts(truckCode, feed) {
  const { t } = useLanguage();
  const [seen, setSeen] = useState(() => (truckCode ? readSeen(truckCode) : null));
  useEffect(() => setSeen(truckCode ? readSeen(truckCode) : null), [truckCode]);

  useEffect(() => {
    if (!truckCode || !feed.liveAt || seen) return;
    const ids = new Set(feed.list.map((d) => d.id));
    writeSeen(truckCode, ids);
    setSeen(ids);
  }, [truckCode, feed.liveAt, feed.list, seen]);

  const fresh = useMemo(() => (seen ? feed.list.filter((d) => !seen.has(d.id)) : []), [seen, feed.list]);

  const notified = useRef(new Set());
  useEffect(() => {
    for (const dispatch of fresh) {
      if (notified.current.has(dispatch.id)) continue;
      notified.current.add(dispatch.id);
      notify(t("ea_drv_notify_title"), String(dispatch.instruction || ""), `pythia-dispatch-${dispatch.id}`);
    }
  }, [fresh, t]);

  // Seen = everything pending now (answered ones leave the list, so the set stays small).
  const markSeen = useCallback(() => {
    if (!truckCode) return;
    const ids = new Set(feed.list.map((d) => d.id));
    writeSeen(truckCode, ids);
    setSeen(ids);
  }, [truckCode, feed.list]);

  return { fresh, markSeen };
}

/**
 * "New message from dispatch": the newest unseen text, Open (to the Instructions tab) and
 * close. The phone-alert opt-in sits here, where a driver sees why it helps, and says
 * plainly that a closed app is reached by WhatsApp, not by this alert.
 * @param {{ fresh: any[], onOpen: () => void, onClose: () => void }} props
 */
export function MessageAlert({ fresh, onOpen, onClose }) {
  const { t } = useLanguage();
  const [permission, setPermission] = useState(() =>
    notificationsSupported() ? Notification.permission : "unsupported",
  );
  if (fresh.length === 0) return null;
  const latest = fresh[fresh.length - 1];

  async function enableAlerts() {
    try {
      setPermission(await Notification.requestPermission());
    } catch {
      setPermission("denied");
    }
  }

  return (
    <section className="drv-msg-alert" role="status" data-testid="driver-message-alert">
      <MessageSquare size={20} aria-hidden="true" className="drv-msg-alert-icon" />
      <div className="drv-msg-alert-body">
        <p className="drv-msg-alert-title">
          {fresh.length === 1 ? t("ea_drv_new_title") : t("ea_drv_new_n").replace("{n}", fresh.length)}
        </p>
        <p className="drv-msg-alert-text" data-testid="driver-message-alert-text">
          {latest.instruction}
        </p>
        {permission === "default" && (
          <div className="drv-msg-alert-optin">
            <button
              type="button"
              className="drv-link"
              data-testid="driver-alerts-enable"
              onClick={enableAlerts}
            >
              <BellRing size={16} aria-hidden="true" /> {t("ea_drv_alerts_on")}
            </button>
            <p className="drv-msg-alert-note">{t("ea_drv_alerts_note")}</p>
          </div>
        )}
        {permission === "granted" && <p className="drv-msg-alert-note">{t("ea_drv_alerts_note")}</p>}
        {permission === "denied" && <p className="drv-msg-alert-note">{t("ea_drv_alerts_denied")}</p>}
      </div>
      <div className="drv-msg-alert-actions">
        <button
          type="button"
          className="drv-btn primary is-small"
          data-testid="driver-message-alert-open"
          onClick={onOpen}
        >
          {t("ea_drv_open")}
        </button>
        <button
          type="button"
          className="drv-msg-alert-close"
          aria-label={t("ea_drv_close")}
          data-testid="driver-message-alert-close"
          onClick={onClose}
        >
          <X size={18} aria-hidden="true" />
        </button>
      </div>
    </section>
  );
}
