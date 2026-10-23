'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { StudioExpense, ExpenseCategory } from '@/lib/types';
import { storage } from '@/lib/storage';
import { apiFetchExpenses, apiSaveExpense, apiDeleteExpense } from '@/lib/api-client';
import { useAuth } from './use-auth';
import { generateSecureId } from '@/lib/crypto';

export function useExpenses() {
  const { currentUser } = useAuth();
  const [expenses, setExpenses] = useState<StudioExpense[]>(() => {
    if (typeof window === 'undefined') return [];
    return storage.getExpenses();
  });
  const [loading, setLoading] = useState(true);
  const isInitialMount = useRef(true);

  const activeWorkspace = currentUser?.workspaceId || (currentUser?.id ? `ws_${currentUser.id}` : 'ws_user-super-admin');

  // Load from cloud as authoritative; fallback to local storage only if offline/error
  const refreshExpenses = useCallback(async (isSilent = false) => {
    if (!isSilent && isInitialMount.current) {
      setLoading(true);
    }
    try {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        const local = storage.getExpenses();
        setExpenses(local);
        return;
      }

      const cloud = await apiFetchExpenses(activeWorkspace);
      if (Array.isArray(cloud)) {
        storage.setAllExpenses(cloud);
        setExpenses(cloud);
      } else {
        const local = storage.getExpenses();
        setExpenses(local);
      }
    } catch (e) {
      console.error('Error refreshing expenses:', e);
      const local = storage.getExpenses();
      setExpenses(local);
    } finally {
      isInitialMount.current = false;
      setLoading(false);
    }
  }, [activeWorkspace]);

  useEffect(() => {
    refreshExpenses(false);

    const handleLocalUpdate = () => {
      refreshExpenses(true);
    };

    window.addEventListener('snap_expenses_updated', handleLocalUpdate);
    window.addEventListener('storage', handleLocalUpdate);
    window.addEventListener('focus', handleLocalUpdate);

    return () => {
      window.removeEventListener('snap_expenses_updated', handleLocalUpdate);
      window.removeEventListener('storage', handleLocalUpdate);
      window.removeEventListener('focus', handleLocalUpdate);
    };
  }, [refreshExpenses]);

  // Create new expense or team advance
  const addExpense = useCallback(
    async (payload: Omit<StudioExpense, 'id' | 'createdAt' | 'updatedAt' | 'workspaceId'>) => {
      const newExpense: StudioExpense = {
        ...payload,
        id: `exp-${Date.now()}-${generateSecureId().slice(0, 6)}`,
        workspaceId: activeWorkspace,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      // 1. Optimistic Local Save
      storage.saveExpense(newExpense);
      setExpenses((prev) => [newExpense, ...prev.filter((e) => e.id !== newExpense.id)]);

      // 2. Cloud Save
      try {
        await apiSaveExpense(newExpense);
      } catch (e) {
        console.error('Failed to sync new expense to cloud:', e);
      }

      return newExpense;
    },
    [activeWorkspace]
  );

  // Update existing expense
  const updateExpense = useCallback(
    async (expense: StudioExpense) => {
      const updated = {
        ...expense,
        workspaceId: expense.workspaceId || activeWorkspace,
        updatedAt: new Date().toISOString(),
      };

      storage.saveExpense(updated);
      setExpenses((prev) =>
        prev.map((e) => (e.id === updated.id ? updated : e))
      );

      try {
        await apiSaveExpense(updated);
      } catch (e) {
        console.error('Failed to sync updated expense to cloud:', e);
      }

      return updated;
    },
    [activeWorkspace]
  );

  // Delete expense
  const deleteExpense = useCallback(
    async (id: string) => {
      storage.deleteExpense(id);
      setExpenses((prev) => prev.filter((e) => e.id !== id));

      try {
        await apiDeleteExpense(id, activeWorkspace);
      } catch (e) {
        console.error('Failed to delete expense from cloud:', e);
      }

      return true;
    },
    [activeWorkspace]
  );

  // Computed Summaries
  const totalExpenses = useMemo(() => {
    return expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }, [expenses]);

  const totalTeamAdvances = useMemo(() => {
    return expenses
      .filter((e) => e.category === 'team_advance')
      .reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  }, [expenses]);

  const expensesByPerson = useMemo(() => {
    const map: Record<string, { personName: string; total: number; count: number; expenses: StudioExpense[] }> = {};

    expenses.forEach((e) => {
      const name = (e.personName || '').trim();
      if (!name) return;
      const key = name.toLowerCase();

      if (!map[key]) {
        map[key] = {
          personName: name,
          total: 0,
          count: 0,
          expenses: [],
        };
      }

      map[key].total += Number(e.amount) || 0;
      map[key].count += 1;
      map[key].expenses.push(e);
    });

    return map;
  }, [expenses]);

  const expensesByCategory = useMemo(() => {
    const map: Partial<Record<ExpenseCategory, number>> = {};
    expenses.forEach((e) => {
      const cat = e.category || 'other';
      map[cat] = (map[cat] || 0) + (Number(e.amount) || 0);
    });
    return map;
  }, [expenses]);

  return {
    expenses,
    loading,
    addExpense,
    updateExpense,
    deleteExpense,
    totalExpenses,
    totalTeamAdvances,
    expensesByPerson,
    expensesByCategory,
    refreshExpenses,
  };
}
