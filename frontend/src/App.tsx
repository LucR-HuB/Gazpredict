import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Badge,
  BarChart,
  Button,
  Card,
  Flex,
  Grid,
  LineChart,
  Metric,
  ProgressBar,
  Select,
  SelectItem,
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
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
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Config, Data, Layout, PlotMouseEvent } from "plotly.js";
import {
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
import { getForecast, getGieHistory, getSystemMetrics, runPipeline } from "./lib/api";
import type { ForecastRecord, HistoryRecord, SystemMetrics } from "./lib/api";

const DAY_MS = 24 * 60 * 60 * 1000;
const WITHDRAWAL_ALERT_THRESHOLD_DAY = -0.5;
const DEFAULT_WITHDRAWAL_THRESHOLD_14D = 5.0;
const DEFAULT_HISTORY_LOOKBACK_DAYS = 365;
const Plot = createPlotlyComponent(Plotly);

const ISO2_TO_ISO3: Record<string, string> = {
  AT: "AUT",
  BE: "BEL",
  BG: "BGR",
  CH: "CHE",
  CZ: "CZE",
  DE: "DEU",
  DK: "DNK",
  ES: "ESP",
  FI: "FIN",
  FR: "FRA",
  GB: "GBR",
  GR: "GRC",
  HR: "HRV",
  HU: "HUN",
  IE: "IRL",
  IT: "ITA",
  LT: "LTU",
  LU: "LUX",
  LV: "LVA",
  NL: "NLD",
  NO: "NOR",
  PL: "POL",
  PT: "PRT",
  RO: "ROU",
  SE: "SWE",
  SI: "SVN",
  SK: "SVK",
};

const COUNTRY_LABEL_BY_CODE: Record<string, string> = {
  AT: "Austria",
  BE: "Belgium",
  BG: "Bulgaria",
  CH: "Switzerland",
  CZ: "Czechia",
  DE: "Germany",
  DK: "Denmark",
  ES: "Spain",
  FI: "Finland",
  FR: "France",
  GB: "United Kingdom",
  GR: "Greece",
  HR: "Croatia",
  HU: "Hungary",
  IE: "Ireland",
  IT: "Italy",
  LT: "Lithuania",
  LU: "Luxembourg",
  LV: "Latvia",
  NL: "Netherlands",
  NO: "Norway",
  PL: "Poland",
  PT: "Portugal",
  RO: "Romania",
  SE: "Sweden",
  SI: "Slovenia",
  SK: "Slovakia",
};

type ChartPoint = {
  date: string;
  dateLabel: string;
  [countryCode: string]: string | number;
};

type HistoryWithNetInjection = HistoryRecord & {
  net_injection: number | null;
};

type OverviewStatus = "Alert" | "Watch" | "Stable";

type OverviewRow = {
  country: string;
  currentStockTwh: number | null;
  stockPct: number | null;
  forecastedInjection14dSum: number | null;
  forecastedStockJ14: number | null;
  trend: string;
  status: OverviewStatus;
  alert: boolean;
};

type TransitionPoint = {
  date: string;
  dateLabel: string;
  Actual?: number;
  Forecast?: number;
  stock_upper?: number;
  stock_lower?: number;
  injection_upper?: number;
  injection_lower?: number;
};

type ForecastExportRow = {
  date: string;
  country: string;
  prediction_twh: number;
  net_injection: number;
  scenario: string;
  temp_shock_c: number;
};

type OverviewForecastChart = {
  data: ChartPoint[];
  categories: string[];
  hiddenCountryCount: number;
  visibleCountryCount: number;
};

type MapPoint = {
  iso3: string;
  countryCode: string;
  countryLabel: string;
  stockTwh: number | null;
  stockPct: number | null;
  forecastedInjection14dSum: number | null;
  status: OverviewStatus;
};

type MapCountryDetails = {
  countryCode: string;
  countryLabel: string;
  currentStockTwh: number | null;
  stockPct: number | null;
  currentNetInjection: number | null;
  forecastStockJ14: number | null;
  netChangeJ14: number | null;
  forecastedInjection14dSum: number | null;
  status: OverviewStatus;
};

type MapPopupPosition = {
  left: number;
  top: number;
};

type MapMetric = "stock" | "fill" | "injection";

type MapStatusFilter = "All" | OverviewStatus;

type MapProjection = "natural earth" | "mercator";

type MapMetricOption = {
  key: MapMetric;
  label: string;
  helper: string;
};

type MapProjectionOption = {
  key: MapProjection;
  label: string;
};

type MapMetricConfig = {
  colorbarTitle: string;
  colorscale: [number, string][];
  format: (value: number) => string;
};

type FullscreenElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type TooltipPayloadItem = {
  color?: string;
  name?: string | number;
  value?: unknown;
  payload?: { date?: string };
};

const MAP_METRIC_OPTIONS: MapMetricOption[] = [
  { key: "stock", label: "Stock (TWh)", helper: "Current stored gas volume" },
  { key: "fill", label: "Fill (%)", helper: "Storage filling level" },
  { key: "injection", label: "14d Injection", helper: "Forecasted net flow over 14 days" },
];

const MAP_STATUS_FILTER_OPTIONS: MapStatusFilter[] = ["All", "Alert", "Watch", "Stable"];

const MAP_PROJECTION_OPTIONS: MapProjectionOption[] = [
  { key: "natural earth", label: "Natural Earth" },
  { key: "mercator", label: "Mercator" },
];

const STATUS_ACCENT_COLOR: Record<OverviewStatus, string> = {
  Alert: "#f43f5e",
  Watch: "#fb923c",
  Stable: "#34d399",
};

const OVERVIEW_CARD_CLASS =
  "bg-slate-900/60 ring-0 shadow-[0_16px_36px_-28px_rgba(15,23,42,0.9)]";
const OVERVIEW_PANEL_CLASS =
  "rounded-xl bg-slate-900/55 p-3 shadow-[0_14px_30px_-24px_rgba(15,23,42,0.95)]";
const OVERVIEW_CHIP_BASE_CLASS =
  "rounded-full px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-300/40";
const OVERVIEW_CHIP_IDLE_CLASS =
  "bg-slate-800/70 text-slate-300 hover:bg-slate-700/80 hover:text-slate-100 shadow-[0_8px_20px_-18px_rgba(15,23,42,0.9)]";
const OVERVIEW_MAP_HEIGHT = "clamp(540px, 58vw, 920px)";
const MAP_POPUP_MARGIN = 16;
const MAP_POPUP_OFFSET = 20;
const MAP_POPUP_MAX_WIDTH = 420;
const MAP_POPUP_ESTIMATED_HEIGHT = 320;
const OVERVIEW_FORECAST_TOP_COUNTRIES = 6;
const OVERVIEW_FORECAST_COLORS = ["cyan", "blue", "indigo", "violet", "fuchsia", "emerald", "slate"];
const DEFAULT_SYSTEM_METRICS: SystemMetrics = {
  r2: 0,
  mae: 0,
  rmse: 0,
  wape: 0,
  message: "No model trained yet",
};

function dateToTimestamp(date: string): number {
  const normalized = date.includes("T") ? date : `${date}T00:00:00Z`;
  const parsed = Date.parse(normalized);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function formatDateLabel(date: string): string {
  const normalized = date.includes("T") ? date : `${date}T00:00:00Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", { month: "short", year: "2-digit" }).format(parsed);
}

function formatTooltipDate(date: string): string {
  const normalized = date.includes("T") ? date : `${date}T00:00:00Z`;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
  }).format(parsed);
}

function formatChartValue(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

function formatTooltipValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatChartValue(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "N/A";
}

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
              <span
                className="h-2 w-2 rounded-full"
                style={{ backgroundColor: item.color ?? "#94a3b8" }}
              />
              {String(item.name ?? "Value")}
            </span>
            <span className="text-xs font-semibold text-slate-100">
              {formatTooltipValue(item.value)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatNumber(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "N/A";
  }
  return value.toFixed(digits);
}

function formatSigned(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "N/A";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

function getMapPopupPosition(clickEvent: MouseEvent, container: HTMLDivElement): MapPopupPosition {
  const bounds = container.getBoundingClientRect();
  const containerWidth = bounds.width;
  const containerHeight = bounds.height;
  const pointerX = clickEvent.clientX - bounds.left;
  const pointerY = clickEvent.clientY - bounds.top;
  const popupWidth = Math.min(MAP_POPUP_MAX_WIDTH, Math.max(280, containerWidth - MAP_POPUP_MARGIN * 2));

  let left = pointerX + MAP_POPUP_OFFSET;
  if (left + popupWidth + MAP_POPUP_MARGIN > containerWidth) {
    left = pointerX - popupWidth - MAP_POPUP_OFFSET;
  }
  left = Math.max(MAP_POPUP_MARGIN, Math.min(left, containerWidth - popupWidth - MAP_POPUP_MARGIN));

  let top = pointerY - MAP_POPUP_ESTIMATED_HEIGHT * 0.35;
  if (top + MAP_POPUP_ESTIMATED_HEIGHT + MAP_POPUP_MARGIN > containerHeight) {
    top = containerHeight - MAP_POPUP_ESTIMATED_HEIGHT - MAP_POPUP_MARGIN;
  }
  top = Math.max(MAP_POPUP_MARGIN, top);

  return { left, top };
}

function getMapMetricValue(point: MapPoint, metric: MapMetric): number | null {
  if (metric === "stock") {
    return point.stockTwh;
  }
  if (metric === "fill") {
    return point.stockPct;
  }
  return point.forecastedInjection14dSum;
}

function getMapMetricConfig(metric: MapMetric): MapMetricConfig {
  if (metric === "fill") {
    return {
      colorbarTitle: "Fill (%)",
      colorscale: [
        [0, "#7f1d1d"],
        [0.3, "#ea580c"],
        [0.6, "#eab308"],
        [1, "#15803d"],
      ],
      format: (value) => `${value.toFixed(1)}%`,
    };
  }

  if (metric === "injection") {
    return {
      colorbarTitle: "14d Injection (TWh)",
      colorscale: [
        [0, "#881337"],
        [0.45, "#fb7185"],
        [0.5, "#e2e8f0"],
        [0.55, "#86efac"],
        [1, "#065f46"],
      ],
      format: (value) => `${value >= 0 ? "+" : ""}${value.toFixed(2)} TWh`,
    };
  }

  return {
    colorbarTitle: "Stock (TWh)",
    colorscale: [
      [0, "#0f172a"],
      [0.25, "#0f766e"],
      [0.55, "#22c55e"],
      [0.8, "#bef264"],
      [1, "#fde047"],
    ],
    format: (value) => `${value.toFixed(2)} TWh`,
  };
}

function parseNumericInput(
  value: number | string | null | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === null || value === undefined) {
    return fallback;
  }

  const parsed =
    typeof value === "number" ? value : Number.parseFloat(value.trim().replace(",", "."));

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(Math.max(parsed, min), max);
}

function getCountryCodeFromCustomData(customData: unknown): string | null {
  if (typeof customData === "string") {
    return customData.toUpperCase();
  }
  if (Array.isArray(customData) && typeof customData[0] === "string") {
    return customData[0].toUpperCase();
  }
  return null;
}

function sortHistoryRecords(rows: HistoryRecord[]): HistoryRecord[] {
  return [...rows].sort(
    (a, b) => a.country.localeCompare(b.country) || dateToTimestamp(a.date) - dateToTimestamp(b.date),
  );
}

function sortForecastRecords(rows: ForecastRecord[]): ForecastRecord[] {
  return [...rows].sort(
    (a, b) => a.country.localeCompare(b.country) || dateToTimestamp(a.date) - dateToTimestamp(b.date),
  );
}

function buildOverviewForecastChart(rows: ForecastRecord[], maxVisibleCountries: number): OverviewForecastChart {
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

function withNetInjection(historyRows: HistoryRecord[]): HistoryWithNetInjection[] {
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

function buildOverviewRows(
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

  const forecastAggByCountry = new Map<
    string,
    { sum14d: number; lastStock: number; lastDate: string }
  >();

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

function buildTransitionSeries(
  historyRows: HistoryWithNetInjection[],
  forecastRows: ForecastRecord[],
): TransitionPoint[] {
  const byDate = new Map<string, TransitionPoint>();

  for (const row of historyRows) {
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Actual = row.stock_twh;
    byDate.set(row.date, existing);
  }

  for (const row of forecastRows) {
    const existing = byDate.get(row.date) ?? { date: row.date, dateLabel: formatDateLabel(row.date) };
    existing.Forecast = row.prediction_twh;
    if (row.stock_upper !== null) {
      existing.stock_upper = row.stock_upper;
    }
    if (row.stock_lower !== null) {
      existing.stock_lower = row.stock_lower;
    }
    byDate.set(row.date, existing);
  }

  return Array.from(byDate.values()).sort((a, b) => dateToTimestamp(a.date) - dateToTimestamp(b.date));
}

function buildFluxSeries(
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

function findDateGaps(rows: Array<{ date: string }>): string[] {
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

function downloadForecastCsv(rows: ForecastExportRow[]): void {
  const header = ["date", "country", "prediction_twh", "net_injection", "scenario", "temp_shock_c"];
  const body = rows.map((row) =>
    [
      row.date,
      row.country,
      row.prediction_twh.toString(),
      row.net_injection.toString(),
      row.scenario,
      row.temp_shock_c.toString(),
    ].join(","),
  );

  const csv = `${header.join(",")}\n${body.join("\n")}`;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = "forecast_generated_base.csv";
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

function App() {
  const worldMapRef = useRef<HTMLDivElement | null>(null);
  const [forecast, setForecast] = useState<ForecastRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics>(DEFAULT_SYSTEM_METRICS);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string>("> System ready.");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [isMapFullscreen, setIsMapFullscreen] = useState(false);
  const [selectedMapCountryCode, setSelectedMapCountryCode] = useState<string | null>(null);
  const [mapPopupPosition, setMapPopupPosition] = useState<MapPopupPosition | null>(null);
  const [mapMetric, setMapMetric] = useState<MapMetric>("stock");
  const [mapStatusFilter, setMapStatusFilter] = useState<MapStatusFilter>("All");
  const [mapProjection, setMapProjection] = useState<MapProjection>("natural earth");
  const [selectedCountry, setSelectedCountry] = useState<string>("");
  const [highWithdrawalThresholdInput, setHighWithdrawalThresholdInput] = useState<string>(
    String(DEFAULT_WITHDRAWAL_THRESHOLD_14D),
  );
  const highWithdrawalThreshold14d = useMemo(
    () =>
      parseNumericInput(
        highWithdrawalThresholdInput,
        0.5,
        30,
        DEFAULT_WITHDRAWAL_THRESHOLD_14D,
      ),
    [highWithdrawalThresholdInput],
  );
  const [historyLookbackInput, setHistoryLookbackInput] = useState<string>(
    String(DEFAULT_HISTORY_LOOKBACK_DAYS),
  );

  const appendLogs = useCallback((entry: string) => {
    setLogs((previous) => (previous ? `${previous}\n${entry}` : entry));
  }, []);

  const loadData = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const [forecastRows, historyRows, modelMetrics] = await Promise.all([
        getForecast(),
        getGieHistory(),
        getSystemMetrics(),
      ]);
      setForecast(sortForecastRecords(forecastRows));
      setHistory(sortHistoryRecords(historyRows));
      setSystemMetrics(modelMetrics);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown loading error";
      setLoadError(message);
      appendLogs(`> Error: failed to load datasets (${message})`);
    } finally {
      setLoading(false);
    }
  }, [appendLogs]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const handleRunPipeline = useCallback(async () => {
    setIsPipelineRunning(true);
    appendLogs("> Pipeline triggered.");
    try {
      const response = await runPipeline();
      appendLogs(response.logs);
      await loadData();
    } catch (error) {
      const message = error instanceof Error ? error.message : "Pipeline failed";
      appendLogs(`> Error: ${message}`);
    } finally {
      setIsPipelineRunning(false);
    }
  }, [appendLogs, loadData]);

  useEffect(() => {
    const webkitDocument = document as WebkitDocument;
    const handleFullscreenChange = () => {
      const activeElement = document.fullscreenElement ?? webkitDocument.webkitFullscreenElement ?? null;
      setIsMapFullscreen(activeElement === worldMapRef.current);
    };

    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange as EventListener);
    return () => {
      document.removeEventListener("fullscreenchange", handleFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", handleFullscreenChange as EventListener);
    };
  }, []);

  const toggleMapFullscreen = useCallback(async () => {
    if (!worldMapRef.current) {
      return;
    }

    const element = worldMapRef.current as FullscreenElement;
    const webkitDocument = document as WebkitDocument;
    const activeElement = document.fullscreenElement ?? webkitDocument.webkitFullscreenElement ?? null;

    try {
      if (!activeElement) {
        if (typeof element.requestFullscreen === "function") {
          await element.requestFullscreen();
        } else if (typeof element.webkitRequestFullscreen === "function") {
          await element.webkitRequestFullscreen();
        } else {
          appendLogs("> Error: Fullscreen API is not available in this browser.");
        }
      } else {
        if (typeof document.exitFullscreen === "function") {
          await document.exitFullscreen();
        } else if (typeof webkitDocument.webkitExitFullscreen === "function") {
          await webkitDocument.webkitExitFullscreen();
        } else {
          appendLogs("> Error: Unable to exit fullscreen in this browser.");
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown fullscreen error";
      appendLogs(`> Error: world map fullscreen failed (${message})`);
    }
  }, [appendLogs]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") {
        return;
      }
      setSelectedMapCountryCode(null);
      setMapPopupPosition(null);
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, []);

  const handleMapClick = useCallback((event: Readonly<PlotMouseEvent>) => {
    const countryCode = getCountryCodeFromCustomData(event.points?.[0]?.customdata);
    if (!countryCode) {
      setSelectedMapCountryCode(null);
      setMapPopupPosition(null);
      return;
    }

    setSelectedMapCountryCode(countryCode);
    const nextPosition =
      worldMapRef.current && event.event instanceof MouseEvent
        ? getMapPopupPosition(event.event, worldMapRef.current)
        : null;
    setMapPopupPosition(nextPosition);
  }, []);

  const handleMapContainerPointerDown = useCallback(() => {
    if (!selectedMapCountryCode) {
      return;
    }
    setSelectedMapCountryCode(null);
    setMapPopupPosition(null);
  }, [selectedMapCountryCode]);

  useEffect(() => {
    if (!selectedMapCountryCode) {
      return;
    }

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      if (worldMapRef.current?.contains(target)) {
        return;
      }
      setSelectedMapCountryCode(null);
      setMapPopupPosition(null);
    };

    window.addEventListener("pointerdown", handlePointerDown);
    return () => {
      window.removeEventListener("pointerdown", handlePointerDown);
    };
  }, [selectedMapCountryCode]);

  const historyWithNetInjection = useMemo(() => withNetInjection(history), [history]);

  const countries = useMemo(() => {
    return Array.from(new Set([...history.map((row) => row.country), ...forecast.map((row) => row.country)])).sort();
  }, [history, forecast]);

  useEffect(() => {
    if (countries.length === 0) {
      return;
    }
    if (!selectedCountry) {
      setSelectedCountry(countries.includes("FR") ? "FR" : countries[0]);
      return;
    }
    if (!countries.includes(selectedCountry)) {
      setSelectedCountry(countries[0]);
    }
  }, [countries, selectedCountry]);

  const overviewRows = useMemo(
    () => buildOverviewRows(historyWithNetInjection, forecast, highWithdrawalThreshold14d),
    [forecast, highWithdrawalThreshold14d, historyWithNetInjection],
  );

  const overviewForecastChart = useMemo(
    () => buildOverviewForecastChart(forecast, OVERVIEW_FORECAST_TOP_COUNTRIES),
    [forecast],
  );

  const selectedCountryHistory = useMemo(() => {
    return historyWithNetInjection.filter((row) => row.country === selectedCountry);
  }, [historyWithNetInjection, selectedCountry]);

  const selectedCountryForecast = useMemo(() => {
    return forecast.filter((row) => row.country === selectedCountry);
  }, [forecast, selectedCountry]);

  const effectiveHistoryLookbackDays = useMemo(() => {
    const parsed = Number(historyLookbackInput);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_HISTORY_LOOKBACK_DAYS;
    }
    return Math.max(Math.round(parsed), 1);
  }, [historyLookbackInput]);

  const historyWindow = useMemo(() => {
    if (selectedCountryHistory.length === 0) {
      return [] as HistoryWithNetInjection[];
    }

    const maxTs = dateToTimestamp(selectedCountryHistory[selectedCountryHistory.length - 1].date);
    const minTs = maxTs - (effectiveHistoryLookbackDays - 1) * DAY_MS;
    return selectedCountryHistory.filter((row) => dateToTimestamp(row.date) >= minTs);
  }, [selectedCountryHistory, effectiveHistoryLookbackDays]);

  const transitionSeries = useMemo(
    () => buildTransitionSeries(historyWindow, selectedCountryForecast),
    [historyWindow, selectedCountryForecast],
  );

  const fluxSeries = useMemo(
    () => buildFluxSeries(historyWindow, selectedCountryForecast),
    [historyWindow, selectedCountryForecast],
  );

  const currentCountryStock =
    selectedCountryHistory.length > 0 ? selectedCountryHistory[selectedCountryHistory.length - 1].stock_twh : null;

  const currentCountryNetInjection =
    selectedCountryHistory.length > 0
      ? selectedCountryHistory[selectedCountryHistory.length - 1].net_injection
      : null;

  const forecastCountryJ14 =
    selectedCountryForecast.length > 0
      ? selectedCountryForecast[selectedCountryForecast.length - 1].prediction_twh
      : null;

  const countryNetChange =
    currentCountryStock !== null && forecastCountryJ14 !== null
      ? forecastCountryJ14 - currentCountryStock
      : null;

  const totalCountriesTracked = overviewRows.length;
  const countriesInAlert = overviewRows.filter((row) => row.alert).length;
  const totalNetInjection14d = overviewRows.reduce(
    (sum, row) => sum + (row.forecastedInjection14dSum ?? 0),
    0,
  );
  const totalCurrentStock = overviewRows.reduce((sum, row) => sum + (row.currentStockTwh ?? 0), 0);
  const countriesInWithdrawal = overviewRows.filter((row) => (row.forecastedInjection14dSum ?? 0) < 0).length;

  const overviewRiskSeries = useMemo(() => {
    return [...overviewRows]
      .sort((a, b) => (a.forecastedInjection14dSum ?? 0) - (b.forecastedInjection14dSum ?? 0))
      .map((row) => ({
        Country: row.country,
        "Forecasted Injection (14d Sum)": row.forecastedInjection14dSum ?? 0,
      }));
  }, [overviewRows]);

  const worldMapPoints = useMemo<MapPoint[]>(() => {
    return overviewRows.flatMap((row) => {
      const iso3 = ISO2_TO_ISO3[row.country];
      if (!iso3) {
        return [];
      }

      return [
        {
          iso3,
          countryCode: row.country,
          countryLabel: COUNTRY_LABEL_BY_CODE[row.country] ?? row.country,
          stockTwh: row.currentStockTwh,
          stockPct: row.stockPct,
          forecastedInjection14dSum: row.forecastedInjection14dSum,
          status: row.status,
        },
      ];
    });
  }, [overviewRows]);

  const mapCountryDetailsByCode = useMemo<Record<string, MapCountryDetails>>(() => {
    const latestHistoryByCountry = new Map<string, HistoryWithNetInjection>();
    for (const row of historyWithNetInjection) {
      latestHistoryByCountry.set(row.country, row);
    }

    const lastForecastByCountry = new Map<string, ForecastRecord>();
    for (const row of sortForecastRecords(forecast)) {
      lastForecastByCountry.set(row.country, row);
    }

    const details: Record<string, MapCountryDetails> = {};
    for (const row of overviewRows) {
      const historyRow = latestHistoryByCountry.get(row.country);
      const forecastRow = lastForecastByCountry.get(row.country);
      const forecastStockJ14 = forecastRow?.prediction_twh ?? row.forecastedStockJ14 ?? null;
      const netChangeJ14 =
        historyRow && forecastStockJ14 !== null ? forecastStockJ14 - historyRow.stock_twh : null;

      details[row.country] = {
        countryCode: row.country,
        countryLabel: COUNTRY_LABEL_BY_CODE[row.country] ?? row.country,
        currentStockTwh: row.currentStockTwh,
        stockPct: row.stockPct,
        currentNetInjection: historyRow?.net_injection ?? null,
        forecastStockJ14,
        netChangeJ14,
        forecastedInjection14dSum: row.forecastedInjection14dSum,
        status: row.status,
      };
    }

    return details;
  }, [forecast, historyWithNetInjection, overviewRows]);

  const mapMetricConfig = useMemo(() => getMapMetricConfig(mapMetric), [mapMetric]);

  const mapStatusCounts = useMemo<Record<OverviewStatus, number>>(() => {
    return worldMapPoints.reduce(
      (acc, point) => {
        acc[point.status] += 1;
        return acc;
      },
      { Alert: 0, Watch: 0, Stable: 0 },
    );
  }, [worldMapPoints]);

  const filteredWorldMapPoints = useMemo(() => {
    return worldMapPoints.filter((point) => mapStatusFilter === "All" || point.status === mapStatusFilter);
  }, [mapStatusFilter, worldMapPoints]);

  const mapPointsWithMetric = useMemo(() => {
    return filteredWorldMapPoints.flatMap((point) => {
      const metricValue = getMapMetricValue(point, mapMetric);
      if (metricValue === null || Number.isNaN(metricValue)) {
        return [];
      }
      return [{ ...point, metricValue }];
    });
  }, [filteredWorldMapPoints, mapMetric]);

  useEffect(() => {
    if (!selectedMapCountryCode) {
      return;
    }

    const visibleCountries = new Set(mapPointsWithMetric.map((point) => point.countryCode));
    if (!visibleCountries.has(selectedMapCountryCode)) {
      setSelectedMapCountryCode(null);
      setMapPopupPosition(null);
    }
  }, [selectedMapCountryCode, mapPointsWithMetric]);

  const mapMetricDomain = useMemo(() => {
    if (mapPointsWithMetric.length === 0) {
      return { zmin: 0, zmax: 1, zmid: undefined as number | undefined };
    }

    if (mapMetric === "fill") {
      return { zmin: 0, zmax: 100, zmid: undefined as number | undefined };
    }

    if (mapMetric === "injection") {
      let maxAbs = 0;
      for (const point of mapPointsWithMetric) {
        maxAbs = Math.max(maxAbs, Math.abs(point.metricValue));
      }
      const domain = maxAbs > 0 ? maxAbs : 1;
      return { zmin: -domain, zmax: domain, zmid: 0 };
    }

    let maxValue = 0;
    for (const point of mapPointsWithMetric) {
      maxValue = Math.max(maxValue, point.metricValue);
    }
    return { zmin: 0, zmax: maxValue > 0 ? maxValue : 1, zmid: undefined as number | undefined };
  }, [mapMetric, mapPointsWithMetric]);

  const activeMapCountryCode = selectedMapCountryCode;
  const isActiveMapCountryVisible =
    activeMapCountryCode !== null && mapPointsWithMetric.some((point) => point.countryCode === activeMapCountryCode);
  const activeMapCountryDetails =
    activeMapCountryCode && isActiveMapCountryVisible ? mapCountryDetailsByCode[activeMapCountryCode] ?? null : null;

  const mapTopCountry = useMemo(() => {
    if (mapPointsWithMetric.length === 0) {
      return null;
    }
    return mapPointsWithMetric.reduce((max, point) => (point.metricValue > max.metricValue ? point : max));
  }, [mapPointsWithMetric]);

  const mapBottomCountry = useMemo(() => {
    if (mapPointsWithMetric.length === 0) {
      return null;
    }
    return mapPointsWithMetric.reduce((min, point) => (point.metricValue < min.metricValue ? point : min));
  }, [mapPointsWithMetric]);

  const worldMapData = useMemo<Data[]>(() => {
    if (mapPointsWithMetric.length === 0) {
      return [];
    }

    const customData = mapPointsWithMetric.map((point) => [
      point.countryCode,
      point.countryLabel,
      point.stockTwh === null ? "N/A" : `${point.stockTwh.toFixed(2)} TWh`,
      point.stockPct === null ? "N/A" : `${point.stockPct.toFixed(1)}%`,
      point.forecastedInjection14dSum === null ? "N/A" : `${formatSigned(point.forecastedInjection14dSum, 2)} TWh`,
      point.status,
      mapMetricConfig.format(point.metricValue),
    ]);

    const traces: Data[] = [
      {
        type: "choropleth",
        locationmode: "ISO-3",
        locations: mapPointsWithMetric.map((point) => point.iso3),
        z: mapPointsWithMetric.map((point) => point.metricValue),
        zmin: mapMetricDomain.zmin,
        zmax: mapMetricDomain.zmax,
        ...(mapMetricDomain.zmid !== undefined ? { zmid: mapMetricDomain.zmid } : {}),
        colorscale: mapMetricConfig.colorscale,
        autocolorscale: false,
        marker: {
          line: {
            color: "#020617",
            width: 0.8,
          },
        },
        colorbar: {
          title: {
            text: mapMetricConfig.colorbarTitle,
            font: { color: "#e2e8f0", size: 12 },
          },
          tickfont: { color: "#94a3b8", size: 10 },
          len: 0.74,
          thickness: 12,
          x: 0.98,
          y: 0.5,
        },
        customdata: customData,
        hoverlabel: {
          bgcolor: "rgba(15,23,42,0.94)",
          bordercolor: "#334155",
          font: { color: "#e2e8f0", size: 12 },
        },
        hovertemplate:
          `<b>%{customdata[1]} (%{customdata[0]})</b><br>${mapMetricConfig.colorbarTitle}: %{customdata[6]}` +
          "<br>Current Stock: %{customdata[2]}" +
          "<br>Fill: %{customdata[3]}" +
          "<br>14d Injection: %{customdata[4]}" +
          "<br>Status: %{customdata[5]}" +
          "<br><span style=\"opacity:0.75\">Click for details</span><extra></extra>",
      } as Data,
    ];

    if (activeMapCountryCode && isActiveMapCountryVisible) {
      const activeIso3 = ISO2_TO_ISO3[activeMapCountryCode];
      if (activeIso3) {
        traces.push({
          type: "choropleth",
          locationmode: "ISO-3",
          locations: [activeIso3],
          z: [1],
          zmin: 0,
          zmax: 1,
          showscale: false,
          colorscale: [
            [0, "rgba(56,189,248,0.20)"],
            [1, "rgba(56,189,248,0.42)"],
          ],
          marker: {
            line: {
              color: "#38bdf8",
              width: 2,
            },
          },
          hoverinfo: "skip",
        } as Data);
      }
    }

    return traces;
  }, [
    activeMapCountryCode,
    isActiveMapCountryVisible,
    mapMetricConfig,
    mapMetricDomain,
    mapPointsWithMetric,
  ]);

  const worldMapLayout = useMemo<Partial<Layout>>(() => {
    return {
      margin: { l: 0, r: 0, t: 0, b: 0 },
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      dragmode: "pan",
      hovermode: "closest",
      uirevision: `world-map-${mapProjection}`,
      transition: {
        duration: 320,
        easing: "cubic-in-out",
      },
      geo: {
        projection: {
          type: mapProjection,
          scale: mapProjection === "mercator" ? 1.13 : 1,
        },
        showcountries: true,
        countrycolor: "#334155",
        countrywidth: 0.7,
        showcoastlines: false,
        showland: true,
        landcolor: "#0f172a",
        showocean: true,
        oceancolor: "#020617",
        showlakes: true,
        lakecolor: "#020617",
        showframe: false,
        bgcolor: "rgba(0,0,0,0)",
      },
    };
  }, [mapProjection]);

  const worldMapConfig = useMemo<Partial<Config>>(
    () => ({
      responsive: true,
      displayModeBar: true,
      displaylogo: false,
      scrollZoom: true,
      doubleClick: "reset",
      modeBarButtonsToRemove: ["toImage", "hoverClosestGeo"],
    }),
    [],
  );

  const forecastRowsForExport = useMemo<ForecastExportRow[]>(() => {
    return forecast.map((row) => ({
      date: row.date,
      country: row.country,
      prediction_twh: row.prediction_twh,
      net_injection: row.net_injection,
      scenario: "Base Case",
      temp_shock_c: 0,
    }));
  }, [forecast]);

  const historyTailRows = useMemo(() => {
    return [...historyWithNetInjection].slice(-200);
  }, [historyWithNetInjection]);

  const historyGaps = useMemo(() => findDateGaps(history), [history]);
  const forecastGaps = useMemo(() => findDateGaps(forecast), [forecast]);

  const maxForecastDate = useMemo(() => {
    if (forecast.length === 0) {
      return "N/A";
    }
    return forecast.reduce((max, row) => (dateToTimestamp(row.date) > dateToTimestamp(max) ? row.date : max), forecast[0].date);
  }, [forecast]);

  const statusBadgeColor: Record<OverviewStatus, "red" | "orange" | "emerald"> = {
    Alert: "red",
    Watch: "orange",
    Stable: "emerald",
  };

  const alertSharePct =
    totalCountriesTracked > 0 ? (countriesInAlert / totalCountriesTracked) * 100 : 0;
  const withdrawalSharePct =
    totalCountriesTracked > 0 ? (countriesInWithdrawal / totalCountriesTracked) * 100 : 0;

  const highWithdrawalHits = selectedCountryForecast.filter(
    (row) => row.net_injection < WITHDRAWAL_ALERT_THRESHOLD_DAY,
  );

  const modelTrainingDateLabel = useMemo(() => {
    if (!systemMetrics.training_date) {
      return null;
    }

    const parsed = new Date(systemMetrics.training_date);
    if (Number.isNaN(parsed.getTime())) {
      return systemMetrics.training_date;
    }
    return parsed.toLocaleString("en-US");
  }, [systemMetrics.training_date]);

  return (
    <main className="dark min-h-screen bg-slate-950 p-10 font-sans text-slate-100">
      <Flex className="mb-8" justifyContent="between" alignItems="center">
        <div>
          <Title className="text-3xl font-bold text-slate-100">GasGuardian ⚡️</Title>
          <Text>Storage Forecast Control Room</Text>
          <Text className="mt-1 text-xs text-slate-300">
            Forecast through: {maxForecastDate}
          </Text>
        </div>
        <div className="flex gap-2">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => void loadData()}
            disabled={loading || isPipelineRunning}
          >
            {loading ? "Loading..." : "Refresh"}
          </Button>
          <Button
            size="xs"
            onClick={() => void handleRunPipeline()}
            disabled={loading || isPipelineRunning}
            loading={isPipelineRunning}
          >
            Run Pipeline
          </Button>
        </div>
      </Flex>

      <Card className="mb-6">
        <Title>Controls</Title>
        <Grid numItems={1} numItemsSm={2} numItemsLg={3} className="mt-4 gap-4">
          <div>
            <Text>Country</Text>
            <Select value={selectedCountry} onValueChange={setSelectedCountry} className="mt-2">
              {countries.map((country) => (
                <SelectItem key={country} value={country}>
                  {country}
                </SelectItem>
              ))}
            </Select>
          </div>
          <div>
            <Text>High Withdrawal Threshold (14d, TWh)</Text>
            <input
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-500/50"
              type="number"
              inputMode="decimal"
              value={highWithdrawalThresholdInput}
              min={0.5}
              max={30}
              step={0.5}
              onChange={(event) => setHighWithdrawalThresholdInput(event.target.value)}
              onBlur={() => setHighWithdrawalThresholdInput(highWithdrawalThreshold14d.toString())}
            />
          </div>
          <div>
            <Text>History Window (days)</Text>
            <input
              className="mt-2 w-full rounded-md border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100 outline-none ring-0 placeholder:text-slate-500 focus:border-slate-500 focus:ring-2 focus:ring-slate-500/50"
              type="number"
              inputMode="numeric"
              value={historyLookbackInput}
              onChange={(event) => setHistoryLookbackInput(event.target.value)}
            />
          </div>
        </Grid>
      </Card>

      {loadError && (
        <Card className="mb-6 border border-red-200 bg-red-50">
          <Text className="font-semibold text-red-700">Data loading error</Text>
          <Text className="mt-1 text-red-700">{loadError}</Text>
        </Card>
      )}

      <TabGroup>
        <TabList>
          <Tab>Forecast</Tab>
          <Tab>System Monitor</Tab>
        </TabList>
        <TabPanels>
          <TabPanel>
            <TabGroup className="mt-6">
              <TabList>
                <Tab>Overview</Tab>
                <Tab>Country Analysis</Tab>
                <Tab>Raw Data</Tab>
              </TabList>
              <TabPanels>
                <TabPanel>
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
                      <Text className="mt-4">
                        Countries with Net Withdrawal: {withdrawalSharePct.toFixed(0)}%
                      </Text>
                      <ProgressBar value={withdrawalSharePct} color="orange" className="mt-2" />
                      <div className={`mt-6 ${OVERVIEW_PANEL_CLASS}`}>
                        <Text>Alert Rule</Text>
                        <Text className="mt-1">
                          Stock {"<"} 10% or 14d withdrawal {">"} {highWithdrawalThreshold14d.toFixed(1)} TWh
                        </Text>
                      </div>
                    </Card>
                  </Grid>

                  <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
                    <Flex justifyContent="between" alignItems="start" className="gap-4">
                      <div>
                        <Title>World Storage Map</Title>
                        <Text>
                          Interactive geospatial cockpit with metric switching, status filtering, projection controls, and click-to-open country details.
                        </Text>
                      </div>
                      <div className="flex flex-wrap justify-end gap-2">
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => {
                            setMapMetric("stock");
                            setMapStatusFilter("All");
                            setMapProjection("natural earth");
                            setSelectedMapCountryCode(null);
                            setMapPopupPosition(null);
                          }}
                        >
                          Reset Controls
                        </Button>
                        <Button
                          size="xs"
                          variant="secondary"
                          onClick={() => void toggleMapFullscreen()}
                        >
                          {isMapFullscreen ? "Exit Full Screen" : "Full Screen"}
                        </Button>
                      </div>
                    </Flex>

                    <Grid numItems={1} numItemsLg={3} className="mt-4 gap-3">
                      <div className={OVERVIEW_PANEL_CLASS}>
                        <Text className="text-xs uppercase tracking-wide text-slate-400">Metric</Text>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {MAP_METRIC_OPTIONS.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() => setMapMetric(option.key)}
                              className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                                mapMetric === option.key
                                  ? "bg-cyan-500/20 text-cyan-100 shadow-[0_10px_24px_-16px_rgba(34,211,238,0.75)]"
                                  : OVERVIEW_CHIP_IDLE_CLASS
                              }`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <Text className="mt-2 text-xs text-slate-400">
                          {MAP_METRIC_OPTIONS.find((option) => option.key === mapMetric)?.helper}
                        </Text>
                      </div>

                      <div className={OVERVIEW_PANEL_CLASS}>
                        <Text className="text-xs uppercase tracking-wide text-slate-400">Status Filter</Text>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {MAP_STATUS_FILTER_OPTIONS.map((option) => (
                            <button
                              key={option}
                              type="button"
                              onClick={() => setMapStatusFilter(option)}
                              className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                                mapStatusFilter === option
                                  ? "bg-emerald-500/20 text-emerald-100 shadow-[0_10px_24px_-16px_rgba(16,185,129,0.75)]"
                                  : OVERVIEW_CHIP_IDLE_CLASS
                              }`}
                            >
                              {option}
                              {" · "}
                              {option === "All" ? worldMapPoints.length : mapStatusCounts[option]}
                            </button>
                          ))}
                        </div>
                        <Text className="mt-2 text-xs text-slate-400">
                          Countries shown: {mapPointsWithMetric.length}/{worldMapPoints.length}
                        </Text>
                      </div>

                      <div className={OVERVIEW_PANEL_CLASS}>
                        <Text className="text-xs uppercase tracking-wide text-slate-400">Projection</Text>
                        <div className="mt-2 flex flex-wrap gap-2">
                          {MAP_PROJECTION_OPTIONS.map((option) => (
                            <button
                              key={option.key}
                              type="button"
                              onClick={() => setMapProjection(option.key)}
                              className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                                mapProjection === option.key
                                  ? "bg-violet-500/20 text-violet-100 shadow-[0_10px_24px_-16px_rgba(168,85,247,0.75)]"
                                  : OVERVIEW_CHIP_IDLE_CLASS
                              }`}
                            >
                              {option.label}
                            </button>
                          ))}
                        </div>
                        <Text className="mt-2 text-xs text-slate-400">
                          Drag to pan, scroll to zoom, double-click to reset camera.
                        </Text>
                      </div>
                    </Grid>

                    <div
                      ref={worldMapRef}
                      onPointerDownCapture={handleMapContainerPointerDown}
                      className="relative mt-4 -mx-16 overflow-hidden rounded-none bg-slate-950/90 p-2 shadow-[0_22px_44px_-24px_rgba(15,23,42,0.95)]"
                    >
                      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_15%_20%,rgba(14,165,233,0.18),transparent_36%),radial-gradient(circle_at_85%_88%,rgba(34,197,94,0.14),transparent_42%)]" />
                      {worldMapPoints.length === 0 ? (
                        <div
                          className="relative z-10 flex items-center justify-center text-sm text-slate-400"
                          style={{ height: OVERVIEW_MAP_HEIGHT }}
                        >
                          No mappable country data available.
                        </div>
                      ) : mapPointsWithMetric.length === 0 ? (
                        <div
                          className="relative z-10 flex items-center justify-center text-sm text-slate-400"
                          style={{ height: OVERVIEW_MAP_HEIGHT }}
                        >
                          No country matches the selected metric/filter.
                        </div>
                      ) : (
                        <>
                          <div className="pointer-events-none absolute left-4 top-4 z-20 hidden rounded-xl bg-slate-950/82 px-3 py-2 shadow-[0_14px_30px_-22px_rgba(15,23,42,0.95)] backdrop-blur lg:block">
                            <Text className="text-[11px] uppercase tracking-wide text-slate-400">
                              {mapMetricConfig.colorbarTitle}
                            </Text>
                            <Text className="mt-1 text-xs text-slate-200">
                              Top: {mapTopCountry ? `${mapTopCountry.countryCode} (${mapMetricConfig.format(mapTopCountry.metricValue)})` : "N/A"}
                            </Text>
                            <Text className="mt-1 text-xs text-slate-300">
                              Low: {mapBottomCountry
                                ? `${mapBottomCountry.countryCode} (${mapMetricConfig.format(mapBottomCountry.metricValue)})`
                                : "N/A"}
                            </Text>
                          </div>

                          <Plot
                            data={worldMapData}
                            layout={worldMapLayout}
                            config={worldMapConfig}
                            style={{
                              width: "100%",
                              height: isMapFullscreen ? "calc(100vh - 128px)" : OVERVIEW_MAP_HEIGHT,
                            }}
                            useResizeHandler
                            onClick={handleMapClick}
                          />

                          {activeMapCountryDetails && (
                            <div
                              className={`pointer-events-none absolute z-20 w-[calc(100%-2rem)] max-w-[420px] rounded-2xl bg-slate-900/90 p-4 shadow-[0_24px_44px_-20px_rgba(15,23,42,0.95)] backdrop-blur transition-all duration-300 ${
                                mapPopupPosition ? "" : "bottom-4 right-4"
                              }`}
                              style={
                                mapPopupPosition
                                  ? { left: mapPopupPosition.left, top: mapPopupPosition.top }
                                  : undefined
                              }
                            >
                              <Flex justifyContent="between" alignItems="start">
                                <div>
                                  <Text className="text-slate-300">
                                    {activeMapCountryDetails.countryLabel} ({activeMapCountryDetails.countryCode})
                                  </Text>
                                  <Title className="mt-1 text-slate-100">{activeMapCountryDetails.status}</Title>
                                </div>
                                <Badge color={statusBadgeColor[activeMapCountryDetails.status]}>
                                  Selected
                                </Badge>
                              </Flex>

                              <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                                <div
                                  className="h-full rounded-full transition-all duration-300"
                                  style={{
                                    width: `${Math.max(
                                      0,
                                      Math.min(100, activeMapCountryDetails.stockPct ?? 0),
                                    )}%`,
                                    backgroundColor: STATUS_ACCENT_COLOR[activeMapCountryDetails.status],
                                  }}
                                />
                              </div>

                              <Grid numItems={2} className="mt-4 gap-3">
                                <div className="rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                                  <Text className="text-xs text-slate-400">Current Stock (TWh)</Text>
                                  <Text className="mt-1 text-lg font-semibold text-slate-100">
                                    {formatNumber(activeMapCountryDetails.currentStockTwh, 2)}
                                  </Text>
                                </div>
                                <div className="rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                                  <Text className="text-xs text-slate-400">Current Net Inj</Text>
                                  <Text className="mt-1 text-lg font-semibold text-slate-100">
                                    {formatSigned(activeMapCountryDetails.currentNetInjection, 2)}
                                  </Text>
                                </div>
                                <div className="rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                                  <Text className="text-xs text-slate-400">Forecasted Stock (J+14)</Text>
                                  <Text className="mt-1 text-lg font-semibold text-slate-100">
                                    {formatNumber(activeMapCountryDetails.forecastStockJ14, 2)}
                                  </Text>
                                </div>
                                <div className="rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                                  <Text className="text-xs text-slate-400">Net Change (J+14 - Now)</Text>
                                  <Text className="mt-1 text-lg font-semibold text-slate-100">
                                    {formatSigned(activeMapCountryDetails.netChangeJ14, 2)}
                                  </Text>
                                </div>
                              </Grid>

                              <div className="mt-3 rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                                <Text className="text-xs text-slate-400">Stock Fill / 14d Injection</Text>
                                <Text className="mt-1 text-sm text-slate-200">
                                  Fill: {activeMapCountryDetails.stockPct === null
                                    ? "N/A"
                                    : `${activeMapCountryDetails.stockPct.toFixed(1)}%`}
                                  {"  •  "}
                                  14d Injection: {formatSigned(activeMapCountryDetails.forecastedInjection14dSum, 2)} TWh
                                </Text>
                                <Text className="mt-1 text-xs text-slate-400">
                                  Press <span className="font-semibold text-slate-300">Esc</span> to close details instantly.
                                </Text>
                              </div>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  </Card>

                  <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
                    <Title>Storage Forecast by Country (TWh)</Title>
                    <Text>
                      {overviewForecastChart.visibleCountryCount === 0
                        ? "Projected gas levels for the next two weeks."
                        : overviewForecastChart.hiddenCountryCount > 0
                          ? `Top ${overviewForecastChart.visibleCountryCount} countries are shown individually; ${overviewForecastChart.hiddenCountryCount} countries are grouped as Others.`
                          : `All ${overviewForecastChart.visibleCountryCount} countries are shown individually.`}
                    </Text>
                    <LineChart
                      className="mt-4 h-80"
                      data={overviewForecastChart.data}
                      index="dateLabel"
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
                </TabPanel>

                <TabPanel>
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
                      <Card
                        decoration="top"
                        decorationColor={countryNetChange !== null && countryNetChange < 0 ? "red" : "emerald"}
                      >
                        <Text>Net Change (J+14 - Now)</Text>
                        <Metric>{formatSigned(countryNetChange, 2)} TWh</Metric>
                        <Text className="mt-2">
                          {countryNetChange === null
                            ? "N/A"
                            : (countryNetChange >= 0 ? "Injection" : "Withdrawal")}
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
                            formatter={(value: unknown, name: unknown) => [
                              formatTooltipValue(value),
                              String(name ?? "Value"),
                            ]}
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
                          <RechartsLine
                            type="monotone"
                            dataKey="Actual"
                            name="Actual"
                            stroke="#3b82f6"
                            strokeWidth={2}
                            dot={false}
                          />
                          <RechartsLine
                            type="monotone"
                            dataKey="Forecast"
                            name="Forecast"
                            stroke="#ef4444"
                            strokeWidth={2}
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
                            formatter={(value: unknown, name: unknown) => [
                              formatTooltipValue(value),
                              String(name ?? "Value"),
                            ]}
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
                        No high withdrawal signal detected (threshold: -0.5 TWh/day).
                      </Text>
                    ) : (
                      <Text className="mt-3 text-red-700">
                        High Withdrawal Alert on {highWithdrawalHits.map((row) => row.date).join(", ")}. Worst day:{" "}
                        {formatNumber(
                          Math.min(...highWithdrawalHits.map((row) => row.net_injection)),
                          3,
                        )}{" "}
                        TWh/day.
                      </Text>
                    )}
                  </Card>
                </TabPanel>

                <TabPanel>
                  <Card className="mt-6">
                    <Title>Raw Data & Export</Title>
                    <Text>Export generated forecast and inspect source datasets.</Text>
                    <Button
                      className="mt-4"
                      variant="secondary"
                      onClick={() => downloadForecastCsv(forecastRowsForExport)}
                      disabled={forecastRowsForExport.length === 0}
                    >
                      Download Generated Forecast CSV
                    </Button>
                  </Card>

                  <Grid numItems={1} numItemsLg={2} className="mt-6 gap-6">
                    <Card>
                      <Title>Generated Forecast</Title>
                      <Table className="mt-4">
                        <TableHead>
                          <TableRow>
                            <TableHeaderCell>Date</TableHeaderCell>
                            <TableHeaderCell>Country</TableHeaderCell>
                            <TableHeaderCell>Net Inj</TableHeaderCell>
                            <TableHeaderCell>Stock</TableHeaderCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {forecastRowsForExport.map((row) => (
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

                    <Card>
                      <Title>History (tail 200 rows)</Title>
                      <Table className="mt-4">
                        <TableHead>
                          <TableRow>
                            <TableHeaderCell>Date</TableHeaderCell>
                            <TableHeaderCell>Country</TableHeaderCell>
                            <TableHeaderCell>Stock</TableHeaderCell>
                            <TableHeaderCell>Fill %</TableHeaderCell>
                            <TableHeaderCell>Net Inj</TableHeaderCell>
                          </TableRow>
                        </TableHead>
                        <TableBody>
                          {historyTailRows.map((row) => (
                            <TableRow key={`${row.country}-${row.date}`}>
                              <TableCell>{row.date}</TableCell>
                              <TableCell>{row.country}</TableCell>
                              <TableCell>{formatNumber(row.stock_twh, 3)}</TableCell>
                              <TableCell>{formatNumber(row.fill_pct, 2)}</TableCell>
                              <TableCell>{formatSigned(row.net_injection, 3)}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </Card>
                  </Grid>
                </TabPanel>
              </TabPanels>
            </TabGroup>
          </TabPanel>

          <TabPanel>
            <Card className="mt-6">
              <Title>System Monitor</Title>
              <Text>Data integrity checks and manual pipeline control.</Text>
            </Card>

            <Card className="mt-6">
              <Title>Model Fit Scores</Title>
              <Text>Latest training metrics from the XGBoost model.</Text>
              <Grid numItems={1} numItemsSm={2} numItemsLg={4} className="mt-4 gap-4">
                <Card decoration="top" decorationColor="blue">
                  <Text>R²</Text>
                  <Metric>{formatNumber(systemMetrics.r2, 3)}</Metric>
                </Card>
                <Card decoration="top" decorationColor="cyan">
                  <Text>MAE</Text>
                  <Metric>{formatNumber(systemMetrics.mae, 3)}</Metric>
                </Card>
                <Card decoration="top" decorationColor="indigo">
                  <Text>RMSE</Text>
                  <Metric>{formatNumber(systemMetrics.rmse, 3)}</Metric>
                </Card>
                <Card decoration="top" decorationColor="violet">
                  <Text>WAPE</Text>
                  <Metric>{formatNumber(systemMetrics.wape * 100, 2)}%</Metric>
                </Card>
              </Grid>
              {modelTrainingDateLabel && (
                <Text className="mt-3 text-xs text-slate-300">Training date: {modelTrainingDateLabel}</Text>
              )}
              {systemMetrics.message && (
                <Text className="mt-2 text-xs text-amber-300">{systemMetrics.message}</Text>
              )}
            </Card>

            <Grid numItems={1} numItemsLg={2} className="mt-6 gap-6">
              <Card>
                <Title>GIE Data Continuity</Title>
                {historyGaps.length === 0 ? (
                  <Text className="mt-3 text-green-700">Data is continuous. No gaps.</Text>
                ) : (
                  <div className="mt-3">
                    <Text className="text-red-700">
                      CRITICAL: {historyGaps.length} missing day(s) detected.
                    </Text>
                    <Text className="mt-2 text-xs text-red-700">
                      {historyGaps.slice(0, 20).join(", ")}
                      {historyGaps.length > 20 ? " ..." : ""}
                    </Text>
                  </div>
                )}
              </Card>

              <Card>
                <Title>Forecast Data Continuity</Title>
                {forecastGaps.length === 0 ? (
                  <Text className="mt-3 text-green-700">Data is continuous. No gaps.</Text>
                ) : (
                  <div className="mt-3">
                    <Text className="text-red-700">
                      CRITICAL: {forecastGaps.length} missing day(s) detected.
                    </Text>
                    <Text className="mt-2 text-xs text-red-700">
                      {forecastGaps.slice(0, 20).join(", ")}
                      {forecastGaps.length > 20 ? " ..." : ""}
                    </Text>
                  </div>
                )}
              </Card>
            </Grid>

            <Card className="mt-6">
              <Flex justifyContent="between" alignItems="center">
                <div>
                  <Title>Pipeline Control</Title>
                  <Text>Entrypoint: backend/src/pipeline/run_pipeline.py</Text>
                </div>
                <Button
                  size="xs"
                  onClick={() => void handleRunPipeline()}
                  disabled={loading || isPipelineRunning}
                  loading={isPipelineRunning}
                >
                  Run Full Pipeline
                </Button>
              </Flex>
              <div className="mt-4 h-72 overflow-y-auto rounded bg-slate-900 p-4 font-mono text-sm text-green-400">
                {logs.split("\n").map((line, index) => (
                  <div key={`${index}-${line}`}>{line}</div>
                ))}
              </div>
            </Card>
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </main>
  );
}

export default App;
