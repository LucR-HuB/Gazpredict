import logging
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from sqlmodel import create_engine, select

try:
    from .feature_definitions import (
        compute_calendar_features,
        compute_hdd,
        compute_interaction_features,
        compute_lags,
        compute_rolling_features,
        compute_seasonality,
        compute_stock_physics,
        compute_target,
    )
except ImportError:
    from feature_definitions import (
        compute_calendar_features,
        compute_hdd,
        compute_interaction_features,
        compute_lags,
        compute_rolling_features,
        compute_seasonality,
        compute_stock_physics,
        compute_target,
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
OUTPUT_PATH = PROJECT_ROOT / "data" / "processed" / "dataset_v2_featured.csv"

MERGE_KEYS = ["date", "country"]
WEATHER_FEATURE_COLUMNS = ["temp_weighted", "wind_weighted"]


def _prepare_weather(weather_df: pd.DataFrame) -> pd.DataFrame:
    """Keep one weather row per date/country and prioritize historical observations."""
    weather = weather_df.copy()

    if "source" in weather.columns:
        source_order = {"history": 0, "forecast": 1}
        weather["source_rank"] = weather["source"].map(source_order).fillna(2)
        weather = weather.sort_values(["country", "date", "source_rank"])
        weather = weather.drop_duplicates(subset=MERGE_KEYS, keep="first")
        weather = weather.drop(columns=["source_rank"])
    else:
        weather = weather.drop_duplicates(subset=MERGE_KEYS, keep="last")

    columns_to_keep = MERGE_KEYS + WEATHER_FEATURE_COLUMNS
    return weather[columns_to_keep]


def build_feature_dataset() -> pd.DataFrame:
    # Step A: Load raw data.
    query_gie = select(GieData)
    gas_df = pd.read_sql(query_gie, engine)

    query_weather = select(WeatherData)
    weather_df = pd.read_sql(query_weather, engine)

    gas_df["date"] = pd.to_datetime(gas_df["date"], errors="coerce")
    weather_df["date"] = pd.to_datetime(weather_df["date"], errors="coerce")

    gas_df = gas_df.dropna(subset=MERGE_KEYS).copy()
    weather_df = weather_df.dropna(subset=MERGE_KEYS).copy()

    gas_df["country"] = gas_df["country"].astype(str)
    weather_df["country"] = weather_df["country"].astype(str)

    gas_df = gas_df.sort_values(["country", "date"]).reset_index(drop=True)
    weather_df = _prepare_weather(weather_df).sort_values(["country", "date"]).reset_index(drop=True)

    merged = pd.merge(gas_df, weather_df, on=MERGE_KEYS, how="left")
    merged = merged.sort_values(["country", "date"]).reset_index(drop=True)

    # Handle potential weather gaps for older gas dates.
    for column in WEATHER_FEATURE_COLUMNS:
        merged[column] = merged.groupby("country")[column].ffill()

    # Step B: Base features.
    dataset = compute_target(merged)
    dataset["hdd"] = compute_hdd(dataset["temp_weighted"])
    dataset[["day_sin", "day_cos"]] = compute_seasonality(dataset["date"])

    # Step C: New V2 features.
    dataset[["day_of_week", "is_weekend"]] = compute_calendar_features(dataset["date"])
    dataset = compute_lags(dataset, col_name="stock_twh", lags=[1])
    dataset = compute_stock_physics(dataset)
    dataset = compute_interaction_features(dataset)

    # Step D: Inertia features.
    dataset = compute_lags(dataset, col_name="net_injection", lags=[1, 7])
    dataset = compute_rolling_features(dataset, col_name="hdd", windows=[7])
    dataset = compute_rolling_features(dataset, col_name="wind_weighted", windows=[7])
    dataset = dataset.rename(columns={"wind_weighted_roll_mean_7": "wind_roll_mean_7"})

    final_columns = [
        "date",
        "country",
        "net_injection",
        "hdd",
        "wind_weighted",
        "day_sin",
        "day_cos",
        "day_of_week",
        "is_weekend",
        "stock_twh_lag_1",
        "stock_fill_rate",
        "hdd_wind",
        "cold_weekend",
        "net_injection_lag_1",
        "net_injection_lag_7",
        "hdd_roll_mean_7",
        "wind_roll_mean_7",
    ]
    missing_columns = [column for column in final_columns if column not in dataset.columns]
    if missing_columns:
        raise KeyError(f"Missing final feature columns: {missing_columns}")

    # Step E: Clean & save-ready dataset.
    dataset = dataset[final_columns].copy()

    before_clean_shape = dataset.shape
    dataset = dataset.replace([np.inf, -np.inf], np.nan)
    dataset = dataset.dropna().copy()
    dataset = dataset.sort_values(["country", "date"]).reset_index(drop=True)
    dataset["date"] = dataset["date"].dt.strftime("%Y-%m-%d")
    after_clean_shape = dataset.shape

    logger = logging.getLogger("build_features")
    logger.info("Dataset shape before cleaning: %s", before_clean_shape)
    logger.info("Dataset shape after cleaning: %s", after_clean_shape)

    return dataset


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )

    dataset = build_feature_dataset()
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    dataset.to_csv(OUTPUT_PATH, index=False)
    logging.getLogger("build_features").info("Feature dataset saved to %s", OUTPUT_PATH)


if __name__ == "__main__":
    main()
