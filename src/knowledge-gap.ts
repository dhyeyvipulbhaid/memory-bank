/**
 * True when a fact only says the assistant, the model, or "I" lacks knowledge.
 * retain() drops these. remember() does not call this.
 */
export function isAssistantKnowledgeGap(text: string): boolean {
  const sentences = sentencesOf(normalize(text));
  if (sentences.length === 0) return false;
  return sentences.every(isGapSentence);
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u0060]/g, "'")
    .replace(/\bcan't\b/g, "cannot")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\b(do|does|is|are|was|were|have|has|did|would|could|should)n't\b/g, "$1 not")
    .replace(/\bi'm\b/g, "i am")
    .replace(/\s+/g, " ")
    .trim();
}

function sentencesOf(text: string): string[] {
  return text
    .split(/[.!?]+/)
    .map((part) => part.replace(/^["']+|["']+$/g, "").trim())
    .filter((part) => part.length > 0);
}

const LEAD =
  /^(?:(?:unfortunately|sorry|actually|currently|well|right now|at this time|as of now|note that|please note|based on (?:the |this )?(?:conversation|chat|context)|from (?:the |this )?(?:conversation|chat)|in this (?:conversation|chat)|as an ai|as a language model|as an assistant|as the assistant|as the model)[,:]?\s+)+/;

const SELF =
  /^(?:the language model|this language model|the assistant|this assistant|an assistant|the model|this model|the ai|this ai|an ai|assistant|model|i am|i)\b[:,]?\s+/;

const HEDGE = "(?:really |actually |currently |yet |still )?";
const ADJECTIVE =
  "(?:specific|any|some|much|enough|further|more|additional|particular|relevant|real|available|prior|previous|stored|recorded|personal|detailed|concrete|direct|useful|reliable|special|the|a|an)";
const NOUN = "(?:information|info|knowledge|details|data|records?|idea|clue)";
const KNOWLEDGE = `(?:${ADJECTIVE}\\s+)*${NOUN}`;

function isGapSentence(sentence: string): boolean {
  const rest = sentence.replace(LEAD, "").trim();
  const subject = rest.match(SELF);
  if (!subject) return false;
  const predicate = rest
    .slice(subject[0].length)
    .trim()
    .replace(/^(?:really |actually |currently |still |just |simply |honestly )+/, "")
    .trim();
  if (predicate === "") return false;
  if (
    predicate.includes(";") ||
    /\b(?:but|however|although|though|except|whereas)\b/.test(predicate)
  ) {
    return false;
  }
  return isGapPredicate(predicate);
}

function isGapPredicate(predicate: string): boolean {
  if (isUnsure(predicate) || isUnfamiliar(predicate)) return true;
  const patterns = [
    new RegExp(`^(?:do|does) not ${HEDGE}(?:know|recognize)\\b`),
    new RegExp(`^(?:cannot|could not) ${HEDGE}(?:recall|recognize|identify)\\b`),
    new RegExp(`^(?:do|does) not ${HEDGE}have\\s+${KNOWLEDGE}\\b`),
    new RegExp(`^(?:have|has) no\\s+${KNOWLEDGE}\\b`),
    /^(?:have|has) never heard of\b/,
    /^never heard of\b/,
    new RegExp(`^lacks?\\s+${KNOWLEDGE}\\b`),
    new RegExp(
      `^(?:cannot|could not) (?:find|locate|access|provide|give|offer|retrieve)\\s+(?:you |me )?(?:any |specific |much |enough )?${KNOWLEDGE}\\b`,
    ),
  ];
  return patterns.some((pattern) => pattern.test(predicate));
}

function isUnsure(predicate: string): boolean {
  const sure = predicate.match(
    new RegExp(`^(?:am not|is not|not) ${HEDGE}(?:sure|certain)\\b\\s*(.*)$`),
  );
  if (sure) return identityTail(sure[1] ?? "");
  const unsure = predicate.match(/^(?:am |is )?unsure\b\s*(.*)$/);
  if (!unsure) return false;
  return identityTail(unsure[1] ?? "");
}

function isUnfamiliar(predicate: string): boolean {
  return (
    /^(?:am not|is not|not) familiar\b/.test(predicate) ||
    /^(?:am not|is not|not) aware\b/.test(predicate) ||
    /^(?:am|is) (?:unfamiliar|unaware)\b/.test(predicate) ||
    /^(?:unfamiliar|unaware)\b/.test(predicate)
  );
}

function identityTail(tail: string): boolean {
  const rest = tail.trim();
  if (rest === "") return true;
  return (
    /^(?:who|what|which|whom)\b/.test(rest) ||
    /^about (?:that|this|it|them|him|her|who|anyone|anybody|someone|somebody|a person|any person)\b/.test(
      rest,
    ) ||
    /^of (?:that|this|it|who|anyone|anybody|someone|somebody|a person|any person)\b/.test(rest) ||
    /^(?:if|whether) (?:that|this|it|who)\b/.test(rest)
  );
}
