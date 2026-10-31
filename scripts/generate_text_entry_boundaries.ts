// Diagnostic corpus: semantic labels precede rendering; never import the parser.
// All selections/amounts/headings are synthetic. Source IDs refer to user examples.
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { oracle, type OracleItem } from "./generate_text_entry";

type Basis =
  | "confirmed"
  | "extension"
  | "clarification"
  | "deferred"
  | "invalid";
export interface BoundaryRecord {
  schema: "text-entry-boundaries-v1";
  is_synthetic: true;
  split: "diagnostic";
  id: string;
  family: string;
  variant: string;
  source_examples: number[];
  basis: Basis;
  note: string;
  raw_text: string;
  mapping: { natal: number; zodiac: number[] };
  expected: {
    status: "accept" | "blocked";
    items: OracleItem[];
    units: number;
    stake: number;
  };
}
const zs = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
const cn = "零一二三四五六七八九十";
const hash = (s: string) => createHash("sha256").update(s).digest("hex");

export async function generateBoundaries(output: string) {
  const records: BoundaryRecord[] = [];
  let state = 20261031;
  const random = (max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
  const distinct = (count: number, max: number, start = 0) => {
    const pool = Array.from({ length: max }, (_, i) => i + start);
    return Array.from(
      { length: count },
      () => pool.splice(random(pool.length), 1)[0],
    );
  };
  for (let sample = 0; sample < 24; sample++) {
    const z = distinct(8, 12);
    const ns = distinct(24, 49, 1);
    const money = String(70 + sample * 10);
    const mapping = {
      natal: sample % 12,
      zodiac: Array.from(
        { length: 49 },
        (_, i) => ((sample % 12) - (i % 12) + 12) % 12,
      ),
    };
    const zt = (n: number[], sep = "") => n.map((i) => zs[i]).join(sep);
    const nt = (n: number[], sep = ".") =>
      n.map((i) => String(i).padStart(2, "0")).join(sep);
    const item = (
      play: string,
      selections: number[],
      quantity = 1,
      compound = false,
      amount = money,
    ): OracleItem => ({ play, selections, quantity, compound, amount });
    const add = (
      family: string,
      variant: string,
      source: number[],
      raw: string,
      items: OracleItem[],
      basis: Basis = "confirmed",
      note = "",
    ) => {
      const accept = basis === "confirmed" || basis === "extension";
      records.push({
        schema: "text-entry-boundaries-v1",
        is_synthetic: true,
        split: "diagnostic",
        id: `boundary-${String(records.length + 1).padStart(5, "0")}`,
        family,
        variant,
        source_examples: source,
        basis,
        note,
        raw_text: raw,
        mapping,
        expected: {
          status: accept ? "accept" : "blocked",
          items: accept ? items : [],
          ...oracle(accept ? items : [], mapping),
        },
      });
    };

    // Linked-zodiac aliases, positions, whitespace, and unsupported new spelling.
    for (const q of [2, 3, 4, 5]) {
      const selected = z.slice(0, q),
        text = zt(selected);
      const expected = [item(cn[q] + "有", selected, q)];
      const source =
        q === 2
          ? [1, 3, 4, 10]
          : q === 3
            ? [1, 2, 3, 9, 29]
            : q === 4
              ? [1, 2, 3, 4, 5, 9]
              : [4, 9];
      for (const alias of [cn[q] + "友", q + "有", q + "连", cn[q] + "连肖"])
        add(
          "linked-alias",
          `${q}:${alias}`,
          source,
          `${alias}${text}各${money}元`,
          expected,
        );
      add(
        "postfix-play",
        `${q}:adjacent`,
        source,
        `${text}${cn[q]}有${money}`,
        expected,
      );
      add(
        "postfix-play",
        `${q}:space-before-money`,
        source,
        `${text}${cn[q]}有 ${money}`,
        expected,
      );
      add(
        "split-play-token",
        `${q}:space`,
        source,
        `${q} 有 ${text} 各${money}`,
        expected,
        "extension",
        "数量与有之间允许空格的候选语法",
      );
      add(
        "split-play-token",
        `${q}:newline`,
        source,
        `${cn[q]}\n有${text}各${money}`,
        expected,
        "extension",
        "玩法词内部换行的候选语法",
      );
    }

    for (const q of [2, 3, 4, 5]) {
      const first = z.slice(0, q),
        second = z.slice(1, q + 1);
      const expected = [
        item(cn[q] + "有", first, q),
        item(cn[q] + "有", second, q),
      ];
      for (const [variant, sep] of [
        ["continuous", ""],
        ["newline", "\n"],
        ["comma", "，"],
        ["semicolon", "；"],
        ["enumeration", "、"],
        ["slash", "/"],
      ])
        add(
          "zodiac-groups",
          `${q}:${variant}`,
          [4, 9],
          `${q}连${zt(first)}${sep}${zt(second)}各${money}`,
          expected,
          ["enumeration", "slash"].includes(variant)
            ? "extension"
            : "confirmed",
          "每个完整生肖组分别投注，不合并或去重",
        );
    }

    const six = z.slice(0, 6),
      five = z.slice(0, 5);
    for (const compound of ["复式", "复试", "付", "复"])
      add(
        "compound",
        compound,
        [13, 14, 20, 21, 28, 32],
        `${zt(six)}${compound}五连肖每组${money}`,
        [item("五有", six, 5, true)],
      );
    for (const alias of ["45有", "四五有", "4有5有", "四友五友"])
      add(
        "multiple-plays",
        alias,
        [5, 21, 22, 35],
        `${zt(six)}复试${alias}各组${money}`,
        [item("四有", six, 4, true), item("五有", six, 5, true)],
      );
    for (const alias of ["4有 5有", "四有、五有", "4/5有", "四五连肖"])
      add(
        "multiple-plays",
        alias,
        [21, 22, 35],
        `${zt(six)}复式${alias}各${money}`,
        [item("四有", six, 4, true), item("五有", six, 5, true)],
        "extension",
        "分隔式多玩法共享同一候选与金额，尚未确认语法",
      );
    const multi = [
      item("三有", five, 3, true),
      item("四有", five, 4, true),
      item("五有", five, 5, true),
    ];
    const multiText = `${zt(five)}复试345有个组${money}`;
    const total = 16 * Number(money);
    for (const [variant, suffix] of [
      ["plain", `\n16组共${total}`],
      ["crlf", `\r\n16组共${total}元`],
      ["space-indent", `\n 16组共${total}`],
      ["tab-indent", `\n\t16组共${total}`],
      ["ideographic-indent", `\n　16组共${total}`],
      ["spaces-in-summary", `\n16 组 共 ${total} 元`],
      ["inline", `，16组共${total}`],
      ["jin", `\n16组共${total}斤`],
      ["chinese-count", `\n十六组共${total}`],
    ])
      add(
        "summary",
        variant,
        [23, 24],
        multiText + suffix,
        multi,
        ["spaces-in-summary", "inline", "jin", "chinese-count"].includes(
          variant,
        )
          ? "extension"
          : "confirmed",
      );
    add(
      "summary",
      "wrong-amount",
      [23, 24],
      `${multiText}\n16组共${total + 10}`,
      [],
      "invalid",
      "合计不符必须阻止提交",
    );
    add(
      "summary",
      "wrong-count-indented",
      [23, 24],
      `${multiText}\n 15组共${total}`,
      [],
      "invalid",
      "缩进不能导致错误合计被忽略",
    );
    add(
      "summary",
      "wrong-chinese-count",
      [23, 24],
      `${multiText}\n十五组共${total}`,
      [],
      "invalid",
      "即使不支持中文合计，也不能把错误合计当新投注",
    );
    add(
      "summary",
      "unknown-before-total",
      [23, 24],
      `${multiText}\n待核对共${total}`,
      [],
      "invalid",
      "未知业务文字不能被继承候选覆盖",
    );

    const fourA = z.slice(0, 4),
      fourB = z.slice(1, 5);
    add(
      "multiple-group-plays",
      "comma",
      [10, 27],
      `复试三四有${zt(fourA)}，${zt(fourB)}各${money}元一组`,
      [
        item("三有", fourA, 3, true),
        item("三有", fourB, 3, true),
        item("四有", fourA, 4, true),
        item("四有", fourB, 4, true),
      ],
    );
    add(
      "continuation",
      "compound-reuse",
      [28],
      `${zt(six)}复五有各${money}四有各${Number(money) + 10}`,
      [
        item("五有", six, 5, true),
        item("四有", six, 4, true, String(Number(money) + 10)),
      ],
    );
    add(
      "continuation",
      "same-play",
      [5, 20],
      `五有复试${zt(six)}每组${money}\n${zt(z.slice(1, 7))}每组${money}`,
      [item("五有", six, 5, true), item("五有", z.slice(1, 7), 5, true)],
    );
    add(
      "continuation",
      "explicit-resets-compound",
      [5, 20, 28],
      `五有复试${zt(six)}每组${money}\n五有${zt(five)}各${money}`,
      [item("五有", six, 5, true), item("五有", five, 5)],
    );
    add(
      "continuation",
      "unknown-reuse",
      [28],
      `${zt(six)}复五有各${money}四有照旧各${money}`,
      [],
      "invalid",
      "照旧未定义，不能覆盖未知内容后复制上一项",
    );

    // Number lists and postfix multi-number plays, including shared trailing amounts.
    for (const sep of [".", "，", " ", "\n", "、"])
      add(
        "bare-numbers",
        JSON.stringify(sep),
        [5, 19, 36],
        `${nt(ns.slice(0, 4), sep)}各${money}`,
        [item("特码", ns.slice(0, 4))],
      );
    add("bare-numbers", "dot-amount", [17], `${ns[0]}.${money}`, [
      item("特码", [ns[0]]),
    ]);
    add(
      "bare-numbers",
      "dot-small-amount",
      [17],
      `${ns[0]}.20`,
      [],
      "clarification",
      "20既可能是号码也可能是金额，不能推广34.300规则直接猜金额",
    );
    add(
      "bare-numbers",
      "leading-zero-and-joined",
      [5],
      `0${nt([ns[0]])}.${nt(ns.slice(1, 3), "")}各${money}`,
      [item("特码", ns.slice(0, 3))],
    );
    add(
      "bare-numbers",
      "joined-comma-control",
      [5],
      `0${nt([ns[0]])}，${nt(ns.slice(1, 3), "")}各${money}`,
      [item("特码", ns.slice(0, 3))],
    );
    add(
      "numeric-postfix",
      "10:space-before-play-control",
      [12],
      `${nt(ns.slice(0, 10), "，")} 十不中各${money}`,
      [item("十不中", ns.slice(0, 10), 10)],
    );
    add(
      "bare-numbers",
      "slash-separated-ambiguous",
      [19, 30, 36],
      `${nt(ns.slice(0, 3), "/")}各${money}`,
      [],
      "clarification",
      "斜线既是金额标记又可能表示号码列表，应人工确认",
    );
    for (const q of [3, 5, 10]) {
      const name = q === 3 ? "三中三" : cn[q] + "不中";
      const source = q === 3 ? [18] : q === 5 ? [11] : [12];
      const a = ns.slice(0, q),
        b = ns.slice(q, q * 2);
      for (const [variant, gap] of [
        ["adjacent", ""],
        ["space", " "],
        ["newline", "\n"],
        ["colon", "："],
      ])
        add(
          "numeric-postfix",
          `${q}:${variant}`,
          source,
          `${nt(a, "，")}${name}${gap}${money}米`,
          [item(name, a, q)],
        );
      for (const [variant, separator] of [
        ["lf", "\n"],
        ["crlf", "\r\n"],
        ["semicolon", "；"],
      ])
        add(
          "numeric-groups",
          `${q}:${variant}`,
          source,
          `${nt(a)}${separator}${nt(b)}新澳${name}各组${money}`,
          [item(name, a, q), item(name, b, q)],
          variant === "semicolon" ? "extension" : "confirmed",
        );
    }
    add(
      "number-compound",
      "prefix",
      [34],
      `澳门\n二中二复试${nt(ns.slice(0, 5))}各${money}元一组`,
      [item("二中二", ns.slice(0, 5), 2, true)],
    );
    add(
      "number-compound",
      "postfix",
      [34],
      `${nt(ns.slice(0, 5))}复试二中二各${money}元`,
      [item("二中二", ns.slice(0, 5), 2, true)],
    );

    const tail = sample % 10;
    const right = Array.from({ length: 49 }, (_, i) => i + 1).filter(
      (n) => n % 10 === tail,
    );
    const left = ns.filter((n) => n % 10 !== tail).slice(0, 2);
    const drag = [
      {
        ...item("二中二含特", [], 2, true),
        drag: { left, right, zodiac: false },
      },
    ];
    for (const label of ["二中特", "二中二带特", "二中二帶特"])
      add(
        "mixed-drag",
        label,
        [2, 8],
        `${label}${nt(left)}拖${tail}尾各${money}斤一组`,
        drag,
      );
    add(
      "mixed-drag",
      "tail-space",
      [2, 8],
      `二中特${nt(left)}拖${tail} 尾各${money}元`,
      drag,
    );
    add(
      "mixed-drag",
      "tail-newline",
      [2, 8],
      `二中特${nt(left)}拖${tail}\n尾各${money}元`,
      drag,
    );
    const zodiacRight = mapping.zodiac.flatMap((v, i) =>
      v === z[0] ? [i + 1] : [],
    );
    const zodiacLeft = ns.filter((n) => !zodiacRight.includes(n)).slice(0, 1);
    add(
      "mixed-drag",
      "zodiac",
      [8],
      `二中二带特${nt(zodiacLeft)}拖${zt([z[0]])}${money}斤一组`,
      [
        {
          ...item("二中二含特", [], 2, true),
          drag: { left: zodiacLeft, right: zodiacRight, zodiac: false },
        },
      ],
    );
    add(
      "mixed-drag",
      "overlap",
      [2, 8],
      `二中特${right[0]}拖${tail}尾各${money}`,
      [],
      "invalid",
      "拖左右号码重叠",
    );
    add(
      "mixed-drag",
      "inherited-compound",
      [8],
      `二中特${nt(left)}拖${tail}尾各${money}\n${nt(ns.slice(0, 3))}/${money}斤一组`,
      [...drag, item("二中二含特", ns.slice(0, 3), 2, true)],
    );

    for (const label of ["平特", "一肖中", "一有", "平"])
      add(
        "single-zodiac",
        label,
        [1, 3, 4, 6, 7, 31],
        `${label}${zt(z.slice(0, 2))}各${money}`,
        [item("一肖中", z.slice(0, 2))],
        "confirmed",
        label === "平" && z[0] === 6 ? "已确认按平+马解析，保留生肖马" : "",
      );
    add(
      "single-zodiac",
      "space-control",
      [4, 31],
      `平 ${zt(z.slice(0, 2))}各${money}`,
      [item("一肖中", z.slice(0, 2))],
    );
    add(
      "single-zodiac",
      "inherited",
      [5],
      `一有${zt([z[0]])}${money}元\n${zt([z[1]])}${money}元`,
      [item("一肖中", [z[0]]), item("一肖中", [z[1]])],
    );
    add("tail", "plain", [7, 15, 16], `平特${tail}尾${money}`, [
      item("尾中", [tail]),
    ]);
    add("tail", "space-before-suffix", [15, 16], `平特 ${tail} 尾 ${money}`, [
      item("尾中", [tail]),
    ]);
    add("zodiac-count", "liang-homophone", [7], `6肖亮${money}`, [
      item("六肖量", [6]),
    ]);
    for (const suffix of ["T", "t", "特"])
      add("package", suffix, [7], `${zt([z[0]])}${suffix}${money}`, [
        { ...item("特码", []), package_zodiacs: [z[0]] },
      ]);
    add(
      "package",
      "each-number",
      [30, 33],
      `澳门特${zt(z.slice(0, 2))}各数${money}`,
      [
        item(
          "特码",
          mapping.zodiac.flatMap((v, i) =>
            z.slice(0, 2).includes(v) ? [i + 1] : [],
          ),
        ),
      ],
      "confirmed",
      z[0] === 6 ? "已确认按特+马解析，保留生肖马" : "",
    );
    add(
      "package",
      "each-number-space-control",
      [30, 33],
      `澳门特 ${zt(z.slice(0, 2))}各数${money}`,
      [
        item(
          "特码",
          mapping.zodiac.flatMap((v, i) =>
            z.slice(0, 2).includes(v) ? [i + 1] : [],
          ),
        ),
      ],
    );
    add(
      "package",
      "each-zodiac-unresolved",
      [25, 26],
      `${zt(z.slice(0, 2))}各肖${money}`,
      [],
      "clarification",
      "用户确认含义取决于所选玩法：一肖中或包肖",
    );
    add(
      "package",
      "explicit-each-zodiac",
      [25, 26],
      `一肖中${zt(z.slice(0, 2))}各肖${money}`,
      [item("一肖中", z.slice(0, 2))],
    );
    add(
      "package",
      "explicit-package",
      [25, 26],
      `特码${zt(z.slice(0, 2))}每肖${money}`,
      [{ ...item("特码", []), package_zodiacs: z.slice(0, 2) }],
    );
    add(
      "mixed-number-zodiac",
      "slash-then-zodiac",
      [30],
      `${ns[0]}/${money}元${zt([z[0]])}各数${money}元`,
      [item("特码", [ns[0]]), item("特码", zodiacRight)],
    );
    add("special-regular", "combined", [6], `${ns[0]}号特平各${money}`, [
      item("特码", [ns[0]]),
      item("平码", [ns[0]]),
    ]);
    add(
      "special-regular",
      "split-token",
      [6],
      `${ns[0]}号特 平各${money}`,
      [item("特码", [ns[0]]), item("平码", [ns[0]])],
      "extension",
      "特平内部空格的候选语法",
    );
    for (const label of ["单平", "4头不中"])
      add(
        "deferred-play",
        label,
        label === "单平" ? [8] : [6],
        `${label}${money}`,
        [],
        "deferred",
        "用户明确暂时搁置，继续待确认",
      );

    // Amounts and headings use clear fields; uncertain shorthand remains blocked.
    const base = `三有${zt(z.slice(0, 3))}`;
    for (const [variant, amount, value] of [
      ["thousands", "1千", "1000"],
      ["scaled-decimal", "1.5千", "1500"],
      ["chinese", "一百零五", "105"],
      ["decimal", "12.5", "12.5"],
      ["trailing-zero", "12.50", "12.5"],
    ])
      add(
        "amount",
        variant,
        [1, 6],
        `${base}各${amount}元`,
        [item("三有", z.slice(0, 3), 3, false, value)],
        variant === "trailing-zero" ? "extension" : "confirmed",
      );
    for (const [variant, amount] of [
      ["omitted-place", "一百五"],
      ["two-decimals", "12.55"],
      ["zero", "0"],
      ["negative", "-80"],
      ["duplicated-unit", "一百百"],
    ])
      add(
        "amount",
        variant,
        [1, 6],
        `${base}各${amount}元`,
        [],
        variant === "omitted-place" ? "clarification" : "invalid",
        "禁止猜金额或接受无效金额",
      );
    for (const marker of [
      "各组",
      "每组",
      "个组",
      "各/",
      "各\n",
      "各：",
      "每 组",
    ])
      add(
        "amount-marker",
        JSON.stringify(marker),
        [1, 6, 13, 14, 23],
        `${base}${marker}${money}`,
        [item("三有", z.slice(0, 3), 3)],
        ["各：", "每 组"].includes(marker) ? "extension" : "confirmed",
      );
    for (const [variant, heading] of [
      ["unknown-name", "清风。"],
      ["unknown-heading", "清风笔记\n"],
      ["zodiac-heading", "龙先生\n"],
      ["numeric-heading", "清风88\n"],
      ["play-heading", "平特笔记\n"],
      ["market", "新奥\n"],
      ["name-colon", "清风："],
    ])
      add(
        "heading",
        variant,
        [3, 4, 6, 7, 8, 10],
        heading + base + `各${money}`,
        [item("三有", z.slice(0, 3), 3)],
        ["numeric-heading", "play-heading", "name-colon"].includes(variant)
          ? "extension"
          : "confirmed",
        "合成昵称，不复制原始客户名称；冒号也可能是自定义玩法",
      );
    add(
      "unknown-suffix",
      "business-text",
      [4, 10],
      base + `各${money}照旧要求`,
      [],
      "invalid",
      "注内业务文字不能静默丢弃",
    );
    add("missing-amount", "none", [29], base, [], "invalid");
    add(
      "duplicate",
      "same-zodiac-in-group",
      [29],
      `三有${zt([z[0], z[0], z[1]])}各${money}`,
      [],
      "invalid",
    );
    add("out-of-range", "number-50", [36], `特码50各${money}`, [], "invalid");
    add(
      "brackets",
      "incomplete",
      [4, 9],
      `三有【${zt(z.slice(0, 3))}各${money}`,
      [],
      "invalid",
    );
    const chinese = (n: number) =>
      n < 10
        ? cn[n]
        : (n < 20 ? "十" : cn[Math.floor(n / 10)] + "十") +
          (n % 10 ? cn[n % 10] : "");
    const chineseMoney = [...money].map((c) => cn[Number(c)]).join("");
    add(
      "numeric-equivalence",
      "chinese-tail-list",
      [15, 16],
      `平特一二三四五六七八九尾各${chineseMoney}`,
      [item("尾中", [1, 2, 3, 4, 5, 6, 7, 8, 9])],
    );
    add(
      "numeric-equivalence",
      "arabic-tail-list",
      [15, 16],
      `平特123456789尾各${money}`,
      [item("尾中", [1, 2, 3, 4, 5, 6, 7, 8, 9])],
    );
    add(
      "numeric-equivalence",
      "chinese-number-list",
      [19, 36],
      `${ns.slice(0, 3).map(chinese).join("，")}各${chineseMoney}`,
      [item("特码", ns.slice(0, 3))],
    );
    add(
      "numeric-equivalence",
      "twelve-play",
      [12],
      `12不中${nt(ns.slice(0, 12))}各${chineseMoney}`,
      [item("十二不中", ns.slice(0, 12), 12)],
    );
    const fullwidth = (s: string) =>
      s.replace(/[0-9]/gu, (c) =>
        String.fromCharCode(c.charCodeAt(0) + 0xfee0),
      );
    add(
      "unicode",
      "fullwidth",
      [3, 19, 36],
      fullwidth(`特码${nt(ns.slice(0, 4))}各${money}`),
      [item("特码", ns.slice(0, 4))],
    );
  }
  const seen = new Set<string>();
  for (const record of records) {
    const key = JSON.stringify([record.raw_text, record.mapping]);
    if (seen.has(key)) throw Error(`Duplicate diagnostic record: ${record.id}`);
    seen.add(key);
  }
  const content = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
  await mkdir(output, { recursive: true });
  await Bun.write(resolve(output, "cases.jsonl"), content);
  const manifest = {
    schema: "text-entry-boundaries-v1",
    seed: 20261031,
    samples_per_template: 24,
    records: records.length,
    templates: new Set(records.map((r) => r.family + ":" + r.variant)).size,
    source_examples: [
      ...new Set(records.flatMap((r) => r.source_examples)),
    ].sort((a, b) => a - b),
    sha256: hash(content),
    labels:
      "confirmed=已确认语义; extension=待评审扩展候选，不自动作为产品承诺; clarification=含义不唯一; deferred=已明确搁置; invalid=应拒绝",
    note: "独立语义先于文本渲染；无原始客户内容。诊断集禁止用于训练或作为真实准确率。未注入用户简称偏好。",
  };
  await Bun.write(
    resolve(output, "manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  return manifest;
}
if (import.meta.main)
  console.log(
    JSON.stringify(
      await generateBoundaries(
        process.argv[2] ?? "test-results/text-entry-boundaries",
      ),
      null,
      2,
    ),
  );
