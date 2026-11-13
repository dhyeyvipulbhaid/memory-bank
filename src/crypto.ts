import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";
import { EncryptionError } from "./errors.ts";

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_CHECK = "memory-bank-ok";

export interface CryptoBox {
  encrypt(plaintext: Uint8Array, aad: string): Uint8Array;
  decrypt(envelope: Uint8Array, aad: string): Uint8Array;
  /** HMAC of a normalized string. Equality lookups compare this, not the text. */
  blind(normalized: string): Uint8Array;
}

export function parseEncryptionKey(key: Uint8Array | string): Uint8Array {
  const bytes =
    typeof key === "string" ? new Uint8Array(Buffer.from(key.trim(), "base64")) : new Uint8Array(key);
  if (bytes.byteLength !== 32) {
    throw new EncryptionError("encryptionKey must be 32 bytes (raw or base64).");
  }
  return bytes;
}

export function createCryptoBox(key: Uint8Array): CryptoBox {
  const ikm = Buffer.from(key);
  const encKey = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("memory-bank:enc:v1"), 32));
  const macKey = Buffer.from(hkdfSync("sha256", ikm, Buffer.alloc(0), Buffer.from("memory-bank:mac:v1"), 32));
  return {
    encrypt(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", encKey, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext)), cipher.final()]);
      const tag = cipher.getAuthTag();
      return new Uint8Array(Buffer.concat([Buffer.from([VERSION]), iv, ciphertext, tag]));
    },
    decrypt(envelope, aad) {
      if (envelope.byteLength < 1 + IV_BYTES + TAG_BYTES || envelope[0] !== VERSION) {
        throw new EncryptionError("Ciphertext failed authentication.");
      }
      const iv = Buffer.from(envelope.subarray(1, 1 + IV_BYTES));
      const tagStart = envelope.byteLength - TAG_BYTES;
      const ciphertext = Buffer.from(envelope.subarray(1 + IV_BYTES, tagStart));
      const tag = Buffer.from(envelope.subarray(tagStart));
      try {
        const decipher = createDecipheriv("aes-256-gcm", encKey, iv);
        decipher.setAAD(Buffer.from(aad));
        decipher.setAuthTag(tag);
        return new Uint8Array(Buffer.concat([decipher.update(ciphertext), decipher.final()]));
      } catch (error) {
        throw new EncryptionError("Ciphertext failed authentication.", { cause: error });
      }
    },
    blind(normalized) {
      return new Uint8Array(createHmac("sha256", macKey).update(normalized).digest());
    },
  };
}

export function keyCheckEnvelope(box: CryptoBox): Uint8Array {
  return box.encrypt(Buffer.from(KEY_CHECK), aad("schema_meta", "encryption", "v1"));
}

export function assertKeyCheck(box: CryptoBox, envelope: Uint8Array): void {
  const opened = Buffer.from(box.decrypt(envelope, aad("schema_meta", "encryption", "v1"))).toString("utf8");
  if (opened !== KEY_CHECK) throw new EncryptionError("Wrong encryption key.");
}

export function aad(table: string, column: string, id: string): string {
  return `${table}|${column}|${id}`;
}
