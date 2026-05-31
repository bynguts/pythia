# Isolation Forest Fleet Anomaly Detection Evaluation

This model detects route deviations and speed anomalies for waste transportation vehicles.

## Model Summary
- **Type**: Isolation Forest
- **Training points**: 1500 (GPS + speed coordinates along official corridors)
- **Features**: `[latitude, longitude, speed_kmh]`
- **Contamination**: 0.01 (clean baseline corridors)

## Performance Metrics (Simulated Test Set)
- **Accuracy**: 77.00%
- **Precision**: 96.55%
- **Recall**: 56.00%
- **F1 Score**: 70.89%

*Validation evidence generated automatically during final project compilation.*
