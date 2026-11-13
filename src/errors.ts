export class MemoryBankError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MemoryBankError";
  }
}

/** The database key is missing, wrong, or the ciphertext was modified. */
export class EncryptionError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EncryptionError";
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

/** The reflect model could not be reached. Nothing was written. */
export class ReflectorUnavailableError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReflectorUnavailableError";
  }
}

/** The reflect model replied, but nothing valid could be stored. Nothing was written. */
export class ReflectFailedError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ReflectFailedError";
  }
}

/** The extractor replied, but the payload was not usable. Nothing was written. */
export class ExtractionFailedError extends MemoryBankError {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ExtractionFailedError";
  }
}
