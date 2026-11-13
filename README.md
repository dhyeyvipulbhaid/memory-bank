# memory-bank

Local knowledge-graph memory for an AI agent.

After a chat, a local model pulls a few narrative facts out of the text and stores them in SQLite. A later run asks for what is relevant and gets back only the facts that fit a token budget. The file on disk can get large. The model context sees a slice of it.

You can also save a fact by hand. That goes into the same graph and does not call a model.

This is a library and a small command-line tool. A host app can import it later. There is no UI in this package.

Memory stays on the machine. In v1 the SQLite file is **not encrypted**. Anyone who can read the file can read the memory.

`retain` is the only call that uses the network, and only to Ollama at `127.0.0.1:11434` unless you point it somewhere else. `remember` and `recall` work with Ollama stopped. If Ollama is down, or the model reply is not usable JSON, `retain` throws and does not write a partial result.

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

bun src/cli.ts retain \
  --db ./memory.sqlite \
  --content "Yesterday Maya said the launch moved to June." \
  --speaker user
```

`retain` needs Ollama. `--model`, `--host`, and `--timeout-ms` override the defaults. `--bank` selects a bank id inside the file. Results are JSON on stdout. Errors go to stderr and the process exits 1.

Entity flags look like `Alice Chen:person,Orbit:product`.

## Schema

One SQLite file. Isolation column on every table: `bank_id`.

| Table | What it holds |
| --- | --- |
| `sources` | Original text, optional context and speaker, `mentioned_at` |
| `source_chunks` | The same text split up when it is long. The full text stays on `sources`. |
| `entities` | `canonical_name`, `aliases_json`, `type` (`person`, `org`, `place`, `product`, `concept`, `other`) |
| `facts` | `text`, `kind` (`world` or `experience`), `occurrence_time` (nullable), `mentioned_at`, `source_id` |
| `edges` | `edge_type` is `mentions`. A fact mentions an entity. |

## Limits in v1

Extraction quality depends on the local model. The prompt asks for two to five coarse facts, and the bank keeps at most five. A small model may miss a fact, invent a detail, or choose a weak name. That is accepted for this version.

Recall matches entity names and keywords. It will miss a paraphrase that shares neither. Identical fact text is stored once per bank. Paraphrases stay separate. There is no vector index.

Resolving a name loads that bank's entities. That is appropriate for a personal graph and will cost more if one bank grows very large.

There is no encryption and no hosted service.
