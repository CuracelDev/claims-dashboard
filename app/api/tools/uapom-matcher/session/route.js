// PATH: app/api/tools/uapom-matcher/session/route.js
import { writeFile, mkdir, readFile, writeFile as wf } from 'fs/promises';
import { existsSync } from 'fs';
import { NextResponse } from 'next/server';
import crypto from 'crypto';

export const dynamic = 'force-dynamic';
export const config = { api: { bodyParser: false, responseLimit: false } };

const BASE = '/tmp/uapom-matcher';

// POST /session — upload UAPOM file, get session token
export async function POST(request) {
  try {
    const formData = await request.formData();
    const uapomFile = formData.get('uapom');
    if (!uapomFile) return NextResponse.json({ error: 'UAPOM file required' }, { status: 400 });

    const token = crypto.randomBytes(8).toString('hex');
    const sessionDir = `${BASE}/session_${token}`;
    await mkdir(sessionDir, { recursive: true });

    await writeFile(`${sessionDir}/uapom.xlsx`, Buffer.from(await uapomFile.arrayBuffer()));

    // Init session metadata
    const meta = { token, batches: 0, created_at: new Date().toISOString(), status: 'active' };
    await wf(`${sessionDir}/meta.json`, JSON.stringify(meta));

    return NextResponse.json({ success: true, token, message: 'UAPOM session created. Now upload Curacel batches.' });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}

// GET /session?token=xxx — check session status
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const token = searchParams.get('token');
  if (!token) return NextResponse.json({ error: 'No token' }, { status: 400 });

  const sessionDir = `${BASE}/session_${token}`;
  if (!existsSync(sessionDir)) return NextResponse.json({ error: 'Session not found' }, { status: 404 });

  try {
    const meta = JSON.parse(await readFile(`${sessionDir}/meta.json`, 'utf8'));
    const batchResults = [];
    for (let i = 1; i <= meta.batches; i++) {
      const bPath = `${sessionDir}/batch_${i}_result.json`;
      if (existsSync(bPath)) {
        batchResults.push(JSON.parse(await readFile(bPath, 'utf8')));
      }
    }
    return NextResponse.json({ ...meta, batch_results: batchResults });
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
