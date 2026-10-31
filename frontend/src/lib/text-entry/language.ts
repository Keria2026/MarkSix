import { monetaryLiteral } from "./amount";

// Normalization is deliberately finite: unknown words survive for correction.
// Each replacement retains its original interval, including reordered fields.
export function normalizeLanguage(raw: string) {
  let text = raw;
  let spans = Array.from({ length: raw.length }, (_, start) => ({
    start,
    end: start + 1,
  }));
  function replace(
    pattern: RegExp,
    render: string | ((match: RegExpExecArray) => string),
  ) {
    const matches = [...text.matchAll(pattern)];
    for (const match of matches.reverse()) {
      const start = match.index!,
        end = start + match[0].length;
      const next = typeof render === "string" ? render : render(match);
      const range = {
        start: spans[start]?.start ?? raw.length,
        end: spans[end - 1]?.end ?? raw.length,
      };
      text = text.slice(0, start) + next + text.slice(end);
      spans.splice(
        start,
        end - start,
        ...Array.from({ length: next.length }, () => range),
      );
    }
  }
  // Corrections, cancellations and unresolved historical references are not noise.
  if (
    /作废|取消|先别|不要下|暂停|转发|引用|啊不|哦[，,]?是|算了|昨天|照旧|前面别动|不是.*那个|是不是这样/u.test(
      raw,
    )
  )
    return { text: raw, spans, review: true };

  replace(
    /[連組複復試數碼龍馬雞豬藍綠]/gu,
    (m) =>
      ({
        連: "连",
        組: "组",
        複: "复",
        復: "复",
        試: "试",
        數: "数",
        碼: "码",
        龍: "龙",
        馬: "马",
        雞: "鸡",
        豬: "猪",
        藍: "蓝",
        綠: "绿",
      })[m[0]]!,
  );
  replace(
    /[壹贰叁肆伍陆柒捌玖拾]/gu,
    (m) =>
      ({
        壹: "一",
        贰: "二",
        叁: "三",
        肆: "四",
        伍: "五",
        陆: "六",
        柒: "七",
        捌: "八",
        玖: "九",
        拾: "十",
      })[m[0]]!,
  );
  replace(/散(?=[二三四五2345]+(?:有|友|连))/gu, "三");
  replace(/—{2,}/gu, " ");
  replace(/平特尾中/gu, "尾中");
  replace(/澳门的/gu, "澳门");
  replace(/(新[澳奥傲]|澳门|澳们)下(?=[二三四五2345])/gu, (m) => m[1]);
  replace(
    /各数([零〇一二两三四五六七八九十百千万\d]+)[，,]是每个号码([零〇一二两三四五六七八九十百千万\d]+)/gu,
    (m) =>
      monetaryLiteral(m[1]) === monetaryLiteral(m[2]) ? "各数" + m[1] : m[0],
  );
  replace(/这项是每肖[，,]不是总共[。.]?/gu, "");
  replace(/([零〇一二两三四五六七八九十百千万\d]+)码那边是([0-9]+)号/gu, (m) =>
    Number(monetaryLiteral(m[1])) === Number(m[2]) ? m[2] + "号" : m[0],
  );
  replace(
    /([零〇一二两三四五六七八九十百千万\d]+)码(?=托|拖)/gu,
    (m) => m[1] + "号",
  );
  replace(
    /合计先写[：:]\s*([零〇一二两三四五六七八九十百千万\d]+)组[，,]\s*共([\d]+)[。.]?/gu,
    (m) => m[1] + "组共" + m[2] + "\n",
  );
  replace(/下面这些[：:]/gu, "");
  replace(
    /一共([零〇一二两三四五六七八九十百千万\d]+)注([零〇一二两三四五六七八九十百千万\d]+)(元|米|块)/gu,
    (m) => m[1] + "组共" + m[2] + m[3],
  );
  replace(
    /([0-9、，,\s]+)[，,]\s*特码[，,]\s*(?:一共|总共|共)([0-9]+)(元|米|块)[，,]([零〇一二两三四五六七八九十\d]+)号码平均分[。.]?/gu,
    (m) => {
      const n = m[1].split(/[、，,\s]+/u).filter(Boolean).length;
      return n === Number(monetaryLiteral(m[4]))
        ? m[1] + "特码共" + m[2] + m[3]
        : m[0];
    },
  );
  const latin: [string, string][] = [
    ["er\\s+zhong\\s+er\\s+(?:dai\\s+te)", "二中二含特"],
    ["er\\s+zhong\\s+er", "二中二"],
    ["each\\s+group", "每组"],
    ["ping\\s+te", "平特"],
    ["lian\\s+xiao", "连肖"],
    ["fu\\s*shi", "复式"],
    ["ao\\s*men|am", "澳门"],
    ["xin\\s+ao", "新澳"],
    ["shu", "鼠"],
    ["niu", "牛"],
    ["hu", "虎"],
    ["tu", "兔"],
    ["long", "龙"],
    ["she", "蛇"],
    ["ma", "马"],
    ["yang", "羊"],
    ["hou", "猴"],
    ["ji", "鸡"],
    ["gou", "狗"],
    ["zhu", "猪"],
    ["er", "2"],
    ["san", "3"],
    ["si", "4"],
    ["wu", "5"],
    ["you", "有"],
    ["lian", "连"],
    ["wei", "尾"],
    ["xiao", "肖"],
    ["tuo", "拖"],
    ["te", "特"],
    ["each", "各"],
  ];
  replace(/各\s*shu\b/giu, "各数");
  replace(/([0-9]+)\s+each\b/giu, (m) => "各" + m[1]);
  const numerals: Record<string, string> = {
    ling: "零",
    yi: "一",
    er: "二",
    liang: "两",
    san: "三",
    si: "四",
    wu: "五",
    liu: "六",
    qi: "七",
    ba: "八",
    jiu: "九",
    shi: "十",
    bai: "百",
    qian: "千",
    wan: "万",
  };
  const numeralWords = Object.keys(numerals).join("|");
  // Resolve longer play/market phrases first, then compositional spoken numbers.
  for (const [from, to] of latin.splice(0, 2))
    replace(new RegExp("\\b(?:" + from + ")\\b", "giu"), to);
  replace(
    new RegExp(
      "\\b(?:" + numeralWords + ")(?:\\s+(?:" + numeralWords + "))*\\b",
      "giu",
    ),
    (m) => {
      const value = monetaryLiteral(
        m[0]
          .toLowerCase()
          .split(/\s+/u)
          .map((word) => numerals[word])
          .join(""),
      );
      return value ?? m[0];
    },
  );
  for (const [from, to] of latin)
    replace(new RegExp("\\b(?:" + from + ")\\b", "giu"), to);
  replace(
    /(?<=[鼠牛虎兔龙蛇马羊猴鸡狗猪])\s*\+\s*(?=[鼠牛虎兔龙蛇马羊猴鸡狗猪])/gu,
    "、",
  );
  replace(/各消/gu, "各肖");
  replace(/(?:特号|特码号)/gu, "特码");
  replace(/每号|各个号码|每个号码/gu, "各数");
  replace(/每个尾数|每个尾|各尾/gu, "每尾");
  replace(/每肖(?=[\s零〇一二两三四五六七八九十百千万\d])/gu, "各肖");
  replace(/一消中/gu, "一肖中");
  replace(
    /([零〇一二两三四五六七八九十百千万\d]+)码(?=和|、|，|\s|特码)/gu,
    (m) => m[1] + "号",
  );
  replace(
    /([零〇一二两三四五六七八九十百千万\d]+)米一组/gu,
    (m) => "每组" + m[1] + "米",
  );
  // Bounded politeness phrases do not carry selections or amounts.
  replace(
    /^(?:这张记[^\r\n，,。；;]{1,20}名下|记[^\r\n：:]{1,20}[（(]今天这张[）)])[:：]?/gu,
    "",
  );
  replace(/这张(?:新澳|澳门)[：:]/gu, "新澳");
  replace(
    /(?:先下|接着|然后|最后加|另外|另下|再下|再来|接下来|先买|再买|这项是|这项|全部|一组一组|给我|再帮我加个|帮我加个|帮我加|帮我下|那个新澳|那个澳门)/gu,
    (m) =>
      m[0].includes("新澳") ? "新澳" : m[0].includes("澳门") ? "澳门" : "",
  );
  replace(/(?<=[，,。；;\n])\s*(?:然后|另外|接着|那个|另|再加一组)/gu, "");
  replace(
    /，?就这些[。.]?\s*$|，?一起记[。.]?\s*$|，?帮我核一下[。.]?\s*$/gu,
    "",
  );
  replace(/\n以上全是新澳[。.]?\s*$/gu, "");
  replace(
    /(?:别弄成包肖|是包号那种|是每肖|是每个号码\s*[\d]+|是每个号码|每个号码)(?=[，,。；;]|$)/gu,
    "",
  );
  replace(
    /(?:不要把[鼠牛虎兔龙蛇马羊猴鸡狗猪]+也按每肖包|别的不要|不是总共)(?:[。.;；]|$)/gu,
    "",
  );
  replace(/(?<=[鼠牛虎兔龙蛇马羊猴鸡狗猪])(?:两只|两肖)/gu, "");
  replace(/还是这([一二三四五六七八九\d]+)肖/gu, (m) => {
    const previous = [
      ...text.slice(0, m.index).matchAll(/[鼠牛虎兔龙蛇马羊猴鸡狗猪]{2,}/gu),
    ].at(-1)?.[0];
    return previous?.length === Number(monetaryLiteral(m[1])) ? "" : m[0];
  });
  replace(/(?:同样候选|也复|还是这批候选)/gu, (m) =>
    m[0] === "也复" ? "复式" : "",
  );
  replace(/这一套|这一批/gu, "");
  replace(/是(?=各数)/gu, "");
  replace(
    /总共|一共(?=[零〇一二两三四五六七八九十百千万\d]+(?:米|元|块))/gu,
    "共",
  );
  replace(
    /(?<=[鼠牛虎兔龙蛇马羊猴鸡狗猪])\s*和\s*(?=[鼠牛虎兔龙蛇马羊猴鸡狗猪])/gu,
    "、",
  );
  replace(
    /(?<=[0-9零〇一二两三四五六七八九十百千万号])\s*和\s*(?=[0-9零〇一二两三四五六七八九十百千万])/gu,
    "、",
  );
  replace(/([^。！？\n]+?)[，,]?都(?:要|做)(?:复式|复试)/gu, (m) =>
    m[1].replace(/([二三四五2345](?:有|连肖|连))/gu, "$1复式"),
  );
  // Explicitly named group counts are checked before removing the redundant prose.
  replace(
    /([二三四五2345](?:有|友|连))\s*([鼠牛虎兔龙蛇马羊猴鸡狗猪、，,\s]+?)([一二三四五六七八九十\d]+)组/gu,
    (m) => {
      const q = Number(monetaryLiteral(m[1][0]));
      const count = Number(monetaryLiteral(m[3]));
      const selected = m[2].replace(/[^鼠牛虎兔龙蛇马羊猴鸡狗猪]/gu, "");
      return selected.length === q * count ? m[1] + m[2] : m[0];
    },
  );
  replace(
    /([三四五2345./、]+(?:有|连肖))全复[，,]([鼠牛虎兔龙蛇马羊猴鸡狗猪]+)[；;]((?:[二三四五2345]有每注[0-9]+[、，,]?){2,})/gu,
    (m) => {
      const plays = [...m[3].matchAll(/([二三四五2345])有每注([0-9]+)/gu)];
      const declared = [...m[1]]
        .filter((c) => /[二三四五2345]/u.test(c))
        .map((c) => Number(monetaryLiteral(c)));
      return plays.length === declared.length &&
        new Set(plays.map((p) => Number(monetaryLiteral(p[1])))).size ===
          declared.length &&
        plays.every((p) => declared.includes(Number(monetaryLiteral(p[1]))))
        ? plays.map((p) => p[1] + "有复式" + m[2] + "每注" + p[2]).join("；")
        : m[0];
    },
  );
  // Semantically empty emphatic counters after a known object list.
  replace(/，?刚才([鼠牛虎兔龙蛇马羊猴鸡狗猪]+)那组也保留/gu, (m) =>
    text.slice(0, m.index).includes(m[1]) ? "" : m[0],
  );
  return { text, spans };
}
