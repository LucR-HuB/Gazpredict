import { useMemo } from "react";
import { Card, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, Title } from "@tremor/react";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line as RechartsLine,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ForecastRecord } from "../lib/api";
import { COUNTRY_LABEL_BY_CODE } from "../lib/countries";
import {
  DAY_MS,
  dateToTimestamp,
  formatChartValue,
  formatDateLabel,
  formatNumber,
  formatSigned,
  formatTooltipDate,
  formatTooltipValue,
} from "../lib/formatters";
import type { HistoryWithNetInjection } from "../lib/types";

type CountryComparisonProps = {
  selectedCountries: string[];
  history: HistoryWithNetInjection[];
  forecast: ForecastRecord[];
  historyLookbackDays: number;
};

type ComparisonChartPoint = {
  date: string;
  dateLabel: string;
  [countryCode: string]: number | string | undefined;
};

type SpreadRow = {
  country: string;
  currentFillPct: number | null;
  forecastFillPct: number | null;
  fillChange14d: number | null;
  depletionRatePpPerDay: number | null;
  netInjection14dSum: number | null;
  horizonDays: number;
};

const COUNTRY_COLOR_BY_CODE: Record<string, string> = {
  FR: "#3b82f6",
  DE: "#f97316",
  IT: "#14b8a6",
  BE: "#ef4444",
  NL: "#a855f7",
  ES: "#eab308",
  PL: "#22c55e",
  AT: "#06b6d4",
  CH: "#f43f5e",
  CZ: "#84cc16",
  GB: "#8b5cf6",
};

const FALLBACK_COUNTRY_COLORS = [
  "#38bdf8",
  "#f59e0b",
  "#22c55e",
  "#f43f5e",
  "#a78bfa",
  "#06b6d4",
  "#fb7185",
  "#eab308",
];

function clampFillPct(value: number): number {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "N/A";
  }
  return `${value.toFixed(digits)}%`;
}

function getCountryColor(countryCode: string): string {
  const fixedColor = COUNTRY_COLOR_BY_CODE[countryCode];
  if (fixedColor) {
    return fixedColor;
  }

  let hash = 0;
  for (const character of countryCode) {
    hash = (hash * 31 + character.charCodeAt(0)) >>> 0;
  }
  return FALLBACK_COUNTRY_COLORS[hash % FALLBACK_COUNTRY_COLORS.length];
}

export default function CountryComparison({
  selectedCountries,
  history,
  forecast,
  historyLookbackDays,
}: CountryComparisonProps) {
  const uniqueSelectedCountries = useMemo(
    () => Array.from(new Set(selectedCountries)),
    [selectedCountries],
  );

  const selectedCountrySet = useMemo(() => new Set(uniqueSelectedCountries), [uniqueSelectedCountries]);

  const countryColors = useMemo(() => {
    return uniqueSelectedCountries.reduce<Record<string, string>>((acc, country) => {
      acc[country] = getCountryColor(country);
      return acc;
    }, {});
  }, [uniqueSelectedCountries]);

  const historyWindowStartTs = useMemo(() => {
    if (history.length === 0) {
      return Number.NEGATIVE_INFINITY;
    }

    let latestHistoryTs = Number.NEGATIVE_INFINITY;
    for (const row of history) {
      latestHistoryTs = Math.max(latestHistoryTs, dateToTimestamp(row.date));
    }

    if (!Number.isFinite(latestHistoryTs)) {
      return Number.NEGATIVE_INFINITY;
    }

    return latestHistoryTs - (historyLookbackDays - 1) * DAY_MS;
  }, [history, historyLookbackDays]);

  const capacityByCountry = useMemo(() => {
    const capacities = new Map<string, number>();

    for (const row of history) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      const previousCapacity = capacities.get(row.country);
      if (previousCapacity === undefined || row.stock_twh > previousCapacity) {
        capacities.set(row.country, row.stock_twh);
      }
    }

    return capacities;
  }, [history, selectedCountrySet]);

  const fillPctSeries = useMemo(() => {
    const pointsByDate = new Map<string, ComparisonChartPoint>();

    for (const row of history) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }
      if (dateToTimestamp(row.date) < historyWindowStartTs) {
        continue;
      }

      const capacity = capacityByCountry.get(row.country);
      if (capacity === undefined || capacity <= 0) {
        continue;
      }

      const historicalFillPct = row.fill_pct !== null ? row.fill_pct : (100 * row.stock_twh) / capacity;
      if (!Number.isFinite(historicalFillPct)) {
        continue;
      }

      const point = pointsByDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
      point[row.country] = clampFillPct(historicalFillPct);
      pointsByDate.set(row.date, point);
    }

    for (const row of forecast) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      const capacity = capacityByCountry.get(row.country);
      if (capacity === undefined || capacity <= 0) {
        continue;
      }

      const forecastFillPct = (100 * row.prediction_twh) / capacity;
      if (!Number.isFinite(forecastFillPct)) {
        continue;
      }

      const point = pointsByDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
      point[row.country] = clampFillPct(forecastFillPct);
      pointsByDate.set(row.date, point);
    }

    return Array.from(pointsByDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date));
  }, [capacityByCountry, forecast, history, historyWindowStartTs, selectedCountrySet]);

  const netInjectionSeries = useMemo(() => {
    const pointsByDate = new Map<string, ComparisonChartPoint>();

    for (const row of history) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }
      if (dateToTimestamp(row.date) < historyWindowStartTs || row.net_injection === null) {
        continue;
      }

      const point = pointsByDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
      point[row.country] = row.net_injection;
      pointsByDate.set(row.date, point);
    }

    for (const row of forecast) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      const point = pointsByDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
      point[row.country] = row.net_injection;
      pointsByDate.set(row.date, point);
    }

    return Array.from(pointsByDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date));
  }, [forecast, history, historyWindowStartTs, selectedCountrySet]);

  const forecastStartDate = useMemo(() => {
    let earliestDate: string | null = null;

    for (const row of forecast) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      if (earliestDate === null || dateToTimestamp(row.date) < dateToTimestamp(earliestDate)) {
        earliestDate = row.date;
      }
    }

    return earliestDate;
  }, [forecast, selectedCountrySet]);

  const spreadRows = useMemo<SpreadRow[]>(() => {
    const latestHistoryByCountry = new Map<string, HistoryWithNetInjection>();
    const forecastAggByCountry = new Map<
      string,
      { sum14d: number; lastStock: number; lastDate: string; horizonDays: number }
    >();

    for (const row of history) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      const previous = latestHistoryByCountry.get(row.country);
      if (!previous || dateToTimestamp(row.date) >= dateToTimestamp(previous.date)) {
        latestHistoryByCountry.set(row.country, row);
      }
    }

    for (const row of forecast) {
      if (!selectedCountrySet.has(row.country)) {
        continue;
      }

      const previous = forecastAggByCountry.get(row.country);
      if (!previous) {
        forecastAggByCountry.set(row.country, {
          sum14d: row.net_injection,
          lastStock: row.prediction_twh,
          lastDate: row.date,
          horizonDays: 1,
        });
        continue;
      }

      previous.sum14d += row.net_injection;
      previous.horizonDays += 1;
      if (dateToTimestamp(row.date) >= dateToTimestamp(previous.lastDate)) {
        previous.lastStock = row.prediction_twh;
        previous.lastDate = row.date;
      }
    }

    return uniqueSelectedCountries.map((country) => {
      const capacity = capacityByCountry.get(country);
      const latestHistory = latestHistoryByCountry.get(country);
      const forecastAgg = forecastAggByCountry.get(country);

      const currentFillPct =
        latestHistory && capacity !== undefined && capacity > 0
          ? clampFillPct(latestHistory.fill_pct ?? (100 * latestHistory.stock_twh) / capacity)
          : null;

      const forecastFillPct =
        forecastAgg && capacity !== undefined && capacity > 0
          ? clampFillPct((100 * forecastAgg.lastStock) / capacity)
          : null;

      const fillChange14d =
        currentFillPct !== null && forecastFillPct !== null ? forecastFillPct - currentFillPct : null;

      const depletionRatePpPerDay =
        fillChange14d !== null && forecastAgg && forecastAgg.horizonDays > 0
          ? -fillChange14d / forecastAgg.horizonDays
          : null;

      return {
        country,
        currentFillPct,
        forecastFillPct,
        fillChange14d,
        depletionRatePpPerDay,
        netInjection14dSum: forecastAgg?.sum14d ?? null,
        horizonDays: forecastAgg?.horizonDays ?? 0,
      };
    });
  }, [capacityByCountry, forecast, history, selectedCountrySet, uniqueSelectedCountries]);

  return (
    <>
      <Card className="mt-6">
        <Title>Comparison View</Title>
        <Text className="mt-2">
          {uniqueSelectedCountries
            .map((country) => `${country} (${COUNTRY_LABEL_BY_CODE[country] ?? country})`)
            .join(" vs ")}
        </Text>
      </Card>

      <Card className="mt-6">
        <Title>Stock Fill % Comparison</Title>
        <Text className="mt-2">
          Forecast fill % is normalized from projected stock: <code>(Forecast TWh / Max Historical Capacity) * 100</code>.
        </Text>
        {fillPctSeries.length === 0 ? (
          <Text className="mt-4 text-slate-300">No fill data available for the selected countries.</Text>
        ) : (
          <div className="mt-4 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={fillPctSeries} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" strokeOpacity={0.45} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDateLabel}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "#475569", opacity: 0.6 }}
                />
                <YAxis
                  domain={[0, 100]}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => `${formatChartValue(value)}%`}
                  tickLine={false}
                  axisLine={{ stroke: "#475569", opacity: 0.6 }}
                  width={86}
                />
                <RechartsTooltip
                  formatter={(value: unknown, name: unknown) => {
                    if (typeof value === "number" && Number.isFinite(value)) {
                      return [`${value.toFixed(2)}%`, String(name ?? "Value")];
                    }
                    return ["N/A", String(name ?? "Value")];
                  }}
                  labelFormatter={(label: unknown) =>
                    formatTooltipDate(typeof label === "string" ? label : String(label ?? ""))
                  }
                  contentStyle={{
                    borderRadius: "0.5rem",
                    backgroundColor: "rgba(15, 23, 42, 0.95)",
                    borderColor: "rgba(148, 163, 184, 0.3)",
                  }}
                  itemStyle={{ color: "#f1f5f9" }}
                  labelStyle={{ color: "#f8fafc", fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: "12px" }} />
                {forecastStartDate && (
                  <ReferenceLine
                    x={forecastStartDate}
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                    label={{
                      value: "Forecast Start",
                      position: "insideTopLeft",
                      fill: "#94a3b8",
                      fontSize: 12,
                    }}
                  />
                )}
                {uniqueSelectedCountries.map((country) => (
                  <RechartsLine
                    key={country}
                    type="monotone"
                    dataKey={country}
                    name={country}
                    stroke={countryColors[country]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <Title>Net Injection Comparison</Title>
        <Text className="mt-2">Overlay of historical and forecast net injection trajectories (TWh/day).</Text>
        {netInjectionSeries.length === 0 ? (
          <Text className="mt-4 text-slate-300">No injection data available for the selected countries.</Text>
        ) : (
          <div className="mt-4 h-80">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={netInjectionSeries} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" strokeOpacity={0.45} />
                <XAxis
                  dataKey="date"
                  tickFormatter={formatDateLabel}
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickLine={false}
                  axisLine={{ stroke: "#475569", opacity: 0.6 }}
                />
                <YAxis
                  tick={{ fill: "#94a3b8", fontSize: 12 }}
                  tickFormatter={(value: number) => formatChartValue(value)}
                  tickLine={false}
                  axisLine={{ stroke: "#475569", opacity: 0.6 }}
                  width={86}
                />
                <RechartsTooltip
                  formatter={(value: unknown, name: unknown) => [formatTooltipValue(value), String(name ?? "Value")]}
                  labelFormatter={(label: unknown) =>
                    formatTooltipDate(typeof label === "string" ? label : String(label ?? ""))
                  }
                  contentStyle={{
                    borderRadius: "0.5rem",
                    backgroundColor: "rgba(15, 23, 42, 0.95)",
                    borderColor: "rgba(148, 163, 184, 0.3)",
                  }}
                  itemStyle={{ color: "#f1f5f9" }}
                  labelStyle={{ color: "#f8fafc", fontWeight: 600 }}
                />
                <Legend wrapperStyle={{ color: "#cbd5e1", fontSize: "12px" }} />
                {forecastStartDate && (
                  <ReferenceLine
                    x={forecastStartDate}
                    stroke="#94a3b8"
                    strokeDasharray="4 4"
                    label={{
                      value: "Forecast Start",
                      position: "insideTopLeft",
                      fill: "#94a3b8",
                      fontSize: 12,
                    }}
                  />
                )}
                {uniqueSelectedCountries.map((country) => (
                  <RechartsLine
                    key={country}
                    type="monotone"
                    dataKey={country}
                    name={country}
                    stroke={countryColors[country]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}
      </Card>

      <Card className="mt-6">
        <Title>Spread Snapshot</Title>
        <Table className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Country</TableHeaderCell>
              <TableHeaderCell>Current Fill %</TableHeaderCell>
              <TableHeaderCell>Forecast Fill % (J+14)</TableHeaderCell>
              <TableHeaderCell>Fill Change (14d, pp)</TableHeaderCell>
              <TableHeaderCell>Depletion Rate (pp/day)</TableHeaderCell>
              <TableHeaderCell>Net Injection (14d, TWh)</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {spreadRows.map((row) => (
              <TableRow key={row.country}>
                <TableCell>
                  {row.country} ({COUNTRY_LABEL_BY_CODE[row.country] ?? row.country})
                </TableCell>
                <TableCell>{formatPercent(row.currentFillPct, 2)}</TableCell>
                <TableCell>{formatPercent(row.forecastFillPct, 2)}</TableCell>
                <TableCell>{row.fillChange14d === null ? "N/A" : `${formatSigned(row.fillChange14d, 2)} pp`}</TableCell>
                <TableCell>
                  {row.depletionRatePpPerDay === null
                    ? "N/A"
                    : `${formatSigned(row.depletionRatePpPerDay, 3)} pp/day`}
                </TableCell>
                <TableCell>
                  {row.netInjection14dSum === null
                    ? "N/A"
                    : `${formatSigned(row.netInjection14dSum, 3)} (avg ${formatNumber(row.netInjection14dSum / Math.max(row.horizonDays, 1), 3)}/day)`}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
