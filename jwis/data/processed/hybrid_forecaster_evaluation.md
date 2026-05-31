# Hybrid Time-Series Waste Forecasting Evaluation Report

An explainable hybrid model (Prophet baseline + XGBoost residuals) designed for predicting waste spikes across Jakarta's administrative zones.

## Architecture Description
1. **Prophet**: Captures long-term population growth trend, yearly seasonality (rainy season changes), and weekly commercial cycle.
2. **XGBoost**: Corrects Prophet's prediction by mapping non-linear daily residuals caused by real-time events (concerts, crowd size), public holidays, and rainfall precipitation surges.

## Overall Performance Metrics
- **Average MAE**: 71.61 Tons / day
- **Average R² Score**: 0.376

## Performance Breakdown by Kelurahan

| Kelurahan | Mean Absolute Error (Tons) | R² Score | Sample Count |
|---|---|---|---|
| Gambir | 61.41 | 0.287 | 731 |
| Kebon Jeruk | 79.34 | 0.34 | 731 |
| Cengkareng | 78.31 | 0.323 | 731 |
| Pulogadung | 95.22 | 0.371 | 731 |
| Tebet | 68.36 | 0.533 | 731 |
| Tanjung Priok | 63.32 | 0.39 | 731 |
| Koja | 61.96 | 0.372 | 731 |
| Kramat Jati | 77.63 | 0.454 | 731 |
| Jagakarsa | 72.95 | 0.252 | 731 |
| Kalideres | 57.57 | 0.434 | 731 |

*Validation verified automatically on mock test sets of weather history.*
