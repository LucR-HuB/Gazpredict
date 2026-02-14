import datetime
import logging
import sys
from pathlib import Path

import pandas as pd
from sqlmodel import Session, delete

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
    logger = logging.getLogger("run_weather_backfill")

    init_db()
    client = WeatherClient()
    today = datetime.date.today()
    dataset = client.build_dataset(
        history_start=datetime.date(2015, 1, 1),
        history_end=today - datetime.timedelta(days=1),
        forecast_start=today,
        forecast_end=today + datetime.timedelta(days=client.FORECAST_HORIZON_DAYS),
    )
    weather_rows = _to_weather_models(dataset)

    with Session(engine) as session:
        session.exec(delete(WeatherData))
        if weather_rows:
            session.add_all(weather_rows)
        session.commit()

    logger.info("Full backfill completed (2015 -> Today+14d). Rows=%s", len(weather_rows))


if __name__ == "__main__":
    main()
