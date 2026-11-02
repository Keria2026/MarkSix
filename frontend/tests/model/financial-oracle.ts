// Independent test model. Never import production counting, money or planning code.
export interface ReferenceRule {
  name: string;
  kind: string;
  scope: string;
  condition: string;
  relation: string;
  quantity: number;
  combination_size: number;
  compound_enabled: boolean;
  minimum_hits?: number;
  odds: string;
  rebate_percent: string;
  special_odds?: string | null;
  special_rebate_percent?: string | null;
  zero_tail_odds?: string | null;
  zero_tail_rebate_percent?: string | null;
  special_hit_odds?: string | null;
}
export interface ReferenceMapping {
  natal: number;
  zodiac: number[];
}
export interface ReferenceLine {
  play: string;
  market: "macau" | "hk";
  selections: number[];
  amount: string;
  compound: boolean;
  package_zodiacs?: number[];
  drag?: { left: number[]; right: number[]; zodiac: boolean } | null;
}
export interface ReferenceAtom {
  play: string;
  market: "macau" | "hk";
  options: number[];
  stake: string;
  rebate: string;
  payout: string;
  exposure: string;
}
export function decimal(text: string, digits: number): bigint {
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw Error("Invalid reference decimal");
  const [whole, fraction = ""] = text.split(".");
  if (fraction.length > digits) throw Error("Invalid reference precision");
  return (
    BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0"))
  );
}
export function yuan(cents: bigint): string {
  return (
    String(cents / 100n) +
    (cents % 100n
      ? "." +
        String(cents % 100n)
          .padStart(2, "0")
          .replace(/0$/, "")
      : "")
  );
}
export function combinations(
  values: readonly number[],
  quantity: number,
): number[][] {
  const result: number[][] = [];
  // Enumerate indices lexicographically, independently of recursive production enumeration.
  if (quantity < 1 || quantity > values.length) return result;
  const indices = Array.from({ length: quantity }, (_, i) => i);
  while (true) {
    result.push(indices.map((i) => values[i]));
    let cursor = quantity - 1;
    while (cursor >= 0 && indices[cursor] === values.length - quantity + cursor)
      cursor--;
    if (cursor < 0) break;
    indices[cursor]++;
    for (let i = cursor + 1; i < quantity; i++) indices[i] = indices[i - 1] + 1;
  }
  return result;
}
const waves = [
  [1, 2, 7, 8, 12, 13, 18, 19, 23, 24, 29, 30, 34, 35, 40, 45, 46],
  [3, 4, 9, 10, 14, 15, 20, 25, 26, 31, 36, 37, 41, 42, 47, 48],
];
function feature(
  kind: string,
  number: number,
  mapping: ReferenceMapping,
): number {
  switch (kind) {
    case "number":
      return number;
    case "zodiac":
      return mapping.zodiac[number - 1];
    case "tail":
      return number % 10;
    case "wave":
      return waves[0].includes(number) ? 0 : waves[1].includes(number) ? 1 : 2;
    case "parity":
      return number % 2;
    case "size":
      return number >= 25 ? 1 : 0;
    default:
      throw Error("Unsupported reference feature " + kind);
  }
}
export function atomSets(
  line: ReferenceLine,
  rule: ReferenceRule,
  mapping: ReferenceMapping,
): number[][] {
  if (line.package_zodiacs?.length)
    return mapping.zodiac.flatMap((z, i) =>
      line.package_zodiacs!.includes(z) ? [[i + 1]] : [],
    );
  if (line.drag) {
    const expand = (choices: number[]) =>
      line.drag!.zodiac
        ? mapping.zodiac.flatMap((z, i) => (choices.includes(z) ? [i + 1] : []))
        : [...choices].sort((a, b) => a - b);
    const left = expand(line.drag.left),
      right = expand(line.drag.right);
    if (rule.combination_size === 2)
      return left.flatMap((a) =>
        right.map((b) => [a, b].sort((x, y) => x - y)),
      );
    return combinations(right, rule.combination_size - left.length).map(
      (trailing) => [...left, ...trailing].sort((a, b) => a - b),
    );
  }
  const values =
    rule.condition === "hard_pair"
      ? [...line.selections]
      : [...line.selections].sort((a, b) => a - b);
  if (line.compound) return combinations(values, rule.combination_size);
  if (rule.quantity === 1) return values.map((v) => [v]);
  return values.length > rule.quantity
    ? combinations(values, rule.quantity)
    : [values];
}
export function price(
  lines: ReferenceLine[],
  rules: ReferenceRule[],
  mappings: Record<"macau" | "hk", ReferenceMapping>,
): ReferenceAtom[] {
  const result: ReferenceAtom[] = [];
  const round = (stake: bigint, rate: bigint) =>
    (stake * rate + 5000n) / 10000n;
  for (const line of lines) {
    const rule = rules.find((rule) => rule.name === line.play);
    if (!rule) throw Error("Unknown reference play " + line.play);
    const mapping = mappings[line.market];
    const sets = atomSets(line, rule, mapping);
    const amount = decimal(line.amount, 2);
    const allocations = new Map<number, bigint>();
    for (const zodiac of line.package_zodiacs ?? []) {
      const pool = mapping.zodiac.flatMap((z, i) =>
        z === zodiac ? [i + 1] : [],
      );
      pool.forEach((n, i) =>
        allocations.set(
          n,
          amount / BigInt(pool.length) +
            (BigInt(i) < amount % BigInt(pool.length) ? 1n : 0n),
        ),
      );
    }
    const natalNumbers = mapping.zodiac.flatMap((z, i) =>
      z === mapping.natal ? [i + 1] : [],
    );
    const natalOptions =
      rule.kind === "zodiac_count"
        ? []
        : natalNumbers.map((n) => feature(rule.kind, n, mapping));
    for (const options of sets) {
      const stake = line.package_zodiacs?.length
        ? allocations.get(options[0])!
        : amount;
      const natal =
        rule.kind !== "wave" && options.some((n) => natalOptions.includes(n));
      const zero = rule.kind === "tail" && options.includes(0);
      const odds =
        zero && rule.zero_tail_odds
          ? rule.zero_tail_odds
          : natal && rule.special_odds
            ? rule.special_odds
            : rule.odds;
      const rebate =
        zero && rule.zero_tail_rebate_percent != null
          ? rule.zero_tail_rebate_percent
          : natal && rule.special_rebate_percent != null
            ? rule.special_rebate_percent
            : rule.rebate_percent;
      const payout = round(stake, decimal(odds, 4));
      const alternative = rule.special_hit_odds
        ? round(stake, decimal(rule.special_hit_odds, 4))
        : 0n;
      result.push({
        play: line.play,
        market: line.market,
        options,
        stake: String(stake),
        rebate: String(round(stake, decimal(rebate, 2))),
        payout: String(payout),
        exposure: String(payout > alternative ? payout : alternative),
      });
    }
  }
  return result;
}
export function canonical(atoms: ReferenceAtom[]): string {
  return JSON.stringify(atoms.map((atom) => JSON.stringify(atom)).sort());
}
export function totals(atoms: ReferenceAtom[]) {
  const sum = (field: "stake" | "rebate" | "exposure") =>
    String(atoms.reduce((sum, atom) => sum + BigInt(atom[field]), 0n));
  return {
    units: atoms.length,
    stake: sum("stake"),
    rebate: sum("rebate"),
    exposure: sum("exposure"),
  };
}
export function mapping(natal: number): ReferenceMapping {
  const zodiac: number[] = [];
  let index = natal;
  for (let number = 1; number <= 49; number++) {
    zodiac.push(index);
    index = index === 0 ? 11 : index - 1;
  }
  return { natal, zodiac };
}
