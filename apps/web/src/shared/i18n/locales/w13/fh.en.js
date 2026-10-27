// Outlook horizon on the Tomorrow page (en): the 7 / 14 / 30-day switch, the horizon summary,
// the daily strip and chart, the weighbridge-learning panel and the monthly proof lines. Keys
// are prefixed "fh_"; only this file uses them.
export const fhEn = {
  fh_days_heading: "Next {n} days · city-wide, t/day",
  fh_days_label: "City-wide waste per day, next {n} days",
  fh_horizon_label: "Forecast horizon",
  fh_horizon_option: "{n} days",
  fh_loading_days: "Loading the next {n} days",
  fh_error_days: "The {n}-day forecast couldn't load.",
  fh_total: "Total, {n} days",
  fh_avg: "Average per day",
  fh_peak: "Peak day",
  fh_peak_trucks: "Trucks at the peak",
  fh_peak_trucks_title:
    "Each district's tonnes on the peak day divided by {cap} t per truck per shift, rounded up and added",
  fh_trucks_unit: "trucks",
  fh_adjusted: "Adjusted {t} t",
  fh_dry_baseline: "Dry-day baseline",
  fh_dry_baseline_title:
    "Past the Open-Meteo window the model is fed a dry day: 0 mm rain, 31 °C, 10 km/h wind",
  fh_weather_window:
    "Open-Meteo weather drives the first {with} days. From {from}, each day runs on a dry-day baseline (0 mm rain, 31 °C, 10 km/h wind) and sharpens as it enters the weather window.",
  fh_weather_all: "Open-Meteo weather drives every day in this range.",
  fh_chart_hint: "Daily forecast chart. Use the left and right arrow keys to read each day.",
  fh_chart_avg: "Average {t}",
  fh_key_forecast: "With Open-Meteo weather",
  fh_key_beyond: "Dry-day baseline",
  fh_axis_beyond: "Dry-day baseline from {date}",
  fh_col_date: "Day",
  fh_col_tons: "Forecast, t",
  fh_col_adjusted: "Adjusted, t",
  fh_col_weather: "Weather input",
  fh_weather_yes: "Open-Meteo forecast",
  fh_weather_no: "Dry-day baseline",
  fh_learn_title: "Learns from the weighbridge",
  fh_learn_status: "Status",
  fh_learn_active: "Self-correcting · {n} weighed days",
  fh_learn_waiting: "Self-correcting from day {min} · {n} weighed so far",
  fh_learn_correction: "Correction",
  fh_learn_correction_from: "Starts on day {min}",
  fh_learn_days: "Weighed days used",
  fh_learn_days_value: "{n} of the last {window}",
  fh_learn_cap: "Cap",
  fh_learn_cap_value: "±{cap}%",
  fh_learn_since: "{from} – {to}",
  fh_learn_basis:
    "Every closed work-order day's weighed tonnes are compared with the approved plan's forecast. The last {window} weighed days, recent ones counting most, set the correction (capped at ±{cap}%), learned on the pilot fleet and applied to the city-wide forecast beside the model figure.",
  fh_learn_waiting_basis:
    "Every closed work-order day with weighed receipts feeds the forecast. From day {min}, an adjusted figure appears beside each forecast.",
  fh_learn_clamped: "Held at the ±{cap}% cap; the weighed days point to {raw}.",
  fh_months_proof:
    "Validated on {n} months of real Bantargebang weighings ({period}): {mape}% error vs {naive}% for the best simple rule, 1–{max} months ahead.",
  fh_months_lebaran:
    "Sharpest in Lebaran months (shaded): {lebaran}% less error than the simple rule, {normal}% in normal months.",
  fh_months_more: "{months} unlock as new Bantargebang weighings arrive.",
  fh_months_pending: "Accuracy figures appear here once the backtest has run.",
  fh_months_unavailable: "Monthly intake figures appear here once the intake model is loaded.",
};
