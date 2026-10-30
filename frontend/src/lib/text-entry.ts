import type { Play } from "./types";
export { playCandidates } from "./text-entry/vocabulary";

export type AmountMode = "auto" | "each" | "package" | "total";
export interface TextPreference {
  alias: string;
  play_id: number;
  play_version: number;
  amount_mode: AmountMode;
}
export interface TextRow {
  key: string;
  source: string;
  start: number;
  end: number;
  playLabel: string;
  playId: number;
  body: string;
  amount: string;
  marker: string;
  mode: AmountMode;
  customAlias: boolean;
  objectBeforePlay?: boolean;
  excluded?: boolean;
  basePlayId?: number;
  baseMode?: AmountMode;
}
export interface TextDraft {
  raw: string;
  recognized: string;
  bettor: string;
  rows: TextRow[];
}
export function newTextDraft(): TextDraft {
  return {
    raw: "",
    recognized: "",
    bettor: "",
    rows: [],
  };
}

export { parseText } from "./text-entry/parser";
export { compileRow } from "./text-entry/compiler";
export type { CompiledRow } from "./text-entry/compiler";

export function confirmedPreferences(
  rows: TextRow[],
  plays: Play[],
): TextPreference[] {
  const grouped = new Map<string, TextPreference | null>();
  for (const row of rows) {
    const play = plays.find((p) => p.id === row.playId);
    if (!play || !/^[\p{L}\p{N}]{1,40}$/u.test(row.playLabel)) continue;
    const next = {
      alias: row.playLabel,
      play_id: play.id,
      play_version: play.version,
      amount_mode: row.mode,
    };
    const old = grouped.get(row.playLabel);
    if (old === undefined) grouped.set(row.playLabel, next);
    else if (
      old &&
      (old.play_id !== next.play_id || old.amount_mode !== next.amount_mode)
    )
      grouped.set(row.playLabel, null);
  }
  return [...grouped.values()].filter((p): p is TextPreference => p !== null);
}
