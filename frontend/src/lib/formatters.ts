export const DAY_MS = 24 * 60 * 60 * 1000;

function parseUtcDate(date: string): Date | null {
  const normalized = date.includes("T") ? date : `${date}T00:00:00Z`;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function dateToTimestamp(date: string): number {
  const parsed = parseUtcDate(date);
  return parsed ? parsed.getTime() : 0;
}

export function formatDateLabel(date: string): string {
  const parsed = parseUtcDate(date);
  if (!parsed) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    timeZone: "UTC",
  }).format(parsed);
}

export function formatTooltipDate(date: string): string {
  const parsed = parseUtcDate(date);
  if (!parsed) {
    return date;
  }

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "2-digit",
    year: "numeric",
    timeZone: "UTC",
  }).format(parsed);
}

export function formatChartValue(value: number): string {
  return new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatTooltipValue(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return formatChartValue(value);
  }
  if (typeof value === "string") {
    return value;
  }
  return "N/A";
}

export function formatNumber(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "N/A";
  }
  return value.toFixed(digits);
}

export function formatSigned(value: number | null, digits = 2): string {
  if (value === null || Number.isNaN(value)) {
    return "N/A";
  }
  return `${value >= 0 ? "+" : ""}${value.toFixed(digits)}`;
}

export function parseNumericInput(
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
