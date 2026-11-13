export class MemoryBankError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryBankError";
  }
}

/** Ollama could not be reached. retain did not write. */
export class ExtractorUnavailableError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractorUnavailableError";
  }
}

/** Ollama could not embed text. Callers that store facts catch this and leave the vector null. */
export class EmbedderUnavailableError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbedderUnavailableError";
  }
}

/** The extractor replied, but the payload was not usable. Nothing was written. */
export class ExtractionFailedError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionFailedError";
  }
}
