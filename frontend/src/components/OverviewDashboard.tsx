import { useMemo } from "react";
import {
  Badge,
  BarChart,
  Card,
  Grid,
  LineChart,
  Metric,
  ProgressBar,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Text,
  Title,
} from "@tremor/react";
import type { CustomTooltipProps } from "@tremor/react";
import { formatChartValue, formatNumber, formatSigned, formatTooltipDate, formatTooltipValue } from "../lib/formatters";
import type {
  MapMetric,
  MapPoint,
  MapProjection,
  OverviewForecastChart,
  OverviewRiskRow,
  OverviewRow,
  TooltipPayloadItem,
} from "../lib/types";
import WorldMap from "./WorldMap";

const OVERVIEW_CARD_CLASS =
  "bg-slate-900/60 ring-0 shadow-[0_16px_36px_-28px_rgba(15,23,42,0.9)]";
const OVERVIEW_PANEL_CLASS =
  "rounded-xl bg-slate-900/55 p-3 shadow-[0_14px_30px_-24px_rgba(15,23,42,0.95)]";
const OVERVIEW_FORECAST_COLORS = ["cyan", "blue", "indigo", "violet", "fuchsia", "emerald", "slate"];

type OverviewDashboardProps = {
  overviewRows: OverviewRow[];
  overviewForecastChart: OverviewForecastChart;
  overviewRiskSeries: OverviewRiskRow[];
  highWithdrawalThreshold14d: number;
  mapPoints: MapPoint[];
  mapMetric: MapMetric;
  mapProjection: MapProjection;
  onMapMetricChange: (metric: MapMetric) => void;
  onMapProjectionChange: (projection: MapProjection) => void;
  onMapCountryClick: (countryCode: string) => void;
};

function DateTooltip({ active, payload, label }: CustomTooltipProps) {
  if (!active || !payload || payload.length === 0) {
    return null;
  }

  const items = payload as unknown as TooltipPayloadItem[];
  const payloadDate = items[0]?.payload?.date;
  const rawDate = typeof payloadDate === "string" ? payloadDate : typeof label === "string" ? label : "";
  const title = formatTooltipDate(rawDate);

  return (
    <div className="rounded-md bg-slate-900/95 px-3 py-2 shadow-[0_18px_34px_-20px_rgba(15,23,42,0.95)] backdrop-blur">
      <div className="mb-2 text-xs font-semibold text-slate-100">{title}</div>
      <div className="space-y-1">
        {items.map((item) => (
          <div key={String(item.name ?? "value")} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-xs text-slate-300">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: item.color ?? "#94a3b8" }} />
              {String(item.name ?? "Value")}
            </span>
            <span className="text-xs font-semibold text-slate-100">{formatTooltipValue(item.value)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function OverviewDashboard({
  overviewRows,
  overviewForecastChart,
  overviewRiskSeries,
  highWithdrawalThreshold14d,
  mapPoints,
  mapMetric,
  mapProjection,
  onMapMetricChange,
  onMapProjectionChange,
  onMapCountryClick,
}: OverviewDashboardProps) {
  const totalCountriesTracked = overviewRows.length;
  const countriesInAlert = useMemo(() => overviewRows.filter((row) => row.alert).length, [overviewRows]);
  const totalNetInjection14d = useMemo(
    () => overviewRows.reduce((sum, row) => sum + (row.forecastedInjection14dSum ?? 0), 0),
    [overviewRows],
  );
  const totalCurrentStock = useMemo(
    () => overviewRows.reduce((sum, row) => sum + (row.currentStockTwh ?? 0), 0),
    [overviewRows],
  );
  const countriesInWithdrawal = useMemo(
    () => overviewRows.filter((row) => (row.forecastedInjection14dSum ?? 0) < 0).length,
    [overviewRows],
  );

  const statusBadgeColor: Record<OverviewRow["status"], "red" | "orange" | "emerald"> = {
    Alert: "red",
    Watch: "orange",
    Stable: "emerald",
  };

  const alertSharePct = totalCountriesTracked > 0 ? (countriesInAlert / totalCountriesTracked) * 100 : 0;
  const withdrawalSharePct =
    totalCountriesTracked > 0 ? (countriesInWithdrawal / totalCountriesTracked) * 100 : 0;

  return (
    <>
      <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
        <Text>Helicopter View</Text>
        <Title>All Countries - System Snapshot</Title>
      </Card>

      <Grid numItems={1} numItemsSm={2} numItemsLg={4} className="mt-6 gap-6">
        <Card decoration="top" decorationColor="slate" className={OVERVIEW_CARD_CLASS}>
          <Text>Countries Tracked</Text>
          <Metric>{totalCountriesTracked}</Metric>
          <Text className="mt-2">Coverage of monitoring scope</Text>
        </Card>
        <Card
          decoration="top"
          decorationColor={countriesInAlert > 0 ? "red" : "green"}
          className={OVERVIEW_CARD_CLASS}
        >
          <Text>Countries in Alert</Text>
          <Metric>{countriesInAlert}</Metric>
          <Text className="mt-2">Low stock or heavy 14d withdrawal</Text>
        </Card>
        <Card
          decoration="top"
          decorationColor={totalNetInjection14d >= 0 ? "green" : "orange"}
          className={OVERVIEW_CARD_CLASS}
        >
          <Text>Net Injection (14d)</Text>
          <Metric>{formatSigned(totalNetInjection14d, 2)} TWh</Metric>
          <Text className="mt-2">Portfolio projected balance</Text>
        </Card>
        <Card decoration="top" decorationColor="indigo" className={OVERVIEW_CARD_CLASS}>
          <Text>Scenario</Text>
          <Metric>Base Case</Metric>
          <Text className="mt-2">Total current stock: {formatNumber(totalCurrentStock, 1)} TWh</Text>
        </Card>
      </Grid>

      <Grid numItems={1} numItemsLg={2} className="mt-6 gap-6">
        <Card className={OVERVIEW_CARD_CLASS}>
          <Title>Projected 14-Day Balance by Country</Title>
          <Text>Positive: expected injection, Negative: expected withdrawal</Text>
          <BarChart
            className="mt-4 h-80"
            data={overviewRiskSeries}
            index="Country"
            categories={["Forecasted Injection (14d Sum)"]}
            colors={["blue"]}
            yAxisWidth={100}
            layout="horizontal"
            showAnimation
            valueFormatter={formatChartValue}
          />
        </Card>
        <Card className={OVERVIEW_CARD_CLASS}>
          <Title>Risk Snapshot</Title>
          <Text className="mt-3">Alert Exposure: {alertSharePct.toFixed(0)}%</Text>
          <ProgressBar value={alertSharePct} color={countriesInAlert > 0 ? "red" : "emerald"} className="mt-2" />
          <Text className="mt-4">Countries with Net Withdrawal: {withdrawalSharePct.toFixed(0)}%</Text>
          <ProgressBar value={withdrawalSharePct} color="orange" className="mt-2" />
          <div className={`mt-6 ${OVERVIEW_PANEL_CLASS}`}>
            <Text>Alert Rule</Text>
            <Text className="mt-1">
              Stock {"<"} 10% or 14d withdrawal {">"} {highWithdrawalThreshold14d.toFixed(1)} TWh
            </Text>
          </div>
        </Card>
      </Grid>

      <WorldMap
        mapPoints={mapPoints}
        metric={mapMetric}
        projection={mapProjection}
        onMetricChange={onMapMetricChange}
        onProjectionChange={onMapProjectionChange}
        onCountryClick={onMapCountryClick}
      />

      <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
        <Title>Storage Forecast by Country (TWh)</Title>
        <Text>
          {overviewForecastChart.visibleCountryCount === 0
            ? "Projected gas levels for the available forecast horizon."
            : overviewForecastChart.hiddenCountryCount > 0
              ? `Top ${overviewForecastChart.visibleCountryCount} countries are shown individually; ${overviewForecastChart.hiddenCountryCount} countries are grouped as Others.`
              : `All ${overviewForecastChart.visibleCountryCount} countries are shown individually.`}
        </Text>
        <LineChart
          className="mt-4 h-80"
          data={overviewForecastChart.data}
          index="date"
          categories={overviewForecastChart.categories}
          colors={OVERVIEW_FORECAST_COLORS.slice(0, overviewForecastChart.categories.length)}
          yAxisWidth={70}
          showAnimation
          customTooltip={DateTooltip}
          connectNulls
          valueFormatter={formatChartValue}
        />
      </Card>

      <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
        <Title>Country Status Table</Title>
        <Table className="mt-4">
          <TableHead>
            <TableRow>
              <TableHeaderCell>Country</TableHeaderCell>
              <TableHeaderCell>Status</TableHeaderCell>
              <TableHeaderCell>Stock (%)</TableHeaderCell>
              <TableHeaderCell>Current Stock (TWh)</TableHeaderCell>
              <TableHeaderCell>Forecasted Injection (14d Sum)</TableHeaderCell>
              <TableHeaderCell>Trend</TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {overviewRows.map((row) => (
              <TableRow key={row.country}>
                <TableCell>{row.country}</TableCell>
                <TableCell>
                  <Badge color={statusBadgeColor[row.status]}>{row.status}</Badge>
                </TableCell>
                <TableCell>{formatNumber(row.stockPct, 1)}</TableCell>
                <TableCell>{formatNumber(row.currentStockTwh, 2)}</TableCell>
                <TableCell>{formatSigned(row.forecastedInjection14dSum, 2)}</TableCell>
                <TableCell>{row.trend}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  );
}
