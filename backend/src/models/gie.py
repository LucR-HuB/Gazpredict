from __future__ import annotations

import datetime as dt

from sqlmodel import Field, SQLModel


class GieData(SQLModel, table=True):
    date: dt.date = Field(primary_key=True, index=True)
    country: str = Field(primary_key=True, index=True)
    storage_twh: float | None = Field(default=None)
    fill_pct: float | None = Field(default=None)
    gas_year: int | None = Field(default=None)
