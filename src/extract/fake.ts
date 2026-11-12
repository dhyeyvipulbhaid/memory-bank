import type { ExtractedFact, ExtractInput, Extractor } from "../types.ts";

export type FakeScript = (input: ExtractInput) => ExtractedFact[] | Promise<ExtractedFact[]>;

/** Scripted extractor for tests and offline demos. It does not call a model. */
export function createFakeExtractor(script: FakeScript): Extractor {
  return {
    extract(input) {
      return script(input);
    },
  };
}
