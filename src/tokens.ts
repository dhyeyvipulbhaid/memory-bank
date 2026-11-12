const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "if",
  "then",
  "of",
  "to",
  "in",
  "on",
  "for",
  "with",
  "at",
  "from",
  "by",
  "as",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "it",
  "this",
  "that",
  "these",
  "those",
  "i",
  "you",
  "we",
  "they",
  "he",
  "she",
  "them",
  "his",
  "her",
  "their",
  "my",
  "your",
  "our",
  "not",
  "no",
  "do",
  "did",
  "does",
  "about",
  "into",
  "over",
  "after",
  "before",
  "what",
  "when",
  "where",
  "who",
  "whom",
  "which",
  "how",
  "why",
]);

/** Rough token count used by recall. About four characters per token. */
export function estimateTokens(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return Math.ceil(trimmed.length / 4);
}

export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 0);
}

export function meaningfulTokens(text: string): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const token of tokenize(text)) {
    if (token.length < 2 || STOPWORDS.has(token) || seen.has(token)) continue;
    seen.add(token);
    tokens.push(token);
  }
  return tokens;
}
