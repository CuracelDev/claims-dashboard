import { NextResponse } from 'next/server';
import * as XLSX from 'xlsx';
import JSZip from 'jszip';

export const runtime = 'nodejs';

function rowsToCSV(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const lines = [headers.join(',')];
  for (const row of rows) {
    const line = headers.map(h => {
      const val = row[h] === null || row[h] === undefined ? '' : String(row[h]);
      if (val.includes(',') || val.includes('"') || val.includes('\n')) return `"${val.replace(/"/g, '""')}"`;
      return val;
    });
    lines.push(line.join(','));
  }
  return lines.join('\n');
}

export async function POST(req) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');
    const batchSize = parseInt(formData.get('batchSize') || '5000', 10);
    if (!file) return NextResponse.json({ error: 'No file uploaded.' }, { status: 400 });
    if (isNaN(batchSize) || batchSize < 1) return NextResponse.json({ error: 'Invalid batch size.' }, { status: 400 });
    const ext = file.name.split('.').pop().toLowerCase();
    if (!['csv', 'xlsx', 'xls'].includes(ext)) return NextResponse.json({ error: 'Unsupported file type.' }, { status: 400 });
    const buffer = Buffer.from(await file.arrayBuffer());
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    if (!rows.length) return NextResponse.json({ error: 'File is empty or has no data rows.' }, { status: 400 });
    const totalRows = rows.length;
    const batchCount = Math.ceil(totalRows / batchSize);
    const zip = new JSZip();
    const baseName = file.name.replace(/\.[^.]+$/, '');
    for (let i = 0; i < batchCount; i++) {
      const batchRows = rows.slice(i * batchSize, Math.min((i + 1) * batchSize, totalRows));
      zip.file(`${baseName}_batch_${String(i + 1).padStart(3, '0')}.csv`, rowsToCSV(batchRows));
    }
    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
    return new NextResponse(zipBuffer, {
      status: 200,
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${baseName}_batches.zip"`,
        'X-Total-Rows': String(totalRows),
        'X-Batch-Count': String(batchCount),
      },
    });
  } catch (err) {
    console.error('[batch-splitter]', err);
    return NextResponse.json({ error: 'Failed to process file.' }, { status: 500 });
  }
}
