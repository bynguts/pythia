// Outlook on the Tomorrow page (en): the week ahead and the monthly model backtest. Keys are
// prefixed "ol_"; only this file uses them.
export const olEn = {
  ol_title: "Outlook",
  ol_aside: "Inputs fill themselves: weather, events, holidays",
  ol_model_title:
    "Model output: the week is the Prophet + XGBoost forecast per district summed for the city; the months are the Bantargebang intake model",
  ol_week: "Next 7 days · city-wide, t/day",
  ol_week_label: "City-wide waste per day, next 7 days",
  ol_today: "Today",
  ol_tomorrow: "Tomorrow",
  ol_rain: "Rain {mm} mm",
  ol_dry: "Dry",
  ol_no_weather: "No weather forecast",
  ol_no_weather_title: "Outside the Open-Meteo forecast window; the model used 0 mm rain",
  ol_weekend: "Weekend",
  ol_event: "{name}",
  ol_event_title: "On the city calendar or a submitted permit",
  ol_months: "Bantargebang intake · weighed vs model, t/day",
  ol_months_label: "Bantargebang intake per month: weighed vs the model one month ahead, t/day",
  ol_within: "Within the backtested 1–{max} months",
  ol_beyond:
    "No figure for {months}: {h} months past the latest weighing data ({through}), beyond the backtested 1–{max} months",
  ol_evidence:
    "Calendar-adjusted 12-month model, backtested on {n} months of real Bantargebang weighing data ({period}): error {mape}% vs {naive}% for the best simple rule, 1–{max} months ahead",
  ol_evidence_none: "Backtest error: —",
  ol_lebaran:
    "The gain comes from Lebaran months (Ramadan and mudik, shaded): {lebaran}% less error than the simple rule there, {normal}% in normal months",
  ol_next: "Next months · within the backtested horizon, t/day",
  ol_bt_actual: "Weighed",
  ol_bt_model: "Model, 1 month ahead",
  ol_bt_lebaran: "Lebaran",
  ol_bt_month: "Month",
  ol_bt_readout: "{month} · weighed {actual} · model {model} t/day",
  ol_loading: "Loading the outlook",
  ol_error: "The outlook couldn't load.",
  ol_unavailable: "—",
  ol_learning: "Learning from {n} weighed days · correction {pct}",
  ol_learning_off: "Starts adjusting after {min} weighed days",
  ol_learning_so_far: "{n} so far",
  ol_learning_title:
    "Weighbridge tonnes of closed work-order days against the plan's forecast; a recent-weighted average, capped at ±{cap}%. The model value stays as it is.",
  ol_corrected: "Adjusted {t} t",
};
