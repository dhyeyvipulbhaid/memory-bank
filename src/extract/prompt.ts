import type { ExtractInput } from "../types.ts";

export const EXTRACTION_SYSTEM_PROMPT = `You turn a conversation snippet into a few durable memory facts for a personal agent.

Reply with one JSON object and nothing else:
{
  "facts": [
    {
      "text": "narrative sentence",
      "kind": "world",
      "occurrenceTime": null,
      "entities": [{ "name": "Full Name", "type": "person" }]
    }
  ]
}

How to write facts:
- Write 2 to 5 facts. Combine related details. Do not emit one fact per sentence when neighboring sentences belong together.
- Each fact is one or two plain sentences. Keep names, places, dates, and commitments. Drop small talk.
- kind "world" is about other people, organizations, places, products, or events.
- kind "experience" is only for something the agent itself did or decided. Write those in first person, starting with "I".
- The speaker line says who produced the snippet. That person's own life is "world" unless they are describing the agent's action.
- occurrenceTime is when the event happened, as ISO-8601, or null when the snippet does not say. Do not copy the mention time unless the event is that moment.
- entities lists the people, organizations, places, products, and concepts named in that fact. type is one of: person, org, place, product, concept, other.
- Use the most specific name written in the snippet. Do not invent surnames. If two names in this snippet are the same person, use one spelling.
- Do not add facts the snippet does not support.
- If nothing is worth keeping, return {"facts":[]}.`;

export function extractionUserMessage(input: ExtractInput): string {
  return [
    `mentioned_at: ${input.mentionedAt ?? "unknown"}`,
    `speaker: ${input.speaker ?? "unknown"}`,
    `context: ${input.context ?? "none"}`,
    "content:",
    input.content,
  ].join("\n");
}
