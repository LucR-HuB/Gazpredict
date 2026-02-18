from __future__ import annotations

import contextlib
import json
import logging
import math
import threading
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import BackgroundTasks, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from sqlmodel import select

from backend.src.config.database import engine
from backend.src.etl.run_gie_daily import main as run_gie
from backend.src.etl.run_weather_daily import main as run_weather
from backend.src.features.build_features import main as run_features
from backend.src.inference.run_inference import run_recursive_forecast
from backend.src.models.gie import GieData
from backend.src.models.train_model import main as run_train


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env")

METRICS_PATH = PROJECT_ROOT / "data" / "models" / "metrics.json"
CONFIDENCE_MULTIPLIER = 1.96


def run_full_pipeline() -> None:
    logger.info("🚀 Starting Full Pipeline...")

    steps = [
        ("GIE daily fetch", run_gie),
        ("Weather daily fetch", run_weather),
        ("Feature engineering", run_features),
        ("Model training", run_train),
    ]

    for step_name, step_fn in steps:
        try:
            logger.info("Running step: %s", step_name)
            step_fn()
            logger.info("Completed step: %s", step_name)
        except Exception:
            logger.exception("Step failed: %s", step_name)

    logger.info("✅ Pipeline Finished")


scheduler = BackgroundScheduler()


@contextlib.asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("System starting up... Triggering Pipeline in background.")
    threading.Thread(target=run_full_pipeline, name="startup-full-pipeline", daemon=True).start()

    scheduler.add_job(
        run_full_pipeline,
        "cron",
        hour=7,
        minute=0,
        id="daily_full_pipeline",
        replace_existing=True,
    )
    scheduler.start()
    logger.info("Scheduler started: full pipeline will run daily at 07:00")
    try:
        yield
    finally:
        scheduler.shutdown()
        logger.info("Scheduler stopped")


app = FastAPI(title="GasGuardian API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _read_sql_df(query: Any) -> pd.DataFrame:
    try:
        return pd.read_sql(query, engine)
    except Exception as exc:
        logger.exception("Failed to read data from SQL database")
        raise HTTPException(status_code=500, detail="Failed to read data from database") from exc


def _sanitize_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    clean_df = df.where(pd.notnull(df), None)
    return clean_df.to_dict(orient="records")


def _load_rmse_from_metrics() -> float:
    if not METRICS_PATH.exists():
        return 0.0

    try:
        with METRICS_PATH.open("r", encoding="utf-8") as metrics_file:
            payload = json.load(metrics_file)
    except (OSError, json.JSONDecodeError):
        logger.warning("Failed to read model metrics at %s. Falling back to rmse=0.", METRICS_PATH)
        return 0.0

    if not isinstance(payload, dict):
        return 0.0

    rmse_raw = payload.get("rmse", 0)
    try:
        rmse = float(rmse_raw)
    except (TypeError, ValueError):
        return 0.0

    if not math.isfinite(rmse):
        return 0.0

    return rmse


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/system/metrics")
def get_system_metrics() -> dict[str, Any]:
    if not METRICS_PATH.exists():
        return {
            "r2": 0,
            "mae": 0,
            "rmse": 0,
            "wape": 0,
            "message": "No model trained yet",
        }

    try:
        with METRICS_PATH.open("r", encoding="utf-8") as metrics_file:
            return json.load(metrics_file)
    except (OSError, json.JSONDecodeError) as exc:
        logger.exception("Failed to read model metrics from %s", METRICS_PATH)
        raise HTTPException(status_code=500, detail="Failed to read model metrics") from exc


@app.get("/api/gie-history")
def get_gie_history(
    start_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    country: Optional[str] = Query(default=None, description="Country code"),
) -> list[dict[str, Any]]:
    df = _read_sql_df(select(GieData))

    try:
        if "date" not in df.columns or "country" not in df.columns:
            logger.error("Invalid GIE SQL schema. Columns: %s", list(df.columns))
            raise HTTPException(status_code=500, detail="SQL schema is invalid for gie history")

        df["date"] = pd.to_datetime(df["date"], errors="raise")

        if start_date:
            try:
                start_ts = pd.to_datetime(start_date, format="%Y-%m-%d", errors="raise")
            except (TypeError, ValueError) as exc:
                raise HTTPException(
                    status_code=400,
                    detail="start_date must be in YYYY-MM-DD format",
                ) from exc
            df = df[df["date"] >= start_ts]

        if country:
            country_filter = country.strip().upper()
            df = df[df["country"].astype(str).str.upper() == country_filter]

        df = df.sort_values(by=["date", "country"])
        df["date"] = df["date"].dt.strftime("%Y-%m-%d")

        return _sanitize_records(df)
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to process gie history data")
        raise HTTPException(status_code=500, detail="Failed to process gie history data") from exc


@app.get("/api/forecast")
def get_forecast() -> list[dict[str, Any]]:
    try:
        df = run_recursive_forecast()
        rmse = _load_rmse_from_metrics()

        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
        sort_columns: list[str] = [col for col in ["country", "date", "scenario"] if col in df.columns]
        if sort_columns:
            df = df.sort_values(by=sort_columns)

        net_col: Optional[str] = None
        for candidate_col in ("net_injection", "net_injection_pred"):
            if candidate_col in df.columns:
                net_col = candidate_col
                break

        if net_col:
            net_injection_pred = pd.to_numeric(df[net_col], errors="coerce")
            net_injection_uncertainty = rmse * CONFIDENCE_MULTIPLIER
            df["injection_upper"] = net_injection_pred + net_injection_uncertainty
            df["injection_lower"] = net_injection_pred - net_injection_uncertainty
        else:
            df["injection_upper"] = None
            df["injection_lower"] = None

        stock_col: Optional[str] = None
        for candidate_col in ("stock_twh", "stock_twh_simulated", "prediction_twh"):
            if candidate_col in df.columns:
                stock_col = candidate_col
                break

        if stock_col:
            stock_pred = pd.to_numeric(df[stock_col], errors="coerce")
            if "country" in df.columns:
                day_index = df.groupby("country").cumcount() + 1
            else:
                day_index = pd.Series(range(1, len(df) + 1), index=df.index)
            uncertainty = rmse * day_index.pow(0.5) * CONFIDENCE_MULTIPLIER
            df["stock_upper"] = stock_pred + uncertainty
            df["stock_lower"] = stock_pred - uncertainty
        else:
            df["stock_upper"] = None
            df["stock_lower"] = None

        # Backward-compatible aliases for existing clients.
        if stock_col and "prediction_twh" not in df.columns:
            df["prediction_twh"] = pd.to_numeric(df[stock_col], errors="coerce")
        if net_col and "net_injection_pred" not in df.columns:
            df["net_injection_pred"] = pd.to_numeric(df[net_col], errors="coerce")

        # Backward-compatible aliases for existing clients.
        df["confidence_upper"] = df["injection_upper"]
        df["confidence_lower"] = df["injection_lower"]

        if "date" in df.columns:
            df["date"] = df["date"].dt.strftime("%Y-%m-%d")

        return _sanitize_records(df)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except RuntimeError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except HTTPException:
        raise
    except Exception as exc:
        logger.exception("Failed to process forecast data")
        raise HTTPException(status_code=500, detail="Failed to process forecast data") from exc


@app.post("/api/pipeline/run")
def run_pipeline(background_tasks: BackgroundTasks) -> dict[str, str]:
    background_tasks.add_task(run_full_pipeline)
    logger.info("Manual full pipeline run triggered in background")
    return {"message": "Pipeline triggered in background", "status": "running"}


@app.post("/api/pipeline/force-run")
def force_run_pipeline(background_tasks: BackgroundTasks) -> dict[str, str]:
    background_tasks.add_task(run_full_pipeline)
    logger.info("Manual full pipeline run triggered in background via legacy endpoint")
    return {"message": "Pipeline triggered in background", "status": "running"}


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
