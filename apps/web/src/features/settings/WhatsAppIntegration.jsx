import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, LogOut, QrCode, Send, WifiOff } from "lucide-react";
import { apiGet, apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";

const POLL_MS = 4000;
// States in which the page keeps checking: a scan, a session start or the gateway coming up.
const WAITING = new Set(["pairing", "starting", "offline"]);
const STATES = new Set(["connected", "pairing", "starting", "offline", "unconfigured"]);
// The gateway serves the pairing QR as a PNG data URL (QRCode.toDataURL); nothing else is rendered.
const QR_PREFIX = "data:image/png;base64,";
const GATEWAY_COMMAND = "cd apps/wa-gateway && npm install && npm start";

const TONE = { connected: "good", pairing: "wait", starting: "wait", offline: "bad", unconfigured: "bad" };
const ICON = {
  connected: CheckCircle2,
  pairing: QrCode,
  starting: QrCode,
  offline: WifiOff,
  unconfigured: WifiOff,
};

// "62812****7890@s.whatsapp.net" -> "+62812****7890": the API only ever sends it masked.
function accountLabel(account) {
  return account ? `+${String(account).split("@")[0]}` : null;
}

// wave11 settings: Stripe-style groups. Each group is a heading and one plain box of
// hairline rows; the connection state leads, delivery and the unlink action follow.
export function WhatsAppIntegration({ canManage }) {
  const { t } = useLanguage();
  const [status, setStatus] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [reload, setReload] = useState(0);
  const [qr, setQr] = useState(null);
  const [groups, setGroups] = useState(null);
  const [groupsReload, setGroupsReload] = useState(0);
  const [choice, setChoice] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(null);
  const [confirmLogout, setConfirmLogout] = useState(false);

  const linkState = STATES.has(status?.link_state) ? status.link_state : status ? "starting" : null;

  const loadStatus = useCallback(async (signal) => {
    try {
      const body = await apiGet("/whatsapp/status", { signal });
      setStatus(body);
      setLoadError(null);
    } catch (error) {
      if (error?.name === "AbortError") return;
      setLoadError(error?.status === 403 ? "forbidden" : "failed");
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    loadStatus(controller.signal);
    return () => controller.abort();
  }, [loadStatus, reload]);

  // Poll while waiting; pause while the tab is hidden and stop when the section unmounts.
  useEffect(() => {
    if (!WAITING.has(linkState)) return undefined;
    const controller = new AbortController();
    let timer = null;
    const tick = () => loadStatus(controller.signal);
    const schedule = () => {
      clearInterval(timer);
      timer = document.hidden ? null : setInterval(tick, POLL_MS);
    };
    const onVisibility = () => {
      if (!document.hidden) tick();
      schedule();
    };
    schedule();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      controller.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [linkState, loadStatus]);

  // A fresh QR with every status read while pairing (the gateway rotates it).
  useEffect(() => {
    if (linkState !== "pairing" || !canManage) return undefined;
    const controller = new AbortController();
    apiGet("/whatsapp/qr", { signal: controller.signal })
      .then((body) => {
        setQr(typeof body?.qr === "string" && body.qr.startsWith(QR_PREFIX) ? body.qr : null);
      })
      .catch(() => {});
    return () => controller.abort();
  }, [status, linkState, canManage]);

  useEffect(() => {
    if (linkState !== "connected" || !canManage) return undefined;
    const controller = new AbortController();
    apiGet("/whatsapp/groups", { signal: controller.signal })
      .then((body) => {
        const list = Array.isArray(body?.groups) ? body.groups : [];
        setGroups(list);
        setChoice(list.find((group) => group.selected)?.jid || "");
      })
      .catch((error) => {
        if (error?.name !== "AbortError") setGroups([]);
      });
    return () => controller.abort();
  }, [linkState, canManage, groupsReload]);

  async function run(action) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
    } finally {
      setBusy(false);
    }
  }

  const saveGroup = () =>
    run(async () => {
      try {
        await apiPost("/whatsapp/alert-group", { group_jid: choice });
        setNotice({ tone: "good", text: t("set_wa_group_saved") });
        setReload((n) => n + 1);
        setGroupsReload((n) => n + 1);
      } catch {
        setNotice({ tone: "bad", text: t("set_wa_group_failed") });
      }
    });

  const sendTest = () =>
    run(async () => {
      try {
        const body = await apiPost("/whatsapp/test");
        setNotice(
          body?.sent
            ? { tone: "good", text: t("set_wa_test_sent") }
            : { tone: "bad", text: t("set_wa_test_failed") },
        );
      } catch (error) {
        setNotice({
          tone: "bad",
          text: error?.status === 409 ? t("set_wa_test_needs_group") : t("set_wa_test_failed"),
        });
      }
    });

  const logout = () =>
    run(async () => {
      setConfirmLogout(false);
      try {
        const body = await apiPost("/whatsapp/logout");
        setNotice(
          body?.logged_out
            ? { tone: "good", text: t("set_wa_logout_done") }
            : { tone: "bad", text: t("set_wa_logout_failed") },
        );
      } catch {
        setNotice({ tone: "bad", text: t("set_wa_logout_failed") });
      }
      setGroups(null);
      setQr(null);
      setReload((n) => n + 1);
    });

  const StateIcon = ICON[linkState] || QrCode;
  const source = status?.alert_group?.source;
  const selectedGroup = groups?.find((group) => group.selected);
  const manage = linkState === "connected" && canManage;

  return (
    <section className="settings-panel" aria-labelledby="settings-wa-title" data-testid="settings-whatsapp">
      <header className="settings-panel-head">
        <h2 id="settings-wa-title">{t("set_tab_whatsapp")}</h2>
        <p>{t("set_wa_intro")}</p>
      </header>

      {!canManage && (
        <p className="settings-banner" data-testid="settings-wa-readonly">
          {t("set_wa_readonly")}
        </p>
      )}

      {loadError === "forbidden" ? (
        <p className="settings-banner">{t("set_wa_no_access")}</p>
      ) : !status && loadError ? (
        <div className="settings-box">
          <div className="settings-row is-bad" role="alert">
            <p className="settings-row-text">{t("set_wa_state_error")}</p>
            <button type="button" className="ghost-button" onClick={() => setReload((n) => n + 1)}>
              {t("set_wa_retry")}
            </button>
          </div>
        </div>
      ) : !status ? (
        <div className="settings-box" aria-busy="true">
          <p className="settings-row settings-row-text" role="status">
            {t("set_wa_state_loading")}
          </p>
        </div>
      ) : (
        <>
          <section className="settings-group" aria-labelledby="settings-wa-connection">
            <h3 id="settings-wa-connection" className="settings-group-title">
              {t("set11_wa_connection")}
            </h3>
            <div className="settings-box">
              <div className="settings-status-row">
                <span className={`settings-glyph is-${TONE[linkState]}`} aria-hidden="true">
                  <StateIcon size={18} />
                </span>
                <div className="settings-status-text">
                  <strong
                    className={`settings-status is-${TONE[linkState]}`}
                    data-testid="settings-wa-status"
                    data-state={linkState}
                  >
                    {t(`set_wa_state_${linkState}`)}
                  </strong>
                  <span>{t(`set11_wa_meta_${linkState}`)}</span>
                </div>
                <span className="prov prov-proxy">{t("set11_wa_chip_unofficial")}</span>
              </div>

              <dl className="settings-facts">
                {linkState === "connected" && (
                  <div>
                    <dt>{t("set_wa_linked_account")}</dt>
                    <dd
                      className={status.linked_account ? "settings-mono" : undefined}
                      data-testid="settings-wa-account"
                    >
                      {accountLabel(status.linked_account) || t("set_wa_linked_unknown")}
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t("set_wa_group_label")}</dt>
                  <dd data-testid="settings-wa-group">
                    <span>
                      {source === "placeholder"
                        ? t("set_wa_group_none")
                        : selectedGroup?.subject || status.alert_group?.jid}
                    </span>
                    {source && <small>{t(`set_wa_group_source_${source}`)}</small>}
                  </dd>
                </div>
              </dl>

              {(linkState === "offline" || linkState === "unconfigured") && (
                <div className="settings-offline" data-testid="settings-wa-offline">
                  <strong>{t(`set_wa_state_${linkState}`)}</strong>
                  <p>{t("set_wa_offline_body")}</p>
                  <code className="settings-command">{GATEWAY_COMMAND}</code>
                  <small>{t("set_wa_offline_after")}</small>
                </div>
              )}

              {(linkState === "pairing" || linkState === "starting") &&
                (canManage ? (
                  <div className="settings-pairing" data-testid="settings-wa-pairing">
                    <div className="settings-qr">
                      {qr && linkState === "pairing" ? (
                        <img
                          src={qr}
                          alt={t("set_wa_qr_alt")}
                          width="240"
                          height="240"
                          data-testid="settings-wa-qr"
                        />
                      ) : (
                        <span role="status">{t("set_wa_qr_waiting")}</span>
                      )}
                    </div>
                    <div className="settings-pairing-steps">
                      <h4>{t("set_wa_scan_title")}</h4>
                      <ol>
                        <li>{t("set11_wa_step_open")}</li>
                        <li>{t("set11_wa_step_devices")}</li>
                        <li>{t("set11_wa_step_scan")}</li>
                      </ol>
                      <small>{t("set_wa_qr_refresh")}</small>
                    </div>
                  </div>
                ) : (
                  <p className="settings-row settings-row-text">{t("set_wa_admin_only_pairing")}</p>
                ))}
            </div>
          </section>

          {notice && (
            <p
              className={`settings-notice is-${notice.tone}`}
              role={notice.tone === "bad" ? "alert" : "status"}
              data-testid="settings-wa-notice"
            >
              {notice.text}
            </p>
          )}

          {manage && (
            <section
              className="settings-group"
              aria-labelledby="settings-wa-delivery"
              data-testid="settings-wa-manage"
            >
              <h3 id="settings-wa-delivery" className="settings-group-title">
                {t("set11_wa_delivery")}
              </h3>
              <div className="settings-box">
                <div className="settings-row settings-row-field">
                  <div className="settings-row-text">
                    <label htmlFor="settings-wa-group-select">{t("set_wa_group_pick")}</label>
                    <small data-testid="settings-wa-group-count">
                      {groups === null
                        ? t("set_wa_state_loading")
                        : groups.length
                          ? t("set_wa_groups_count").replace("{n}", groups.length)
                          : t("set_wa_groups_empty")}
                    </small>
                  </div>
                  <div className="settings-row-control">
                    <select
                      id="settings-wa-group-select"
                      className="settings-select"
                      value={choice}
                      disabled={!groups?.length || busy}
                      onChange={(event) => setChoice(event.target.value)}
                    >
                      <option value="" disabled>
                        {t("set_wa_group_pick")}
                      </option>
                      {(groups || []).map((group) => (
                        <option key={group.jid} value={group.jid}>
                          {group.subject}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="primary-button"
                      disabled={!choice || busy || choice === selectedGroup?.jid}
                      onClick={saveGroup}
                    >
                      {t("set_wa_group_save")}
                    </button>
                  </div>
                </div>
                <div className="settings-row">
                  <div className="settings-row-text">
                    <strong>{t("set11_wa_test_title")}</strong>
                    <small>{t("set11_wa_test_body")}</small>
                  </div>
                  <button type="button" className="ghost-button" disabled={busy} onClick={sendTest}>
                    <Send size={16} aria-hidden="true" /> {t("set_wa_test")}
                  </button>
                </div>
              </div>
            </section>
          )}

          {manage && (
            <section className="settings-group" aria-labelledby="settings-wa-device">
              <h3 id="settings-wa-device" className="settings-group-title">
                {t("set11_wa_device")}
              </h3>
              <div className="settings-box">
                <div className="settings-row">
                  <div className="settings-row-text">
                    <strong>{t("set11_wa_unlink_title")}</strong>
                    <small>{t("set11_wa_unlink_body")}</small>
                  </div>
                  {!confirmLogout && (
                    <button
                      type="button"
                      className="ghost-button settings-danger"
                      disabled={busy}
                      onClick={() => setConfirmLogout(true)}
                    >
                      <LogOut size={16} aria-hidden="true" /> {t("set_wa_logout")}
                    </button>
                  )}
                </div>
                {confirmLogout && (
                  <div
                    className="settings-row settings-confirm"
                    role="group"
                    aria-labelledby="settings-wa-logout-q"
                  >
                    <p id="settings-wa-logout-q" className="settings-row-text">
                      {t("set_wa_logout_confirm")}
                    </p>
                    <div className="settings-row-control">
                      <button type="button" className="ghost-button" onClick={() => setConfirmLogout(false)}>
                        {t("set_wa_cancel")}
                      </button>
                      <button type="button" className="primary-button settings-danger-solid" onClick={logout}>
                        {t("set_wa_logout_yes")}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </section>
          )}
        </>
      )}

      <p className="settings-provenance">{t("set_wa_unofficial")}</p>
    </section>
  );
}
