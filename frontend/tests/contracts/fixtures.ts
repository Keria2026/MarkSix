import defaults from "../../../backend/src/default-plays.json" with { type: "json" };
import type { Play } from "../../src/lib/types";
export const plays: Play[] = defaults.plays.map((p, i) => ({
  ...p,
  id: i + 1,
  version: 1,
})) as Play[];
