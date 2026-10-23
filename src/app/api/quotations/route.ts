import { NextResponse } from 'next/server';
import { Quotation } from '@/lib/types';
import { getQuotationsFromDb, saveQuotationToDb } from '@/lib/server-db';
import { handleConditionalGet } from '@/lib/http-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const NO_CACHE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
};

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId =
      url.searchParams.get('workspaceId') ||
      request.headers.get('x-workspace-id') ||
      url.searchParams.get('userId') ||
      request.headers.get('x-user-id') ||
      undefined;

    const quotations = await getQuotationsFromDb(workspaceId);
    return handleConditionalGet(request, { success: true, quotations });
  } catch {
    return NextResponse.json({ error: 'Failed to fetch quotations from database' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const quotation = (await request.json()) as Quotation;
    if (!quotation || (!quotation.id && !quotation.quotationNumber)) {
      return NextResponse.json({ error: 'Invalid quotation payload' }, { status: 400, headers: NO_CACHE_HEADERS });
    }

    const saved = await saveQuotationToDb(quotation);
    return NextResponse.json({ success: true, quotation: saved }, { headers: NO_CACHE_HEADERS });
  } catch {
    return NextResponse.json({ error: 'Failed to save quotation to database' }, { status: 500, headers: NO_CACHE_HEADERS });
  }
}
