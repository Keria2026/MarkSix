// Rule interactions, labelled before rendering. No production parser/counting imports.
import { mapping, type ReferenceLine } from "./financial-oracle";
import type { TextCase } from "./text-slips";

export const boundaryFamilies = [
  "amount-aliases",
  "numeric-groups",
  "shared-number-plays",
  "shared-tail-plays",
  "shared-zodiac-plays",
  "overlapping-number-selectors",
  "compound-selectors",
  "mixed-selector-drag",
  "suffix-prices",
  "large-slash-prices",
  "market-scope",
  "section-and-slip-totals",
  "unknown-content",
  "invalid-money",
  "ocr-price-aliases",
  "incomplete-and-duplicate-groups",
  "native-single-objects",
  "newline-prices",
  "postfix-direct-prices",
  "operator-prices",
  "issue-prefixed-mixed-slip",
  "ambiguous-input",
  "group-local-compound",
  "summary-precision",
  "contradictory-price-prose",
  "contradictory-unit-prose",
  "consistent-unit-prose",
  "financial-looking-heading",
  "ocr-unknown-neighbors",
  "source-and-configuration",
  "formal-money",
  "formal-issue-prefix",
  "equivalent-price-prose",
] as const;
export function* ruleBoundaryCases(
  seed: number,
  size: number,
): Generator<TextCase> {
  let state = seed >>> 0 || 1;
  const random = (max: number) => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) % max;
  };
  const pick = <T>(options: readonly T[]): T => options[random(options.length)];
  const zs = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
  const nt = (pool: number[], sep = ".") =>
    pool.map((n) => String(n).padStart(2, "0")).join(sep);
  const distinct = (count: number, max: number, start = 0) => {
    const pool = Array.from({ length: max }, (_, i) => i + start);
    return Array.from(
      { length: count },
      () => pool.splice(random(pool.length), 1)[0],
    );
  };
  for (let index = 0; index < size; index++) {
    const maps = { macau: mapping(random(12)), hk: mapping(random(12)) };
    const market = pick(["macau", "hk"] as const);
    const heading = market === "hk" ? "香港" : "澳门";
    const selected = distinct(12, 49, 1),
      z = distinct(7, 12),
      tails = distinct(4, 10);
    const value = pick(["10", "20", "70", "100", "200", "12.5", "0.5"]);
    const line = (
      play: string,
      selections: number[],
      amount = value,
      compound = false,
    ): ReferenceLine => ({ play, selections, amount, compound, market });
    const zt = (pool: number[]) => pool.map((n) => zs[n]).join("");
    let lines: ReferenceLine[] = [],
      raw = "",
      accept = true;
    const family = index % boundaryFamilies.length;
    if (family === 0) {
      const marker = pick([
        "各",
        "各买",
        "各打",
        "个数",
        "每个数字",
        "每个号码",
        "各個數字",
        "每號",
        "每注",
        "各组",
      ]);
      lines = [line("特码", selected.slice(0, 3))];
      raw =
        heading +
        "特" +
        nt(lines[0].selections, pick([".", "．", "、", "-", "–", "，"])) +
        marker +
        value +
        pick(["元", "米", "斤", "块", "塊"]);
    } else if (family === 1) {
      const q = pick([2, 3]),
        name = q === 2 ? "二中二" : "三中三";
      const groups = [selected.slice(0, q), selected.slice(q, q * 2)];
      lines = groups.map((g) => line(name, g));
      raw =
        heading +
        name +
        groups
          .map((g) => nt(g, pick([".", "-", "、"])))
          .join(pick(["，", "/", "\n", "\r\n", " ", "；"])) +
        "每组" +
        value;
    } else if (family === 2) {
      lines = [
        line("二中二", selected.slice(0, 5), value, true),
        line("三中三", selected.slice(0, 5), value, true),
      ];
      raw =
        heading +
        nt(selected.slice(0, 5)) +
        pick(["复试", "复式", "付"]) +
        "二中二三中三各组" +
        value;
    } else if (family === 3) {
      lines = [
        line("三尾连", tails, value, true),
        line("四尾连", tails, value, true),
      ];
      raw =
        heading +
        tails.join(pick([".", "、", " "])) +
        pick(["付", "复式", "复试"]) +
        pick(["三四连尾", "3.4连尾", "三、四尾连"]) +
        "各" +
        value;
    } else if (family === 4) {
      lines = [3, 4, 5].map((q) =>
        line("零一二三四五"[q] + "有", z.slice(0, 5), value, true),
      );
      raw =
        heading +
        zt(z.slice(0, 5)) +
        "复式" +
        pick(["3.4.5有", "三四五连肖", "3/4/5有"]) +
        "每组" +
        value;
    } else if (family === 5 || family === 6) {
      const head = random(5),
        tail = random(10),
        zi = random(12);
      const pool = Array.from({ length: 49 }, (_, i) => i + 1);
      const heads = pool.filter((n) => Math.floor(n / 10) === head),
        ts = pool.filter((n) => n % 10 === tail),
        zns = pool.filter((n) => maps[market].zodiac[n - 1] === zi);
      if (family === 5) {
        lines = [line("特码", [...heads, ...ts, ...zns])];
        raw =
          heading +
          "特码" +
          head +
          "头、" +
          tail +
          "尾、" +
          zs[zi] +
          "各数" +
          value;
      } else {
        const kind = random(3),
          numbers = kind === 0 ? heads : kind === 1 ? ts : zns;
        lines = [line("三中三", numbers, value, true)];
        raw =
          heading +
          "三中三复式" +
          (kind === 0 ? head + "头" : kind === 1 ? tail + "尾" : zs[zi]) +
          "每组" +
          value;
      }
    } else if (family === 7) {
      const tail = 2 + random(8),
        right = Array.from({ length: 5 }, (_, i) => tail + i * 10);
      lines = [
        {
          ...line("二中二含特", [], value, true),
          drag: { left: [1], right, zodiac: false },
        },
      ];
      raw =
        heading +
        "01拖" +
        tail +
        "尾，二中二，" +
        pick(["韩特", "含特", "韓特"]) +
        "各组" +
        value;
    } else if (family === 8) {
      lines = [
        line("特码", selected.slice(0, 2)),
        line("特码", selected.slice(2, 3), "30"),
      ];
      raw =
        heading +
        "特码" +
        nt(selected.slice(0, 2)) +
        "各" +
        value +
        "元" +
        pick(["一甲数", "一个数", "一個數"]) +
        "，" +
        nt(selected.slice(2, 3)) +
        "各30元";
    } else if (family === 9) {
      const amount = pick(["50", "59", "200", "200.5", "200.00"]);
      lines = [
        line("十不中", selected.slice(0, 10), amount.replace(/\.00$/u, "")),
      ];
      raw =
        heading +
        "十不中" +
        nt(selected.slice(0, 10)) +
        pick(["//", "///", "／／", "/ /"]) +
        amount;
    } else if (family === 10) {
      lines = [
        { ...line("特码", [selected[0]]), market: "hk" },
        { ...line("特码", [selected[1]], "30"), market: "macau" },
        { ...line("特码", [selected[2]], "40"), market: "macau" },
      ];
      raw = pick([
        `香港特码${selected[0]}各${value}元，澳门特码${selected[1]}各30元，${selected[2]}各40元`,
        `特码${selected[0]}各${value}元香港，特码${selected[1]}各30元澳门，${selected[2]}各40元`,
      ]);
    } else if (family === 11) {
      lines = [
        line("二有", z.slice(0, 2), "70"),
        line("三有", z.slice(2, 5), "30"),
      ];
      raw =
        heading +
        "二有" +
        zt(z.slice(0, 2)) +
        "各70，共70；三有" +
        zt(z.slice(2, 5)) +
        "各30，共30\n总100";
    } else if (family === 12) {
      accept = false;
      raw =
        heading +
        pick([
          `特码${selected[0]}未知各${value}`,
          `特码${selected[0]}各${value}。abc`,
          `特码${selected[0]}各${value}请取消`,
          `二中二${nt(selected.slice(0, 2))}备注各${value}`,
          `三有${zt(z.slice(0, 3))}各${value}照旧`,
          pick(["上期同上", "明天那张", "上次照抄", "昨晚那张"]) +
            "\n特码" +
            selected[0] +
            "各" +
            value,
        ]);
    } else if (family === 13) {
      accept = false;
      raw =
        heading +
        `特码${selected[0]}各` +
        pick([
          "0",
          "-10",
          "10.01",
          "90000000000000.1",
          "1.234",
          "十百",
          "一百五",
        ]) +
        "元";
    } else if (family === 14) {
      lines = [line("特码", [selected[0]], "20")];
      raw =
        heading +
        "特码" +
        nt([selected[0]]) +
        pick([
          "各",
          "每注",
          "每组",
          "各数",
          "每号",
          "个数",
          "各买",
          "每個號碼",
        ]) +
        pick(["2O", "2o", "２Ｏ"]) +
        pick(["元", "米", "斤", "塊"]);
    } else if (family === 15) {
      accept = false;
      raw =
        heading +
        pick([
          "二中二" + nt([selected[0], selected[0]]) + "各10",
          "三中三" + nt(selected.slice(0, 2)) + "各10",
          "三有" + zt([z[0], z[0], z[1]]) + "各10",
          "二中二（" + nt(selected.slice(0, 2)) + "各10",
          "二中二01拖01.02各10",
        ]);
    } else if (family === 16) {
      const kind = random(3),
        name = kind === 0 ? "尾中" : kind === 1 ? "一肖中" : "波色",
        pool =
          kind === 0
            ? tails.slice(0, 3)
            : kind === 1
              ? z.slice(0, 3)
              : [0, 1, 2];
      lines = [line(name, pool)];
      raw =
        heading +
        name +
        (kind === 0
          ? pool.map((n) => n + "尾").join("、")
          : kind === 1
            ? zt(pool)
            : "红波、蓝波、绿波") +
        "各" +
        value;
    } else if (family === 17) {
      lines = [
        line("二中二", selected.slice(0, 2)),
        line("二中二", selected.slice(2, 4)),
      ];
      raw =
        heading +
        "二中二\n" +
        nt(selected.slice(0, 2)) +
        "\n" +
        nt(selected.slice(2, 4)) +
        "\n每组" +
        value;
    } else if (family === 18) {
      lines = [
        line("特码", [selected[0]], "60"),
        line("特码", selected.slice(1, 3), "30"),
      ];
      raw =
        heading +
        nt([selected[0]]) +
        "特60，" +
        nt(selected.slice(1, 3), "，") +
        "各30";
    } else if (family === 19) {
      lines = [line("二中二", selected.slice(0, 2))];
      raw =
        heading +
        "二中二" +
        nt(selected.slice(0, 2)) +
        pick(["/", "x", "×", "*"]) +
        value +
        "元";
    } else if (family === 20) {
      lines = [
        line("特码", selected.slice(0, 3), "10"),
        line("三有", z.slice(0, 3), "20"),
      ];
      raw =
        pick(["第312期", "３１２期", "三百一十二期"]) +
        heading +
        "特" +
        nt(selected.slice(0, 3), "/") +
        "各10米\n三有" +
        zt(z.slice(0, 3)) +
        "各20元\n4注共50";
    } else if (family === 21) {
      accept = false;
      raw = pick([
        `特码${selected[0]}各100元\n一肖`,
        `特码${selected[0]}各10，香港澳门`,
        `三有${zt(z.slice(0, 4))}各10`,
        `二中二${nt(selected.slice(0, 3))}各10`,
        `特码${selected[0]}每注1,000元`,
      ]);
    } else if (family === 22) {
      const groups = [selected.slice(0, 4), selected.slice(4, 9)];
      lines = groups.map((g) => line("三中三", g, value, true));
      raw =
        heading +
        "三中三复式" +
        groups.map((g) => "(" + nt(g) + ")").join(pick([" ", "，", "\n"])) +
        "每组" +
        value;
    } else if (family === 23) {
      lines = [line("特码", selected.slice(0, 2), "12.5")];
      const wrong = random(2) === 0;
      raw =
        heading +
        "特码" +
        nt(selected.slice(0, 2)) +
        "各12.50元\n2组共" +
        (wrong ? "25.01" : "25.00");
      accept = !wrong;
      if (wrong) lines = [];
    } else if (family === 24) {
      accept = false;
      raw =
        heading +
        "特码" +
        zt(z.slice(0, 2)) +
        "各数20，是每个号码" +
        pick(["30", "三十", "３０"]);
    } else if (family === 25) {
      accept = false;
      raw =
        heading +
        "特码" +
        zt(z.slice(0, 2)) +
        pick([
          "各数20，这项是每肖，不是总共",
          "各肖20，别弄成包肖",
          "各数20，是包号那种",
          "各肖20，是每个号码",
          "各肖20，不要把" + zt(z.slice(0, 2)) + "也按每肖包",
        ]);
    } else if (family === 26) {
      const packageMode = random(2) === 0;
      lines = [
        packageMode
          ? { ...line("特码", [], "20"), package_zodiacs: z.slice(0, 2) }
          : line(
              "特码",
              maps[market].zodiac.flatMap((zi, i) =>
                z.slice(0, 2).includes(zi) ? [i + 1] : [],
              ),
              "20",
            ),
      ];
      raw =
        heading +
        "特码" +
        zt(z.slice(0, 2)) +
        (packageMode
          ? "各肖20，这项是每肖，不是总共"
          : pick(["各数", "个数", "每个号码", "各号"]) +
            " 20 元，" +
            pick(["别弄成包肖", "是每个号码 20 元", "是每个号码"]));
    } else if (family === 27) {
      accept = false;
      raw =
        pick(["200待定", "500未知金额", "一百五待确认"]) +
        "\n" +
        heading +
        "特码" +
        selected[0] +
        "各20";
    } else if (family === 28) {
      accept = false;
      raw =
        heading +
        "特码" +
        selected[0] +
        pick([
          "各2O未知元",
          "各2O元未知",
          "各O2元",
          "各2OO元",
          "号码2O元",
          "个数2O备注元",
        ]);
    } else if (family === 29) {
      lines = [line("二中二含特", selected.slice(0, 2), "20")];
      raw =
        "测试客A：\n" +
        heading +
        "二中二带特" +
        nt(selected.slice(0, 2)) +
        "每组20";
    } else if (family === 30) {
      const pairs = [
        ["壹佰", "100"],
        ["貳佰零伍", "205"],
        ["參仟", "3000"],
        ["陸拾", "60"],
        ["兩百", "200"],
        ["壹萬貳仟", "12000"],
      ] as const;
      const [written, amount] = pick(pairs);
      lines = [line("特码", selected.slice(0, 2), amount)];
      raw = heading + "特碼" + nt(selected.slice(0, 2)) + "各" + written + "元";
    } else if (family === 31) {
      lines = [line("特码", selected.slice(0, 2), "10")];
      raw =
        pick(["第壹佰貳拾參期", "參佰壹拾貳期"]) +
        heading +
        "特" +
        nt(selected.slice(0, 2)) +
        "各10";
    } else {
      const mismatch = random(2) === 0;
      lines = [
        line(
          "特码",
          maps[market].zodiac.flatMap((zi, i) => (zi === z[0] ? [i + 1] : [])),
          "12.5",
        ),
      ];
      raw =
        heading +
        "特码" +
        zs[z[0]] +
        "各数12.50元，是每个号码" +
        (mismatch ? "12.55元" : "12.5元");
      accept = !mismatch;
    }
    if (!accept) lines = [];
    if (random(5) === 0)
      raw = raw.replace(/[0-9]/gu, (c) =>
        String.fromCharCode(c.charCodeAt(0) + 0xfee0),
      );
    yield {
      id: `rules-${seed}-${index}`,
      family: boundaryFamilies[family],
      raw,
      accept,
      lines,
      mappings: maps,
    };
  }
}
