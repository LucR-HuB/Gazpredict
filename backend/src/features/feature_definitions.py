import numpy as np
import pandas as pd


def compute_hdd(temp_series: pd.Series, threshold: float = 17) -> pd.Series:
    """Compute Heating Degree Days as max(0, threshold - temp)."""
    return (threshold - temp_series).clip(lower=0)


def compute_rolling_features(
    df: pd.DataFrame,
    col_name: str,
    windows: list[int] = [3, 7],
) -> pd.DataFrame:
    """Add rolling mean features for a column."""
    result = df.copy()
    sort_columns = [column for column in ["country", "date"] if column in result.columns]
    if sort_columns:
        result = result.sort_values(sort_columns)

    if "country" in result.columns:
        grouped = result.groupby("country")[col_name]
        for window in windows:
            result[f"{col_name}_roll_mean_{window}"] = (
                grouped.rolling(window=window, min_periods=window).mean().reset_index(level=0, drop=True)
            )
    else:
        for window in windows:
            result[f"{col_name}_roll_mean_{window}"] = result[col_name].rolling(
                window=window,
                min_periods=window,
            ).mean()

    return result


def compute_lags(
    df: pd.DataFrame,
    col_name: str,
    lags: list[int] = [1, 2],
) -> pd.DataFrame:
    """Add lagged features for a column."""
    result = df.copy()
    sort_columns = [column for column in ["country", "date"] if column in result.columns]
    if sort_columns:
        result = result.sort_values(sort_columns)

    if "country" in result.columns:
        grouped = result.groupby("country")[col_name]
        for lag in lags:
            result[f"{col_name}_lag_{lag}"] = grouped.shift(lag)
    else:
        for lag in lags:
            result[f"{col_name}_lag_{lag}"] = result[col_name].shift(lag)

    return result


def compute_seasonality(date_series: pd.Series) -> pd.DataFrame:
    """Create cyclical day-of-year seasonality features."""
    dates = pd.to_datetime(date_series, errors="coerce")
    day_of_year = dates.dt.dayofyear
    angle = 2 * np.pi * day_of_year / 365.25
    return pd.DataFrame(
        {
            "day_sin": np.sin(angle),
            "day_cos": np.cos(angle),
        },
        index=date_series.index,
    )


def compute_calendar_features(date_series: pd.Series) -> pd.DataFrame:
    """Create basic calendar effects from a date series."""
    dates = pd.to_datetime(date_series, errors="coerce")
    day_of_week = dates.dt.dayofweek
    is_weekend = day_of_week.isin([5, 6]).astype(int)
    return pd.DataFrame(
        {
            "day_of_week": day_of_week,
            "is_weekend": is_weekend,
        },
        index=date_series.index,
    )


def compute_interaction_features(df: pd.DataFrame) -> pd.DataFrame:
    """Create interaction terms between weather and calendar effects."""
    result = df.copy()
    required = ["hdd", "wind_weighted", "is_weekend"]
    missing = [column for column in required if column not in result.columns]
    if missing:
        raise KeyError(f"Missing required columns for interaction features: {missing}")

    result["hdd_wind"] = result["hdd"] * result["wind_weighted"]
    result["cold_weekend"] = result["hdd"] * result["is_weekend"]
    return result


def compute_stock_physics(df: pd.DataFrame) -> pd.DataFrame:
    """
    Build stock-level physics features.

    Notes:
    - Ensures stock_twh exists and fills gaps.
    - If stock_twh_lag_1 is present, it is preferred to avoid leakage.
    - If max_capacity is unavailable, stock_fill_rate falls back to stock level itself.
    """
    result = df.copy()

    if "stock_twh" not in result.columns:
        if "storage_twh" in result.columns:
            result["stock_twh"] = result["storage_twh"]
        elif "stock_twh_lag_1" in result.columns:
            result["stock_twh"] = result["stock_twh_lag_1"]
        else:
            raise KeyError(
                "Expected one of ['stock_twh', 'storage_twh', 'stock_twh_lag_1'] in input dataframe."
            )

    sort_columns = [column for column in ["country", "date"] if column in result.columns]
    if sort_columns:
        result = result.sort_values(sort_columns)

    if result["stock_twh"].isna().any():
        if "country" in result.columns:
            result["stock_twh"] = result.groupby("country")["stock_twh"].ffill().bfill()
        else:
            result["stock_twh"] = result["stock_twh"].ffill().bfill()

    stock_reference_col = "stock_twh_lag_1" if "stock_twh_lag_1" in result.columns else "stock_twh"

    if result[stock_reference_col].isna().any():
        if "country" in result.columns:
            result[stock_reference_col] = result.groupby("country")[stock_reference_col].ffill().bfill()
        else:
            result[stock_reference_col] = result[stock_reference_col].ffill().bfill()

    if "max_capacity" in result.columns:
        safe_capacity = result["max_capacity"].replace(0, np.nan)
        result["stock_fill_rate"] = result[stock_reference_col] / safe_capacity
    else:
        result["stock_fill_rate"] = result[stock_reference_col]

    return result


def compute_target(df: pd.DataFrame) -> pd.DataFrame:
    """Compute net injection as stock_twh - stock_twh_lag_1."""
    result = df.copy()

    if "stock_twh" not in result.columns:
        if "storage_twh" in result.columns:
            result["stock_twh"] = result["storage_twh"]
        else:
            raise KeyError("Expected either 'stock_twh' or 'storage_twh' in input dataframe.")

    if "stock_twh_lag_1" not in result.columns:
        result = compute_lags(result, col_name="stock_twh", lags=[1])

    result["net_injection"] = result["stock_twh"] - result["stock_twh_lag_1"]
    return result
