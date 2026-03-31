import { handleUpload } from '@vercel/blob/client';
import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

export async function POST(request) {
  const body = await request.json();
  try {
    const response = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async () => ({
        addRandomSuffix: true,
        allowedContentTypes: [
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'application/octet-stream',
          'text/plain',
        ],
        maximumSizeInBytes: 200 * 1024 * 1024,
        tokenPayload: JSON.stringify({ source: 'uapom-matcher' }),
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob uploaded]', blob.url);
      },
    });
    return NextResponse.json(response);
  } catch (err) {
    console.error('[upload error]', err.message);
    return NextResponse.json({ error: err.message }, { status: 400 });
  }
}
