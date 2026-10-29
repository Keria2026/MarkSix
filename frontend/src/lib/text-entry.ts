import { basicCount, entryCents, zodiacs } from "./types";
import type { Mapping, Play, SlipLine } from "./types";
import { dragPreview } from "./drag";
import trainedCandidates from "./generated/text-entry-candidates.json" with { type: "json" };

export function playCandidates(alias: string, plays: Play[]) {
  const vocabulary: Record<string, { name: string; count: number }[]> =
    trainedCandidates.candidates;
  const counts = new Map(
    (Object.hasOwn(vocabulary, alias) ? vocabulary[alias] : []).map(
      (candidate) => [candidate.name, candidate.count],
    ),
  );
  return plays
    .filter((play) => play.enabled)
    .map((play) => ({
      play,
      suggested: counts.has(play.rule.name),
      count: counts.get(play.rule.name) ?? 0,
    }))
    .sort((a, b) => b.count - a.count);
}

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
}
export interface TextDraft {
  raw: string;
  recognized: string;
  bettor: string;
  rows: TextRow[];
  remember: boolean;
  pending: { key: string; id: string } | null;
}
export function newTextDraft(): TextDraft {
  return {
    raw: "",
    recognized: "",
    bettor: "",
    rows: [],
    remember: true,
    pending: null,
  };
}

// These are vocabulary candidates, never automatic mappings to a financial rule.
const vocabulary = [
  "新澳门四肖",
  "平特一肖",
  "二中特",
  "澳特",
  "特",
  "三友",
  "二有",
  "三有",
  "四有",
  "五有",
  "二中二",
  "八不中",
  "二中2",
  "2中2",
  "三中2",
  "3中2",
  "三全中",
  "3全中",
  "特码生肖",
  "特肖",
  "特生",
  "一肖",
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
  "波色",
  "大小",
  "单双",
];
const separator = /^[\s,，、;；:：.。\-]+$/u;
const prefix =
  /^(?:(?:六合彩|6合采|六合菜|六合|新澳门)[\s:：-]*|(?:帮我打|买|下|压|来|再来)[\s:：-]*)+/u;

function normalizedSource(raw: string) {
  let text = "";
  const positions: number[] = [];
  let index = 0;
  for (const char of raw) {
    const normalized = char.normalize("NFKC");
    for (let i = 0; i < normalized.length; i++) positions.push(index);
    text += normalized;
    index += char.length;
  }
  positions.push(raw.length);
  return { text, positions };
}

export function parseText(
  raw: string,
  plays: Play[],
  learned: TextPreference[] = [],
): TextRow[] {
  if (raw.length > 12000)
    throw new Error("每单原文最多 12,000 字，请核对后缩短；不会自动拆成多张单");
  const { text, positions } = normalizedSource(raw);
  const active = plays.filter((p) => p.enabled);
  const habits = learned.filter((p) =>
    active.some((a) => a.id === p.play_id && a.version === p.play_version),
  );
  const words = [
    ...new Set([
      ...active.map((p) => p.rule.name),
      ...habits.map((p) => p.alias),
      ...vocabulary,
    ]),
  ].sort((a, b) => b.length - a.length);
  const rows: TextRow[] = [];
  let start = 0,
    bodyStart = 0,
    cursor = 0,
    playLabel = "",
    hasHeader = false;
  function emit(
    end: number,
    amount = "",
    marker = "",
    bodyEnd = end,
    bodyOverride?: string,
  ) {
    const source = raw.slice(positions[start], positions[end]);
    if (!source.trim() || separator.test(source)) {
      start = end;
      bodyStart = end;
      return;
    }
    const matches = active.filter((p) => p.rule.name === playLabel);
    const habit = habits.find((p) => p.alias === playLabel);
    rows.push({
      key: `${positions[start]}:${positions[end]}`,
      source,
      start: positions[start],
      end: positions[end],
      playLabel,
      playId:
        matches.length === 1
          ? matches[0].id
          : matches.length > 1
            ? 0
            : (habit?.play_id ?? 0),
      body:
        bodyOverride ??
        text
          .slice(bodyStart, bodyEnd)
          .replace(/^[\s:：,，;；]+|[\s,，;；]+$/gu, ""),
      amount,
      marker,
      mode: habit?.amount_mode ?? "auto",
      customAlias: !playLabel,
    });
    start = end;
    bodyStart = end;
    hasHeader = false;
  }
  while (cursor < text.length) {
    const word = words.find(
      (w) =>
        text.startsWith(w, cursor) &&
        !(w === "尾" && /\d$/u.test(text.slice(bodyStart, cursor))),
    );
    if (word) {
      const preceding = text
        .slice(bodyStart, cursor)
        .replace(/^[\s,，;；:：]+/u, "")
        .replace(prefix, "");
      if (hasHeader || (preceding.trim() && !separator.test(preceding)))
        emit(cursor);
      playLabel = word;
      cursor += word.length;
      bodyStart = cursor;
      hasHeader = true;
      continue;
    }
    const rest = text.slice(cursor);
    const packageFirst =
      /^(\d+(?:\.\d+)?)包([鼠牛虎兔龙蛇马羊猴鸡狗猪]+)/u.exec(rest);
    if (packageFirst && /^[\s:：,，]*$/u.test(text.slice(bodyStart, cursor))) {
      const end = cursor + packageFirst[0].length;
      emit(end, packageFirst[1], "每肖", cursor, packageFirst[2]);
      cursor = end;
      continue;
    }
    // A slash is an amount delimiter only after numeric selections, never 羊/狗.
    const explicit =
      /^(各(?:号|数|注|组)?|个组|每个|每注|每肖|共|合计|下|[xX×*$]|\/)\s*(\d+(?:\.\d+)?)(?:\s*(?:元|米|块))?/u.exec(
        rest,
      );
    const preceding = text.slice(bodyStart, cursor);
    if (
      explicit &&
      preceding.trim() &&
      !(explicit[1] === "/" && /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(preceding))
    ) {
      const end = cursor + explicit[0].length;
      emit(end, explicit[2], explicit[1], cursor);
      cursor = end;
      continue;
    }
    const bare = /^(\d+(?:\.\d+)?)(元|米|块)?/u.exec(rest);
    if (
      bare &&
      /[鼠牛虎兔龙蛇马羊猴鸡狗猪]\s*[,，、;；]?\s*$/u.test(preceding)
    ) {
      const end = cursor + bare[0].length;
      emit(end, bare[1], "", cursor);
      cursor = end;
      continue;
    }
    // Explicit currency after a space also disambiguates numeric selections.
    if (bare?.[2] && /\s$/u.test(preceding) && preceding.trim()) {
      const end = cursor + bare[0].length;
      emit(end, bare[1], "", cursor);
      cursor = end;
      continue;
    }
    cursor++;
  }
  emit(text.length);
  if (rows.length > 100)
    throw new Error("每单最多 100 个原文片段，请核对后缩短");
  return rows;
}

function values(body: string, kind: Play["rule"]["kind"]): number[] {
  if (body.includes("-"))
    throw new Error("横线可能表示范围或负数，请改为明确的选项列表");
  const clean = body.replace(/[\s,，、;；:：.。/\[\]【】()（）-]/gu, "");
  let result: number[];
  if (kind === "zodiac") {
    result = [...clean].map((c) => zodiacs.indexOf(c));
  } else if (kind === "number" || kind === "tail" || kind === "zodiac_count") {
    const tokens = body
      .replace(/[尾]/gu, kind === "tail" ? " " : "尾")
      .split(/[\s,，、;；:：.。/\[\]【】()（）-]+/u)
      .filter(Boolean);
    if (tokens.some((t) => !/^\d{1,2}$/u.test(t)))
      throw new Error("连写号码或未知文字：请用空格分开每个号码，不能自动猜分");
    result = tokens.map(Number);
    const min = kind === "number" ? 1 : 0;
    const max = kind === "number" ? 49 : kind === "tail" ? 9 : 12;
    if (result.some((v) => v < min || v > max))
      throw new Error("选项超出当前玩法范围");
  } else {
    const names =
      kind === "wave"
        ? ["红", "蓝", "绿"]
        : kind === "size"
          ? ["小", "大"]
          : ["双", "单"];
    result = [...clean.replace(/波/gu, "")].map((c) => names.indexOf(c));
  }
  if (!result.length || result.some((v) => v < 0))
    throw new Error("存在未识别的投注项，请修正，不能忽略");
  if (new Set(result).size !== result.length)
    throw new Error("同一组存在重复选项，请确认是重复投注还是笔误");
  return result;
}

export interface CompiledRow {
  items: SlipLine[];
  error: string;
}
export function compileRow(
  row: TextRow,
  plays: Play[],
  mapping: Mapping,
): CompiledRow {
  try {
    const play = plays.find((p) => p.id === row.playId && p.enabled);
    if (!play)
      throw new Error(`请确认“${row.playLabel || "未注明玩法"}”对应的玩法`);
    const cents = entryCents(row.amount);
    if (cents === null) throw new Error("请明确金额，须大于零且最多一位小数");
    const { rule } = play;
    let body = row.body;
    if (body.includes("托"))
      throw new Error("“托”可能表示“拖”，请确认后在选项中改为“拖”");
    const compound = body.includes("复式");
    const packageIntent = body.includes("包") || row.marker === "每肖";
    if (packageIntent && /^(共|合计)$/u.test(row.marker))
      throw new Error("包肖与总额同时出现，请明确每肖金额");
    body = body.replace(/复式|包肖|包/gu, "");
    const mode = /^(共|合计)$/u.test(row.marker)
      ? "total"
      : packageIntent
        ? "package"
        : row.marker
          ? "each"
          : row.mode;
    const base = {
      play_id: play.id,
      play_version: play.version,
      amount: row.amount,
      selections: [] as number[],
      compound: false,
    };
    let items: SlipLine[];
    if (body.includes("拖")) {
      const halves = body.split("拖");
      if (halves.length !== 2) throw new Error("拖投注须有明确的左右两组");
      const zodiac =
        rule.kind === "number" && /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(body);
      const kind = zodiac ? "zodiac" : rule.kind;
      const drag = {
        left: values(halves[0], kind),
        right: values(halves[1], kind),
        zodiac,
      };
      if (mode === "package") throw new Error("拖投注不能按每肖包号金额录入");
      items = [{ ...base, compound: true, drag }];
    } else if (
      rule.kind === "number" &&
      /[鼠牛虎兔龙蛇马羊猴鸡狗猪]/u.test(body)
    ) {
      if (rule.quantity !== 1)
        throw new Error("号码组合中的生肖请明确写成拖投注或改为号码");
      const zs = values(body, "zodiac");
      if (mode === "auto")
        throw new Error("生肖金额有歧义：请选择每号金额或每肖包号金额");
      items = [
        mode === "package"
          ? { ...base, package_zodiacs: zs }
          : {
              ...base,
              selections: mapping.zodiac.flatMap((z, i) =>
                zs.includes(z) ? [i + 1] : [],
              ),
            },
      ];
    } else {
      if (mode === "package")
        throw new Error("包肖只适用于单号码玩法与生肖选项");
      // Comma-separated full zodiac sets are separate lines of the same slip.
      const parts = body.split(/[,，;；]+/u).filter((s) => s.trim());
      const groups =
        rule.kind === "zodiac" &&
        rule.quantity > 1 &&
        !compound &&
        parts.length > 1 &&
        parts.every((s) => s.replace(/\s/gu, "").length === rule.quantity)
          ? parts
          : [body];
      items = groups.map((group) => {
        const selections = values(group, rule.kind);
        if (
          !compound &&
          rule.quantity > 1 &&
          rule.relation === "eq" &&
          selections.length !== rule.quantity
        )
          throw new Error(
            `本玩法需要 ${rule.quantity} 项；更多候选请明确写“复式”`,
          );
        return { ...base, selections, compound };
      });
    }
    let units = 0;
    for (const item of items) {
      if (item.drag) {
        const d = item.drag;
        const preview = dragPreview(
          rule,
          {
            left: d.left
              .map((v) =>
                d.zodiac || rule.kind === "zodiac" ? zodiacs[v] : String(v),
              )
              .join(" "),
            right: d.right
              .map((v) =>
                d.zodiac || rule.kind === "zodiac" ? zodiacs[v] : String(v),
              )
              .join(" "),
            zodiac: d.zodiac,
          },
          mapping,
        );
        if (!preview.input)
          throw new Error(preview.error || "拖投注不符合当前玩法");
        units += preview.units;
      } else
        units += item.package_zodiacs?.length
          ? mapping.zodiac.filter((z) => item.package_zodiacs!.includes(z))
              .length
          : basicCount(rule, item.selections, item.compound);
    }
    if (!units || units > 1000)
      throw new Error("注数无效或超过 1000 注，请修正候选项");
    if (mode === "total") {
      if (cents % BigInt(units) !== 0n || (cents / BigInt(units)) % 10n !== 0n)
        throw new Error("总金额不能按当前注数均分到一角，请明确每注金额");
      const per = cents / BigInt(units);
      const amount = `${per / 100n}.${(per % 100n) / 10n}`;
      items = items.map((item) => ({ ...item, amount }));
    }
    return { items, error: "" };
  } catch (error) {
    return {
      items: [],
      error: error instanceof Error ? error.message : "无法识别",
    };
  }
}

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
