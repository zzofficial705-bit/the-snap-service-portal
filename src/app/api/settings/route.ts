import { NextResponse } from 'next/server';
import { getSettingsFromDb, saveSettingsToDb } from '@/lib/server-db';
import { handleConditionalGet } from '@/lib/http-cache';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const workspaceId =
      url.searchParams.get('workspaceId') ||
      req.headers.get('x-workspace-id') ||
      url.searchParams.get('userId') ||
      req.headers.get('x-user-id') ||
      undefined;

    const settings = await getSettingsFromDb(workspaceId);
    return handleConditionalGet(req, settings);
  } catch (error) {
    console.error('Error fetching settings:', error);
    return NextResponse.json({ error: 'Failed to fetch settings' }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const url = new URL(req.url);
    const body = await req.json();
    const settings = body.settings || body;
    const workspaceId =
      body.workspaceId ||
      url.searchParams.get('workspaceId') ||
      req.headers.get('x-workspace-id') ||
      body.userId ||
      url.searchParams.get('userId') ||
      undefined;

    const saved = await saveSettingsToDb(settings, workspaceId);
    return NextResponse.json(saved);
  } catch (error) {
    console.error('Error saving settings:', error);
    return NextResponse.json({ error: 'Failed to save settings' }, { status: 500 });
  }
}
