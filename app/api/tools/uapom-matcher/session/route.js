import { writeFile, mkdir, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';

const BASE = '/tmp/uapom-matcher';

export async function POST(request) {
  try {
    const formData = await request.formData();
    const uapomFile = formData.get('uapom');
    if (!uapomFile) return NextResponse.json({ error: 'UAPOM file required' }, { status: 400 });

    const token = crypto.randomBytes(8).toString('hex');
    const sessionDir = `${BASE}/session_${token}`;
    await mkdir(sessionDir, { recursive: true });
    await writeFile(`${sessionDir}/uapom.xlsx`, Buffer.from(await uapomFile.arrayBuffer()));

    const meta = { token, batches: 0, created_at: new Date().toISOString(), status: 'active' };
    await writeFile(`${sessionDir}/meta.json`, JSON.stringify(meta));

    return NextResponse.json({ success: true, token, message: 'UAPOM session created.' });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 400 });

  const sessionDir = `${BASE}/session_${token}`;
  if (!existsSync(sessionDir)) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  try {
    const meta = JSON.parse(await readFile(`${sessionDir}/meta.json`, 'utf8'));
    return NextResponse.json(meta);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
