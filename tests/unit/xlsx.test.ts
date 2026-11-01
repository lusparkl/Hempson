import zlib from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { buildXlsx, columnName, crc32 } from '../../apps/api/src/services/xlsx';

/** Reads a stored-entry zip through its central directory: name, data, recorded CRC. */
function unzip(buf: Buffer) {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Array<{ name: string; data: Buffer; crc: number }> = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const crc = buf.readUInt32LE(p + 16);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    out.push({ name, data: buf.subarray(start, start + size), crc });
    p += 46 + nameLen;
  }
  return out;
}

describe('xlsx writer', () => {
  it('column names', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnName)).toEqual(['A', 'Z', 'AA', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('crc32 matches zlib', () => {
    const b = Buffer.from('Замовлення 123 =SUM(A1)');
    if (typeof (zlib as { crc32?: unknown }).crc32 === 'function') expect(crc32(b)).toBe((zlib as unknown as { crc32: (d: Buffer) => number }).crc32(b));
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926);
  });

  it('a valid package: the five parts, correct CRCs, text as inline strings (formulas stay text), numbers as numbers', () => {
    const files = unzip(
      buildXlsx('Замовлення', [
        ['ID', 'Сума'],
        ['=HYPERLINK("http://x")', 1299.5],
        ['a<b & "c"\u0007', null],
      ]),
    );
    expect(files.map((f) => f.name)).toEqual(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/worksheets/sheet1.xml']);
    for (const f of files) expect(crc32(f.data), f.name).toBe(f.crc);
    const sheet = files[4]!.data.toString('utf8');
    expect(sheet).toContain('<c r="A2" t="inlineStr"><is><t xml:space="preserve">=HYPERLINK(&quot;http://x&quot;)</t></is></c>');
    expect(sheet).toContain('<c r="B2"><v>1299.5</v></c>');
    expect(sheet).toContain('<c r="A3" t="inlineStr"><is><t xml:space="preserve">a&lt;b &amp; &quot;c&quot;</t></is></c>');
    expect(sheet).not.toContain('<f>');
    expect(sheet).not.toContain('B3');
    expect(files[2]!.data.toString('utf8')).toContain('<sheet name="Замовлення" sheetId="1" r:id="rId1"/>');
  });
});
