import datetime
import logging
import sys
from pathlib import Path

import pandas as pd
from sqlalchemy import func
from sqlmodel import Session, delete, select

try:
    from .weather_client import WeatherClient
except ImportError:
    from weather_client import WeatherClient

try:
    from backend.src.config.database import engine, init_db
    from backend.src.models.weather import WeatherData
except ImportError:
    project_root = Path(__file__).resolve().parents[3]
    if str(project_root) not in sys.path:
        sys.path.append(str(project_root))
    from backend.src.config.database import engine, init_db
    from backend.src.models.weather import WeatherData


def _to_weather_models(df: pd.DataFrame) -> list[WeatherData]:
    records: list[WeatherData] = []
    if df.empty:
        return records

    cleaned = df.drop_duplicates(subset=["date", "country", "source"], keep="last")
    for row in cleaned.itertuples(index=False):
        row_date = row.date.date() if hasattr(row.date, "date") else row.date
        records.append(
            WeatherData(
                date=row_date,
                country=str(row.country),
                source=str(row.source),
                temp_weighted=None if pd.isna(row.temp_weighted) else float(row.temp_weighted),
                wind_weighted=None if pd.isna(row.wind_weighted) else float(row.wind_weighted),
            )
        )
    return records


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    logger = logging.getLogger("run_weather_daily")

    init_db()
    client = WeatherClient()

    today = datetime.date.today()
    yesterday = today - datetime.timedelta(days=1)
    forecast_end = today + datetime.timedelta(days=client.FORECAST_HORIZON_DAYS)

    with Session(engine) as session:
        latest_history_date = session.exec(
            select(func.max(WeatherData.date)).where(WeatherData.source == "history")
        ).one()

    if latest_history_date is None:
        history_start = client.HISTORY_START
    else:
        resolved_latest = (
            latest_history_date.date()
            if hasattr(latest_history_date, "date")
            else latest_history_date
        )
        history_start = resolved_latest + datetime.timedelta(days=1)

    history_start_for_call: datetime.date | None = history_start
    history_end_for_call: datetime.date | None = yesterday
    if history_start > yesterday:
        history_start_for_call = None
        history_end_for_call = None

    logger.info(
        "Daily update windows history=[%s, %s] forecast=[%s, %s]",
        history_start_for_call,
        history_end_for_call,
        today,
        forecast_end,
    )

    fresh_df = client.build_dataset(
        history_start=history_start_for_call,
        history_end=history_end_for_call,
        forecast_start=today,
        forecast_end=forecast_end,
        delay_seconds=0.0,
    )
    fresh_rows = _to_weather_models(fresh_df)

    with Session(engine) as session:
        session.exec(
            delete(WeatherData)
            .where(WeatherData.source == "forecast")
            .where(WeatherData.date >= today)
        )

        if fresh_rows:
            session.add_all(fresh_rows)
        session.commit()

    logger.info("Daily weather update completed. Rows_upserted=%s", len(fresh_rows))


if __name__ == "__main__":
    main()
