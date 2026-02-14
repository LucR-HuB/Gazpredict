import json
import subprocess
import sys
from collections import deque
from datetime import date
from pathlib import Path

import numpy as np
import pandas as pd
import plotly.express as px
import plotly.graph_objects as go
import streamlit as st
from xgboost import XGBRegressor


st.set_page_config(page_title="GasGuardian Dashboard", layout="wide")


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.append(str(PROJECT_ROOT))

from backend.src.features.feature_definitions import (  # noqa: E402
    compute_calendar_features,
    compute_hdd,
    compute_stock_physics,
)


HISTORY_PATH = PROJECT_ROOT / "data" / "raw" / "gie_history.csv"
FORECAST_PATH = PROJECT_ROOT / "data" / "predictions" / "forecast_14d.csv"
WEATHER_PATH = PROJECT_ROOT / "data" / "raw" / "weather_daily.csv"
MODEL_PATH = PROJECT_ROOT / "data" / "models" / "xgb_gas_v1.json"
MODEL_FEATURES_PATH = PROJECT_ROOT / "data" / "models" / "model_features.json"
PIPELINE_PATH = PROJECT_ROOT / "backend" / "src" / "pipeline" / "run_pipeline.py"

FORECAST_HORIZON_DAYS = 14
HDD_THRESHOLD = 17.0
WITHDRAWAL_ALERT_THRESHOLD_DAY = -0.5
WITHDRAWAL_ALERT_THRESHOLD_14D_DEFAULT = 5.0


def _build_fixed_buffer(values: list[float], size: int, pad_value: float) -> deque:
    clean_values = [float(value) for value in values if pd.notna(value)]
    if not clean_values:
        clean_values = [float(pad_value)] * size
    elif len(clean_values) < size:
        clean_values = [clean_values[0]] * (size - len(clean_values)) + clean_values
    else:
        clean_values = clean_values[-size:]
    return deque(clean_values, maxlen=size)


@st.cache_data(show_spinner=False)
def load_history(path: Path) -> pd.DataFrame:
    history = pd.read_csv(path, parse_dates=["date"])
    if "stock_twh" not in history.columns and "storage_twh" in history.columns:
        history = history.rename(columns={"storage_twh": "stock_twh"})

    required = {"date", "country", "stock_twh"}
    missing = required - set(history.columns)
    if missing:
        raise KeyError(f"Missing required history columns: {sorted(missing)}")

    history["country"] = history["country"].astype(str)
    history["stock_twh"] = pd.to_numeric(history["stock_twh"], errors="coerce")
    history["fill_pct"] = pd.to_numeric(history.get("fill_pct"), errors="coerce")
    history = history.dropna(subset=["date", "country", "stock_twh"]).copy()
    history = history.sort_values(["country", "date"]).reset_index(drop=True)
    history["net_injection"] = history.groupby("country")["stock_twh"].diff()
    return history[["date", "country", "stock_twh", "fill_pct", "net_injection"]]


@st.cache_data(show_spinner=False)
def load_forecast(path: Path) -> pd.DataFrame:
    forecast = pd.read_csv(path, parse_dates=["date"])
    if "net_injection_pred" not in forecast.columns and "net_injection" in forecast.columns:
        forecast = forecast.rename(columns={"net_injection": "net_injection_pred"})
    if "stock_twh_simulated" not in forecast.columns and "stock_twh" in forecast.columns:
        forecast = forecast.rename(columns={"stock_twh": "stock_twh_simulated"})

    required = {"date", "country", "net_injection_pred", "stock_twh_simulated"}
    missing = required - set(forecast.columns)
    if missing:
        raise KeyError(f"Missing required forecast columns: {sorted(missing)}")

    forecast["country"] = forecast["country"].astype(str)
    forecast["net_injection_pred"] = pd.to_numeric(forecast["net_injection_pred"], errors="coerce")
    forecast["stock_twh_simulated"] = pd.to_numeric(forecast["stock_twh_simulated"], errors="coerce")
    forecast = forecast.dropna(subset=["date", "country", "net_injection_pred", "stock_twh_simulated"]).copy()
    forecast = forecast.sort_values(["country", "date"]).reset_index(drop=True)
    return forecast[["date", "country", "net_injection_pred", "stock_twh_simulated"]]


@st.cache_data(show_spinner=False)
def load_weather(path: Path) -> pd.DataFrame:
    weather = pd.read_csv(path, parse_dates=["date"])
    required = {"date", "country", "temp_weighted", "wind_weighted"}
    missing = required - set(weather.columns)
    if missing:
        raise KeyError(f"Missing required weather columns: {sorted(missing)}")

    weather["country"] = weather["country"].astype(str)
    weather["temp_weighted"] = pd.to_numeric(weather["temp_weighted"], errors="coerce")
    weather["wind_weighted"] = pd.to_numeric(weather["wind_weighted"], errors="coerce")
    if "source" not in weather.columns:
        weather["source"] = "forecast"
    weather["source"] = weather["source"].astype(str).str.lower()
    weather = weather.dropna(subset=["date", "country", "temp_weighted", "wind_weighted"]).copy()
    weather = weather.sort_values(["country", "date"]).drop_duplicates(["date", "country", "source"], keep="last")
    return weather[["date", "country", "temp_weighted", "wind_weighted", "source"]]


@st.cache_resource(show_spinner=False)
def load_model_artifacts(model_path: Path, model_features_path: Path) -> tuple[XGBRegressor, list[str]]:
    if not model_path.exists():
        raise FileNotFoundError(f"Model artifact not found: {model_path}")
    if not model_features_path.exists():
        raise FileNotFoundError(f"Model features artifact not found: {model_features_path}")

    model = XGBRegressor()
    model.load_model(model_path)

    model_features = json.loads(model_features_path.read_text())
    if not isinstance(model_features, list) or not model_features:
        raise ValueError("model_features.json must contain a non-empty list of feature names.")
    return model, model_features


def check_gaps(df: pd.DataFrame, date_col: str = "date") -> list[date]:
    if date_col not in df.columns:
        raise KeyError(f"Missing required date column: {date_col}")

    dates = pd.to_datetime(df[date_col], errors="coerce").dropna().dt.normalize()
    if dates.empty:
        return []

    min_date = dates.min()
    max_date = dates.max()
    expected_dates = pd.date_range(start=min_date, end=max_date, freq="D")
    observed_dates = pd.DatetimeIndex(dates.unique()).sort_values()
    missing_dates = expected_dates.difference(observed_dates)
    return [missing_date.date() for missing_date in missing_dates]


@st.cache_data(show_spinner=False)
def load_monitor_dataset(path: Path) -> pd.DataFrame:
    return pd.read_csv(path)


def resolve_forecast_dates(weather_df: pd.DataFrame, horizon_days: int) -> pd.DatetimeIndex:
    weather_forecast = weather_df[weather_df["source"] == "forecast"].copy()
    if weather_forecast.empty:
        raise RuntimeError("No weather rows with source='forecast' found.")

    weather_forecast = weather_forecast.sort_values("date")
    today = pd.Timestamp.today().normalize()
    start_date = weather_forecast.loc[weather_forecast["date"] >= today, "date"].min()
    if pd.isna(start_date):
        start_date = weather_forecast["date"].min()
    return pd.date_range(start=pd.Timestamp(start_date).normalize(), periods=horizon_days, freq="D")


def run_recursive_forecast_with_temp_shock(
    history_df: pd.DataFrame,
    weather_df: pd.DataFrame,
    temp_shock_c: float,
    horizon_days: int = FORECAST_HORIZON_DAYS,
) -> pd.DataFrame:
    model, model_features = load_model_artifacts(MODEL_PATH, MODEL_FEATURES_PATH)

    gie = history_df.copy()
    gie = gie.sort_values(["country", "date"]).reset_index(drop=True)
    if "net_injection" not in gie.columns:
        gie["net_injection"] = gie.groupby("country")["stock_twh"].diff()

    forecast_dates = resolve_forecast_dates(weather_df, horizon_days=horizon_days)
    start_date = forecast_dates.min()

    weather = weather_df.copy()
    weather = weather.sort_values(["country", "date"]).reset_index(drop=True)

    weather["temp_adjusted"] = weather["temp_weighted"]
    forecast_mask = (
        (weather["source"] == "forecast")
        & (weather["date"] >= start_date)
        & (weather["date"] <= forecast_dates.max())
    )
    if abs(temp_shock_c) > 0:
        weather.loc[forecast_mask, "temp_adjusted"] = weather.loc[forecast_mask, "temp_adjusted"] + float(temp_shock_c)

    weather["hdd"] = compute_hdd(weather["temp_adjusted"], threshold=HDD_THRESHOLD)
    weather_forecast = weather[
        (weather["source"] == "forecast") & (weather["date"] >= start_date)
    ][["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])
    weather_all = weather[["date", "country", "hdd", "wind_weighted"]].sort_values(["country", "date"])

    trained_countries = sorted(
        feature_name.replace("country_", "")
        for feature_name in model_features
        if feature_name.startswith("country_")
    )
    if not trained_countries:
        trained_countries = sorted(gie["country"].unique().tolist())

    results: list[dict] = []
    for country in trained_countries:
        gie_country = gie[gie["country"] == country].sort_values("date").copy()
        if gie_country.empty:
            continue

        latest_row = gie_country.iloc[-1]
        current_stock = float(latest_row["stock_twh"])

        lag_values = gie_country["net_injection"].dropna().tolist()
        lag_pad = lag_values[-1] if lag_values else 0.0
        lag_buffer = _build_fixed_buffer(lag_values, size=7, pad_value=lag_pad)

        weather_history_country = weather_all[
            (weather_all["country"] == country) & (weather_all["date"] < start_date)
        ].sort_values("date")

        weather_forecast_country = weather_forecast[weather_forecast["country"] == country].set_index("date")
        if weather_forecast_country.empty:
            continue

        weather_forecast_country = weather_forecast_country.reindex(forecast_dates).ffill().bfill()
        if weather_forecast_country[["hdd", "wind_weighted"]].isna().any().any():
            continue

        first_hdd = float(weather_forecast_country.iloc[0]["hdd"])
        first_wind = float(weather_forecast_country.iloc[0]["wind_weighted"])

        hdd_values = weather_history_country["hdd"].dropna().tolist()
        wind_values = weather_history_country["wind_weighted"].dropna().tolist()
        hdd_buffer = _build_fixed_buffer(hdd_values, size=6, pad_value=first_hdd)
        wind_buffer = _build_fixed_buffer(wind_values, size=6, pad_value=first_wind)

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
                    "date": pd.Timestamp(sim_date),
                    "country": country,
                    "net_injection_pred": pred_injection,
                    "stock_twh_simulated": current_stock,
                }
            )

    if not results:
        raise RuntimeError("No forecasts were produced in live simulation.")

    scenario_df = pd.DataFrame(results).sort_values(["country", "date"]).reset_index(drop=True)
    scenario_df["scenario"] = "shock" if abs(temp_shock_c) > 0 else "base_live"
    scenario_df["temp_shock_c"] = float(temp_shock_c)
    return scenario_df


def build_country_forecast_table(
    forecast_df: pd.DataFrame,
    weather_df: pd.DataFrame,
    country: str,
    temp_shock_c: float,
) -> pd.DataFrame:
    table = forecast_df[forecast_df["country"] == country][["date", "country", "net_injection_pred", "stock_twh_simulated"]].copy()
    if table.empty:
        return pd.DataFrame(columns=["Date", "HDD", "Net Inj (TWh/day)", "Stock (TWh)"])

    weather_forecast = weather_df[
        (weather_df["country"] == country) & (weather_df["source"] == "forecast")
    ][["date", "country", "temp_weighted"]].copy()
    if not weather_forecast.empty:
        weather_forecast["temp_adjusted"] = weather_forecast["temp_weighted"] + float(temp_shock_c)
        weather_forecast["hdd"] = compute_hdd(weather_forecast["temp_adjusted"], threshold=HDD_THRESHOLD)
        table = table.merge(weather_forecast[["date", "country", "hdd"]], on=["date", "country"], how="left")
    else:
        table["hdd"] = pd.NA

    table = table.sort_values("date")
    table = table.rename(
        columns={
            "date": "Date",
            "hdd": "HDD",
            "net_injection_pred": "Net Inj (TWh/day)",
            "stock_twh_simulated": "Stock (TWh)",
        }
    )
    table["Date"] = pd.to_datetime(table["Date"], errors="coerce").dt.date
    table["HDD"] = pd.to_numeric(table["HDD"], errors="coerce").round(2)
    table["Net Inj (TWh/day)"] = pd.to_numeric(table["Net Inj (TWh/day)"], errors="coerce").round(3)
    table["Stock (TWh)"] = pd.to_numeric(table["Stock (TWh)"], errors="coerce").round(3)
    return table[["Date", "HDD", "Net Inj (TWh/day)", "Stock (TWh)"]]


def build_overview_table(
    history_df: pd.DataFrame,
    forecast_df: pd.DataFrame,
    high_withdrawal_threshold_14d: float,
) -> pd.DataFrame:
    latest_history = history_df.sort_values(["country", "date"]).groupby("country", as_index=False).last()
    capacity_by_country = history_df.groupby("country", as_index=False)["stock_twh"].max().rename(
        columns={"stock_twh": "capacity_proxy_twh"}
    )
    latest_history = latest_history.merge(capacity_by_country, on="country", how="left")

    latest_history["stock_pct"] = latest_history["fill_pct"]
    missing_pct_mask = latest_history["stock_pct"].isna() & latest_history["capacity_proxy_twh"].gt(0)
    latest_history.loc[missing_pct_mask, "stock_pct"] = (
        100.0
        * latest_history.loc[missing_pct_mask, "stock_twh"]
        / latest_history.loc[missing_pct_mask, "capacity_proxy_twh"]
    )

    forecast_agg = forecast_df.sort_values(["country", "date"]).groupby("country", as_index=False).agg(
        forecasted_injection_14d_sum=("net_injection_pred", "sum"),
        forecasted_stock_j14=("stock_twh_simulated", "last"),
    )

    overview = latest_history.merge(forecast_agg, on="country", how="outer")
    overview["trend_icon"] = np.where(
        overview["forecasted_stock_j14"].ge(overview["stock_twh"]),
        "📈",
        "📉",
    )
    overview.loc[overview["forecasted_stock_j14"].isna(), "trend_icon"] = "N/A"

    overview["alert_stock_low"] = overview["stock_pct"].lt(10).fillna(False)
    overview["alert_withdrawal_high"] = overview["forecasted_injection_14d_sum"].lt(
        -float(high_withdrawal_threshold_14d)
    ).fillna(False)
    overview["alert"] = overview["alert_stock_low"] | overview["alert_withdrawal_high"]

    overview["status"] = np.select(
        [
            overview["alert"],
            overview["forecasted_injection_14d_sum"].lt(0).fillna(False),
        ],
        [
            "Alert",
            "Watch",
        ],
        default="Stable",
    )

    overview_display = overview[
        [
            "country",
            "stock_twh",
            "stock_pct",
            "forecasted_injection_14d_sum",
            "trend_icon",
            "status",
            "alert",
        ]
    ].copy()
    overview_display = overview_display.rename(
        columns={
            "country": "Country",
            "stock_twh": "Current Stock (TWh)",
            "stock_pct": "Stock (%)",
            "forecasted_injection_14d_sum": "Forecasted Injection (14d Sum)",
            "trend_icon": "Trend",
            "status": "Status",
            "alert": "Alert",
        }
    )
    overview_display["Current Stock (TWh)"] = pd.to_numeric(
        overview_display["Current Stock (TWh)"], errors="coerce"
    ).round(2)
    overview_display["Stock (%)"] = pd.to_numeric(overview_display["Stock (%)"], errors="coerce").round(1)
    overview_display["Forecasted Injection (14d Sum)"] = pd.to_numeric(
        overview_display["Forecasted Injection (14d Sum)"], errors="coerce"
    ).round(2)
    overview_display = overview_display.sort_values("Country").reset_index(drop=True)
    return overview_display


def build_unified_transition_df(history_df: pd.DataFrame, forecast_df: pd.DataFrame) -> pd.DataFrame:
    actual = history_df[["date", "country", "net_injection", "stock_twh"]].copy()
    actual["Type"] = "Actual"

    forecast = forecast_df[["date", "country", "net_injection_pred", "stock_twh_simulated"]].copy()
    forecast = forecast.rename(
        columns={
            "net_injection_pred": "net_injection",
            "stock_twh_simulated": "stock_twh",
        }
    )
    forecast["Type"] = "Forecast"

    unified = pd.concat([actual, forecast], ignore_index=True)
    unified["_type_order"] = unified["Type"].map({"Actual": 0, "Forecast": 1}).fillna(9)
    unified = unified.sort_values(["country", "date", "_type_order"]).drop(columns="_type_order")
    return unified.reset_index(drop=True)


def render_overview_card(title: str, value: str, subtitle: str, tone: str = "neutral") -> None:
    tone_map = {
        "neutral": "#1F2937",
        "good": "#166534",
        "warn": "#9A3412",
        "danger": "#991B1B",
        "info": "#0F766E",
    }
    accent = tone_map.get(tone, tone_map["neutral"])
    st.markdown(
        (
            "<div style='border:1px solid #E5E7EB;border-radius:14px;padding:14px 16px;background:linear-gradient(135deg,#FFFFFF,#F8FAFC);'>"
            f"<div style='font-size:13px;color:#6B7280;'>{title}</div>"
            f"<div style='font-size:30px;font-weight:700;line-height:1.2;color:{accent};margin-top:2px;'>{value}</div>"
            f"<div style='font-size:12px;color:#6B7280;margin-top:4px;'>{subtitle}</div>"
            "</div>"
        ),
        unsafe_allow_html=True,
    )


def get_file_heartbeat(path: Path, now_ts: pd.Timestamp) -> dict[str, object]:
    if not path.exists():
        return {
            "exists": False,
            "path": str(path),
            "is_stale": True,
            "last_updated": None,
            "age_hours": None,
        }

    modified_ts = pd.Timestamp.fromtimestamp(path.stat().st_mtime)
    age_hours = float((now_ts - modified_ts).total_seconds() / 3600.0)
    return {
        "exists": True,
        "path": str(path),
        "is_stale": age_hours > 24.0,
        "last_updated": modified_ts,
        "age_hours": age_hours,
    }


def render_heartbeat_card(title: str, status: dict[str, object]) -> None:
    exists = bool(status["exists"])
    if not exists:
        st.markdown(
            (
                "<div style='border:1px solid #FECACA;border-radius:12px;padding:12px 14px;background:#FEF2F2;'>"
                f"<div style='font-size:13px;color:#7F1D1D;'>{title}</div>"
                "<div style='font-size:20px;font-weight:700;color:#B91C1C;'>FILE NOT FOUND</div>"
                f"<div style='font-size:11px;color:#991B1B;word-break:break-all;'>{status['path']}</div>"
                "</div>"
            ),
            unsafe_allow_html=True,
        )
        return

    age_hours = float(status["age_hours"])
    last_updated = pd.Timestamp(status["last_updated"])
    is_stale = bool(status["is_stale"])

    tone_bg = "#FEF2F2" if is_stale else "#F0FDF4"
    tone_border = "#FECACA" if is_stale else "#BBF7D0"
    tone_title = "#7F1D1D" if is_stale else "#14532D"
    tone_value = "#B91C1C" if is_stale else "#166534"

    st.markdown(
        (
            f"<div style='border:1px solid {tone_border};border-radius:12px;padding:12px 14px;background:{tone_bg};'>"
            f"<div style='font-size:13px;color:{tone_title};'>{title}</div>"
            f"<div style='font-size:20px;font-weight:700;color:{tone_value};'>Last Updated: {age_hours:.1f}h ago</div>"
            f"<div style='font-size:11px;color:{tone_title};'>{last_updated.strftime('%Y-%m-%d %H:%M:%S')}</div>"
            "</div>"
        ),
        unsafe_allow_html=True,
    )


def load_model_features_metadata(model_features_path: Path) -> tuple[int, list[str], str | None]:
    if not model_features_path.exists():
        return 0, [], f"Model features file not found: {model_features_path}"

    try:
        model_features_data = json.loads(model_features_path.read_text())
    except Exception as exc:
        return 0, [], f"Failed to parse model features: {exc}"

    if not isinstance(model_features_data, list):
        return 0, [], "Model features file is not a JSON list."

    features = [str(feature) for feature in model_features_data]
    return len(features), features, None


def run_pipeline_subprocess() -> subprocess.CompletedProcess:
    if not PIPELINE_PATH.exists():
        raise FileNotFoundError(f"Pipeline script not found: {PIPELINE_PATH}")

    return subprocess.run(
        [sys.executable, str(PIPELINE_PATH)],
        capture_output=True,
        text=True,
        check=True,
        cwd=PROJECT_ROOT,
    )


def ensure_pipeline_on_startup() -> None:
    if st.session_state.get("startup_pipeline_done", False):
        return

    with st.spinner("Initialisation: exécution du pipeline complet avant affichage du dashboard..."):
        try:
            result = run_pipeline_subprocess()
        except subprocess.CalledProcessError as exc:
            st.session_state["pipeline_status"] = "failure"
            st.session_state["pipeline_stdout"] = exc.stdout or ""
            st.session_state["pipeline_stderr"] = exc.stderr or ""

            st.error("Pipeline Failed during startup. Dashboard blocked.")
            with st.expander("Error Logs (stderr)", expanded=True):
                st.code(st.session_state["pipeline_stderr"] or "No stderr output captured.", language="text")
            if st.session_state["pipeline_stdout"]:
                with st.expander("Standard Output (stdout)"):
                    st.code(st.session_state["pipeline_stdout"], language="text")
            st.stop()
        except FileNotFoundError as exc:
            st.error(str(exc))
            st.stop()
        else:
            st.session_state["pipeline_status"] = "success"
            st.session_state["pipeline_stdout"] = result.stdout or ""
            st.session_state["pipeline_stderr"] = result.stderr or ""
            st.session_state["startup_pipeline_done"] = True
            st.cache_data.clear()
            st.cache_resource.clear()
            st.rerun()


def main() -> None:
    ensure_pipeline_on_startup()

    load_errors: list[str] = []
    try:
        history_df = load_history(HISTORY_PATH)
    except Exception as exc:
        history_df = pd.DataFrame(
            {
                "date": pd.Series(dtype="datetime64[ns]"),
                "country": pd.Series(dtype="object"),
                "stock_twh": pd.Series(dtype="float"),
                "fill_pct": pd.Series(dtype="float"),
                "net_injection": pd.Series(dtype="float"),
            }
        )
        load_errors.append(f"History load failed: {exc}")

    try:
        base_forecast_df = load_forecast(FORECAST_PATH)
    except Exception as exc:
        base_forecast_df = pd.DataFrame(
            {
                "date": pd.Series(dtype="datetime64[ns]"),
                "country": pd.Series(dtype="object"),
                "net_injection_pred": pd.Series(dtype="float"),
                "stock_twh_simulated": pd.Series(dtype="float"),
            }
        )
        load_errors.append(f"Forecast load failed: {exc}")

    try:
        weather_df = load_weather(WEATHER_PATH)
    except Exception as exc:
        weather_df = pd.DataFrame(
            {
                "date": pd.Series(dtype="datetime64[ns]"),
                "country": pd.Series(dtype="object"),
                "temp_weighted": pd.Series(dtype="float"),
                "wind_weighted": pd.Series(dtype="float"),
                "source": pd.Series(dtype="object"),
            }
        )
        load_errors.append(f"Weather load failed: {exc}")

    if load_errors:
        st.warning("Some datasets failed to load. System Monitor can help diagnose:")
        for msg in load_errors:
            st.caption(f"- {msg}")

    all_countries = sorted(set(history_df["country"].unique()) | set(base_forecast_df["country"].unique()))
    if not all_countries:
        all_countries = ["FR"]

    default_country = "FR" if "FR" in all_countries else all_countries[0]
    default_country_idx = all_countries.index(default_country)

    st.sidebar.header("Controls")
    selected_country = st.sidebar.selectbox("Country", all_countries, index=default_country_idx)
    temp_shock_c = st.sidebar.slider("Temperature Shock (°C)", -5.0, 5.0, 0.0, 0.5)
    high_withdrawal_threshold_14d = st.sidebar.number_input(
        "High Withdrawal Threshold (TWh, 14d)",
        min_value=0.5,
        max_value=30.0,
        value=WITHDRAWAL_ALERT_THRESHOLD_14D_DEFAULT,
        step=0.5,
    )

    country_history = history_df[history_df["country"] == selected_country].sort_values("date").copy()
    if country_history.empty:
        history_window = country_history
    else:
        min_hist_date = country_history["date"].min()
        max_hist_date = country_history["date"].max()
        default_start = max(min_hist_date, max_hist_date - pd.Timedelta(days=365))
        date_start, date_end = st.sidebar.slider(
            "History Date Range",
            min_value=min_hist_date.date(),
            max_value=max_hist_date.date(),
            value=(default_start.date(), max_hist_date.date()),
            format="YYYY-MM-DD",
        )
        date_start = pd.Timestamp(date_start)
        date_end = pd.Timestamp(date_end)
        history_window = country_history[
            (country_history["date"] >= date_start) & (country_history["date"] <= date_end)
        ].copy()

    shock_forecast_df = None
    shock_error = None
    if abs(temp_shock_c) > 0:
        with st.spinner("Running live what-if simulation..."):
            try:
                shock_forecast_df = run_recursive_forecast_with_temp_shock(
                    history_df=history_df,
                    weather_df=weather_df,
                    temp_shock_c=temp_shock_c,
                    horizon_days=FORECAST_HORIZON_DAYS,
                )
            except Exception as exc:
                shock_error = str(exc)

    active_forecast_df = shock_forecast_df if shock_forecast_df is not None else base_forecast_df
    scenario_label = "Shock Scenario" if shock_forecast_df is not None else "Base Case"

    title_col, update_col = st.columns([3, 2])
    with title_col:
        st.title("GasGuardian - Storage Forecast Control Room")
    with update_col:
        last_update_ts = (
            pd.Timestamp.fromtimestamp(FORECAST_PATH.stat().st_mtime).strftime("%Y-%m-%d %H:%M:%S")
            if FORECAST_PATH.exists()
            else "N/A"
        )
        max_forecast_date = base_forecast_df["date"].max()
        max_forecast_label = max_forecast_date.strftime("%Y-%m-%d") if pd.notna(max_forecast_date) else "N/A"
        st.markdown(
            f"**Last Update:** `{last_update_ts}`  \n"
            f"**Forecast Through:** `{max_forecast_label}`"
        )

    if shock_error:
        st.warning(f"Shock simulation failed, base forecast is used instead. Details: {shock_error}")

    forecast_tab, system_monitor_tab = st.tabs(["📈 Forecast", "🛠️ System Monitor"])
    with forecast_tab:
        overview_tab, analysis_tab, raw_tab = st.tabs(["Overview", "Country Analysis", "Raw Data"])

    with overview_tab:
        overview_df = build_overview_table(
            history_df=history_df,
            forecast_df=active_forecast_df,
            high_withdrawal_threshold_14d=high_withdrawal_threshold_14d,
        )

        st.markdown(
            (
                "<div style='border:1px solid #E5E7EB;border-radius:16px;padding:16px 18px;"
                "background:linear-gradient(120deg,#F0F9FF,#F8FAFC);margin-bottom:8px;'>"
                "<div style='font-size:13px;color:#475569;'>Helicopter View</div>"
                "<div style='font-size:24px;font-weight:700;color:#0F172A;'>All Countries - System Snapshot</div>"
                "</div>"
            ),
            unsafe_allow_html=True,
        )

        alert_count = int(overview_df["Alert"].sum()) if "Alert" in overview_df.columns else 0
        tracked_count = len(overview_df)
        total_stock_twh = float(pd.to_numeric(overview_df["Current Stock (TWh)"], errors="coerce").sum())
        total_net_14d = float(pd.to_numeric(overview_df["Forecasted Injection (14d Sum)"], errors="coerce").sum())
        withdrawal_count = int((overview_df["Forecasted Injection (14d Sum)"] < 0).sum())

        kpi_1, kpi_2, kpi_3, kpi_4 = st.columns(4)
        with kpi_1:
            render_overview_card("Countries Tracked", f"{tracked_count}", "Coverage of monitoring scope", tone="neutral")
        with kpi_2:
            tone = "danger" if alert_count > 0 else "good"
            render_overview_card("Countries in Alert", f"{alert_count}", "Low stock or heavy 14d withdrawal", tone=tone)
        with kpi_3:
            tone = "good" if total_net_14d >= 0 else "warn"
            render_overview_card("Net Injection (14d)", f"{total_net_14d:+.2f} TWh", "Portfolio-level projected balance", tone=tone)
        with kpi_4:
            tone = "info" if scenario_label == "Shock Scenario" else "neutral"
            render_overview_card("Scenario", scenario_label, f"Total current stock: {total_stock_twh:.1f} TWh", tone=tone)

        chart_col, summary_col = st.columns([1.4, 1])
        with chart_col:
            chart_df = overview_df.sort_values("Forecasted Injection (14d Sum)", ascending=True).copy()
            colors = [
                "#B91C1C" if bool(alert) else ("#C2410C" if val < 0 else "#15803D")
                for alert, val in zip(
                    chart_df["Alert"].tolist(),
                    chart_df["Forecasted Injection (14d Sum)"].fillna(0).tolist(),
                )
            ]
            chart_df["label"] = (
                chart_df["Forecasted Injection (14d Sum)"].map(lambda x: f"{x:+.2f} TWh")
                + " | "
                + chart_df["Stock (%)"].map(lambda x: f"{x:.1f}%")
            )
            risk_fig = go.Figure(
                data=[
                    go.Bar(
                        x=chart_df["Forecasted Injection (14d Sum)"],
                        y=chart_df["Country"],
                        orientation="h",
                        marker_color=colors,
                        text=chart_df["label"],
                        textposition="outside",
                        hovertemplate=(
                            "<b>%{y}</b><br>"
                            "Forecast 14d: %{x:+.2f} TWh<br>"
                            "Stock: %{customdata:.1f}%<extra></extra>"
                        ),
                        customdata=chart_df["Stock (%)"],
                    )
                ]
            )
            risk_fig.add_vline(x=0, line_width=1.5, line_color="#64748B", line_dash="dot")
            risk_fig.update_layout(
                title="Projected 14-Day Balance by Country",
                height=350,
                xaxis_title="Forecasted Injection (14d Sum, TWh)",
                yaxis_title="",
                margin={"l": 10, "r": 20, "t": 52, "b": 10},
                plot_bgcolor="rgba(0,0,0,0)",
                paper_bgcolor="rgba(0,0,0,0)",
            )
            st.plotly_chart(risk_fig, use_container_width=True)

        with summary_col:
            risk_share = (alert_count / tracked_count * 100.0) if tracked_count > 0 else 0.0
            withdraw_share = (withdrawal_count / tracked_count * 100.0) if tracked_count > 0 else 0.0
            st.markdown("**Risk Snapshot**")
            st.caption(f"Alert Exposure: {risk_share:.0f}%")
            st.progress(min(max(risk_share / 100.0, 0.0), 1.0))
            st.caption(f"Countries with Net Withdrawal: {withdraw_share:.0f}%")
            st.progress(min(max(withdraw_share / 100.0, 0.0), 1.0))
            st.markdown(
                (
                    "<div style='margin-top:12px;border:1px solid #E5E7EB;border-radius:12px;padding:12px 14px;background:#FFFFFF;'>"
                    f"<div style='font-size:13px;color:#475569;'>Alert Rule</div>"
                    f"<div style='font-size:13px;color:#0F172A;'>Stock &lt; 10% or 14d withdrawal &gt; {high_withdrawal_threshold_14d:.1f} TWh</div>"
                    "</div>"
                ),
                unsafe_allow_html=True,
            )

        status_map = {"Alert": "🔴 Alert", "Watch": "🟠 Watch", "Stable": "🟢 Stable"}
        display_table = overview_df[
            [
                "Country",
                "Status",
                "Stock (%)",
                "Current Stock (TWh)",
                "Forecasted Injection (14d Sum)",
                "Trend",
            ]
        ].copy()
        display_table["Status"] = display_table["Status"].map(status_map).fillna(display_table["Status"])

        def _highlight_rows(row: pd.Series) -> list[str]:
            raw_status = overview_df.loc[row.name, "Status"]
            if raw_status == "Alert":
                style = "background-color: #FFE8E8"
            elif raw_status == "Watch":
                style = "background-color: #FFF7E6"
            else:
                style = ""
            return [style] * len(row)

        styled_table = (
            display_table.style.format(
                {
                    "Stock (%)": "{:.1f}",
                    "Current Stock (TWh)": "{:.2f}",
                    "Forecasted Injection (14d Sum)": "{:+.2f}",
                }
            )
            .bar(subset=["Stock (%)"], color="#93C5FD")
            .bar(subset=["Forecasted Injection (14d Sum)"], color=["#FCA5A5", "#86EFAC"], align="zero")
            .apply(_highlight_rows, axis=1)
        )

        st.dataframe(styled_table, use_container_width=True)
        st.caption(
            "Legend: red = alert, orange = watch, green trend icon = improving stock trajectory."
        )

    with analysis_tab:
        st.subheader(f"Country Analysis - {selected_country}")

        country_base_forecast = base_forecast_df[base_forecast_df["country"] == selected_country].sort_values("date").copy()
        country_active_forecast = active_forecast_df[
            active_forecast_df["country"] == selected_country
        ].sort_values("date").copy()
        country_shock_forecast = (
            shock_forecast_df[shock_forecast_df["country"] == selected_country].sort_values("date").copy()
            if shock_forecast_df is not None
            else pd.DataFrame(columns=country_active_forecast.columns)
        )

        current_stock = None
        current_net_injection = None
        if not country_history.empty:
            latest_actual = country_history.iloc[-1]
            current_stock = float(latest_actual["stock_twh"])
            if pd.notna(latest_actual["net_injection"]):
                current_net_injection = float(latest_actual["net_injection"])

        forecast_stock_j14 = None
        if not country_active_forecast.empty:
            forecast_stock_j14 = float(country_active_forecast.iloc[-1]["stock_twh_simulated"])

        net_change = None
        if current_stock is not None and forecast_stock_j14 is not None:
            net_change = forecast_stock_j14 - current_stock

        kpi_col_1, kpi_col_2, kpi_col_3 = st.columns(3)
        with kpi_col_1:
            if current_stock is None:
                st.metric("Current Stock (TWh)", "N/A")
            else:
                delta_text = f"{current_net_injection:+.2f} vs prev day" if current_net_injection is not None else None
                st.metric("Current Stock (TWh)", f"{current_stock:.2f}", delta=delta_text)
        with kpi_col_2:
            if forecast_stock_j14 is None:
                st.metric("Forecasted Stock (J+14)", "N/A")
            else:
                st.metric("Forecasted Stock (J+14)", f"{forecast_stock_j14:.2f}")
        with kpi_col_3:
            if net_change is None:
                st.metric("Net Change (J+14 - Now)", "N/A")
            else:
                color = "#1B5E20" if net_change >= 0 else "#B71C1C"
                direction = "Injection" if net_change >= 0 else "Withdrawal"
                st.markdown(
                    (
                        "<div style='border:1px solid #E0E0E0;border-radius:10px;padding:10px 14px;background:#FAFAFA;'>"
                        "<div style='font-size:14px;color:#555;'>Net Change (J+14 - Now)</div>"
                        f"<div style='font-size:28px;font-weight:700;color:{color};line-height:1.2;'>{net_change:+.2f} TWh</div>"
                        f"<div style='font-size:13px;color:{color};'>{direction}</div>"
                        "</div>"
                    ),
                    unsafe_allow_html=True,
                )

        st.markdown("**Actual -> Forecast Transition**")
        transition_df = build_unified_transition_df(history_df=history_window, forecast_df=country_active_forecast)
        transition_fig = go.Figure()
        transition_actual = transition_df[transition_df["Type"] == "Actual"]
        transition_forecast = transition_df[transition_df["Type"] == "Forecast"]
        if not transition_actual.empty:
            transition_fig.add_trace(
                go.Scatter(
                    x=transition_actual["date"],
                    y=transition_actual["stock_twh"],
                    mode="lines",
                    name="Actual",
                    line={"color": "#1f77b4", "width": 3},
                )
            )
        if not transition_forecast.empty:
            transition_fig.add_trace(
                go.Scatter(
                    x=transition_forecast["date"],
                    y=transition_forecast["stock_twh"],
                    mode="lines",
                    name="Forecast",
                    line={"color": "#d62728", "width": 3, "dash": "dash"},
                )
            )
        transition_today = pd.Timestamp.today().normalize()
        transition_fig.add_vline(x=transition_today, line_width=2, line_dash="dot", line_color="#666666")
        transition_fig.add_annotation(
            x=transition_today,
            y=1,
            yref="paper",
            text="Today",
            showarrow=False,
            xanchor="left",
            yanchor="bottom",
            font={"color": "#666666"},
            bgcolor="rgba(255,255,255,0.7)",
        )
        transition_fig.update_layout(
            height=390,
            xaxis_title="Date",
            yaxis_title="Stock (TWh)",
            legend_title_text="",
            margin={"l": 12, "r": 12, "t": 20, "b": 10},
        )
        st.plotly_chart(transition_fig, use_container_width=True)

        st.markdown("**What-If Scenario (Base vs Shock)**")
        stock_fig = go.Figure()
        if not history_window.empty:
            stock_fig.add_trace(
                go.Scatter(
                    x=history_window["date"],
                    y=history_window["stock_twh"],
                    mode="lines",
                    name="Actual",
                    line={"color": "#1f77b4", "width": 3},
                )
            )
        if not country_base_forecast.empty:
            stock_fig.add_trace(
                go.Scatter(
                    x=country_base_forecast["date"],
                    y=country_base_forecast["stock_twh_simulated"],
                    mode="lines",
                    name="Base Case",
                    line={"color": "#d62728", "width": 3},
                )
            )
        if not country_shock_forecast.empty:
            shock_name = "Cold Snap" if temp_shock_c < 0 else "Warm Shock"
            stock_fig.add_trace(
                go.Scatter(
                    x=country_shock_forecast["date"],
                    y=country_shock_forecast["stock_twh_simulated"],
                    mode="lines",
                    name=f"{shock_name} ({temp_shock_c:+.1f}°C)",
                    line={"color": "#ff7f0e", "width": 3, "dash": "dash"},
                )
            )

        today_line = pd.Timestamp.today().normalize()
        stock_fig.add_vline(x=today_line, line_width=2, line_dash="dot", line_color="#666666")
        stock_fig.add_annotation(
            x=today_line,
            y=1,
            yref="paper",
            text="Today",
            showarrow=False,
            xanchor="left",
            yanchor="bottom",
            font={"color": "#666666"},
            bgcolor="rgba(255,255,255,0.7)",
        )
        stock_fig.update_layout(
            height=430,
            xaxis_title="Date",
            yaxis_title="Stock (TWh)",
            legend_title_text="",
            margin={"l": 12, "r": 12, "t": 20, "b": 10},
        )
        st.plotly_chart(stock_fig, use_container_width=True)

        if not country_base_forecast.empty and not country_shock_forecast.empty:
            base_j14 = float(country_base_forecast.iloc[-1]["stock_twh_simulated"])
            shock_j14 = float(country_shock_forecast.iloc[-1]["stock_twh_simulated"])
            delta_j14 = shock_j14 - base_j14
            if temp_shock_c < 0:
                st.info(
                    f"A cold snap of {temp_shock_c:+.1f}°C changes J+14 stock by {delta_j14:+.2f} TWh."
                )
            else:
                st.info(
                    f"A warm shock of {temp_shock_c:+.1f}°C changes J+14 stock by {delta_j14:+.2f} TWh."
                )

        flux_actual = history_window[["date", "net_injection"]].dropna().copy()
        flux_actual["Type"] = "Actual"

        flux_forecast = country_active_forecast[["date", "net_injection_pred"]].copy()
        flux_forecast = flux_forecast.rename(columns={"net_injection_pred": "net_injection"})
        flux_forecast["Type"] = "Forecast"

        flux_df = pd.concat([flux_actual, flux_forecast], ignore_index=True).dropna(subset=["net_injection"])
        if flux_df.empty:
            st.info("No net-injection values available for this country.")
        else:
            flux_fig = px.bar(
                flux_df,
                x="date",
                y="net_injection",
                color="Type",
                barmode="group",
                color_discrete_map={"Actual": "#1f77b4", "Forecast": "#d62728"},
            )
            flux_fig.add_hline(y=0, line_width=1, line_color="#777777")
            flux_fig.update_layout(
                height=350,
                xaxis_title="Date",
                yaxis_title="Net Injection (TWh/day)",
                legend_title_text="",
                margin={"l": 12, "r": 12, "t": 20, "b": 10},
            )
            st.plotly_chart(flux_fig, use_container_width=True)

        forecast_table = build_country_forecast_table(
            forecast_df=country_active_forecast,
            weather_df=weather_df,
            country=selected_country,
            temp_shock_c=temp_shock_c if shock_forecast_df is not None else 0.0,
        )
        with st.expander("Next 14 Days Forecast Table"):
            if forecast_table.empty:
                st.info("No forecast rows available.")
            else:
                st.dataframe(forecast_table, use_container_width=True, hide_index=True)
                if forecast_table["HDD"].isna().all():
                    st.caption("HDD values unavailable for the selected horizon.")

        with st.expander("Alerts", expanded=True):
            if country_active_forecast.empty:
                st.info("No forecast rows to evaluate alerts.")
            else:
                withdrawal_hits = country_active_forecast[
                    country_active_forecast["net_injection_pred"] < WITHDRAWAL_ALERT_THRESHOLD_DAY
                ].copy()
                if withdrawal_hits.empty:
                    st.success("No high withdrawal signal detected (threshold: -0.5 TWh/day).")
                else:
                    hit_dates = ", ".join(withdrawal_hits["date"].dt.strftime("%Y-%m-%d").tolist())
                    worst_value = float(withdrawal_hits["net_injection_pred"].min())
                    st.error(
                        f"⚠️ High Withdrawal Alert: net_injection_pred < -0.5 detected on {hit_dates}. "
                        f"Worst day: {worst_value:.3f} TWh/day."
                    )

    with raw_tab:
        st.subheader("Raw Data & Export")
        generated_forecast = active_forecast_df.sort_values(["country", "date"]).copy()
        generated_forecast["scenario"] = scenario_label
        generated_forecast["temp_shock_c"] = float(temp_shock_c if shock_forecast_df is not None else 0.0)

        export_df = generated_forecast.copy()
        export_df["date"] = export_df["date"].dt.strftime("%Y-%m-%d")
        csv_data = export_df.to_csv(index=False).encode("utf-8")
        file_suffix = "shock" if shock_forecast_df is not None else "base"
        file_name = f"forecast_generated_{file_suffix}.csv"
        st.download_button(
            label="Download Generated Forecast CSV",
            data=csv_data,
            file_name=file_name,
            mime="text/csv",
        )

        left_raw, right_raw = st.columns(2)
        with left_raw:
            st.markdown("**Generated Forecast**")
            st.dataframe(generated_forecast, use_container_width=True, hide_index=True)
        with right_raw:
            history_preview = history_df.sort_values(["country", "date"]).tail(200).copy()
            st.markdown("**History (tail 200 rows)**")
            st.dataframe(history_preview, use_container_width=True, hide_index=True)

    with system_monitor_tab:
        st.subheader("System Monitor")
        st.caption("Data integrity checks and manual pipeline control.")

        st.markdown("**Data Integrity Check**")

        try:
            gie_raw_df = load_monitor_dataset(HISTORY_PATH)
            gie_gaps = check_gaps(gie_raw_df, date_col="date")
        except Exception as exc:
            gie_gaps = None
            st.error(f"Failed to load GIE dataset: {exc}")

        if gie_gaps is not None:
            if len(gie_gaps) == 0:
                st.success("✅ GIE Data is continuous. No gaps.")
            else:
                st.error(f"❌ CRITICAL: GIE Data has {len(gie_gaps)} missing days!")
                st.dataframe(
                    pd.DataFrame({"missing_date": [gap_date.isoformat() for gap_date in gie_gaps]}),
                    use_container_width=True,
                    hide_index=True,
                )

        try:
            weather_raw_df = load_monitor_dataset(WEATHER_PATH)
            weather_gaps = check_gaps(weather_raw_df, date_col="date")
        except Exception as exc:
            weather_gaps = None
            st.error(f"Failed to load Weather dataset: {exc}")

        if weather_gaps is not None:
            if len(weather_gaps) == 0:
                st.success("✅ Weather Data is continuous. No gaps.")
            else:
                st.error(f"❌ CRITICAL: Weather Data has {len(weather_gaps)} missing days!")
                st.dataframe(
                    pd.DataFrame({"missing_date": [gap_date.isoformat() for gap_date in weather_gaps]}),
                    use_container_width=True,
                    hide_index=True,
                )

        st.markdown("**Pipeline Control**")
        st.caption(f"Pipeline entrypoint: {PIPELINE_PATH}")

        last_pipeline_status = st.session_state.get("pipeline_status")
        last_pipeline_stdout = st.session_state.get("pipeline_stdout", "")
        last_pipeline_stderr = st.session_state.get("pipeline_stderr", "")

        if last_pipeline_status == "success":
            st.success("Pipeline finished successfully!")
            with st.expander("Pipeline Logs (stdout)", expanded=True):
                st.code(last_pipeline_stdout or "No stdout output captured.", language="text")
            if last_pipeline_stderr:
                with st.expander("Pipeline Logs (stderr)"):
                    st.code(last_pipeline_stderr, language="text")
        elif last_pipeline_status == "failure":
            st.error("Pipeline Failed!")
            with st.expander("Error Logs (stderr)", expanded=True):
                st.code(last_pipeline_stderr or "No stderr output captured.", language="text")
            if last_pipeline_stdout:
                with st.expander("Standard Output (stdout)"):
                    st.code(last_pipeline_stdout, language="text")

        if st.button("🔄 Run Full Pipeline"):
            with st.spinner("Pipeline is running... This may take up to 2 minutes."):
                try:
                    result = run_pipeline_subprocess()
                except subprocess.CalledProcessError as exc:
                    st.session_state["pipeline_status"] = "failure"
                    st.session_state["pipeline_stdout"] = exc.stdout or ""
                    st.session_state["pipeline_stderr"] = exc.stderr or ""
                    st.error("Pipeline Failed!")
                    with st.expander("Error Logs (stderr)", expanded=True):
                        st.code(st.session_state["pipeline_stderr"] or "No stderr output captured.", language="text")
                    if st.session_state["pipeline_stdout"]:
                        with st.expander("Standard Output (stdout)"):
                            st.code(st.session_state["pipeline_stdout"], language="text")
                except FileNotFoundError as exc:
                    st.error(str(exc))
                else:
                    st.session_state["pipeline_status"] = "success"
                    st.session_state["pipeline_stdout"] = result.stdout or ""
                    st.session_state["pipeline_stderr"] = result.stderr or ""
                    st.success("Pipeline finished successfully!")
                    with st.expander("Pipeline Logs (stdout)", expanded=True):
                        st.code(st.session_state["pipeline_stdout"] or "No stdout output captured.", language="text")
                    if st.session_state["pipeline_stderr"]:
                        with st.expander("Pipeline Logs (stderr)"):
                            st.code(st.session_state["pipeline_stderr"], language="text")
                    st.session_state["startup_pipeline_done"] = True
                    st.cache_data.clear()
                    st.cache_resource.clear()
                    st.rerun()


if __name__ == "__main__":
    main()
