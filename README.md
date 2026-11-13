# memory-bank

Local knowledge-graph memory for an AI agent.

After a chat, a local model pulls a few narrative facts out of the text and stores them in SQLite. A later run asks for what is relevant and gets back only the facts that fit a token budget. The file on disk can get large. The model context sees a slice of it.

You can also save a fact by hand. That goes into the same graph and does not call a model.

This is a library and a small command-line tool. A host app can import it later. There is no UI in this package.

Memory stays on the machine. In v1 the SQLite file is **not encrypted**. Anyone who can read the file can read the memory.

`retain` calls Ollama to extract facts. If that call fails, or the reply is not usable JSON, `retain` throws and does not write a partial result. `remember` and `recall` do not extract, and they work with Ollama stopped. When you pass an embedder, `retain` and `remember` also ask Ollama for a vector. If that call fails, the fact is still saved and the vector stays null. `recall` never calls the network.

## Requirements

[Bun](https://bun.sh) 1.1 or newer. Runtime dependencies: none. SQLite comes from `bun:sqlite`.

## Tests

```bash
bun install
bun test
```

Tests do not need Ollama. They use a scripted extractor.

`bun run typecheck` runs `tsc --noEmit`.

## Library

```ts
import {
  openBank,
  createOllamaExtractor,
  createFakeExtractor,
  estimateTokens,
} from "memory-bank";
```

```ts
const bank = openBank("/path/to/memory.sqlite", {
  bankId: "personal",
  extractor: createOllamaExtractor({ model: "qwen3:8b" }),
});

const saved = await bank.retain({
  content: transcript,
  context: "planning chat",
  speaker: "user",
  mentionedAt: new Date().toISOString(),
});

const manual = await bank.remember({
  text: "Maya's dog is named Pepper.",
  kind: "world",
  entities: [
    { name: "Maya", type: "person" },
    { name: "Pepper", type: "other" },
  ],
});

const memory = await bank.recall({
  query: userMessage,
  tokenBudget: 800,
});
// memory.facts is the slice to put in the next prompt.

bank.close();
```

### `openBank(path, options?)`

Opens or creates one SQLite file and returns a `MemoryBank`.

- `options.bankId` defaults to `"default"`. Every row is stored with that id, and every read filters on it. Two bank ids in one file cannot see each other's facts or entities. Two files are separate as well.
- `options.extractor` is required for `retain`. `remember` and `recall` work without one.
- Opening a file merges leftover facts that match under the same normalization in the same `bank_id`. The oldest row is kept, its mentions stay, mentions from the copies are moved onto it, and the extra fact rows are deleted. A stored occurrence time is kept. If the oldest row has none and a copy has one, that time is copied over. Sources are left in place. Another bank id in the file is not merged into this one.

### `retain({ content, context?, mentionedAt?, speaker? })`

Sends the text to the extractor, then stores the original text as a source document (split into chunks when it is long) plus up to five facts.

Each fact is `world` (about other people or things) or `experience` (the agent's own action, written in first person by the extractor). `mentionedAt` is when the text was said. It defaults to now. `occurrenceTime` is when the event actually happened, and only when the source text names that occurrence. Preferences, standing facts, and undated statements leave it null. A missing occurrence is never filled with the current clock or with `mentionedAt`.

A fact that only says the assistant, the model, or "I" lacks knowledge, cannot answer, or just did something in this chat or browser is dropped before it is saved. "The assistant does not have specific information about a person named Pepper" is not stored. Neither is "The assistant redirected the user to a search page for Pepper" or "The assistant is unable to provide information about Pepper due to restrictions." A negative fact about someone else still is, including "Maya does not have a preference for morning meetings" and "Maya visited Wikipedia yesterday." A first-person preference or dated experience, such as "I don't like morning meetings" or "I visited Wikipedia yesterday," is kept. Rows already in the file are left as they are. `remember` does not use this filter.

Returns `{ sourceId, facts }`.

If this bank already has a fact with the same text, after trimming, collapsing whitespace, and ignoring case, that row is reused. The id, wording, kind, mentioned time, and source id stay as they were. Entity mentions from the new write are still resolved and attached. A null `occurrenceTime` can be filled when the new write has one. A stored `occurrenceTime` is left unchanged, including when the new write has null. The later chat is still saved as its own source. The same text in another bank id is a different fact. A different sentence that only shares a word or an entity is also a different fact.

### `remember({ text, kind?, entities?, occurrenceTime?, mentionedAt? })`

Saves one fact directly. `kind` defaults to `"world"`. Entity `type` defaults to `"other"`. No model is called. Repeating the same text, aside from case and whitespace, reuses the existing fact in this bank instead of inserting another row. The original mentioned time is kept. The later write is still stored as a source.

Names are resolved against the bank:

- same name, ignoring case and punctuation
- a stored alias
- one long token off by a single character (`Katherine` / `Kathrine`)
- a shorter name that starts a longer one (`Alice` / `Alice Chen`)

A shared first name is not enough to merge two people. `Alice Chen` and `Alice Wong` stay two entities. A later mention of `Alice` is attached to one of them only when another entity in that same save already shares a fact with exactly one candidate. Otherwise `Alice` is stored as its own entity.

The more specific name becomes the canonical name. The shorter form is kept as an alias.

### `recall({ query, tokenBudget })`

Finds facts by entity name and by keyword overlap, ranks them, and returns the ones that fit `tokenBudget`. Facts that score nothing are left out, so a blank or stopword query does not return the whole graph. Source documents are not returned.

`tokenBudget` is measured with `estimateTokens`, which is `ceil(characters / 4)` of the fact text. `tokensUsed` is the sum of that cost for the facts returned. A fact that does not fit in the remaining budget is skipped.

### Semantic search

`recall` matches names and keywords. A paraphrase that shares no words with the fact is invisible to it. `semanticSearch` embeds the query and ranks facts by cosine similarity, then keeps the top results that fit `tokenBudget`.

Pull the embed model once:

```bash
ollama pull nomic-embed-text
```

Pass an embedder when you open the bank. `model` defaults to `nomic-embed-text`. `host` is the Ollama base URL and defaults to `http://127.0.0.1:11434`.

```ts
import { createOllamaEmbedder, createOllamaExtractor, openBank } from "memory-bank";

const bank = openBank("./memory.sqlite", {
  extractor: createOllamaExtractor({ model: "qwen3:8b" }),
  embedder: createOllamaEmbedder({
    model: "nomic-embed-text",
    host: "http://127.0.0.1:11434",
  }),
});
```

Each new fact stores a little-endian float32 blob, the model name, and the dimension. Facts written with no embedder, or while Ollama was down, have a null vector. Keyword `recall` still finds them.

`backfillEmbeddings` fills those nulls and skips rows that already have a vector. It commits each fact before the next one. If it stops, run it again and it continues. It does not replace a vector that is already stored, including one from a different model. Search only compares vectors saved for the embedder's model and dimension.

```ts
const filled = await bank.backfillEmbeddings();
// filled.embedded, filled.remaining

const memory = await bank.semanticSearch({
  query: "where does the dog play",
  tokenBudget: 800,
  limit: 10,
});
```

`limit` defaults to 10. Ranking is brute-force cosine behind a `VectorRanker`. Pass `vectorRanker` to `openBank` to swap that later.

From the command line, `remember` and `retain` embed unless you pass `--no-embed`. `--embed-model` and `--host` override the defaults. Backfill:

```bash
bun src/cli.ts backfill --db ./memory.sqlite
bun src/cli.ts backfill --db ./memory.sqlite --embed-model nomic-embed-text --host http://127.0.0.1:11434
```

The suite does not need Ollama. To check a real local server:

```bash
MEMORY_BANK_OLLAMA_TEST=1 bun test test/ollama-embed.integration.test.ts
```

### Hybrid recall

Personal-Agents should call `hybridRecall` for the slice that goes into the next prompt. `recall` stays the keyword and entity lookup. It does not use vectors, neighbors, or time.

`hybridRecall` builds three lists and fuses them with reciprocal rank fusion (`1 / (60 + rank)`, weights default to 1). The lists are keyword overlap, cosine similarity, and the entity graph. The graph list is a direct entity or alias match, plus facts that mention an entity one hop away (they share a fact with a matched entity). A missing embedder, or an embedder that throws, drops the vector list and the other two still run.

Recency multiplies the fused score. It halves every `halfLifeDays` (default 30), using `occurrenceTime` when the fact has one and `mentionedAt` otherwise. Pass `now` in tests. A time cue in the query (`yesterday`, `last week`, `in March`, `2024-05-02`) keeps facts inside that UTC window and drops the rest. Weeks start on Monday. Facts inside the window with no other signal still surface, behind any real hit.

Each fact includes `breakdown` with `keyword`, `vector`, `graph`, and `recency`. `score` is `(keyword + vector + graph) * recency`, plus a small prior when the fact sits in a parsed window. `llmRerank: true` asks Ollama to reorder that list. It is off by default. If the rerank call fails, fusion order is kept. `weights` changes the fusion.

```ts
const memory = await bank.hybridRecall({
  query: "what did I do last week",
  tokenBudget: 800,
  halfLifeDays: 30,
});
// memory.facts[0].breakdown
```

```bash
bun src/cli.ts hybrid --db ./memory.sqlite --query "what did I do last week" --token-budget 800
bun test test/hybrid.test.ts test/time-window.test.ts
MEMORY_BANK_OLLAMA_TEST=1 bun test test/ollama-embed.integration.test.ts
```

### Reflect

`reflect` reads facts in a scope and asks Ollama for a few observations. Each one cites the fact ids it came from. They are stored apart from world and experience facts, with a confidence and an embedding when the embedder is up. `hybridRecall` returns them with `derived: true` unless you pass `includeObservations: false`. `recall` does not return them.

The scope is the query, entity, topic, and time bounds. Running `reflect` again on that same scope updates an observation whose text is unchanged and deletes observations the model no longer returns. `forget(factId)` removes that fact. An observation that cited only the forgotten fact is removed. One that still cites another fact stays.

Gathering keeps facts that score at least half as high as the best match, so an off-topic fact is not sent to the model. A draft is dropped when it cites a fact outside that set, cites only one fact while several were gathered, hedges (`suggesting`, `indicating`), or comments on the notes (`separate from`, `mentioned in the context of`). Near-duplicate wording is collapsed and the higher confidence is kept. The same junk filter as `retain` still applies. If none remain, nothing is written. The default cap is 5. If Ollama is down, `reflect` throws and writes nothing.

The default chat model is `qwen3:8b`. `host` is the Ollama base URL. The HTTP timeout defaults to 120 seconds (`timeoutMs`, or `--timeout-ms` on the CLI) so a cold model load can finish. The live test allows the same 120 seconds.

```ts
const reflected = await bank.reflect({
  query: "Maya meetings",
  maxObservations: 5,
});
// reflected.observations[0].sourceFactIds
```

```bash
ollama pull qwen3:8b
bun src/cli.ts reflect --db ./memory.sqlite --query "Maya meetings" --model qwen3:8b
bun test test/reflect.test.ts
MEMORY_BANK_OLLAMA_TEST=1 bun test test/ollama-reflect.integration.test.ts
```

### Extractors

```ts
interface Extractor {
  extract(input: {
    content: string;
    context?: string;
    speaker?: string;
    mentionedAt?: string;
  }): Promise<ExtractedFact[]> | ExtractedFact[];
}

interface ExtractedFact {
  text: string;
  kind: "world" | "experience";
  occurrenceTime: string | null;
  entities: Array<{ name: string; type: EntityType }>;
}
```

`EntityType` is `person | org | place | product | concept | other`.

`createOllamaExtractor({ model?, host?, timeoutMs? })` posts to `{host}/api/chat`. The default model is `qwen3:8b` and the default host is `http://127.0.0.1:11434`. The request sets `think: false` and `format: "json"`. `<think>` blocks are stripped from the message content. A `thinking` field on the response is ignored.

`createFakeExtractor(script)` returns whatever the function returns. Use it in tests.

`ExtractorUnavailableError` means the server could not be reached or returned an HTTP error. `ExtractionFailedError` means the body was not a JSON object with a `facts` array of valid facts. Both leave the bank unchanged.

## CLI

```bash
bun src/cli.ts remember \
  --db ./memory.sqlite \
  --text "Maya prefers morning meetings." \
  --entities "Maya:person" \
  --kind world

bun src/cli.ts recall \
  --db ./memory.sqlite \
  --query "Maya meetings" \
  --token-budget 200

bun src/cli.ts hybrid \
  --db ./memory.sqlite \
  --query "what did I do last week" \
  --token-budget 800

bun src/cli.ts reflect \
  --db ./memory.sqlite \
  --query "Maya meetings" \
  --model qwen3:8b

bun src/cli.ts retain \
  --db ./memory.sqlite \
  --content "Yesterday Maya said the launch moved to June." \
  --speaker user

bun src/cli.ts backfill \
  --db ./memory.sqlite \
  --embed-model nomic-embed-text \
  --host http://127.0.0.1:11434
```

`retain` needs Ollama for extraction. `--model`, `--host`, and `--timeout-ms` override the defaults. `--embed-model` chooses the embedding model (default `nomic-embed-text`). `--no-embed` skips that call. `--bank` selects a bank id inside the file. Results are JSON on stdout. Errors go to stderr and the process exits 1.

Entity flags look like `Alice Chen:person,Orbit:product`.

## Schema

One SQLite file. Isolation column on every table: `bank_id`.

| Table | What it holds |
| --- | --- |
| `sources` | Original text, optional context and speaker, `mentioned_at` |
| `source_chunks` | The same text split up when it is long. The full text stays on `sources`. |
| `entities` | `canonical_name`, `aliases_json`, `type` (`person`, `org`, `place`, `product`, `concept`, `other`) |
| `facts` | `text`, `kind` (`world` or `experience`), `occurrence_time` (nullable), `mentioned_at`, `source_id`, `embedding` (float32 blob, nullable), `embedding_model`, `embedding_dim` |
| `edges` | `edge_type` is `mentions`. A fact mentions an entity. |

Opening a file from an older build adds the three embedding columns. Existing rows keep a null vector.

## Limits in v1

Extraction quality depends on the local model. The prompt asks for two to five coarse facts, and the bank keeps at most five. A small model may miss a fact, invent a detail, or choose a weak name. That is accepted for this version.

`recall` matches entity names and keywords. It will miss a paraphrase that shares neither. `hybridRecall` fuses that lookup with vectors, one-hop neighbors, and recency. `semanticSearch` is vectors alone. There is no approximate nearest-neighbor index. Identical fact text is stored once per bank. Paraphrases stay separate.

Resolving a name loads that bank's entities. That is appropriate for a personal graph and will cost more if one bank grows very large.

There is no encryption and no hosted service.
