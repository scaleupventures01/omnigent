export interface StatuslineData {
  updated?: number;
  capturedAtMs?: number;
  goal?: {
    runrate?: number;
    current?: number;
    target?: number;
  };
  pipeline?: {
    stages?: Array<{
      stage?: string;
      value?: number;
    }>;
    current?: number;
    target?: number;
  };
  cash?: {
    value?: number;
    display?: string;
  };
  nt?: {
    daily?: number;
    positions?: number;
  };
  net?: {
    direction?: string;
  };
}

export function finiteStatusNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export interface RateLimitsData {
  captured?: number;
  five_hour?: {
    used_percentage?: number;
    resets_at?: number;
  };
  seven_day?: {
    used_percentage?: number;
    resets_at?: number;
  };
}

export interface FreshRateLimits {
  fiveHourPct: number;
  fiveHourResets: number;
  sevenDayPct: number;
  sevenDayResets: number;
}

export type ProviderId = "claude" | "chatgpt" | "kimi";

export interface ProviderUsageWindow {
  usedPercent: number;
  resetsAt: number;
}

export interface ProviderUsage {
  fiveHour: ProviderUsageWindow | null;
  weekly: ProviderUsageWindow | null;
}

export interface ProviderRateLimitsData {
  capturedAtMs?: number;
  providers?: Partial<Record<ProviderId, ProviderUsage>>;
}

export function providerUsageWindow(
  data: ProviderRateLimitsData | null,
  provider: ProviderId,
  window: keyof ProviderUsage,
): ProviderUsageWindow | null {
  const value = data?.providers?.[provider]?.[window];
  if (
    !value ||
    !finiteStatusNumber(value.usedPercent) ||
    !finiteStatusNumber(value.resetsAt)
  ) {
    return null;
  }
  return value;
}

/** Validated rate limits, or null when fields are missing or captured is stale. */
export function freshRateLimits(data: RateLimitsData | null, nowSeconds: number): FreshRateLimits | null {
  if (!data || !finiteStatusNumber(data.captured) || nowSeconds - data.captured > 3600) {
    return null;
  }
  const fiveHourPct = data.five_hour?.used_percentage;
  const fiveHourResets = data.five_hour?.resets_at;
  const sevenDayPct = data.seven_day?.used_percentage;
  const sevenDayResets = data.seven_day?.resets_at;
  if (
    !finiteStatusNumber(fiveHourPct) ||
    !finiteStatusNumber(fiveHourResets) ||
    !finiteStatusNumber(sevenDayPct) ||
    !finiteStatusNumber(sevenDayResets)
  ) {
    return null;
  }
  return { fiveHourPct, fiveHourResets, sevenDayPct, sevenDayResets };
}

/** 5h window remaining: "Xh" at an hour or more, else "Xm", or "now". */
export function rateLimitLeftHours(secondsLeft: number): string {
  if (secondsLeft <= 0) return "now";
  if (secondsLeft < 3600) return `${Math.floor(secondsLeft / 60)}m`;
  return `${Math.floor(secondsLeft / 3600)}h`;
}

/** 7d window remaining: "Xd" at a day or more, else "Xh". */
export function rateLimitLeftDays(secondsLeft: number): string {
  if (secondsLeft <= 0) return "now";
  if (secondsLeft >= 86400) return `${Math.floor(secondsLeft / 86400)}d`;
  return `${Math.floor(secondsLeft / 3600)}h`;
}

export function metricPercent(value: unknown, target: unknown): number | null {
  if (!finiteStatusNumber(value) || !finiteStatusNumber(target) || target <= 0) return null;
  return (value / target) * 100;
}

export function progressBar(value: number | null): string {
  if (!finiteStatusNumber(value)) return "-";
  const filled = Math.min(10, Math.max(0, Math.floor(Math.min(value, 100) / 10)));
  return `${"▓".repeat(filled)}${"░".repeat(10 - filled)}`;
}

export function displayMetricPercent(value: number | null): string {
  return finiteStatusNumber(value) ? `${Math.round(value)}%` : "-";
}

function moneySign(value: number, roundedMagnitude: number): string {
  return value < 0 && roundedMagnitude !== 0 ? "-" : "";
}

export function formatMoneyComma(value: unknown): string {
  if (!finiteStatusNumber(value)) return "-";
  const roundedMagnitude = Math.round(Math.abs(value));
  return `${moneySign(value, roundedMagnitude)}$${roundedMagnitude.toLocaleString("en-US")}`;
}

export function formatMoneyK(value: unknown): string {
  if (!finiteStatusNumber(value)) return "-";
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) {
    const roundedMagnitude = Math.round(magnitude / 1000);
    return `${moneySign(value, roundedMagnitude)}$${roundedMagnitude}K`;
  }
  const roundedMagnitude = Math.round(magnitude);
  return `${moneySign(value, roundedMagnitude)}$${roundedMagnitude}`;
}

export function formatSignedMoneyK(value: unknown): string {
  if (!finiteStatusNumber(value)) return "-";
  const formatted = formatMoneyK(value);
  return value < 0 ? formatted : `+${formatted}`;
}

export function qualifiedPipelineValue(data: StatuslineData | null): number | undefined {
  const stages = data?.pipeline?.stages;
  if (!stages) return data?.pipeline?.current;
  return stages.reduce((sum, item) => {
    if (item.stage !== "REPLIED_INTERESTED" && item.stage !== "PROPOSAL_SENT") return sum;
    return finiteStatusNumber(item.value) ? sum + item.value : sum;
  }, 0);
}
