import logging
import os
import sys
from datetime import date, timedelta
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from sqlalchemy import func
from sqlmodel import Session, select

try:
    from .gie_client import GIEClient
except ImportError:
    from gie_client import GIEClient

try:
    from backend.src.config.database import engine, init_db
    from backend.src.models.gie import GieData
except ImportError:
    project_root = Path(__file__).resolve().parents[3]
    if str(project_root) not in sys.path:
        sys.path.append(str(project_root))
    from backend.src.config.database import engine, init_db
    from backend.src.models.gie import GieData


COUNTRIES = ["FR", "DE", "IT", "NL", "BE"]
PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEFAULT_START_DATE = date(2018, 1, 1)


def _to_gie_models(df: pd.DataFrame) -> list[GieData]:
    records: list[GieData] = []
    if df.empty:
        return records

    cleaned = df.drop_duplicates(subset=["date", "country"], keep="last")
    for row in cleaned.itertuples(index=False):
        row_date = row.date.date() if hasattr(row.date, "date") else row.date
        records.append(
            GieData(
                date=row_date,
                country=str(row.country),
                storage_twh=None if pd.isna(row.storage_twh) else float(row.storage_twh),
                fill_pct=None if pd.isna(row.fill_pct) else float(row.fill_pct),
                gas_year=None if pd.isna(row.gas_year) else int(row.gas_year),
            )
        )
    return records


def main() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s | %(levelname)s | %(name)s | %(message)s",
    )
    logger = logging.getLogger("run_gie_daily")

    load_dotenv(PROJECT_ROOT / ".env")
    api_key = os.getenv("GIE_API_KEY")
    if not api_key:
        raise ValueError("Missing GIE_API_KEY in environment.")

    init_db()
    client = GIEClient(api_key=api_key)

    end_date = date.today() - timedelta(days=1)
    total_inserted = 0
    for country in COUNTRIES:
        with Session(engine) as session:
            latest_date = session.exec(
                select(func.max(GieData.date)).where(GieData.country == country)
            ).one()

        if latest_date is None:
            start_date = DEFAULT_START_DATE
        else:
            resolved_latest = (
                latest_date.date() if hasattr(latest_date, "date") else latest_date
            )
            start_date = resolved_latest + timedelta(days=1)

        if start_date > end_date:
            logger.info("[%s] Up to date.", country)
            logger.info(
                "[%s] Computed window start=%s end=%s",
                country,
                start_date,
                end_date,
            )
            continue

        date_from = start_date.isoformat()
        date_to = end_date.isoformat()
        logger.info("[%s] Fetching missing window: %s -> %s", country, date_from, date_to)
        raw_rows = client.fetch_data(date_from=date_from, date_to=date_to, country=country)
        country_df = client.process_data(raw_rows)
        gie_rows = _to_gie_models(country_df)

        if not gie_rows:
            logger.info("[%s] No new rows to insert.", country)
            continue

        with Session(engine) as session:
            session.add_all(gie_rows)
            session.commit()

        total_inserted += len(gie_rows)
        logger.info("[%s] Updated %s rows", country, len(gie_rows))

    logger.info("GIE daily update finished. Added_rows=%s", total_inserted)


if __name__ == "__main__":
    main()
