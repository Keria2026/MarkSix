import { monetaryLiteral } from "./amount";
import { phoneticKey } from "./phonetics";
import type { Play } from "../types";
import type { TextPreference } from "../text-entry";
import trained from "../generated/text-entry-candidates.json" with { type: "json" };

// Numeric spelling is an orthographic variant of a configured play name.
export function numericPlayName(name: string) {
  return name.replace(
    /[零〇一二两三四五六七八九十百千万]+/gu,
    (text) => monetaryLiteral(text) ?? text,
  );
}

// Domain meanings confirmed by the user. Exact configured names take precedence.
const meanings: Record<string, string> = Object.fromEntries(
  Object.entries({
    特码: ["特码", "特", "澳特", "T", "t"],
    平码: ["平码", "平"],
    ...Object.fromEntries(
      [2, 3, 4, 5].map((n) => {
        const cn = "一二三四五"[n - 1];
        return [
          cn + "有",
          [
            cn + "有",
            cn + "友",
            cn + "连",
            cn + "连肖",
            n + "有",
            n + "友",
            n + "连",
            n + "连肖",
          ],
        ];
      }),
    ),
    一肖中: [
      "一肖中",
      "一有",
      "1有",
      "平特",
      "平特一肖",
      "平特一肖",
      "平特肖",
      "平特+肖",
      "一肖",
      "肖中",
    ],
    二中二含特: ["二中特", "二中二带特", "二中二帶特"],
    四肖中特: ["新澳门四肖", "四肖"],
  }).flatMap(([name, aliases]) => aliases.map((alias) => [alias, name])),
);
// Other observed words can be recognized without inventing a matching play.
export const lexicalAliases = [
  ...new Set([
    ...Object.keys(meanings),
    ...Object.keys(trained.candidates),
    "平特一肖",
    "三友",
    "二中2",
    "2中2",
    "三中2",
    "3中2",
    "三全中",
    "3全中",
    "特码生肖",
    "特肖",
    "特生",
    "一宵",
    "单肖",
    "六肖",
    "连肖",
    "连生",
    "串肖",
    "平码号",
    "平马",
    "正码",
    "尾数",
    "尾數",
    "尾",
    "单平",
    "4头不中",
    "四头不中",
    "色波",
    "大小",
    "单双",
  ]),
];

export function playCandidates(alias: string, plays: Play[]) {
  const vocabulary: Record<string, { name: string; count: number }[]> =
    trained.candidates;
  const counts = new Map(
    (Object.hasOwn(vocabulary, alias) ? vocabulary[alias] : []).map((c) => [
      c.name,
      c.count,
    ]),
  );
  const meaning = Object.hasOwn(meanings, alias) ? meanings[alias] : undefined;
  return plays
    .filter((p) => p.enabled)
    .map((play) => ({
      play,
      suggested:
        play.rule.name === meaning ||
        counts.has(play.rule.name) ||
        phoneticKey(play.rule.name) === phoneticKey(alias) ||
        phoneticKey(numericPlayName(play.rule.name)) === phoneticKey(alias) ||
        Object.entries(meanings).some(
          ([label, name]) =>
            name === play.rule.name &&
            phoneticKey(label) === phoneticKey(alias),
        ) ||
        Object.entries(vocabulary).some(
          ([label, targets]) =>
            phoneticKey(label) === phoneticKey(alias) &&
            targets.some((target) => target.name === play.rule.name),
        ),
      count: counts.get(play.rule.name) ?? 0,
    }))
    .sort(
      (a, b) =>
        Number(b.play.rule.name === alias) -
          Number(a.play.rule.name === alias) ||
        Number(b.play.rule.name === meaning) -
          Number(a.play.rule.name === meaning) ||
        Number(b.suggested) - Number(a.suggested) ||
        b.count - a.count,
    );
}

export function resolvePlay(
  label: string,
  active: Play[],
  habits: TextPreference[],
) {
  const named = active.filter((p) => p.rule.name.normalize("NFKC") === label);
  const exact = named.length
    ? named
    : active.filter(
        (p) => numericPlayName(p.rule.name) === numericPlayName(label),
      );
  const habit = habits.find((h) => h.alias.normalize("NFKC") === label);
  let id = 0;
  if (exact.length) id = exact.length === 1 ? exact[0].id : 0;
  else {
    const meaning = Object.hasOwn(meanings, label)
      ? meanings[label]
      : undefined;
    const domain = active.filter((p) => p.rule.name === meaning);
    if (domain.length) id = domain.length === 1 ? domain[0].id : 0;
    else if (habit) id = habit.play_id;
    else {
      const candidates = playCandidates(label, active).filter(
        (c) => c.suggested,
      );
      const ids = new Set([
        ...candidates.map((candidate) => candidate.play.id),
        ...habits
          .filter((h) => phoneticKey(h.alias) === phoneticKey(label))
          .map((h) => h.play_id),
      ]);
      if (ids.size === 1) id = [...ids][0];
    }
  }
  return {
    label,
    id,
    mode: habit?.play_id === id ? habit.amount_mode : ("auto" as const),
  };
}
