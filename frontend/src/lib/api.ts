const API_URL = "http://localhost:8000";

export interface ForecastRecord {
  date: string;
  country: string;
  prediction_twh: number;
  net_injection: number;
  injection_upper: number | null;
  injection_lower: number | null;
  stock_upper: number | null;
  stock_lower: number | null;
}

export interface HistoryRecord {
  date: string;
  country: string;
  stock_twh: number;
  fill_pct: number | null;
}

export interface PipelineResponse {
  status: string;
  logs: string;
}

export interface SystemMetrics {
  r2: number;
  mae: number;
  rmse: number;
  wape: number;
  training_date?: string;
  message?: string;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeHistoryRecord(value: unknown): HistoryRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const date = typeof candidate.date === "string" ? candidate.date : null;
  const country = typeof candidate.country === "string" ? candidate.country : null;
  const stock = toFiniteNumber(candidate.stock_twh ?? candidate.storage_twh);
  const fillPct = toFiniteNumber(candidate.fill_pct);

  if (!date || !country || stock === null) {
    return null;
  }

  return {
    date,
    country,
    stock_twh: stock,
    fill_pct: fillPct,
  };
}

function normalizeForecastRecord(value: unknown): ForecastRecord | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  const date = typeof candidate.date === "string" ? candidate.date : null;
  const country = typeof candidate.country === "string" ? candidate.country : null;
  const prediction = toFiniteNumber(candidate.prediction_twh ?? candidate.stock_twh_simulated);
  const netInjection = toFiniteNumber(candidate.net_injection ?? candidate.net_injection_pred);
  const injectionUpper = toFiniteNumber(candidate.injection_upper ?? candidate.confidence_upper);
  const injectionLower = toFiniteNumber(candidate.injection_lower ?? candidate.confidence_lower);
  const stockUpper = toFiniteNumber(candidate.stock_upper);
  const stockLower = toFiniteNumber(candidate.stock_lower);

  if (!date || !country || prediction === null || netInjection === null) {
    return null;
  }

  return {
    date,
    country,
    prediction_twh: prediction,
    net_injection: netInjection,
    injection_upper: injectionUpper,
    injection_lower: injectionLower,
    stock_upper: stockUpper,
    stock_lower: stockLower,
  };
}

function normalizePipelineResponse(payload: unknown): PipelineResponse {
  if (typeof payload !== "object" || payload === null) {
    return {
      status: "unknown",
      logs: "> Pipeline completed.",
    };
  }

  const candidate = payload as Record<string, unknown>;
  const status = typeof candidate.status === "string" ? candidate.status : "unknown";
  const logs = typeof candidate.logs === "string" ? candidate.logs : "> Pipeline completed.";

  return { status, logs };
}

function normalizeSystemMetrics(payload: unknown): SystemMetrics {
  const defaults: SystemMetrics = {
    r2: 0,
    mae: 0,
    rmse: 0,
    wape: 0,
    message: "No model trained yet",
  };

  if (typeof payload !== "object" || payload === null) {
    return defaults;
  }

  const candidate = payload as Record<string, unknown>;
  const r2 = toFiniteNumber(candidate.r2) ?? 0;
  const mae = toFiniteNumber(candidate.mae) ?? 0;
  const rmse = toFiniteNumber(candidate.rmse) ?? 0;
  const wape = toFiniteNumber(candidate.wape) ?? 0;
  const trainingDate = typeof candidate.training_date === "string" ? candidate.training_date : undefined;
  const message = typeof candidate.message === "string" ? candidate.message : undefined;

  return {
    r2,
    mae,
    rmse,
    wape,
    ...(trainingDate ? { training_date: trainingDate } : {}),
    ...(message ? { message } : {}),
  };
}

export async function getGieHistory(params?: {
  country?: string;
  startDate?: string;
}): Promise<HistoryRecord[]> {
  try {
    const query = new URLSearchParams();
    if (params?.country) {
      query.set("country", params.country);
    }
    if (params?.startDate) {
      query.set("start_date", params.startDate);
    }

    const queryString = query.toString();
    const url = `${API_URL}/api/gie-history${queryString ? `?${queryString}` : ""}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`GIE history request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return [];
    }

    return payload
      .map(normalizeHistoryRecord)
      .filter((row): row is HistoryRecord => row !== null);
  } catch (error) {
    console.error("API Error (GIE History):", error);
    return [];
  }
}

export async function getForecast(): Promise<ForecastRecord[]> {
  try {
    const response = await fetch(`${API_URL}/api/forecast`);
    if (!response.ok) {
      throw new Error(`Forecast request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    if (!Array.isArray(payload)) {
      return [];
    }

    return payload
      .map(normalizeForecastRecord)
      .filter((row): row is ForecastRecord => row !== null);
  } catch (error) {
    console.error("API Error (Forecast):", error);
    return [];
  }
}

export async function runPipeline(): Promise<PipelineResponse> {
  try {
    const response = await fetch(`${API_URL}/api/pipeline/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
    });

    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const detail =
        typeof payload === "object" &&
        payload !== null &&
        "detail" in payload &&
        typeof (payload as { detail?: unknown }).detail === "string"
          ? (payload as { detail: string }).detail
          : null;
      throw new Error(
        `Pipeline request failed with status ${response.status}${detail ? `: ${detail}` : ""}`,
      );
    }

    return normalizePipelineResponse(payload);
  } catch (error) {
    throw new Error(`Pipeline failed: ${getErrorMessage(error)}`);
  }
}

export async function getSystemMetrics(): Promise<SystemMetrics> {
  try {
    const response = await fetch(`${API_URL}/api/system/metrics`);
    if (!response.ok) {
      throw new Error(`System metrics request failed with status ${response.status}`);
    }

    const payload: unknown = await response.json();
    return normalizeSystemMetrics(payload);
  } catch (error) {
    console.error("API Error (System Metrics):", error);
    return normalizeSystemMetrics(null);
  }
}
