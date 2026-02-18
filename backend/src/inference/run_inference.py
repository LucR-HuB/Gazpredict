import calendar
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
OUTPUT_PATH = PROJECT_ROOT / "data" / "predictions" / "forecast_hybrid.csv"

FORECAST_HORIZON_DAYS = 14
SIMULATION_END_MONTH = 4
SIMULATION_END_DAY = 30

CLIMATOLOGY_COLUMNS = [
    "hdd_mean",
    "hdd_min",
    "hdd_max",
    "wind_weighted_mean",
    "wind_weighted_min",
    "wind_weighted_max",
]


def _build_fixed_buffer(values: list[float], size: int, pad_value: float) -> deque:
    clean_values = [float(value) for value in values if pd.notna(value)]
    if not clean_values:
        clean_values = [float(pad_value)] * size
    elif len(clean_values) < size:
        clean_values = [clean_values[0]] * (size - len(clean_values)) + clean_values
    else:
        clean_values = clean_values[-size:]
    return deque(clean_values, maxlen=size)


def _prepare_weather_tables(weather_df: pd.DataFrame) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    weather = weather_df.copy()
    weather["date"] = pd.to_datetime(weather["date"], errors="coerce").dt.normalize()
    weather = weather.dropna(subset=["date", "country"]).copy()
    weather["country"] = weather["country"].astype(str)
    weather = weather.sort_values(["country", "date"]).reset_index(drop=True)

    if "hdd" not in weather.columns:
        if "temp_weighted" not in weather.columns:
            raise KeyError("Missing required 'temp_weighted' column in weather data.")
        weather["hdd"] = compute_hdd(weather["temp_weighted"])

    required_weather_cols = ["date", "country", "hdd", "wind_weighted"]
    missing_cols = [col for col in required_weather_cols if col not in weather.columns]
    if missing_cols:
        raise KeyError(f"Missing required weather columns: {missing_cols}")

    if "source" not in weather.columns:
        weather_all = (
            weather[required_weather_cols]
            .drop_duplicates(subset=["country", "date"], keep="last")
            .sort_values(["country", "date"])
            .reset_index(drop=True)
        )
        return weather_all, weather_all.copy(), weather_all.copy()

    weather = weather[required_weather_cols + ["source"]].copy()
    weather["source"] = weather["source"].astype(str).str.lower()

    weather_history = (
        weather[weather["source"] == "history"][required_weather_cols]
        .drop_duplicates(subset=["country", "date"], keep="last")
        .sort_values(["country", "date"])
        .reset_index(drop=True)
    )
    weather_forecast = (
        weather[weather["source"] == "forecast"][required_weather_cols]
        .drop_duplicates(subset=["country", "date"], keep="last")
        .sort_values(["country", "date"])
        .reset_index(drop=True)
    )

    source_rank = {"history": 0, "forecast": 1}
    weather["source_rank"] = weather["source"].map(source_rank).fillna(2)
    weather_all = (
        weather.sort_values(["country", "date", "source_rank"])
        .drop_duplicates(subset=["country", "date"], keep="first")[required_weather_cols]
        .sort_values(["country", "date"])
        .reset_index(drop=True)
    )

    if weather_history.empty:
        weather_history = weather_all.copy()

    return weather_all, weather_forecast, weather_history


def _build_climatology(weather_df: pd.DataFrame) -> pd.DataFrame:
    weather = weather_df.copy()
    weather["date"] = pd.to_datetime(weather["date"], errors="coerce").dt.normalize()
    weather = weather.dropna(subset=["date"]).copy()

    if "source" in weather.columns:
        weather = weather[weather["source"].astype(str).str.lower() == "history"].copy()

    if weather.empty:
        raise RuntimeError("No historical weather rows available for climatology.")

    if "hdd" not in weather.columns:
        if "temp_weighted" not in weather.columns:
            raise KeyError("Missing required 'temp_weighted' column to compute climatology HDD.")
        weather["hdd"] = compute_hdd(weather["temp_weighted"])

    if "wind_weighted" not in weather.columns:
        raise KeyError("Missing required 'wind_weighted' column to compute climatology.")

    weather = weather.dropna(subset=["hdd", "wind_weighted"]).copy()
    if weather.empty:
        raise RuntimeError("No valid HDD/wind weather rows available for climatology.")

    dedupe_keys = ["date"]
    if "country" in weather.columns:
        dedupe_keys = ["country", "date"]
    weather = weather.drop_duplicates(subset=dedupe_keys, keep="last")

    weather["year"] = weather["date"].dt.year.astype(int)
    current_year = pd.Timestamp.today().year
    weather = weather[weather["year"] < current_year].copy()
    if weather.empty:
        raise RuntimeError("No past years available to build climatology.")

    yearly_coverage = weather.groupby("year")["date"].nunique().rename("n_days").reset_index()
    yearly_coverage["expected_days"] = yearly_coverage["year"].map(
        lambda year: 366 if calendar.isleap(int(year)) else 365
    )
    full_years = yearly_coverage[
        yearly_coverage["n_days"] >= yearly_coverage["expected_days"]
    ]["year"].tolist()

    weather = weather[weather["year"].isin(full_years)].copy()
    if weather.empty:
        raise RuntimeError("No complete past years found to build climatology.")

    weather["mm_dd"] = weather["date"].dt.strftime("%m-%d")
    climatology = (
        weather.groupby("mm_dd", as_index=True)
        .agg(
            hdd_mean=("hdd", "mean"),
            hdd_min=("hdd", "min"),
            hdd_max=("hdd", "max"),
            wind_weighted_mean=("wind_weighted", "mean"),
            wind_weighted_min=("wind_weighted", "min"),
            wind_weighted_max=("wind_weighted", "max"),
        )
        .sort_index()
    )
    if climatology.empty:
        raise RuntimeError("Climatology computation produced no rows.")
    return climatology


def _prepare_gie_table(gie_df: pd.DataFrame) -> pd.DataFrame:
    gie = gie_df.copy()
    gie["date"] = pd.to_datetime(gie["date"], errors="coerce").dt.normalize()
    gie = gie.dropna(subset=["date", "country"]).copy()
    gie["country"] = gie["country"].astype(str)
    gie = gie.sort_values(["country", "date"]).reset_index(drop=True)
    gie = gie.rename(columns={"storage_twh": "stock_twh"})

    if "stock_twh" not in gie.columns:
        raise KeyError("Missing required 'storage_twh' column in GIE data.")

    gie["stock_twh"] = pd.to_numeric(gie["stock_twh"], errors="coerce")
    gie = gie.dropna(subset=["stock_twh"]).copy()
    if gie.empty:
        raise RuntimeError("No valid GIE stock rows available after cleaning.")

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


def _lookup_climatology_row(climatology_by_day: pd.DataFrame, sim_date: pd.Timestamp) -> pd.Series:
    day_key = sim_date.strftime("%m-%d")
    if day_key == "02-29" and day_key not in climatology_by_day.index:
        day_key = "02-28"

    if day_key in climatology_by_day.index:
        row = climatology_by_day.loc[day_key]
        if isinstance(row, pd.DataFrame):
            return row.iloc[0]
        return row

    return climatology_by_day.mean(numeric_only=True)


def _predict_next_step(
    model: XGBRegressor,
    model_features: list[str],
    country: str,
    sim_date: pd.Timestamp,
    hdd_today: float,
    wind_today: float,
    current_stock: float,
    lag_buffer: deque,
    hdd_buffer: deque,
    wind_buffer: deque,
) -> tuple[float, float]:
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
    next_stock = current_stock + pred_injection

    lag_buffer.append(pred_injection)
    hdd_buffer.append(hdd_today)
    wind_buffer.append(wind_today)

    return pred_injection, next_stock


def _resolve_simulation_end_date(today: pd.Timestamp) -> pd.Timestamp:
    this_year_end = pd.Timestamp(
        year=today.year,
        month=SIMULATION_END_MONTH,
        day=SIMULATION_END_DAY,
    )
    if today <= this_year_end:
        return this_year_end
    return pd.Timestamp(
        year=today.year + 1,
        month=SIMULATION_END_MONTH,
        day=SIMULATION_END_DAY,
    )


def _build_country_weather_index(weather_df: pd.DataFrame, country: str) -> pd.DataFrame:
    if weather_df.empty:
        return pd.DataFrame(columns=["hdd", "wind_weighted"])

    weather_country = weather_df[weather_df["country"] == country].copy()
    if weather_country.empty:
        return pd.DataFrame(columns=["hdd", "wind_weighted"])

    weather_country = (
        weather_country.drop_duplicates(subset=["date"], keep="last")
        .set_index("date")
        .sort_index()
    )
    return weather_country


def run_recursive_forecast(
    weather_df: pd.DataFrame | None = None,
    gie_df: pd.DataFrame | None = None,
) -> pd.DataFrame:
    logger = logging.getLogger("run_inference")
    model, model_features = _load_artifacts()

    if weather_df is None or gie_df is None:
        weather_df, gie_df = _load_inputs_from_sql()

    weather_all, weather_forecast, weather_history = _prepare_weather_tables(weather_df)
    climatology = _build_climatology(weather_history)
    gie = _prepare_gie_table(gie_df)

    today = pd.Timestamp.today().normalize()
    forecast_end_date = today + pd.Timedelta(days=FORECAST_HORIZON_DAYS)
    simulation_end_date = _resolve_simulation_end_date(today)

    logger.info(
        "Global windows | today=%s | forecast_end=%s | simulation_end=%s",
        today.date(),
        forecast_end_date.date(),
        simulation_end_date.date(),
    )

    trained_countries = sorted(
        feature_name.replace("country_", "")
        for feature_name in model_features
        if feature_name.startswith("country_")
    )
    if not trained_countries:
        trained_countries = sorted(gie["country"].unique())

    results: list[dict[str, object]] = []

    for country in trained_countries:
        gie_country = gie[gie["country"] == country].sort_values("date").copy()
        if gie_country.empty:
            logger.warning("Skipping %s: no GIE history available.", country)
            continue

        latest_row = gie_country.iloc[-1]
        last_gie_date = pd.Timestamp(latest_row["date"]).normalize()
        start_date = last_gie_date + pd.Timedelta(days=1)

        if start_date > simulation_end_date:
            logger.info(
                "Skipping %s: start_date=%s is after simulation_end=%s.",
                country,
                start_date.date(),
                simulation_end_date.date(),
            )
            continue

        sim_dates = pd.date_range(start=start_date, end=simulation_end_date, freq="D")
        if sim_dates.empty:
            logger.warning("Skipping %s: empty simulation date range.", country)
            continue

        weather_all_country = _build_country_weather_index(weather_all, country)
        weather_forecast_country = _build_country_weather_index(weather_forecast, country)

        nowcast_dates = sim_dates[sim_dates < today]
        tactical_dates = sim_dates[(sim_dates >= today) & (sim_dates <= forecast_end_date)]

        nowcast_slice = pd.DataFrame(columns=["hdd", "wind_weighted"])
        if len(nowcast_dates) > 0:
            nowcast_slice = weather_all_country.reindex(nowcast_dates)
            if nowcast_slice[["hdd", "wind_weighted"]].isna().any().any():
                logger.warning(
                    "Skipping %s: missing realized weather for nowcast dates %s -> %s.",
                    country,
                    nowcast_dates.min().date(),
                    nowcast_dates.max().date(),
                )
                continue

        tactical_slice = pd.DataFrame(columns=["hdd", "wind_weighted"])
        if len(tactical_dates) > 0:
            if weather_forecast_country.empty:
                logger.warning("Skipping %s: no forecast weather rows available.", country)
                continue
            tactical_slice = weather_forecast_country.reindex(tactical_dates)
            if tactical_slice[["hdd", "wind_weighted"]].isna().any().any():
                logger.warning(
                    "Skipping %s: missing forecast weather for dates %s -> %s.",
                    country,
                    tactical_dates.min().date(),
                    tactical_dates.max().date(),
                )
                continue

        climatology_seed = _lookup_climatology_row(climatology, sim_dates[0])
        hdd_pad = float(climatology_seed["hdd_mean"])
        wind_pad = float(climatology_seed["wind_weighted_mean"])

        weather_seed = weather_all_country[weather_all_country.index < start_date]
        hdd_values = weather_seed["hdd"].dropna().tolist() if not weather_seed.empty else []
        wind_values = (
            weather_seed["wind_weighted"].dropna().tolist()
            if not weather_seed.empty
            else []
        )

        lag_values = gie_country["net_injection"].dropna().tolist()
        lag_pad = lag_values[-1] if lag_values else 0.0

        last_gie_value = float(latest_row["stock_twh"])
        current_stocks = {
            "forecast": last_gie_value,
            "normal": last_gie_value,
            "cold": last_gie_value,
            "warm": last_gie_value,
        }
        lag_buffers = {
            scenario_key: _build_fixed_buffer(lag_values, size=7, pad_value=lag_pad)
            for scenario_key in current_stocks
        }
        hdd_buffers = {
            scenario_key: _build_fixed_buffer(hdd_values, size=6, pad_value=hdd_pad)
            for scenario_key in current_stocks
        }
        wind_buffers = {
            scenario_key: _build_fixed_buffer(wind_values, size=6, pad_value=wind_pad)
            for scenario_key in current_stocks
        }

        logger.info(
            "[%s] Last GIE=%s | start=%s | forecast_end=%s | simulation_end=%s | days=%s",
            country,
            last_gie_date.date(),
            start_date.date(),
            forecast_end_date.date(),
            simulation_end_date.date(),
            len(sim_dates),
        )

        for sim_date in sim_dates:
            scenario_payloads: list[tuple[str, str, float, float]] = []

            if sim_date < today:
                weather_today = nowcast_slice.loc[sim_date]
                scenario_payloads.append(
                    (
                        "forecast",
                        "actuel",
                        float(weather_today["hdd"]),
                        float(weather_today["wind_weighted"]),
                    )
                )
            elif sim_date <= forecast_end_date:
                weather_today = tactical_slice.loc[sim_date]
                scenario_payloads.append(
                    (
                        "forecast",
                        "forecast",
                        float(weather_today["hdd"]),
                        float(weather_today["wind_weighted"]),
                    )
                )
            else:
                climatology_row = _lookup_climatology_row(climatology, sim_date)
                scenario_payloads.extend(
                    [
                        (
                            "normal",
                            "scenario_normal",
                            float(climatology_row["hdd_mean"]),
                            float(climatology_row["wind_weighted_mean"]),
                        ),
                        (
                            "cold",
                            "scenario_cold",
                            float(climatology_row["hdd_max"]),
                            float(climatology_row["wind_weighted_max"]),
                        ),
                        (
                            "warm",
                            "scenario_warm",
                            float(climatology_row["hdd_min"]),
                            float(climatology_row["wind_weighted_min"]),
                        ),
                    ]
                )

            for scenario_key, scenario_name, hdd_today, wind_today in scenario_payloads:
                pred_injection, next_stock = _predict_next_step(
                    model=model,
                    model_features=model_features,
                    country=country,
                    sim_date=sim_date,
                    hdd_today=hdd_today,
                    wind_today=wind_today,
                    current_stock=float(current_stocks[scenario_key]),
                    lag_buffer=lag_buffers[scenario_key],
                    hdd_buffer=hdd_buffers[scenario_key],
                    wind_buffer=wind_buffers[scenario_key],
                )
                current_stocks[scenario_key] = next_stock
                results.append(
                    {
                        "date": sim_date,
                        "country": country,
                        "scenario": scenario_name,
                        "stock_twh": next_stock,
                        "net_injection": pred_injection,
                    }
                )

            if today <= sim_date <= forecast_end_date:
                for scenario_key in ("normal", "cold", "warm"):
                    current_stocks[scenario_key] = float(current_stocks["forecast"])
                    lag_buffers[scenario_key] = deque(
                        lag_buffers["forecast"],
                        maxlen=lag_buffers["forecast"].maxlen,
                    )
                    hdd_buffers[scenario_key] = deque(
                        hdd_buffers["forecast"],
                        maxlen=hdd_buffers["forecast"].maxlen,
                    )
                    wind_buffers[scenario_key] = deque(
                        wind_buffers["forecast"],
                        maxlen=wind_buffers["forecast"].maxlen,
                    )

    if not results:
        raise RuntimeError("No forecasts were produced. Check weather and context data availability.")

    forecast_df = pd.DataFrame(results)
    forecast_df["date"] = pd.to_datetime(forecast_df["date"], errors="coerce")
    forecast_df = forecast_df.sort_values(["country", "date", "scenario"]).reset_index(drop=True)
    forecast_df["date"] = forecast_df["date"].dt.strftime("%Y-%m-%d")
    forecast_df = forecast_df[["date", "country", "scenario", "stock_twh", "net_injection"]]
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
    logger.info("Saved hybrid recursive forecast to %s", OUTPUT_PATH)
    logger.info("Output rows: %s", len(forecast_df))


if __name__ == "__main__":
    main()
