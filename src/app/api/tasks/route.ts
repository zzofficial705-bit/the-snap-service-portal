import { NextResponse } from 'next/server';
import { getTasksFromDb, saveTaskToDb, deleteTaskFromDb } from '@/lib/server-db';
import { TaskItem } from '@/lib/types';
import { handleConditionalGet } from '@/lib/http-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId =
      url.searchParams.get('workspaceId') ||
      request.headers.get('x-workspace-id') ||
      url.searchParams.get('userId') ||
      request.headers.get('x-user-id') ||
      undefined;

    const tasks = await getTasksFromDb(workspaceId);
    return handleConditionalGet(request, { success: true, tasks });
  } catch (error) {
    console.error('API GET /api/tasks error:', error);
    return NextResponse.json({ error: 'Failed to fetch tasks' }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const body: TaskItem = await request.json();
    if (!body || !body.id || !body.title) {
      return NextResponse.json({ error: 'Invalid task data' }, { status: 400 });
    }

    const saved = await saveTaskToDb(body);
    return NextResponse.json(
      { success: true, task: saved },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }
    );
  } catch (error) {
    console.error('API POST /api/tasks error:', error);
    return NextResponse.json({ error: 'Failed to save task' }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');
    if (!id) {
      return NextResponse.json({ error: 'Task ID required' }, { status: 400 });
    }

    await deleteTaskFromDb(id);
    return NextResponse.json({ success: true });
  } catch (error) {
    console.error('API DELETE /api/tasks error:', error);
    return NextResponse.json({ error: 'Failed to delete task' }, { status: 500 });
  }
}
