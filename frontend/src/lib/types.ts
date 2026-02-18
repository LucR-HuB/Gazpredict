import type { HistoryRecord } from "./api";

export type ChartPoint = {
  date: string;
  dateLabel: string;
  [countryCode: string]: string | number;
};

export type HistoryWithNetInjection = HistoryRecord & {
  net_injection: number | null;
};

export type OverviewStatus = "Alert" | "Watch" | "Stable";

export type OverviewRow = {
  country: string;
  currentStockTwh: number | null;
  stockPct: number | null;
  forecastedInjection14dSum: number | null;
  forecastedStockJ14: number | null;
  trend: string;
  status: OverviewStatus;
  alert: boolean;
};

export type TransitionPoint = {
  date: string;
  dateLabel: string;
  Actual?: number;
  Forecast?: number;
  ForecastJ14?: number;
  ForecastAfterJ14?: number;
  clim_min?: number;
  clim_diff?: number;
  clim_avg?: number;
  stock_upper?: number;
  stock_lower?: number;
  injection_upper?: number;
  injection_lower?: number;
};

export type ForecastExportRow = {
  date: string;
  country: string;
  prediction_twh: number;
  net_injection: number;
  scenario: string;
  temp_shock_c: number;
};

export type OverviewForecastChart = {
  data: ChartPoint[];
  categories: string[];
  hiddenCountryCount: number;
  visibleCountryCount: number;
};

export type OverviewRiskRow = {
  Country: string;
  "Forecasted Injection (14d Sum)": number;
};

export type MapPoint = {
  iso3: string;
  countryCode: string;
  countryLabel: string;
  stockTwh: number | null;
  stockPct: number | null;
  currentNetInjection: number | null;
  forecastStockJ14: number | null;
  netChangeJ14: number | null;
  forecastedInjection14dSum: number | null;
  status: OverviewStatus;
};

export type MapMetric = "stock" | "fill" | "injection";

export type MapStatusFilter = "All" | OverviewStatus;

export type MapProjection = "natural earth" | "mercator";

export type MapMetricOption = {
  key: MapMetric;
  label: string;
  helper: string;
};

export type MapProjectionOption = {
  key: MapProjection;
  label: string;
};

export type MapMetricConfig = {
  colorbarTitle: string;
  colorscale: [number, string][];
  format: (value: number) => string;
};

export type TooltipPayloadItem = {
  color?: string;
  name?: string | number;
  value?: unknown;
  payload?: { date?: string };
};
