# memory-bank

Local knowledge-graph memory for an AI agent. Facts live in one SQLite file. A later call returns only the slice that fits a token budget.

`retain` sends a transcript to a local Ollama chat model and keeps up to five facts. If that call fails, or the reply is not usable JSON, it throws and writes nothing. `remember` stores one fact by hand and does not call a model. `recall` matches entity names and keywords and never uses the network. Pass an embedder and new facts also get a vector. If that call fails, the fact is still saved and the vector stays null.

The package is a library and a command-line tool, plus a local graph viewer for development. Memory stays on the machine. Encryption is opt-in: with no key the file is plaintext, and with a 32-byte key the sensitive fields are AES-256-GCM.

## What it does

- **Encryption at rest.** `openBank({ encryptionKey })` accepts a 32-byte key (`Uint8Array` or base64). Fact text, observation text, embeddings, entity names and aliases, and source text are encrypted with AES-256-GCM. Each value gets a fresh 12-byte IV, and the associated data is the table, column, and row id. Name resolution and exact dedup compare an HMAC-SHA256 blind index from a separate HKDF subkey. `encryptBank(path, key)` and `memory-bank encrypt --db <file> --key-env MEMORY_BANK_KEY` convert an existing plaintext file in one transaction. `--dry-run` only counts fields. See [Encryption at rest](#encryption-at-rest).
- **Semantic search.** `createOllamaEmbedder()` stores `nomic-embed-text` vectors (little-endian float32, plus model name and dimension). `semanticSearch` ranks facts by brute-force cosine. `backfillEmbeddings` fills facts that have no vector yet and skips rows that already have one.
- **Hybrid recall.** `hybridRecall` fuses keyword overlap, vector similarity, and the entity graph (alias match plus one hop) with reciprocal rank fusion, then multiplies by recency. A time cue in the query (`yesterday`, `last week`, `in March`, an explicit date) keeps facts inside that UTC window. `llmRerank: true` asks the chat model (`qwen3:8b` by default) to reorder the list. It is off by default, and a failed rerank leaves the fused order. A missing embedder drops the vector list and the other two still run. Personal-Agents should call `hybridRecall` for the prompt slice. `recall` stays the keyword and entity lookup.
- **Reflect.** `reflect` asks the chat model for a few observations that cite the facts they came from. They are stored apart from world and experience facts. `hybridRecall` returns them with `derived: true` unless `includeObservations` is false. Running the same scope again updates a matching observation and drops the ones the model no longer returns.
- **Junk sweep.** `sweepJunk` uses the same `junkReason` check as `retain` on facts already in the file (assistant disclaimers, session narration, `unknown`, near-empty text). The default is a dry run. Deletion happens only when `dryRun` is false, which is `memory-bank sweep --apply`. Back up the file first.
- **Memory graph.** `graphSnapshot` returns `{ nodes, edges }` for one bank: semantic neighbors, facts within a week of each other, shared mentions, and observation-to-fact links. The default slice is 200 nodes and the hard cap is 1000. `memory-bank graph-serve` opens a local force-directed viewer at `http://127.0.0.1:4173`. That viewer is a dev tool.

## Using it from another repo

Pin a commit. This package is not published to npm.

```json
{
  "dependencies": {
    "memory-bank": "github:dhyeyvipulbhaid/memory-bank#356954d9c8b49cec7f3e413ca4fb70d1db1894e9"
  }
}
```

Replace that sha with the commit you want. The host app needs [Bun](https://bun.sh) 1.1 or newer. `retain` and `reflect` need a local Ollama server and a chat model (`ollama pull qwen3:8b`). Semantic search, hybrid recall, and reflect embeddings also need `ollama pull nomic-embed-text`. `remember` and `recall` work with Ollama stopped.

```ts
import { createOllamaEmbedder, createOllamaExtractor, openBank } from "memory-bank";

const bank = openBank("./memory.sqlite", {
  extractor: createOllamaExtractor({ model: "qwen3:8b" }),
  embedder: createOllamaEmbedder({ model: "nomic-embed-text" }),
});

await bank.retain({
  content: "Yesterday Maya said the launch moved to June.",
  speaker: "user",
});

const memory = await bank.recall({
  query: "Maya launch",
  tokenBudget: 800,
});
// memory.facts is the keyword slice. Use hybridRecall for the prompt.

bank.close();
```

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

### Cleanup

Facts saved before the junk filter, including assistant disclaimers, session narration, `unknown`, and near-empty text, can still be in the file. `sweepJunk` uses the same `junkReason` check as `retain`. It lists matches and does not delete unless `dryRun` is false.

Copy the sqlite file before applying a sweep.

```bash
cp ./memory.sqlite ./memory.sqlite.bak
bun src/cli.ts sweep --db ./memory.sqlite
bun src/cli.ts sweep --db ./memory.sqlite --apply
```

`listFacts({ limit, offset, kind?, entity?, query? })` pages the stored facts. `updateFact(id, text)` rewrites one fact, embeds the new text, and folds it into an existing row when the normalized text already exists. `forget(id)` and `forgetMany(ids)` delete facts, mention links, entities left with no links, and observations that cited only the deleted facts.

```bash
bun src/cli.ts list --db ./memory.sqlite --limit 20 --entity Maya
bun src/cli.ts forget --db ./memory.sqlite --id <fact-id>
bun test test/sweep.test.ts
```

### Memory graph

`graphSnapshot` returns `{ nodes, edges }` for a force-directed view. Nodes are the most recent facts and observations in the window. `recency` runs from 0 to 1 for color. `sourceFactCount` is the node size. Edges are `semantic` (cosine neighbors above `minSimilarity`, default 0.72), `temporal` (the next fact within a week), `entity` (a shared mention, a few per fact), and `derived` (an observation pointing at the facts it cites). The slice is capped at 200 nodes by default and never more than 1000.

```bash
bun src/cli.ts graph --db ./memory.sqlite --out ./graph.json
bun src/cli.ts graph-serve --db ./memory.sqlite
```

`graph-serve` listens on `http://127.0.0.1:4173`. Drag to pan, scroll to zoom, and hover a node for its text. The corner legend is recency (slate to amber) and the four edge colors.

```bash
bun test test/graph.test.ts
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

Opening a file from an older build adds the embedding columns and the encryption columns. Existing rows stay plaintext until you run `encrypt`. Schema version 4 is the encryption columns and the `entity_name_index` table. A `schema_meta` row named `encryption` is the key check; it is written only when a key is in use.

## Encryption at rest

Field-level AES-256-GCM protects the SQLite file when it is sitting on disk. It does not protect a process that already has the key, and it does not hide row counts, timestamps, fact kinds, or the shape of the mention graph. Key management belongs to the host app (an OS keychain, for example). This library only receives the raw 32-byte key.

`openBank({ encryptionKey })` takes that key as a `Uint8Array` or base64. Leave it unset and the file stays plaintext, including files written by older builds. A key on a brand-new empty file turns encryption on. A key on an existing plaintext file is refused, so plaintext and ciphertext are never mixed. A missing key on an encrypted file, or the wrong key, throws `EncryptionError` before any row is returned.

Each value gets a fresh 12-byte IV. The stored blob is a version byte, the IV, the ciphertext, and the GCM tag. The associated data is the table, the column, and the row id, so a value copied onto another row fails authentication. Entity name and alias resolution, and exact fact dedup, compare a keyed HMAC-SHA256 (a separate HKDF subkey), not the plaintext. Keyword search, semantic search, `hybridRecall`, `reflect`, `sweepJunk`, and `graphSnapshot` decrypt in memory. That is fine for a few thousand facts and will get slower as the bank grows, because those scans can no longer use a SQL `LIKE` index.

Generate a key:

```bash
bun -e 'console.log(Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64"))'
```

Put it in the environment, back up the file, then convert it. `--dry-run` only counts fields.

```bash
export MEMORY_BANK_KEY='the-base64-key'
cp ./test.sqlite ./test.sqlite.bak
bun src/cli.ts encrypt --db ./test.sqlite --key-env MEMORY_BANK_KEY --dry-run
bun src/cli.ts encrypt --db ./test.sqlite --key-env MEMORY_BANK_KEY
strings ./test.sqlite | grep -F 'a sentence you stored' || echo 'plaintext fact text is gone'
bun src/cli.ts recall --db ./test.sqlite --key-env MEMORY_BANK_KEY --query 'Maya' --token-budget 200
```

Other commands take the same `--key-env`. `encryptBank(path, key)` is the library call. It is one transaction and it is safe to run again with the same key.

## Limits in v1

Extraction quality depends on the local model. The prompt asks for two to five coarse facts, and the bank keeps at most five. A small model may miss a fact, invent a detail, or choose a weak name. That is accepted for this version.

`recall` matches entity names and keywords. It will miss a paraphrase that shares neither. `hybridRecall` fuses that lookup with vectors, one-hop neighbors, and recency. `semanticSearch` is vectors alone. There is no approximate nearest-neighbor index. Identical fact text is stored once per bank. Paraphrases stay separate.

Resolving a name loads that bank's entities. That is appropriate for a personal graph and will cost more if one bank grows very large. On an encrypted bank, keyword search and that name scan decrypt rows in memory.

There is no hosted service. Encryption at rest is opt-in and covers the file, not the running process.
