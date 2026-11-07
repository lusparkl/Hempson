import { inflateRawSync } from 'node:zlib';

/** One spreadsheet cell: text, a number, or empty. */
export type Cell = string | number | null;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A zip archive with stored (uncompressed) entries: small exports, no compression dependency. */
function zipStored(files: Array<{ name: string; data: Buffer }>): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const crc = crc32(f.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 names
    local.writeUInt16LE(0, 8); // stored
    local.writeUInt32LE(0, 10); // time/date (1980-01-01 00:00)
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(f.data.length, 18);
    local.writeUInt32LE(f.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, f.data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt32LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(f.data.length, 20);
    cen.writeUInt32LE(f.data.length, 24);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, name);
    offset += local.length + name.length + f.data.length;
  }
  const cenSize = central.reduce((a, b) => a + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** XML text: escaped, and without the control characters XML 1.0 forbids. */
const xmlChar = (ch: string) => {
  const c = ch.codePointAt(0)!;
  return c === 0x9 || c === 0xa || c === 0xd || (c >= 0x20 && c <= 0xd7ff) || (c >= 0xe000 && c <= 0xfffd) || c >= 0x10000;
};
const xml = (s: string) => [...s].filter(xmlChar).join('').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Column letters: 0 = A, 25 = Z, 26 = AA. */
export function columnName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

/**
 * A one-sheet .xlsx workbook (P8 order export). Text is written as inline strings, so a cell starting with `=` stays text
 * and is never evaluated as a formula. Numbers are numbers. No styles.
 */
export function buildXlsx(sheetName: string, rows: Cell[][]): Buffer {
  const body = rows
    .map((row, r) => {
      const cells = row
        .map((v, c) => {
          const ref = `${columnName(c)}${r + 1}`;
          if (v === null || v === '') return '';
          if (typeof v === 'number' && Number.isFinite(v)) return `<c r="${ref}"><v>${v}</v></c>`;
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${xml(String(v))}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${cells}</row>`;
    })
    .join('');
  const name = xml(sheetName.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1');
  const files = {
    '[Content_Types].xml':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    '_rels/.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    'xl/workbook.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${name}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${body}</sheetData></worksheet>`,
  };
  return zipStored(Object.entries(files).map(([n, d]) => ({ name: n, data: Buffer.from(d, 'utf8') })));
}

// ---------- reading (P8 catalog import) ----------

export class XlsxReadError extends Error {
  constructor(readonly kind: 'not_xlsx' | 'too_large' | 'unsupported' | 'no_sheet') {
    super(`xlsx: ${kind}`);
    this.name = 'XlsxReadError';
  }
}

export type XlsxReadLimits = {
  /** Largest uncompressed size of one archive entry (zip-bomb guard). */
  maxEntryBytes: number;
  maxRows: number;
  maxColumns: number;
};
const READ_LIMITS: XlsxReadLimits = { maxEntryBytes: 20_000_000, maxRows: 5001, maxColumns: 100 };

type ZipEntry = { method: number; flags: number; crc: number; compSize: number; size: number; offset: number };

/** The central directory of a zip: entry name to its location. Zip64, encrypted and multi-disk archives are refused. */
function zipEntries(buf: Buffer): Map<string, ZipEntry> {
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new XlsxReadError('not_xlsx');
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  if (count === 0xffff || p === 0xffffffff) throw new XlsxReadError('unsupported');
  const out = new Map<string, ZipEntry>();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxReadError('not_xlsx');
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    out.set(name, {
      flags: buf.readUInt16LE(p + 8),
      method: buf.readUInt16LE(p + 10),
      crc: buf.readUInt32LE(p + 16),
      compSize: buf.readUInt32LE(p + 20),
      size: buf.readUInt32LE(p + 24),
      offset: buf.readUInt32LE(p + 42),
    });
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
  }
  return out;
}

function zipRead(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  if (e.flags & 1) throw new XlsxReadError('unsupported'); // encrypted
  if (e.size > maxBytes) throw new XlsxReadError('too_large');
  const h = e.offset;
  if (h + 30 > buf.length || buf.readUInt32LE(h) !== 0x04034b50) throw new XlsxReadError('not_xlsx');
  const start = h + 30 + buf.readUInt16LE(h + 26) + buf.readUInt16LE(h + 28);
  const raw = buf.subarray(start, start + e.compSize);
  if (raw.length !== e.compSize) throw new XlsxReadError('not_xlsx');
  let data: Buffer;
  if (e.method === 0) data = Buffer.from(raw);
  else if (e.method === 8) {
    try {
      data = inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch (err) {
      throw new XlsxReadError(err instanceof RangeError ? 'too_large' : 'not_xlsx');
    }
  } else throw new XlsxReadError('unsupported');
  if (data.length !== e.size || crc32(data) !== e.crc) throw new XlsxReadError('not_xlsx');
  return data;
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const unxml = (s: string) =>
  s.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]+);/g, (m, e: string) => {
    if (e[0] !== '#') return ENTITY[e] ?? m;
    const c = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return c > 0 && c <= 0x10ffff ? String.fromCodePoint(c) : '';
  });
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1];
/** Text of all `<t>` runs, without phonetic hints (`<rPh>`). Element names may carry a namespace prefix. */
const textRuns = (xmlPart: string) =>
  [...xmlPart.replace(/<(\w+:)?rPh\b[\s\S]*?<\/(\w+:)?rPh>/g, '').matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((m) => unxml(m[1]!)).join('');

/** 'B12' -> column 1. */
function columnIndex(ref: string): number | undefined {
  const m = /^([A-Z]{1,3})\d+$/.exec(ref);
  if (!m) return undefined;
  let n = 0;
  for (const ch of m[1]!) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/** A number as Excel shows it: 15 significant digits, so a stored 1299.8999999999999 reads as 1299.9. */
const numberText = (v: string) => {
  const n = Number(v);
  return Number.isFinite(n) ? String(Number(n.toPrecision(15))) : v;
};

/**
 * The first worksheet of an .xlsx file as rows of text cells (P8 catalog import), with its row numbers. Built in, no
 * dependency (D21/D35): reads the zip directory, inflates only the parts it needs (size-capped, CRC-checked), and takes
 * each cell's stored value: shared or inline strings as text, numbers in their shortest form, booleans as 1/0, formulas
 * as their cached result. Formulas are never evaluated. Dates arrive as serial numbers. Empty rows are dropped.
 */
export function readXlsxFirstSheet(file: Buffer, limits: Partial<XlsxReadLimits> = {}): Array<{ line: number; cells: string[] }> {
  const lim = { ...READ_LIMITS, ...limits };
  const entries = zipEntries(file);
  const part = (name: string) => {
    const e = entries.get(name);
    return e ? zipRead(file, e, lim.maxEntryBytes).toString('utf8') : undefined;
  };
  const workbook = part('xl/workbook.xml');
  if (!workbook) throw new XlsxReadError(entries.has('xl/workbook.bin') ? 'unsupported' : 'not_xlsx');
  const first = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(workbook);
  if (!first) throw new XlsxReadError('no_sheet');
  const rid = attr(first[1]!, '[\\w]+:id');
  let path = 'xl/worksheets/sheet1.xml';
  const rels = part('xl/_rels/workbook.xml.rels');
  if (rid && rels) {
    for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
      if (attr(m[1]!, 'Id') !== rid) continue;
      const target = attr(m[1]!, 'Target');
      if (target) path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
    }
  }
  const sheet = part(path);
  if (!sheet) throw new XlsxReadError('no_sheet');
  const sharedXml = part('xl/sharedStrings.xml');
  const shared = sharedXml ? [...sharedXml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((m) => textRuns(m[1]!)) : [];

  const out: Array<{ line: number; cells: string[] }> = [];
  let rowNo = 0;
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    rowNo = Number(attr(rm[1]!, 'r')) || rowNo + 1;
    if (rowNo > lim.maxRows) throw new XlsxReadError('too_large');
    const cells: string[] = [];
    let col = -1;
    for (const cm of (rm[2] ?? '').matchAll(/<(?:\w+:)?c\b([^>]*?)\/>|<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attrs = cm[1] ?? cm[2] ?? '';
      const ref = attr(attrs, 'r');
      col = (ref ? columnIndex(ref) : undefined) ?? col + 1;
      if (col >= lim.maxColumns) continue;
      const body = cm[3] ?? '';
      const type = attr(attrs, 't') ?? 'n';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1];
      let text = '';
      if (type === 'inlineStr') text = textRuns(body);
      else if (v !== undefined) {
        const raw = unxml(v);
        text = type === 's' ? (shared[Number(raw)] ?? '') : type === 'n' ? numberText(raw) : raw;
      }
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    if (cells.some((c) => c.trim() !== '')) out.push({ line: rowNo, cells });
  }
  return out;
}
