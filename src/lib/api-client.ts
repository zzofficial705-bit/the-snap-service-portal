import { Quotation, StudioExpense } from './types';

/**
 * REST API Client for Central Production Database Operations
 * Enforces strict conditional ETag support (HTTP 304) to eliminate bandwidth & egress.
 */

let lastQuotationsEtag: string | null = null;
let lastQuotationsData: Quotation[] = [];

export async function apiFetchQuotations(workspaceId?: string): Promise<Quotation[]> {
  try {
    const url = workspaceId
      ? `/api/quotations?workspaceId=${encodeURIComponent(workspaceId)}`
      : `/api/quotations`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (lastQuotationsEtag) {
      headers['If-None-Match'] = lastQuotationsEtag;
    }

    const res = await fetch(url, {
      cache: 'no-cache',
      headers,
    });

    if (res.status === 304) {
      // 304 Not Modified: 0 payload bytes transferred
      return lastQuotationsData;
    }

    if (res.ok) {
      const etag = res.headers.get('ETag');
      if (etag) lastQuotationsEtag = etag;
      const data = await res.json();
      if (data && Array.isArray(data.quotations)) {
        lastQuotationsData = data.quotations;
        return data.quotations;
      }
    }
  } catch (e) {
    console.error('API Fetch Quotations Error:', e);
  }
  return lastQuotationsData.length > 0 ? lastQuotationsData : [];
}

export async function apiFetchQuotationById(id: string): Promise<Quotation | null> {
  if (!id) return null;
  try {
    const timestamp = Date.now();
    const url = `/api/quotations/${encodeURIComponent(id)}?_t=${timestamp}`;

    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.ok) {
      lastQuotationsEtag = null;
      const data = await res.json();
      if (data && data.quotation) {
        return data.quotation;
      }
    }
  } catch (e) {
    console.error('API Fetch Quotation By ID Error:', e);
  }
  return null;
}

export async function apiFetchPublicQuotation(date: string, quotationNumber: string, pin: string): Promise<Quotation | null> {
  if (!date || !quotationNumber || !pin) return null;
  try {
    const timestamp = Date.now();
    const url = `/api/portal/resolve?date=${encodeURIComponent(date)}&quotationNumber=${encodeURIComponent(quotationNumber)}&pin=${encodeURIComponent(pin)}&_t=${timestamp}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.ok) {
      lastQuotationsEtag = null;
      const data = await res.json();
      if (data && data.quotation) {
        return data.quotation;
      }
    }
  } catch (e) {
    console.error('API Fetch Public Quotation Error:', e);
  }
  return null;
}

export async function apiSaveQuotation(quotation: Quotation): Promise<Quotation> {
  try {
    const res = await fetch('/api/quotations', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(quotation),
    });
    if (res.ok) {
      lastQuotationsEtag = null;
      const data = await res.json();
      if (data && data.quotation) {
        return data.quotation;
      }
    }
  } catch (e) {
    console.error('API Save Quotation Error:', e);
  }
  return quotation;
}

export async function apiDeleteQuotation(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/quotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Cache-Control': 'no-cache' },
    });
    return res.ok;
  } catch (e) {
    console.error('API Delete Quotation Error:', e);
    return false;
  }
}

import { AppSettings } from './types';

export async function apiFetchSettings(workspaceId?: string): Promise<AppSettings | null> {
  try {
    const timestamp = Date.now();
    const url = workspaceId
      ? `/api/settings?workspaceId=${encodeURIComponent(workspaceId)}&_t=${timestamp}`
      : `/api/settings?_t=${timestamp}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.bank) {
        return data as AppSettings;
      }
    }
  } catch (e) {
    console.error('API Fetch Settings Error:', e);
  }
  return null;
}

export async function apiSaveSettings(settings: AppSettings, workspaceId?: string): Promise<AppSettings> {
  try {
    const url = workspaceId ? `/api/settings?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/settings';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ settings, workspaceId }),
    });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (e) {
    console.error('API Save Settings Error:', e);
  }
  return settings;
}

import { Service } from './types';

export async function apiFetchServices(workspaceId?: string): Promise<Service[]> {
  try {
    const timestamp = Date.now();
    const url = workspaceId
      ? `/api/services?workspaceId=${encodeURIComponent(workspaceId)}&_t=${timestamp}`
      : `/api/services?_t=${timestamp}`;
    const res = await fetch(url, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data)) {
        return data as Service[];
      }
    }
  } catch (e) {
    console.error('API Fetch Services Error:', e);
  }
  return [];
}

export async function apiSaveServices(services: Service[], workspaceId?: string): Promise<Service[]> {
  try {
    const url = workspaceId ? `/api/services?workspaceId=${encodeURIComponent(workspaceId)}` : '/api/services';
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify({ services, workspaceId }),
    });
    if (res.ok) {
      const data = await res.json();
      return data;
    }
  } catch (e) {
    console.error('API Save Services Error:', e);
  }
  return services;
}

import { UserAccount } from './types';

export async function apiFetchUsers(): Promise<UserAccount[]> {
  try {
    const timestamp = Date.now();
    const res = await fetch(`/api/users?_t=${timestamp}`, {
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Pragma': 'no-cache',
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.users)) {
        return data.users as UserAccount[];
      }
    }
  } catch (e) {
    console.error('API Fetch Users Error:', e);
  }
  return [];
}

export async function apiSaveUser(user: UserAccount): Promise<UserAccount> {
  try {
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(user),
    });
    if (res.ok) {
      const data = await res.json();
      if (data && data.user) {
        return data.user;
      }
    }
  } catch (e) {
    console.error('API Save User Error:', e);
  }
  return user;
}

export async function apiDeleteUser(userId: string): Promise<UserAccount[]> {
  try {
    const res = await fetch(`/api/users?id=${encodeURIComponent(userId)}`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
    });
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.users)) {
        return data.users as UserAccount[];
      }
    }
  } catch (e) {
    console.error('API Delete User Error:', e);
  }
  return [];
}

import { TaskItem } from './types';

let lastTasksEtag: string | null = null;
let lastTasksData: TaskItem[] = [];

export async function apiFetchTasks(workspaceId?: string): Promise<TaskItem[]> {
  try {
    const url = workspaceId
      ? `/api/tasks?workspaceId=${encodeURIComponent(workspaceId)}`
      : `/api/tasks`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (lastTasksEtag) {
      headers['If-None-Match'] = lastTasksEtag;
    }

    const res = await fetch(url, {
      cache: 'no-cache',
      headers,
    });

    if (res.status === 304) {
      return lastTasksData;
    }

    if (res.ok) {
      const etag = res.headers.get('ETag');
      if (etag) lastTasksEtag = etag;
      const data = await res.json();
      if (data && Array.isArray(data.tasks)) {
        lastTasksData = data.tasks;
        return data.tasks as TaskItem[];
      }
    }
  } catch (e) {
    console.error('API Fetch Tasks Error:', e);
  }
  return lastTasksData.length > 0 ? lastTasksData : [];
}

export async function apiSaveTask(task: TaskItem): Promise<TaskItem> {
  try {
    const res = await fetch('/api/tasks', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(task),
    });
    if (res.ok) {
      lastTasksEtag = null;
      const data = await res.json();
      if (data && data.task) {
        return data.task;
      }
    }
  } catch (e) {
    console.error('API Save Task Error:', e);
  }
  return task;
}

export async function apiDeleteTask(id: string): Promise<boolean> {
  try {
    const res = await fetch(`/api/tasks?id=${encodeURIComponent(id)}`, {
      method: 'DELETE',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (res.ok) {
      lastTasksEtag = null;
    }
    return res.ok;
  } catch (e) {
    console.error('API Delete Task Error:', e);
    return false;
  }
}

// ----------------------------------------------------
// Studio Expenses & Team Advances API
// ----------------------------------------------------

let lastExpensesEtag: string | null = null;
let lastExpensesData: StudioExpense[] = [];

export async function apiFetchExpenses(workspaceId?: string): Promise<StudioExpense[]> {
  try {
    const url = workspaceId
      ? `/api/expenses?workspaceId=${encodeURIComponent(workspaceId)}`
      : `/api/expenses`;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (lastExpensesEtag) {
      headers['If-None-Match'] = lastExpensesEtag;
    }

    const res = await fetch(url, {
      cache: 'no-cache',
      headers,
    });

    if (res.status === 304) {
      return lastExpensesData;
    }

    if (res.ok) {
      const etag = res.headers.get('ETag');
      if (etag) lastExpensesEtag = etag;
      const data = await res.json();
      if (data && Array.isArray(data.expenses)) {
        lastExpensesData = data.expenses;
        return data.expenses as StudioExpense[];
      }
    }
  } catch (e) {
    console.error('API Fetch Expenses Error:', e);
  }
  return lastExpensesData.length > 0 ? lastExpensesData : [];
}

export async function apiSaveExpense(expense: StudioExpense): Promise<StudioExpense> {
  try {
    const res = await fetch('/api/expenses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
      },
      body: JSON.stringify(expense),
    });
    if (res.ok) {
      lastExpensesEtag = null;
      const data = await res.json();
      if (data && data.expense) {
        return data.expense;
      }
    }
  } catch (e) {
    console.error('API Save Expense Error:', e);
  }
  return expense;
}

export async function apiDeleteExpense(id: string, workspaceId?: string): Promise<boolean> {
  try {
    const url = workspaceId
      ? `/api/expenses?id=${encodeURIComponent(id)}&workspaceId=${encodeURIComponent(workspaceId)}`
      : `/api/expenses?id=${encodeURIComponent(id)}`;
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { 'Cache-Control': 'no-cache' },
    });
    if (res.ok) {
      lastExpensesEtag = null;
    }
    return res.ok;
  } catch (e) {
    console.error('API Delete Expense Error:', e);
    return false;
  }
}
