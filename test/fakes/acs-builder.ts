// Build synthetic compiled-ACS BEHAVIOR lumps for tests (FNAM/SNAM name chunks).

function nameChunk(id: string, names: string[]): Buffer {
  const strings: Buffer[] = [];
  const offsets: number[] = [];
  let pos = 4 + names.length * 4; // strings begin after count + offset table
  for (const n of names) {
    offsets.push(pos);
    const sb = Buffer.from(n + "\0", "latin1");
    strings.push(sb);
    pos += sb.length;
  }
  const head = Buffer.alloc(4 + names.length * 4);
  head.writeUInt32LE(names.length, 0);
  offsets.forEach((o, i) => head.writeUInt32LE(o, 4 + i * 4));
  const payload = Buffer.concat([head, ...strings]);
  const chunk = Buffer.alloc(8 + payload.length);
  chunk.write(id, 0, "latin1");
  chunk.writeUInt32LE(payload.length, 4);
  payload.copy(chunk, 8);
  return chunk;
}

function chunks(functions: string[], scripts: string[]): Buffer {
  return Buffer.concat([nameChunk("FNAM", functions), nameChunk("SNAM", scripts)]);
}

/** Direct "ACSE" format: header [magic][chunksOffset], chunks right after. */
export function buildBehaviorAcse(functions: string[], scripts: string[]): Buffer {
  const header = Buffer.alloc(8);
  header.write("ACSE", 0, "latin1");
  header.writeUInt32LE(8, 4);
  return Buffer.concat([header, chunks(functions, scripts)]);
}

/** Old "ACS\0" header with embedded enhanced chunks (the compatibility variant). */
export function buildBehaviorAcs0Enhanced(functions: string[], scripts: string[]): Buffer {
  const body = chunks(functions, scripts);
  const tail = Buffer.alloc(8);
  tail.writeUInt32LE(8, 0); // chunks offset
  tail.write("ACSE", 4, "latin1"); // pretag
  const dir = Buffer.alloc(4); // minimal directory
  const dirofs = 8 + body.length + 8; // start of the directory (after the tail)
  const header = Buffer.alloc(8);
  header.write("ACS\0", 0, "latin1");
  header.writeUInt32LE(dirofs, 4);
  return Buffer.concat([header, body, tail, dir]);
}

/** A minimal pure ACS0 lump (no enhanced chunks): `dirofs` below the 24-byte cutoff. */
export function buildBehaviorAcs0Plain(): Buffer {
  const buf = Buffer.alloc(8);
  buf.write("ACS\0", 0, "latin1");
  buf.writeUInt32LE(8, 4); // dirofs = 8 (< 24) -> no chunks
  return buf;
}
