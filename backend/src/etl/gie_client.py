import logging
import time
from typing import Any

import pandas as pd
import requests


class GIEClient:
    BASE_URL = "https://agsi.gie.eu/api"
    PAGE_SIZE = 300
    PAGE_SLEEP_SECONDS = 0.35
    MAX_RETRIES = 8
    BACKOFF_BASE_SECONDS = 1.8
    REQUEST_TIMEOUT = (10, 60)

    def __init__(self, api_key: str):
        if not api_key:
            raise ValueError("GIE API key is required.")

        self.logger = logging.getLogger(self.__class__.__name__)
        self.session = requests.Session()
        self.session.headers.update({"x-key": api_key})

    def fetch_data(self, date_from: str, date_to: str, country: str) -> list[dict[str, Any]]:
        records: list[dict[str, Any]] = []
        seen_dates: set[str] = set()
        page = 1

        while True:
            params = {
                "country": country,
                "from": date_from,
                "to": date_to,
                "size": self.PAGE_SIZE,
                "page": page,
            }

            rows = self._request_page(params=params, country=country, page=page)
            if not rows:
                break

            new_rows = 0
            for row in rows:
                gas_day = row.get("gasDayStart")
                if not gas_day or gas_day in seen_dates:
                    continue
                seen_dates.add(gas_day)
                enriched = dict(row)
                enriched["country"] = country
                records.append(enriched)
                new_rows += 1

            if new_rows == 0:
                self.logger.warning(
                    "No new rows for country=%s, page=%s in [%s, %s]. Stopping pagination.",
                    country,
                    page,
                    date_from,
                    date_to,
                )
                break

            page += 1
            time.sleep(self.PAGE_SLEEP_SECONDS)

        self.logger.info(
            "Fetched %s rows for country=%s in [%s, %s].",
            len(records),
            country,
            date_from,
            date_to,
        )
        return records

    def process_data(self, raw_data: list[dict[str, Any]]) -> pd.DataFrame:
        output_columns = ["date", "country", "storage_twh", "fill_pct", "gas_year"]
        if not raw_data:
            return pd.DataFrame(columns=output_columns)

        df = pd.DataFrame(raw_data)
        if df.empty:
            return pd.DataFrame(columns=output_columns)

        df["date"] = pd.to_datetime(df.get("gasDayStart"), errors="coerce")
        df["country"] = df.get("country").astype("string")
        df["storage_twh"] = self._to_float(df.get("gasInStorage"))
        df["fill_pct"] = self._to_float(df.get("full"))
        df["gas_year"] = self._calculate_gas_year(df["date"])

        df = df[output_columns]
        df = df.dropna(subset=["date", "country"])
        df = df.sort_values(["country", "date"]).reset_index(drop=True)

        self.logger.info("Processed dataframe with %s rows.", len(df))
        return df

    def _request_page(self, params: dict[str, Any], country: str, page: int) -> list[dict[str, Any]]:
        for attempt in range(1, self.MAX_RETRIES + 1):
            try:
                response = self.session.get(
                    self.BASE_URL,
                    params=params,
                    timeout=self.REQUEST_TIMEOUT,
                )
            except (
                requests.exceptions.ReadTimeout,
                requests.exceptions.ConnectTimeout,
                requests.exceptions.ConnectionError,
            ) as exc:
                wait_seconds = self._retry_wait(attempt)
                self.logger.warning(
                    "Network error for country=%s page=%s (%s). Retry in %.1fs.",
                    country,
                    page,
                    exc.__class__.__name__,
                    wait_seconds,
                )
                time.sleep(wait_seconds)
                continue

            if response.status_code == 429:
                retry_after = response.headers.get("Retry-After")
                wait_seconds = float(retry_after) if retry_after and retry_after.isdigit() else self._retry_wait(attempt)
                self.logger.warning(
                    "Rate limit hit for country=%s page=%s. Retry in %.1fs.",
                    country,
                    page,
                    wait_seconds,
                )
                time.sleep(wait_seconds)
                continue

            if 500 <= response.status_code < 600:
                wait_seconds = self._retry_wait(attempt)
                self.logger.warning(
                    "Server error %s for country=%s page=%s. Retry in %.1fs.",
                    response.status_code,
                    country,
                    page,
                    wait_seconds,
                )
                time.sleep(wait_seconds)
                continue

            if response.status_code >= 400:
                self.logger.error(
                    "Request failed for country=%s page=%s with status=%s body=%s",
                    country,
                    page,
                    response.status_code,
                    response.text[:500],
                )
                response.raise_for_status()

            payload = response.json()
            data = payload.get("data", [])
            if not isinstance(data, list):
                self.logger.error(
                    "Unexpected payload for country=%s page=%s: data is not a list.",
                    country,
                    page,
                )
                raise ValueError("Invalid payload from AGSI API: 'data' is not a list.")
            return data

        message = f"Exceeded retries for country={country}, page={page}."
        self.logger.error(message)
        raise RuntimeError(message)

    def _retry_wait(self, attempt: int) -> float:
        return min(60.0, self.BACKOFF_BASE_SECONDS**attempt)

    @staticmethod
    def _to_float(series: pd.Series) -> pd.Series:
        return pd.to_numeric(
            series.astype(str).str.replace(",", ".", regex=False),
            errors="coerce",
        ).astype("float64")

    @staticmethod
    def _calculate_gas_year(dates: pd.Series) -> pd.Series:
        return (
            dates.dt.year.where(dates.dt.month < 10, dates.dt.year + 1).astype("Int64")
        )
