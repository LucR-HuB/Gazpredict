import { useMemo } from "react";
import { Button, Card, Flex, Grid, Metric, Text, Title } from "@tremor/react";
import type { SystemMetrics } from "../lib/api";
import { formatNumber } from "../lib/formatters";

type SystemMonitorProps = {
  systemMetrics: SystemMetrics;
  historyGaps: string[];
  forecastGaps: string[];
  logs: string;
  loading: boolean;
  isPipelineRunning: boolean;
  onRunPipeline: () => void;
};

export default function SystemMonitor({
  systemMetrics,
  historyGaps,
  forecastGaps,
  logs,
  loading,
  isPipelineRunning,
  onRunPipeline,
}: SystemMonitorProps) {
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
    <>
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
        {systemMetrics.message && <Text className="mt-2 text-xs text-amber-300">{systemMetrics.message}</Text>}
      </Card>

      <Grid numItems={1} numItemsLg={2} className="mt-6 gap-6">
        <Card>
          <Title>GIE Data Continuity</Title>
          {historyGaps.length === 0 ? (
            <Text className="mt-3 text-green-700">Data is continuous. No gaps.</Text>
          ) : (
            <div className="mt-3">
              <Text className="text-red-700">CRITICAL: {historyGaps.length} missing day(s) detected.</Text>
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
              <Text className="text-red-700">CRITICAL: {forecastGaps.length} missing day(s) detected.</Text>
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
          <Button size="xs" onClick={onRunPipeline} disabled={loading || isPipelineRunning} loading={isPipelineRunning}>
            Run Full Pipeline
          </Button>
        </Flex>
        <div className="mt-4 h-72 overflow-y-auto rounded bg-slate-900 p-4 font-mono text-sm text-green-400">
          {logs.split("\n").map((line, index) => (
            <div key={`${index}-${line}`}>{line}</div>
          ))}
        </div>
      </Card>
    </>
  );
}
