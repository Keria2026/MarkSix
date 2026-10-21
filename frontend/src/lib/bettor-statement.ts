import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync } from "fflate";
import { money } from "./types";
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

type Bettor = BettorStatement["bettors"][number];
export interface StatementRow {
  id: string;
  createdAt: string;
  stake: bigint;
  rebate: bigint;
  net: bigint | null;
}
const cents = (value: number) => {
  if (!Number.isSafeInteger(value))
    throw new Error("账单金额不合法，已停止导出");
  return BigInt(value);
};
const sum = (values: bigint[]) => values.reduce((a, b) => a + b, 0n);
export function statementRows(
  bettor: Bettor,
  settled: boolean,
): StatementRow[] {
  const groups = new Map<string, StatementRow>();
  const created = new Map<string, string>();
  for (const { record: r } of bettor.bets) {
    const key = r.slip_id ?? r.id;
    if (!created.has(key) || r.created_at < created.get(key)!)
      created.set(key, r.created_at);
  }
  for (const { record: r } of bettor.bets) {
    if (r.status === "cancelled") continue;
    if (settled && (r.status !== "settled" || r.payout === null))
      throw new Error("结算记录不完整，已停止导出");
    const id = r.slip_id ?? r.id;
    const row = groups.get(id) ?? {
      id,
      createdAt: created.get(id)!,
      stake: 0n,
      rebate: 0n,
      net: settled ? 0n : null,
    };
    row.stake += cents(r.stake);
    row.rebate += cents(r.rebate);
    if (row.net !== null)
      row.net += cents(r.payout!) + cents(r.rebate) - cents(r.stake);
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
  const t = bettor.totals;
  if (
    sum(rows.map((r) => r.stake)) !== cents(t.stake) + cents(t.refunded) ||
    sum(rows.map((r) => r.rebate)) !== cents(t.rebate) ||
    (settled &&
      (t.net === null || sum(rows.map((r) => r.net!)) !== -cents(t.net)))
  )
    throw new Error("账单明细与汇总不一致，已停止导出");
  return rows;
}

type Color = [number, number, number];
type Operation =
  | {
      kind: "text";
      value: string;
      x: number;
      y: number;
      size: number;
      color: Color;
    }
  | { kind: "line"; y: number }
  | { kind: "rect"; x: number; y: number; w: number; h: number; color: Color };
const WIDTH = 595.28,
  HEIGHT = 841.89,
  LEFT = 44,
  RIGHT = WIDTH - LEFT;
const ink: Color = [0.125, 0.165, 0.22],
  muted: Color = [0.44, 0.5, 0.59];
const green: Color = [0.137, 0.45, 0.345],
  red: Color = [0.65, 0.286, 0.286];
const pale: Color = [0.957, 0.969, 0.984],
  border: Color = [0.89, 0.91, 0.94];
const netText = (n: bigint | null) =>
  n === null ? "待结算" : `${n > 0n ? "+" : ""}${money(n, false)}`;
const netColor = (n: bigint | null) =>
  n === null || n === 0n ? ink : n > 0n ? green : red;

function layout(
  data: BettorStatement,
  bettor: Bettor,
  rows: StatementRow[],
  font: PDFFont,
) {
  const pages: Operation[][] = [];
  let ops: Operation[] = [];
  const charset = new Set(font.getCharacterSet());
  const printable = (v: string) =>
    [...v]
      .map((c) =>
        charset.has(c.codePointAt(0)!)
          ? c
          : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`,
      )
      .join("");
  const wrap = (value: string, size: number, width: number) => {
    const lines: string[] = [];
    let current = "";
    for (const c of printable(value)) {
      if (current && font.widthOfTextAtSize(current + c, size) > width) {
        lines.push(current);
        current = "";
      }
      current += c;
    }
    lines.push(current);
    return lines;
  };
  function text(
    value: string,
    x: number,
    y: number,
    size = 11,
    color = ink,
    maxWidth = RIGHT - x,
  ) {
    const safe = printable(value);
    const width = font.widthOfTextAtSize(safe, size);
    ops.push({
      kind: "text",
      value: safe,
      x,
      y,
      size: width > maxWidth ? (size * maxWidth) / width : size,
      color,
    });
  }
  function end(
    value: string,
    x: number,
    y: number,
    size = 11,
    color = ink,
    maxWidth = 128,
  ) {
    const safe = printable(value),
      width = font.widthOfTextAtSize(safe, size);
    const actual = width > maxWidth ? (size * maxWidth) / width : size;
    text(
      safe,
      x - font.widthOfTextAtSize(safe, actual),
      y,
      actual,
      color,
      maxWidth,
    );
  }
  const rule = (y: number) => ops.push({ kind: "line", y });
  const rect = (x: number, y: number, w: number, h: number, color: Color) =>
    ops.push({ kind: "rect", x, y, w, h, color });
  function start() {
    ops = [];
    pages.push(ops);
    rect(LEFT, 792, 28, 3, [0.216, 0.427, 0.9]);
    text("投注人对账单", LEFT, 752, 24);
    end("MarkSix", RIGHT, 756, 11, muted);
    rule(714);
  }
  function header(y: number) {
    text("投注单", LEFT, y, 13);
    end("金额单位：元", RIGHT, y, 8.5, muted);
    rect(LEFT, y - 42, RIGHT - LEFT, 27, [0.937, 0.953, 0.973]);
    text("序号", 55, y - 33, 9, muted);
    end("下注本金", 252, y - 33, 9, muted);
    end("净输赢", 396, y - 33, 9, muted);
    end(data.settled ? "反水" : "预计反水", 538, y - 33, 9, muted);
    return y - 67;
  }
  start();
  text("基本信息", LEFT, 685, 13);
  text("期号", LEFT, 651, 9, muted);
  text(data.period, LEFT, 628, 15);
  text("投注人", 310, 651, 9, muted);
  const name = bettor.name || "未登记";
  const nameSize = wrap(name, 12, RIGHT - 310).length > 4 ? 10 : 12;
  const names = wrap(name, nameSize, RIGHT - 310);
  const nameHeight = nameSize + 2;
  names.forEach((line, i) => text(line, 310, 630 - i * nameHeight, nameSize));
  const offset = Math.max(0, names.length - 2) * nameHeight;
  rect(LEFT, 509 - offset, RIGHT - LEFT, 91, pale);
  text("总净输赢", 59, 577 - offset, 9, muted);
  const net = data.settled ? -cents(bettor.totals.net!) : null;
  text(
    net === null ? "待结算" : `¥ ${netText(net)}`,
    59,
    543 - offset,
    23,
    netColor(net),
    185,
  );
  text(data.settled ? "反水" : "预计反水", 262, 577 - offset, 9, muted);
  text(money(cents(bettor.totals.rebate)), 262, 545 - offset, 17, ink, 128);
  text("本金", 406, 577 - offset, 9, muted);
  text(money(sum(rows.map((r) => r.stake))), 406, 545 - offset, 17, ink, 130);
  text(
    data.settled
      ? "净输赢已包含反水，反水不重复相加。"
      : "尚未结算，反水为预计值。",
    LEFT,
    490 - offset,
    8,
    muted,
  );
  let y = header(452 - offset);
  if (!rows.length) text("暂无有效投注单", LEFT, y, 10, muted);
  rows.forEach((row, i) => {
    if (y < 85) {
      start();
      const heading = wrap(`第 ${data.period} 期 · ${name}`, 10, RIGHT - LEFT);
      heading.forEach((line, n) => text(line, LEFT, 685 - n * 15, 10, muted));
      y = header(Math.min(640, 685 - heading.length * 15 - 20));
    }
    text(String(i + 1).padStart(3, "0"), 55, y, 10, muted, 55);
    end(money(row.stake, false), 252, y, 10);
    end(netText(row.net), 396, y, 11, netColor(row.net));
    end(money(row.rebate, false), 538, y, 10);
    rule(y - 12);
    y -= 33;
  });
  pages.forEach((page, i) => {
    ops = page;
    rule(57);
    text(`第 ${data.period} 期`, LEFT, 37, 8, muted);
    end(`${i + 1} / ${pages.length}`, RIGHT, 37, 8, muted);
  });
  return pages;
}

async function paintPdf(
  doc: PDFDocument,
  font: PDFFont,
  pages: Operation[][],
  signal: AbortSignal,
) {
  let painted = 0;
  for (const ops of pages) {
    const page = doc.addPage([WIDTH, HEIGHT]);
    for (const op of ops) {
      if (++painted % 100 === 0) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
      }
      if (op.kind === "text")
        page.drawText(op.value, {
          x: op.x,
          y: op.y,
          size: op.size,
          font,
          color: rgb(...op.color),
        });
      else if (op.kind === "rect")
        page.drawRectangle({
          x: op.x,
          y: op.y,
          width: op.w,
          height: op.h,
          color: rgb(...op.color),
        });
      else
        page.drawLine({
          start: { x: LEFT, y: op.y },
          end: { x: RIGHT, y: op.y },
          thickness: 0.6,
          color: rgb(...border),
        });
    }
  }
}
async function paintPng(
  ops: Operation[],
  family: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(WIDTH * 2);
  canvas.height = Math.ceil(HEIGHT * 2);
  try {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("浏览器无法生成 PNG，请选择 PDF");
    ctx.scale(2, 2);
    ctx.fillStyle = "white";
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    const css = (c: Color) =>
      `rgb(${c.map((n) => Math.round(n * 255)).join(",")})`;
    for (const op of ops) {
      if (op.kind === "text") {
        ctx.fillStyle = css(op.color);
        ctx.font = `${op.size}px "${family}"`;
        ctx.fillText(op.value, op.x, HEIGHT - op.y);
      } else if (op.kind === "rect") {
        ctx.fillStyle = css(op.color);
        ctx.fillRect(op.x, HEIGHT - op.y - op.h, op.w, op.h);
      } else {
        ctx.strokeStyle = css(border);
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.moveTo(LEFT, HEIGHT - op.y);
        ctx.lineTo(RIGHT, HEIGHT - op.y);
        ctx.stroke();
      }
    }
    const blob = await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob(
        (value) =>
          value ? resolve(value) : reject(new Error("PNG 生成失败，请重试")),
        "image/png",
      ),
    );
    signal.throwIfAborted();
    return new Uint8Array(await blob.arrayBuffer());
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function createBettorArchive(
  data: BettorStatement,
  fontBytes: Uint8Array,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
  format: StatementFormat,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null),
    used = new Set<string>();
  let face: FontFace | undefined,
    size = 0;
  const family = `MarkSixStatement-${crypto.randomUUID()}`;
  const add = (name: string, bytes: Uint8Array) => {
    size += bytes.length;
    if (size > 128 * 1024 * 1024)
      throw new Error("账单超过 128 MiB，已停止导出；未下载任何不完整账单");
    files[name] = bytes;
  };
  try {
    signal.throwIfAborted();
    if (format === "png") {
      face = new FontFace(family, new Uint8Array(fontBytes).buffer);
      await face.load();
      signal.throwIfAborted();
      document.fonts.add(face);
    }
    for (let index = 0; index < data.bettors.length; index++) {
      signal.throwIfAborted();
      const bettor = data.bettors[index],
        rows = statementRows(bettor, data.settled);
      const doc = await PDFDocument.create();
      doc.registerFontkit(fontkit);
      const font = await doc.embedFont(fontBytes, { subset: true });
      const pages = layout(data, bettor, rows, font);
      const name = statementFilename(bettor.name, used, format);
      if (format === "pdf") {
        doc.setTitle(`第${data.period}期 · ${bettor.name} · 投注对账单`);
        doc.setProducer("MarkSix");
        await paintPdf(doc, font, pages, signal);
        add(name, await doc.save());
      } else {
        const folder = name.slice(0, -4);
        for (let p = 0; p < pages.length; p++) {
          signal.throwIfAborted();
          add(
            `${folder}/${String(p + 1).padStart(3, "0")}.png`,
            await paintPng(pages[p], family, signal),
          );
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      }
      signal.throwIfAborted();
      progress(index + 1, data.bettors.length);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return zipSync(files, { level: 0 });
  } finally {
    if (face) document.fonts.delete(face);
  }
}
