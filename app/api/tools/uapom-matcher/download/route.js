import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const name = searchParams.get('name') || 'download';

  if (!url) return NextResponse.json({ error: 'No URL provided' }, { status: 400 });

  try {
    const res = await fetch(url);
    const buf = await res.arrayBuffer();
    const isZip = name.endsWith('.zip');

    return new NextResponse(buf, {
      headers: {
        'Content-Type': isZip ? 'application/zip' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="${name}"`,
      },
    });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
