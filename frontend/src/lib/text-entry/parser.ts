import { assignMarkets, tokenizeMarkets, type MarketRange } from "./markets";
import { normalizeLanguage } from "./language";
import { entryCents, type Play } from "../types";
import type { TextPreference, TextRow } from "../text-entry";
import { resolvePlay, playCandidates } from "./vocabulary";
import type { Token } from "./lexer";
import { monetaryLiteral } from "./amount";
import { numberGroups } from "./number-groups";

interface Context {
  label: string;
  id: number;
  mode: TextPreference["amount_mode"];
  compound?: boolean;
  defaultSpecial?: boolean;
}
interface Segment {
  context: Context;
  contexts: Context[];
  explicitPlay: boolean;
  objectBeforePlay: boolean;
  groupDepth: number;
  compound: boolean;
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
  const normalized = normalizeLanguage(raw, [
    ...plays.filter((play) => play.enabled).map((play) => play.rule.name),
    ...learned
      .filter((habit) =>
        plays.some(
          (play) =>
            play.enabled &&
            play.id === habit.play_id &&
            play.version === habit.play_version,
        ),
      )
      .map((habit) => habit.alias),
  ]);
  if (normalized.review)
    return [
      {
        key: `0:${raw.length}:review`,
        source: raw,
        start: 0,
        end: raw.length,
        body: raw,
        playLabel: "请确认更正、取消或历史引用的最终内容",
        playId: 0,
        amount: "",
        marker: "",
        mode: "auto",
        customAlias: true,
      },
    ];
  if (normalized.text !== raw) {
    const rows = parseNormalizedText(normalized.text, plays, learned);
    let cursor = 0;
    return rows.map((row, index) => {
      const originalStart = normalized.spans[row.start]?.start ?? raw.length;
      const start = Math.min(cursor, originalStart);
      const end =
        index === rows.length - 1
          ? raw.length
          : (normalized.spans[row.end - 1]?.end ?? originalStart);
      cursor = Math.max(cursor, end);
      return {
        ...row,
        start,
        end,
        source: raw.slice(start, end),
        key: `${start}:${end}:${index}`,
      };
    });
  }
  return parseNormalizedText(raw, plays, learned);
}
function parseNormalizedText(
  raw: string,
  plays: Play[],
  learned: TextPreference[],
) {
  const active = plays.filter((p) => p.enabled);
  const habits = learned.filter((h) =>
    active.some((p) => p.id === h.play_id && p.version === h.play_version),
  );
  // Resolve repeated homophones once for this exact configuration snapshot.
  const resolutions = new Map<string, ReturnType<typeof resolvePlay>>();
  const resolvable = new Map<string, boolean>();
  function resolve(label: string) {
    let result = resolutions.get(label);
    if (!result) {
      result = resolvePlay(label, active, habits);
      resolutions.set(label, result);
    }
    return { ...result };
  }
  function canResolve(label: string) {
    if (!resolvable.has(label))
      resolvable.set(
        label,
        resolve(label).id > 0 ||
          playCandidates(label, active).some(
            (candidate) => candidate.suggested,
          ),
      );
    return resolvable.get(label)!;
  }
  let { tokens, markers: markets } = tokenizeMarkets(
    raw,
    [...active.map((p) => p.rule.name), ...habits.map((h) => h.alias)],
    canResolve,
  );
  // A standalone non-business heading stays in the source span, but does not
  // become a selection. Unknown text inside a bet remains an error.
  // Only leading standalone headings are remarks. Unknown text after a bet
  // remains financial input that must be corrected.
  const headings: { start: number; end: number }[] = [];
  const carriesBetting = (parts: Token[]) =>
    parts.some((token) =>
      [
        "play",
        "plays",
        "amount",
        "currency",
        "drag",
        "compound",
        "summary",
      ].includes(token.kind),
    ) ||
    (parts.some((token) => token.kind === "object") &&
      parts.some((token) => ["number", "money"].includes(token.kind))) ||
    new Set(
      parts
        .filter((token) => token.kind === "object")
        .map((token) => token.text),
    ).size >= 2 ||
    ["number", "money"].includes(parts[0]?.kind ?? "");
  let headingToken = 0;
  for (const line of raw.matchAll(/^[^\r\n]+/gmu)) {
    const end = line.index! + line[0].length;
    while (tokens[headingToken]?.end <= line.index!) headingToken++;
    let last = headingToken;
    while (tokens[last]?.start < end) last++;
    const parts = tokens
      .slice(headingToken, last)
      .filter((token) => token.start >= line.index! && token.end <= end);
    if (!parts.some((t) => t.kind === "unknown")) break;
    if (carriesBetting(parts)) break;
    if (
      /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(line[0]) &&
      parts.some((t) => ["play", "plays", "number", "money"].includes(t.kind))
    )
      break;
    headings.push({ start: line.index!, end: line.index! + line[0].length });
  }
  function withoutHeadings<T extends { start: number; end: number }>(
    values: T[],
  ) {
    let index = 0;
    return values.filter((token) => {
      while (headings[index]?.end <= token.start) index++;
      const heading = headings[index];
      return !heading || token.start < heading.start || token.end > heading.end;
    });
  }
  tokens = withoutHeadings(tokens);
  const nameEnd = tokens.findIndex(
    (t) => t.kind === "separator" && /[。.,，:：]/u.test(t.text),
  );
  if (
    nameEnd > 0 &&
    tokens.slice(0, nameEnd).some((t) => t.kind === "unknown") &&
    !carriesBetting(tokens.slice(0, nameEnd)) &&
    !tokens
      .slice(0, nameEnd)
      .some((t) => ["amount", "currency", "drag", "compound"].includes(t.kind))
  ) {
    markets = markets.filter((t) => t.start >= tokens[nameEnd].end);
    tokens.splice(0, nameEnd + 1);
  }
  markets = withoutHeadings(markets);
  const rows: TextRow[] = [];
  const ranges: MarketRange[] = [];
  let inherited = empty();
  let inheritedContexts: Context[] = [];
  let previousBody = "";
  let start = 0;
  const fresh = (): Segment => ({
    context: { ...inherited },
    contexts: inheritedContexts,
    explicitPlay: false,
    objectBeforePlay: false,
    groupDepth: 0,
    content: [],
    compound: inherited.compound === true,
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
    return resolve(label);
  }
  function infer(kind: "tail" | "wave" | "size" | "parity") {
    const current = active.find((p) => p.id === segment.context.id);
    if (current?.rule.kind === kind) return;
    const candidates = active.filter(
      (p) => p.rule.kind === kind && p.rule.quantity === 1,
    );
    segment.contexts = [];
    segment.compound = false;
    segment.context = {
      label: { tail: "尾数", wave: "波色", size: "大小", parity: "单双" }[
        kind as "tail" | "wave" | "size" | "parity"
      ],
      id: candidates.length === 1 ? candidates[0].id : 0,
      mode: "auto",
    };
  }
  function emit(end: number) {
    const hasSelections = segment.content.some(
      (t) => t.kind === "object" || t.kind === "number",
    );
    let body = segment.content
      .map((t) =>
        t.kind === "compound" ? "复式" : t.kind === "package" ? "包" : t.text,
      )
      .join("")
      .replace(/(?:复式[\s,，]*){2,}/gu, "复式 ")
      .replace(/^[\s:：,，;；.。]+|[\s,，;；.。]+$/gu, "");
    const firstNumber = segment.content.find(
      (token) => token.kind === "number",
    );
    const newNumberLine = !!(
      !segment.explicitPlay &&
      rows.at(-1)?.amount &&
      active.find((play) => play.id === segment.context.id)?.rule.kind ===
        "zodiac" &&
      firstNumber &&
      /[\r\n]/u.test(raw.slice(start, firstNumber.start)) &&
      segment.content.every((token) =>
        ["number", "separator"].includes(token.kind),
      )
    );
    const implicitEachZodiac =
      !segment.context.label &&
      !segment.explicitPlay &&
      ["各", "各号", "每注", "各注"].includes(segment.marker) &&
      segment.content.some(
        (token) => token.kind === "object" && zodiac.test(token.text),
      ) &&
      segment.content.every(
        (token) =>
          token.kind === "separator" ||
          (token.kind === "object" && zodiac.test(token.text)),
      );
    const implicitSpecial =
      implicitEachZodiac ||
      newNumberLine ||
      (["各肖", "各数"].includes(segment.marker) &&
        !segment.explicitPlay &&
        (!segment.context.label || segment.context.defaultSpecial === true));
    if (segment.explicitPlay || hasSelections || segment.amount) {
      if (implicitSpecial) {
        segment.context = { ...context("特码"), defaultSpecial: true };
        segment.contexts = [];
        segment.compound = false;
      }
      if (
        (segment.compound ||
          segment.contexts.some((c) => c.label.endsWith("有"))) &&
        hasSelections &&
        !body.includes("复式")
      )
        body = "复式 " + body;
      if (
        segment.context.label === "平" &&
        /^[鼠牛虎兔龙蛇马羊猴鸡狗猪\s,，]+$/u.test(body)
      )
        segment.context = context("一肖中");
      if (
        !segment.context.label &&
        hasSelections &&
        !segment.content.some(
          (t) => t.kind === "unknown" || t.kind === "object",
        )
      )
        segment.context = context("特码");
      // An immediately repeated compound selection block can specify a second
      // linked play and amount without restating its candidates.
      if (
        !hasSelections &&
        segment.explicitPlay &&
        substantive().every((t) => t.kind === "compound") &&
        segment.amount &&
        previousBody.includes("复式") &&
        active.find((p) => p.id === segment.context.id)?.rule.kind === "zodiac"
      )
        body = previousBody;
      const currentRule = active.find((p) => p.id === segment.context.id)?.rule;
      if (
        !hasSelections &&
        substantive().length === 0 &&
        currentRule?.kind === "zodiac_count" &&
        currentRule.zodiac_count
      )
        body = String(currentRule.zodiac_count);
      const contexts = segment.contexts.length
        ? segment.contexts
        : [segment.context];
      const first = tokens.find(
        (t) => t.start >= start && t.end <= end && t.kind !== "separator",
      );
      ranges.push({
        first: rows.length,
        count: contexts.length,
        start: first?.start ?? start,
        end,
      });
      for (const [index, selected] of contexts.entries())
        rows.push({
          key: `${start}:${end}${contexts.length > 1 ? ":" + index : ""}`,
          source: raw.slice(start, end),
          start,
          end,
          playLabel: implicitSpecial ? "" : selected.label,
          playId: selected.id,
          body,
          amount: segment.amount,
          marker: segment.marker,
          mode: selected.mode,
          customAlias: implicitSpecial || !selected.label,
          objectBeforePlay: segment.objectBeforePlay,
        });
      previousBody = body;
      inheritedContexts = segment.contexts;
      inherited = {
        ...segment.context,
        compound: body.includes("复式") || body.includes("拖"),
      };
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
  function previousSignificant(index: number) {
    let i = index - 1;
    while (tokens[i]?.kind === "separator") i--;
    return tokens[i];
  }
  function nextSignificant(index: number) {
    while (tokens[index]?.kind === "separator") index++;
    return index;
  }
  function followedByListAmount(index: number) {
    // An explicit trailing amount takes precedence over dot-amount shorthand.
    // Keep newlines as record boundaries when looking beyond another number.
    let i = index + 1;
    while (tokens[i]?.kind === "separator" && !/[\r\n]/u.test(tokens[i].text))
      i++;
    while (tokens[i]?.kind === "number") {
      i++;
      while (tokens[i]?.kind === "separator" && !/[\r\n]/u.test(tokens[i].text))
        i++;
    }
    return tokens[i]?.kind === "amount" && readAmount(i + 1) !== null;
  }
  const explicitPriceLookahead = new Map<number, boolean>();
  const groupPriceLookahead = new Map<number, boolean>();
  function explicitPriceAfterList(index: number, groupSlash = false) {
    const cache = groupSlash ? groupPriceLookahead : explicitPriceLookahead;
    const visited: number[] = [];
    let result = false;
    for (let i = index; i < tokens.length; i++) {
      const cached = cache.get(i);
      if (cached !== undefined) {
        result = cached;
        break;
      }
      visited.push(i);
      const token = tokens[i];
      if (token.kind === "separator" && /[\r\n;；。]/u.test(token.text)) break;
      if (groupSlash && token.kind === "number" && readAmount(i)?.perGroup) {
        result = true;
        break;
      }
      if (
        [
          "number",
          "object",
          "separator",
          "group-open",
          "group-close",
          "compound",
        ].includes(token.kind) ||
        ["尾", "头", "頭"].includes(token.text)
      )
        continue;
      if (token.kind === "amount") {
        if (["x", "X"].includes(token.text)) continue;
        if (token.text === "/") {
          if (groupSlash) continue;
          break;
        }
        result = readAmount(i + 1) !== null;
      }
      break;
    }
    for (const i of visited) cache.set(i, result);
    return result;
  }
  function xCompletesExistingAmount(index: number) {
    if (!hasObjects()) return false;
    const first = nextSignificant(index + 1);
    if (!["number", "money"].includes(tokens[first]?.kind)) return false;
    const price = readAmount(first);
    if (!price) return false;
    const next = tokens[nextSignificant(price.last + 1)];
    return (
      !!next &&
      ["number", "object"].includes(next.kind) &&
      !["尾", "头", "頭", "波"].includes(next.text)
    );
  }
  const postfixPrices = new Map<number, boolean>();
  function priceAfterPostfixList(index: number) {
    const visited: number[] = [];
    let priced = false;
    for (let i = index; i < tokens.length; i++) {
      if (postfixPrices.has(i)) {
        priced = postfixPrices.get(i)!;
        break;
      }
      visited.push(i);
      const token = tokens[i];
      if (token.kind === "separator" && /[\r\n;；。]/u.test(token.text)) break;
      if (
        ["number", "object", "separator", "compound"].includes(token.kind) ||
        token.text === "*"
      )
        continue;
      if (["play", "plays"].includes(token.kind)) {
        let next = nextSignificant(i + 1);
        while (["play", "plays", "compound"].includes(tokens[next]?.kind))
          next = nextSignificant(next + 1);
        priced =
          tokens[next]?.kind === "amount" && readAmount(next + 1) !== null;
      } else if (token.kind === "amount") priced = readAmount(i + 1) !== null;
      break;
    }
    for (const i of visited) postfixPrices.set(i, priced);
    return priced;
  }
  function followsAmountDot(index: number) {
    let i = index - 1;
    while (
      tokens[i]?.kind === "separator" &&
      /^[^\S\r\n]+$/u.test(tokens[i].text)
    )
      i--;
    return tokens[i]?.text === ".";
  }
  function postfixPlayAfter(index: number) {
    let i = index + 1;
    while (
      tokens[i]?.kind === "separator" &&
      !/[\r\n。.;；]/u.test(tokens[i].text)
    ) {
      // A comma after a complete inherited bet starts its next clause, rather
      // than letting that clause's play steal the completed amount and pool.
      if (segment.context.id && /[,，]/u.test(tokens[i].text)) return false;
      i++;
    }
    while (tokens[i]?.kind === "compound") {
      i++;
      while (
        tokens[i]?.kind === "separator" &&
        !/[\r\n。.;；]/u.test(tokens[i].text)
      ) {
        if (segment.context.id && /[,，]/u.test(tokens[i].text)) return false;
        i++;
      }
    }
    return ["play", "plays"].includes(tokens[i]?.kind);
  }
  function readAmount(
    index: number,
    integerOnly = false,
  ): {
    amount: string;
    last: number;
    perGroup: boolean;
    suffixMarker?: string;
  } | null {
    let i = index;
    while (
      tokens[i]?.kind === "separator" &&
      /^[\s:：,，;；]+$/u.test(tokens[i].text)
    )
      i++;
    while (tokens[i]?.kind === "amount") {
      i = nextSignificant(i + 1);
    }
    if (!["number", "money"].includes(tokens[i]?.kind)) return null;
    let amount = tokens[i].text;
    if (
      !integerOnly &&
      tokens[i + 1]?.text === "." &&
      tokens[i + 2]?.kind === "number" &&
      tokens[i].lexicalEnd === tokens[i + 1].lexicalStart &&
      tokens[i + 1].lexicalEnd === tokens[i + 2].lexicalStart
    ) {
      amount += "." + tokens[i + 2].text;
      i += 2;
    }
    const currency = nextSignificant(i + 1);
    // 点/點 is an amount unit only in the confirmed “金额点一组” syntax.
    // Decimal-point prose and unknown text remain visible for correction.
    const groupPoint =
      tokens[currency]?.kind === "unknown" &&
      ["点", "點"].includes(tokens[currency].text) &&
      tokens[nextSignificant(currency + 1)]?.text === "一组";
    if (tokens[currency]?.kind === "currency" || groupPoint) i = currency;
    const suffix = nextSignificant(i + 1);
    const following = nextSignificant(suffix + 1);
    const prefixGroup =
      ["number", "money"].includes(tokens[following]?.kind) &&
      /^[\s:：]*$/u.test(
        raw.slice(tokens[suffix]?.end, tokens[following]?.start),
      ) &&
      !/[\r\n]/u.test(raw.slice(tokens[suffix]?.end, tokens[following]?.start));
    const perGroup = tokens[suffix]?.text === "一组" && !prefixGroup;
    if (perGroup) i = suffix;
    let suffixMarker: string | undefined;
    const adjacentSuffix = /^[^\S\r\n]*$/u.test(
      raw.slice(tokens[i].end, tokens[suffix]?.start),
    );
    const suffixPlay = active.find((play) => play.id === segment.context.id);
    const zodiacSuffix =
      tokens[suffix]?.text === "一肖" &&
      suffixPlay?.rule.quantity === 1 &&
      ["number", "zodiac"].includes(suffixPlay.rule.kind) &&
      tokens[following]?.kind !== "object" &&
      segment.content.some(
        (token) => token.kind === "object" && zodiac.test(token.text),
      ) &&
      segment.content.every(
        (token) =>
          token.kind === "separator" ||
          (token.kind === "object" && zodiac.test(token.text)),
      );
    if (
      !perGroup &&
      !prefixGroup &&
      adjacentSuffix &&
      ((tokens[suffix]?.text === "各数" &&
        (tokens[currency]?.kind === "currency" || Number(amount) > 49)) ||
        zodiacSuffix)
    ) {
      suffixMarker = tokens[suffix].text === "一肖" ? "各肖" : "各数";
      i = suffix;
    }
    return {
      amount: (monetaryLiteral(amount) ?? amount).replace(
        /(\.\d*?[1-9])0+$|\.0+$/u,
        "$1",
      ),
      last: i,
      perGroup,
      suffixMarker,
    };
  }
  function applyAmount(
    money: { amount: string; perGroup: boolean; suffixMarker?: string },
    marker = "",
  ) {
    segment.amount = money.amount;
    if (money.suffixMarker) segment.marker = money.suffixMarker;
    const rule = active.find((play) => play.id === segment.context.id)?.rule;
    const first = segment.content.findIndex((token) => token.kind === "number");
    const list = segment.content.slice(first);
    const numbers = list.filter((token) => token.kind !== "separator");
    // A single flat number pool with an explicit per-group suffix denotes
    // combinations. Brackets, multiple object lines and unknown words cannot
    // silently become one pool; the compiler still validates values and counts.
    if (
      money.perGroup &&
      !["共", "合计"].includes(marker) &&
      first >= 0 &&
      rule?.kind === "number" &&
      rule.relation === "eq" &&
      rule.quantity > 1 &&
      rule.compound_enabled &&
      !numberGroups(
        segment.content.map((token) => token.text).join(""),
        rule.quantity,
      ) &&
      numbers.length > rule.quantity &&
      numbers.every(
        (token) => token.kind === "number" && /^\d{1,2}$/u.test(token.text),
      ) &&
      list.every(
        (token) => token.kind !== "separator" || !/[\r\n;；]/u.test(token.text),
      )
    )
      segment.compound = true;
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (
      token.kind === "separator" &&
      hasObjects() &&
      /^\/(?:[ \t]*\/)+$/u.test(
        raw.slice(token.start, token.end).normalize("NFKC"),
      )
    ) {
      const money = readAmount(i + 1);
      const cents = money && entryCents(money.amount);
      if (
        money &&
        cents !== null &&
        cents !== undefined &&
        cents > 4900n &&
        !followedByListAmount(money.last)
      ) {
        applyAmount(money, "/");
        segment.marker = money.suffixMarker ?? "/";
        emit(tokens[money.last].end);
        i = money.last;
        continue;
      }
    }
    if (
      token.text === "*" &&
      hasObjects() &&
      priceAfterPostfixList(nextSignificant(i + 1))
    ) {
      segment.content.push({ ...token, kind: "separator", text: "." });
      continue;
    }
    // A literal x retains its unit-price meaning unless a later explicit price
    // or a new play unambiguously makes it a list/clause separator.
    if (
      token.kind === "amount" &&
      ["x", "X"].includes(token.text) &&
      !/[a-z]/iu.test(raw[token.start - 1] ?? "") &&
      !/[a-z]/iu.test(raw[token.end] ?? "") &&
      !xCompletesExistingAmount(i) &&
      (explicitPriceAfterList(nextSignificant(i + 1)) ||
        (!hasObjects() &&
          !segment.explicitPlay &&
          rows.length > 0 &&
          ["play", "plays"].includes(tokens[nextSignificant(i + 1)]?.kind)))
    ) {
      segment.content.push({ ...token, kind: "separator", text: ";" });
      continue;
    }
    // Once a financial row is complete, slash starts its next clause. Before
    // an amount it remains an operator, e.g. 三中三/5.
    if (
      token.text === "/" &&
      !hasObjects() &&
      !segment.explicitPlay &&
      rows.length &&
      // Repeated bare numeric slashes can also be a selection list. A prior
      // slash amount alone does not establish a new financial clause.
      (rows.at(-1)!.marker !== "/" ||
        ["play", "plays"].includes(tokens[nextSignificant(i + 1)]?.kind))
    ) {
      continue;
    }
    if (
      token.kind === "amount" &&
      ["共", "合计"].includes(token.text) &&
      !hasObjects() &&
      !segment.explicitPlay &&
      (rows.length || /^\s*$/u.test(raw.slice(0, token.start)))
    ) {
      const money = readAmount(i + 1);
      if (money) {
        const end = tokens[money.last].end;
        const inline =
          rows.length > 0 &&
          !/[\r\n]/u.test(raw.slice(rows.at(-1)!.end, token.start));
        rows.push({
          key: `${start}:${end}:summary`,
          source: raw.slice(start, end),
          start,
          end,
          playLabel: "",
          playId: 0,
          body: token.text + money.amount,
          amount: "",
          marker: "",
          mode: "auto",
          customAlias: false,
          summary: true,
          summaryScope: inline ? "section" : undefined,
        });
        start = end;
        segment = fresh();
        i = money.last;
        continue;
      }
    }
    if (token.kind === "summary") {
      if (segment.explicitPlay || hasObjects() || segment.amount)
        emit(token.start);
      const inline =
        rows.length > 0 &&
        !/[\r\n]/u.test(raw.slice(rows.at(-1)!.end, token.start));
      rows.push({
        key: `${start}:${token.end}:summary`,
        source: raw.slice(start, token.end),
        start,
        end: token.end,
        playLabel: "",
        playId: 0,
        body: token.text,
        amount: "",
        marker: "",
        mode: "auto",
        customAlias: false,
        summary: true,
        summaryScope: inline ? "section" : undefined,
      });
      start = token.end;
      segment = fresh();
      continue;
    }
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
        segment.contexts = [];
        segment.explicitPlay = true;
        segment.content = [];
        continue;
      }
    }
    if (
      token.kind === "separator" &&
      segment.amount &&
      ((/[。;；]/u.test(token.text) && segment.explicitPlay) ||
        (/[\r\n]/u.test(token.text) && hasObjects()))
    ) {
      emit(token.end);
      continue;
    }
    // A tail suffix belongs to the preceding selection, including linked tails.
    if (
      token.kind === "play" &&
      ["尾", "尾数", "尾數"].includes(token.text) &&
      substantive().at(-1)?.kind === "number"
    ) {
      const selected = active.find((p) => p.id === segment.context.id);
      if (
        !segment.explicitPlay ||
        selected?.rule.kind === "tail" ||
        selected?.rule.kind === "number"
      ) {
        if (
          !segment.explicitPlay &&
          selected?.rule.kind !== "number" &&
          !segment.content.some((t) => t.kind === "drag")
        )
          infer("tail");
        if (segment.context.label === "平") segment.context = context("尾中");
        segment.content.push({ ...token, kind: "object", text: "尾" });
        continue;
      }
    }
    if (!segment.explicitPlay && token.kind === "object") {
      if (/[红蓝绿]/u.test(token.text)) infer("wave");
      else if (/[大小]/u.test(token.text)) infer("size");
      else if (/[单双]/u.test(token.text)) infer("parity");
    }
    if (token.kind === "play" || token.kind === "plays") {
      if (
        token.text === "平特" &&
        !segment.explicitPlay &&
        segment.content.some((t) => t.text === "尾")
      )
        token.text = "尾中";
      // A tail qualifier narrows generic 平特 to 尾中.
      if (
        ["尾", "尾中"].includes(token.text) &&
        ["平特", "平"].includes(segment.context.label) &&
        hasObjects()
      ) {
        segment.context = context("尾中");
        segment.content.push({ ...token, kind: "object", text: "尾" });
        continue;
      }
      // Some messages repeat the same label after its objects (四有…四有50).
      if (
        segment.explicitPlay &&
        hasObjects() &&
        context(token.text).id > 0 &&
        context(token.text).id === segment.context.id
      )
        continue;
      // Adjacent postfix play names share the already written selection pool
      // and the following price; a new play with its own objects still emits.
      const additional = context(token.text);
      if (
        segment.explicitPlay &&
        segment.objectBeforePlay &&
        hasObjects() &&
        !segment.amount &&
        ["play", "plays"].includes(previousSignificant(i)?.kind ?? "") &&
        active.find((play) => play.id === additional.id)?.rule.kind ===
          active.find((play) => play.id === segment.context.id)?.rule.kind
      ) {
        segment.contexts = [
          ...(segment.contexts.length ? segment.contexts : [segment.context]),
          additional,
        ];
        continue;
      }
      // A new explicit play interrupts an incomplete record. An object before its
      // first play is retained, so 牛特500 is assembled as one semantic record.
      const flatLinkedQualifier =
        segment.context.label === "平特" &&
        !hasObjects() &&
        !segment.amount &&
        token.labels?.every((label) => label.endsWith("有"));
      if (segment.explicitPlay && !flatLinkedQualifier) emit(token.start);
      segment.compound = segment.content.some((t) => t.kind === "compound");
      segment.objectBeforePlay = hasObjects();
      segment.contexts = token.labels?.map(context) ?? [];
      segment.context = segment.contexts[0] ?? context(token.text);
      if (
        token.labels?.every(
          (label) => label.endsWith("有") || label.endsWith("尾连"),
        )
      )
        segment.content.unshift({
          kind: "compound",
          text: "复式",
          start: token.start,
          end: token.end,
        });
      segment.explicitPlay = true;
      if (
        segment.amount &&
        hasObjects() &&
        tokens[nextSignificant(i + 1)]?.kind !== "compound"
      )
        emit(token.end);
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
        segment.contexts = [];
        segment.compound = false;
        segment.explicitPlay = true;
        segment.objectBeforePlay = true;
        continue;
      }
    }
    if (
      token.kind === "connector" &&
      token.text === "买" &&
      hasObjects() &&
      readAmount(i + 1)
    )
      continue;
    if (
      token.kind === "connector" &&
      !substantive().length &&
      tokens[nextSignificant(i + 1)]
    )
      continue;
    if (token.kind === "amount") {
      const next = nextSignificant(i + 1);
      const rule = active.find((play) => play.id === segment.context.id)?.rule;
      // Keep slash prices unless a later explicit price establishes shared
      // pricing for number-combination groups, e.g. 01 02/03 04/每组10.
      if (
        token.text === "/" &&
        ((tokens[next]?.kind === "object" && zodiac.test(tokens[next].text)) ||
          (tokens[next]?.kind === "number" &&
            rule?.kind === "number" &&
            hasObjects() &&
            !readAmount(next)?.perGroup &&
            explicitPriceAfterList(next, true)))
      ) {
        segment.content.push({ ...token, kind: "separator" });
        continue;
      }
      const money = readAmount(i + 1);
      if (money && !segment.amount) {
        applyAmount(money, token.text);
        segment.marker = money.suffixMarker ?? token.text;
        if (
          !(!segment.explicitPlay && postfixPlayAfter(money.last)) &&
          (hasObjects() ||
            (segment.explicitPlay && !segment.context.id) ||
            (segment.explicitPlay &&
              active.find((p) => p.id === segment.context.id)?.rule.kind ===
                "zodiac_count"))
        )
          emit(tokens[money.last].end);
        i = money.last;
        continue;
      }
      segment.content.push({ ...token, kind: "unknown" });
      continue;
    }
    if (token.kind === "number" || token.kind === "money") {
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
        previous?.kind === "object" &&
        /[鼠牛虎兔龙蛇马羊猴鸡狗猪红蓝绿大小单双尾波头頭]/u.test(previous.text);
      const decimal = readAmount(i);
      // An invalid fractional price followed by a complete number/price pair
      // can instead be the established 09.200.27.100 shorthand. Valid decimal
      // amounts are never rounded or reinterpreted to force acceptance.
      const priceRule = active.find(
        (play) => play.id === segment.context.id,
      )?.rule;
      const dotPair =
        priceRule?.kind === "number" &&
        priceRule.quantity === 1 &&
        hasObjects() &&
        followsAmountDot(i) &&
        Number(token.text) > 49 &&
        decimal &&
        entryCents(decimal.amount) === null &&
        tokens[i + 1]?.text === "." &&
        tokens[i + 2]?.kind === "number" &&
        Number(tokens[i + 2].text) >= 1 &&
        Number(tokens[i + 2].text) <= 49 &&
        tokens[i + 3]?.text === "." &&
        tokens[i + 4]?.kind === "number" &&
        Number(tokens[i + 4].text) > 49 &&
        entryCents(tokens[i + 4].text) !== null;
      const money = dotPair ? readAmount(i, true) : decimal;
      const currency = money && tokens[money.last].kind === "currency";
      if (
        money &&
        !segment.amount &&
        !["尾", "尾数", "尾數", "头", "頭"].includes(tokens[next]?.text) &&
        ((bareAfterZodiac && (money.perGroup || !followedByListAmount(i))) ||
          afterGroup ||
          currency ||
          ((money.perGroup || money.suffixMarker) && hasObjects()) ||
          ["单平", "4头不中", "四头不中"].includes(segment.context.label) ||
          (segment.explicitPlay &&
            active.find((p) => p.id === segment.context.id)?.rule.kind ===
              "zodiac_count" &&
            !followedByListAmount(i)) ||
          (Number(token.text) > 49 &&
            hasObjects() &&
            followsAmountDot(i) &&
            !followedByListAmount(i)) ||
          (hasObjects() &&
            ((segment.objectBeforePlay &&
              previousSignificant(i)?.kind === "play") ||
              !followedByListAmount(i)) &&
            ["play", "connector"].includes(previousSignificant(i)?.kind ?? "")))
      ) {
        applyAmount(money);
        if (
          !(!segment.explicitPlay && postfixPlayAfter(money.last)) &&
          (hasObjects() ||
            (segment.explicitPlay && !segment.context.id) ||
            (segment.explicitPlay &&
              active.find((p) => p.id === segment.context.id)?.rule.kind ===
                "zodiac_count"))
        )
          emit(tokens[money.last].end);
        i = money.last;
        continue;
      }
    }
    segment.content.push(token);
  }
  emit(raw.length);
  assignMarkets(raw, rows, ranges, markets);
  if (rows.length > 100) throw Error("每单最多 100 个原文片段，请核对后缩短");
  return rows;
}
