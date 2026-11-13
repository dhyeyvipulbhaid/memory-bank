export const ENTITY_TYPES = ["person", "org", "place", "product", "concept", "other"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

export const FACT_KINDS = ["world", "experience"] as const;
export type FactKind = (typeof FACT_KINDS)[number];

export interface EntityRef {
  id: string;
  name: string;
  type: EntityType;
}

export interface ExtractedEntity {
  name: string;
  type: EntityType;
}

export interface ExtractedFact {
  text: string;
  kind: FactKind;
  occurrenceTime: string | null;
  entities: ExtractedEntity[];
}

export interface ExtractInput {
  content: string;
  context?: string;
  speaker?: string;
  mentionedAt?: string;
}

export interface Extractor {
  extract(input: ExtractInput): Promise<ExtractedFact[]> | ExtractedFact[];
}

/** Turns text into a vector. `model` is stored next to every vector it writes. */
export interface Embedder {
  readonly model: string;
  embed(text: string): Promise<readonly number[]> | readonly number[];
}

/** One stored vector handed to a ranker. Swap the ranker later without changing callers. */
export interface VectorPoint {
  id: string;
  vector: Float32Array;
}

export interface VectorHit {
  id: string;
  score: number;
}

export interface VectorRanker {
  rank(query: Float32Array, points: readonly VectorPoint[]): VectorHit[];
}

export interface OpenBankOptions {
  /** Rows are scoped to this id. Two ids in one file cannot see each other. */
  bankId?: string;
  /** Required for retain. remember and recall work without it. */
  extractor?: Extractor;
  /**
   * When set, retain and remember store a vector for each new fact.
   * A failure here does not block the write. Pass null to skip embedding.
   */
  embedder?: Embedder | null;
  /** Defaults to brute-force cosine. Replace this to swap the ranking strategy. */
  vectorRanker?: VectorRanker;
}

export interface RetainInput {
  content: string;
  context?: string;
  mentionedAt?: string | Date;
  speaker?: string;
}

export interface RememberInput {
  text: string;
  kind?: FactKind;
  entities?: Array<{ name: string; type?: EntityType }>;
  occurrenceTime?: string | Date | null;
  mentionedAt?: string | Date;
}

export interface FactRecord {
  id: string;
  text: string;
  kind: FactKind;
  occurrenceTime: string | null;
  mentionedAt: string;
  sourceId: string;
  entities: EntityRef[];
}

export interface RetainResult {
  sourceId: string;
  facts: FactRecord[];
}

export interface RecallInput {
  query: string;
  tokenBudget: number;
}

export interface RecalledFact extends FactRecord {
  score: number;
}

export interface RecallResult {
  facts: RecalledFact[];
  /** Sum of estimateTokens(fact.text) for the facts returned. */
  tokensUsed: number;
}

export interface SemanticSearchInput {
  query: string;
  tokenBudget: number;
  /** Maximum number of facts to return. Defaults to 10. */
  limit?: number;
}

export interface BackfillResult {
  /** Facts that gained a vector during this call. */
  embedded: number;
  /** Facts in this bank that still have no vector. */
  remaining: number;
}
