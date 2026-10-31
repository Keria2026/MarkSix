import type { Bet, Atom, AtomResult, Draw, LedgerTotals } from "./types";

export interface BettorStatement {
  period: string;
  settled: boolean;
  draw: Draw | null;
  bet_version: number;
  generated_at: string;
  bettors: {
    name: string;
    totals: LedgerTotals;
    bets: { record: Bet; atoms: Atom[]; results: AtomResult[] | null }[];
  }[];
}

export type StatementFormat = "pdf" | "png";
export function statementFilename(
  name: string,
  used: Set<string>,
  format: StatementFormat,
): string {
  let stem = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+|[. ]+$/g, "");
  if (!stem) stem = "未登记";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(stem))
    stem = `投注人-${stem}`;
  while (new TextEncoder().encode(stem).length > 240)
    stem = [...stem].slice(0, -1).join("");
  let filename = `${stem}.${format}`,
    suffix = 2;
  while (used.has(filename.toUpperCase()))
    filename = `${stem} (${suffix++}).${format}`;
  used.add(filename.toUpperCase());
  return filename;
}

export type Bettor = BettorStatement["bettors"][number];
export interface RebateBand {
  rate: string;
  base: bigint;
  amount: bigint;
}
export interface StatementRow {
  id: string;
  createdAt: string;
  stake: bigint;
  payout: bigint | null;
  rebate: bigint;
  net: bigint | null;
  bands: RebateBand[];
}
const cents = (value: number) => {
  if (!Number.isSafeInteger(value))
    throw new Error("账单金额不合法，已停止导出");
  return BigInt(value);
};
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
function normalizedRate(value: string): string {
  const match = /^(\d{1,3})(?:\.(\d{1,2}))?$/.exec(value);
  if (!match) throw new Error("水钱比例不完整，已停止导出");
  const scaled =
    Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (scaled > 10000) throw new Error("水钱比例不合法，已停止导出");
  const fraction = String(scaled % 100)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return `${Math.floor(scaled / 100)}${fraction ? `.${fraction}` : ""}`;
}
function addBand(
  bands: RebateBand[],
  rate: string,
  base: bigint,
  amount: bigint,
) {
  const existing = bands.find((b) => b.rate === rate);
  if (existing) {
    existing.base += base;
    existing.amount += amount;
  } else bands.push({ rate, base, amount });
}
export function statementTotals(rows: StatementRow[], settled: boolean) {
  const bands: RebateBand[] = [];
  for (const row of rows)
    for (const band of row.bands)
      addBand(bands, band.rate, band.base, band.amount);
  bands.sort((a, b) => Number(a.rate) - Number(b.rate));
  return {
    stake: sum(rows.map((r) => r.stake)),
    payout: settled ? sum(rows.map((r) => r.payout!)) : null,
    rebate: sum(rows.map((r) => r.rebate)),
    net: settled ? sum(rows.map((r) => r.net!)) : null,
    bands,
  };
}
export function statementRows(
  bettor: Bettor,
  settled: boolean,
): StatementRow[] {
  const groups = new Map<string, StatementRow>(),
    created = new Map<string, string>();
  for (const { record: r } of bettor.bets) {
    const key = r.slip_id ?? r.id;
    if (!created.has(key) || r.created_at < created.get(key)!)
      created.set(key, r.created_at);
  }
  for (const { record: r, atoms, results } of bettor.bets) {
    if (r.status === "cancelled") continue;
    if (
      !atoms.length ||
      atoms.length !== r.unit_count ||
      (settled &&
        (r.status !== "settled" ||
          r.payout === null ||
          !results ||
          results.length !== atoms.length))
    )
      throw new Error("结算记录不完整，已停止导出");
    const id = r.slip_id ?? r.id;
    const row = groups.get(id) ?? {
      id,
      createdAt: created.get(id)!,
      stake: 0n,
      payout: settled ? 0n : null,
      rebate: 0n,
      net: settled ? 0n : null,
      bands: [],
    };
    let stake = 0n,
      rebate = 0n,
      paid = 0n,
      refunded = 0n;
    for (let i = 0; i < atoms.length; i++) {
      const atom = atoms[i],
        result = settled ? results![i] : null;
      const base = cents(atom.stake),
        amount = cents(result?.rebate ?? atom.rebate);
      stake += base;
      rebate += amount;
      if (result) paid += cents(result.payout);
      if (result?.voided) {
        if (amount !== 0n || cents(result.payout) !== base)
          throw new Error("和局金额不一致，已停止导出");
        refunded += base;
      } else
        addBand(
          row.bands,
          normalizedRate(atom.rebate_percent || r.rule.rebate_percent),
          base,
          amount,
        );
    }
    if (
      stake !== cents(r.stake) ||
      rebate !== cents(r.rebate) ||
      (settled &&
        (paid !== cents(r.payout!) || refunded !== cents(r.void_stake)))
    )
      throw new Error("基础注与投注单金额不一致，已停止导出");
    row.stake += stake;
    row.rebate += rebate;
    if (row.payout !== null) row.payout += paid;
    if (row.net !== null) row.net += paid + rebate - stake;
    groups.set(id, row);
  }
  const rows = [...groups.values()].sort((a, b) =>
    a.createdAt < b.createdAt
      ? -1
      : a.createdAt > b.createdAt
        ? 1
        : a.id < b.id
          ? -1
          : a.id > b.id
            ? 1
            : 0,
  );
  for (const row of rows)
    row.bands.sort((a, b) => Number(a.rate) - Number(b.rate));
  const total = statementTotals(rows, settled),
    t = bettor.totals;
  if (
    total.stake !== cents(t.stake) + cents(t.refunded) ||
    total.rebate !== cents(t.rebate) ||
    (settled &&
      (t.net === null ||
        total.net !== -cents(t.net) ||
        total.payout !== cents(t.payout) + cents(t.refunded)))
  )
    throw new Error("账单明细与汇总不一致，已停止导出");
  return rows;
}
