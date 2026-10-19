import { PDFDocument, rgb, type PDFFont, type PDFPage } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { zipSync } from "fflate";
import { money, label, time } from "./types";
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

export function pdfFilename(name: string, used: Set<string>): string {
  let stem = name
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/^\.+|[. ]+$/g, "");
  if (!stem) stem = "未登记";
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:[ .]|$)/i.test(stem))
    stem = `投注人-${stem}`;
  while (new TextEncoder().encode(stem).length > 240)
    stem = [...stem].slice(0, -1).join("");
  let filename = `${stem}.pdf`,
    suffix = 2;
  while (used.has(filename.toUpperCase()))
    filename = `${stem} (${suffix++}).pdf`;
  used.add(filename.toUpperCase());
  return filename;
}

function writer(
  doc: PDFDocument,
  font: PDFFont,
  heading: string,
  period: string,
) {
  const charset = new Set(font.getCharacterSet());
  const printable = (text: string) =>
    [...text]
      .map((c) =>
        charset.has(c.codePointAt(0)!)
          ? c
          : `[U+${c.codePointAt(0)!.toString(16).toUpperCase()}]`,
      )
      .join("");
  const wrap = (text: string, size: number, width: number): string[] => {
    const lines: string[] = [];
    let current = "";
    for (const char of printable(text)) {
      if (current && font.widthOfTextAtSize(current + char, size) > width) {
        lines.push(current);
        current = "";
      }
      current += char;
    }
    lines.push(current);
    return lines;
  };
  let page: PDFPage,
    y = 0;
  const ink = rgb(0.13, 0.19, 0.29),
    muted = rgb(0.3, 0.36, 0.46);
  const newPage = () => {
    page = doc.addPage([595.28, 841.89]);
    y = 800;
    page.drawText("MarkSix · 投注人对账单", {
      x: 40,
      y,
      size: 15,
      font,
      color: ink,
    });
    y -= 24;
    for (const line of wrap(`第 ${period} 期 · ${heading}`, 10, 515)) {
      page.drawText(line, { x: 40, y, size: 10, font, color: muted });
      y -= 15;
    }
    y -= 9;
  };
  const ensure = (height: number) => {
    if (y - height < 55) newPage();
  };
  const paragraph = (text: string, size = 10) => {
    for (const line of wrap(text, size, 515)) {
      ensure(size + 8);
      page.drawText(line, { x: 40, y, size, font, color: ink });
      y -= size + 6;
    }
    y -= 5;
  };
  let columns: string[] | null = null;
  const row = (cells: string[], header = false): void => {
    if (header) columns = cells;
    const widths = [172, 65, 60, 72, 65, 81];
    const content = cells.map((v, i) => wrap(v, 9, widths[i] - 10));
    const height = Math.max(...content.map((c) => c.length)) * 13 + 12;
    const previous = page;
    ensure(height);
    if (!header && page !== previous && columns) row(columns, true);
    if (header)
      page.drawRectangle({
        x: 40,
        y: y - height + 10,
        width: 515,
        height,
        color: rgb(0.91, 0.94, 0.98),
      });
    let x = 40;
    for (let i = 0; i < content.length; i++) {
      content[i].forEach((line, lineIndex) =>
        page.drawText(line, {
          x: x + 5,
          y: y - lineIndex * 13,
          size: 9,
          font,
          color: ink,
        }),
      );
      x += widths[i];
    }
    page.drawLine({
      start: { x: 40, y: y - height + 9 },
      end: { x: 555, y: y - height + 9 },
      thickness: 0.4,
      color: rgb(0.82, 0.86, 0.92),
    });
    y -= height;
  };
  newPage();
  return {
    paragraph,
    row,
    finish: () => {
      const pages = doc.getPages();
      pages.forEach((p, i) =>
        p.drawText(
          `第 ${i + 1} / ${pages.length} 页 · 投注人视角 · 金额单位：元`,
          { x: 40, y: 28, size: 9, font, color: muted },
        ),
      );
    },
  };
}

export async function createBettorArchive(
  data: BettorStatement,
  fontBytes: Uint8Array,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = Object.create(null);
  const used = new Set<string>();
  let painted = 0;
  for (let index = 0; index < data.bettors.length; index++) {
    signal.throwIfAborted();
    const bettor = data.bettors[index];
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const font = await doc.embedFont(fontBytes, { subset: true });
    doc.setTitle(`第${data.period}期 · ${bettor.name} · 投注对账单`);
    doc.setProducer("MarkSix");
    const output = writer(
      doc,
      font,
      `投注人：${bettor.name || "未登记"}`,
      data.period,
    );
    const totalNet =
      bettor.totals.net === null ? "待结算" : money(-bettor.totals.net);
    output.paragraph(
      `总净输赢（含反水）：${totalNet}    ${data.settled ? "反水（水钱）" : "预计反水（水钱）"}：${money(bettor.totals.rebate)}`,
      12,
    );
    output.paragraph(
      `有效本金：${money(bettor.totals.stake)}    和局退本：${money(bettor.totals.refunded)}`,
    );
    output.paragraph(
      `账本版本：${data.bet_version}    生成时间：${data.generated_at}（北京时间）`,
    );
    output.paragraph(
      data.draw
        ? `开奖结果：${data.draw.numbers.slice(0, 6).join(" · ")}  +  ${data.draw.numbers[6]}`
        : "尚未取得有效开奖结果；输赢、返还显示待结算，反水为预计值。",
    );
    output.paragraph(
      "正数为投注人盈利，负数为亏损；和局返还本金且无反水；撤销项不计总额。飞出不改变投注人的原受注账目。",
    );
    const groups = new Map<string, typeof bettor.bets>();
    for (const bet of bettor.bets) {
      const key = bet.record.slip_id ?? bet.record.id;
      const entries = groups.get(key) ?? [];
      entries.push(bet);
      groups.set(key, entries);
    }
    for (const [id, bets] of groups) {
      const grouped = bets[0].record.slip_id !== null;
      const net = bets
        .filter((b) => b.record.status !== "cancelled")
        .reduce(
          (sum, b) =>
            sum +
            (b.record.payout === null
              ? 0
              : b.record.payout + b.record.rebate - b.record.stake),
          0,
        );
      output.paragraph(`${grouped ? "组合单" : "投注记录"} ${id}`, 11);
      if (grouped)
        output.paragraph(
          `${bets.length} 个分项 · 整单净输赢：${data.settled ? money(net) : "待结算"}`,
        );
      bets.sort(
        (a, b) => (a.record.slip_position ?? 0) - (b.record.slip_position ?? 0),
      );
      for (let n = 0; n < bets.length; n++) {
        const { record, atoms, results } = bets[n];
        if (
          (record.status === "settled" && !results) ||
          (results && results.length !== atoms.length)
        )
          throw new Error("结算明细不完整，已停止导出");
        const cancelled = record.status === "cancelled";
        output.paragraph(
          `${grouped ? `${n + 1}. ` : ""}${record.rule.name} · ${time(record.created_at)} · ${record.compound ? "复式" : atoms.length > 1 ? "多选" : "单注"}${cancelled ? " · 已作废，不计总额" : ""}`,
        );
        output.row(
          [
            "基础注 / 含本赔率",
            "本金",
            "判定",
            "含本返还",
            data.settled ? "反水" : "预计反水",
            "净输赢",
          ],
          true,
        );
        for (let i = 0; i < atoms.length; i++) {
          if (++painted % 100 === 0)
            await new Promise((resolve) => setTimeout(resolve, 0));
          signal.throwIfAborted();
          const atom = atoms[i],
            result = results?.[i];
          const state = cancelled
            ? "已作废"
            : result
              ? result.voided
                ? "和局退本"
                : result.won
                  ? "中奖"
                  : "未中"
              : "待结算";
          const odds =
            result?.won &&
            atom.special_hit_odds &&
            atom.options.includes(data.draw?.numbers[6] ?? -1)
              ? atom.special_hit_odds
              : atom.odds;
          output.row([
            `${atom.options.map((v) => label(atom.kind, v)).join(" · ")} / ${odds}倍`,
            money(atom.stake),
            state,
            cancelled ? "—" : result ? money(result.payout) : "待结算",
            cancelled ? "—" : money(result?.rebate ?? atom.rebate),
            cancelled ? "—" : result ? money(-result.net) : "待结算",
          ]);
        }
        output.paragraph(
          `分项净输赢：${cancelled ? "不计" : record.payout === null ? "待结算" : money(record.payout + record.rebate - record.stake)}    反水：${cancelled ? "不计" : money(record.rebate)}`,
        );
      }
    }
    output.finish();
    signal.throwIfAborted();
    files[pdfFilename(bettor.name, used)] = await doc.save();
    progress(index + 1, data.bettors.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return zipSync(files, { level: 0 });
}
