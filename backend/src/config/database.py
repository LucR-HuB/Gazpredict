from __future__ import annotations

import os
from pathlib import Path
from typing import Generator

from dotenv import load_dotenv
from sqlmodel import SQLModel, Session, create_engine


PROJECT_ROOT = Path(__file__).resolve().parents[3]
load_dotenv(PROJECT_ROOT / ".env")

DATABASE_URL = os.getenv("DATABASE_URL")
if not DATABASE_URL:
    raise ValueError("Missing DATABASE_URL in environment.")

engine = create_engine(DATABASE_URL, echo=False)


def get_session() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session


def init_db() -> None:
    # Ensure model modules are imported so metadata includes all tables.
    try:
        from backend.src.models import gie as _gie_models  # noqa: F401
        from backend.src.models import weather as _weather_models  # noqa: F401
    except ImportError:
        pass

    SQLModel.metadata.create_all(engine)
