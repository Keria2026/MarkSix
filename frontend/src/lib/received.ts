export type ReceivedKind = "special" | "zodiac" | "tail";
export type ReceivedDistribution = Record<ReceivedKind, number[]>;
const sizes: Record<ReceivedKind, number> = {
  special: 49,
  zodiac: 12,
  tail: 10,
};
export function readReceived(value: unknown): ReceivedDistribution {
  if (!value || typeof value !== "object")
    throw Error("受注分布数据不完整，请重试");
  for (const kind of Object.keys(sizes) as ReceivedKind[]) {
    const amounts = (value as ReceivedDistribution)[kind];
    if (
      !Array.isArray(amounts) ||
      amounts.length !== sizes[kind] ||
      amounts.some(
        (n) => !Number.isSafeInteger(n) || n < 0 || n > 9_000_000_000_000_000,
      )
    )
      throw Error("受注分布数据不完整，请重试");
    if (
      amounts.reduce((sum, n) => sum + BigInt(n), 0n) > 9_000_000_000_000_000n
    )
      throw Error("受注分布金额超出允许范围");
  }
  return value as ReceivedDistribution;
}
export function receivedSummary(amounts: number[]) {
  const total = amounts.reduce((sum, n) => sum + BigInt(n), 0n);
  const count = BigInt(amounts.length);
  const round = (n: bigint) => (n + count / 2n) / count;
  return {
    total,
    average: round(total),
    cells: amounts.map((amount) => ({
      amount,
      above: BigInt(amount) * count > total,
      excess:
        BigInt(amount) * count > total
          ? round(BigInt(amount) * count - total)
          : 0n,
    })),
  };
}
