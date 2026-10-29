// Label semantic intentions before rendering text. Never import the production parser.
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";

export interface OracleItem {
  play: string;
  selections: number[];
  compound: boolean;
  amount: string;
  quantity: number;
  package_zodiacs?: number[];
  drag?: { left: number[]; right: number[]; zodiac: boolean };
}
export interface CorpusRecord {
  schema: 2;
  is_synthetic: true;
  id: string;
  split: "train" | "validation" | "test";
  family: string;
  template: string;
  semantic_group: string;
  raw_text: string;
  mapping: { natal: number; zodiac: number[] };
  aliases: { alias: string; play: string; amount_mode: "auto" }[];
  expected: {
    status: "accept" | "blocked";
    items: OracleItem[];
    units: number;
    stake: number;
  };
}
const zs = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
function choose(n: number, k: number): number {
  if (n < k || k < 0) return 0;
  let result = 1;
  for (let i = 1; i <= k; i++) result = (result * (n - i + 1)) / i;
  return result;
}
export function oracle(items: OracleItem[], mapping: CorpusRecord["mapping"]) {
  let units = 0,
    stake = 0;
  for (const item of items) {
    let count: number;
    const cents = Math.round(Number(item.amount) * 100);
    if (item.package_zodiacs) {
      count = mapping.zodiac.filter((z) =>
        item.package_zodiacs!.includes(z),
      ).length;
      stake += item.package_zodiacs.length * cents;
    } else {
      if (item.drag) {
        const d = item.drag;
        const left = d.zodiac
          ? mapping.zodiac.filter((z) => d.left.includes(z)).length
          : d.left.length;
        const right = d.zodiac
          ? mapping.zodiac.filter((z) => d.right.includes(z)).length
          : d.right.length;
        count =
          choose(left + right, item.quantity) -
          choose(left, item.quantity) -
          choose(right, item.quantity);
      } else
        count = item.compound
          ? choose(item.selections.length, item.quantity)
          : item.quantity === 1
            ? item.selections.length
            : 1;
      stake += count * cents;
    }
    units += count;
  }
  return { units, stake };
}

export async function generateCorpus(
  output: string,
  source?: string,
  size = 5000,
) {
  if (!Number.isInteger(size) || size < 100)
    throw Error("Corpus size must be an integer >= 100");
  let state = 20261029;
  const random = (max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
  const pick = <T>(a: T[]): T => a[random(a.length)];
  const distinct = (n: number, max: number, min = 0) => {
    const pool = Array.from({ length: max }, (_, i) => i + min);
    const result: number[] = [];
    while (result.length < n)
      result.push(pool.splice(random(pool.length), 1)[0]);
    return result;
  };
  const seenTexts = new Set<string>(),
    seenGroups = new Map<string, string>();
  const files: Record<string, string[]> = {
    train: [],
    validation: [],
    test: [],
  };
  const counts: Record<string, number> = {};
  const splits = [
    ["train", Math.floor(size * 0.7), 0],
    ["validation", Math.floor(size * 0.15), 4],
    ["test", size - Math.floor(size * 0.7) - Math.floor(size * 0.15), 6],
  ] as const;
  const families = [
    "numbers",
    "zodiac",
    "groups",
    "compound",
    "postfix-package",
    "explicit-package",
    "amount-before-package",
    "zodiac-numbers",
    "numeric-drag",
    "zodiac-drag",
    "currency",
    "total",
    "mixed",
    "continuation",
    "postfix-play",
    "single-zodiac",
    "single-shorthand",
    "four-special",
    "eight-miss",
    "brackets",
    "missing-money",
    "duplicate",
    "unknown",
    "unconfirmed",
    "ambiguous-package",
    "ambiguous-numbers",
    "joined-numbers",
    "overlap",
    "invalid-money",
    "unknown-play",
    "partial-play",
    "fractional-total",
    "star-tail",
    "grouped-eight",
    "invalid-group-count",
    "phonetic-play",
    "phonetic-drag",
    "mixed-brackets",
    "fee-name",
  ];
  for (const [split, target, baseStyle] of splits) {
    let attempts = 0;
    while (files[split].length < target) {
      if (++attempts > target * 100)
        throw Error("Insufficient unique semantic examples");
      const family = families[files[split].length % families.length];
      const style = baseStyle + random(split === "train" ? 4 : 2);
      const separators = [".", " ", "、", "\n", "，", ".\n", "；", " "];
      const sep = separators[style];
      const money = pick([
        "10",
        "15",
        "25",
        "40",
        "50",
        "100",
        "200",
        "250",
        "300",
        "500",
        "600",
        "1000",
        "5000",
        "30000",
        "12.5",
      ]);
      const z = distinct(5, 12),
        ns = distinct(8, 49, 1);
      const ztext = (values: number[]) =>
        values.map((i) => zs[i]).join(style % 2 ? "" : sep);
      const ntext = (values: number[]) =>
        values.map((i) => String(i).padStart(2, "0")).join(sep);
      const each = ["各", "各号", "各注", "下", "每注", "个组", "各数", "×"][
        style
      ];
      const headerGap = ["：", "", " ", "，", "\n", ":", "；", " "][style];
      let raw = "",
        items: OracleItem[] = [],
        accept = true;
      const aliases: CorpusRecord["aliases"] = [];
      const alias = (label: string, play: string) => {
        if (label !== play)
          aliases.push({ alias: label, play, amount_mode: "auto" });
        return label;
      };
      const line = (
        play: string,
        selections: number[],
        amount = money,
        quantity = 1,
        compound = false,
      ): OracleItem => ({ play, selections, amount, quantity, compound });
      const numberHeader = alias(pick(["特", "澳特", "特码"]), "特码");
      const zodiacHeader = alias(pick(["三友", "三有"]), "三有");
      // Explicit alias labels are supervision, not automatically installed customer preferences.
      switch (family) {
        case "numbers": {
          const selection = ns.slice(0, 1 + random(7));
          raw = numberHeader + headerGap + ntext(selection) + each + money;
          items = [line("特码", selection)];
          break;
        }
        case "zodiac":
          raw =
            zodiacHeader +
            headerGap +
            ztext(z.slice(0, 3)) +
            (style % 2 ? "" : "各注") +
            money;
          items = [line("三有", z.slice(0, 3), money, 3)];
          break;
        case "groups":
          raw =
            "二有" +
            headerGap +
            z
              .slice(0, 2)
              .map((i) => zs[i])
              .join("") +
            "，" +
            z
              .slice(2, 4)
              .map((i) => zs[i])
              .join("") +
            "，各" +
            money;
          items = [
            line("二有", z.slice(0, 2), money, 2),
            line("二有", z.slice(2, 4), money, 2),
          ];
          break;
        case "compound":
          raw =
            (style % 2 ? "另复" + zodiacHeader : zodiacHeader + "复式") +
            headerGap +
            ztext(z.slice(0, 4)) +
            "各注" +
            money;
          items = [line("三有", z.slice(0, 4), money, 3, true)];
          break;
        case "postfix-package":
          raw = zs[z[0]] + alias("特", "特码") + money;
          items = [{ ...line("特码", []), package_zodiacs: [z[0]] }];
          break;
        case "explicit-package":
          raw =
            numberHeader + headerGap + "包肖" + ztext(z.slice(0, 2)) + money;
          items = [{ ...line("特码", []), package_zodiacs: z.slice(0, 2) }];
          break;
        case "amount-before-package":
          raw = numberHeader + headerGap + money + "包" + ztext(z.slice(0, 2));
          items = [{ ...line("特码", []), package_zodiacs: z.slice(0, 2) }];
          break;
        case "zodiac-numbers":
          raw =
            numberHeader + headerGap + ztext(z.slice(0, 2)) + "各数" + money;
          items = [line("特码", [], money)];
          break;
        case "numeric-drag":
          raw =
            "二中二" +
            headerGap +
            ntext(ns.slice(0, 2)) +
            "拖" +
            ntext(ns.slice(2, 4)) +
            "各" +
            money;
          items = [
            {
              ...line("二中二", [], money, 2, true),
              drag: {
                left: ns.slice(0, 2),
                right: ns.slice(2, 4),
                zodiac: false,
              },
            },
          ];
          break;
        case "zodiac-drag":
          raw =
            alias("二中特", "二中二含特") +
            headerGap +
            zs[z[0]] +
            "拖" +
            zs[z[1]] +
            "各" +
            money +
            "元";
          items = [
            {
              ...line("二中二含特", [], money, 2, true),
              drag: { left: [z[0]], right: [z[1]], zodiac: true },
            },
          ];
          break;
        case "currency":
          raw =
            numberHeader +
            headerGap +
            ntext(ns.slice(0, 2)) +
            " " +
            money +
            pick(["元", "米", "斤"]);
          items = [line("特码", ns.slice(0, 2))];
          break;
        case "total":
          raw =
            numberHeader +
            headerGap +
            ntext(ns.slice(0, 2)) +
            "共" +
            Number(money) * 2;
          items = [line("特码", ns.slice(0, 2))];
          break;
        case "mixed":
          raw =
            "三有" +
            ztext(z.slice(0, 3)) +
            "500。另复" +
            zodiacHeader +
            ztext(z.slice(0, 4)) +
            "各600";
          items = [
            line("三有", z.slice(0, 3), "500", 3),
            line("三有", z.slice(0, 4), "600", 3, true),
          ];
          break;
        case "continuation":
          raw =
            numberHeader +
            String(ns[0]).padStart(2, "0") +
            "各" +
            money +
            "，" +
            String(ns[1]).padStart(2, "0") +
            "各100";
          items = [line("特码", [ns[0]]), line("特码", [ns[1]], "100")];
          break;
        case "postfix-play":
          raw = ztext(z.slice(0, 3)) + zodiacHeader + money;
          items = [line("三有", z.slice(0, 3), money, 3)];
          break;
        case "single-zodiac":
          raw =
            alias(pick(["一宵", "平特一肖", "一肖中"]), "一肖中") +
            zs[z[0]] +
            money;
          items = [line("一肖中", [z[0]])];
          break;
        case "single-shorthand":
          raw = zs[z[0]] + "中" + money;
          items = [line("一肖中", [z[0]])];
          break;
        case "phonetic-play":
          raw =
            "壹肖鐘" +
            zs[z[0]]
              .replace("马", "嗎")
              .replace("龙", "龍")
              .replace("鸡", "雞")
              .replace("猪", "豬") +
            "各" +
            money;
          items = [line("一肖中", [z[0]])];
          break;
        case "phonetic-drag":
          raw = "二種二" + zs[z[0]] + "托" + zs[z[1]] + "各" + money;
          items = [
            {
              ...line("二中二", [], money, 2, true),
              drag: { left: [z[0]], right: [z[1]], zodiac: true },
            },
          ];
          break;
        case "mixed-brackets":
          raw = "八不中{" + ntext(ns) + "]各" + money;
          items = [line("八不中", ns, money, 8)];
          break;
        case "fee-name":
          raw =
            "特碼45倍" +
            headerGap +
            String(ns[0]).padStart(2, "0") +
            "各" +
            money;
          items = [line("特码45倍", [ns[0]])];
          break;
        case "four-special":
          raw = "新澳门四肖" + headerGap + ztext(z.slice(0, 4)) + money + "米";
          accept = false; // The current customer defaults do not configure 四肖中特.
          break;
        case "eight-miss":
          raw = "八不中" + headerGap + ntext(ns) + "/" + money;
          items = [line("八不中", ns, money, 8)];
          break;
        case "brackets":
          raw =
            numberHeader +
            "【" +
            ntext(ns.slice(0, 4)) +
            "】[" +
            ntext(ns.slice(4, 8)) +
            "]各号" +
            money;
          items = [line("特码", ns.slice(0, 4)), line("特码", ns.slice(4, 8))];
          break;
        case "star-tail":
          raw = "平特一肖" + zs[z[0]] + money + "*";
          items = [line("一肖中", [z[0]])];
          break;
        case "grouped-eight":
          raw =
            "八不中【" +
            ntext(ns) +
            "】{" +
            ntext([...ns].reverse()) +
            "}各" +
            money;
          items = [
            line("八不中", ns, money, 8),
            line("八不中", [...ns].reverse(), money, 8),
          ];
          break;
        case "invalid-group-count":
          raw =
            "八不中【" +
            ntext(ns.slice(0, 7)) +
            "】[" +
            ntext(ns) +
            "]各" +
            money;
          accept = false;
          break;
        case "missing-money":
          raw = "三有" + ztext(z.slice(0, 3));
          accept = false;
          break;
        case "duplicate":
          raw = "三有" + zs[z[0]] + zs[z[0]] + zs[z[1]] + "各" + money;
          accept = false;
          break;
        case "unknown":
          raw = "特码" + ntext(ns.slice(0, 2)) + "各" + money + "照旧要求";
          accept = false;
          break;
        case "unconfirmed":
          raw = "私家未定义" + ztext(z.slice(0, 3)) + money;
          aliases.length = 0;
          accept = false;
          break;
        case "ambiguous-package":
          raw = "特码" + zs[z[0]] + money;
          accept = false;
          break;
        case "ambiguous-numbers":
          raw = "特码" + ntext(ns.slice(0, 3));
          accept = false;
          break;
        case "joined-numbers":
          raw =
            "特码" +
            String(ns[0]).padStart(2, "0") +
            String(ns[1]).padStart(2, "0") +
            "各" +
            money;
          accept = false;
          break;
        case "overlap":
          raw = "二中二" + ns[0] + "拖" + ns[0] + " " + ns[1] + "各" + money;
          accept = false;
          break;
        case "invalid-money":
          raw = "特码" + ntext(ns.slice(0, 2)) + "各" + money + ".25";
          accept = false;
          break;
        case "unknown-play":
          raw = "未知玩法" + ztext(z.slice(0, 4)) + money + "米";
          accept = false;
          break;
        case "partial-play":
          raw = "特码\n三有" + ztext(z.slice(0, 3)) + money;
          accept = false;
          break;
        case "fractional-total":
          raw = "特码" + ntext(ns.slice(0, 3)) + "共100";
          accept = false;
          break;
      }
      if (style === 7)
        raw = raw.replace(/[0-9]/gu, (c) =>
          String.fromCharCode(c.charCodeAt(0) + 0xfee0),
        );
      const natal = random(12);
      const mapping = {
        natal,
        zodiac: Array.from(
          { length: 49 },
          (_, i) => (natal - (i % 12) + 12) % 12,
        ),
      };
      if (family === "zodiac-numbers")
        items[0].selections = mapping.zodiac.flatMap((v, i) =>
          z.slice(0, 2).includes(v) ? [i + 1] : [],
        );
      const semantic = sha(
        JSON.stringify({
          family,
          items,
          negative: accept ? null : { z, ns, money },
          mapping,
        }),
      );
      if (
        seenTexts.has(raw) ||
        (seenGroups.has(semantic) && seenGroups.get(semantic) !== split)
      )
        continue;
      seenTexts.add(raw);
      seenGroups.set(semantic, split);
      const expected = {
        status: accept ? ("accept" as const) : ("blocked" as const),
        items,
        ...oracle(items, mapping),
      };
      const record: CorpusRecord = {
        schema: 2,
        is_synthetic: true,
        id: `${split}-${String(files[split].length + 1).padStart(5, "0")}`,
        split,
        family,
        template: `${family}:${style}`,
        semantic_group: semantic,
        raw_text: raw,
        mapping,
        aliases: aliases.filter(
          (a, i, list) =>
            items.some((item) => item.play === a.play) &&
            raw.includes(a.alias) &&
            list.findIndex((b) => b.alias === a.alias) === i,
        ),
        expected,
      };
      files[split].push(JSON.stringify(record));
      counts[family] = (counts[family] ?? 0) + 1;
    }
  }
  await mkdir(output, { recursive: true });
  const hashes: Record<string, string> = {};
  for (const [name, records] of Object.entries(files)) {
    const content = records.join("\n") + "\n";
    await Bun.write(resolve(output, `${name}.jsonl`), content);
    hashes[name] = sha(content);
  }
  const sourceText = source ? await Bun.file(source).text() : null;
  const manifest = {
    schema: 2,
    generated_by: "scripts/generate_text_entry.ts",
    seed: 20261029,
    records: size,
    splits: Object.fromEntries(
      Object.entries(files).map(([k, v]) => [k, v.length]),
    ),
    families: counts,
    sha256: hashes,
    source:
      sourceText === null
        ? null
        : {
            sha256: sha(sourceText),
            characters: sourceText.length,
            nonempty_lines: sourceText.split(/\r?\n/u).filter((s) => s.trim())
              .length,
          },
    note: "Synthetic semantic labels are created before text rendering. No raw source records or account data are copied. Train/validation/test have disjoint texts, semantic groups and rendering templates; these share a curated domain grammar and do not prove unrestricted natural-language accuracy.",
  };
  await Bun.write(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
if (import.meta.main) {
  const output = process.argv[2] ?? "test-results/text-entry-corpus";
  const source = process.argv[3];
  console.log(JSON.stringify(await generateCorpus(output, source), null, 2));
}
