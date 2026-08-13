export interface StatuslineData {
  updated?: number;
  goal?: {
    runrate?: number;
    target?: number;
  };
  pipeline?: {
    stages?: Array<{
      stage?: string;
      value?: number;
    }>;
    target?: number;
  };
  cash?: {
    value?: number;
  };
  nt?: {
    daily?: number;
    positions?: number;
  };
}

export function finiteStatusNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
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
  if (!stages) return undefined;
  return stages.reduce((sum, item) => {
    if (item.stage !== "REPLIED_INTERESTED" && item.stage !== "PROPOSAL_SENT") return sum;
    return finiteStatusNumber(item.value) ? sum + item.value : sum;
  }, 0);
}
