import { lexicalAliases } from "./vocabulary";
import { phoneticKey } from "./phonetics";

export type TokenKind =
  | "play"
  | "object"
  | "number"
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
}

const operators: [string, TokenKind][] = [
  ...["新澳门", "新澳", "澳门", "澳"].map((s): [string, TokenKind] => [
    s,
    "market",
  ]),
  ...[
    "各号",
    "各数",
    "各注",
    "各组",
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
  ["复", "compound"],
  ["包肖", "package"],
  ["包", "package"],
  ["拖", "drag"],
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
    ...new Set([...playNames, ...lexicalAliases]),
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
  const tokens: Token[] = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    const rest = normalized.slice(cursor);
    const word = match(rest);
    let text: string, kind: TokenKind;
    if (word) [text, kind] = word;
    else if (/^\d/u.test(rest)) {
      text = /^\d+/u.exec(rest)![0];
      kind = "number";
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
      text: kind === "currency" ? "元" : text,
      start: offsets[cursor],
      end: offsets[end],
    });
    cursor = end;
  }
  return tokens;
}
