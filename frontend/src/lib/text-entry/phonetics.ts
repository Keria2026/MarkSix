import { pinyin } from "pinyin-pro";

// Per-character readings keep domain terms independent of surrounding prose.
export function phoneticKey(text: string): string {
  return [...text.normalize("NFKC")]
    .map((char) =>
      /\p{Script=Han}/u.test(char)
        ? pinyin(char, { toneType: "none", traditional: true })
        : char,
    )
    .join("|");
}
