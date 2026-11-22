// Build synthetic compiled-ACS BEHAVIOR lumps for tests (FNAM/SNAM name chunks).

/** Little-endian DWORDs. */
export function u32(...values: number[]): Buffer {
  const buf = Buffer.alloc(values.length * 4);
  values.forEach((v, i) => buf.writeUInt32LE(v >>> 0, i * 4));
  return buf;
}

/** One chunk: [id][size][data]. */
export function chunk(id: string, data: Buffer): Buffer {
  return Buffer.concat([Buffer.from(id, "latin1"), u32(data.length), data]);
}

/** A FUNC chunk: one public, value-returning, argless entry per address. */
export function funcChunk(addresses: number[]): Buffer {
  return chunk("FUNC", Buffer.concat(addresses.map((a) => Buffer.concat([Buffer.from([0, 0, 1, 0]), u32(a)]))));
}

/** A compiled object with code from offset 8, by default behind zt-bcc's indirect `ACS\0` header,
 *  whose chunk offset and real tag sit just before a minimal directory after the chunks. */
export function buildObject(opts: { format?: "ACSE" | "ACSe"; indirect?: boolean; code?: Buffer; chunks?: Buffer[] }): Buffer {
  const { format = "ACSe", indirect = true, code = Buffer.alloc(0), chunks = [] } = opts;
  const body = Buffer.concat([code, ...chunks]);
  if (!indirect) return Buffer.concat([Buffer.from(format, "latin1"), u32(8 + code.length), body]);
  const tail = Buffer.concat([u32(8 + code.length), Buffer.from(format, "latin1"), u32(0)]);
  return Buffer.concat([Buffer.from("ACS\0", "latin1"), u32(8 + body.length + 8), body, tail]);
}

export function nameChunk(id: string, names: string[]): Buffer {
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

/** ACSE lump with an MEXP chunk (slot i = exports[i]) and, if given, an ARAY chunk. */
export function buildBehaviorExports(
  exports: string[],
  arrays?: Array<{ index: number; size: number }>,
): Buffer {
  const header = Buffer.alloc(8);
  header.write("ACSE", 0, "latin1");
  header.writeUInt32LE(8, 4);
  const parts = [header, nameChunk("MEXP", exports)];
  if (arrays) {
    const aray = Buffer.alloc(8 + arrays.length * 8);
    aray.write("ARAY", 0, "latin1");
    aray.writeUInt32LE(arrays.length * 8, 4);
    arrays.forEach((a, i) => {
      aray.writeUInt32LE(a.index, 8 + i * 8);
      aray.writeUInt32LE(a.size, 12 + i * 8);
    });
    parts.push(aray);
  }
  return Buffer.concat(parts);
}
