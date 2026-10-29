import type { Play } from "../types";
import type { TextPreference, TextRow } from "../text-entry";
import { tokenize } from "./lexer";
import { resolvePlay } from "./vocabulary";
import type { Token } from "./lexer";

interface Context {
  label: string;
  id: number;
  mode: TextPreference["amount_mode"];
}
interface Segment {
  context: Context;
  explicitPlay: boolean;
  objectBeforePlay: boolean;
  groupDepth: number;
  content: Token[];
  amount: string;
  marker: string;
}
const zodiac = /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u;
const empty = (): Context => ({ label: "", id: 0, mode: "auto" });

export function parseText(
  raw: string,
  plays: Play[],
  learned: TextPreference[] = [],
): TextRow[] {
  if (raw.length > 12000)
    throw Error("每单原文最多 12,000 字，请核对后缩短；不会自动拆成多张单");
  const active = plays.filter((p) => p.enabled);
  const habits = learned.filter((h) =>
    active.some((p) => p.id === h.play_id && p.version === h.play_version),
  );
  const tokens = tokenize(raw, [
    ...active.map((p) => p.rule.name),
    ...habits.map((h) => h.alias),
  ]);
  const rows: TextRow[] = [];
  let inherited = empty();
  let start = 0;
  const fresh = (): Segment => ({
    context: { ...inherited },
    explicitPlay: false,
    objectBeforePlay: false,
    groupDepth: 0,
    content: [],
    amount: "",
    marker: "",
  });
  let segment = fresh();
  const substantive = () =>
    segment.content.filter((t) => t.kind !== "separator");
  const hasObjects = () =>
    segment.content.some(
      (t) => t.kind === "object" || t.kind === "number" || t.kind === "unknown",
    );
  function context(label: string): Context {
    return resolvePlay(label, active, habits);
  }
  function emit(end: number) {
    const hasSelections = segment.content.some(
      (t) => t.kind === "object" || t.kind === "number",
    );
    const body = segment.content
      .map((t) =>
        t.kind === "compound" ? "复式" : t.kind === "package" ? "包" : t.text,
      )
      .join("")
      .replace(/^[\s:：,，;；.。]+|[\s,，;；.。]+$/gu, "");
    if (segment.explicitPlay || hasSelections || segment.amount) {
      rows.push({
        key: `${start}:${end}`,
        source: raw.slice(start, end),
        start,
        end,
        playLabel: segment.context.label,
        playId: segment.context.id,
        body,
        amount: segment.amount,
        marker: segment.marker,
        mode: segment.context.mode,
        customAlias: !segment.context.label,
        objectBeforePlay: segment.objectBeforePlay,
      });
      inherited = { ...segment.context };
    } else if (rows.length) {
      const previous = rows[rows.length - 1];
      // Unknown words stay attached to their source bet for correction. Pure
      // punctuation has no financial fields and cannot become a separate bet.
      if (/[\p{L}\p{N}]/u.test(body)) previous.body += " " + body;
      previous.end = end;
      previous.source = raw.slice(previous.start, end);
      previous.key = `${previous.start}:${end}`;
    } else if (/[\p{L}\p{N}]/u.test(body)) {
      rows.push({
        key: `${start}:${end}`,
        source: raw.slice(start, end),
        start,
        end,
        playLabel: "",
        playId: 0,
        body,
        amount: "",
        marker: "",
        mode: "auto",
        customAlias: true,
      });
    }
    start = end;
    segment = fresh();
  }
  function nextSignificant(index: number) {
    while (tokens[index]?.kind === "separator") index++;
    return index;
  }
  function readAmount(index: number): { amount: string; last: number } | null {
    let i = index;
    while (tokens[i]?.kind === "separator" && /^\s+$/u.test(tokens[i].text))
      i++;
    if (tokens[i]?.kind !== "number") return null;
    let amount = tokens[i].text;
    if (
      tokens[i + 1]?.text === "." &&
      tokens[i + 2]?.kind === "number" &&
      tokens[i].end === tokens[i + 1].start &&
      tokens[i + 1].end === tokens[i + 2].start
    ) {
      amount += "." + tokens[i + 2].text;
      i += 2;
    }
    const currency = nextSignificant(i + 1);
    if (tokens[currency]?.kind === "currency") i = currency;
    return { amount, last: i };
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "market") continue;
    if (token.kind === "group-open") {
      segment.groupDepth++;
      segment.content.push(token);
      continue;
    }
    if (token.kind === "group-close") {
      segment.groupDepth = Math.max(0, segment.groupDepth - 1);
      segment.content.push(token);
      continue;
    }
    if (segment.groupDepth) {
      segment.content.push(token);
      continue;
    }
    if (
      token.kind === "separator" &&
      token.text === ":" &&
      !segment.explicitPlay &&
      !segment.amount &&
      segment.content.some((t) => t.kind === "unknown")
    ) {
      const label = segment.content
        .map((t) => t.text)
        .join("")
        .trim();
      if (/^\p{L}[\p{L}\p{N}+]{0,39}$/u.test(label)) {
        segment.context = context(label);
        segment.explicitPlay = true;
        segment.content = [];
        continue;
      }
    }
    if (token.kind === "play") {
      // A new explicit play interrupts an incomplete record. An object before its
      // first play is retained, so 牛特500 is assembled as one semantic record.
      if (segment.explicitPlay) emit(token.start);
      segment.objectBeforePlay = hasObjects();
      segment.context = context(token.text);
      segment.explicitPlay = true;
      if (segment.amount && hasObjects()) emit(token.end);
      continue;
    }
    if (token.kind === "single") {
      const content = substantive();
      if (
        !segment.explicitPlay &&
        content.length === 1 &&
        content[0].kind === "object" &&
        zodiac.test(content[0].text)
      ) {
        segment.context = context("一肖中");
        segment.explicitPlay = true;
        segment.objectBeforePlay = true;
        continue;
      }
    }
    if (
      token.kind === "connector" &&
      !substantive().length &&
      tokens[nextSignificant(i + 1)]
    )
      continue;
    if (token.kind === "amount") {
      const next = nextSignificant(i + 1);
      // 羊/狗 is an object list; numeric lists use / as an amount marker.
      if (
        token.text === "/" &&
        tokens[next]?.kind === "object" &&
        zodiac.test(tokens[next].text)
      ) {
        segment.content.push({ ...token, kind: "separator" });
        continue;
      }
      const money = readAmount(i + 1);
      if (money && !segment.amount) {
        segment.amount = money.amount;
        segment.marker = token.text;
        if (segment.context.label && hasObjects()) emit(tokens[money.last].end);
        i = money.last;
        continue;
      }
      segment.content.push({ ...token, kind: "unknown" });
      continue;
    }
    if (token.kind === "number") {
      const meaningful = substantive();
      const leadingMoney = readAmount(i);
      const next = nextSignificant((leadingMoney?.last ?? i) + 1);
      // Amount-before-object is explicit only with a package operator (100包狗).
      if (!hasObjects() && leadingMoney && tokens[next]?.kind === "package") {
        const objectStart = nextSignificant(next + 1);
        let last = objectStart;
        while (
          tokens[last]?.kind === "object" &&
          zodiac.test(tokens[last].text)
        ) {
          segment.content.push(tokens[last]);
          const candidate = nextSignificant(last + 1);
          if (
            tokens[candidate]?.kind !== "object" ||
            !zodiac.test(tokens[candidate].text)
          )
            break;
          last = candidate;
        }
        if (segment.content.some((t) => t.kind === "object")) {
          segment.content.unshift(tokens[next]);
          segment.amount = leadingMoney.amount;
          segment.marker = "每肖";
          if (segment.context.label) emit(tokens[last].end);
          i = last;
          continue;
        }
      }
      const previous = meaningful
        .filter((t) => t.kind !== "group-open" && t.kind !== "group-close")
        .at(-1);
      const afterGroup =
        meaningful.at(-1)?.kind === "group-close" && Number(token.text) > 49;
      const bareAfterZodiac =
        previous?.kind === "object" && zodiac.test(previous.text);
      const money = readAmount(i);
      const currency = money && tokens[money.last].kind === "currency";
      if (
        money &&
        !segment.amount &&
        (bareAfterZodiac || afterGroup || currency)
      ) {
        segment.amount = money.amount;
        if (segment.context.label && hasObjects()) emit(tokens[money.last].end);
        i = money.last;
        continue;
      }
    }
    segment.content.push(token);
  }
  emit(raw.length);
  if (rows.length > 100) throw Error("每单最多 100 个原文片段，请核对后缩短");
  return rows;
}
