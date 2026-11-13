/**
 * True when retain() should drop a fact. That is an assistant, model, or
 * first-person claim about lacking knowledge, being unable to answer, or a
 * just-now chat or browser action. remember() does not call this.
 *
 * A sentence about someone else stays, including "Maya prefers morning
 * meetings" and "Maya visited Wikipedia yesterday". A first-person preference
 * or dated experience stays too. A fact that mixes a disclaimer with any
 * other sentence stays.
 */
export function isAssistantKnowledgeGap(text: string): boolean {
  const sentences = sentencesOf(normalize(text));
  if (sentences.length === 0) return false;
  return sentences.every(
    (sentence) => isGapSentence(sentence) || isJustNowSessionNarration(sentence),
  );
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

function assistantPredicate(sentence: string): string | null {
  const rest = sentence.replace(LEAD, "").trim();
  const subject = rest.match(SELF);
  if (!subject) return null;
  const predicate = rest
    .slice(subject[0].length)
    .trim()
    .replace(
      /^(?:really |actually |currently |still |just |simply |honestly |then |also |only )+/,
      "",
    )
    .trim();
  if (predicate === "") return null;
  if (
    predicate.includes(";") ||
    /\b(?:but|however|although|though|except|whereas)\b/.test(predicate)
  ) {
    return null;
  }
  return predicate;
}

function isGapSentence(sentence: string): boolean {
  const predicate = assistantPredicate(sentence);
  if (predicate == null) return false;
  return isGapPredicate(predicate);
}

/** A dated or relative occurrence is a world event, not this chat's tool use. */
function namesPastEvent(predicate: string): boolean {
  const month =
    "(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  return (
    /\b(?:yesterday|tomorrow|tonight)\b/.test(predicate) ||
    /\b(?:last|next|this past)\s+(?:week|month|year|night|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(
      predicate,
    ) ||
    /\bago\b/.test(predicate) ||
    /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/.test(predicate) ||
    new RegExp(`\\bin\\s+${month}\\b`).test(predicate) ||
    new RegExp(`\\b${month}\\s+\\d{1,2}\\b`).test(predicate) ||
    /\b\d{4}-\d{2}-\d{2}\b/.test(predicate) ||
    /\b(?:19|20)\d{2}\b/.test(predicate) ||
    /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/.test(predicate)
  );
}

function isJustNowSessionNarration(sentence: string): boolean {
  const predicate = assistantPredicate(sentence);
  if (predicate == null) return false;
  if (namesPastEvent(predicate)) return false;
  return isSessionPredicate(predicate);
}

const SESSION_PREFIX =
  "(?:(?:has |have |had |is |was |were |am |did |does |do )?(?:tried to |attempted to |proceeded to )?)";

const SESSION_TARGET =
  "\\b(?:pages?|tabs?|links?|urls?|browsers?|websites?|wikipedia|wiki|search(?:es|ed|ing)?|articles?|results?|queries|query|prompts?|dialogs?|pop-?ups?|visits?|buttons?|google)\\b";

function isSessionPredicate(predicate: string): boolean {
  if (new RegExp(`^${SESSION_PREFIX}re-?direct(?:s|ed|ing)?\\b`).test(predicate)) return true;
  if (
    new RegExp(
      `^${SESSION_PREFIX}(?:look(?:s|ed|ing)? up|look(?:s|ed|ing)?\\s+\\S+\\s+up|search(?:es|ed|ing)?|googled)\\b`,
    ).test(predicate)
  ) {
    return true;
  }
  if (
    new RegExp(
      `^${SESSION_PREFIX}(?:click(?:s|ed|ing)?|tap(?:s|ped|ping)?|press(?:es|ed|ing)?|typed|typing|types)\\b`,
    ).test(predicate)
  ) {
    return true;
  }
  const aimed =
    new RegExp(`^${SESSION_PREFIX}(?:open(?:s|ed|ing)?|visit(?:s|ed|ing)?|navigat(?:e|es|ed|ing)|brows(?:e|es|ed|ing)|load(?:s|ed|ing)?|went to|go(?:es)? to)\\b`).test(
      predicate,
    ) ||
    new RegExp(
      `^${SESSION_PREFIX}(?:approv(?:e|es|ed|ing)|den(?:y|ies|ied|ying)|stop(?:s|ped|ping)?|refus(?:e|es|ed|ing)|declin(?:e|es|ed|ing)|cancels?|cancelled|canceled|canceling|cancelling|block(?:s|ed|ing)?)\\b`,
    ).test(predicate);
  return aimed && new RegExp(SESSION_TARGET).test(predicate);
}

function isGapPredicate(predicate: string): boolean {
  if (isUnsure(predicate) || isUnfamiliar(predicate) || isInability(predicate)) return true;
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

const INFORM_VERB =
  "(?:find|locate|access|provide|give|offer|retrieve|share|answer|disclose|tell|reveal|discuss|say|talk)";
const INFO_WORD = "\\b(?:information|info|knowledge|details|data|answers?|questions?)\\b";
const RESTRICTION =
  "\\bdue to (?:a |the )?(?:restrictions?|polic(?:y|ies)|guidelines|safety)\\b";

function isInability(predicate: string): boolean {
  const aboutInfo = new RegExp(INFO_WORD).test(predicate);
  const restricted = new RegExp(RESTRICTION).test(predicate);
  const informVerb = new RegExp(`\\b${INFORM_VERB}\\b`).test(predicate);
  if (
    new RegExp(`^(?:am |is |was |were )?(?:unable|not able) to ${INFORM_VERB}\\b`).test(predicate) &&
    (aboutInfo || restricted)
  ) {
    return true;
  }
  if (
    new RegExp(`^(?:cannot|could not|will not) ${INFORM_VERB}\\b`).test(predicate) &&
    (aboutInfo || restricted)
  ) {
    return true;
  }
  if (
    /^(?:am |is |was |were )?not (?:allowed|permitted)\b/.test(predicate) &&
    (aboutInfo || (restricted && informVerb))
  ) {
    return true;
  }
  if (
    /^(?:am |is |was |were |has been |have been )?denied\b/.test(predicate) &&
    (aboutInfo || /\b(?:access|permission|restrictions?)\b/.test(predicate))
  ) {
    return true;
  }
  return (
    restricted &&
    /\b(?:unable|not able|cannot|could not|will not|not allowed|not permitted|denied|restricted)\b/.test(
      predicate,
    ) &&
    (aboutInfo || informVerb)
  );
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
