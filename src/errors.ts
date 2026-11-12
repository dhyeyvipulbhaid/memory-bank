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

/** The extractor replied, but the payload was not usable. Nothing was written. */
export class ExtractionFailedError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionFailedError";
  }
}
