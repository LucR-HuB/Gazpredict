import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Card, Grid, Metric, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, Title } from "@tremor/react";
import {
  Area as RechartsArea,
  Bar as RechartsBar,
  Brush,
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
import { dateToTimestamp, formatChartValue, formatDateLabel, formatNumber, formatSigned, formatTooltipDate, formatTooltipValue } from "../lib/formatters";
import { buildFluxSeries, buildTransitionSeries, calculateClimatology } from "../lib/transformers";
import type { HistoryWithNetInjection, TransitionPoint } from "../lib/types";

type CountryDeepDiveProps = {
  selectedCountry: string;
  history: HistoryWithNetInjection[];
  forecast: ForecastRecord[];
  threshold: number;
  historyLookbackDays: number;
};

type BrushWindow = {
  startIndex: number;
  endIndex: number;
};

type BrushWindowChange = {
  startIndex?: number;
  endIndex?: number;
};

const WINTER_END_MONTH_INDEX = 3;
const WINTER_END_DAY = 30;
const BRUSH_HEIGHT = 24;
const BRUSH_TRAVELLER_WIDTH = 12;
const WHEEL_PIXELS_PER_STEP = 36;
const BRUSH_MIN_VISIBLE_POINTS = 7;
const BRUSH_STEP_POINTS = 5;

export default function CountryDeepDive({
  selectedCountry,
  history,
  forecast,
  threshold,
  historyLookbackDays,
}: CountryDeepDiveProps) {
  const selectedCountryHistory = useMemo(() => {
    return history.filter((row) => row.country === selectedCountry);
  }, [history, selectedCountry]);

  const selectedCountryForecast = useMemo(() => {
    return forecast.filter((row) => row.country === selectedCountry);
  }, [forecast, selectedCountry]);

  const selectedCountryForecastNearTerm = useMemo(() => {
    return selectedCountryForecast.filter(
      (row) => !row.scenario || row.scenario === "actuel" || row.scenario === "forecast",
    );
  }, [selectedCountryForecast]);

  const predictionStartDate = useMemo(() => {
    if (selectedCountryForecast.length === 0) {
      return null;
    }

    return selectedCountryForecast.reduce((earliestDate, row) => {
      return dateToTimestamp(row.date) < dateToTimestamp(earliestDate) ? row.date : earliestDate;
    }, selectedCountryForecast[0].date);
  }, [selectedCountryForecast]);

  const climatologyByCountryDay = useMemo(() => calculateClimatology(history), [history]);

  const forecastSplitDate = useMemo(() => {
    if (selectedCountryForecastNearTerm.length === 0) {
      return null;
    }

    return selectedCountryForecastNearTerm.reduce((latestDate, row) => {
      return dateToTimestamp(row.date) > dateToTimestamp(latestDate) ? row.date : latestDate;
    }, selectedCountryForecastNearTerm[0].date);
  }, [selectedCountryForecastNearTerm]);

  const transitionSeriesRaw = useMemo(
    () =>
      buildTransitionSeries(
        selectedCountryHistory,
        selectedCountryForecast,
        climatologyByCountryDay,
        forecastSplitDate,
      ),
    [climatologyByCountryDay, forecastSplitDate, selectedCountryForecast, selectedCountryHistory],
  );

  const fluxSeriesRaw = useMemo(
    () => buildFluxSeries(selectedCountryHistory, selectedCountryForecast, forecastSplitDate),
    [forecastSplitDate, selectedCountryForecast, selectedCountryHistory],
  );

  const maxNavigationTs = useMemo(() => {
    let maxTs = Number.NEGATIVE_INFINITY;

    for (const row of transitionSeriesRaw) {
      maxTs = Math.max(maxTs, dateToTimestamp(row.date));
    }
    for (const row of fluxSeriesRaw) {
      maxTs = Math.max(maxTs, dateToTimestamp(row.date));
    }

    if (!Number.isFinite(maxTs)) {
      return null;
    }

    if (selectedCountryForecast.length === 0) {
      return maxTs;
    }

    const latestForecastDate = selectedCountryForecast[selectedCountryForecast.length - 1].date;
    const forecastYear = new Date(`${latestForecastDate}T00:00:00Z`).getUTCFullYear();
    const winterEndTs = Date.UTC(forecastYear, WINTER_END_MONTH_INDEX, WINTER_END_DAY);
    return Math.min(maxTs, winterEndTs);
  }, [fluxSeriesRaw, selectedCountryForecast, transitionSeriesRaw]);

  const transitionSeriesClamped = useMemo(() => {
    if (maxNavigationTs === null) {
      return [] as TransitionPoint[];
    }
    return transitionSeriesRaw.filter((row) => dateToTimestamp(row.date) <= maxNavigationTs);
  }, [maxNavigationTs, transitionSeriesRaw]);

  const fluxSeriesClamped = useMemo(() => {
    if (maxNavigationTs === null) {
      return [] as TransitionPoint[];
    }
    return fluxSeriesRaw.filter((row) => dateToTimestamp(row.date) <= maxNavigationTs);
  }, [fluxSeriesRaw, maxNavigationTs]);

  const { transitionSeries, fluxSeries, minNavigationDate, maxNavigationDate } = useMemo(() => {
    const transitionByDate = new Map(transitionSeriesClamped.map((row) => [row.date, row]));
    const fluxByDate = new Map(fluxSeriesClamped.map((row) => [row.date, row]));

    const uniqueDates = Array.from(new Set([...transitionByDate.keys(), ...fluxByDate.keys()])).sort(
      (a, b) => dateToTimestamp(a) - dateToTimestamp(b),
    );

    const alignedTransitionSeries = uniqueDates.map((date) => {
      return transitionByDate.get(date) ?? { date, dateLabel: formatDateLabel(date) };
    });
    const alignedFluxSeries = uniqueDates.map((date) => {
      return fluxByDate.get(date) ?? { date, dateLabel: formatDateLabel(date) };
    });

    return {
      transitionSeries: alignedTransitionSeries,
      fluxSeries: alignedFluxSeries,
      minNavigationDate: uniqueDates[0] ?? null,
      maxNavigationDate: uniqueDates[uniqueDates.length - 1] ?? null,
    };
  }, [fluxSeriesClamped, transitionSeriesClamped]);

  const [brushWindow, setBrushWindow] = useState<BrushWindow | null>(null);
  const transitionChartContainerRef = useRef<HTMLDivElement | null>(null);
  const fluxChartContainerRef = useRef<HTMLDivElement | null>(null);

  const predictionStartIndex = useMemo(() => {
    if (predictionStartDate === null || transitionSeries.length === 0) {
      return null;
    }

    const index = transitionSeries.findIndex((row) => row.date === predictionStartDate);
    return index >= 0 ? index : null;
  }, [predictionStartDate, transitionSeries]);

  useEffect(() => {
    if (transitionSeries.length === 0) {
      setBrushWindow(null);
      return;
    }

    const endIndex = transitionSeries.length - 1;
    const visiblePoints = Math.max(1, Math.min(historyLookbackDays, transitionSeries.length));
    const startIndex = Math.max(0, endIndex - visiblePoints + 1);
    setBrushWindow({ startIndex, endIndex });
  }, [historyLookbackDays, selectedCountry, transitionSeries.length]);

  const handleBrushChange = (nextWindow: BrushWindowChange): void => {
    if (transitionSeries.length === 0) {
      return;
    }

    const maxIndex = transitionSeries.length - 1;
    const startIndex = Math.max(0, Math.min(nextWindow.startIndex ?? 0, maxIndex));
    const endIndex = Math.max(startIndex, Math.min(nextWindow.endIndex ?? maxIndex, maxIndex));

    setBrushWindow((previous) => {
      if (previous && previous.startIndex === startIndex && previous.endIndex === endIndex) {
        return previous;
      }
      return { startIndex, endIndex };
    });
  };

  const zoomBrushWindow = useCallback((delta: number): void => {
    if (delta === 0 || transitionSeries.length === 0) {
      return;
    }

    const maxIndex = transitionSeries.length - 1;
    setBrushWindow((previous) => {
      if (!previous) {
        return previous;
      }

      const currentVisiblePoints = Math.max(previous.endIndex - previous.startIndex + 1, 1);
      const nextVisiblePoints = Math.max(
        BRUSH_MIN_VISIBLE_POINTS,
        Math.min(
          transitionSeries.length,
          currentVisiblePoints + delta * BRUSH_STEP_POINTS,
        ),
      );

      const anchorIndex = predictionStartIndex ?? Math.round((previous.startIndex + previous.endIndex) / 2);
      const leftPoints = Math.floor((nextVisiblePoints - 1) / 2);
      const rightPoints = nextVisiblePoints - 1 - leftPoints;
      let nextStart = anchorIndex - leftPoints;
      let nextEnd = anchorIndex + rightPoints;

      if (nextStart < 0) {
        nextEnd += -nextStart;
        nextStart = 0;
      }
      if (nextEnd > maxIndex) {
        const overflow = nextEnd - maxIndex;
        nextStart = Math.max(0, nextStart - overflow);
        nextEnd = maxIndex;
      }

      if (nextStart === previous.startIndex && nextEnd === previous.endIndex) {
        return previous;
      }

      return { startIndex: nextStart, endIndex: nextEnd };
    });
  }, [predictionStartIndex, transitionSeries.length]);

  const handleChartWheel = useCallback((event: WheelEvent): void => {
    const horizontalDelta =
      Math.abs(event.deltaX) >= Math.abs(event.deltaY) ? event.deltaX : (event.shiftKey ? event.deltaY : 0);

    if (horizontalDelta === 0) {
      return;
    }

    event.preventDefault();
    const shiftMagnitude = Math.max(1, Math.round(Math.abs(horizontalDelta) / WHEEL_PIXELS_PER_STEP));
    zoomBrushWindow(horizontalDelta > 0 ? shiftMagnitude : -shiftMagnitude);
  }, [zoomBrushWindow]);

  useEffect(() => {
    const containers = [transitionChartContainerRef.current, fluxChartContainerRef.current].filter(
      (container): container is HTMLDivElement => container !== null,
    );

    containers.forEach((container) => {
      container.addEventListener("wheel", handleChartWheel, { passive: false });
    });

    return () => {
      containers.forEach((container) => {
        container.removeEventListener("wheel", handleChartWheel);
      });
    };
  }, [handleChartWheel]);

  const renderBrushTraveller = (rawProps: unknown) => {
    const props = rawProps as { x?: number; y?: number; width?: number; height?: number };
    const x = props.x ?? 0;
    const y = props.y ?? 0;
    const width = props.width ?? BRUSH_TRAVELLER_WIDTH;
    const height = props.height ?? BRUSH_HEIGHT;

    const travellerHeight = Math.max(8, height - 2);
    const travellerY = y + (height - travellerHeight) / 2;
    const centerX = x + width / 2;

    return (
      <g>
        <rect
          x={x}
          y={travellerY}
          width={width}
          height={travellerHeight}
          rx={4}
          fill="rgba(15, 23, 42, 0.95)"
          stroke="rgba(103, 232, 249, 0.95)"
          strokeWidth={1}
        />
        <line
          x1={centerX - 2}
          y1={travellerY + 4}
          x2={centerX - 2}
          y2={travellerY + travellerHeight - 4}
          stroke="rgba(103, 232, 249, 0.95)"
          strokeWidth={1}
        />
        <line
          x1={centerX + 2}
          y1={travellerY + 4}
          x2={centerX + 2}
          y2={travellerY + travellerHeight - 4}
          stroke="rgba(103, 232, 249, 0.95)"
          strokeWidth={1}
        />
      </g>
    );
  };

  const currentCountryStock =
    selectedCountryHistory.length > 0 ? selectedCountryHistory[selectedCountryHistory.length - 1].stock_twh : null;

  const currentCountryNetInjection =
    selectedCountryHistory.length > 0 ? selectedCountryHistory[selectedCountryHistory.length - 1].net_injection : null;

  const forecastCountryJ14 =
    selectedCountryForecastNearTerm.length > 0
      ? selectedCountryForecastNearTerm[selectedCountryForecastNearTerm.length - 1].prediction_twh
      : null;

  const countryNetChange =
    currentCountryStock !== null && forecastCountryJ14 !== null
      ? forecastCountryJ14 - currentCountryStock
      : null;

  const highWithdrawalHits = selectedCountryForecastNearTerm.filter((row) => row.net_injection < threshold);

  return (
    <>
      <Card className="mt-6">
        <Title>Country Analysis - {selectedCountry || "N/A"}</Title>
        <Grid numItems={1} numItemsSm={2} numItemsLg={3} className="mt-4 gap-6">
          <Card decoration="top" decorationColor="blue">
            <Text>Current Stock (TWh)</Text>
            <Metric>{formatNumber(currentCountryStock, 2)}</Metric>
            <Text className="mt-2">
              {currentCountryNetInjection === null
                ? "N/A vs prev day"
                : `${formatSigned(currentCountryNetInjection, 2)} vs prev day`}
            </Text>
          </Card>
          <Card decoration="top" decorationColor="indigo">
            <Text>Forecasted Stock (J+14)</Text>
            <Metric>{formatNumber(forecastCountryJ14, 2)}</Metric>
            <Text className="mt-2">End of current forecast horizon</Text>
          </Card>
          <Card decoration="top" decorationColor={countryNetChange !== null && countryNetChange < 0 ? "red" : "emerald"}>
            <Text>Net Change (J+14 - Now)</Text>
            <Metric>{formatSigned(countryNetChange, 2)} TWh</Metric>
            <Text className="mt-2">
              {countryNetChange === null ? "N/A" : (countryNetChange >= 0 ? "Injection" : "Withdrawal")}
            </Text>
          </Card>
        </Grid>
      </Card>

      <Card className="mt-6">
        <Title>Actual → Forecast Transition</Title>
        <Text className="mt-2 text-xs text-slate-400">
          Forecast split: ≤J+14 ({forecastSplitDate ?? "N/A"}) vs post-J+14. Navigate from{" "}
          {minNavigationDate ? formatTooltipDate(minNavigationDate) : "N/A"} to{" "}
          {maxNavigationDate ? formatTooltipDate(maxNavigationDate) : "N/A"} (max bound: Mar 31).
        </Text>
        <div ref={transitionChartContainerRef} className="mt-4 h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={transitionSeries}
              margin={{ top: 8, right: 16, left: 4, bottom: 24 }}
              syncId="country-time-window"
            >
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
                width={70}
              />
              <RechartsTooltip
                formatter={(value: unknown, name: unknown, item: unknown) => {
                  const tooltipItem = (item ?? {}) as {
                    dataKey?: string;
                    payload?: TransitionPoint;
                  };

                  if (tooltipItem.dataKey === "clim_min") {
                    return null;
                  }

                  if (tooltipItem.dataKey === "clim_diff") {
                    const min = tooltipItem.payload?.clim_min;
                    const diff = tooltipItem.payload?.clim_diff;
                    if (typeof min !== "number" || typeof diff !== "number") {
                      return ["N/A", "5y Range"];
                    }
                    return [`${formatChartValue(min)} - ${formatChartValue(min + diff)}`, "5y Range"];
                  }

                  if (tooltipItem.dataKey === "clim_avg") {
                    return [formatTooltipValue(value), "5y Avg"];
                  }

                  return [formatTooltipValue(value), String(name ?? "Value")];
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
              {forecastSplitDate && (
                <ReferenceLine
                  x={forecastSplitDate}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: "J+14", position: "insideTopRight", fill: "#fbbf24", fontSize: 11 }}
                />
              )}
              <RechartsArea
                type="monotone"
                dataKey="clim_min"
                stackId="clim"
                fill="none"
                stroke="none"
                legendType="none"
                name="__clim_base"
                isAnimationActive={false}
              />
              <RechartsArea
                type="monotone"
                dataKey="clim_diff"
                stackId="clim"
                name="5y Range"
                fill="#94a3b8"
                opacity={0.15}
                stroke="none"
                connectNulls
                isAnimationActive={false}
              />
              <RechartsLine
                type="monotone"
                dataKey="clim_avg"
                name="5y Avg"
                stroke="#94a3b8"
                strokeDasharray="5 5"
                dot={false}
                strokeWidth={1}
                connectNulls
              />
              <RechartsLine type="monotone" dataKey="Actual" name="Actual" stroke="#3b82f6" strokeWidth={2} dot={false} />
              <RechartsLine
                type="monotone"
                dataKey="ForecastJ14"
                name="Forecast (≤J+14)"
                stroke="#ef4444"
                strokeWidth={2}
                dot={false}
              />
              <RechartsLine
                type="monotone"
                dataKey="ForecastAfterJ14"
                name="Forecast (>J+14)"
                stroke="#f59e0b"
                strokeWidth={2}
                strokeDasharray="6 4"
                dot={false}
              />
              <RechartsLine
                type="monotone"
                dataKey="stock_upper"
                name="Stock Upper"
                stroke="#82ca9d"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1}
                connectNulls
              />
              <RechartsLine
                type="monotone"
                dataKey="stock_lower"
                name="Stock Lower"
                stroke="#82ca9d"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1}
                connectNulls
              />
              <Brush
                dataKey="date"
                className="country-chart-brush"
                height={BRUSH_HEIGHT}
                travellerWidth={BRUSH_TRAVELLER_WIDTH}
                stroke="rgba(56, 189, 248, 0.75)"
                fill="rgba(8, 47, 73, 0.35)"
                tickFormatter={formatDateLabel}
                traveller={renderBrushTraveller}
                startIndex={brushWindow?.startIndex ?? 0}
                endIndex={brushWindow?.endIndex ?? Math.max(0, transitionSeries.length - 1)}
                onChange={handleBrushChange}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="mt-6">
        <Title>Net Injection (Actual vs Forecast)</Title>
        <div ref={fluxChartContainerRef} className="mt-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart
              data={fluxSeries}
              margin={{ top: 8, right: 16, left: 4, bottom: 24 }}
              syncId="country-time-window"
            >
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
                width={70}
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
              {forecastSplitDate && (
                <ReferenceLine
                  x={forecastSplitDate}
                  stroke="#f59e0b"
                  strokeDasharray="4 4"
                  label={{ value: "J+14", position: "insideTopRight", fill: "#fbbf24", fontSize: 11 }}
                />
              )}
              <RechartsBar dataKey="Actual" name="Actual" fill="#3b82f6" />
              <RechartsBar dataKey="ForecastJ14" name="Forecast (≤J+14)" fill="#ef4444" />
              <RechartsBar dataKey="ForecastAfterJ14" name="Forecast (>J+14)" fill="#f59e0b" />
              <RechartsLine
                type="monotone"
                dataKey="injection_upper"
                name="Injection Upper"
                stroke="#82ca9d"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1}
                connectNulls
              />
              <RechartsLine
                type="monotone"
                dataKey="injection_lower"
                name="Injection Lower"
                stroke="#82ca9d"
                strokeDasharray="3 3"
                dot={false}
                strokeWidth={1}
                connectNulls
              />
              <Brush
                dataKey="date"
                className="country-chart-brush"
                height={BRUSH_HEIGHT}
                travellerWidth={BRUSH_TRAVELLER_WIDTH}
                stroke="rgba(56, 189, 248, 0.75)"
                fill="rgba(8, 47, 73, 0.35)"
                tickFormatter={formatDateLabel}
                traveller={renderBrushTraveller}
                startIndex={brushWindow?.startIndex ?? 0}
                endIndex={brushWindow?.endIndex ?? Math.max(0, fluxSeries.length - 1)}
                onChange={handleBrushChange}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="mt-6">
        <Title>Next 14 Days Forecast Table</Title>
        <Table className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Date</TableHeaderCell>
              <TableHeaderCell>Country</TableHeaderCell>
              <TableHeaderCell>Net Inj (TWh/day)</TableHeaderCell>
              <TableHeaderCell>Stock (TWh)</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {selectedCountryForecastNearTerm.map((row) => (
              <TableRow key={`${row.country}-${row.date}`}>
                <TableCell>{row.date}</TableCell>
                <TableCell>{row.country}</TableCell>
                <TableCell>{formatSigned(row.net_injection, 3)}</TableCell>
                <TableCell>{formatNumber(row.prediction_twh, 3)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      <Card className="mt-6">
        <Title>Alerts</Title>
        {highWithdrawalHits.length === 0 ? (
          <Text className="mt-3 text-green-700">
            No high withdrawal signal detected (threshold: {threshold.toFixed(1)} TWh/day).
          </Text>
        ) : (
          <Text className="mt-3 text-red-700">
            High Withdrawal Alert on {highWithdrawalHits.map((row) => row.date).join(", ")}. Worst day:{" "}
            {formatNumber(Math.min(...highWithdrawalHits.map((row) => row.net_injection)), 3)} TWh/day.
          </Text>
        )}
      </Card>
    </>
  );
}
