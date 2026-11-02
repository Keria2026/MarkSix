// Generate labelled intentions before rendering human-facing text. No production imports.
import {
  mapping,
  price,
  totals,
  yuan,
  type ReferenceLine,
  type ReferenceMapping,
  type ReferenceRule,
} from "./financial-oracle";
export interface TextCase {
  id: string;
  family: string;
  raw: string;
  accept: boolean;
  lines: ReferenceLine[];
  mappings: Record<"macau" | "hk", ReferenceMapping>;
}
const zodiac = "鼠牛虎兔龙蛇马羊猴鸡狗猪";
const aliases: Record<string, string[]> = {
  特码: ["特码", "特碼", "特"],
  平码: ["平码", "平碼"],
  二中二含特: ["二中二含特", "二中二带特", "二中二帶特"],
  三有: ["三有", "3有", "三连肖"],
  四有: ["四有", "4有", "四连肖"],
  二有: ["二有", "2有", "二连肖"],
  五有: ["五有", "5有", "五连肖"],
};
export function* textCases(
  rules: ReferenceRule[],
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
  const pick = <T>(items: readonly T[]): T => items[random(items.length)];
  const distinct = (count: number, max: number, start = 0) => {
    const pool = Array.from({ length: max }, (_, i) => i + start);
    const result: number[] = [];
    while (result.length < count)
      result.push(pool.splice(random(pool.length), 1)[0]);
    return result;
  };
  const ruleFor = (name: string) => rules.find((rule) => rule.name === name)!;
  for (let index = 0; index < size; index++) {
    const maps = { macau: mapping(random(12)), hk: mapping(random(12)) };
    const sep = pick([" ", "、", ".", ",", "，"]);
    const market = () => pick(["macau", "hk"] as const);
    const marketWord = (value: "macau" | "hk") =>
      value === "hk"
        ? pick(["香港", "港", "香"])
        : pick(["新澳门", "澳", "澳门"]);
    const name = (rule: ReferenceRule) =>
      pick(aliases[rule.name] ?? [rule.name]);
    const amount = () =>
      pick(["10", "20", "35", "80", "100", "200", "12.5", "0.5", "1200"]);
    const money = (value: string) => {
      const chinese: Record<string, string> = {
        "10": "十",
        "20": "二十",
        "35": "三十五",
        "80": "八十",
        "100": "一百",
        "200": "两百",
        "1200": "一千二百",
      };
      return random(4) === 0 && chinese[value] ? chinese[value] : value;
    };
    const amountText = (value: string) =>
      pick(["各", "每注", "各组", "每组"]) +
      money(value) +
      pick(["", "元", "米", "斤"]);
    const objects = (rule: ReferenceRule, selected: number[]) => {
      const render = (value: number) =>
        rule.kind === "number"
          ? String(value).padStart(2, "0")
          : rule.kind === "zodiac"
            ? zodiac[value]
            : rule.kind === "tail"
              ? String(value) + "尾"
              : rule.kind === "wave"
                ? ["红波", "蓝波", "绿波"][value]
                : String(value);
      return selected
        .map(render)
        .join(rule.kind === "zodiac" ? pick(["", " ", "、"]) : sep);
    };
    const make = (rule: ReferenceRule, compound = false): ReferenceLine => {
      const sizes: Record<string, number> = {
        number: 49,
        zodiac: 12,
        tail: 10,
        wave: 3,
        zodiac_count: 7,
      };
      const count =
        rule.quantity === 1
          ? 1 + random(Math.min(3, sizes[rule.kind]))
          : rule.quantity + (compound ? 1 + random(2) : 0);
      return {
        play: rule.name,
        market: market(),
        selections:
          rule.kind === "zodiac_count"
            ? [
                Number(
                  rule.name[0] === "四"
                    ? 4
                    : rule.name[0] === "五"
                      ? 5
                      : rule.name[0] === "六"
                        ? 6
                        : 7,
                ),
              ]
            : distinct(count, sizes[rule.kind], rule.kind === "number" ? 1 : 0),
        compound,
        amount: amount(),
      };
    };
    const render = (line: ReferenceLine, explicit = true) => {
      const rule = ruleFor(line.play);
      const pool = line.drag
        ? objects(rule, line.drag.left) + "拖" + objects(rule, line.drag.right)
        : line.package_zodiacs
          ? line.package_zodiacs.map((z) => zodiac[z]).join("")
          : objects(rule, line.selections);
      const marker = line.package_zodiacs
        ? "各肖" + money(line.amount) + "元"
        : amountText(line.amount);
      return (
        (explicit ? marketWord(line.market) + name(rule) : "") +
        (line.compound && !line.drag ? "复式" : "") +
        pool +
        marker
      );
    };
    let lines: ReferenceLine[] = [];
    let raw = "";
    let accept = true;
    const family = index % 18;
    if (family === 0) {
      const rule = pick(rules.filter((rule) => rule.kind !== "zodiac_count"));
      lines = [make(rule)];
      raw = render(lines[0]);
    } else if (family === 1) {
      const rule = pick(rules.filter((rule) => rule.compound_enabled));
      lines = [make(rule, true)];
      raw = render(lines[0]);
    } else if (family === 2) {
      const rule = pick(rules.filter((rule) => rule.compound_enabled));
      const left = 1 + random(Math.min(2, rule.combination_size - 1));
      const total = left + (rule.combination_size - left) + 1 + random(2);
      const size = rule.kind === "number" ? 49 : rule.kind === "tail" ? 10 : 12;
      const pool = distinct(total, size, rule.kind === "number" ? 1 : 0);
      lines = [
        {
          play: rule.name,
          market: market(),
          amount: amount(),
          selections: [],
          compound: true,
          drag: {
            left: pool.slice(0, left),
            right: pool.slice(left),
            zodiac: false,
          },
        },
      ];
      raw = render(lines[0]);
    } else if (family === 3) {
      const rule = pick(
        rules.filter(
          (rule) =>
            rule.kind === "number" &&
            (rule.quantity === 1 || rule.compound_enabled),
        ),
      );
      const chosen = market();
      const type = random(3);
      const value =
        type === 0 ? random(5) : type === 1 ? random(10) : random(12);
      const pool = Array.from({ length: 49 }, (_, i) => i + 1).filter((n) =>
        type === 0
          ? Math.floor(n / 10) === value
          : type === 1
            ? n % 10 === value
            : maps[chosen].zodiac[n - 1] === value,
      );
      const selector = String(value) + (type === 0 ? "头" : "尾");
      lines = [
        {
          play: rule.name,
          market: chosen,
          amount: amount(),
          selections: pool,
          compound: rule.quantity > 1,
        },
      ];
      raw =
        marketWord(chosen) +
        name(rule) +
        (rule.quantity > 1 ? "复式" : "") +
        (type === 2 ? zodiac[value] : selector) +
        amountText(lines[0].amount);
    } else if (family === 4) {
      const rule = pick(rules.filter((rule) => rule.kind !== "zodiac_count"));
      const first = make(rule, rule.compound_enabled && random(2) === 1);
      const second = { ...make(rule, first.compound), market: first.market };
      lines = [first, second];
      raw = render(first) + pick(["；", "\n", "，"]) + render(second, false);
    } else if (family === 5) {
      const count = 2 + random(5);
      lines = Array.from({ length: count }, () => {
        const rule = pick(rules.filter((rule) => rule.kind !== "zodiac_count"));
        return make(rule, rule.compound_enabled && random(2) === 1);
      });
      raw = lines.map((line) => render(line)).join("；");
      const total = totals(price(lines, rules, maps));
      raw += "\n" + total.units + "组共" + yuan(BigInt(total.stake));
    } else if (family === 6) {
      const zs = distinct(1 + random(3), 12);
      const chosen = market();
      const value = amount();
      lines = [
        {
          play: pick(["特码", "平码"]),
          market: chosen,
          selections: [],
          compound: false,
          package_zodiacs: zs,
          amount: value,
        },
      ];
      raw = render(lines[0]);
    } else if (family === 7) {
      const rule = pick(
        rules.filter(
          (rule) => rule.quantity > 1 && rule.kind !== "zodiac_count",
        ),
      );
      const first = make(rule);
      const second = {
        ...make(rule),
        market: first.market,
        amount: first.amount,
      };
      lines = [first, second];
      raw =
        marketWord(first.market) +
        name(rule) +
        "(" +
        objects(rule, first.selections) +
        ")(" +
        objects(rule, second.selections) +
        ")" +
        amountText(first.amount);
    } else if (family === 8) {
      const rule = pick(
        rules.filter((rule) => rule.kind === "number" && rule.compound_enabled),
      );
      const line = make(rule, true);
      lines = [line];
      raw =
        marketWord(line.market) +
        name(rule) +
        "\n" +
        objects(rule, line.selections) +
        "/" +
        money(line.amount) +
        pick(["点一组", "點一組", "元一组"]);
    } else if (family === 9) {
      const chosen = market();
      const pool = distinct(4, 12);
      const value = amount();
      lines = [
        {
          play: "三有",
          market: chosen,
          selections: pool,
          compound: true,
          amount: value,
        },
        {
          play: "四有",
          market: chosen,
          selections: pool,
          compound: true,
          amount: value,
        },
      ];
      raw =
        marketWord(chosen) +
        "三有四" +
        pool.map((z) => zodiac[z]).join("") +
        value +
        "一组";
    } else if (family === 10) {
      const line = make(ruleFor("特码"));
      line.selections = [1 + random(49)];
      lines = [];
      accept = false;
      const text = render(line);
      const mutation = random(6);
      raw =
        mutation === 0
          ? "特码01未知各" + line.amount
          : mutation === 1
            ? text + "请取消"
            : mutation === 2
              ? "特码50各" + line.amount
              : mutation === 3
                ? "特码01各90000000000000.1"
                : mutation === 4
                  ? text + "\n999组共1"
                  : "澳门香港特码01各10";
    } else if (family === 11) {
      const rule = pick(
        rules.filter((rule) => rule.kind === "number" && rule.compound_enabled),
      );
      const line = make(rule);
      line.selections = [1 + random(49)];
      accept = false;
      lines = [];
      raw =
        marketWord(line.market) +
        name(rule) +
        objects(rule, line.selections) +
        "各10";
    } else if (family === 12) {
      const rule = pick(rules.filter((rule) => rule.kind !== "zodiac_count"));
      const line = make(rule, rule.compound_enabled);
      lines = [line];
      raw =
        marketWord(line.market) +
        "\n" +
        name(rule) +
        (line.compound ? "复式" : "") +
        "\n" +
        objects(rule, line.selections) +
        "\n" +
        amountText(line.amount);
    } else if (family === 13) {
      const rule = pick(
        rules.filter(
          (rule) => rule.kind !== "zodiac_count" && rule.quantity === 1,
        ),
      );
      const line = make(rule);
      lines = [line];
      raw =
        marketWord(line.market) +
        objects(rule, line.selections) +
        name(rule) +
        amountText(line.amount);
    } else if (family === 14) {
      const rule = ruleFor("特码");
      const line = make(rule);
      lines = [line];
      raw =
        marketWord(line.market) +
        name(rule) +
        amountText(line.amount) +
        " " +
        objects(rule, line.selections);
    } else if (family === 15) {
      accept = false;
      const prefix = pick([
        "三有鼠牛待定",
        "二中二01 02备注",
        "特码01稍后再说",
        "尾中3尾备注",
        "红波待定",
        "鼠牛待定",
        "01 02待定",
        "01待确认",
      ]);
      raw = prefix + "\n澳门特码03各10";
    } else if (family === 16) {
      const line = make(ruleFor("特码"));
      accept = false;
      const correct = totals(price([line], rules, maps));
      raw =
        render(line) +
        "\n" +
        correct.units +
        "组共" +
        yuan(BigInt(correct.stake) + 10n);
    } else {
      const rule = pick(rules.filter((rule) => rule.kind !== "zodiac_count"));
      const line = make(rule);
      lines = [line];
      raw =
        "测试客A：\n" +
        render(line) +
        "\n" +
        totals(price(lines, rules, maps)).units +
        "组共" +
        yuan(BigInt(totals(price(lines, rules, maps)).stake));
    }
    if (accept && random(5) === 0)
      raw = raw.replace(/[0-9]/g, (c) =>
        String.fromCharCode(c.charCodeAt(0) + 0xfee0),
      );
    yield {
      id: String(seed) + "-" + String(index),
      family: [
        "explicit",
        "compound",
        "drag",
        "number-selectors",
        "inheritance",
        "mixed-slip-total",
        "zodiac-package",
        "bracket-groups",
        "numeric-group-price",
        "shared-plays",
        "unsafe-edit",
        "incomplete-options",
        "multiline-heading",
        "postfix-play",
        "amount-first",
        "financial-heading",
        "conflicting-total",
        "nickname-total",
      ][family],
      raw,
      accept,
      lines,
      mappings: maps,
    };
  }
}
