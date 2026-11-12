const CHUNK_CHARS = 1000;

/** Split long evidence so it can be stored beside the full source text. */
export function chunkText(text: string, size = CHUNK_CHARS): string[] {
  if (text.length <= size) return [text];

  const chunks: string[] = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n\n", size);
    if (cut < size * 0.4) cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.4) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.4) cut = size;
    chunks.push(rest.slice(0, cut));
    const next = rest.slice(cut).replace(/^\s+/, "");
    if (next.length === rest.length) {
      chunks.push(rest.slice(0, size));
      rest = rest.slice(size);
      continue;
    }
    rest = next;
  }
  if (rest.length > 0) chunks.push(rest);
  return chunks;
}
