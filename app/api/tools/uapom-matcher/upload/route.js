import { put } from '@vercel/blob';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const file = formData.get('file');
    const filename = formData.get('filename') || file.name;

    if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 });

    const blob = await put(filename, file, {
      access: 'public',
      token: process.env.BLOB_READ_WRITE_TOKEN,
    });

    return NextResponse.json({ url: blob.url, filename });
  } catch (err) {
    console.error('[blob upload]', err.message);
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
