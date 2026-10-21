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
    end("下注本金", 190, y - 33, 9, muted, 90);
    end("中奖金额", 300, y - 33, 9, muted, 100);
    end(
      data.settled ? "水钱（比例）" : "预计水钱（比例）",
      425,
      y - 33,
      9,
      muted,
      115,
    );
    end("净输赢", 538, y - 33, 9, muted, 100);
    return y - 67;
  }
  start();
  const name = bettor.name || "未登记";
  const total = statementTotals(rows, data.settled);
  function continuation() {
    start();
    text(`投注人：${name}  ｜  第 ${data.period} 期`, LEFT, 688, 11);
    return 652;
  }
  text(`投注人：${name}  ｜  第 ${data.period} 期`, LEFT, 688, 11);
  let y = header(652);
  if (!rows.length) {
    text("暂无有效投注单", LEFT, y, 10, muted);
    y -= 33;
  }
  rows.forEach((row, i) => {
    const lines = row.bands.length
      ? row.bands.map((b) => `${b.rate}% · ${money(b.amount, false)}`)
      : ["0.00（无水钱）"];
    let line = 0;
    if (
      i === rows.length - 1 &&
      lines.length <= 15 &&
      y < Math.max(30, lines.length * 13 + 14) + 120
    )
      y = header(continuation());
    while (line < lines.length) {
      if (y < 100) y = header(continuation());
      // A receipt may contain hundreds of rates. Continue the same numbered row
      // across pages, without duplicating principal or winnings in the totals.
      const count = Math.min(
        lines.length - line,
        Math.max(1, Math.floor((y - 85) / 13)),
      );
      const center = y - (count - 1) * 6.5;
      text(
        `${String(i + 1).padStart(3, "0")}${line ? "（续）" : ""}`,
        55,
        center,
        9,
        muted,
        53,
      );
      end(line ? "—" : money(row.stake, false), 190, center, 10, ink, 90);
      end(
        line ? "—" : row.payout === null ? "待结算" : money(row.payout, false),
        300,
        center,
        10,
        ink,
        100,
      );
      for (let n = 0; n < count; n++)
        end(lines[line + n], 425, y - n * 13, 9, ink, 115);
      end(
        line ? "—" : netText(row.net),
        538,
        center,
        10,
        netColor(row.net),
        100,
      );
      const height = Math.max(30, count * 13 + 14);
      rule(y - height + 12);
      y -= height;
      line += count;
    }
  });
  if (y < 120) y = header(continuation());
  const footerHeight = 48;
  rect(LEFT, y - footerHeight + 14, RIGHT - LEFT, footerHeight, pale);
  text("合计", 55, y - 10, 10);
  end("总本金", 190, y + 1, 8, muted, 90);
  end("总中奖金额", 300, y + 1, 8, muted, 100);
  end(data.settled ? "总反水" : "预计总反水", 425, y + 1, 8, muted, 115);
  end("总净输赢", 538, y + 1, 8, muted, 100);
  end(money(total.stake, false), 190, y - 18, 10, ink, 90);
  end(
    total.payout === null ? "待结算" : money(total.payout, false),
    300,
    y - 18,
    10,
    ink,
    100,
  );
  end(money(total.rebate, false), 425, y - 18, 10, ink, 115);
  end(netText(total.net), 538, y - 18, 10, netColor(total.net), 100);
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
