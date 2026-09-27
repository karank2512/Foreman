/** Small pure string helpers shared by search, pages, extraction and the mock brain. */

const STOPWORDS = new Set(
  (
    "a an and are as at be been but by can could do does for from had has have how i if in into is it its " +
    "just me my no not of on or our out over per so some such than that the their them then there these they " +
    "this those to too up us was we were what when where which who why will with would you your about across " +
    "after all also any each every more most other should via"
  ).split(" "),
);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter(Boolean);
}

/** Deliberately tiny stemmer: enough to make "databases" match "database" and "companies" match "company". */
export function stem(token: string): string {
  if (token === "series") return token;
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  // "analysis", "status", "business" are not plurals.
  if (token.length > 3 && token.endsWith("s") && !/(ss|is|us)$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Lower-cased, stemmed, de-duplicated content words. */
export function keywords(s: string, extraStopwords?: ReadonlySet<string>): string[] {
  const seen = new Set<string>();
  for (const raw of tokenize(s)) {
    if (STOPWORDS.has(raw)) continue;
    const t = stem(raw);
    if (t.length < 2 || STOPWORDS.has(t) || extraStopwords?.has(t) || extraStopwords?.has(raw)) continue;
    seen.add(t);
  }
  return [...seen];
}

/** Field names arrive in whatever style the spec author used; compare them as snake_case. */
export function normalizeKey(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function clip(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

export function titleCase(s: string): string {
  return s
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join(" ");
}

export function sentenceCase(s: string): string {
  const t = s.trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}

/** 85_000_000 → "$85M" · 7_500_000 → "$7.5M" · 1_200_000_000 → "$1.2B" · 950_000 → "$950K". */
export function formatUsdShort(amount: number): string {
  const abs = Math.abs(amount);
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, ""));
  if (abs >= 1e9) return `$${fmt(Math.round(amount / 1e8) / 10)}B`;
  if (abs >= 1e6) return `$${fmt(Math.round(amount / 1e5) / 10)}M`;
  if (abs >= 1e3) return `$${fmt(Math.round(amount / 1e2) / 10)}K`;
  return `$${fmt(Math.round(amount * 100) / 100)}`;
}

/** "42%" — whole-number share; 0 when the denominator is 0 (never NaN). */
export function pct(part: number, whole: number): string {
  return `${whole > 0 ? Math.round((part / whole) * 100) : 0}%`;
}

// A Map, not an object literal: a noun like "constructor" must not hit Object.prototype.
const IRREGULAR_PLURALS: ReadonlyMap<string, string> = new Map([
  ["person", "people"],
  ["child", "children"],
  ["criterion", "criteria"],
  ["phenomenon", "phenomena"],
  ["axis", "axes"],
  ["quiz", "quizzes"],
]);
/** Mass nouns never take an s: "research", not "researchs". */
const UNCOUNTABLE = new Set(["feedback", "data", "metadata", "information", "research", "news", "software", "equipment", "series", "species"]);

/**
 * English plural of a record noun, inflecting only the last word ("feedback item" → "feedback items"):
 * company → companies, analysis → analyses, address → addresses, day → days, API → APIs.
 */
export function pluralNoun(one: string): string {
  const match = /^(.*?)([A-Za-z]+)$/.exec(one);
  if (!match) return `${one}s`;
  const [, head, word] = match;
  const lower = word.toLowerCase();
  const irregular = IRREGULAR_PLURALS.get(lower);
  let many: string;
  if (UNCOUNTABLE.has(lower)) many = word;
  else if (word.length > 1 && word === word.toUpperCase()) many = `${word}s`;
  else if (irregular) many = word[0] + irregular.slice(1);
  else if (/sis$/i.test(word)) many = `${word.slice(0, -2)}es`;
  else if (/[^aeiou]y$/i.test(word)) many = `${word.slice(0, -1)}ies`;
  else if (/(s|x|z|ch|sh)$/i.test(word)) many = `${word}es`;
  else many = `${word}s`;
  return head + many;
}

export function plural(n: number, one: string, many = pluralNoun(one)): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** "A", "A and B", "A, B and C". */
export function joinList(items: string[]): string {
  if (items.length <= 1) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}
