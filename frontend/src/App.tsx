import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Button,
  Card,
  Flex,
  Grid,
  MultiSelect,
  MultiSelectItem,
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
import CountryComparison from "./components/CountryComparison";
import CountryDeepDive from "./components/CountryDeepDive";
import OverviewDashboard from "./components/OverviewDashboard";
import SystemMonitor from "./components/SystemMonitor";
import { getForecast, getGieHistory, getSystemMetrics, runPipeline } from "./lib/api";
import type { ForecastRecord, HistoryRecord, SystemMetrics } from "./lib/api";
import { COUNTRY_LABEL_BY_CODE, ISO2_TO_ISO3 } from "./lib/countries";
import { dateToTimestamp, formatNumber, formatSigned, parseNumericInput } from "./lib/formatters";
import {
  buildOverviewForecastChart,
  buildOverviewRows,
  findDateGaps,
  sortForecastRecords,
  sortHistoryRecords,
  withNetInjection,
} from "./lib/transformers";
import type { ForecastExportRow, MapMetric, MapPoint, MapProjection, OverviewRiskRow } from "./lib/types";

const WITHDRAWAL_ALERT_THRESHOLD_DAY = -0.5;
const DEFAULT_WITHDRAWAL_THRESHOLD_14D = 5.0;
const DEFAULT_HISTORY_LOOKBACK_DAYS = 365;
const OVERVIEW_FORECAST_TOP_COUNTRIES = 6;

const DEFAULT_SYSTEM_METRICS: SystemMetrics = {
  r2: 0,
  mae: 0,
  rmse: 0,
  wape: 0,
  message: "No model trained yet",
};

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
  const [forecast, setForecast] = useState<ForecastRecord[]>([]);
  const [history, setHistory] = useState<HistoryRecord[]>([]);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics>(DEFAULT_SYSTEM_METRICS);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string>("> System ready.");
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isPipelineRunning, setIsPipelineRunning] = useState(false);
  const [selectedCountry, setSelectedCountry] = useState<string>("");
  const [comparisonPeers, setComparisonPeers] = useState<string[]>([]);
  const [highWithdrawalThresholdInput, setHighWithdrawalThresholdInput] = useState<string>(
    String(DEFAULT_WITHDRAWAL_THRESHOLD_14D),
  );
  const [historyLookbackInput, setHistoryLookbackInput] = useState<string>(
    String(DEFAULT_HISTORY_LOOKBACK_DAYS),
  );
  const [mapMetric, setMapMetric] = useState<MapMetric>("stock");
  const [mapProjection, setMapProjection] = useState<MapProjection>("natural earth");

  const highWithdrawalThreshold14d = useMemo(
    () => parseNumericInput(highWithdrawalThresholdInput, 0.5, 30, DEFAULT_WITHDRAWAL_THRESHOLD_14D),
    [highWithdrawalThresholdInput],
  );

  const effectiveHistoryLookbackDays = useMemo(() => {
    const parsed = Number(historyLookbackInput);
    if (!Number.isFinite(parsed)) {
      return DEFAULT_HISTORY_LOOKBACK_DAYS;
    }
    return Math.max(Math.round(parsed), 1);
  }, [historyLookbackInput]);

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

  const handleRefresh = useCallback(() => {
    void loadData();
  }, [loadData]);

  const handleRunPipelineClick = useCallback(() => {
    void handleRunPipeline();
  }, [handleRunPipeline]);

  const countries = useMemo(() => {
    return Array.from(new Set([...history.map((row) => row.country), ...forecast.map((row) => row.country)])).sort();
  }, [history, forecast]);

  useEffect(() => {
    if (countries.length === 0) {
      return;
    }

    if (!selectedCountry || !countries.includes(selectedCountry)) {
      setSelectedCountry(countries.includes("FR") ? "FR" : countries[0]);
    }

    if (comparisonPeers.length === 0) {
      return;
    }

    const uniqueValidPeers = Array.from(
      new Set(comparisonPeers.filter((country) => countries.includes(country) && country !== selectedCountry)),
    );

    const peersChanged =
      uniqueValidPeers.length !== comparisonPeers.length ||
      uniqueValidPeers.some((country, index) => country !== comparisonPeers[index]);

    if (peersChanged) {
      setComparisonPeers(uniqueValidPeers);
    }
  }, [comparisonPeers, countries, selectedCountry]);

  const historyWithNetInjection = useMemo(() => withNetInjection(history), [history]);

  const overviewRows = useMemo(
    () => buildOverviewRows(historyWithNetInjection, forecast, highWithdrawalThreshold14d),
    [forecast, highWithdrawalThreshold14d, historyWithNetInjection],
  );

  const overviewForecastChart = useMemo(
    () => buildOverviewForecastChart(forecast, OVERVIEW_FORECAST_TOP_COUNTRIES),
    [forecast],
  );

  const overviewRiskSeries = useMemo<OverviewRiskRow[]>(() => {
    return [...overviewRows]
      .sort((a, b) => (a.forecastedInjection14dSum ?? 0) - (b.forecastedInjection14dSum ?? 0))
      .map((row) => ({
        Country: row.country,
        "Forecasted Injection (14d Sum)": row.forecastedInjection14dSum ?? 0,
      }));
  }, [overviewRows]);

  const mapPoints = useMemo<MapPoint[]>(() => {
    const latestHistoryByCountry = new Map<string, (typeof historyWithNetInjection)[number]>();
    for (const row of historyWithNetInjection) {
      latestHistoryByCountry.set(row.country, row);
    }

    const lastForecastByCountry = new Map<string, ForecastRecord>();
    for (const row of forecast) {
      lastForecastByCountry.set(row.country, row);
    }

    return overviewRows.flatMap((row) => {
      const iso3 = ISO2_TO_ISO3[row.country];
      if (!iso3) {
        return [];
      }

      const historyRow = latestHistoryByCountry.get(row.country);
      const forecastRow = lastForecastByCountry.get(row.country);
      const forecastStockJ14 = forecastRow?.prediction_twh ?? row.forecastedStockJ14 ?? null;
      const netChangeJ14 = historyRow && forecastStockJ14 !== null ? forecastStockJ14 - historyRow.stock_twh : null;

      return [
        {
          iso3,
          countryCode: row.country,
          countryLabel: COUNTRY_LABEL_BY_CODE[row.country] ?? row.country,
          stockTwh: row.currentStockTwh,
          stockPct: row.stockPct,
          currentNetInjection: historyRow?.net_injection ?? null,
          forecastStockJ14,
          netChangeJ14,
          forecastedInjection14dSum: row.forecastedInjection14dSum,
          status: row.status,
        },
      ];
    });
  }, [forecast, historyWithNetInjection, overviewRows]);

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
    return forecast.reduce(
      (max, row) => (dateToTimestamp(row.date) > dateToTimestamp(max) ? row.date : max),
      forecast[0].date,
    );
  }, [forecast]);

  const handleMapCountryClick = useCallback((countryCode: string) => {
    if (!countries.includes(countryCode)) {
      return;
    }
    setSelectedCountry(countryCode);
  }, [countries]);

  const availableComparisonOptions = useMemo(
    () => countries.filter((country) => country !== selectedCountry),
    [countries, selectedCountry],
  );

  const effectiveComparisonCountries = useMemo(() => {
    if (!selectedCountry) {
      return [] as string[];
    }
    return [selectedCountry, ...comparisonPeers];
  }, [comparisonPeers, selectedCountry]);

  const analysisViewKey = useMemo(() => {
    if (comparisonPeers.length > 0) {
      return `analysis-comparison-${effectiveComparisonCountries.join("-")}`;
    }
    if (!selectedCountry) {
      return "analysis-empty";
    }
    return `analysis-detail-${selectedCountry}`;
  }, [comparisonPeers.length, effectiveComparisonCountries, selectedCountry]);

  return (
    <main className="dark min-h-screen bg-slate-950 p-10 font-sans text-slate-100">
      <Flex className="mb-8" justifyContent="between" alignItems="center">
        <div>
          <Title className="text-3xl font-bold text-slate-100">GasGuardian ⚡️</Title>
          <Text>Storage Forecast Control Room</Text>
          <Text className="mt-1 text-xs text-slate-300">Forecast through: {maxForecastDate}</Text>
        </div>
        <div className="flex gap-2">
          <Button size="xs" variant="secondary" onClick={handleRefresh} disabled={loading || isPipelineRunning}>
            {loading ? "Loading..." : "Refresh"}
          </Button>
          <Button
            size="xs"
            onClick={handleRunPipelineClick}
            disabled={loading || isPipelineRunning}
            loading={isPipelineRunning}
          >
            Run Pipeline
          </Button>
        </div>
      </Flex>

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
                  <OverviewDashboard
                    overviewRows={overviewRows}
                    overviewForecastChart={overviewForecastChart}
                    overviewRiskSeries={overviewRiskSeries}
                    highWithdrawalThreshold14d={highWithdrawalThreshold14d}
                    mapPoints={mapPoints}
                    mapMetric={mapMetric}
                    mapProjection={mapProjection}
                    onMapMetricChange={setMapMetric}
                    onMapProjectionChange={setMapProjection}
                    onMapCountryClick={handleMapCountryClick}
                  />
                </TabPanel>

                <TabPanel>
                  <Card className="mt-6">
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

                  <Card className="mt-6">
                    <Title>Spread Comparison</Title>
                    <Text className="mt-1">
                      Compare the active country with one or more peers.
                    </Text>
                    <div className="mt-4">
                      <Text>Compare {selectedCountry || "country"} with</Text>
                      <MultiSelect
                        value={comparisonPeers}
                        onValueChange={setComparisonPeers}
                        placeholder="Select countries..."
                        className="mt-2"
                      >
                        {availableComparisonOptions.map((country) => (
                          <MultiSelectItem key={country} value={country}>
                            {country} - {COUNTRY_LABEL_BY_CODE[country] ?? country}
                          </MultiSelectItem>
                        ))}
                      </MultiSelect>
                    </div>
                    {comparisonPeers.length === 0 && (
                      <Text className="mt-2 text-xs text-slate-400">
                        Select at least one peer to open the comparison view.
                      </Text>
                    )}
                  </Card>

                  <div key={analysisViewKey} className="analysis-view-enter">
                    {comparisonPeers.length > 0 && (
                      <CountryComparison
                        selectedCountries={effectiveComparisonCountries}
                        history={historyWithNetInjection}
                        forecast={forecast}
                        historyLookbackDays={effectiveHistoryLookbackDays}
                      />
                    )}

                    {comparisonPeers.length === 0 && !selectedCountry && (
                      <Card className="mt-6">
                        <Title>Select a country</Title>
                        <Text className="mt-2">
                          Choose at least one country to open Country Analysis. Select multiple countries to compare
                          spreads.
                        </Text>
                      </Card>
                    )}

                    {comparisonPeers.length === 0 && selectedCountry && (
                      <CountryDeepDive
                        selectedCountry={selectedCountry}
                        history={historyWithNetInjection}
                        forecast={forecast}
                        threshold={WITHDRAWAL_ALERT_THRESHOLD_DAY}
                        historyLookbackDays={effectiveHistoryLookbackDays}
                      />
                    )}
                  </div>
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
            <SystemMonitor
              systemMetrics={systemMetrics}
              historyGaps={historyGaps}
              forecastGaps={forecastGaps}
              logs={logs}
              loading={loading}
              isPipelineRunning={isPipelineRunning}
              onRunPipeline={handleRunPipelineClick}
            />
          </TabPanel>
        </TabPanels>
      </TabGroup>
    </main>
  );
}

export default App;
