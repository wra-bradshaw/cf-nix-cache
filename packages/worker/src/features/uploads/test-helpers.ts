const encoder = new TextEncoder();

/** A NAR holding one file, serialized the way `nix-store --dump` writes it. */
export function narOfFile(contents: Uint8Array): Uint8Array {
  const out: number[] = [];
  for (const field of [
    encoder.encode('nix-archive-1'),
    encoder.encode('('),
    encoder.encode('type'),
    encoder.encode('regular'),
    encoder.encode('contents'),
    contents,
    encoder.encode(')'),
  ]) {
    const length = new Uint8Array(8);
    new DataView(length.buffer).setBigUint64(0, BigInt(field.length), true);
    out.push(
      ...length,
      ...field,
      ...new Array((8 - (field.length % 8)) % 8).fill(0),
    );
  }
  return new Uint8Array(out);
}
