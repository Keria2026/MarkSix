// Convert explicit monetary literals without floating point or abbreviated-place guesses.
// A bare numeral is still classified by the parser's surrounding syntax.
export function monetaryLiteral(text: string): string | null {
  if (/^\d+(?:\.\d+)?$/u.test(text)) return text;
  const scaled = /^(\d+(?:\.\d+)?)([十百千万])$/u.exec(text);
  const units: Record<string, bigint> = {
    十: 10n,
    百: 100n,
    千: 1000n,
    万: 10000n,
  };
  if (scaled) {
    const [whole, fraction = ""] = scaled[1].split(".");
    const denominator = 10n ** BigInt(fraction.length);
    const value = BigInt(whole + fraction) * units[scaled[2]];
    if (value % denominator !== 0n) return null;
    return String(value / denominator);
  }
  if (!/^[零〇一二两三四五六七八九十百千万]+$/u.test(text)) return null;
  const digits = "零一二三四五六七八九";
  const normalized = text.replace(/〇/gu, "零").replace(/两/gu, "二");
  if (!/[十百千万]/u.test(normalized))
    return [...normalized].map((c) => digits.indexOf(c)).join("");
  let total = 0n,
    section = 0n,
    digit = 0n,
    last = 10000n;
  for (const char of normalized) {
    if (digits.includes(char)) {
      if (digit !== 0n) return null;
      digit = BigInt(digits.indexOf(char));
    } else {
      const unit = units[char];
      if (unit === 10000n) {
        if (total || (!section && !digit)) return null;
        total = (section + digit) * unit;
        section = 0n;
        last = 10000n;
      } else {
        if (unit >= last || (!digit && !(char === "十" && !section)))
          return null;
        section += (digit || 1n) * unit;
        last = unit;
      }
      digit = 0n;
    }
  }
  // 一百五 is colloquially ambiguous between 105 and 150.
  if (digit && last > 10n && !normalized.includes("零")) return null;
  return String(total + section + digit);
}
