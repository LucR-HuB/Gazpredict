import logging
import os
import sys
from datetime import date
from pathlib import Path

import pandas as pd
from dotenv import load_dotenv
from sqlmodel import Session, delete

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
START_YEAR = 2016
PROJECT_ROOT = Path(__file__).resolve().parents[3]


def year_ranges(start_year: int, today: date) -> list[tuple[str, str]]:
    ranges: list[tuple[str, str]] = []
    for year in range(start_year, today.year + 1):
        start = date(year, 1, 1)
        end = min(date(year, 12, 31), today)
        ranges.append((start.isoformat(), end.isoformat()))
    return ranges


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
    logger = logging.getLogger("run_backfill")

    load_dotenv(PROJECT_ROOT / ".env")
    api_key = os.getenv("GIE_API_KEY")
    if not api_key:
        raise ValueError("Missing GIE_API_KEY in environment.")

    client = GIEClient(api_key=api_key)
    today = date.today()
    init_db()

    raw_records: list[dict] = []
    for date_from, date_to in year_ranges(START_YEAR, today):
        logger.info("Backfill window: %s -> %s", date_from, date_to)
        for country in COUNTRIES:
            logger.info("Fetching country=%s", country)
            chunk = client.fetch_data(
                date_from=date_from,
                date_to=date_to,
                country=country,
            )
            raw_records.extend(chunk)

    df = client.process_data(raw_records)
    gie_rows = _to_gie_models(df)

    with Session(engine) as session:
        session.exec(delete(GieData))
        if gie_rows:
            session.add_all(gie_rows)
        session.commit()

    logger.info("Backfill finished. Rows=%s inserted_into=gie_data", len(gie_rows))


if __name__ == "__main__":
    main()
