// Outlook on the Tomorrow page (en): the week ahead and the next three months. Keys are
// prefixed "ol_"; only the outlook lane edits this file.
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
  ol_months: "Next 3 months · Bantargebang intake, t/day",
  ol_months_label: "Bantargebang intake per day, next 3 months",
  ol_within: "Within the backtested 1–{max} months",
  ol_beyond: "{h} months past the data · beyond the backtested 1–{max}",
  ol_evidence: "Error {mape}% on real weighing data (backtest {period}) vs {naive}% for the best simple rule",
  ol_evidence_none: "Backtest error: —",
  ol_fitted: "Data through {month}",
  ol_loading: "Loading the outlook",
  ol_error: "The outlook couldn't load.",
  ol_unavailable: "—",
};
