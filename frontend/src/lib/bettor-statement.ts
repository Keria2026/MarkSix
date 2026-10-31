import { PDFDocument, rgb, type PDFFont } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync } from "fflate";
import { pngEncoder } from "./png";
import { money, marketName } from "./types";
import { statementFilename, statementRows, statementTotals } from "./statement";
import type {
  BettorStatement,
  Bettor,
  StatementRow,
  StatementFormat,
} from "./statement";
export { statementFilename, statementRows, statementTotals } from "./statement";
export type {
  BettorStatement,
  StatementFormat,
  RebateBand,
  StatementRow,
} from "./statement";

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
  paginate = true,
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
    text("序号 / 市场", 55, y - 33, 9, muted, 65);
    end("下注本金", 190, y - 33, 9, muted, 90);
    end("中奖金额", 300, y - 33, 9, muted, 100);
    end(
      total.net !== null ? "水钱（比例）" : "预计水钱（比例）",
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
    text(
      `投注人：${name}  ｜  ${data.combined ? `录入日期 ${data.business_date}` : `${marketName(data.market)} 第 ${data.draw?.expect ?? data.period} 期`}`,
      LEFT,
      688,
      11,
    );
    return 652;
  }
  text(
    `投注人：${name}  ｜  ${data.combined ? `录入日期 ${data.business_date}` : `${marketName(data.market)} 第 ${data.draw?.expect ?? data.period} 期`}`,
    LEFT,
    688,
    11,
  );
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
      paginate &&
      i === rows.length - 1 &&
      lines.length <= 15 &&
      y < Math.max(45, lines.length * 13 + 14) + 120
    )
      y = header(continuation());
    while (line < lines.length) {
      if (paginate && y < 100) y = header(continuation());
      // A receipt may contain hundreds of rates. Continue the same numbered row
      // across pages, without duplicating principal or winnings in the totals.
      const count = Math.min(
        lines.length - line,
        paginate ? Math.max(1, Math.floor((y - 85) / 13)) : lines.length,
      );
      const center = y - (count - 1) * 6.5;
      text(
        `${String(i + 1).padStart(3, "0")}${line ? "（续）" : ""}`,
        55,
        center + 7,
        9,
        muted,
        53,
      );
      text(marketName(row.market), 55, center - 6, 8, muted, 60);
      text(
        row.expect ?? (row.market === "macau" ? row.periodId : "待开奖"),
        55,
        center - 18,
        7,
        muted,
        60,
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
      const height = Math.max(45, count * 13 + 14);
      rule(y - height + 12);
      y -= height;
      line += count;
    }
  });
  if (paginate && y < 120) y = header(continuation());
  const footerHeight = 48;
  rect(LEFT, y - footerHeight + 14, RIGHT - LEFT, footerHeight, pale);
  text("合计", 55, y - 10, 10);
  end("总本金", 190, y + 1, 8, muted, 90);
  end("总中奖金额", 300, y + 1, 8, muted, 100);
  end(total.net !== null ? "总反水" : "预计总反水", 425, y + 1, 8, muted, 115);
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
  const height = paginate ? HEIGHT : Math.max(HEIGHT, HEIGHT - y + 120);
  if (!paginate) for (const op of ops) op.y += height - HEIGHT;
  pages.forEach((page, i) => {
    ops = page;
    rule(57);
    text(
      `${data.combined ? `录入日期 ${data.business_date}` : `${marketName(data.market)} 第 ${data.draw?.expect ?? data.period} 期`}`,
      LEFT,
      37,
      8,
      muted,
    );
    if (paginate) end(`${i + 1} / ${pages.length}`, RIGHT, 37, 8, muted);
  });
  return { pages, height };
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
  height: number,
  family: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  signal.throwIfAborted();
  const width = Math.ceil(WIDTH * 2),
    pixels = Math.ceil(height * 2);
  const encoder = pngEncoder(width, pixels);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  const css = (c: Color) =>
    `rgb(${c.map((n) => Math.round(n * 255)).join(",")})`;
  try {
    for (let top = 0; top < pixels; top += 1024) {
      signal.throwIfAborted();
      canvas.height = Math.min(1024, pixels - top);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("浏览器无法生成 PNG，请选择 PDF");
      ctx.fillStyle = "white";
      ctx.fillRect(0, 0, width, canvas.height);
      ctx.scale(2, 2);
      ctx.translate(0, -top / 2);
      for (const op of ops) {
        const y = height - op.y;
        const start =
          op.kind === "rect"
            ? y - op.h
            : op.kind === "text"
              ? y - op.size * 1.5
              : y - 1;
        if (
          (y + (op.kind === "text" ? op.size : 1)) * 2 < top ||
          start * 2 > top + canvas.height
        )
          continue;
        if (op.kind === "text") {
          ctx.fillStyle = css(op.color);
          ctx.font = `${op.size}px "${family}"`;
          ctx.fillText(op.value, op.x, y);
        } else if (op.kind === "rect") {
          ctx.fillStyle = css(op.color);
          ctx.fillRect(op.x, y - op.h, op.w, op.h);
        } else {
          ctx.strokeStyle = css(border);
          ctx.lineWidth = 0.6;
          ctx.beginPath();
          ctx.moveTo(LEFT, y);
          ctx.lineTo(RIGHT, y);
          ctx.stroke();
        }
      }
      encoder.push(ctx.getImageData(0, 0, width, canvas.height).data);
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    signal.throwIfAborted();
    return encoder.finish();
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
      const { pages, height } = layout(
        data,
        bettor,
        rows,
        font,
        format === "pdf",
      );
      const name = statementFilename(bettor.name, used, format);
      if (format === "pdf") {
        doc.setTitle(
          `${data.combined ? `录入日期 ${data.business_date}` : `${marketName(data.market)} 第${data.draw?.expect ?? data.period}期`} · ${bettor.name} · 投注对账单`,
        );
        doc.setProducer("MarkSix");
        await paintPdf(doc, font, pages, signal);
        add(name, await doc.save());
      } else {
        add(name, await paintPng(pages[0], height, family, signal));
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
