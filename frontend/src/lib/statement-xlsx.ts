// Minimal OOXML workbook: numeric cells, explicit formatting and no external links.
import { strToU8, zipSync } from "fflate";
import { statementFilename, statementRows } from "./statement";
import type { BettorStatement, StatementRow } from "./statement";

interface ExcelRow {
  id: string;
  stake: bigint;
  rebate: bigint;
  payout: bigint | null;
  net: bigint | null;
}
const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
const REL = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
function escapeXml(value: string) {
  return value
    .replace(
      /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,
      "",
    )
    .replace(
      /[&<>"']/g,
      (char) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&apos;",
        })[char]!,
    );
}
function decimal(cents: bigint) {
  const negative = cents < 0n;
  const absolute = negative ? -cents : cents;
  const fraction = String(absolute % 100n)
    .padStart(2, "0")
    .replace(/0+$/, "");
  return (
    (negative ? "-" : "") +
    String(absolute / 100n) +
    (fraction ? "." + fraction : "")
  );
}
// Excel keeps only 15 significant decimal digits. Preserve larger values as
// exact text, and never use SUM/row formulas that would silently ignore that text.
function numeric(cents: bigint) {
  return (
    (cents < 0n ? -cents : cents).toString().replace(/0+$/, "").length <= 15
  );
}
function moneyStyle(value: bigint, winnings: boolean, total: boolean) {
  const precision = value % 100n === 0n ? 0 : value % 10n === 0n ? 1 : 2;
  return (total ? (winnings ? 12 : 9) : winnings ? 6 : 3) + precision;
}
function textCell(ref: string, value: string, style = 0) {
  return (
    '<c r="' +
    ref +
    '" s="' +
    style +
    '" t="inlineStr"><is><t xml:space="preserve">' +
    escapeXml(value) +
    "</t></is></c>"
  );
}
function moneyCell(
  ref: string,
  value: bigint | null,
  winnings = false,
  total = false,
  formula?: string,
) {
  const style =
    value === null ? (total ? 1 : 0) : moneyStyle(value, winnings, total);
  if (value === null) return textCell(ref, "待结算", style);
  if (!numeric(value)) return textCell(ref, decimal(value), style);
  return (
    '<c r="' +
    ref +
    '" s="' +
    style +
    '">' +
    (formula ? "<f>" + escapeXml(formula) + "</f>" : "") +
    "<v>" +
    decimal(value) +
    "</v></c>"
  );
}
function receiptRows(rows: StatementRow[]): ExcelRow[] {
  const receipts = new Map<string, ExcelRow>();
  for (const row of rows) {
    // Rebate bands contain effective principal; voided/refunded stakes are
    // excluded from both principal and winnings, consistent with the ledger.
    const stake = row.bands.reduce((sum, band) => sum + band.base, 0n);
    const refunded = row.stake - stake;
    const payout = row.payout === null ? null : row.payout - refunded;
    const net = row.net === null ? null : -row.net; // Ledger/operator direction.
    if (
      refunded < 0n ||
      (payout !== null && payout < 0n) ||
      (net !== null && payout !== null && net !== stake - row.rebate - payout)
    )
      throw new Error("账单结账金额不一致，已停止导出");
    const receipt = receipts.get(row.id);
    if (!receipt) {
      receipts.set(row.id, {
        id: row.id,
        stake,
        rebate: row.rebate,
        payout,
        net,
      });
    } else {
      receipt.stake += stake;
      receipt.rebate += row.rebate;
      receipt.payout =
        receipt.payout === null || payout === null
          ? null
          : receipt.payout + payout;
      receipt.net =
        receipt.net === null || net === null ? null : receipt.net + net;
    }
  }
  return [...receipts.values()];
}
const styles = (() => {
  const fonts = [
    '<font><sz val="12"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font>',
    '<font><b/><sz val="12"/><color rgb="FF000000"/><name val="Arial"/><family val="2"/></font>',
    '<font><sz val="12"/><color rgb="FFFF0000"/><name val="Arial"/><family val="2"/></font>',
    '<font><b/><sz val="12"/><color rgb="FFFF0000"/><name val="Arial"/><family val="2"/></font>',
  ];
  const formats = [
    [164, "0.0"],
    [165, "0;-0;;@"],
    [166, "0.0;-0.0;;@"],
    [167, "0.00;-0.00;;@"],
  ] as const;
  const xfs = [
    [0, 0],
    [1, 0],
    [3, 0],
    [0, 1],
    [0, 164],
    [0, 2],
    [2, 165],
    [2, 166],
    [2, 167],
    [1, 1],
    [1, 164],
    [1, 2],
    [3, 1],
    [3, 164],
    [3, 2],
  ];
  return (
    XML +
    '<styleSheet xmlns="' +
    NS +
    '"><numFmts count="' +
    formats.length +
    '">' +
    formats
      .map(
        ([id, code]) =>
          '<numFmt numFmtId="' +
          id +
          '" formatCode="' +
          escapeXml(code) +
          '"/>',
      )
      .join("") +
    '</numFmts><fonts count="4">' +
    fonts.join("") +
    '</fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
    '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border>' +
    ["left", "right", "top", "bottom"]
      .map(
        (side) =>
          "<" + side + ' style="thin"><color rgb="FF000000"/></' + side + ">",
      )
      .join("") +
    '<diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="' +
    xfs.length +
    '">' +
    xfs
      .map(
        ([font, format]) =>
          '<xf numFmtId="' +
          format +
          '" fontId="' +
          font +
          '" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyNumberFormat="1" applyAlignment="1"><alignment horizontal="center" vertical="center" shrinkToFit="1"/></xf>',
      )
      .join("") +
    '</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>'
  );
})();

async function workbook(
  data: BettorStatement,
  name: string,
  rows: ExcelRow[],
  signal: AbortSignal,
) {
  if (rows.length > 1_048_574)
    throw new Error("账单超过 Excel 行数上限，已停止导出");
  const headers = ["序号", "总单", "水", "中", "结账"];
  const body = [
    '<row r="1" ht="24" customHeight="1">' +
      headers
        .map((header, index) =>
          textCell(
            String.fromCharCode(65 + index) + "1",
            header,
            index === 3 ? 2 : 1,
          ),
        )
        .join("") +
      "</row>",
  ];
  for (let index = 0; index < rows.length; index++) {
    if (index % 100 === 0) {
      signal.throwIfAborted();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    const row = rows[index],
      number = index + 2;
    const formula =
      row.payout !== null &&
      row.net !== null &&
      [row.stake, row.rebate, row.payout, row.net].every(numeric)
        ? "ROUND(B" + number + "-C" + number + "-D" + number + ",2)"
        : undefined;
    body.push(
      '<row r="' +
        number +
        '"><c r="A' +
        number +
        '" s="0"><v>' +
        (index + 1) +
        "</v></c>" +
        moneyCell("B" + number, row.stake) +
        moneyCell("C" + number, row.rebate) +
        moneyCell("D" + number, row.payout, true) +
        moneyCell("E" + number, row.net, false, false, formula) +
        "</row>",
    );
  }
  const last = rows.length + 2;
  const sum = (field: "stake" | "rebate" | "payout" | "net") =>
    rows.some((row) => row[field] === null)
      ? null
      : rows.reduce((sum, row) => sum + row[field]!, 0n);
  body.push(
    '<row r="' +
      last +
      '" ht="24" customHeight="1">' +
      textCell("A" + last, "总数", 1) +
      (["stake", "rebate", "payout", "net"] as const)
        .map((field, index) => {
          const column = String.fromCharCode(66 + index),
            total = sum(field);
          const formula =
            rows.length &&
            total !== null &&
            numeric(total) &&
            rows.every((row) => row[field] !== null && numeric(row[field]!))
              ? "ROUND(SUM(" + column + "2:" + column + (last - 1) + "),2)"
              : undefined;
          return moneyCell(
            column + last,
            total,
            field === "payout",
            true,
            formula,
          );
        })
        .join("") +
      "</row>",
  );
  signal.throwIfAborted();
  const sheet =
    XML +
    '<worksheet xmlns="' +
    NS +
    '"><dimension ref="A1:E' +
    last +
    '"/>' +
    '<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews>' +
    '<sheetFormatPr defaultRowHeight="21"/><cols>' +
    [9, 15, 14, 14, 16]
      .map(
        (width, index) =>
          '<col min="' +
          (index + 1) +
          '" max="' +
          (index + 1) +
          '" width="' +
          width +
          '" customWidth="1"/>',
      )
      .join("") +
    "</cols><sheetData>" +
    body.join("") +
    "</sheetData>" +
    '<printOptions horizontalCentered="1"/><pageMargins left="0.3" right="0.3" top="0.5" bottom="0.5" header="0.2" footer="0.2"/><pageSetup paperSize="9" orientation="portrait" fitToWidth="1" fitToHeight="0"/></worksheet>';
  const parts = {
    "[Content_Types].xml":
      XML +
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>',
    "_rels/.rels":
      XML +
      '<Relationships xmlns="' +
      REL +
      '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>',
    "xl/workbook.xml":
      XML +
      '<workbook xmlns="' +
      NS +
      '" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="账单" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">\'账单\'!$1:$1</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>',
    "xl/_rels/workbook.xml.rels":
      XML +
      '<Relationships xmlns="' +
      REL +
      '"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
    "xl/styles.xml": styles,
    "xl/worksheets/sheet1.xml": sheet,
    "docProps/core.xml":
      XML +
      '<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>' +
      escapeXml(
        name + " · " + (data.business_date ?? data.period) + " · 投注账单",
      ) +
      "</dc:title><dc:creator>MarkSix</dc:creator></cp:coreProperties>",
  };
  const bytes = Object.fromEntries(
    Object.entries(parts).map(([path, xml]) => [path, strToU8(xml)]),
  );
  if (
    Object.values(bytes).reduce((size, part) => size + part.length, 0) >
    128 * 1024 * 1024
  )
    throw new Error("账单超过 128 MiB，已停止导出");
  return zipSync(bytes, { level: 6 });
}

export async function createXlsxFiles(
  data: BettorStatement,
  signal: AbortSignal,
  progress: (done: number, total: number) => void,
): Promise<Record<string, Uint8Array>> {
  const files: Record<string, Uint8Array> = Object.create(null),
    used = new Set<string>();
  let size = 0;
  signal.throwIfAborted();
  for (let index = 0; index < data.bettors.length; index++) {
    const bettor = data.bettors[index];
    signal.throwIfAborted();
    const rows = receiptRows(statementRows(bettor, data.settled));
    const bytes = await workbook(data, bettor.name, rows, signal);
    size += bytes.length;
    if (size > 128 * 1024 * 1024)
      throw new Error("账单超过 128 MiB，已停止导出");
    files[statementFilename(bettor.name, used, "xlsx")] = bytes;
    progress(index + 1, data.bettors.length);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return files;
}
