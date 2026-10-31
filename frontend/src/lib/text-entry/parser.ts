import { normalizeLanguage } from "./language";
import type { Play } from "../types";
import type { TextPreference, TextRow } from "../text-entry";
import { tokenize } from "./lexer";
import { resolvePlay, playCandidates } from "./vocabulary";
import type { Token } from "./lexer";
import { monetaryLiteral } from "./amount";

interface Context {
  label: string;
  id: number;
  mode: TextPreference["amount_mode"];
  compound?: boolean;
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
  const normalized = normalizeLanguage(raw);
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
  let tokens = tokenize(
    raw,
    [...active.map((p) => p.rule.name), ...habits.map((h) => h.alias)],
    (label) =>
      resolvePlay(label, active, habits).id > 0 ||
      playCandidates(label, active).some((c) => c.suggested),
  );
  // A standalone non-business heading stays in the source span, but does not
  // become a selection. Unknown text inside a bet remains an error.
  // Only leading standalone headings are remarks. Unknown text after a bet
  // remains financial input that must be corrected.
  const headings: { start: number; end: number }[] = [];
  for (const line of raw.matchAll(/^[^\r\n]+/gmu)) {
    const parts = tokens.filter(
      (t) => t.start >= line.index! && t.end <= line.index! + line[0].length,
    );
    if (!parts.some((t) => t.kind === "unknown")) break;
    if (
      parts.some((t) =>
        ["amount", "currency", "drag", "compound", "summary"].includes(t.kind),
      )
    )
      break;
    if (
      /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(line[0]) &&
      parts.some((t) => ["play", "plays", "number", "money"].includes(t.kind))
    )
      break;
    headings.push({ start: line.index!, end: line.index! + line[0].length });
  }
  tokens = tokens.filter(
    (t) => !headings.some((h) => t.start >= h.start && t.end <= h.end),
  );
  const nameEnd = tokens.findIndex(
    (t) => t.kind === "separator" && /[。.,，:：]/u.test(t.text),
  );
  if (
    nameEnd > 0 &&
    tokens.slice(0, nameEnd).some((t) => t.kind === "unknown") &&
    !tokens
      .slice(0, nameEnd)
      .some((t) => ["amount", "currency", "drag", "compound"].includes(t.kind))
  )
    tokens.splice(0, nameEnd + 1);
  const rows: TextRow[] = [];
  let market: "macau" | "hk" =
    /[港香]/u.test(raw) && !/澳/u.test(raw) ? "hk" : "macau";
  let inherited = empty();
  let inheritedContexts: Context[] = [];
  let previousBody = "";
  let lastMarket: Token | undefined;
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
    return resolvePlay(label, active, habits);
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
    const implicitSpecial =
      ["各肖", "各数"].includes(segment.marker) && !segment.explicitPlay;
    if (segment.explicitPlay || hasSelections || segment.amount) {
      if (implicitSpecial) {
        segment.context = context("特码");
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
      for (const [index, selected] of contexts.entries())
        rows.push({
          key: `${start}:${end}${contexts.length > 1 ? ":" + index : ""}`,
          source: raw.slice(start, end),
          start,
          end,
          ...(market === "hk" ? { market } : {}),
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
    let i = nextSignificant(index + 1);
    while (tokens[i]?.kind === "number") {
      i++;
      while (tokens[i]?.kind === "separator" && !/[\r\n]/u.test(tokens[i].text))
        i++;
    }
    return tokens[i]?.kind === "amount" && readAmount(i + 1) !== null;
  }
  function postfixPlayAfter(index: number) {
    let i = index + 1;
    while (
      tokens[i]?.kind === "separator" &&
      !/[\r\n。.;；]/u.test(tokens[i].text)
    )
      i++;
    while (tokens[i]?.kind === "compound") {
      i++;
      while (
        tokens[i]?.kind === "separator" &&
        !/[\r\n。.;；]/u.test(tokens[i].text)
      )
        i++;
    }
    return ["play", "plays"].includes(tokens[i]?.kind);
  }
  function readAmount(index: number): { amount: string; last: number } | null {
    let i = index;
    while (
      tokens[i]?.kind === "separator" &&
      /^[\s:：]+$/u.test(tokens[i].text)
    )
      i++;
    while (tokens[i]?.kind === "amount") {
      i = nextSignificant(i + 1);
    }
    if (!["number", "money"].includes(tokens[i]?.kind)) return null;
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
    const suffix = nextSignificant(i + 1);
    if (tokens[suffix]?.text === "一组") i = suffix;
    return {
      amount: (monetaryLiteral(amount) ?? amount).replace(
        /(\.\d*?[1-9])0+$|\.0+$/u,
        "$1",
      ),
      last: i,
    };
  }
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === "summary") {
      if (segment.explicitPlay || hasObjects() || segment.amount)
        emit(token.start);
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
      });
      start = token.end;
      segment = fresh();
      continue;
    }
    if (token.kind === "market") {
      const nextMarket = /[港香]/u.test(token.text) ? "hk" : "macau";
      if (
        market !== nextMarket &&
        ((lastMarket &&
          /^[\s,，、:：;；]*$/u.test(raw.slice(lastMarket.end, token.start))) ||
          (lastMarket &&
            tokens.slice(i + 1).every((t) => t.kind === "separator")))
      ) {
        segment.content.push({
          ...token,
          kind: "unknown",
          text: "市场范围待确认",
        });
      }
      if (segment.amount || (hasObjects() && market !== nextMarket))
        emit(token.start);
      market = nextMarket;
      lastMarket = token;
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
        (selected?.rule.kind === "number" &&
          segment.content.some((t) => t.kind === "drag"))
      ) {
        if (
          !segment.explicitPlay &&
          !segment.content.some((t) => t.kind === "drag")
        )
          infer("tail");
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
        segment.context.label === "平特" &&
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
      if (token.labels?.every((label) => label.endsWith("有")))
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
        /[鼠牛虎兔龙蛇马羊猴鸡狗猪红蓝绿大小单双尾波]/u.test(previous.text);
      const money = readAmount(i);
      const currency = money && tokens[money.last].kind === "currency";
      if (
        money &&
        !segment.amount &&
        !["尾", "尾数", "尾數"].includes(tokens[next]?.text) &&
        (bareAfterZodiac ||
          afterGroup ||
          currency ||
          ["单平", "4头不中", "四头不中"].includes(segment.context.label) ||
          (segment.explicitPlay &&
            active.find((p) => p.id === segment.context.id)?.rule.kind ===
              "zodiac_count") ||
          (Number(token.text) > 49 &&
            hasObjects() &&
            tokens[i - 1]?.kind === "separator" &&
            tokens[i - 1]?.text === "." &&
            !followedByListAmount(i)) ||
          (hasObjects() &&
            ["play", "connector"].includes(previousSignificant(i)?.kind ?? "")))
      ) {
        segment.amount = money.amount;
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
  if (rows.length > 100) throw Error("每单最多 100 个原文片段，请核对后缩短");
  return rows;
}
