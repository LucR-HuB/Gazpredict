import type { ForecastRecord, HistoryRecord } from "./api";
import { DAY_MS, dateToTimestamp, formatDateLabel } from "./formatters";
import type {
  ChartPoint,
  HistoryWithNetInjection,
  OverviewForecastChart,
  OverviewRow,
  OverviewStatus,
  TransitionPoint,
} from "./types";

type ClimatologyStats = {
  min: number;
  max: number;
  avg: number;
};

type ClimatologyAccumulator = {
  min: number;
  max: number;
  sum: number;
  count: number;
};

function parseDateParts(date: string): { year: number; monthDay: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(date);
  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  if (!Number.isInteger(year)) {
    return null;
  }

  return { year, monthDay: `${match[2]}-${match[3]}` };
}

function applyClimatologyToPoint(
  point: TransitionPoint,
  country: string,
  date: string,
  climatologyByCountryDay: Record<string, ClimatologyStats>,
): void {
  const dateParts = parseDateParts(date);
  if (!dateParts) {
    return;
  }

  const climatology = climatologyByCountryDay[`${country}-${dateParts.monthDay}`];
  if (!climatology) {
    return;
  }

  point.clim_min = climatology.min;
  point.clim_diff = climatology.max - climatology.min;
  point.clim_avg = climatology.avg;
}

export function sortHistoryRecords(rows: HistoryRecord[]): HistoryRecord[] {
  return [...rows].sort(
    (a, b) => a.country.localeCompare(b.country) || dateToTimestamp(a.date) - dateToTimestamp(b.date),
  );
}

export function sortForecastRecords(rows: ForecastRecord[]): ForecastRecord[] {
  return [...rows].sort(
    (a, b) => a.country.localeCompare(b.country) || dateToTimestamp(a.date) - dateToTimestamp(b.date),
  );
}

export function calculateClimatology(
  historyRows: HistoryRecord[],
): Record<string, ClimatologyStats> {
  if (historyRows.length === 0) {
    return {};
  }

  const parsedRows: Array<{ country: string; monthDay: string; year: number; stock: number }> = [];
  let latestDate: { ts: number; year: number; monthDay: string } | null = null;

  for (const row of historyRows) {
    const dateParts = parseDateParts(row.date);
    if (!dateParts || !Number.isFinite(row.stock_twh)) {
      continue;
    }

    const timestamp = dateToTimestamp(row.date);
    parsedRows.push({
      country: row.country,
      monthDay: dateParts.monthDay,
      year: dateParts.year,
      stock: row.stock_twh,
    });

    if (latestDate === null || timestamp > latestDate.ts) {
      latestDate = {
        ts: timestamp,
        year: dateParts.year,
        monthDay: dateParts.monthDay,
      };
    }
  }

  if (latestDate === null) {
    return {};
  }

  const lastFullYear = latestDate.monthDay === "12-31" ? latestDate.year : latestDate.year - 1;
  const startYear = lastFullYear - 4;
  let rowsForClimatology = parsedRows.filter(
    (row) => row.year >= startYear && row.year <= lastFullYear,
  );

  if (rowsForClimatology.length === 0) {
    const rollingStartYear = latestDate.year - 4;
    rowsForClimatology = parsedRows.filter(
      (row) => row.year >= rollingStartYear && row.year <= latestDate.year,
    );
  }

  const aggregation = new Map<string, ClimatologyAccumulator>();

  for (const row of rowsForClimatology) {
    const key = `${row.country}-${row.monthDay}`;
    const existing = aggregation.get(key);
    if (!existing) {
      aggregation.set(key, {
        min: row.stock,
        max: row.stock,
        sum: row.stock,
        count: 1,
      });
      continue;
    }

    existing.min = Math.min(existing.min, row.stock);
    existing.max = Math.max(existing.max, row.stock);
    existing.sum += row.stock;
    existing.count += 1;
  }

  const climatologyByCountryDay: Record<string, ClimatologyStats> = {};

  for (const [key, value] of aggregation.entries()) {
    climatologyByCountryDay[key] = {
      min: value.min,
      max: value.max,
      avg: value.sum / value.count,
    };
  }

  return climatologyByCountryDay;
}

export function buildOverviewForecastChart(
  rows: ForecastRecord[],
  maxVisibleCountries: number,
): OverviewForecastChart {
  const safeMaxVisibleCountries = Math.max(1, maxVisibleCountries);
  const latestPredictionByCountry = new Map<string, number>();

  for (const row of sortForecastRecords(rows)) {
    latestPredictionByCountry.set(row.country, row.prediction_twh);
  }

  const rankedCountries = Array.from(latestPredictionByCountry.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([country]) => country);

  if (rankedCountries.length === 0) {
    return {
      data: [],
      categories: [],
      hiddenCountryCount: 0,
      visibleCountryCount: 0,
    };
  }

  const visibleCountries = rankedCountries.slice(0, safeMaxVisibleCountries);
  const visibleCountrySet = new Set(visibleCountries);
  const hiddenCountryCount = Math.max(rankedCountries.length - visibleCountries.length, 0);
  const othersCategory = hiddenCountryCount > 0 ? `Others (${hiddenCountryCount})` : null;
  const categories = othersCategory ? [...visibleCountries, othersCategory] : visibleCountries;
  const byDate = new Map<string, ChartPoint>();

  for (const row of rows) {
    const existing = byDate.get(row.date) ?? {
      date: row.date,
      dateLabel: formatDateLabel(row.date),
    };

    if (visibleCountrySet.has(row.country)) {
      existing[row.country] = row.prediction_twh;
    } else if (othersCategory) {
      const currentOthers = typeof existing[othersCategory] === "number" ? existing[othersCategory] : 0;
      existing[othersCategory] = currentOthers + row.prediction_twh;
    }

    byDate.set(row.date, existing);
  }

  return {
    data: Array.from(byDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date)),
    categories,
    hiddenCountryCount,
    visibleCountryCount: visibleCountries.length,
  };
}

export function withNetInjection(historyRows: HistoryRecord[]): HistoryWithNetInjection[] {
  const sortedRows = sortHistoryRecords(historyRows);
  const previousStockByCountry = new Map<string, number>();

  return sortedRows.map((row) => {
    const previousStock = previousStockByCountry.get(row.country);
    const netInjection = previousStock === undefined ? null : row.stock_twh - previousStock;
    previousStockByCountry.set(row.country, row.stock_twh);

    return {
      ...row,
      net_injection: netInjection,
    };
  });
}

export function buildOverviewRows(
  historyRows: HistoryWithNetInjection[],
  forecastRows: ForecastRecord[],
  highWithdrawalThreshold14d: number,
): OverviewRow[] {
  const latestHistoryByCountry = new Map<string, HistoryWithNetInjection>();
  const capacityByCountry = new Map<string, number>();

  for (const row of historyRows) {
    latestHistoryByCountry.set(row.country, row);

    const currentCapacity = capacityByCountry.get(row.country);
    if (currentCapacity === undefined || row.stock_twh > currentCapacity) {
      capacityByCountry.set(row.country, row.stock_twh);
    }
  }

  const forecastAggByCountry = new Map<string, { sum14d: number; lastStock: number; lastDate: string }>();

  for (const row of sortForecastRecords(forecastRows)) {
    const previous = forecastAggByCountry.get(row.country);
    if (!previous) {
      forecastAggByCountry.set(row.country, {
        sum14d: row.net_injection,
        lastStock: row.prediction_twh,
        lastDate: row.date,
      });
      continue;
    }

    previous.sum14d += row.net_injection;
    if (dateToTimestamp(row.date) >= dateToTimestamp(previous.lastDate)) {
      previous.lastStock = row.prediction_twh;
      previous.lastDate = row.date;
    }
  }

  const countries = Array.from(
    new Set([...latestHistoryByCountry.keys(), ...forecastAggByCountry.keys()]),
  ).sort();

  return countries.map((country) => {
    const latest = latestHistoryByCountry.get(country);
    const forecastAgg = forecastAggByCountry.get(country);

    const currentStockTwh = latest?.stock_twh ?? null;
    const capacity = capacityByCountry.get(country);
    const stockPct =
      latest?.fill_pct ??
      (currentStockTwh !== null && capacity !== undefined && capacity > 0
        ? (100 * currentStockTwh) / capacity
        : null);

    const forecastedInjection14dSum = forecastAgg?.sum14d ?? null;
    const forecastedStockJ14 = forecastAgg?.lastStock ?? null;

    const trend =
      currentStockTwh !== null && forecastedStockJ14 !== null
        ? (forecastedStockJ14 >= currentStockTwh ? "📈" : "📉")
        : "N/A";

    const alertStockLow = stockPct !== null && stockPct < 10;
    const alertWithdrawalHigh =
      forecastedInjection14dSum !== null &&
      forecastedInjection14dSum < -Math.abs(highWithdrawalThreshold14d);
    const alert = alertStockLow || alertWithdrawalHigh;

    let status: OverviewStatus = "Stable";
    if (alert) {
      status = "Alert";
    } else if (forecastedInjection14dSum !== null && forecastedInjection14dSum < 0) {
      status = "Watch";
    }

    return {
      country,
      currentStockTwh,
      stockPct,
      forecastedInjection14dSum,
      forecastedStockJ14,
      trend,
      status,
      alert,
    };
  });
}

export function buildTransitionSeries(
  historyRows: HistoryWithNetInjection[],
  forecastRows: ForecastRecord[],
  climatologyByCountryDay: Record<string, ClimatologyStats> = {},
): TransitionPoint[] {
  const byDate = new Map<string, TransitionPoint>();
  let latestHistoryRow: HistoryWithNetInjection | null = null;
  let earliestForecastDate: string | null = null;

  for (const row of historyRows) {
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Actual = row.stock_twh;
    applyClimatologyToPoint(existing, row.country, row.date, climatologyByCountryDay);
    byDate.set(row.date, existing);

    if (
      latestHistoryRow === null ||
      dateToTimestamp(row.date) >= dateToTimestamp(latestHistoryRow.date)
    ) {
      latestHistoryRow = row;
    }
  }

  for (const row of forecastRows) {
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Forecast = row.prediction_twh;
    applyClimatologyToPoint(existing, row.country, row.date, climatologyByCountryDay);
    if (row.stock_upper !== null) {
      existing.stock_upper = row.stock_upper;
    }
    if (row.stock_lower !== null) {
      existing.stock_lower = row.stock_lower;
    }
    byDate.set(row.date, existing);

    if (
      earliestForecastDate === null ||
      dateToTimestamp(row.date) < dateToTimestamp(earliestForecastDate)
    ) {
      earliestForecastDate = row.date;
    }
  }

  if (
    latestHistoryRow !== null &&
    earliestForecastDate !== null &&
    dateToTimestamp(latestHistoryRow.date) < dateToTimestamp(earliestForecastDate)
  ) {
    const existing =
      byDate.get(latestHistoryRow.date) ??
      ({
        date: latestHistoryRow.date,
        dateLabel: formatDateLabel(latestHistoryRow.date),
      } as TransitionPoint);

    if (existing.Forecast === undefined) {
      existing.Forecast = latestHistoryRow.stock_twh;
    }
    applyClimatologyToPoint(
      existing,
      latestHistoryRow.country,
      latestHistoryRow.date,
      climatologyByCountryDay,
    );
    byDate.set(latestHistoryRow.date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date));
}

export function buildFluxSeries(
  historyRows: HistoryWithNetInjection[],
  forecastRows: ForecastRecord[],
): TransitionPoint[] {
  const byDate = new Map<string, TransitionPoint>();

  for (const row of historyRows) {
    if (row.net_injection === null) {
      continue;
    }
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Actual = row.net_injection;
    byDate.set(row.date, existing);
  }

  for (const row of forecastRows) {
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Forecast = row.net_injection;
    if (row.injection_upper !== null) {
      existing.injection_upper = row.injection_upper;
    }
    if (row.injection_lower !== null) {
      existing.injection_lower = row.injection_lower;
    }
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date));
}

export function findDateGaps(rows: Array<{ date: string }>): string[] {
  const dates = Array.from(new Set(rows.map((row) => row.date.slice(0, 10)))).sort();
  if (dates.length === 0) {
    return [];
  }

  const minTs = dateToTimestamp(dates[0]);
  const maxTs = dateToTimestamp(dates[dates.length - 1]);
  const dateSet = new Set(dates);
  const missing: string[] = [];

  for (let currentTs = minTs; currentTs <= maxTs; currentTs += DAY_MS) {
    const key = new Date(currentTs).toISOString().slice(0, 10);
    if (!dateSet.has(key)) {
      missing.push(key);
    }
  }

  return missing;
}
