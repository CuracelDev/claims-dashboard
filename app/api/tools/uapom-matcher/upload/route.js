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
        allowedContentTypes: [
          'text/csv',
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'application/vnd.ms-excel',
          'application/octet-stream',
        ],
        maximumSizeInBytes: 200 * 1024 * 1024,
      }),
      onUploadCompleted: async ({ blob }) => {
        console.log('[blob upload complete]', blob.url);
      },
    });
    return NextResponse.json(response);
  } catch (err) {
    return NextResponse.json({ error: err.message }, { status: 500 });
  }
}
