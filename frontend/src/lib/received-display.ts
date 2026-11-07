import {
  readReceived,
  type ReceivedDistribution,
  type ReceivedKind,
} from "./received";
import { zodiacs } from "./types";
export interface ReceivedDisplay {
  received: ReceivedDistribution;
  deducted: ReceivedDistribution;
  display: ReceivedDistribution;
  revision: number;
}
export function readReceivedDisplay(value: unknown): ReceivedDisplay {
  if (!value || typeof value !== "object")
    throw Error("首页显示数据不完整，请重试");
  const state = value as ReceivedDisplay;
  const received = readReceived(state.received),
    deducted = readReceived(state.deducted),
    display = readReceived(state.display);
  if (!Number.isSafeInteger(state.revision) || state.revision < 0)
    throw Error("首页显示版本无效，请重试");
  for (const kind of ["special", "zodiac", "tail"] as const) {
    if (
      display[kind].some(
        (amount, index) =>
          amount !== Math.max(0, received[kind][index] - deducted[kind][index]),
      )
    )
      throw Error("首页减出金额不一致，请刷新重试");
  }
  return { received, deducted, display, revision: state.revision };
}
export function displayCents(input: string): bigint | null {
  const text = input.trim();
  if (!/^\d+(?:\.\d{1,2})?$/u.test(text)) return null;
  const [whole, fraction = ""] = text.split(".");
  const significant = whole.replace(/^0+/u, "") || "0";
  if (significant.length > 14) return null;
  const cents = BigInt(significant) * 100n + BigInt(fraction.padEnd(2, "0"));
  return cents > 0n && cents <= 9_000_000_000_000_000n ? cents : null;
}
export function displayAmount(cents: bigint): string {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}
export function receivedItemName(kind: ReceivedKind, index: number): string {
  return kind === "special"
    ? String(index + 1).padStart(2, "0")
    : kind === "tail"
      ? `${index}尾`
      : zodiacs[index];
}
