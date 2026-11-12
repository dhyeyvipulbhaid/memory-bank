/** Compare names without case, punctuation, or extra spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function displayName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim();
}

export function nameTokens(name: string): string[] {
  const normalized = normalizeName(name);
  return normalized ? normalized.split(" ") : [];
}

export function levenshtein(left: string, right: string): number {
  if (left === right) return 0;
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;

  const row = new Array<number>(right.length + 1);
  for (let column = 0; column <= right.length; column++) row[column] = column;

  for (let i = 1; i <= left.length; i++) {
    let previous = i - 1;
    row[0] = i;
    for (let j = 1; j <= right.length; j++) {
      const current = row[j] ?? 0;
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const insert = current + 1;
      const remove = (row[j - 1] ?? 0) + 1;
      const replace = previous + cost;
      row[j] = Math.min(insert, remove, replace);
      previous = current;
    }
  }
  return row[right.length] ?? 0;
}

export type NameMatch = "exact" | "typo" | "weak";

/**
 * exact: same normalized name.
 * typo: one long token differs by a single edit. Short surnames are not typos.
 * weak: a single given name lines up with the start of a longer name, or a
 * longer name extends a shorter one. Weak matches need a unique candidate
 * or co-occurrence before they merge.
 */
export function matchStrength(mention: string, target: string): NameMatch | null {
  const left = normalizeName(mention);
  const right = normalizeName(target);
  if (!left || !right) return null;
  if (left === right) return "exact";

  const leftTokens = left.split(" ");
  const rightTokens = right.split(" ");

  if (leftTokens.length === rightTokens.length && leftTokens.length >= 2) {
    let differences = 0;
    let distance = 0;
    let longest = 0;
    for (let i = 0; i < leftTokens.length; i++) {
      const a = leftTokens[i] ?? "";
      const b = rightTokens[i] ?? "";
      if (a === b) continue;
      differences += 1;
      distance = levenshtein(a, b);
      longest = Math.max(a.length, b.length);
      if (differences > 1) return null;
    }
    if (differences === 1 && distance === 1 && longest >= 6) return "typo";
    return null;
  }

  if (isLeadingName(leftTokens, rightTokens) || isLeadingName(rightTokens, leftTokens)) {
    return "weak";
  }
  return null;
}

function isLeadingName(shorter: string[], longer: string[]): boolean {
  if (shorter.length === 0 || shorter.length >= longer.length) return false;
  return shorter.every((token, index) => longer[index] === token);
}
