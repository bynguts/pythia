import { Fragment, useState } from "react";
import { ChevronDown, GripVertical } from "lucide-react";
import { localeFor, useLanguage } from "../../shared/i18n/index.jsx";
import { Segmented } from "../../shared/ui/index.js";
import { basisText, districtRows, gateRows, lanesFromBasis, planGateWindow } from "./tomorrowModel.js";

const VISIBLE_ROWS = 9;
const DISTRICT_CODES = 6;

// Truck codes in a cell: a code never breaks inside itself ("T-" / "222"); past `max` the
// rest fold into "+n", listed in full in the tooltip.
function TruckCodes({ codes, max = Infinity }) {
  const shown = codes.slice(0, max);
  const rest = codes.length - shown.length;
  return (
    <span className="tmr-codes" title={rest > 0 ? codes.join(", ") : undefined}>
      {shown.map((code, index) => (
        <Fragment key={code}>
          {index > 0 && ", "}
          <span className="ui-code tmr-code">{code}</span>
        </Fragment>
      ))}
      {rest > 0 && <span className="tmr-code tmr-codes-more"> +{rest}</span>}
    </span>
  );
}

// The plan's KPI row: trucks used of the pilot fleet, trips and tonnes, the gate slot
// grid, and the modelled queue at the gate without vs with a staggered plan.
export function AllocationKpis({ plan, rows, fleetSize, held, board, queueMetric }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value, digits = 0) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: digits });
  const gateWindow = planGateWindow(plan);
  const lanes = lanesFromBasis(board?.capacity_basis);
  const spare = fleetSize != null ? fleetSize - rows.length - held.length : null;
  const trucksNote = held.length
    ? held.length <= 2
      ? t("s3_kpi_trucks_held").replace("{codes}", held.join(", "))
      : t("s3_kpi_trucks_held_many").replace("{n}", held.length)
    : spare != null && spare > 0
      ? t("s3_kpi_trucks_spare").replace("{n}", number(spare))
      : " ";
  const queueBefore = queueMetric?.baseline_mean;
  const queueAfter = queueMetric?.staggered_mean;
  return (
    <dl className="tmr-kpis" data-testid="tmr-kpis">
      <div className="tmr-kpi" data-provenance="simulated" title={t("s3_kpi_sim_title")}>
        <dt>{t("s3_kpi_trucks")}</dt>
        <dd className="tmr-kpi-value" data-testid="tmr-kpi-trucks" data-value={rows.length}>
          {fleetSize != null
            ? t("s3_kpi_trucks_value").replace("{a}", number(rows.length)).replace("{b}", number(fleetSize))
            : number(rows.length)}
        </dd>
        <dd className="tmr-kpi-note">{trucksNote}</dd>
      </div>
      <div className="tmr-kpi" data-provenance="model">
        <dt>{t("s3_kpi_trips")}</dt>
        <dd className="tmr-kpi-value" data-testid="tmr-kpi-trips" data-value={plan.assignments?.length ?? 0}>
          {number(plan.assignments?.length ?? 0)}
        </dd>
        <dd className="tmr-kpi-note">
          {t("s3_kpi_trips_note").replace("{t}", number(plan.total_assigned_tons, 1))}
        </dd>
      </div>
      <div className="tmr-kpi" data-provenance="model">
        <dt>{t("s3_kpi_gate")}</dt>
        <dd className="tmr-kpi-value">
          {board?.slot_minutes != null ? t("s3_kpi_gate_value").replace("{n}", board.slot_minutes) : "—"}
        </dd>
        <dd className="tmr-kpi-note" title={basisText(board?.capacity_basis, t)}>
          {gateWindow
            ? t(lanes ? "s3_kpi_gate_note_lanes" : "s3_kpi_gate_note")
                .replace("{from}", gateWindow.from)
                .replace("{to}", gateWindow.to)
                .replace("{n}", lanes)
            : " "}
        </dd>
      </div>
      <div className="tmr-kpi is-model" data-provenance="simulated" title={t("s3_kpi_queue_title")}>
        <dt>{t("s3_kpi_queue")}</dt>
        <dd className="tmr-kpi-value" data-testid="tmr-kpi-queue">
          {queueBefore != null && queueAfter != null
            ? t("s3_kpi_queue_value")
                .replace("{a}", number(queueBefore, 1))
                .replace("{b}", number(queueAfter, 1))
            : "—"}
        </dd>
        <dd className="tmr-kpi-note">{t("s3_kpi_queue_note")}</dd>
      </div>
    </dl>
  );
}

export function PlanFlags({ flags, review }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const label = (flag) => {
    if (flag.kind === "over")
      return t("s3_flag_over").replace("{code}", flag.code).replace("{t}", number(flag.tons));
    if (flag.kind === "short")
      return flag.trips
        ? (flag.trips === 1
            ? t("s3_flag_short_trip")
            : t("s3_flag_short_trips").replace("{n}", flag.trips)
          ).replace("{area}", flag.area)
        : t("s3_flag_short").replace("{area}", flag.area).replace("{t}", number(flag.tons));
    if (flag.kind === "short_more")
      return t("s3_flag_short_more").replace("{n}", flag.count).replace("{t}", number(flag.tons));
    if (flag.kind === "unassigned") return t("s3_flag_unassigned").replace("{t}", number(flag.tons));
    return t("s3_flag_gate_peak").replace("{from}", flag.from).replace("{to}", flag.to);
  };
  return (
    <ul
      className="tmr-flags"
      data-testid="tmr-flags"
      aria-label={t(review ? "s3_flags_review" : "s3_flags_title")}
    >
      <li className="tmr-flags-title" aria-hidden="true">
        {t(review ? "s3_flags_review" : "s3_flags_title")}
      </li>
      {flags.length === 0 ? (
        <li className="tmr-chip is-ok" data-testid="tmr-flag" data-kind="none">
          {t("s3_flag_none")}
        </li>
      ) : (
        flags.map((flag, index) => (
          <li
            key={`${flag.kind}-${index}`}
            className={`tmr-chip${flag.tone === "warn" ? " is-warn" : ""}`}
            data-testid="tmr-flag"
            data-kind={flag.kind}
          >
            {label(flag)}
          </li>
        ))
      )}
    </ul>
  );
}

function MoreToggle({ hidden, open, onToggle, unit }) {
  const { t } = useLanguage();
  if (hidden <= 0 && !open) return null;
  const text = open
    ? t("s3_show_fewer")
    : unit === "truck"
      ? hidden === 1
        ? t("s3_more_trucks_one")
        : t("s3_more_trucks").replace("{n}", hidden)
      : t("s3_more_rows").replace("{n}", hidden);
  return (
    <button type="button" className="tmr-more" aria-expanded={open} data-testid="tmr-more" onClick={onToggle}>
      {text}
      <ChevronDown size={14} aria-hidden="true" />
    </button>
  );
}

// By truck: one row per truck. While the plan can still change (`canSwap`), a row's grip
// drags it onto another row to swap the two trucks' work (POST …/swap); Enter on a grip
// picks it, Enter on a second grip swaps, Escape cancels.
function TruckTable({ rows, canSwap, onSwap }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) => Number(value ?? 0).toLocaleString(locale, { maximumFractionDigits: 1 });
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(null);
  const [dragging, setDragging] = useState(null);
  const [over, setOver] = useState(null);
  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);

  const why = (row) => {
    if (row.demand && row.demandLabel)
      return t("s3_why_forecast")
        .replace("{t}", Number(row.demand.tons).toLocaleString(locale, { maximumFractionDigits: 0 }))
        .replace("{area}", row.demandLabel);
    return "—";
  };
  function pick(code) {
    if (!picked) return setPicked(code);
    if (picked === code) return setPicked(null);
    onSwap(picked, code);
    setPicked(null);
  }
  return (
    <>
      <div className="ui-table-wrap">
        <table className="ui-table tmr-table" data-testid="tmr-truck-table">
          <caption className="sr-only">{t("s3_alloc_title")}</caption>
          <thead>
            <tr>
              <th scope="col" className="tmr-col-truck">
                {t("s3_th_truck")}
              </th>
              <th scope="col" className="tmr-col-districts">
                {t("s3_th_districts")}
              </th>
              <th scope="col" className="tmr-col-trips">
                {t("s3_th_trips")}
              </th>
              <th scope="col" className="tmr-col-gate">
                {t("s3_th_gate")}
              </th>
              <th scope="col" className="tmr-col-load">
                {t("s3_th_load")}
              </th>
              <th scope="col">{t("s3_th_why")}</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const classes = [
                row.over ? "is-over" : "",
                picked === row.truck ? "is-picked" : "",
                over === row.truck && dragging && dragging !== row.truck ? "is-drop" : "",
              ]
                .filter(Boolean)
                .join(" ");
              const dropProps = canSwap
                ? {
                    onDragOver: (event) => {
                      if (!dragging || dragging === row.truck) return;
                      event.preventDefault();
                      setOver(row.truck);
                    },
                    onDragLeave: () => setOver((current) => (current === row.truck ? null : current)),
                    onDrop: (event) => {
                      event.preventDefault();
                      if (dragging && dragging !== row.truck) onSwap(dragging, row.truck);
                      setDragging(null);
                      setOver(null);
                    },
                  }
                : {};
              return (
                <tr
                  key={row.truck}
                  className={classes || undefined}
                  data-testid="tmr-truck-row"
                  data-truck={row.truck}
                  {...dropProps}
                >
                  <td>
                    <span className={`tmr-truck${canSwap ? "" : " tmr-truck-plain"}`}>
                      {canSwap && (
                        <button
                          type="button"
                          className="tmr-grip"
                          draggable
                          aria-pressed={picked === row.truck}
                          aria-label={
                            picked && picked !== row.truck
                              ? t("s3_drag_target").replace("{a}", picked).replace("{b}", row.truck)
                              : picked === row.truck
                                ? t("s3_drag_picked").replace("{code}", row.truck)
                                : t("s3_drag_handle").replace("{code}", row.truck)
                          }
                          data-testid="tmr-grip"
                          onClick={() => pick(row.truck)}
                          onKeyDown={(event) => {
                            if (event.key === "Escape") setPicked(null);
                          }}
                          onDragStart={(event) => {
                            event.dataTransfer.effectAllowed = "move";
                            event.dataTransfer.setData("text/plain", row.truck);
                            setDragging(row.truck);
                          }}
                          onDragEnd={() => {
                            setDragging(null);
                            setOver(null);
                          }}
                        >
                          <GripVertical size={14} aria-hidden="true" />
                        </button>
                      )}
                      <strong>{row.truck}</strong>
                    </span>
                  </td>
                  <td>{row.districts.join(", ")}</td>
                  <td>{row.trips}</td>
                  <td data-testid="tmr-gate-slot">{row.slot?.start || "—"}</td>
                  <td className={`tmr-load${row.over ? " is-over" : ""}`}>{number(row.tons)} t</td>
                  <td className="tmr-why-cell" title={why(row)}>
                    {why(row)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <MoreToggle
        hidden={rows.length - shown.length}
        open={open}
        unit="truck"
        onToggle={() => setOpen(!open)}
      />
    </>
  );
}

function DistrictTable({ plan }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const number = (value) =>
    value == null ? "—" : Number(value).toLocaleString(locale, { maximumFractionDigits: 1 });
  const rows = districtRows(plan);
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);
  return (
    <>
      <div className="ui-table-wrap">
        <table className="ui-table tmr-table" data-testid="tmr-district-table">
          <caption className="sr-only">{t("s3_view_district")}</caption>
          <thead>
            <tr>
              <th scope="col" className="tmr-col-districts">
                {t("s3_th_district")}
              </th>
              <th scope="col">{t("s3_th_trucks")}</th>
              <th scope="col" className="tmr-col-trips">
                {t("s3_th_trips")}
              </th>
              <th scope="col" className="tmr-col-load">
                {t("s3_th_load")}
              </th>
              <th scope="col" className="tmr-col-load">
                {t("s3_th_forecast")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr key={row.area} data-testid="tmr-district-row">
                <td>
                  <strong className="tmr-truck tmr-truck-plain">{row.label}</strong>
                </td>
                <td>
                  <TruckCodes codes={row.trucks} max={DISTRICT_CODES} />
                </td>
                <td>{row.trips}</td>
                <td>{number(row.tons)} t</td>
                <td className="tmr-why-cell">{row.demand != null ? `${number(row.demand)} t` : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreToggle hidden={rows.length - shown.length} open={open} onToggle={() => setOpen(!open)} />
    </>
  );
}

// One plain line when the weighbridge slots can't take the plan as staggered: trucks left
// without a slot, or a gate the rest of the day's (unstaggered) traffic already saturates.
function gateCapacityLine(capacity, t, locale) {
  if (!capacity) return null;
  const number = (value) => Number(value).toLocaleString(locale, { maximumFractionDigits: 0 });
  if (capacity.overflow_trucks?.length) {
    return t("s3_gate_overflow")
      .replace("{n}", number(capacity.overflow_trucks.length))
      .replace("{cap}", number(capacity.capacity_per_slot));
  }
  if (capacity.saturated && capacity.saturated_slots?.length) {
    return t("s3_gate_saturated")
      .replace("{from}", capacity.saturated_slots[0])
      .replace("{n}", number(capacity.coverage?.planned_gate_arrivals ?? 0))
      .replace("{total}", number(capacity.coverage?.daily_arrivals ?? 0));
  }
  return null;
}

function GateTable({ plan, board }) {
  const { t, lang } = useLanguage();
  const locale = localeFor(lang);
  const rows = gateRows(plan, board);
  const [open, setOpen] = useState(false);
  const shown = open ? rows : rows.slice(0, VISIBLE_ROWS);
  if (!rows.length) return <p className="tmr-empty-row">{t("s3_gate_empty")}</p>;
  // Slots on two dates name their day, so 09:00 today and 09:00 tomorrow read apart.
  const twoDays = new Set(rows.map((row) => row.date)).size > 1;
  const dayOf = (date) =>
    date ? new Date(`${date}T00:00:00`).toLocaleDateString(locale, { day: "numeric", month: "short" }) : "";
  const capacityLine = gateCapacityLine(plan.gate_capacity, t, locale);
  return (
    <>
      {capacityLine && (
        <p
          className="tmr-empty-row"
          data-testid="tmr-gate-capacity"
          title={basisText(plan.gate_capacity?.basis, t)}
        >
          {capacityLine}
        </p>
      )}
      <div className="ui-table-wrap">
        <table className="ui-table tmr-table" data-testid="tmr-gate-table" data-provenance="model">
          <caption className="sr-only">{t("s3_view_gate")}</caption>
          <thead>
            <tr>
              <th scope="col" className="tmr-col-gate">
                {t("s3_th_slot")}
              </th>
              <th scope="col">{t("s3_th_trucks")}</th>
              <th scope="col" className="tmr-col-gate" title={t("s3_wait_model_title")}>
                {t("s3_th_wait")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              <tr
                key={`${row.date} ${row.start} ${row.facility || ""}`}
                className={row.over ? "is-over" : undefined}
                data-testid="tmr-gate-row"
              >
                <td>
                  <strong className="tmr-truck tmr-truck-plain">
                    {twoDays && `${dayOf(row.date)} · `}
                    {row.start}–{row.end}
                  </strong>
                  {row.facility && <small className="tmr-gate-facility">{row.facility}</small>}
                </td>
                <td>
                  <TruckCodes codes={row.trucks} />
                </td>
                <td className="tmr-why-cell" data-testid="tmr-gate-wait">
                  {row.wait != null ? (
                    t("s3_wait_min").replace(
                      "{n}",
                      Number(row.wait).toLocaleString(locale, { maximumFractionDigits: 1 }),
                    )
                  ) : (
                    <span title={t(row.noWait === "older" ? "s3_wait_none_older" : "s3_wait_none_facility")}>
                      —
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MoreToggle hidden={rows.length - shown.length} open={open} onToggle={() => setOpen(!open)} />
    </>
  );
}

// The Segmented control for the card header and the table it selects.
export function useAllocationViews({ plan, rows, board, canSwap, onSwap }) {
  const { t } = useLanguage();
  const [view, setView] = useState("truck");
  const control = (
    <Segmented
      label={t("s3_view_label")}
      value={view}
      onChange={setView}
      options={[
        { value: "truck", label: t("s3_view_truck"), testId: "tmr-view-truck" },
        { value: "district", label: t("s3_view_district"), testId: "tmr-view-district" },
        { value: "gate", label: t("s3_view_gate"), testId: "tmr-view-gate" },
      ]}
    />
  );
  const body =
    view === "district" ? (
      <DistrictTable plan={plan} />
    ) : view === "gate" ? (
      <GateTable plan={plan} board={board} />
    ) : (
      <TruckTable rows={rows} canSwap={canSwap} onSwap={onSwap} />
    );
  return { control, body };
}
