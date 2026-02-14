import datetime
import logging
import sys
import time
from pathlib import Path
from typing import Any

import openmeteo_requests
import pandas as pd
import requests_cache
from retry_requests import retry

try:
    from backend.config.stations import WEATHER_GRID
except ImportError:
    project_root = Path(__file__).resolve().parents[3]
    if str(project_root) not in sys.path:
        sys.path.append(str(project_root))
    from backend.config.stations import WEATHER_GRID


class WeatherClient:
    ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
    FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
    HISTORY_START = datetime.date(2015, 1, 1)
    FORECAST_HORIZON_DAYS = 14
    OUTPUT_COLUMNS = ["date", "country", "temp_weighted", "wind_weighted", "source"]
    CACHE_PATH = Path(__file__).resolve().parents[3] / ".cache"

    def __init__(self) -> None:
        self.logger = logging.getLogger(self.__class__.__name__)
        cache_session = requests_cache.CachedSession(str(self.CACHE_PATH), expire_after=-1)
        retry_session = retry(cache_session, retries=5, backoff_factor=0.2)
        self.client = openmeteo_requests.Client(session=retry_session)

    def build_dataset(
        self,
        history_start: datetime.date | None = None,
        history_end: datetime.date | None = None,
        forecast_start: datetime.date | None = None,
        forecast_end: datetime.date | None = None,
        delay_seconds: float = 5.0,
    ) -> pd.DataFrame:
        today = datetime.date.today()
        if history_start is None and history_end is None:
            resolved_history_start: datetime.date | None = self.HISTORY_START
            resolved_history_end: datetime.date | None = today - datetime.timedelta(days=1)
        elif history_start is None:
            resolved_history_start = None
            resolved_history_end = None
        else:
            resolved_history_start = history_start
            resolved_history_end = history_end or (today - datetime.timedelta(days=1))

        resolved_forecast_start = forecast_start or today
        resolved_forecast_end = forecast_end or (
            today + datetime.timedelta(days=self.FORECAST_HORIZON_DAYS)
        )

        country_frames: list[pd.DataFrame] = []
        for country, grid in WEATHER_GRID.items():
            self.logger.info("Processing country=%s", country)
            country_df = self._build_country_series(
                country=country,
                grid=grid,
                history_start=resolved_history_start,
                history_end=resolved_history_end,
                forecast_start=resolved_forecast_start,
                forecast_end=resolved_forecast_end,
                delay_seconds=delay_seconds,
            )
            country_frames.append(country_df)

        if not country_frames:
            return pd.DataFrame(columns=self.OUTPUT_COLUMNS)

        combined = pd.concat(country_frames, ignore_index=True)
        combined = self._normalize_output(combined)
        combined = combined.drop_duplicates(subset=["date", "country", "source"], keep="last")
        combined = combined.sort_values(["country", "date"]).reset_index(drop=True)
        return combined

    def update_daily(self, existing_df: pd.DataFrame, delay_seconds: float = 0.0) -> pd.DataFrame:
        today = datetime.date.today()
        yesterday = today - datetime.timedelta(days=1)
        forecast_end = today + datetime.timedelta(days=self.FORECAST_HORIZON_DAYS)

        existing = self._normalize_output(existing_df)
        historical_rows = existing[
            (existing["source"] == "history") | (existing["date"] < today)
        ].copy()

        max_date = historical_rows["date"].max() if not historical_rows.empty else None
        if pd.notna(max_date):
            missing_start = max_date + datetime.timedelta(days=1)
        else:
            missing_start = yesterday
        missing_end = yesterday

        history_start_for_call: datetime.date | None = missing_start
        if missing_start > missing_end:
            history_start_for_call = None

        self.logger.info(
            "Daily update windows history=[%s, %s] forecast=[%s, %s]",
            history_start_for_call,
            missing_end,
            today,
            forecast_end,
        )

        fresh_df = self.build_dataset(
            history_start=history_start_for_call,
            history_end=missing_end,
            forecast_start=today,
            forecast_end=forecast_end,
            delay_seconds=delay_seconds,
        )

        updated = pd.concat([existing, fresh_df], ignore_index=True)
        updated = self._normalize_output(updated)
        updated = updated.drop_duplicates(subset=["date", "country", "source"], keep="last")
        updated = updated.sort_values(["country", "date"]).reset_index(drop=True)
        return updated

    def _build_country_series(
        self,
        country: str,
        grid: dict[str, Any],
        history_start: datetime.date | None,
        history_end: datetime.date | None,
        forecast_start: datetime.date,
        forecast_end: datetime.date,
        delay_seconds: float,
    ) -> pd.DataFrame:
        if history_start is None or history_end is None:
            temperature_history = pd.DataFrame(
                columns=["date", "country", "temp_weighted", "source"]
            )
            wind_history = pd.DataFrame(
                columns=["date", "country", "wind_weighted", "source"]
            )
        else:
            temperature_history = self._fetch_weighted_metric(
                country=country,
                points=grid["temperature_points"],
                variable="temperature_2m_mean",
                start_date=history_start,
                end_date=history_end,
                source="history",
                output_column="temp_weighted",
                url=self.ARCHIVE_URL,
                delay_seconds=delay_seconds,
            )
            wind_history = self._fetch_weighted_metric(
                country=country,
                points=grid["wind_points"],
                variable="wind_speed_10m_max",
                start_date=history_start,
                end_date=history_end,
                source="history",
                output_column="wind_weighted",
                url=self.ARCHIVE_URL,
                delay_seconds=delay_seconds,
            )

        temperature_forecast = self._fetch_weighted_metric(
            country=country,
            points=grid["temperature_points"],
            variable="temperature_2m_mean",
            start_date=forecast_start,
            end_date=forecast_end,
            source="forecast",
            output_column="temp_weighted",
            url=self.FORECAST_URL,
            delay_seconds=delay_seconds,
        )
        wind_forecast = self._fetch_weighted_metric(
            country=country,
            points=grid["wind_points"],
            variable="wind_speed_10m_max",
            start_date=forecast_start,
            end_date=forecast_end,
            source="forecast",
            output_column="wind_weighted",
            url=self.FORECAST_URL,
            delay_seconds=delay_seconds,
        )

        temperature_df = pd.concat([temperature_history, temperature_forecast], ignore_index=True)
        wind_df = pd.concat([wind_history, wind_forecast], ignore_index=True)

        merged = pd.merge(
            temperature_df,
            wind_df,
            on=["date", "country", "source"],
            how="outer",
        )
        merged = merged[self.OUTPUT_COLUMNS]
        merged = merged.sort_values(["date", "source"]).reset_index(drop=True)
        return merged

    def _fetch_weighted_metric(
        self,
        country: str,
        points: list[dict[str, Any]],
        variable: str,
        start_date: datetime.date,
        end_date: datetime.date,
        source: str,
        output_column: str,
        url: str,
        delay_seconds: float = 5.0,
    ) -> pd.DataFrame:
        if end_date < start_date:
            return pd.DataFrame(columns=["date", "country", output_column, "source"])

        params = {
            "latitude": ",".join(str(point["lat"]) for point in points),
            "longitude": ",".join(str(point["lon"]) for point in points),
            "start_date": start_date.isoformat(),
            "end_date": end_date.isoformat(),
            "daily": variable,
            "timezone": "UTC",
        }
        self.logger.info(
            "Waiting... %.2fs before API call for country=%s variable=%s source=%s",
            delay_seconds,
            country,
            variable,
            source,
        )
        time.sleep(delay_seconds)
        try:
            responses = self.client.weather_api(url, params=params)
        except Exception as exc:
            error_text = str(exc).lower()
            is_rate_limited = (
                "request limit" in error_text
                or "rate limit" in error_text
                or "try again in one minute" in error_text
            )
            if not is_rate_limited:
                raise

            self.logger.warning(
                "Rate limit hit for country=%s variable=%s source=%s. Waiting 60s before retry.",
                country,
                variable,
                source,
            )
            self.logger.info(
                "Waiting... 60s before retry for country=%s variable=%s source=%s",
                country,
                variable,
                source,
            )
            time.sleep(60)
            self.logger.info(
                "Waiting... %.2fs before retry API call for country=%s variable=%s source=%s",
                delay_seconds,
                country,
                variable,
                source,
            )
            time.sleep(delay_seconds)
            responses = self.client.weather_api(url, params=params)

        if not responses:
            self.logger.warning(
                "No data returned for country=%s variable=%s source=%s in [%s, %s].",
                country,
                variable,
                source,
                start_date,
                end_date,
            )
            return pd.DataFrame(columns=["date", "country", output_column, "source"])

        if len(responses) != len(points):
            self.logger.warning(
                "Response count mismatch for country=%s variable=%s source=%s: points=%s responses=%s",
                country,
                variable,
                source,
                len(points),
                len(responses),
            )

        weighted_series: pd.Series | None = None
        for point, response in zip(points, responses):
            series = self._response_to_series(response=response)
            contribution = series * float(point["weight"])
            weighted_series = (
                contribution
                if weighted_series is None
                else weighted_series.add(contribution, fill_value=0.0)
            )

        if weighted_series is None:
            return pd.DataFrame(columns=["date", "country", output_column, "source"])

        metric_df = weighted_series.rename(output_column).reset_index()
        metric_df.columns = ["date", output_column]
        metric_df["country"] = country
        metric_df["source"] = source
        metric_df = metric_df[["date", "country", output_column, "source"]]
        return metric_df

    @staticmethod
    def _response_to_series(response: Any) -> pd.Series:
        daily = response.Daily()
        values = daily.Variables(0).ValuesAsNumpy()

        start = pd.to_datetime(daily.Time(), unit="s", utc=True).tz_localize(None)
        interval = pd.Timedelta(seconds=daily.Interval())
        dates = pd.date_range(start=start, periods=len(values), freq=interval)

        return pd.Series(values, index=dates, dtype="float64")

    def _normalize_output(self, df: pd.DataFrame | None) -> pd.DataFrame:
        if df is None or df.empty:
            return pd.DataFrame(columns=self.OUTPUT_COLUMNS)

        normalized = df.copy()
        for column in self.OUTPUT_COLUMNS:
            if column not in normalized.columns:
                normalized[column] = pd.NA

        normalized["date"] = pd.to_datetime(normalized["date"], errors="coerce").dt.date
        normalized["country"] = normalized["country"].astype("string")
        normalized["temp_weighted"] = pd.to_numeric(
            normalized["temp_weighted"], errors="coerce"
        )
        normalized["wind_weighted"] = pd.to_numeric(
            normalized["wind_weighted"], errors="coerce"
        )
        normalized["source"] = normalized["source"].astype("string")

        normalized = normalized.dropna(subset=["date", "country"])
        normalized = normalized[self.OUTPUT_COLUMNS]
        return normalized
