import { Quotation, Service, AppSettings, UserAccount, PaymentTransaction, TaskItem, StudioExpense } from './types';
import { DEFAULT_SERVICES, DEFAULT_SETTINGS, DEFAULT_INCLUSIONS, getDefaultSettingsForWorkspace } from './defaults';
import { getTodayDateString } from './utils';
import { generateSecureId, generateRandomNumericId } from './crypto';

const STORAGE_KEYS = {
  QUOTATIONS: 'snap_service_persistent_quotations_v2',
  DELETED_IDS: 'snap_service_deleted_quotation_ids',
  DELETED_USER_IDS: 'snap_service_deleted_user_ids',
  SERVICES: 'snap_service_services',
  SETTINGS: 'snap_service_settings',
  USERS: 'snap_service_users',
  CURRENT_USER: 'snap_service_current_user',
  TASKS: 'snap_service_tasks_v1',
  EXPENSES: 'snap_service_expenses_v1',
};

// Seed Users: Super Admin (Owner)
export const SEED_USERS: UserAccount[] = [
  {
    id: 'user-super-admin',
    name: 'Zunair Ahmad (Owner)',
    email: 'admin@snapservice.com',
    password: 'admin123',
    phone: '0323-9244924',
    role: 'super_admin',
    approved: true,
    active: true,
    createdAt: '2026-08-01T00:00:00.000Z',
  },
];

export const storage = {
  // Persistent Offline-First Quotations CRUD
  getQuotations: (): Quotation[] => {
    if (typeof window === 'undefined') return [];
    try {
      const data = localStorage.getItem(STORAGE_KEYS.QUOTATIONS);
      if (!data) return [];
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      const deletedIds = storage.getDeletedIds();
      return parsed
        .filter((q: Quotation) => {
          const idMatch = q.id && deletedIds.has(q.id.toLowerCase());
          const numMatch = q.quotationNumber && deletedIds.has(q.quotationNumber.toLowerCase());
          return !idMatch && !numMatch;
        });
    } catch (e) {
      console.error('Error reading quotations from localStorage', e);
      return [];
    }
  },

  setAllQuotations: (quotations: Quotation[]): void => {
    if (typeof window === 'undefined') return;
    try {
      const deletedIds = storage.getDeletedIds();
      const cleanList = (quotations || []).filter((q) => {
        const idMatch = q.id && deletedIds.has(q.id.toLowerCase());
        const numMatch = q.quotationNumber && deletedIds.has(q.quotationNumber.toLowerCase());
        return !idMatch && !numMatch;
      });
      localStorage.setItem(STORAGE_KEYS.QUOTATIONS, JSON.stringify(cleanList));
    } catch (e) {
      console.error('Error writing quotations to localStorage', e);
    }
  },

  getDeletedIds: (): Set<string> => {
    if (typeof window === 'undefined') return new Set();
    try {
      const data = localStorage.getItem(STORAGE_KEYS.DELETED_IDS);
      if (!data) return new Set();
      const arr = JSON.parse(data);
      return new Set(Array.isArray(arr) ? arr.map((s: string) => String(s).toLowerCase()) : []);
    } catch {
      return new Set();
    }
  },

  addDeletedId: (id: string, quotationNumber?: string): void => {
    if (typeof window === 'undefined' || !id) return;
    try {
      const set = storage.getDeletedIds();
      set.add(id.trim().toLowerCase());
      if (quotationNumber) set.add(quotationNumber.trim().toLowerCase());
      localStorage.setItem(STORAGE_KEYS.DELETED_IDS, JSON.stringify(Array.from(set)));
    } catch {}
  },

  removeDeletedId: (id: string): void => {
    if (typeof window === 'undefined' || !id) return;
    try {
      const set = storage.getDeletedIds();
      set.delete(id.trim().toLowerCase());
      localStorage.setItem(STORAGE_KEYS.DELETED_IDS, JSON.stringify(Array.from(set)));
    } catch {}
  },

  getQuotationById: (id: string): Quotation | null => {
    if (!id) return null;
    const cleanId = id.trim().toLowerCase();
    const all = storage.getQuotations();
    return (
      all.find(
        (q) =>
          (q.id && q.id.toLowerCase() === cleanId) ||
          (q.quotationNumber && q.quotationNumber.toLowerCase() === cleanId)
      ) || null
    );
  },

  saveQuotationLocally: (quotation: Quotation): Quotation => {
    if (typeof window === 'undefined' || !quotation) return quotation;
    try {
      if (quotation.id) storage.removeDeletedId(quotation.id);
      if (quotation.quotationNumber) storage.removeDeletedId(quotation.quotationNumber);

      const all = storage.getQuotations();
      const idx = all.findIndex((q) => q.id === quotation.id);
      let updated: Quotation[];
      if (idx >= 0) {
        updated = [...all];
        updated[idx] = quotation;
      } else {
        updated = [quotation, ...all];
      }
      storage.setAllQuotations(updated);
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('snap_quotation_updated'));
      }
    } catch (e) {
      console.error('Error saving quotation locally', e);
    }
    return quotation;
  },

  saveQuotation: (quotation: Quotation): Quotation => {
    return storage.saveQuotationLocally(quotation);
  },

  deleteQuotation: (id: string): void => {
    if (typeof window === 'undefined' || !id) return;
    const cleanKey = id.trim().toLowerCase();
    try {
      const all = storage.getQuotations();
      const target = all.find(
        (q) => (q.id && q.id.toLowerCase() === cleanKey) || (q.quotationNumber && q.quotationNumber.toLowerCase() === cleanKey)
      );
      const filtered = all.filter(
        (q) =>
          q.id.toLowerCase() !== cleanKey &&
          (!q.quotationNumber || q.quotationNumber.toLowerCase() !== cleanKey)
      );
      storage.addDeletedId(cleanKey, target?.quotationNumber);
      if (target?.id) storage.addDeletedId(target.id);
      localStorage.setItem(STORAGE_KEYS.QUOTATIONS, JSON.stringify(filtered));
    } catch (e) {
      console.error('Error deleting quotation from localStorage', e);
    }
  },

  duplicateQuotation: (id: string): Quotation | null => {
    const target = storage.getQuotationById(id);
    if (!target) return null;

    const nextNum = storage.generateQuotationNumber();

    const newQuotation: Quotation = {
      ...target,
      id: generateSecureId('quote'),
      quotationNumber: nextNum,
      securityPin: generateRandomNumericId(6),
      client: {
        ...target.client,
        name: `${target.client.name} (Copy)`,
      },
      status: 'draft',
      payment: {
        ...target.payment,
        advanceReceived: 0,
        transactions: [],
        clientProposedAdvance: undefined,
        balancePayable: target.payment?.grandTotal || 0,
        paymentStatus: 'unpaid',
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    return storage.saveQuotation(newQuotation);
  },

  // Helper to resolve clean workspace key
  resolveWorkspaceKey: (targetWorkspaceOrUserId?: string): string => {
    if (targetWorkspaceOrUserId) {
      const clean = targetWorkspaceOrUserId.trim();
      if (clean === 'user-super-admin' || clean === 'global' || clean === 'super_admin' || clean === 'ws_user-super-admin' || clean === 'ws_global') {
        return 'ws_user-super-admin';
      }
      if (clean.startsWith('ws_')) return clean;
      return `ws_${clean}`;
    }
    if (typeof window === 'undefined') return 'ws_user-super-admin';
    const currentUser = storage.getCurrentUser();
    if (!currentUser || !currentUser.id) return 'ws_user-super-admin';
    if (currentUser.role === 'super_admin' || currentUser.id === 'user-super-admin') return 'ws_user-super-admin';
    return currentUser.workspaceId || `ws_${currentUser.id}`;
  },

  // Service Library CRUD (Per-Workspace)
  getServices: (targetWorkspaceOrUserId?: string): Service[] => {
    if (typeof window === 'undefined') return DEFAULT_SERVICES;
    try {
      const activeWs = storage.resolveWorkspaceKey(targetWorkspaceOrUserId);
      const wsKey = `${STORAGE_KEYS.SERVICES}_${activeWs}`;
      const data = localStorage.getItem(wsKey);
      if (!data) {
        return DEFAULT_SERVICES;
      }
      return JSON.parse(data);
    } catch (e) {
      console.error('Error reading services from localStorage', e);
      return DEFAULT_SERVICES;
    }
  },

  saveServices: (services: Service[], targetWorkspaceOrUserId?: string): void => {
    if (typeof window !== 'undefined') {
      const activeWs = storage.resolveWorkspaceKey(targetWorkspaceOrUserId);
      const wsKey = `${STORAGE_KEYS.SERVICES}_${activeWs}`;
      localStorage.setItem(wsKey, JSON.stringify(services));
      storage.triggerAutoBackup();
    }
  },

  // Settings CRUD (Per-Workspace Studio Configurations)
  getSettings: (targetWorkspaceOrUserId?: string): AppSettings => {
    const activeWs = storage.resolveWorkspaceKey(targetWorkspaceOrUserId);
    if (typeof window === 'undefined') return getDefaultSettingsForWorkspace(activeWs);
    try {
      const wsKey = `${STORAGE_KEYS.SETTINGS}_${activeWs}`;
      const data = localStorage.getItem(wsKey);

      if (!data) {
        return getDefaultSettingsForWorkspace(activeWs);
      }
      return JSON.parse(data);
    } catch (e) {
      console.error('Error reading per-workspace settings from localStorage', e);
      return getDefaultSettingsForWorkspace(activeWs);
    }
  },

  saveSettings: (settings: AppSettings, targetWorkspaceOrUserId?: string): void => {
    if (typeof window !== 'undefined') {
      const activeWs = storage.resolveWorkspaceKey(targetWorkspaceOrUserId || settings.workspaceId);
      const wsKey = `${STORAGE_KEYS.SETTINGS}_${activeWs}`;
      const settingsToSave: AppSettings = {
        ...settings,
        workspaceId: activeWs,
      };
      localStorage.setItem(wsKey, JSON.stringify(settingsToSave));
      storage.triggerAutoBackup();
    }
  },

  // Auto-generate next quotation number with strict sequence increment per workspace
  generateQuotationNumber: (targetWorkspaceOrUserId?: string): string => {
    const activeWs = storage.resolveWorkspaceKey(targetWorkspaceOrUserId);
    const settings = storage.getSettings(activeWs);
    const quotations = storage.getQuotations().filter(
      (q) => (q.workspaceId ? q.workspaceId === activeWs : storage.resolveWorkspaceKey(q.userId) === activeWs)
    );
    let maxSeq = (settings.quotation.startingNumber || 101) - 1;

    quotations.forEach((q) => {
      if (q.quotationNumber) {
        const parts = q.quotationNumber.split('-');
        const numStr = parts[parts.length - 1];
        const num = parseInt(numStr, 10);
        if (!isNaN(num) && num > maxSeq) {
          maxSeq = num;
        }
      }
    });

    const nextNumber = maxSeq + 1;
    const prefix = settings.quotation.prefix || 'SS-2026';
    return `${prefix}-${nextNumber}`;
  },

  getDeletedUserIds: (): Set<string> => {
    if (typeof window === 'undefined') return new Set();
    try {
      const data = localStorage.getItem(STORAGE_KEYS.DELETED_USER_IDS);
      if (!data) return new Set();
      const parsed = JSON.parse(data);
      return new Set(Array.isArray(parsed) ? parsed.map((id: string) => id.trim().toLowerCase()) : []);
    } catch {
      return new Set();
    }
  },

  addDeletedUserId: (id: string): void => {
    if (typeof window === 'undefined' || !id) return;
    try {
      const set = storage.getDeletedUserIds();
      set.add(id.trim().toLowerCase());
      localStorage.setItem(STORAGE_KEYS.DELETED_USER_IDS, JSON.stringify(Array.from(set)));
    } catch {}
  },

  removeDeletedUserId: (id: string): void => {
    if (typeof window === 'undefined' || !id) return;
    try {
      const set = storage.getDeletedUserIds();
      set.delete(id.trim().toLowerCase());
      localStorage.setItem(STORAGE_KEYS.DELETED_USER_IDS, JSON.stringify(Array.from(set)));
    } catch {}
  },

  // User Accounts CRUD & Session Management
  getUsers: (): UserAccount[] => {
    if (typeof window === 'undefined') return SEED_USERS;
    try {
      const data = localStorage.getItem(STORAGE_KEYS.USERS);
      if (!data) {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(SEED_USERS));
        return SEED_USERS;
      }
      const parsed: UserAccount[] = JSON.parse(data);
      const deletedIds = storage.getDeletedUserIds();
      const filtered = Array.isArray(parsed)
        ? parsed.filter((u) => u && u.id && !deletedIds.has(u.id.trim().toLowerCase()))
        : [];
      const hasSuperAdmin = filtered.some((u) => u.role === 'super_admin');
      if (!hasSuperAdmin) {
        filtered.unshift(SEED_USERS[0]);
      }
      return filtered;
    } catch {
      return SEED_USERS;
    }
  },

  saveUser: (user: UserAccount): UserAccount => {
    if (user.id) storage.removeDeletedUserId(user.id);
    const list = storage.getUsers();
    const idx = list.findIndex((u) => u.id === user.id || u.email.toLowerCase() === user.email.toLowerCase());
    let updated: UserAccount[];
    if (idx >= 0) {
      updated = [...list];
      updated[idx] = { ...updated[idx], ...user };
    } else {
      updated = [user, ...list];
    }
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(updated));
      storage.triggerAutoBackup();
    }
    return user;
  },

  deleteUser: (idOrEmail: string): void => {
    if (!idOrEmail || idOrEmail === 'user-super-admin' || idOrEmail === 'admin@snapservice.com') return;
    const clean = idOrEmail.trim().toLowerCase();
    storage.addDeletedUserId(clean);
    const list = storage.getUsers();
    const updated = list.filter((u) => u.id.toLowerCase() !== clean && u.email.toLowerCase() !== clean);
    if (typeof window !== 'undefined') {
      localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(updated));
      storage.triggerAutoBackup();
    }
  },

  getCurrentUser: (): UserAccount | null => {
    if (typeof window === 'undefined') return null;
    try {
      const data = localStorage.getItem(STORAGE_KEYS.CURRENT_USER);
      if (!data) return null;
      return JSON.parse(data);
    } catch (e) {
      return null;
    }
  },

  setCurrentUser: (user: UserAccount | null): void => {
    if (typeof window !== 'undefined') {
      if (user) {
        localStorage.setItem(STORAGE_KEYS.CURRENT_USER, JSON.stringify(user));
      } else {
        localStorage.removeItem(STORAGE_KEYS.CURRENT_USER);
      }
    }
  },

  // Complete System Backup & Restore Engine
  createBackupData: () => {
    if (typeof window === 'undefined') return null;
    return {
      appName: 'The Snap Service',
      version: '2.0',
      timestamp: new Date().toISOString(),
      quotations: storage.getQuotations(),
      services: storage.getServices(),
      settings: storage.getSettings(),
      users: storage.getUsers(),
    };
  },

  triggerAutoBackup: () => {
    if (typeof window === 'undefined') return;
    try {
      const backupData = storage.createBackupData();
      if (backupData) {
        localStorage.setItem('snap_service_auto_backup_latest', JSON.stringify(backupData));
        localStorage.setItem('snap_service_last_auto_backup_time', new Date().toISOString());
      }
    } catch (e) {
      console.error('Error creating auto-backup', e);
    }
  },

  getLastAutoBackupTime: (): string | null => {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('snap_service_last_auto_backup_time');
  },

  restoreFromBackupData: (backupObj: Record<string, unknown> | null | undefined): boolean => {
    if (typeof window === 'undefined' || !backupObj) return false;
    try {
      if (backupObj.quotations && Array.isArray(backupObj.quotations)) {
        for (const q of backupObj.quotations) {
          try {
            fetch('/api/quotations', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(q),
            }).catch(() => {});
          } catch {}
        }
      }
      if (backupObj.services && Array.isArray(backupObj.services)) {
        localStorage.setItem(STORAGE_KEYS.SERVICES, JSON.stringify(backupObj.services));
      }
      if (backupObj.users && Array.isArray(backupObj.users)) {
        localStorage.setItem(STORAGE_KEYS.USERS, JSON.stringify(backupObj.users));
      }
      if (backupObj.settings) {
        const currentUser = storage.getCurrentUser();
        const userId = currentUser?.id || 'default';
        const userKey = `${STORAGE_KEYS.SETTINGS}_${userId}`;
        localStorage.setItem(userKey, JSON.stringify(backupObj.settings));
      }
      storage.triggerAutoBackup();
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new Event('snap_quotation_updated'));
      }
      return true;
    } catch (e) {
      console.error('Error restoring backup data', e);
      return false;
    }
  },
  recordPaymentTransaction: (quotationId: string, transaction: PaymentTransaction): Quotation | null => {
    const q = storage.getQuotationById(quotationId);
    if (!q) return null;

    const existingTx = q.payment?.transactions || [];
    const updatedTx = [...existingTx, transaction];
    const totalPaid = updatedTx.reduce((sum, t) => sum + (t.amount || 0), 0);
    const grandTotal = q.payment?.grandTotal || 0;
    const balance = Math.max(0, grandTotal - totalPaid);

    let status: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
    if (totalPaid >= grandTotal && grandTotal > 0) status = 'paid_in_full';
    else if (totalPaid > 0) status = 'partially_paid';

    let updatedVariations = q.variations;
    if (updatedVariations && updatedVariations.length > 0) {
      updatedVariations = updatedVariations.map((v) => {
        const isTarget = v.id === q.selectedVariationId || v.isAccepted;
        if (!isTarget) return v;
        const vGrandTotal = Number(v.payment?.grandTotal) || grandTotal;
        return {
          ...v,
          payment: {
            ...v.payment,
            grandTotal: vGrandTotal,
            advanceReceived: totalPaid,
            balancePayable: Math.max(0, vGrandTotal - totalPaid),
            transactions: updatedTx,
            paymentStatus: status,
            clientProposedAdvance: v.payment?.clientProposedAdvance,
          },
        };
      });
    }

    const updatedQuotation: Quotation = {
      ...q,
      variations: updatedVariations,
      payment: {
        ...q.payment,
        advanceReceived: totalPaid,
        balancePayable: balance,
        transactions: updatedTx,
        paymentStatus: status,
        clientProposedAdvance: q.payment?.clientProposedAdvance,
      },
      updatedAt: new Date().toISOString(),
    };

    storage.saveQuotationLocally(updatedQuotation);
    return updatedQuotation;
  },

  updatePaymentTransaction: (
    quotationId: string,
    transactionId: string,
    updatedFields: Partial<PaymentTransaction>
  ): Quotation | null => {
    const q = storage.getQuotationById(quotationId);
    if (!q) return null;

    const existingTx = q.payment?.transactions || [];
    const updatedTx = existingTx.map((t) => (t.id === transactionId ? { ...t, ...updatedFields } : t));
    const totalPaid = updatedTx.reduce((sum, t) => sum + (t.amount || 0), 0);
    const grandTotal = q.payment?.grandTotal || 0;
    const balance = Math.max(0, grandTotal - totalPaid);

    let status: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
    if (totalPaid >= grandTotal && grandTotal > 0) status = 'paid_in_full';
    else if (totalPaid > 0) status = 'partially_paid';

    let updatedVariations = q.variations;
    if (updatedVariations && updatedVariations.length > 0) {
      updatedVariations = updatedVariations.map((v) => {
        const isTarget = v.id === q.selectedVariationId || v.isAccepted;
        if (!isTarget) return v;
        const vGrandTotal = Number(v.payment?.grandTotal) || grandTotal;
        return {
          ...v,
          payment: {
            ...v.payment,
            grandTotal: vGrandTotal,
            advanceReceived: totalPaid,
            balancePayable: Math.max(0, vGrandTotal - totalPaid),
            transactions: updatedTx,
            paymentStatus: status,
            clientProposedAdvance: v.payment?.clientProposedAdvance,
          },
        };
      });
    }

    const updatedQuotation: Quotation = {
      ...q,
      variations: updatedVariations,
      payment: {
        ...q.payment,
        advanceReceived: totalPaid,
        balancePayable: balance,
        transactions: updatedTx,
        paymentStatus: status,
        clientProposedAdvance: q.payment?.clientProposedAdvance,
      },
      updatedAt: new Date().toISOString(),
    };

    storage.saveQuotationLocally(updatedQuotation);
    return updatedQuotation;
  },

  deletePaymentTransaction: (quotationId: string, transactionId: string): Quotation | null => {
    const q = storage.getQuotationById(quotationId);
    if (!q) return null;

    const existingTx = q.payment?.transactions || [];
    const updatedTx = existingTx.filter((t) => t.id !== transactionId);
    const totalPaid = updatedTx.reduce((sum, t) => sum + (t.amount || 0), 0);
    const grandTotal = q.payment?.grandTotal || 0;
    const balance = Math.max(0, grandTotal - totalPaid);

    let status: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
    if (totalPaid >= grandTotal && grandTotal > 0) status = 'paid_in_full';
    else if (totalPaid > 0) status = 'partially_paid';

    let updatedVariations = q.variations;
    if (updatedVariations && updatedVariations.length > 0) {
      updatedVariations = updatedVariations.map((v) => {
        const isTarget = v.id === q.selectedVariationId || v.isAccepted;
        if (!isTarget) return v;
        const vGrandTotal = Number(v.payment?.grandTotal) || grandTotal;
        return {
          ...v,
          payment: {
            ...v.payment,
            grandTotal: vGrandTotal,
            advanceReceived: totalPaid,
            balancePayable: Math.max(0, vGrandTotal - totalPaid),
            transactions: updatedTx,
            paymentStatus: status,
            clientProposedAdvance: v.payment?.clientProposedAdvance,
          },
        };
      });
    }

    const updatedQuotation: Quotation = {
      ...q,
      variations: updatedVariations,
      payment: {
        ...q.payment,
        advanceReceived: totalPaid,
        balancePayable: balance,
        transactions: updatedTx,
        paymentStatus: status,
        clientProposedAdvance: q.payment?.clientProposedAdvance,
      },
      updatedAt: new Date().toISOString(),
    };

    storage.saveQuotationLocally(updatedQuotation);
    return updatedQuotation;
  },

  // ----------------------------------------------------
  // Snap Service — Daily Tasks Persistent CRUD
  // ----------------------------------------------------
  getTasks: (): TaskItem[] => {
    if (typeof window === 'undefined') return [];
    try {
      const data = localStorage.getItem(STORAGE_KEYS.TASKS);
      if (!data) return [];
      const parsed = JSON.parse(data);
      if (!Array.isArray(parsed)) return [];
      return parsed;
    } catch (e) {
      console.error('Error reading tasks from localStorage', e);
      return [];
    }
  },

  getTaskById: (id: string): TaskItem | null => {
    const tasks = storage.getTasks();
    return tasks.find((t) => t.id === id) || null;
  },

  saveTask: (task: TaskItem): TaskItem => {
    if (typeof window === 'undefined') return task;
    try {
      const tasks = storage.getTasks();
      const index = tasks.findIndex((t) => t.id === task.id);
      let updated: TaskItem[];
      if (index >= 0) {
        updated = [...tasks];
        updated[index] = { ...task, updatedAt: new Date().toISOString() };
      } else {
        updated = [task, ...tasks];
      }
      localStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(updated));
      window.dispatchEvent(new Event('snap_tasks_updated'));
      return task;
    } catch (e) {
      console.error('Error saving task to localStorage', e);
      return task;
    }
  },

  deleteTask: (id: string): boolean => {
    if (typeof window === 'undefined') return false;
    try {
      const tasks = storage.getTasks();
      const filtered = tasks.filter((t) => t.id !== id);
      localStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(filtered));
      window.dispatchEvent(new Event('snap_tasks_updated'));
      return true;
    } catch (e) {
      console.error('Error deleting task from localStorage', e);
      return false;
    }
  },

  setAllTasks: (tasks: TaskItem[]) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEYS.TASKS, JSON.stringify(tasks));
      window.dispatchEvent(new Event('snap_tasks_updated'));
    } catch (e) {
      console.error('Error writing all tasks to localStorage', e);
    }
  },

  // Studio Expenses & Team Advances LocalStorage Engine
  getExpenses: (): StudioExpense[] => {
    if (typeof window === 'undefined') return [];
    try {
      const data = localStorage.getItem(STORAGE_KEYS.EXPENSES);
      if (!data) return [];
      const parsed = JSON.parse(data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('Error reading expenses from localStorage', e);
      return [];
    }
  },

  saveExpense: (expense: StudioExpense): StudioExpense => {
    if (typeof window === 'undefined') return expense;
    try {
      const expenses = storage.getExpenses();
      const idx = expenses.findIndex((e) => e.id === expense.id);
      let updated: StudioExpense[];
      if (idx >= 0) {
        updated = [...expenses];
        updated[idx] = { ...expense, updatedAt: new Date().toISOString() };
      } else {
        updated = [expense, ...expenses];
      }
      localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(updated));
      window.dispatchEvent(new Event('snap_expenses_updated'));
      return expense;
    } catch (e) {
      console.error('Error saving expense to localStorage', e);
      return expense;
    }
  },

  deleteExpense: (id: string): boolean => {
    if (typeof window === 'undefined') return false;
    try {
      const expenses = storage.getExpenses();
      const filtered = expenses.filter((e) => e.id !== id);
      localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(filtered));
      window.dispatchEvent(new Event('snap_expenses_updated'));
      return true;
    } catch (e) {
      console.error('Error deleting expense from localStorage', e);
      return false;
    }
  },

  setAllExpenses: (expenses: StudioExpense[]) => {
    if (typeof window === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEYS.EXPENSES, JSON.stringify(expenses));
      window.dispatchEvent(new Event('snap_expenses_updated'));
    } catch (e) {
      console.error('Error writing all expenses to localStorage', e);
    }
  },
};
