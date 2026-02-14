from __future__ import annotations

import contextlib
import logging
from pathlib import Path
from typing import Any, Optional

import pandas as pd
import uvicorn
from apscheduler.schedulers.background import BackgroundScheduler
from dotenv import load_dotenv
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from backend.src.etl.run_gie_daily import main as run_gie
from backend.src.etl.run_weather_daily import main as run_weather
from backend.src.features.build_features import main as run_features
from backend.src.models.train_model import main as run_train


logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env")

GIE_HISTORY_PATH = PROJECT_ROOT / "data" / "raw" / "gie_history.csv"
FORECAST_PATH = PROJECT_ROOT / "data" / "predictions" / "forecast_14d.csv"


def run_daily_pipeline() -> None:
    logger.info("Starting daily pipeline...")
    try:
        run_gie()
        run_weather()
        run_features()
        run_train()
        logger.info("Pipeline finished successfully")
    except Exception as exc:
        logger.exception("Pipeline failed: %s", exc)


scheduler = BackgroundScheduler()
scheduler.add_job(run_daily_pipeline, "cron", hour=7, minute=0)


@contextlib.asynccontextmanager
async def lifespan(_: FastAPI):
    scheduler.start()
    logger.info("Scheduler started: pipeline will run daily at 07:00")
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


def _read_csv_safe(csv_path: Path) -> pd.DataFrame:
    try:
        return pd.read_csv(csv_path)
    except FileNotFoundError as exc:
        logger.warning("CSV file not found: %s", csv_path)
        raise HTTPException(
            status_code=404,
            detail=f"Run pipeline first. Missing file: {csv_path.name}",
        ) from exc
    except pd.errors.ParserError as exc:
        logger.exception("CSV parser error for %s", csv_path)
        raise HTTPException(
            status_code=500,
            detail=f"CSV file is corrupted: {csv_path.name}",
        ) from exc
    except OSError as exc:
        logger.exception("Unable to read CSV file %s", csv_path)
        raise HTTPException(
            status_code=500,
            detail=f"Unable to read file: {csv_path.name}",
        ) from exc


def _sanitize_records(df: pd.DataFrame) -> list[dict[str, Any]]:
    clean_df = df.where(pd.notnull(df), None)
    return clean_df.to_dict(orient="records")


@app.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/gie-history")
def get_gie_history(
    start_date: Optional[str] = Query(default=None, description="YYYY-MM-DD"),
    country: Optional[str] = Query(default=None, description="Country code"),
) -> list[dict[str, Any]]:
    df = _read_csv_safe(GIE_HISTORY_PATH)

    try:
        if "date" not in df.columns or "country" not in df.columns:
            logger.error("Invalid gie_history schema. Columns: %s", list(df.columns))
            raise HTTPException(status_code=500, detail="CSV schema is invalid for gie history")

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
    except pd.errors.ParserError as exc:
        logger.exception("CSV parser error while processing %s", GIE_HISTORY_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"CSV file is corrupted: {GIE_HISTORY_PATH.name}",
        ) from exc
    except Exception as exc:
        logger.exception("Failed to process gie history data")
        raise HTTPException(status_code=500, detail="Failed to process gie history data") from exc


@app.get("/api/forecast")
def get_forecast() -> list[dict[str, Any]]:
    df = _read_csv_safe(FORECAST_PATH)

    try:
        sort_columns: list[str] = [col for col in ["date", "country"] if col in df.columns]
        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"], errors="coerce")
        if sort_columns:
            df = df.sort_values(by=sort_columns)
        if "date" in df.columns:
            df["date"] = df["date"].dt.strftime("%Y-%m-%d")

        return _sanitize_records(df)
    except HTTPException:
        raise
    except pd.errors.ParserError as exc:
        logger.exception("CSV parser error while processing %s", FORECAST_PATH)
        raise HTTPException(
            status_code=500,
            detail=f"CSV file is corrupted: {FORECAST_PATH.name}",
        ) from exc
    except Exception as exc:
        logger.exception("Failed to process forecast data")
        raise HTTPException(status_code=500, detail="Failed to process forecast data") from exc


@app.post("/api/pipeline/force-run")
def force_run_pipeline() -> dict[str, str]:
    scheduler.add_job(run_daily_pipeline)
    logger.info("Manual pipeline run triggered")
    return {"status": "Pipeline triggered", "message": "Check logs for progress"}


@app.post("/api/pipeline/run")
def run_pipeline() -> dict[str, str]:
    return force_run_pipeline()


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
