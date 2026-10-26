import { useState } from "react";
import { ApiError, apiPost } from "../../shared/api/client.js";
import { useLanguage } from "../../shared/i18n/index.jsx";
import { Button } from "../../shared/ui/Button.jsx";
import { Drawer } from "../../shared/ui/Drawer.jsx";
import { jakartaToday } from "../readiness/clock.js";
import { PRETRIP_ITEM_KEYS } from "../readiness/readinessModel.js";

function useSubmit(onDone) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function run(task) {
    setBusy(true);
    setError("");
    try {
      await task();
      onDone();
    } catch (reason) {
      setError(reason instanceof ApiError && reason.detail ? reason.detail : "x");
    }
    setBusy(false);
  }
  return { busy, error, run };
}

function TruckSelect({ id, trucks, value, onChange }) {
  const { t } = useLanguage();
  return (
    <select id={id} className="flt-input" value={value} required onChange={(e) => onChange(e.target.value)}>
      <option value="">{t("s2_form_pick_truck")}</option>
      {trucks.map((truck) => (
        <option key={truck.truck_code} value={truck.truck_code}>
          {truck.truck_code}
          {truck.driver_name ? ` · ${truck.driver_name}` : ""}
        </option>
      ))}
    </select>
  );
}

function ErrorLine({ error }) {
  const { t } = useLanguage();
  if (!error) return null;
  return (
    <p className="flt-form-error" role="alert">
      {error === "x" ? t("s2_form_failed") : error}
    </p>
  );
}

export function LogDamageDrawer({ open, onClose, trucks, onSaved }) {
  const { t } = useLanguage();
  const [truck, setTruck] = useState("");
  const [component, setComponent] = useState("");
  const [severity, setSeverity] = useState("ringan");
  const [note, setNote] = useState("");
  const { busy, error, run } = useSubmit(() => {
    setTruck("");
    setComponent("");
    setNote("");
    setSeverity("ringan");
    onSaved(t("s2_dmg_logged"));
  });
  const driver = trucks.find((item) => item.truck_code === truck)?.driver_name || "";
  const valid = truck && component.trim() && note.trim();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("s2_log_damage")}
      subtitle={t("s2_dmg_form_sub")}
      testId="log-damage-drawer"
    >
      <form
        className="flt-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          run(() =>
            apiPost("/damage-reports", {
              truck_code: truck,
              driver_name: driver || "—",
              component: component.trim(),
              severity,
              note: note.trim(),
              source: "dispatcher",
            }),
          );
        }}
      >
        <label htmlFor="flt-dmg-truck">{t("s2_form_truck")}</label>
        <TruckSelect id="flt-dmg-truck" trucks={trucks} value={truck} onChange={setTruck} />
        <label htmlFor="flt-dmg-component">{t("s2_form_component")}</label>
        <input
          id="flt-dmg-component"
          className="flt-input"
          list="flt-components"
          value={component}
          maxLength={80}
          onChange={(e) => setComponent(e.target.value)}
          required
        />
        <datalist id="flt-components">
          {Object.values(PRETRIP_ITEM_KEYS).map((key) => (
            <option key={key} value={t(key)} />
          ))}
        </datalist>
        <fieldset className="flt-radios">
          <legend>{t("s2_form_severity")}</legend>
          {[
            ["ringan", "s2_sev_minor"],
            ["berat", "s2_sev_major"],
          ].map(([value, key]) => (
            <label key={value} className="flt-radio">
              <input
                type="radio"
                name="flt-severity"
                value={value}
                checked={severity === value}
                onChange={() => setSeverity(value)}
              />
              <span>{t(key)}</span>
            </label>
          ))}
        </fieldset>
        {severity === "berat" && <p className="flt-hint">{t("s2_form_major_hint")}</p>}
        <label htmlFor="flt-dmg-note">{t("s2_form_note")}</label>
        <textarea
          id="flt-dmg-note"
          className="flt-input"
          rows={3}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          required
        />
        <ErrorLine error={error} />
        <div className="flt-form-actions">
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {t("s2_form_save")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("s2_cancel")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}

export function BookServiceDrawer({ open, onClose, trucks, onSaved }) {
  const { t } = useLanguage();
  const [truck, setTruck] = useState("");
  const [date, setDate] = useState(jakartaToday());
  const [component, setComponent] = useState("");
  const [description, setDescription] = useState("");
  const [nextDue, setNextDue] = useState("");
  const { busy, error, run } = useSubmit(() => {
    setTruck("");
    setComponent("");
    setDescription("");
    setNextDue("");
    onSaved(t("s2_svc_booked"));
  });
  const valid = truck && date && component.trim() && description.trim();

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={t("s2_book_service")}
      subtitle={t("s2_svc_form_sub")}
      testId="book-service-drawer"
    >
      <form
        className="flt-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid) return;
          run(() =>
            apiPost("/service-records", {
              truck_code: truck,
              service_date: date,
              component: component.trim(),
              description: description.trim(),
              next_due_date: nextDue || null,
            }),
          );
        }}
      >
        <label htmlFor="flt-svc-truck">{t("s2_form_truck")}</label>
        <TruckSelect id="flt-svc-truck" trucks={trucks} value={truck} onChange={setTruck} />
        <label htmlFor="flt-svc-date">{t("s2_form_service_date")}</label>
        <input
          id="flt-svc-date"
          className="flt-input"
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          required
        />
        <label htmlFor="flt-svc-component">{t("s2_form_component")}</label>
        <input
          id="flt-svc-component"
          className="flt-input"
          value={component}
          maxLength={80}
          onChange={(e) => setComponent(e.target.value)}
          required
        />
        <label htmlFor="flt-svc-desc">{t("s2_form_description")}</label>
        <textarea
          id="flt-svc-desc"
          className="flt-input"
          rows={3}
          value={description}
          maxLength={500}
          onChange={(e) => setDescription(e.target.value)}
          required
        />
        <label htmlFor="flt-svc-next">{t("s2_form_next_due")}</label>
        <input
          id="flt-svc-next"
          className="flt-input"
          type="date"
          value={nextDue}
          min={date}
          onChange={(e) => setNextDue(e.target.value)}
        />
        <ErrorLine error={error} />
        <div className="flt-form-actions">
          <Button variant="primary" type="submit" disabled={!valid || busy}>
            {t("s2_form_save")}
          </Button>
          <Button variant="ghost" onClick={onClose}>
            {t("s2_cancel")}
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
