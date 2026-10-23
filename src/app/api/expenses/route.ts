import { NextResponse } from 'next/server';
import { getExpensesFromDb, saveExpenseToDb, deleteExpenseFromDb } from '@/lib/server-db';
import { StudioExpense } from '@/lib/types';
import { generateSecureId } from '@/lib/crypto';
import { handleConditionalGet } from '@/lib/http-cache';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const workspaceId = url.searchParams.get('workspaceId') || undefined;
    const expenses = await getExpensesFromDb(workspaceId);
    return handleConditionalGet(request, { success: true, expenses });
  } catch (error) {
    console.error('API GET /api/expenses error:', error);
    return NextResponse.json(
      { error: 'Failed to fetch studio expenses' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
  try {
    const body = await request.json();
    if (!body || typeof body.amount !== 'number' || body.amount <= 0) {
      return NextResponse.json({ error: 'Valid amount is required' }, { status: 400 });
    }

    const expense: StudioExpense = {
      id: body.id || `exp-${Date.now()}-${generateSecureId().slice(0, 6)}`,
      workspaceId: body.workspaceId || 'ws_user-super-admin',
      amount: Number(body.amount),
      category: body.category || 'other',
      date: body.date || new Date().toISOString().split('T')[0],
      personName: (body.personName || '').trim(),
      userId: body.userId || undefined,
      paymentMethod: body.paymentMethod || 'cash',
      description: (body.description || '').trim(),
      reference: (body.reference || '').trim() || undefined,
      receiptUrl: body.receiptUrl || undefined,
      createdAt: body.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    const updatedExpenses = await saveExpenseToDb(expense);

    return NextResponse.json(
      { success: true, expense, expenses: updatedExpenses },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }
    );
  } catch (error) {
    console.error('API POST /api/expenses error:', error);
    return NextResponse.json(
      { error: 'Failed to save expense' },
      { status: 500 }
    );
  }
}

export async function PUT(request: Request) {
  return POST(request);
}

export async function DELETE(request: Request) {
  try {
    const url = new URL(request.url);
    let id = url.searchParams.get('id');
    const workspaceId = url.searchParams.get('workspaceId') || undefined;

    if (!id) {
      const body = await request.json().catch(() => ({}));
      id = body.id;
    }

    if (!id) {
      return NextResponse.json({ error: 'Missing expense id' }, { status: 400 });
    }

    const updatedExpenses = await deleteExpenseFromDb(id, workspaceId);

    return NextResponse.json(
      { success: true, expenses: updatedExpenses },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
          'Pragma': 'no-cache',
          'Expires': '0',
        },
      }
    );
  } catch (error) {
    console.error('API DELETE /api/expenses error:', error);
    return NextResponse.json(
      { error: 'Failed to delete expense' },
      { status: 500 }
    );
  }
}
