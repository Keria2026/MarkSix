import { zipSync } from "fflate";
import type { BettorStatement, StatementFormat } from "./statement";

export async function createBettorArchive(
  data: BettorStatement,
  fontBytes: Uint8Array,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  format: StatementFormat,
): Promise<Uint8Array> {
  return zipSync(
    await createBettorFiles(data, fontBytes, signal, progress, format),
    { level: 0 },
  );
}

export async function createBettorFile(
  data: BettorStatement,
  name: string,
  fontBytes: Uint8Array,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  format: StatementFormat,
): Promise<{ name: string; bytes: Uint8Array }> {
  const bettors = data.bettors.filter((bettor) => bettor.name === name);
  if (bettors.length !== 1)
    throw new Error("未找到该投注人的完整账单，请刷新统计后重试");
  const files = await createBettorFiles(
    { ...data, bettors },
    fontBytes,
    signal,
    progress,
    format,
  );
  const [filename, bytes] = Object.entries(files)[0];
  return { name: filename, bytes };
}

async function createBettorFiles(
  data: BettorStatement,
  fontBytes: Uint8Array,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  format: StatementFormat,
): Promise<Record<string, Uint8Array>> {
  signal.throwIfAborted();
  if (format === "xlsx") {
    const { createXlsxFiles } = await import("./statement-xlsx");
    return createXlsxFiles(data, signal, progress);
  }
  if (format !== "pdf" && format !== "png") throw new Error("不支持的账单格式");
  const { createBettorFiles } = await import("./bettor-statement");
  return createBettorFiles(data, fontBytes, signal, progress, format);
}
