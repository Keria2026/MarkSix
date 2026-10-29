import type { ModuleFeatures, EntryMode, Play } from "./types";
export function entryModeFor(features: ModuleFeatures): EntryMode | null {
  if (features.entry_mode === "text" && features.text_entry) return "text";
  if (features.entry_mode === "manual" && features.manual_entry)
    return "manual";
  if (features.manual_entry) return "manual";
  return features.text_entry ? "text" : null;
}
export function specialRatePlay(play: Play) {
  const r = play.rule;
  return (
    play.enabled &&
    r.kind === "number" &&
    r.scope === "special" &&
    r.condition === "all" &&
    r.quantity === 1
  );
}
