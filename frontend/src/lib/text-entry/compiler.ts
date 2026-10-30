import { basicCount, entryCents, zodiacs } from "../types";
import type { Mapping, Play, Rule, SlipLine } from "../types";
import { dragPreview } from "../drag";
import { tokenize } from "./lexer";
import type { TextRow } from "../text-entry";

function values(body: string, kind: Play["rule"]["kind"]): number[] {
  if (body.includes("-"))
    throw new Error("横线可能表示范围或负数，请改为明确的选项列表");
  body = body.replace(/(?<=\d)号/gu, "");
  const clean = body.replace(/[\s,，、;；:：.。/\[\]【】{}()（）-]/gu, "");
  let result: number[];
  if (kind === "zodiac") {
    result = [...clean].map((c) => zodiacs.indexOf(c));
  } else if (kind === "number" || kind === "tail" || kind === "zodiac_count") {
    const tokens = body
      .replace(/[尾]/gu, kind === "tail" ? " " : "尾")
      .split(/[\s,，、;；:：.。/\[\]【】{}()（）-]+/u)
      .filter(Boolean);
    const split = tokens.flatMap((token) => {
      if (!/^\d+$/u.test(token)) return [token];
      if (token.length > 2 && Number(token) >= 1 && Number(token) <= 49)
        return [String(Number(token))];
      if (token.length > 2 && token.length % 2 === 0)
        return token.match(/.{2}/gu)!;
      return [token];
    });
    if (split.some((t) => !/^\d{1,2}$/u.test(t)))
      throw new Error("连写号码或未知文字：请用空格分开每个号码，不能自动猜分");
    result = split.map(Number);
    const min = kind === "number" ? 1 : 0;
    const max = kind === "number" ? 49 : kind === "tail" ? 9 : 12;
    if (result.some((v) => v < min || v > max))
      throw new Error("选项超出当前玩法范围");
  } else {
    const names =
      kind === "wave"
        ? ["红", "蓝", "绿"]
        : kind === "size"
          ? ["小", "大"]
          : ["双", "单"];
    result = [...clean.replace(/波/gu, "")].map((c) => names.indexOf(c));
  }
  if (!result.length || result.some((v) => v < 0))
    throw new Error("存在未识别的投注项，请修正，不能忽略");
  if (new Set(result).size !== result.length)
    throw new Error("同一组存在重复选项，请确认是重复投注还是笔误");
  return result;
}

function bracketGroups(body: string) {
  const groups: string[] = [];
  let close = "",
    start = 0,
    outside = "";
  for (let i = 0; i < body.length; i++) {
    const char = body[i];
    if (/[\[【({]/u.test(char)) {
      if (close) throw new Error("请将嵌套括号展开为独立投注组");
      close = "open";
      start = i + 1;
    } else if (/[\]】)}]/u.test(char)) {
      if (!close) throw new Error("投注括号缺少左括号，请核对分组");
      const group = body.slice(start, i);
      if (!group.trim()) throw new Error("括号内没有投注项");
      groups.push(group);
      close = "";
    } else if (!close) outside += char;
  }
  if (close) throw new Error("投注括号未闭合，请补全分组");
  return { groups, outside };
}

export interface CompiledRow {
  items: SlipLine[];
  error: string;
}
function lineUnits(item: SlipLine, rule: Rule, mapping: Mapping): number {
  if (item.drag) {
    const d = item.drag;
    const text = (values: number[]) =>
      values
        .map((v) =>
          d.zodiac || rule.kind === "zodiac" ? zodiacs[v] : String(v),
        )
        .join(" ");
    const preview = dragPreview(
      rule,
      { left: text(d.left), right: text(d.right), zodiac: d.zodiac },
      mapping,
    );
    if (!preview.input)
      throw new Error(preview.error || "拖投注不符合当前玩法");
    return preview.units;
  }
  return item.package_zodiacs?.length
    ? mapping.zodiac.filter((z) => item.package_zodiacs!.includes(z)).length
    : basicCount(rule, item.selections, item.compound);
}

export function compileRow(
  row: TextRow,
  plays: Play[],
  mapping: Mapping,
): CompiledRow {
  if (row.summary) return { items: [], error: "合计须与整单投注一起校验" };
  try {
    const play = plays.find((p) => p.id === row.playId && p.enabled);
    if (!play)
      throw new Error(`请确认“${row.playLabel || "未注明玩法"}”对应的玩法`);
    const cents = entryCents(row.amount);
    if (cents === null) throw new Error("请明确金额，须大于零且最多一位小数");
    const { rule } = play;
    let body = tokenize(row.body, [])
      .map((token) => (token.kind === "compound" ? "复式" : token.text))
      .join("");
    const compound = body.includes("复式");
    const postfixPackage =
      row.objectBeforePlay &&
      rule.kind === "number" &&
      rule.scope === "special" &&
      rule.quantity === 1 &&
      !row.marker &&
      row.mode === "auto";
    const packageIntent =
      body.includes("包") ||
      row.marker === "每肖" ||
      (row.marker === "各肖" && rule.kind === "number") ||
      postfixPackage;
    if (packageIntent && /^(共|合计)$/u.test(row.marker))
      throw new Error("包肖与总额同时出现，请明确每肖金额");
    body = body.replace(/复式|包肖|包/gu, "");
    const grouping = bracketGroups(body);
    const mode = /^(共|合计)$/u.test(row.marker)
      ? "total"
      : packageIntent
        ? "package"
        : row.marker
          ? "each"
          : row.mode;
    const base = {
      play_id: play.id,
      play_version: play.version,
      amount: row.amount,
      selections: [] as number[],
      compound: false,
    };
    let items: SlipLine[];
    if (body.includes("拖")) {
      const halves = body.split("拖");
      if (halves.length !== 2) throw new Error("拖投注须有明确的左右两组");
      const zodiacOnly = (part: string) =>
        /^[鼠牛虎兔龙蛇马羊猴鸡狗猪\s,，、;；:：.。/]+$/u.test(part);
      const zodiac = rule.kind === "number" && halves.every(zodiacOnly);
      function dragValues(part: string): number[] {
        if (zodiac) return values(part, "zodiac");
        if (rule.kind !== "number") return values(part, rule.kind);
        // Mixed number / zodiac / tail drag is normalized using this period's
        // mapping. The persisted request then contains explicit number pools.
        const expanded = part.replace(
          /[鼠牛虎兔龙蛇马羊猴鸡狗猪]|(?<!\d)[0-9]尾/gu,
          (selection) => {
            const selected = selection.endsWith("尾")
              ? Array.from({ length: 49 }, (_, i) => i + 1).filter(
                  (n) => n % 10 === Number(selection[0]),
                )
              : mapping.zodiac.flatMap((z, i) =>
                  z === zodiacs.indexOf(selection) ? [i + 1] : [],
                );
            return " " + selected.join(" ") + " ";
          },
        );
        return values(expanded, "number");
      }
      const drag = {
        left: dragValues(halves[0]),
        right: dragValues(halves[1]),
        zodiac,
      };
      if (mode === "package") throw new Error("拖投注不能按每肖包号金额录入");
      items = [{ ...base, compound: true, drag }];
    } else if (
      rule.kind === "number" &&
      /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(body)
    ) {
      if (rule.quantity !== 1)
        throw new Error("号码组合中的生肖请明确写成拖投注或改为号码");
      const zs = values(body, "zodiac");
      if (mode === "auto")
        throw new Error("生肖金额有歧义：请选择每号金额或每肖包号金额");
      items = [
        mode === "package"
          ? { ...base, package_zodiacs: zs }
          : {
              ...base,
              selections: mapping.zodiac.flatMap((z, i) =>
                zs.includes(z) ? [i + 1] : [],
              ),
            },
      ];
    } else {
      if (mode === "package")
        throw new Error("包肖只适用于单号码玩法与生肖选项");
      // Comma-separated full zodiac sets are separate lines of the same slip.
      const parts = body.split(/[,，;；]+/u).filter((s) => s.trim());
      // Newlines can delimit complete groups even when the play and amount
      // follow the entire selection block. Never regroup an incomplete line.
      const lines = body.split(/\r?\n/u).filter((s) => s.trim());
      const completeLines =
        rule.quantity > 1 &&
        lines.length > 1 &&
        lines.every((line) => {
          try {
            const n = values(line, rule.kind).length;
            return compound ? n >= rule.combination_size : n === rule.quantity;
          } catch {
            return false;
          }
        });
      if (
        grouping.groups.length &&
        grouping.outside.replace(/[\s,，、;；:：.。/]/gu, "")
      )
        throw new Error("括号外还有未归组的投注项，请核对分组");
      const groups = grouping.groups.length
        ? grouping.groups
        : completeLines
          ? lines
          : rule.kind === "zodiac" &&
              rule.quantity > 1 &&
              parts.length > 1 &&
              parts.every((s) => {
                const n = s.replace(/\s/gu, "").length;
                return compound
                  ? n >= rule.combination_size
                  : n === rule.quantity;
              })
            ? parts
            : rule.kind === "zodiac" &&
                !compound &&
                rule.quantity > 1 &&
                /^[鼠牛虎兔龙蛇马羊猴鸡狗猪\s]+$/u.test(body) &&
                body.replace(/\s/gu, "").length > rule.quantity &&
                body.replace(/\s/gu, "").length % rule.quantity === 0
              ? body
                  .replace(/\s/gu, "")
                  .match(new RegExp(`.{${rule.quantity}}`, "gu"))!
              : [body];
      items = groups.map((group) => {
        const selections = values(group, rule.kind);
        if (
          !compound &&
          rule.quantity > 1 &&
          rule.relation === "eq" &&
          selections.length !== rule.quantity
        )
          throw new Error(
            `本玩法需要 ${rule.quantity} 项；更多候选请明确写“复式”`,
          );
        return { ...base, selections, compound };
      });
    }
    const units = items.reduce(
      (sum, item) => sum + lineUnits(item, rule, mapping),
      0,
    );
    if (!units || units > 1000)
      throw new Error("注数无效或超过 1000 注，请修正候选项");
    if (mode === "total") {
      if (cents % BigInt(units) !== 0n || (cents / BigInt(units)) % 10n !== 0n)
        throw new Error("总金额不能按当前注数均分到一角，请明确每注金额");
      const per = cents / BigInt(units);
      const amount = `${per / 100n}.${(per % 100n) / 10n}`;
      items = items.map((item) => ({ ...item, amount }));
    }
    return { items, error: "" };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "无法识别",
    };
  }
}

// Summary text is checked against compiled financial rows, never emitted as a bet.
export function compileText(
  rows: TextRow[],
  plays: Play[],
  mapping: Mapping,
): CompiledRow[] {
  let units = 0,
    stake = 0n,
    valid = true;
  return rows.map((row) => {
    if (row.excluded) return { items: [], error: "" };
    if (row.summary) {
      const match =
        /^(\d+)组\s*(?:共|合计)\s*(\d+(?:\.\d+)?)(?:元|米|块)?$/u.exec(
          row.body.trim(),
        );
      const expected = match ? entryCents(match[2]) : null;
      const error =
        !match || expected === null
          ? "合计格式或金额精度不正确，请修改或移除此项"
          : !valid
            ? "请先处理前面投注项，再核对合计"
            : BigInt(match[1]) !== BigInt(units) || expected !== stake
              ? `原文合计与投注不符：当前 ${units} 组，共 ${stake / 100n}.${String(stake % 100n).padStart(2, "0")} 元`
              : "";
      return { items: [], error };
    }
    const result = compileRow(row, plays, mapping);
    if (result.error) valid = false;
    for (const item of result.items) {
      const rule = plays.find((p) => p.id === item.play_id)!.rule;
      const count = lineUnits(item, rule, mapping);
      units += count;
      stake +=
        entryCents(item.amount)! *
        BigInt(item.package_zodiacs?.length || count);
    }
    return result;
  });
}
