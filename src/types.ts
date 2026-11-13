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

export interface RerankFact {
  id: string;
  text: string;
}

export interface RerankInput {
  query: string;
  facts: readonly RerankFact[];
}

/** Optional second pass. hybridRecall calls it only when llmRerank is set. */
export interface Reranker {
  rerank(input: RerankInput): Promise<readonly string[]> | readonly string[];
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
  /** Used by hybridRecall when llmRerank is true. Defaults to a local Ollama chat model. */
  reranker?: Reranker | null;
  /** Used by reflect. Defaults to a local Ollama chat model. */
  reflector?: Reflector | null;
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

export interface HybridWeights {
  keyword?: number;
  vector?: number;
  graph?: number;
}

/** Reciprocal-rank contributions plus the recency multiplier. They explain `score`. */
export interface ScoreBreakdown {
  keyword: number;
  vector: number;
  graph: number;
  recency: number;
}

export interface HybridFact extends Omit<FactRecord, "kind"> {
  kind: FactKind | "observation";
  /** True when this row was synthesized by reflect rather than retained or remembered. */
  derived: boolean;
  /** Fact ids an observation was derived from. */
  sourceFactIds?: string[];
  confidence?: number;
  /** (keyword + vector + graph [+ a small in-window prior]) * recency. */
  score: number;
  breakdown: ScoreBreakdown;
}

export interface HybridRecallInput {
  query: string;
  tokenBudget: number;
  /** Stop after this many facts that fit the budget. Omit to use the budget alone. */
  limit?: number;
  /** Reciprocal rank fusion weights. Each defaults to 1. */
  weights?: HybridWeights;
  /** RRF constant added to each rank. Defaults to 60. */
  rrfK?: number;
  /** Recency halves once per this many days. Defaults to 30. */
  halfLifeDays?: number;
  /** Clock for recency and time cues. Defaults to now. */
  now?: string | Date;
  /** Ask the reranker to reorder fused facts. Off by default. A failure keeps fusion order. */
  llmRerank?: boolean;
  /** Include reflect observations. Defaults to true. */
  includeObservations?: boolean;
}

export interface ObservationDraft {
  text: string;
  confidence: number;
  sourceFactIds: string[];
}

export interface ReflectFact {
  id: string;
  text: string;
  kind: string;
  mentionedAt: string;
}

export interface ReflectRequest {
  topic?: string;
  facts: ReflectFact[];
}

export interface Reflector {
  reflect(input: ReflectRequest): Promise<ObservationDraft[]> | ObservationDraft[];
}

export interface ReflectInput {
  query?: string;
  /** Entity name used to gather facts and to scope the run. */
  entity?: string;
  topic?: string;
  since?: string | Date;
  until?: string | Date;
  /** Maximum observations stored from one run. Defaults to 5. */
  maxObservations?: number;
  now?: string | Date;
}

export interface ObservationRecord {
  id: string;
  text: string;
  confidence: number;
  derived: true;
  sourceFactIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface ReflectResult {
  observations: ObservationRecord[];
  /** Previous observations in this scope that were replaced. */
  removedIds: string[];
}

export interface SweepJunkInput {
  /** Defaults to true. Deletion happens only when this is false. */
  dryRun?: boolean;
}

export interface SweepCandidate {
  id: string;
  text: string;
  reason: string;
}

export interface SweepJunkResult {
  dryRun: boolean;
  candidates: SweepCandidate[];
  deleted: number;
  removedObservationIds: string[];
  removedEntityIds: string[];
}

export interface ListFactsInput {
  kind?: FactKind;
  /** Canonical name or alias. */
  entity?: string;
  query?: string;
  limit: number;
  offset?: number;
}

export interface ListFactsResult {
  facts: FactRecord[];
  total: number;
}

export interface UpdateFactResult {
  fact: FactRecord;
  /** True when the new text matched another fact and this row was folded into it. */
  mergedIntoExisting: boolean;
}

export interface ForgetManyResult {
  removedFactIds: string[];
  removedObservationIds: string[];
  removedEntityIds: string[];
}

export interface HybridRecallResult {
  facts: HybridFact[];
  /** Sum of estimateTokens(fact.text) for the facts returned. */
  tokensUsed: number;
}
