export type Kind =
  | "number"
  | "zodiac"
  | "wave"
  | "tail"
  | "parity"
  | "size"
  | "zodiac_count";
export type Scope = "regular" | "special" | "all";
export type Condition =
  | "all"
  | "none"
  | "any"
  | "hard_pair"
  | "soft_pair"
  | "at_least";
export type Relation = "eq" | "le" | "ge";
export interface Rule {
  name: string;
  kind: Kind;
  scope: Scope;
  condition: Condition;
  relation: Relation;
  quantity: number;
  combination_size: number;
  compound_enabled: boolean;
  selection_limit?: number | null;
  zodiac_count?: number | null;
  special_hit_odds?: string | null;
  minimum_hits: number;
  odds: string;
  rebate_percent: string;
  special_odds: string | null;
  zero_tail_odds?: string | null;
  special_rebate_percent: string | null;
}
export interface Play {
  id: number;
  version: number;
  rule: Rule;
  enabled: boolean;
}
export interface Mapping {
  zodiac: number[];
  natal: number;
}
export interface Draw {
  expect: string;
  open_time: string;
  numbers: number[];
  zodiac: number[];
  waves: number[];
}
export interface Risk {
  min_payout: number;
  min_net: number | null;
  max_net: number | null;
  max_payout: number;
  best_draw: number[];
  worst_draw: number[];
  elapsed_ms: number;
  nodes: number;
  strategy: string;
}
export interface Totals {
  records: number;
  units: number;
  stake: number;
  rebate: number;
  exposure: number;
  payout: number;
  winning_stake: number;
  losing_stake: number;
  gross: number | null;
  refunded: number;
  flyout_stake: number;
  flyout_net: number | null;
  retained_net: number | null;
  net: number | null;
}
export interface Period {
  id: string;
  business_date: string;
  close_time: string;
  open_time: string;
  mapping: Mapping;
  state: string;
  phase: string;
  bet_version: number;
  draw: Draw | null;
  error: string | null;
  mapping_warning: boolean;
  last_fetch_at: string | null;
  settled_at: string | null;
  risk_status: string;
  risk_version: number | null;
  risk_result: Risk | null;
  risk_error: string | null;
  risk_started_at: string | null;
  totals: Totals;
  server_time: string;
}
export interface Bootstrap {
  today: Period;
  plays: Play[];
  zodiacs: string[];
}
export interface Bet {
  bettor: string;
  revision: number;
  void_stake: number;
  void_units: number;
  id: string;
  period_id: string;
  play_id: number;
  play_version: number;
  rule: Rule;
  selections: number[];
  compound: boolean;
  amount: number;
  unit_count: number;
  stake: number;
  rebate: number;
  status: string;
  payout: number | null;
  winning_stake: number | null;
  created_at: string;
  cancelled_at: string | null;
  natal: number;
}
export interface Atom {
  special_hit_odds?: string | null;
  special_hit_payout?: number | null;
  options: number[];
  stake: number;
  payout: number;
  rebate: number;
  odds: string;
}
export interface AtomResult {
  voided: boolean;
  won: boolean;
  payout: number;
  rebate: number;
  net: number;
}
export interface Detail {
  record: Bet;
  atoms: Atom[];
  results: AtomResult[] | null;
  layoffs: Layoff[];
  events: {
    event: string;
    detail: Record<string, unknown>;
    created_at: string;
  }[];
}
export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  page_size: number;
}
export interface Quote {
  units: number;
  stake: number;
  rebate: number;
  max_return: number;
  max_profit: number;
  result: Risk;
}
export interface Settings {
  closing: { effective_date: string; open_time: string; close_time: string }[];
  mappings: { effective_date: string; mapping: Mapping }[];
  tomorrow: string;
}
export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export async function api<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options,
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      "X-Marksix": "1",
      ...options.headers,
    },
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = {
      error: response.ok ? "响应格式错误" : `请求失败（${response.status}）`,
    };
  }
  if (!response.ok)
    throw new ApiError(response.status, data.error ?? "操作失败");
  return data as T;
}
export const kinds: Record<Kind, string> = {
  number: "号码",
  zodiac: "生肖",
  wave: "波色",
  tail: "尾数",
  parity: "单双",
  size: "大小",
  zodiac_count: "生肖种数",
};
export const scopes: Record<Scope, string> = {
  regular: "平码 · 前 6 个",
  special: "特码 · 最后 1 个",
  all: "全部 · 7 个号码",
};
export const conditions: Record<Condition, string> = {
  all: "全部命中",
  none: "全部不命中",
  any: "至少命中一个",
  at_least: "至少命中 N 个",
  hard_pair: "特碰 · 位置固定",
  soft_pair: "软碰 · 位置可互换",
};
export const relations: Record<Relation, string> = {
  eq: "等于",
  le: "小于等于",
  ge: "大于等于",
};
export const phases: Record<string, string> = {
  scheduled: "尚未开盘",
  open: "接受投注",
  closed: "已封盘",
  fetching: "等待开奖",
  settling: "结算中",
  settled: "已结算",
  missing: "开奖缺失",
};
export const zodiacs = [
  "鼠",
  "牛",
  "虎",
  "兔",
  "龙",
  "蛇",
  "马",
  "羊",
  "猴",
  "鸡",
  "狗",
  "猪",
];
export function money(
  cents: number | bigint | null | undefined,
  symbol = true,
): string {
  if (cents == null) return "—";
  const n = BigInt(cents);
  const a = n < 0n ? -n : n;
  return `${n < 0n ? "−" : ""}${symbol ? "¥ " : ""}${new Intl.NumberFormat("zh-CN").format(a / 100n)}.${String(a % 100n).padStart(2, "0")}`;
}
export function signed(cents: number | null): string {
  return cents == null ? "待结算" : `${cents > 0 ? "+" : ""}${money(cents)}`;
}
export function wave(n: number): number {
  return [
    1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46,
  ].includes(n)
    ? 0
    : [3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48].includes(n)
      ? 1
      : 2;
}
export function label(kind: Kind, value: number): string {
  if (kind === "zodiac_count") return `${value} 种生肖`;
  return kind === "number"
    ? String(value).padStart(2, "0")
    : kind === "zodiac"
      ? zodiacs[value]
      : kind === "wave"
        ? ["红波", "蓝波", "绿波"][value]
        : kind === "tail"
          ? `${value}尾`
          : kind === "size"
            ? ["小", "大"][value]
            : ["双", "单"][value];
}
export function options(kind: Kind): number[] {
  const size = {
    number: 49,
    zodiac: 12,
    wave: 3,
    tail: 10,
    parity: 2,
    size: 2,
    zodiac_count: 7,
  }[kind];
  return Array.from({ length: size }, (_, i) =>
    kind === "number" || kind === "zodiac_count" ? i + 1 : i,
  );
}
export function count(n: number, k: number): number {
  if (k > n || k < 1) return 0;
  let r = 1;
  k = Math.min(k, n - k);
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
export function time(value: string | null): string {
  if (!value) return "—";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(`${value}Z`));
}

export interface LedgerTotals {
  records: number;
  units: number;
  stake: number;
  rebate: number;
  payout: number;
  refunded: number;
  net: number | null;
}
export interface Layoff {
  id: string;
  bet_id: string;
  period_id: string;
  receiver: string;
  amount: number;
  unit_count: number;
  stake: number;
  rebate: number;
  status: string;
  payout: number | null;
  void_stake: number;
  void_units: number;
  created_at: string;
}
export interface Statistics {
  period: string;
  settled: boolean;
  incoming: LedgerTotals;
  outgoing: LedgerTotals;
  retained: {
    stake: number;
    rebate: number;
    payout: number;
    net: number | null;
  };
  bettors: { name: string; totals: LedgerTotals }[];
  receivers: { name: string; totals: LedgerTotals }[];
  layoffs: Layoff[];
  layoffs_total: number;
  layoffs_page: number;
}
export function basicCount(
  rule: Rule,
  selections: number[],
  compound: boolean,
): number {
  if (
    rule.kind === "zodiac_count" &&
    (selections.length !== 1 || selections[0] !== rule.zodiac_count)
  )
    return 0;
  const n = selections.length;
  if (
    !n ||
    (compound && !rule.compound_enabled) ||
    (rule.selection_limit != null && n > rule.selection_limit)
  )
    return 0;
  const accepts = (v: number) =>
    rule.relation === "eq"
      ? v === rule.quantity
      : rule.relation === "le"
        ? v <= rule.quantity
        : v >= rule.quantity;
  if (!compound && rule.quantity !== 1 && !accepts(n)) return 0;
  if (rule.condition === "hard_pair" && n !== 2) return 0;
  const k = compound ? rule.combination_size : Math.min(n, rule.quantity);
  if (!accepts(k) || (rule.condition === "at_least" && k < rule.minimum_hits))
    return 0;
  return count(n, k);
}
export function annualMapping(year: number): Mapping {
  const natal = (((6 + year - 2026) % 12) + 12) % 12;
  return {
    natal,
    zodiac: Array.from({ length: 49 }, (_, i) => (natal - (i % 12) + 12) % 12),
  };
}

// Reject only boundaries that cannot be repaired by adding further options.
export function selectionBoundary(
  rule: Rule,
  selections: number[],
  compound: boolean,
): string | null {
  const n = selections.length;
  if (rule.selection_limit != null && n > rule.selection_limit)
    return `此玩法最多选择 ${rule.selection_limit} 项`;
  if (
    !compound &&
    rule.quantity !== 1 &&
    rule.relation !== "ge" &&
    n > rule.quantity
  )
    return `此玩法最多选择 ${rule.quantity} 项，请先取消已选项`;
  if (["hard_pair", "soft_pair"].includes(rule.condition) && n > 2)
    return "碰号玩法只能选择两个号码";
  if (basicCount(rule, selections, compound) > 1000)
    return "单次最多 1,000 条基础注，请减少候选项";
  return null;
}
