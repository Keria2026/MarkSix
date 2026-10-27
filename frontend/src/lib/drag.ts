import {
  label,
  type DragInput,
  type Kind,
  type Mapping,
  type Rule,
} from "./types";
import { parseSelections } from "./selection";

export interface DragDraft {
  left: string;
  right: string;
  zodiac: boolean;
}
export function dragAvailable(rule: Rule): boolean {
  return (
    rule.compound_enabled &&
    rule.combination_size >= 2 &&
    ["number", "zodiac", "tail"].includes(rule.kind)
  );
}
function choose(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let count = 1;
  for (let i = 1; i <= k; i++) count = (count * (n - k + i)) / i;
  return Math.round(count);
}
export function dragPreview(rule: Rule, draft: DragDraft, mapping: Mapping) {
  const kind: Kind = draft.zodiac ? "zodiac" : rule.kind;
  const empty = {
    input: null,
    units: 0,
    left: [] as number[],
    right: [] as number[],
  };
  try {
    if (!dragAvailable(rule)) throw new Error("此玩法不支持拖，请先启用复式");
    if (draft.zodiac && (rule.kind !== "number" || rule.combination_size !== 2))
      throw new Error("生肖展开号码拖仅适用于每注两个号码的玩法");
    const left = parseSelections(kind, draft.left);
    const right = parseSelections(kind, draft.right);
    if (!left.length || !right.length)
      return { ...empty, error: "请填写拖的两边选项" };
    if (left.some((v) => right.includes(v)))
      throw new Error("拖的两边不能有重叠选项");
    const expand = (values: number[]) =>
      draft.zodiac
        ? mapping.zodiac.flatMap((z, i) => (values.includes(z) ? [i + 1] : []))
        : values;
    const expandedLeft = expand(left),
      expandedRight = expand(right);
    if (
      rule.selection_limit != null &&
      expandedLeft.length + expandedRight.length > rule.selection_limit
    )
      throw new Error(`总候选项不能超过 ${rule.selection_limit} 项`);
    const k = rule.combination_size;
    if (k > 2 && expandedLeft.length >= k)
      throw new Error("固定项须少于每注选项数");
    const units =
      k === 2
        ? expandedLeft.length * expandedRight.length
        : choose(expandedRight.length, k - expandedLeft.length);
    if (!units) throw new Error("拖项不足以补齐一条基础注");
    if (units > 1000) throw new Error("单次最多 1,000 条基础注，请减少拖项");
    const input: DragInput = { left, right, zodiac: draft.zodiac };
    return {
      input,
      units,
      left: expandedLeft,
      right: expandedRight,
      error: "",
    };
  } catch (error) {
    return {
      ...empty,
      error: error instanceof Error ? error.message : "拖选项不合法",
    };
  }
}
export function dragLabel(kind: Kind, drag: DragInput): string {
  const selectionKind = drag.zodiac ? "zodiac" : kind;
  return `${drag.left.map((n) => label(selectionKind, n)).join("、")} 拖 ${drag.right.map((n) => label(selectionKind, n)).join("、")}`;
}
