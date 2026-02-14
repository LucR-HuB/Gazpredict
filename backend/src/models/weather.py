from __future__ import annotations

import datetime as dt

from sqlmodel import Field, SQLModel


class WeatherData(SQLModel, table=True):
    date: dt.date = Field(primary_key=True)
    country: str = Field(primary_key=True)
    source: str = Field(primary_key=True)
    temp_weighted: float | None = Field(default=None)
    wind_weighted: float | None = Field(default=None)
