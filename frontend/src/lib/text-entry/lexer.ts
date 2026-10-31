import { monetaryLiteral } from "./amount";
import { summaryPattern } from "./summary";
import { lexicalAliases, numericPlayName } from "./vocabulary";
import { phoneticKey } from "./phonetics";

export type TokenKind =
  | "play"
  | "plays"
  | "object"
  | "number"
  | "money"
  | "summary"
  | "amount"
  | "currency"
  | "compound"
  | "package"
  | "drag"
  | "connector"
  | "single"
  | "market"
  | "group-open"
  | "group-close"
  | "separator"
  | "unknown";
export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
  labels?: string[];
}

export const marketLabels = [
  "香港六合彩",
  "新澳门",
  "新澳",
  "澳门",
  "香港",
  "澳",
  "港",
  "香",
];
const operators: [string, TokenKind][] = [
  ...marketLabels.map((s): [string, TokenKind] => [s, "market"]),
  ...[
    "各号",
    "各个数",
    "个数",
    "各组",
    "每组",
    "每尾",
    "一组",
    "1组",
    "各肖",
    "各/",
    "各数",
    "各注",
    "个组",
    "每个",
    "每注",
    "每肖",
    "合计",
    "各",
    "共",
    "下",
    "x",
    "X",
    "×",
    "*",
    "$",
    "/",
  ].map((s): [string, TokenKind] => [s, "amount"]),
  ["复式", "compound"],
  ["复试", "compound"],
  ["付", "compound"],
  ["复", "compound"],
  ["包肖", "package"],
  ["包", "package"],
  ["拖", "drag"],
  ["波", "object"],
  ["中", "single"],
  ...["元", "米", "斤", "块"].map((s): [string, TokenKind] => [s, "currency"]),
  ...[
    "六合彩",
    "6合采",
    "六合菜",
    "六合",
    "帮我打",
    "再来",
    "另",
    "买",
    "压",
    "来",
  ].map((s): [string, TokenKind] => [s, "connector"]),
];

export function tokenize(
  raw: string,
  playNames: string[],
  canResolvePlay?: (label: string) => boolean,
): Token[] {
  let normalized = "";
  const offsets: number[] = [];
  let offset = 0;
  for (const char of raw) {
    const next = char.normalize("NFKC");
    for (let i = 0; i < next.length; i++) offsets.push(offset);
    normalized += next;
    offset += char.length;
  }
  offsets.push(raw.length);
  const dictionary: [string, TokenKind][] = [
    ...new Set(
      [...playNames, ...lexicalAliases].flatMap((name) => [
        name,
        numericPlayName(name),
      ]),
    ),
  ]
    .filter(Boolean)
    .map((name) => [name.normalize("NFKC"), "play"]);
  dictionary.push(...operators);
  dictionary.push(
    ...[..."鼠牛虎兔龙蛇马羊猴鸡狗猪红蓝绿大小单双"].map(
      (char): [string, TokenKind] => [char, "object"],
    ),
  );
  const sounds = new Map<string, string>();
  const sound = (text: string) =>
    [...text]
      .map((char) => {
        if (!sounds.has(char)) sounds.set(char, phoneticKey(char));
        return sounds.get(char)!;
      })
      .join("|");
  const lengths = [...new Set(dictionary.map(([name]) => name.length))].sort(
    (a, b) => b - a,
  );
  const phonetic = new Map<string, [string, TokenKind][]>();
  for (const entry of dictionary) {
    const key = sound(entry[0]);
    const matches = phonetic.get(key) ?? [];
    matches.push(entry);
    phonetic.set(key, matches);
  }
  function match(rest: string): [string, TokenKind, number] | undefined {
    for (const length of lengths) {
      if (length > rest.length) continue;
      const input = rest.slice(0, length);
      // A short exact play followed by a zodiac takes priority over a longer
      // alias/homophone that would consume the zodiac (特马 / 平马).
      if (/^[特平]马/u.test(input) && length > 1 && !playNames.includes(input))
        continue;
      const exact = dictionary.find(([name]) => name === input);
      if (exact) return [...exact, length];
      const matches = phonetic.get(sound(input));
      if (!matches?.length) continue;
      const kinds = new Set(matches.map(([, kind]) => kind));
      if (kinds.size !== 1) continue;
      const kind = matches[0][1];
      // Keep the original play label so competing homophones stay unresolved.
      if (kind === "play") {
        if (canResolvePlay?.(input)) return [input, kind, length];
        continue;
      }
      const names = new Set(matches.map(([name]) => name));
      if (names.size === 1) return [matches[0][0], kind, length];
    }
  }
  const spaced = dictionary
    .filter(([name]) => name.length > 1 && !/\d{2}/u.test(name))
    .sort((a, b) => b[0].length - a[0].length)
    .map(([name, kind]) => ({
      name,
      kind,
      pattern: new RegExp(
        "^" +
          [...name]
            .map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
            .join("\\s*"),
        "u",
      ),
    }));
  const tokens: Token[] = [];
  let cursor = 0;
  function previousSignificant() {
    let i = tokens.length - 1;
    while (tokens[i]?.kind === "separator") i--;
    return tokens[i];
  }
  while (cursor < normalized.length) {
    const rest = normalized.slice(cursor);
    const summary = summaryPattern.exec(rest)?.[0];
    if (summary) {
      tokens.push({
        kind: "summary",
        text: summary,
        start: offsets[cursor],
        end: offsets[cursor + summary.length],
      });
      cursor += summary.length;
      continue;
    }
    const combined =
      previousSignificant()?.kind === "amount" && /^\d/u.test(rest)
        ? undefined
        : /^(?:[二三四五2345]\s*[有友]\s*[,、/]?\s*){2,}|^[二三四五2345](?:\s*[./、]?\s*[二三四五2345])+\s*(?:连肖|有|友)|^特\s*平/u.exec(
            rest,
          )?.[0];
    if (combined && !playNames.includes(combined)) {
      const labels =
        combined.replace(/\s/gu, "") === "特平"
          ? ["特码", "平码"]
          : [...combined].flatMap((c) => {
              const n = "二三四五".includes(c)
                ? "二三四五".indexOf(c) + 2
                : Number(c);
              return n >= 2 && n <= 5 ? ["一二三四五"[n - 1] + "有"] : [];
            });
      const end = cursor + combined.length;
      tokens.push({
        kind: "plays",
        text: combined,
        labels: [...new Set(labels)],
        start: offsets[cursor],
        end: offsets[end],
      });
      cursor = end;
      continue;
    }
    const exactSpaced = spaced.find((entry) => {
      const m = entry.pattern.exec(rest)?.[0];
      return (
        m &&
        /\s/u.test(m) &&
        !(
          /^[特平]马/u.test(m.replace(/\s/gu, "")) &&
          !playNames.includes(entry.name)
        )
      );
    });
    const consumed = exactSpaced?.pattern.exec(rest)?.[0];
    const word =
      consumed && exactSpaced
        ? ([exactSpaced.name, exactSpaced.kind, consumed.length] as [
            string,
            TokenKind,
            number,
          ])
        : match(rest);
    let text: string, kind: TokenKind;
    if (word) [text, kind] = word;
    else if (/^\d/u.test(rest)) {
      const candidate = /^\d+(?:\.\d+)?[十百千万]/u.exec(rest);
      // A number immediately before 十不中 is a selection, not a multiple of ten.
      const money =
        candidate && match(rest.slice(candidate[0].length - 1))?.[1] !== "play"
          ? candidate
          : null;
      text = money?.[0] ?? /^\d+/u.exec(rest)![0];
      kind = money ? "money" : "number";
    } else if (/^[零〇一二两三四五六七八九十百千万]/u.test(rest)) {
      text = /^[零〇一二两三四五六七八九十百千万]+/u.exec(rest)![0];
      for (let j = 1; j < text.length; j++) {
        if (
          match(rest.slice(j))?.[1] === "play" &&
          monetaryLiteral(text.slice(0, j)) !== null
        ) {
          text = text.slice(0, j);
          break;
        }
      }
      const value = monetaryLiteral(text);
      kind = value === null ? "money" : "number";
      // Consumed length remains based on the original Chinese text.
    } else {
      text = String.fromCodePoint(rest.codePointAt(0)!);
      kind = /[鼠牛虎兔龙蛇马羊猴鸡狗猪红蓝绿大小单双]/u.test(text)
        ? "object"
        : /[\[【({]/u.test(text)
          ? "group-open"
          : /[\]】)}]/u.test(text)
            ? "group-close"
            : /[\s,，、;；:：.。]/u.test(text)
              ? "separator"
              : "unknown";
    }
    const end = cursor + (word?.[2] ?? text.length);
    tokens.push({
      kind,
      text:
        kind === "currency"
          ? "元"
          : text === "1组"
            ? "一组"
            : kind === "number"
              ? (monetaryLiteral(text) ?? text)
              : text,
      start: offsets[cursor],
      end: offsets[end],
    });
    cursor = end;
  }
  return tokens;
}
