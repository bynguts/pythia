import { useEffect, useState } from "react";
import { ApiError, apiGet } from "../../shared/api/client.js";
import { useLanguage, localeFor } from "../../shared/i18n/index.jsx";
import "./monthlyIntake.css";

// The one forecast backtested on real data (Bantargebang intake, t/day per month).
// Its data end at `fitted_through` and the backtest covers 1–3 months ahead, so
// each month carries the API's `within_backtested_horizon` flag on screen.

function fill(template, values) {
  return Object.entries(values).reduce((text, [key, value]) => text.replaceAll(`{${key}}`, value), template);
}

function currentMonth() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

// "2026-04" + n months → Date on the first of that month (local time).
function monthDate(ym, add = 0) {
  const [year, month] = ym.split("-").map(Number);
  return new Date(year, month - 1 + add, 1);
}

// Teardown v4 P2: consecutive months with the same rounded level and the same
// horizon flag collapse into one row ("Okt–Des 2026 ≈ 7.247 t/hari"), so three
// identical numbers never read as a broken chart.
function groupMonths(months) {
  const groups = [];
  for (const m of months) {
    const last = groups.at(-1);
    if (
      last &&
      Math.round(last.tons_per_day) === Math.round(m.tons_per_day) &&
      last.within_backtested_horizon === m.within_backtested_horizon &&
      !m.idul_fitri_date_unverified &&
      !last.idul_fitri_date_unverified
    ) {
      last.months.push(m.month);
      last.horizon_to = m.horizon_months;
    } else {
      groups.push({ ...m, months: [m.month], horizon_to: m.horizon_months });
    }
  }
  return groups;
}

export function MonthlyIntakeStrip() {
  const { lang, t } = useLanguage();
  const [data, setData] = useState(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    const get = (query) => apiGet(`/ml/monthly-intake?months=3${query}`, { signal: controller.signal });
    // Ask for the operator's own months; a clock still inside the observed data
    // (422) falls back to the API default, the first unobserved month.
    get(`&start_month=${currentMonth()}`)
      .catch((error) => {
        if (error instanceof ApiError && error.status === 422) return get("");
        throw error;
      })
      .then(setData)
      .catch((error) => {
        if (error?.name !== "AbortError") setFailed(true);
      });
    return () => controller.abort();
  }, []);

  const locale = localeFor(lang);
  const monthLabel = (date) => date.toLocaleDateString(locale, { month: "short", year: "numeric" });
  const months = data?.available ? data.months : [];
  const horizons = data?.backtested_horizon_months || [];

  return (
    <section
      className="monthly-intake-strip"
      data-testid="monthly-intake-strip"
      aria-labelledby="monthly-intake-title"
    >
      <div className="section-intro compact">
        <div>
          <h2 id="monthly-intake-title">{t("hon_mi_title")}</h2>
        </div>
        {months.length > 0 && horizons.length > 0 && (
          <p data-testid="monthly-intake-note">
            {fill(t("hon_mi_note"), {
              through: monthLabel(monthDate(data.fitted_through)),
              maxh: horizons.at(-1),
              from: monthLabel(monthDate(data.fitted_through, horizons[0])),
              to: monthLabel(monthDate(data.fitted_through, horizons.at(-1))),
            })}
          </p>
        )}
      </div>

      {!data && !failed && <p className="monthly-intake-status">{t("hon_mi_loading")}</p>}
      {(failed || (data && !data.available)) && (
        <p className="monthly-intake-status" data-testid="monthly-intake-unavailable">
          {t("hon_mi_unavailable")}
        </p>
      )}

      {months.length > 0 && (
        <ol className="monthly-intake-months" aria-label={t("hon_mi_list_label")}>
          {groupMonths(months).map((m) => {
            const range = m.months.length > 1;
            const label = range
              ? `${monthLabel(monthDate(m.months[0]))}–${monthLabel(monthDate(m.months.at(-1)))}`
              : monthLabel(monthDate(m.month));
            return (
              <li key={m.month} data-testid={`monthly-intake-${m.month}`} data-months={m.months.join(" ")}>
                <span className="monthly-intake-month">{label}</span>
                <strong>
                  {range ? "≈ " : ""}
                  {Number(m.tons_per_day).toLocaleString(locale, { maximumFractionDigits: 0 })}{" "}
                  {t("hon_mi_unit")}
                </strong>
                <span
                  className={`monthly-intake-horizon ${m.within_backtested_horizon ? "is-within" : "is-outside"}`}
                  data-testid="monthly-intake-horizon"
                  data-within={m.within_backtested_horizon ? "true" : "false"}
                >
                  {range
                    ? fill(
                        t(m.within_backtested_horizon ? "w10num_mi_within_range" : "w10num_mi_outside_range"),
                        {
                          from: m.horizon_months,
                          to: m.horizon_to,
                        },
                      )
                    : fill(t(m.within_backtested_horizon ? "hon_mi_within" : "hon_mi_outside"), {
                        h: m.horizon_months,
                      })}
                </span>
                {m.idul_fitri_date_unverified && <small>{t("hon_mi_eid_unverified")}</small>}
              </li>
            );
          })}
        </ol>
      )}
      {months.length > 0 && (
        <p className="monthly-intake-quantity" data-testid="monthly-intake-quantity">
          {t("w10num_mi_quantity")}
        </p>
      )}
      {months.length > 0 && (
        <small className="monthly-intake-class" data-testid="monthly-intake-class">
          {t("hon_mi_class")}
        </small>
      )}
    </section>
  );
}
