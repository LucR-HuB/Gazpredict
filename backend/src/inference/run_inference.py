import json
import logging
import sys
from collections import deque
from pathlib import Path

import numpy as np
import pandas as pd
from sqlmodel import select
from xgboost import XGBRegressor

SRC_ROOT = Path(__file__).resolve().parents[1]
if str(SRC_ROOT) not in sys.path:
    sys.path.append(str(SRC_ROOT))

from features.feature_definitions import (
    compute_calendar_features,
    compute_hdd,
    compute_stock_physics,
)

try:
    from backend.src.config.database import engine
    from backend.src.models.gie import GieData
    from backend.src.models.weather import WeatherData
except ImportError:
    project_root = Path(__file__).resolve().parents[3]
    if str(project_root) not in sys.path:
        sys.path.append(str(project_root))
    from backend.src.config.database import engine
    from backend.src.models.gie import GieData
    from backend.src.models.weather import WeatherData


PROJECT_ROOT = Path(__file__).resolve().parents[3]
MODEL_PATH = PROJECT_ROOT / "data" / "models" / "xgb_gas_v1.json"
MODEL_FEATURES_PATH = PROJECT_ROOT / "data" / "models" / "model_features.json"
OUTPUT_PATH = PROJECT_ROOT / "data" / "predictions" / "forecast_14d.csv"

FORECAST_HORIZON_DAYS = 14


def _build_fixed_buffer(values: list[float], size: int, pad_value: float) -> deque:
    clean_values = [float(value) for value in values if pd.notna(value)]
    if not clean_values:
        clean_values = [float(pad_value)] * size
    elif len(clean_values) < size:
        clean_values = [clean_values[0]] * (size - len(clean_values)) + clean_values
    else:
        clean_values = clean_values[-size:]
    return deque(clean_values, maxlen=size)


def _prepare_weather_tables(weather_df: pd.DataFrame, today: pd.Timestamp) -> tuple[pd.DataFrame, pd.DataFrame]:
    weather = weather_df.copy()
    weather["date"] = pd.to_datetime(weather["date"], errors="coerce")
    weather = weather.dropna(subset=["date", "country"]).copy()
    weather["country"] = weather["country"].astype(str)
    weather = weather.sort_values(["country", "date"]).reset_index(drop=True)

    weather["hdd"] = compute_hdd(weather["temp_weighted"])

    forecast = weather[
        (weather["source"].astype(str).str.lower() == "forecast") & (weather["date"] >= today)
    ].copy()
    forecast = forecast[["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])

    weather_all = weather[["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])
    return forecast, weather_all


def _prepare_gie_table(gie_df: pd.DataFrame) -> pd.DataFrame:
    gie = gie_df.copy()
    gie["date"] = pd.to_datetime(gie["date"], errors="coerce")
    gie = gie.dropna(subset=["date", "country"]).copy()
    gie["country"] = gie["country"].astype(str)
    gie = gie.sort_values(["country", "date"]).reset_index(drop=True)
    gie = gie.rename(columns={"storage_twh": "stock_twh"})

    if "stock_twh" not in gie.columns:
        raise KeyError("Missing required 'storage_twh' column in GIE data.")

    gie["net_injection"] = gie.groupby("country")["stock_twh"].diff()
    return gie


def _load_artifacts() -> tuple[XGBRegressor, list[str]]:
    if not MODEL_PATH.exists():
        raise FileNotFoundError(f"Model artifact not found: {MODEL_PATH}")
    if not MODEL_FEATURES_PATH.exists():
        raise FileNotFoundError(f"Model features artifact not found: {MODEL_FEATURES_PATH}")

    model = XGBRegressor()
    model.load_model(MODEL_PATH)

    model_features = json.loads(MODEL_FEATURES_PATH.read_text())
    if not isinstance(model_features, list) or not model_features:
        raise ValueError("model_features.json must contain a non-empty list of feature names.")

    return model, model_features


def _load_inputs_from_sql() -> tuple[pd.DataFrame, pd.DataFrame]:
    weather_df = pd.read_sql(select(WeatherData), engine)
    gie_df = pd.read_sql(select(GieData), engine)

    if gie_df.empty:
        raise RuntimeError("No GIE data available in SQL database.")
    if weather_df.empty:
        raise RuntimeError("No weather data available in SQL database.")

    return weather_df, gie_df


def run_recursive_forecast(
    weather_df: pd.DataFrame | None = None,
    gie_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    logger = logging.getLogger("run_inference")
    model, model_features = _load_artifacts()

    today = pd.Timestamp.today().normalize()
    forecast_dates = pd.date_range(start=today, periods=FORECAST_HORIZON_DAYS, freq="D")
    logger.info("Forecast window: %s to %s", forecast_dates.min().date(), forecast_dates.max().date())

    if weather_df is None or gie_df is None:
        weather_df, gie_df = _load_inputs_from_sql()

    weather_forecast, weather_all = _prepare_weather_tables(weather_df, today)
    gie = _prepare_gie_table(gie_df)

    trained_countries = sorted(
        feature_name.replace("country_", "")
        for feature_name in model_features
        if feature_name.startswith("country_")
    )
    if not trained_countries:
        trained_countries = sorted(gie["country"].unique())

    results: list[dict] = []

    for country in trained_countries:
        gie_country = gie[gie["country"] == country].sort_values("date").copy()
        if gie_country.empty:
            logger.warning("Skipping %s: no GIE history available.", country)
            continue

        latest_row = gie_country.iloc[-1]
        latest_stock = float(latest_row["stock_twh"])
        latest_date = latest_row["date"]

        if latest_date < (today - pd.Timedelta(days=1)):
            logger.warning(
                "Country %s latest stock date is %s (older than yesterday). Using latest available context.",
                country,
                latest_date.date(),
            )

        lag_values = gie_country["net_injection"].dropna().tolist()
        lag_pad = lag_values[-1] if lag_values else 0.0
        lag_buffer = _build_fixed_buffer(lag_values, size=7, pad_value=lag_pad)

        weather_history_country = weather_all[
            (weather_all["country"] == country) & (weather_all["date"] < today)
        ].sort_values("date")

        weather_forecast_country = weather_forecast[weather_forecast["country"] == country].set_index("date")
        if weather_forecast_country.empty:
            logger.warning("Skipping %s: no forecast weather available from today onward.", country)
            continue

        weather_forecast_country = weather_forecast_country.reindex(forecast_dates).ffill().bfill()
        if weather_forecast_country[["hdd", "wind_weighted"]].isna().any().any():
            logger.warning("Skipping %s: weather forecast has unresolved missing values.", country)
            continue

        first_hdd = float(weather_forecast_country.iloc[0]["hdd"])
        first_wind = float(weather_forecast_country.iloc[0]["wind_weighted"])

        hdd_values = weather_history_country["hdd"].dropna().tolist()
        wind_values = weather_history_country["wind_weighted"].dropna().tolist()
        hdd_buffer = _build_fixed_buffer(hdd_values, size=6, pad_value=first_hdd)
        wind_buffer = _build_fixed_buffer(wind_values, size=6, pad_value=first_wind)

        current_stock = latest_stock

        for sim_date in forecast_dates:
            weather_today = weather_forecast_country.loc[sim_date]
            hdd_today = float(weather_today["hdd"])
            wind_today = float(weather_today["wind_weighted"])

            calendar_df = compute_calendar_features(pd.Series([sim_date]))
            day_of_week = int(calendar_df.loc[0, "day_of_week"])
            is_weekend = int(calendar_df.loc[0, "is_weekend"])

            day_of_year = sim_date.dayofyear
            angle = 2 * np.pi * day_of_year / 365.25
            day_sin = float(np.sin(angle))
            day_cos = float(np.cos(angle))

            hdd_roll_mean_7 = float(np.mean([*hdd_buffer, hdd_today]))
            wind_roll_mean_7 = float(np.mean([*wind_buffer, wind_today]))

            stock_df = compute_stock_physics(pd.DataFrame([{"stock_twh_lag_1": current_stock}]))
            stock_fill_rate = float(stock_df.loc[0, "stock_fill_rate"])

            feature_row = {
                "hdd": hdd_today,
                "wind_weighted": wind_today,
                "hdd_wind": hdd_today * wind_today,
                "cold_weekend": hdd_today * is_weekend,
                "stock_twh_lag_1": current_stock,
                "stock_fill_rate": stock_fill_rate,
                "net_injection_lag_1": float(lag_buffer[-1]),
                "net_injection_lag_7": float(lag_buffer[0]),
                "hdd_roll_mean_7": hdd_roll_mean_7,
                "wind_roll_mean_7": wind_roll_mean_7,
                "day_sin": day_sin,
                "day_cos": day_cos,
                "day_of_week": day_of_week,
                "is_weekend": is_weekend,
                "country": country,
            }

            X_row = pd.DataFrame([feature_row])
            X_row = pd.get_dummies(X_row, columns=["country"], drop_first=False)
            X_row = X_row.reindex(columns=model_features, fill_value=0.0).astype(float)

            pred_injection = float(model.predict(X_row)[0])
            current_stock += pred_injection

            lag_buffer.append(pred_injection)
            hdd_buffer.append(hdd_today)
            wind_buffer.append(wind_today)

            results.append(
                {
                    "date": sim_date.strftime("%Y-%m-%d"),
                    "country": country,
                    "net_injection_pred": pred_injection,
                    "stock_twh_simulated": current_stock,
                }
            )

    if not results:
        raise RuntimeError("No forecasts were produced. Check weather forecast and context data availability.")

    forecast_df = pd.DataFrame(results).sort_values(["country", "date"]).reset_index(drop=True)
    return forecast_df


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )

    logger = logging.getLogger("run_inference")
    forecast_df = run_recursive_forecast()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    forecast_df.to_csv(OUTPUT_PATH, index=False)
    logger.info("Saved 14-day recursive forecast to %s", OUTPUT_PATH)
    logger.info("Output rows: %s", len(forecast_df))


if __name__ == "__main__":
    main()
