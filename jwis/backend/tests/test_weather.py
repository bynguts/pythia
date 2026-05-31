import unittest

from app.weather import build_weather_risk, parse_open_meteo_daily


class WeatherTests(unittest.TestCase):
    def test_parse_open_meteo_daily_shapes_forecast_records(self):
        payload = {
            "daily": {
                "time": ["2026-06-01", "2026-06-02"],
                "temperature_2m_max": [31.2, 30.4],
                "temperature_2m_min": [24.8, 24.1],
                "precipitation_sum": [42.0, 8.5],
                "precipitation_probability_max": [91, 45],
                "wind_speed_10m_max": [17.1, 12.3],
            }
        }

        forecast = parse_open_meteo_daily(payload)

        self.assertEqual(len(forecast), 2)
        self.assertEqual(forecast[0]["date"], "2026-06-01")
        self.assertEqual(forecast[0]["rainfall_mm"], 42.0)
        self.assertEqual(forecast[0]["risk_level"], "critical")

    def test_weather_risk_recommends_delay_when_rain_probability_is_high(self):
        risk = build_weather_risk(rainfall_mm=32, precipitation_probability=85, wind_speed_kmh=18)

        self.assertEqual(risk["risk_level"], "critical")
        self.assertIn("Delay", risk["operational_advice"])
        self.assertGreaterEqual(risk["waste_impact_percent"], 16)


if __name__ == "__main__":
    unittest.main()
