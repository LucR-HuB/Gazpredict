import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Badge, Button, Card, Flex, Grid, Text, Title } from "@tremor/react";
import createPlotlyComponent from "react-plotly.js/factory";
import Plotly from "plotly.js-dist-min";
import type { Config, Data, Layout, PlotMouseEvent } from "plotly.js";
import { formatNumber, formatSigned } from "../lib/formatters";
import type {
  MapMetric,
  MapMetricConfig,
  MapMetricOption,
  MapPoint,
  MapProjection,
  MapProjectionOption,
  MapStatusFilter,
  OverviewStatus,
} from "../lib/types";

const Plot = createPlotlyComponent(Plotly);

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

const STATUS_BADGE_COLOR: Record<OverviewStatus, "red" | "orange" | "emerald"> = {
  Alert: "red",
  Watch: "orange",
  Stable: "emerald",
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

type WorldMapProps = {
  mapPoints: MapPoint[];
  metric: MapMetric;
  projection: MapProjection;
  onMetricChange: (metric: MapMetric) => void;
  onProjectionChange: (projection: MapProjection) => void;
  onCountryClick: (countryCode: string) => void;
};

type MapPopupPosition = {
  left: number;
  top: number;
};

type FullscreenElement = HTMLDivElement & {
  webkitRequestFullscreen?: () => Promise<void> | void;
};

type WebkitDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => Promise<void> | void;
};

type MapPointWithMetric = MapPoint & {
  metricValue: number;
};

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

function getCountryCodeFromCustomData(customData: unknown): string | null {
  if (typeof customData === "string") {
    return customData.toUpperCase();
  }
  if (Array.isArray(customData) && typeof customData[0] === "string") {
    return customData[0].toUpperCase();
  }
  return null;
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

const WorldMap = memo(function WorldMap({
  mapPoints,
  metric,
  projection,
  onMetricChange,
  onProjectionChange,
  onCountryClick,
}: WorldMapProps) {
  const worldMapRef = useRef<HTMLDivElement | null>(null);
  const [isMapFullscreen, setIsMapFullscreen] = useState(false);
  const [selectedMapCountryCode, setSelectedMapCountryCode] = useState<string | null>(null);
  const [mapPopupPosition, setMapPopupPosition] = useState<MapPopupPosition | null>(null);
  const [statusFilter, setStatusFilter] = useState<MapStatusFilter>("All");

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
        }
      } else if (typeof document.exitFullscreen === "function") {
        await document.exitFullscreen();
      } else if (typeof webkitDocument.webkitExitFullscreen === "function") {
        await webkitDocument.webkitExitFullscreen();
      }
    } catch (error) {
      console.error("World map fullscreen failed", error);
    }
  }, []);

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

  const handleMapClick = useCallback(
    (event: Readonly<PlotMouseEvent>) => {
      const countryCode = getCountryCodeFromCustomData(event.points?.[0]?.customdata);
      if (!countryCode) {
        setSelectedMapCountryCode(null);
        setMapPopupPosition(null);
        return;
      }

      onCountryClick(countryCode);
      setSelectedMapCountryCode(countryCode);
      const nextPosition =
        worldMapRef.current && event.event instanceof MouseEvent
          ? getMapPopupPosition(event.event, worldMapRef.current)
          : null;
      setMapPopupPosition(nextPosition);
    },
    [onCountryClick],
  );

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

  const mapMetricConfig = useMemo(() => getMapMetricConfig(metric), [metric]);

  const mapStatusCounts = useMemo<Record<OverviewStatus, number>>(() => {
    return mapPoints.reduce(
      (acc, point) => {
        acc[point.status] += 1;
        return acc;
      },
      { Alert: 0, Watch: 0, Stable: 0 },
    );
  }, [mapPoints]);

  const filteredMapPoints = useMemo(() => {
    return mapPoints.filter((point) => statusFilter === "All" || point.status === statusFilter);
  }, [mapPoints, statusFilter]);

  const mapPointsWithMetric = useMemo<MapPointWithMetric[]>(() => {
    return filteredMapPoints.flatMap((point) => {
      const metricValue = getMapMetricValue(point, metric);
      if (metricValue === null || Number.isNaN(metricValue)) {
        return [];
      }

      return [{ ...point, metricValue }];
    });
  }, [filteredMapPoints, metric]);

  const visibleCountryCodes = useMemo(
    () => new Set(mapPointsWithMetric.map((point) => point.countryCode)),
    [mapPointsWithMetric],
  );

  const mapMetricDomain = useMemo(() => {
    if (mapPointsWithMetric.length === 0) {
      return { zmin: 0, zmax: 1, zmid: undefined as number | undefined };
    }

    if (metric === "fill") {
      return { zmin: 0, zmax: 100, zmid: undefined as number | undefined };
    }

    if (metric === "injection") {
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
  }, [mapPointsWithMetric, metric]);

  const activeMapCountryCode =
    selectedMapCountryCode && visibleCountryCodes.has(selectedMapCountryCode)
      ? selectedMapCountryCode
      : null;
  const isActiveMapCountryVisible = activeMapCountryCode !== null;
  const activeMapCountryDetails =
    activeMapCountryCode && isActiveMapCountryVisible
      ? mapPointsWithMetric.find((point) => point.countryCode === activeMapCountryCode) ?? null
      : null;

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

    if (activeMapCountryCode && isActiveMapCountryVisible && activeMapCountryDetails) {
      traces.push({
        type: "choropleth",
        locationmode: "ISO-3",
        locations: [activeMapCountryDetails.iso3],
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

    return traces;
  }, [
    activeMapCountryCode,
    activeMapCountryDetails,
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
      uirevision: `world-map-${projection}`,
      transition: {
        duration: 320,
        easing: "cubic-in-out",
      },
      geo: {
        projection: {
          type: projection,
          scale: projection === "mercator" ? 1.13 : 1,
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
  }, [projection]);

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

  return (
    <Card className={`mt-6 ${OVERVIEW_CARD_CLASS}`}>
      <Flex justifyContent="between" alignItems="start" className="gap-4">
        <div>
          <Title>World Storage Map</Title>
          <Text>
            Interactive geospatial cockpit with metric switching, status filtering, projection controls,
            and click-to-open country details.
          </Text>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="xs"
            variant="secondary"
            onClick={() => {
              onMetricChange("stock");
              setStatusFilter("All");
              onProjectionChange("natural earth");
              setSelectedMapCountryCode(null);
              setMapPopupPosition(null);
            }}
          >
            Reset Controls
          </Button>
          <Button size="xs" variant="secondary" onClick={() => void toggleMapFullscreen()}>
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
                onClick={() => onMetricChange(option.key)}
                className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                  metric === option.key
                    ? "bg-cyan-500/20 text-cyan-100 shadow-[0_10px_24px_-16px_rgba(34,211,238,0.75)]"
                    : OVERVIEW_CHIP_IDLE_CLASS
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
          <Text className="mt-2 text-xs text-slate-400">
            {MAP_METRIC_OPTIONS.find((option) => option.key === metric)?.helper}
          </Text>
        </div>

        <div className={OVERVIEW_PANEL_CLASS}>
          <Text className="text-xs uppercase tracking-wide text-slate-400">Status Filter</Text>
          <div className="mt-2 flex flex-wrap gap-2">
            {MAP_STATUS_FILTER_OPTIONS.map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setStatusFilter(option)}
                className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                  statusFilter === option
                    ? "bg-emerald-500/20 text-emerald-100 shadow-[0_10px_24px_-16px_rgba(16,185,129,0.75)]"
                    : OVERVIEW_CHIP_IDLE_CLASS
                }`}
              >
                {option}
                {" · "}
                {option === "All" ? mapPoints.length : mapStatusCounts[option]}
              </button>
            ))}
          </div>
          <Text className="mt-2 text-xs text-slate-400">
            Countries shown: {mapPointsWithMetric.length}/{mapPoints.length}
          </Text>
        </div>

        <div className={OVERVIEW_PANEL_CLASS}>
          <Text className="text-xs uppercase tracking-wide text-slate-400">Projection</Text>
          <div className="mt-2 flex flex-wrap gap-2">
            {MAP_PROJECTION_OPTIONS.map((option) => (
              <button
                key={option.key}
                type="button"
                onClick={() => onProjectionChange(option.key)}
                className={`${OVERVIEW_CHIP_BASE_CLASS} ${
                  projection === option.key
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
        {mapPoints.length === 0 ? (
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
                Top:{" "}
                {mapTopCountry
                  ? `${mapTopCountry.countryCode} (${mapMetricConfig.format(mapTopCountry.metricValue)})`
                  : "N/A"}
              </Text>
              <Text className="mt-1 text-xs text-slate-300">
                Low:{" "}
                {mapBottomCountry
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
                  mapPopupPosition ? { left: mapPopupPosition.left, top: mapPopupPosition.top } : undefined
                }
              >
                <Flex justifyContent="between" alignItems="start">
                  <div>
                    <Text className="text-slate-300">
                      {activeMapCountryDetails.countryLabel} ({activeMapCountryDetails.countryCode})
                    </Text>
                    <Title className="mt-1 text-slate-100">{activeMapCountryDetails.status}</Title>
                  </div>
                  <Badge color={STATUS_BADGE_COLOR[activeMapCountryDetails.status]}>Selected</Badge>
                </Flex>

                <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-800">
                  <div
                    className="h-full rounded-full transition-all duration-300"
                    style={{
                      width: `${Math.max(0, Math.min(100, activeMapCountryDetails.stockPct ?? 0))}%`,
                      backgroundColor: STATUS_ACCENT_COLOR[activeMapCountryDetails.status],
                    }}
                  />
                </div>

                <Grid numItems={2} className="mt-4 gap-3">
                  <div className="rounded-lg bg-slate-950/80 p-3 shadow-[0_12px_24px_-20px_rgba(15,23,42,0.95)]">
                    <Text className="text-xs text-slate-400">Current Stock (TWh)</Text>
                    <Text className="mt-1 text-lg font-semibold text-slate-100">
                      {formatNumber(activeMapCountryDetails.stockTwh, 2)}
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
                    Fill: {activeMapCountryDetails.stockPct === null ? "N/A" : `${activeMapCountryDetails.stockPct.toFixed(1)}%`}
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
  );
});

export default WorldMap;
