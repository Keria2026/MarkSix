import { phoneticKey } from "./phonetics";
import type { Play } from "../types";
import type { TextPreference } from "../text-entry";
import trained from "../generated/text-entry-candidates.json" with { type: "json" };

// Domain meanings confirmed by the user. Exact configured names take precedence.
const meanings: Record<string, string> = Object.fromEntries(
  Object.entries({
    特码: ["特码", "特", "澳特"],
    一肖中: [
      "一肖中",
      "平特一肖",
      "平特一肖",
      "平特肖",
      "平特+肖",
      "一肖",
      "肖中",
    ],
    二中二含特: ["二中特"],
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
  const exact = active.filter((p) => p.rule.name.normalize("NFKC") === label);
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
