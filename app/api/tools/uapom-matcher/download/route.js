import { readdir, readFile } from 'fs/promises';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  const fileType = searchParams.get('file');

  if (!token) return NextResponse.json({ error: 'No token' }, { status: 400 });

  const base = `/tmp/uapom-matcher/${token}`;

  try {
    const files = await readdir(base);
    const isZip = fileType === 'zip';
    const target = files.find(f => isZip ? f.endsWith('.zip') : (f.startsWith('UAPOM_Analysis_Master') && f.endsWith('.xlsx')));

    if (!target) return NextResponse.json({ error: 'File not found — run analysis first' }, { status: 404 });

    const buffer = await readFile(`${base}/${target}`);
    const mimeType = isZip ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

    return new NextResponse(buffer, {
      headers: {
        'Content-Type': mimeType,
        'Content-Disposition': `attachment; filename="${target}"`,
      },
    });
  } catch {
    return NextResponse.json({ error: 'File not found — run analysis first' }, { status: 404 });
  }
}
