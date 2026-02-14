const API_URL = "http://localhost:8000";

export interface ForecastRecord {
  date: string;
  country: string;
  prediction_twh: number;
  net_injection: number;
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

  if (!date || !country || prediction === null || netInjection === null) {
    return null;
  }

  return {
    date,
    country,
    prediction_twh: prediction,
    net_injection: netInjection,
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

    const payload: unknown = await response.json();
    if (!response.ok) {
      throw new Error(`Pipeline request failed with status ${response.status}`);
    }

    return normalizePipelineResponse(payload);
  } catch (error) {
    throw new Error(`Pipeline failed: ${getErrorMessage(error)}`);
  }
}
