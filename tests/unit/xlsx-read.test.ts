import { describe, expect, it } from 'vitest';
import { XlsxReadError, buildXlsx, readXlsxFirstSheet } from '../../apps/api/src/services/xlsx';
import { excelLikeWorkbook, zipDeflated } from '../fixtures/xlsx-zip';

const kind = (f: () => unknown) => {
  try {
    f();
  } catch (e) {
    return e instanceof XlsxReadError ? e.kind : String(e);
  }
  return 'no error';
};

describe('xlsx reader', () => {
  it('round-trips the built-in writer (stored entries, inline strings)', () => {
    const file = buildXlsx('Каталог', [
      ['sku', 'name', 'price'],
      ['TEE-S', '=SUM(A1) & <b>', 499.5],
      [null, null, null],
      ['', 'only name', 12],
    ]);
    expect(readXlsxFirstSheet(file)).toEqual([
      { line: 1, cells: ['sku', 'name', 'price'] },
      { line: 2, cells: ['TEE-S', '=SUM(A1) & <b>', '499.5'] },
      { line: 4, cells: ['', 'only name', '12'] },
    ]);
  });

  it('reads an Excel-shaped workbook: first listed sheet via rels, shared strings with rich runs, gaps, numbers, booleans, cached formulas', () => {
    const shared = [
      '<t>sku</t>',
      '<t>name</t>',
      '<t>price</t>',
      '<t>active</t>',
      '<r><t>Сукня </t></r><r><rPr><b/></rPr><t xml:space="preserve">&quot;Літо&quot; &amp; co</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh>',
      '<t>DR-1</t>',
    ];
    const rows =
      '<row r="1" spans="1:4"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>3</v></c></row>' +
      '<row r="3"><c r="A3" t="s" s="2"><v>5</v></c><c r="B3" t="s"><v>4</v></c><c r="C3" s="1"><f>A9*2</f><v>1299.8999999999999</v></c><c r="D3" t="b"><v>1</v></c></row>' +
      '<row r="4"><c r="A4" s="1"/><c r="C4"><v>1001</v></c><c r="D4" t="str"><f>IF(1,"так")</f><v>так</v></c></row>' +
      '<row r="5"><c r="A5" s="3"/></row>';
    expect(readXlsxFirstSheet(excelLikeWorkbook(rows, shared))).toEqual([
      { line: 1, cells: ['sku', 'name', 'price', 'active'] },
      { line: 3, cells: ['DR-1', 'Сукня "Літо" & co', '1299.9', '1'] },
      { line: 4, cells: ['', '', '1001', 'так'] },
    ]);
  });

  it('accepts namespace-prefixed parts (OpenXML SDK output)', () => {
    const file = zipDeflated({
      'xl/workbook.xml': '<x:workbook xmlns:x="m" xmlns:r="r"><x:sheets><x:sheet name="S" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/worksheets/sheet1.xml':
        '<x:worksheet xmlns:x="m"><x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>sku</x:t></x:is></x:c><x:c r="B1"><x:v>7</x:v></x:c></x:row></x:sheetData></x:worksheet>',
    });
    expect(readXlsxFirstSheet(file)).toEqual([{ line: 1, cells: ['sku', '7'] }]);
  });

  it('refuses non-xlsx input, corrupted data, binary workbooks and zip bombs', () => {
    expect(kind(() => readXlsxFirstSheet(Buffer.from('sku,name\nA,B\n')))).toBe('not_xlsx');
    expect(kind(() => readXlsxFirstSheet(zipDeflated({ 'xl/workbook.bin': 'x' })))).toBe('unsupported');
    expect(kind(() => readXlsxFirstSheet(zipDeflated({ 'word/document.xml': '<w/>' })))).toBe('not_xlsx');
    const good = buildXlsx('S', [['sku'], ['A']]);
    const bad = Buffer.from(good);
    bad[bad.indexOf('sku') + 1] = 0x58; // flips a byte of the sheet data: CRC mismatch
    expect(kind(() => readXlsxFirstSheet(bad))).toBe('not_xlsx');
    const bomb = `<worksheet><sheetData>${'<row/>'.repeat(10)}</sheetData>${' '.repeat(3_000_000)}</worksheet>`;
    const file = zipDeflated({ 'xl/workbook.xml': '<workbook><sheets><sheet name="S" sheetId="1"/></sheets></workbook>', 'xl/worksheets/sheet1.xml': bomb });
    expect(file.length).toBeLessThan(10_000);
    expect(kind(() => readXlsxFirstSheet(file, { maxEntryBytes: 1_000_000 }))).toBe('too_large');
  });

  it('caps rows and ignores columns past the limit', () => {
    const rows = Array.from({ length: 6 }, (_, i) => [`S${i}`]);
    expect(kind(() => readXlsxFirstSheet(buildXlsx('S', rows), { maxRows: 5 }))).toBe('too_large');
    expect(readXlsxFirstSheet(buildXlsx('S', [['a', 'b', 'c']]), { maxColumns: 2 })).toEqual([{ line: 1, cells: ['a', 'b'] }]);
  });
});
