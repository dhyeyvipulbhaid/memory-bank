import type { ExtractInput } from "../types.ts";

export const EXTRACTION_SYSTEM_PROMPT = `You turn a conversation snippet into a few durable memory facts for a personal agent.

Reply with one JSON object and nothing else:
{
  "facts": [
    {
      "text": "narrative sentence",
      "kind": "world",
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
- Only output occurrenceTime when the text names a specific past or scheduled occurrence, such as "we met Tuesday" or "the standup was on Nov 10 at 9am". Use an ISO-8601 timestamp for that occurrence.
- Omit occurrenceTime for preferences, standing facts, and undated statements. "9am works for me" is a preference, not an event time.
- Never use "now" or the current clock as occurrenceTime. Never copy mentioned_at into occurrenceTime.
- entities lists the people, organizations, places, products, and concepts named in that fact. type is one of: person, org, place, product, concept, other.
- Use the most specific name written in the snippet. Do not invent surnames. If two names in this snippet are the same person, use one spelling.
- Skip a fact that only reports your own lack of knowledge, or the assistant's or the model's. Do not emit "I don't know who Pepper is", "I do not have any information about that", or "I'm not sure who that is". Keep a real negative about someone else, such as "Maya does not have a preference for morning meetings".
- Do not add facts the snippet does not support.
- If nothing is worth keeping, return {"facts":[]}.`;

export function extractionUserMessage(input: ExtractInput): string {
  return [
    "mentioned_at is when this text was recorded, not when an event happened. Do not copy it into occurrenceTime.",
    `mentioned_at: ${input.mentionedAt ?? "unknown"}`,
    `speaker: ${input.speaker ?? "unknown"}`,
    `context: ${input.context ?? "none"}`,
    "content:",
    input.content,
  ].join("\n");
}
