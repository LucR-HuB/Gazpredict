import { useMemo } from "react";
import { Card, Grid, Metric, Table, TableBody, TableCell, TableHead, TableHeaderCell, TableRow, Text, Title } from "@tremor/react";
import {
  Area as RechartsArea,
  Bar as RechartsBar,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line as RechartsLine,
  ResponsiveContainer,
  Tooltip as RechartsTooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { ForecastRecord } from "../lib/api";
import { DAY_MS, dateToTimestamp, formatChartValue, formatDateLabel, formatNumber, formatSigned, formatTooltipDate, formatTooltipValue } from "../lib/formatters";
import { buildFluxSeries, buildTransitionSeries, calculateClimatology } from "../lib/transformers";
import type { HistoryWithNetInjection, TransitionPoint } from "../lib/types";

type CountryDeepDiveProps = {
  selectedCountry: string;
  history: HistoryWithNetInjection[];
  forecast: ForecastRecord[];
  threshold: number;
  historyLookbackDays: number;
};

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

  const climatologyByCountryDay = useMemo(() => calculateClimatology(history), [history]);

  const historyWindow = useMemo(() => {
    if (selectedCountryHistory.length === 0) {
      return [] as HistoryWithNetInjection[];
    }

    const maxTs = dateToTimestamp(selectedCountryHistory[selectedCountryHistory.length - 1].date);
    const minTs = maxTs - (historyLookbackDays - 1) * DAY_MS;
    return selectedCountryHistory.filter((row) => dateToTimestamp(row.date) >= minTs);
  }, [historyLookbackDays, selectedCountryHistory]);

  const transitionSeries = useMemo(
    () => buildTransitionSeries(historyWindow, selectedCountryForecast, climatologyByCountryDay),
    [climatologyByCountryDay, historyWindow, selectedCountryForecast],
  );

  const fluxSeries = useMemo(
    () => buildFluxSeries(historyWindow, selectedCountryForecast),
    [historyWindow, selectedCountryForecast],
  );

  const currentCountryStock =
    selectedCountryHistory.length > 0 ? selectedCountryHistory[selectedCountryHistory.length - 1].stock_twh : null;

  const currentCountryNetInjection =
    selectedCountryHistory.length > 0 ? selectedCountryHistory[selectedCountryHistory.length - 1].net_injection : null;

  const forecastCountryJ14 =
    selectedCountryForecast.length > 0
      ? selectedCountryForecast[selectedCountryForecast.length - 1].prediction_twh
      : null;

  const countryNetChange =
    currentCountryStock !== null && forecastCountryJ14 !== null
      ? forecastCountryJ14 - currentCountryStock
      : null;

  const highWithdrawalHits = selectedCountryForecast.filter((row) => row.net_injection < threshold);

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
        <div className="mt-4 h-80">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={transitionSeries} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
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
              <RechartsLine type="monotone" dataKey="Forecast" name="Forecast" stroke="#ef4444" strokeWidth={2} dot={false} />
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
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </Card>

      <Card className="mt-6">
        <Title>Net Injection (Actual vs Forecast)</Title>
        <div className="mt-4 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={fluxSeries} margin={{ top: 8, right: 16, left: 4, bottom: 8 }}>
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
              <RechartsBar dataKey="Actual" name="Actual" fill="#3b82f6" />
              <RechartsBar dataKey="Forecast" name="Forecast" fill="#ef4444" />
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
            {selectedCountryForecast.map((row) => (
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
