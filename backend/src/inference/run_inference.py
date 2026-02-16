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


def _prepare_weather_tables(weather_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame]:
    weather = weather_df.copy()
    weather["date"] = pd.to_datetime(weather["date"], errors="coerce")
    weather = weather.dropna(subset=["date", "country"]).copy()
    weather["country"] = weather["country"].astype(str)
    weather = weather.sort_values(["country", "date"]).reset_index(drop=True)

    weather["hdd"] = compute_hdd(weather["temp_weighted"])

    source = weather["source"].astype(str).str.lower()
    forecast = weather[source == "forecast"].copy()
    forecast = forecast[["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])

    history = weather[source == "history"].copy()
    history = history[["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])
    return forecast, history


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
    forecast_end_exclusive = today + pd.Timedelta(days=FORECAST_HORIZON_DAYS)
    logger.info(
        "Global horizon end (exclusive): %s (forecast weather used from %s onward)",
        forecast_end_exclusive.date(),
        today.date(),
    )

    if weather_df is None or gie_df is None:
        weather_df, gie_df = _load_inputs_from_sql()

    weather_forecast, weather_history = _prepare_weather_tables(weather_df)
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
        latest_history_date = latest_row["date"]
        start_inference_date = latest_history_date + pd.Timedelta(days=1)
        end_inference_date = forecast_end_exclusive
        country_inference_dates = pd.date_range(
            start=start_inference_date,
            end=end_inference_date,
            freq="D",
            inclusive="left",
        )
        if country_inference_dates.empty:
            logger.warning(
                "Skipping %s: empty inference window (%s to %s exclusive).",
                country,
                start_inference_date.date(),
                end_inference_date.date(),
            )
            continue
        logger.info(
            "[%s] Inference window: %s -> %s (exclusive, %s days)",
            country,
            start_inference_date.date(),
            end_inference_date.date(),
            len(country_inference_dates),
        )

        if latest_history_date < (today - pd.Timedelta(days=1)):
            logger.warning(
                "Country %s latest stock date is %s (older than yesterday). Using latest available context.",
                country,
                latest_history_date.date(),
            )

        lag_values = gie_country["net_injection"].dropna().tolist()
        lag_pad = lag_values[-1] if lag_values else 0.0
        lag_buffer = _build_fixed_buffer(lag_values, size=7, pad_value=lag_pad)

        weather_history_country = (
            weather_history[weather_history["country"] == country]
            .drop_duplicates(subset=["date"], keep="last")
            .set_index("date")
            .sort_index()
        )
        weather_forecast_country = (
            weather_forecast[weather_forecast["country"] == country]
            .drop_duplicates(subset=["date"], keep="last")
            .set_index("date")
            .sort_index()
        )
        if weather_forecast_country.empty:
            logger.warning("Skipping %s: no forecast weather available.", country)
            continue

        required_history_dates = country_inference_dates[country_inference_dates < today]
        required_forecast_dates = country_inference_dates[country_inference_dates >= today]

        history_slice = pd.DataFrame(columns=["hdd", "wind_weighted"])
        if len(required_history_dates) > 0:
            history_slice = weather_history_country.reindex(required_history_dates)
            if history_slice[["hdd", "wind_weighted"]].isna().any().any():
                logger.warning(
                    "Skipping %s: missing realized weather for nowcast dates %s -> %s.",
                    country,
                    required_history_dates.min().date(),
                    required_history_dates.max().date(),
                )
                continue

        forecast_slice = pd.DataFrame(columns=["hdd", "wind_weighted"])
        if len(required_forecast_dates) > 0:
            forecast_slice = weather_forecast_country.reindex(required_forecast_dates)
            if forecast_slice[["hdd", "wind_weighted"]].isna().any().any():
                logger.warning(
                    "Skipping %s: missing forecast weather for dates %s -> %s.",
                    country,
                    required_forecast_dates.min().date(),
                    required_forecast_dates.max().date(),
                )
                continue

        if country_inference_dates[0] < today:
            first_weather_row = history_slice.loc[country_inference_dates[0]]
        else:
            first_weather_row = forecast_slice.loc[country_inference_dates[0]]
        first_hdd = float(first_weather_row["hdd"])
        first_wind = float(first_weather_row["wind_weighted"])

        history_seed = weather_history_country[weather_history_country.index < today]
        forecast_seed = weather_forecast_country[
            (weather_forecast_country.index >= today) & (weather_forecast_country.index < start_inference_date)
        ]
        weather_seed = pd.concat([history_seed, forecast_seed], axis=0).sort_index()
        weather_seed = weather_seed[weather_seed.index < start_inference_date]

        hdd_values = weather_seed["hdd"].dropna().tolist()
        wind_values = weather_seed["wind_weighted"].dropna().tolist()
        hdd_buffer = _build_fixed_buffer(hdd_values, size=6, pad_value=first_hdd)
        wind_buffer = _build_fixed_buffer(wind_values, size=6, pad_value=first_wind)

        current_stock = latest_stock

        for sim_date in country_inference_dates:
            if sim_date < today:
                weather_today = history_slice.loc[sim_date]
            else:
                weather_today = forecast_slice.loc[sim_date]
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
    logger.info("Saved recursive nowcast + %s-day forecast to %s", FORECAST_HORIZON_DAYS, OUTPUT_PATH)
    logger.info("Output rows: %s", len(forecast_df))


if __name__ == "__main__":
    main()
