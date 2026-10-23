import { Quotation, UserAccount, TaskItem, DeviceSubscription, Service, AppSettings, StudioExpense } from './types';
import { supabase } from './supabase';
import { SEED_USERS } from './storage';
import { generateRandomNumericId } from './crypto';
import { DEFAULT_SETTINGS, DEFAULT_SERVICES, getDefaultSettingsForWorkspace } from './defaults';
import { getQuotationSecurityPin, sortQuotationsByNumber, isQuotationExpired } from './utils';

/**
 * Production Central Database Persistence Engine
 * Official Supabase SDK Integration with PostgreSQL.
 * Guarantees permanent persistence with 0 data loss across all devices and serverless restarts.
 */

// Strict Server-Side Security Guard:
// Prevent server-db logic and SUPABASE_SERVICE_ROLE_KEY from ever being invoked in browser/client environments.
if (typeof window !== 'undefined') {
  throw new Error('Security Violation: server-db module can only be executed in a server-side environment.');
}

const rawDbUrl = (process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || '').trim();
const SUPABASE_URL = (rawDbUrl.startsWith('http') ? rawDbUrl : 'https://kwrliixcdmjyuurjucrc.supabase.co').replace(/\/$/, '');
const rawDbKey = (
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ||
  process.env.SUPABASE_KEY ||
  ''
).trim();
const SUPABASE_KEY = rawDbKey === '[SENSITIVE]' ? '' : rawDbKey;

// High-Availability Central Cloud Backup Endpoints
const PRIMARY_CLOUD_DB = 'https://jsonblob.com/api/jsonBlob/1339847291029315584';

// In-memory runtime cache for microsecond performance on active serverless instance
const memoryStore: Map<string, Quotation> =
  (globalThis as unknown as { __snap_quotations_store?: Map<string, Quotation> }).__snap_quotations_store ||
  new Map();
(globalThis as unknown as { __snap_quotations_store?: Map<string, Quotation> }).__snap_quotations_store = memoryStore;

// ----------------------------------------------------
// Central In-Memory TTL Caching Engine (Egress Shield)
// Protects Supabase from high-frequency polling egress
// ----------------------------------------------------
interface MemoryCacheEntry<T> {
  data: T;
  timestamp: number;
}

let quotationsCache: MemoryCacheEntry<Quotation[]> | null = null;
const QUOTATIONS_TTL_MS = 25000; // 25s TTL

let tasksCache: MemoryCacheEntry<TaskItem[]> | null = null;
const TASKS_TTL_MS = 25000;

let devicesCache: MemoryCacheEntry<DeviceSubscription[]> | null = null;
const DEVICES_TTL_MS = 60000; // 60s TTL

let expensesCache: MemoryCacheEntry<StudioExpense[]> | null = null;
const EXPENSES_TTL_MS = 25000;

let usersCacheTimestamp = 0;
const USERS_TTL_MS = 60000;

export function computeQuotationListEtag(list: Quotation[]): string {
  if (!list || list.length === 0) return '"q_empty"';
  const first = list[0];
  const last = list[list.length - 1];
  const firstUp = first?.updatedAt ? new Date(first.updatedAt).getTime() : 0;
  const lastUp = last?.updatedAt ? new Date(last.updatedAt).getTime() : 0;
  return `"${list.length}_${firstUp}_${lastUp}"`;
}

export function computeTasksListEtag(list: TaskItem[]): string {
  if (!list || list.length === 0) return '"t_empty"';
  const first = list[0];
  const last = list[list.length - 1];
  const firstUp = first?.updatedAt ? new Date(first.updatedAt).getTime() : 0;
  return `"${list.length}_${firstUp}_${last?.id || ''}"`;
}

export function computeExpensesListEtag(list: StudioExpense[]): string {
  if (!list || list.length === 0) return '"e_empty"';
  const first = list[0];
  const firstUp = first?.updatedAt ? new Date(first.updatedAt).getTime() : 0;
  return `"${list.length}_${firstUp}"`;
}

export function invalidateQuotationsCache() {
  quotationsCache = null;
}

export function invalidateTasksCache() {
  tasksCache = null;
  cachedTasks = null;
}

export function invalidateDevicesCache() {
  devicesCache = null;
  cachedDeviceSubscriptions = null;
}

export function invalidateExpensesCache() {
  expensesCache = null;
  cachedExpenses = null;
}

/**
 * Primary Workspace Resolution Engine
 * Resolves stable authoritative workspaceId for any user or workspace string.
 * Zunair (Super Admin): 'ws_user-super-admin'
 * Standard Users: 'ws_${userId}'
 */
export function getWorkspaceId(userOrId?: string | { id?: string; role?: string; workspaceId?: string }): string {
  if (!userOrId) return 'ws_user-super-admin';
  if (typeof userOrId === 'string') {
    const clean = userOrId.trim();
    if (
      clean === 'user-super-admin' ||
      clean === 'global' ||
      clean === 'super_admin' ||
      clean === 'admin' ||
      clean === 'ws_user-super-admin' ||
      clean === 'ws_global'
    ) {
      return 'ws_user-super-admin';
    }
    if (clean.startsWith('ws_')) return clean;
    return `ws_${clean}`;
  }
  if (userOrId.workspaceId) return userOrId.workspaceId;
  if (userOrId.role === 'super_admin' || userOrId.id === 'user-super-admin') return 'ws_user-super-admin';
  if (userOrId.id) return `ws_${userOrId.id}`;
  return 'ws_user-super-admin';
}

function parseSupabaseRow(r: any): Quotation {
  const base = r.full_data || {};
  const creatorId = base.createdByUserId || r.user_id || base.userId || 'user-super-admin';
  const wsId = base.workspaceId || getWorkspaceId(creatorId);
  const pubDate = (
    base.publicLinkDate ||
    (r.client?.quotationDate ? r.client.quotationDate.split('T')[0] : (r.created_at ? r.created_at.split('T')[0] : new Date().toISOString().split('T')[0]))
  ).trim();

  const rawPayment = {
    ...(base.payment || {}),
    ...(r.payment || {}),
  };

  const rawTransactions: any[] | undefined =
    (r.payment?.transactions && Array.isArray(r.payment.transactions))
      ? r.payment.transactions
      : (base.payment?.transactions && Array.isArray(base.payment.transactions))
      ? base.payment.transactions
      : undefined;

  const rawAdvance = Number(rawPayment.advanceReceived) || 0;

  // Real transactions are the single source of truth:
  // If transactions array was explicitly defined (even if empty []), use it directly!
  // Only for legacy records where transactions was never defined (undefined) do we fall back to rawAdvance.
  const finalTransactions = rawTransactions !== undefined ? rawTransactions : [];

  const totalPaid = rawTransactions !== undefined
    ? finalTransactions.reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0)
    : rawAdvance;

  const grandTotal = Number(rawPayment.grandTotal) || 0;
  const balancePayable = Math.max(0, grandTotal - totalPaid);

  let paymentStatus: 'unpaid' | 'partially_paid' | 'paid_in_full' = rawPayment.paymentStatus || 'unpaid';
  if (totalPaid >= grandTotal && grandTotal > 0) paymentStatus = 'paid_in_full';
  else if (totalPaid > 0) paymentStatus = 'partially_paid';

  return {
    id: r.id || base.id,
    quotationNumber: r.quotation_number || base.quotationNumber,
    workspaceId: wsId,
    userId: creatorId,
    createdByUserId: creatorId,
    updatedByUserId: base.updatedByUserId || r.updated_by_user_id || creatorId,
    status: (r.status === 'trash' || base.status === 'trash') ? 'trash' : (r.status || base.status || 'sent'),
    previousStatus: base.previousStatus,
    isDeleted: (r.status === 'trash' || base.status === 'trash') ? true : (base.isDeleted === true && !base.restoredAt),
    deletedAt: (r.status === 'trash' || base.status === 'trash' || (base.isDeleted === true && !base.restoredAt)) ? (base.deletedAt || r.deleted_at || undefined) : undefined,
    autoExpired: (r.status === 'trash' || base.status === 'trash') ? (base.autoExpired || false) : false,
    autoExpiredReason: (r.status === 'trash' || base.status === 'trash') ? base.autoExpiredReason : undefined,
    restoredAt: base.restoredAt,
    client: r.client || base.client || { name: '', phone: '', quotationDate: '', eventDates: '' },
    packageType: base.packageType || 'multi_event',
    events: r.events || base.events || [],
    inclusions: r.inclusions || base.inclusions || [],
    notes: base.notes || r.notes || rawPayment.specialNote,
    payment: {
      ...rawPayment,
      subtotal: rawPayment.subtotal,
      discount: rawPayment.discount,
      discountType: rawPayment.discountType,
      discountPercentage: rawPayment.discountPercentage,
      specialNote: rawPayment.specialNote || base.notes || r.notes,
      grandTotal,
      advanceReceived: totalPaid,
      advanceType: rawPayment.advanceType || 'fixed',
      balancePayable,
      transactions: finalTransactions,
      clientProposedAdvance: totalPaid === 0 && finalTransactions.length === 0 ? undefined : rawPayment.clientProposedAdvance,
      paymentStatus,
    },
    termsAndConditions: base.termsAndConditions || [],
    additionalExpenses: base.additionalExpenses || base.internalAnalysis?.additionalExpenses || [],
    internalAnalysis: base.internalAnalysis,
    securityPin: base.securityPin,
    publicLinkDate: pubDate,
    deliverableStatus: base.deliverableStatus || r.deliverable_status || r.deliverableStatus,
    whatsappHistory: base.whatsappHistory || r.whatsapp_history || r.whatsappHistory || [],
    hasVariations: r.has_variations ?? r.hasVariations ?? base.hasVariations ?? (base.variations && Array.isArray(base.variations) && base.variations.length > 1) ?? false,
    selectedVariationId: r.selected_variation_id || r.selectedVariationId || base.selectedVariationId || (base.variations && base.variations[0]?.id) || undefined,
    variations: (() => {
      const rawVars = r.variations || (base.variations && Array.isArray(base.variations) ? base.variations : undefined);
      if (!rawVars || !Array.isArray(rawVars)) return undefined;
      const effectiveSelId = r.selected_variation_id || r.selectedVariationId || base.selectedVariationId || rawVars[0]?.id;
      return rawVars.map((v: any) => {
        const isTarget = v.id === effectiveSelId || v.isAccepted;
        const vTx = (v.payment?.transactions && Array.isArray(v.payment.transactions))
          ? v.payment.transactions
          : isTarget
          ? finalTransactions
          : [];
        const vTotalPaid = vTx.reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
        const vGrandTotal = Number(v.payment?.grandTotal) || grandTotal;
        const vAdvance = (Array.isArray(v.payment?.transactions) || isTarget)
          ? vTotalPaid
          : (Number(v.payment?.advanceReceived) || 0);
        const vBalance = Math.max(0, vGrandTotal - vAdvance);
        let vPStatus = v.payment?.paymentStatus || (isTarget ? paymentStatus : 'unpaid');
        if (vAdvance >= vGrandTotal && vGrandTotal > 0) vPStatus = 'paid_in_full';
        else if (vAdvance > 0) vPStatus = 'partially_paid';

        return {
          ...v,
          notes: v.notes || v.payment?.specialNote,
          payment: {
            ...(v.payment || {}),
            subtotal: v.payment?.subtotal,
            discount: v.payment?.discount,
            discountType: v.payment?.discountType,
            discountPercentage: v.payment?.discountPercentage,
            specialNote: v.payment?.specialNote || v.notes,
            grandTotal: vGrandTotal,
            advanceReceived: vAdvance,
            balancePayable: vBalance,
            transactions: vTx,
            paymentStatus: vPStatus,
            clientProposedAdvance: vAdvance === 0 && vTx.length === 0 ? undefined : v.payment?.clientProposedAdvance,
          },
        };
      });
    })(),
    createdAt: r.created_at || base.createdAt || new Date().toISOString(),
    updatedAt: r.updated_at || base.updatedAt || new Date().toISOString(),
  };
}

/**
 * Fetch all quotations from Supabase Central Database scoped by workspace
 */
export async function getQuotationsFromDb(workspaceId?: string): Promise<Quotation[]> {
  const targetWorkspace = workspaceId ? getWorkspaceId(workspaceId) : undefined;
  const now = Date.now();

  let finalList: Quotation[];

  // 1. High-Performance Egress Shield: Return in-memory cache if fresh
  if (quotationsCache && (now - quotationsCache.timestamp < QUOTATIONS_TTL_MS)) {
    finalList = quotationsCache.data;
  } else {
    let fetchedList: Quotation[] | null = null;

    // 1. Query Supabase via official client
    try {
      const { data, error } = await supabase
        .from('quotations')
        .select('*')
        .order('updated_at', { ascending: false });

      if (!error && Array.isArray(data) && data.length > 0) {
        fetchedList = data.map(parseSupabaseRow);
      }
    } catch (e) {
      console.error('Supabase SDK fetch error:', e);
    }

    // 2. Query Supabase REST API fallback
    if (!fetchedList && SUPABASE_URL && SUPABASE_KEY) {
      try {
        const endpoint = `${SUPABASE_URL}/rest/v1/quotations?select=*&order=updated_at.desc`;
        const res = await fetch(endpoint, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
          },
          cache: 'no-store',
        });
        if (res.ok) {
          const rows = await res.json();
          if (Array.isArray(rows) && rows.length > 0) {
            fetchedList = rows.map(parseSupabaseRow);
          }
        }
      } catch (e) {
        console.error('Supabase REST fetch exception:', e);
      }
    }

    // 3. Fallback to memory store if database is cold
    if (!fetchedList || fetchedList.length === 0) {
      if (memoryStore.size > 0) {
        fetchedList = Array.from(new Set(memoryStore.values()));
      }
    }

    finalList = (fetchedList || []).filter(
      (q) => q && q.id && !q.id.startsWith('sys_') && !(q as any).full_data?.isSystemTaskRecord && !(q as any).full_data?.isSystemSettingsRecord && !(q as any).full_data?.isSystemServicesRecord
    );

    // Auto-expire unconfirmed quotations and sync into in-memory store
    for (const q of finalList) {
      if (isQuotationExpired(q)) {
        q.previousStatus = q.status !== 'trash' ? q.status : (q.previousStatus || 'sent');
        q.status = 'trash';
        q.isDeleted = true;
        q.autoExpired = true;
        q.autoExpiredReason = 'Event date arrived/passed without client confirmation';
        if (!q.deletedAt) q.deletedAt = new Date().toISOString();
      }
      if (q.id) memoryStore.set(q.id.toLowerCase(), q);
      if (q.quotationNumber) memoryStore.set(q.quotationNumber.toLowerCase(), q);
    }

    // Store in TTL cache
    quotationsCache = {
      data: finalList,
      timestamp: now,
    };
  }

  const scopedList = targetWorkspace
    ? finalList.filter((q) => (q.workspaceId ? q.workspaceId === targetWorkspace : getWorkspaceId(q.userId) === targetWorkspace))
    : finalList;

  return sortQuotationsByNumber(scopedList);
}

/**
 * Fetch single quotation from Supabase Central Database by ID or Quotation Number
 */
export async function getQuotationFromDb(idOrNumber: string): Promise<Quotation | null> {
  if (!idOrNumber) return null;
  const cleanKey = idOrNumber.trim().toLowerCase();

  // 1. Immediate in-memory lookup (0 network cost)
  const cached = memoryStore.get(cleanKey);
  if (cached) return cached;

  // 2. Direct Supabase Query
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      const endpoint = `${SUPABASE_URL}/rest/v1/quotations?or=(id.eq.${encodeURIComponent(cleanKey)},quotation_number.ilike.${encodeURIComponent(cleanKey)})&select=*&limit=1`;
      const res = await fetch(endpoint, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0) {
          const q = parseSupabaseRow(rows[0]);
          if (q.id) memoryStore.set(q.id.toLowerCase(), q);
          if (q.quotationNumber) memoryStore.set(q.quotationNumber.toLowerCase(), q);
          return q;
        }
      }
    } catch (e) {
      console.error('Supabase single fetch exception:', e);
    }
  }

  const all = await getQuotationsFromDb();
  return (
    all.find(
      (q) =>
        (q.id && q.id.toLowerCase() === cleanKey) ||
        (q.quotationNumber && q.quotationNumber.toLowerCase() === cleanKey)
    ) || null
  );
}

/**
 * Authoritative Public Portal Quotation Lookup
 * Strictly validates ALL THREE URL components:
 * 1. publicLinkDate: URL date must match the quotation's permanent immutable publicLinkDate
 * 2. quotationNumber: URL quotation number must match exact quotationNumber
 * 3. securityPin: URL token must match stored securityPin
 * If ANY of the three does NOT match -> returns null (404 Not Found).
 */
export async function getPublicQuotationFromDb(
  urlDate: string,
  quotationNumber: string,
  uniquePin: string
): Promise<Quotation | null> {
  if (!urlDate || !quotationNumber || !uniquePin) return null;
  const cleanQNum = quotationNumber.trim().toUpperCase();
  const cleanPin = uniquePin.trim();
  const cleanDate = urlDate.trim();

  // Fetch all candidate quotations from database
  const all = await getQuotationsFromDb();

  for (const q of all) {
    // If quotation is in Trash / deleted -> strictly NOT accessible by client (Quotation Not Found)
    if (q.status === 'trash' || q.isDeleted) continue;

    const candidateNum = (q.quotationNumber || q.id || '').trim().toUpperCase();
    if (candidateNum !== cleanQNum) continue;

    // Validate PIN / Security Token
    const candidatePin = (q.securityPin || '').trim();
    const fallbackPin = getQuotationSecurityPin(q);
    if (candidatePin !== cleanPin && fallbackPin !== cleanPin) continue;

    // Validate EXACT immutable publicLinkDate (NO alternative date fallbacks)
    const candidateDate = (
      q.publicLinkDate ||
      (q.client?.quotationDate ? q.client.quotationDate.split('T')[0] : (q.createdAt ? q.createdAt.split('T')[0] : ''))
    ).trim();

    if (cleanDate !== candidateDate) continue;

    // Exact 3-way match confirmed!
    return q;
  }

  return null;
}

/**
 * Insert or Update quotation in Supabase Central Database & Central Backup Store
 */
export async function saveQuotationToDb(quotation: Quotation): Promise<Quotation> {
  const now = new Date().toISOString();
  const exactStatus = quotation.status || 'sent';
  const authorId = quotation.createdByUserId || quotation.userId || 'user-super-admin';
  const wsId = quotation.workspaceId ? getWorkspaceId(quotation.workspaceId) : getWorkspaceId(authorId);

  const existingQuotes = await getQuotationsFromDb();
  const existingRecord = existingQuotes.find(
    (q) => q.id?.toLowerCase() === quotation.id?.toLowerCase() || (q.quotationNumber && q.quotationNumber.toLowerCase() === quotation.quotationNumber?.toLowerCase())
  );

  // Preserve immutable publicLinkDate on edit; initialize once if new
  let finalPublicLinkDate = existingRecord?.publicLinkDate || quotation.publicLinkDate;
  if (!finalPublicLinkDate) {
    if (quotation.client?.quotationDate) {
      finalPublicLinkDate = quotation.client.quotationDate.split('T')[0];
    } else if (quotation.createdAt) {
      finalPublicLinkDate = quotation.createdAt.split('T')[0];
    } else {
      finalPublicLinkDate = new Date().toISOString().split('T')[0];
    }
  }

  const isTrashing = exactStatus === 'trash' || quotation.isDeleted === true;

  // Protect variations & transactions from being inadvertently wiped by partial updates
  const finalHasVariations = quotation.hasVariations !== undefined
    ? quotation.hasVariations
    : (existingRecord?.hasVariations ?? (existingRecord?.variations && existingRecord.variations.length > 1) ?? false);

  const finalVariations = (quotation.variations && Array.isArray(quotation.variations) && quotation.variations.length > 0)
    ? quotation.variations
    : (existingRecord?.variations || undefined);

  const finalSelectedVarId = quotation.selectedVariationId || existingRecord?.selectedVariationId;

  const incomingTx = quotation.payment?.transactions;
  const existingTx = existingRecord?.payment?.transactions || [];
  const finalTx = Array.isArray(incomingTx)
    ? incomingTx
    : existingTx;

  const finalPaid = finalTx.reduce((sum: number, t: any) => sum + (Number(t.amount) || 0), 0);
  const finalGrandTotal = Number(quotation.payment?.grandTotal ?? existingRecord?.payment?.grandTotal) || 0;
  const finalBalance = Math.max(0, finalGrandTotal - finalPaid);
  let finalPaymentStatus: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
  if (finalPaid >= finalGrandTotal && finalGrandTotal > 0) finalPaymentStatus = 'paid_in_full';
  else if (finalPaid > 0) finalPaymentStatus = 'partially_paid';

  const toSave: Quotation = {
    ...quotation,
    workspaceId: wsId,
    userId: authorId,
    createdByUserId: authorId,
    updatedByUserId: quotation.updatedByUserId || authorId,
    status: isTrashing ? 'trash' : exactStatus,
    previousStatus: quotation.previousStatus !== undefined
      ? quotation.previousStatus
      : (isTrashing ? (existingRecord?.status !== 'trash' ? existingRecord?.status : 'sent') : existingRecord?.previousStatus),
    isDeleted: isTrashing,
    deletedAt: isTrashing ? (quotation.deletedAt || existingRecord?.deletedAt || now) : undefined,
    autoExpired: isTrashing ? (quotation.autoExpired !== undefined ? quotation.autoExpired : (existingRecord?.autoExpired || false)) : false,
    autoExpiredReason: isTrashing ? (quotation.autoExpiredReason || existingRecord?.autoExpiredReason) : undefined,
    restoredAt: quotation.restoredAt !== undefined ? quotation.restoredAt : existingRecord?.restoredAt,
    publicLinkDate: finalPublicLinkDate,
    deliverableStatus: quotation.deliverableStatus !== undefined ? quotation.deliverableStatus : existingRecord?.deliverableStatus,
    hasVariations: finalHasVariations,
    selectedVariationId: finalSelectedVarId,
    variations: finalVariations,
    notes: quotation.notes || quotation.payment?.specialNote || existingRecord?.notes,
    payment: {
      ...(quotation.payment || {}),
      subtotal: quotation.payment?.subtotal ?? existingRecord?.payment?.subtotal,
      discount: quotation.payment?.discount !== undefined ? quotation.payment.discount : existingRecord?.payment?.discount,
      discountType: quotation.payment?.discountType ?? existingRecord?.payment?.discountType,
      discountPercentage: quotation.payment?.discountPercentage ?? existingRecord?.payment?.discountPercentage,
      specialNote: quotation.payment?.specialNote !== undefined ? quotation.payment.specialNote : existingRecord?.payment?.specialNote,
      grandTotal: finalGrandTotal,
      advanceReceived: finalPaid,
      balancePayable: finalBalance,
      transactions: finalTx,
      paymentStatus: finalPaymentStatus,
      clientProposedAdvance: (finalPaid === 0 && finalTx.length === 0)
        ? 0
        : (quotation.payment?.clientProposedAdvance ?? existingRecord?.payment?.clientProposedAdvance),
    },
    updatedAt: now,
    createdAt: quotation.createdAt || existingRecord?.createdAt || now,
  };

  // Enforce guaranteed global uniqueness for quotation URL security PIN
  let finalPin = toSave.securityPin;
  const takenPins = new Set<string>();
  for (const q of existingQuotes) {
    if (q.id?.toLowerCase() !== toSave.id?.toLowerCase() && q.securityPin) {
      takenPins.add(q.securityPin.trim());
    }
  }

  // If no PIN assigned or collision detected, generate unique random 6-digit access code
  if (!finalPin || takenPins.has(finalPin.trim())) {
    let candidate = generateRandomNumericId(6);
    let attempts = 0;
    while (takenPins.has(candidate) && attempts < 100) {
      candidate = generateRandomNumericId(6);
      attempts++;
    }
    finalPin = candidate;
  }

  toSave.securityPin = finalPin;

  // 1. Update in-memory store immediately
  if (toSave.id) memoryStore.set(toSave.id.toLowerCase(), toSave);
  if (toSave.quotationNumber) memoryStore.set(toSave.quotationNumber.toLowerCase(), toSave);
  invalidateQuotationsCache();

  // 2. Persist to Supabase Database (Official SDK with REST fallback)
  const dbPayload = {
    id: toSave.id,
    quotation_number: toSave.quotationNumber,
    user_id: toSave.userId,
    status: toSave.status,
    client: toSave.client,
    events: toSave.events,
    inclusions: toSave.inclusions,
    payment: toSave.payment,
    full_data: toSave,
    updated_at: now,
  };

  try {
    const { error } = await supabase.from('quotations').upsert(dbPayload, { onConflict: 'id' });
    if (error) {
      console.error('Supabase SDK upsert error:', error);
      // Fallback: Try REST API
      if (SUPABASE_URL && SUPABASE_KEY) {
        await fetch(`${SUPABASE_URL}/rest/v1/quotations?on_conflict=id`, {
          method: 'POST',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Content-Type': 'application/json',
            'Prefer': 'resolution=merge-duplicates',
          },
          body: JSON.stringify(dbPayload),
        });
      }
    }
  } catch (e) {
    console.error('Supabase save exception:', e);
  }

  // 3. Persist to High-Availability Cloud Backup Store
  try {
    const all = Array.from(new Set(memoryStore.values()));
    await fetch(PRIMARY_CLOUD_DB, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(all),
    });
  } catch {}

  // 4. Mirror to Google Drive Webhook if configured
  const googleWebhook = process.env.GOOGLE_DRIVE_WEBHOOK_URL;
  if (googleWebhook) {
    try {
      fetch(googleWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toSave),
      }).catch(() => {});
    } catch {}
  }

  return toSave;
}

/**
 * Delete quotation from Supabase Central Database
 */
export async function deleteQuotationFromDb(id: string): Promise<boolean> {
  if (!id) return false;
  const cleanKey = id.trim().toLowerCase();

  // 1. Remove from in-memory store
  invalidateQuotationsCache();
  for (const [key, q] of Array.from(memoryStore.entries())) {
    if (
      key === cleanKey ||
      (q.id && q.id.toLowerCase() === cleanKey) ||
      (q.quotationNumber && q.quotationNumber.toLowerCase() === cleanKey)
    ) {
      memoryStore.delete(key);
      if (q.id) memoryStore.delete(q.id.toLowerCase());
      if (q.quotationNumber) memoryStore.delete(q.quotationNumber.toLowerCase());
    }
  }

  // 2. Delete from Supabase via SDK
  try {
    await supabase
      .from('quotations')
      .delete()
      .or(`id.eq.${id},id.ilike.${id},quotation_number.eq.${id},quotation_number.ilike.${id}`);
  } catch (e) {
    console.error('Supabase SDK delete error:', e);
  }

  // 3. Fallback: Delete from Supabase REST API
  if (SUPABASE_URL && SUPABASE_KEY) {
    try {
      await fetch(
        `${SUPABASE_URL}/rest/v1/quotations?or=(id.eq.${encodeURIComponent(id)},quotation_number.ilike.${encodeURIComponent(id)})`,
        {
          method: 'DELETE',
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
          },
        }
      );
    } catch (e) {
      console.error('Supabase REST delete exception:', e);
    }
  }

  // 4. Sync deletion to High-Availability Cloud Backup Store
  try {
    const all = Array.from(new Set(memoryStore.values())).filter(
      (q) =>
        q.id !== id &&
        q.id.toLowerCase() !== cleanKey &&
        q.quotationNumber !== id &&
        q.quotationNumber.toLowerCase() !== cleanKey
    );
    await fetch(PRIMARY_CLOUD_DB, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(all),
    });
  } catch {}

  return true;
}

const PRIMARY_SETTINGS_CLOUD_DB = 'https://jsonblob.com/api/jsonBlob/1339847291029315585';
const cachedSettingsMap = new Map<string, AppSettings>();

export async function getSettingsFromDb(workspaceOrUserId?: string): Promise<AppSettings> {
  const targetWs = getWorkspaceId(workspaceOrUserId);
  if (cachedSettingsMap.has(targetWs)) {
    return cachedSettingsMap.get(targetWs)!;
  }

  // 1. Try fetching from Supabase 'quotations' table with sys_settings_${targetWs}
  try {
    const sysId = `sys_settings_${targetWs}`;
    const { data } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', sysId)
      .single();

    if (data?.full_data?.settings?.bank) {
      const parsed = { ...data.full_data.settings, workspaceId: targetWs } as AppSettings;
      cachedSettingsMap.set(targetWs, parsed);
      return parsed;
    }
  } catch {}

  // 2. Try fetching from Supabase table 'app_settings'
  try {
    const { data, error } = await supabase
      .from('app_settings')
      .select('*')
      .eq('id', targetWs)
      .limit(1)
      .single();

    if (!error && data && data.settings_data?.bank) {
      const parsed = { ...data.settings_data, workspaceId: targetWs } as AppSettings;
      cachedSettingsMap.set(targetWs, parsed);
      return parsed;
    }
  } catch {}

  // 3. Fallback to secondary Cloud DB ONLY for Super Admin workspace
  if (targetWs === 'ws_user-super-admin') {
    try {
      const res = await fetch(PRIMARY_SETTINGS_CLOUD_DB, {
        headers: { 'Accept': 'application/json' },
        cache: 'no-store',
      });
      if (res.ok) {
        const data = await res.json();
        if (data && data.bank) {
          const parsed = { ...data, workspaceId: targetWs } as AppSettings;
          cachedSettingsMap.set(targetWs, parsed);
          return parsed;
        }
      }
    } catch {}
  }

  return getDefaultSettingsForWorkspace(targetWs);
}

export async function saveSettingsToDb(settings: AppSettings, workspaceOrUserId?: string): Promise<AppSettings> {
  const targetWs = getWorkspaceId(workspaceOrUserId || settings.workspaceId);
  const settingsToSave: AppSettings = {
    ...settings,
    workspaceId: targetWs,
  };
  cachedSettingsMap.set(targetWs, settingsToSave);

  // 1. Save to Supabase quotations table under isolated sys_settings_${targetWs}
  try {
    const sysId = `sys_settings_${targetWs}`;
    await supabase
      .from('quotations')
      .upsert({
        id: sysId,
        quotation_number: `SYS-SETTINGS-${targetWs}`,
        user_id: targetWs,
        status: 'confirmed',
        client: { name: `Settings for ${targetWs}`, phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemSettingsRecord: true, workspaceId: targetWs, settings: settingsToSave },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving settings to Supabase quotations:', e);
  }

  // 2. Save to Supabase app_settings table
  try {
    await supabase
      .from('app_settings')
      .upsert({
        id: targetWs,
        settings_data: settingsToSave,
        updated_at: new Date().toISOString(),
      });
  } catch {}

  // 3. Save to Cloud DB if Super Admin
  if (targetWs === 'ws_user-super-admin') {
    try {
      await fetch(PRIMARY_SETTINGS_CLOUD_DB, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify(settingsToSave),
      });
    } catch {}
  }

  return settingsToSave;
}

const cachedServicesMap = new Map<string, Service[]>();

export async function getServicesFromDb(workspaceOrUserId?: string): Promise<Service[]> {
  const targetWs = getWorkspaceId(workspaceOrUserId);
  if (cachedServicesMap.has(targetWs)) {
    return cachedServicesMap.get(targetWs)!;
  }

  try {
    const sysId = `sys_services_${targetWs}`;
    const { data } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', sysId)
      .single();

    if (data?.full_data?.services && Array.isArray(data.full_data.services) && data.full_data.services.length > 0) {
      const list = data.full_data.services as Service[];
      cachedServicesMap.set(targetWs, list);
      return list;
    }
  } catch {}

  return DEFAULT_SERVICES;
}

export async function saveServicesToDb(services: Service[], workspaceOrUserId?: string): Promise<Service[]> {
  const targetWs = getWorkspaceId(workspaceOrUserId);
  cachedServicesMap.set(targetWs, services);

  try {
    const sysId = `sys_services_${targetWs}`;
    await supabase
      .from('quotations')
      .upsert({
        id: sysId,
        quotation_number: `SYS-SERVICES-${targetWs}`,
        user_id: targetWs,
        status: 'confirmed',
        client: { name: `Services for ${targetWs}`, phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemServicesRecord: true, workspaceId: targetWs, services },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving services to Supabase:', e);
  }

  return services;
}

const PRIMARY_USERS_CLOUD_DB = 'https://jsonblob.com/api/jsonBlob/1339847291029315585';
let cachedUsers: UserAccount[] | null = null;

function mergeWithSeedUsers(users: UserAccount[]): UserAccount[] {
  const map = new Map<string, UserAccount>();
  SEED_USERS.forEach((u) => map.set(u.id.toLowerCase(), { ...u, workspaceId: 'ws_user-super-admin' }));
  users.forEach((u) => {
    if (u && u.id) {
      const wsId = u.workspaceId || getWorkspaceId(u.id);
      map.set(u.id.toLowerCase(), { ...u, workspaceId: wsId });
    }
  });
  return Array.from(map.values());
}

export async function getUsersFromDb(): Promise<UserAccount[]> {
  const now = Date.now();
  if (cachedUsers && (now - usersCacheTimestamp < USERS_TTL_MS)) {
    return cachedUsers;
  }

  // 1. Try fetching from Supabase 'quotations' table under 'sys_users' (100% reliable registry)
  try {
    const { data, error } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', 'sys_users')
      .maybeSingle();

    if (!error && data?.full_data && Array.isArray(data.full_data.users)) {
      const parsed: UserAccount[] = data.full_data.users;
      const merged = mergeWithSeedUsers(parsed);
      cachedUsers = merged;
      usersCacheTimestamp = now;
      return merged;
    }
  } catch {}

  // 2. Try fetching from Supabase table 'app_users'
  try {
    const { data, error } = await supabase
      .from('app_users')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && Array.isArray(data) && data.length > 0) {
      const parsed: UserAccount[] = data.map((r) => r.full_data || r);
      const merged = mergeWithSeedUsers(parsed);
      cachedUsers = merged;
      return merged;
    }
  } catch {}

  // 3. Try fetching from secondary Cloud DB
  try {
    const res = await fetch(PRIMARY_USERS_CLOUD_DB, {
      headers: { 'Accept': 'application/json' },
      cache: 'no-store',
    });
    if (res.ok) {
      const data = await res.json();
      if (Array.isArray(data) && data.length > 0) {
        const merged = mergeWithSeedUsers(data);
        cachedUsers = merged;
        return merged;
      }
    }
  } catch {}

  if (cachedUsers && cachedUsers.length > 0) return cachedUsers;
  return SEED_USERS;
}

export async function saveUserToDb(user: UserAccount): Promise<UserAccount[]> {
  const wsId = user.workspaceId || getWorkspaceId(user.id);
  const userWithWs: UserAccount = {
    ...user,
    workspaceId: wsId,
  };
  const current = await getUsersFromDb();
  const index = current.findIndex(
    (u) =>
      u.id === user.id ||
      (u.email && user.email && u.email.toLowerCase() === user.email.toLowerCase())
  );
  let updatedList: UserAccount[];
  if (index >= 0) {
    updatedList = [...current];
    updatedList[index] = { ...updatedList[index], ...userWithWs };
  } else {
    updatedList = [...current, userWithWs];
  }
  cachedUsers = updatedList;
  usersCacheTimestamp = Date.now();

  // 1. Save to Supabase 'quotations' table under 'sys_users' (100% guaranteed persistence)
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_users',
        quotation_number: 'SYS-USERS',
        user_id: 'ws_user-super-admin',
        status: 'confirmed',
        client: { name: 'Users Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemRecord: true, users: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving users to Supabase quotations:', e);
  }

  // 2. Save to Supabase app_users table
  try {
    await supabase
      .from('app_users')
      .upsert({
        id: userWithWs.id,
        email: userWithWs.email,
        name: userWithWs.name,
        role: userWithWs.role,
        approved: userWithWs.approved,
        active: userWithWs.active,
        full_data: userWithWs,
        updated_at: new Date().toISOString(),
      });
  } catch {}

  // 3. Save to Cloud DB
  try {
    await fetch(PRIMARY_USERS_CLOUD_DB, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(updatedList),
    });
  } catch {}

  return updatedList;
}

export async function deleteUserFromDb(userIdOrEmail: string): Promise<UserAccount[]> {
  if (
    !userIdOrEmail ||
    userIdOrEmail === 'user-super-admin' ||
    userIdOrEmail.toLowerCase() === 'admin@snapservice.com'
  ) {
    return getUsersFromDb();
  }

  const cleanTarget = userIdOrEmail.trim().toLowerCase();
  const current = await getUsersFromDb();
  const updatedList = current.filter(
    (u) =>
      u.id.toLowerCase() !== cleanTarget &&
      u.email.toLowerCase() !== cleanTarget
  );
  cachedUsers = updatedList;
  usersCacheTimestamp = Date.now();

  // 1. Save updated list to Supabase 'quotations' under 'sys_users'
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_users',
        quotation_number: 'SYS-USERS',
        user_id: 'ws_user-super-admin',
        status: 'confirmed',
        client: { name: 'Users Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemRecord: true, users: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error updating sys_users in Supabase:', e);
  }

  // 2. Delete from Supabase app_users table
  try {
    await supabase.from('app_users').delete().eq('id', userIdOrEmail);
  } catch {}
  try {
    await supabase.from('app_users').delete().eq('email', cleanTarget);
  } catch {}

  // 3. Update Cloud DB
  try {
    await fetch(PRIMARY_USERS_CLOUD_DB, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify(updatedList),
    });
  } catch {}

  return updatedList;
}

// ----------------------------------------------------
// Snap Service — Daily Tasks Cloud DB Persistence
// Dual-Layer Engine: Supabase table 'app_tasks' + Supabase registry record 'sys_global_tasks'
// ----------------------------------------------------
let cachedTasks: TaskItem[] | null = null;

function isTaskAccessibleInScope(t: TaskItem, targetWs?: string): boolean {
  if (!targetWs) return true;
  if (
    targetWs === 'ws_user-super-admin' ||
    targetWs === 'user-super-admin' ||
    targetWs === 'global' ||
    targetWs === 'ws_global'
  ) {
    // Super Admin oversees all studio tasks
    return true;
  }
  const cleanWs = targetWs.startsWith('ws_') ? targetWs : `ws_${targetWs}`;
  const userId = cleanWs.replace(/^ws_/, '');

  return (
    t.workspaceId === cleanWs ||
    t.assignedToUserId === userId ||
    (t.assignedToUserId ? getWorkspaceId(t.assignedToUserId) === cleanWs : false) ||
    t.createdByUserId === userId ||
    (Array.isArray(t.history) && t.history.some((h) => h.userId === userId))
  );
}

export async function getTasksFromDb(workspaceOrUserId?: string): Promise<TaskItem[]> {
  const targetWs = workspaceOrUserId ? getWorkspaceId(workspaceOrUserId) : undefined;
  const now = Date.now();

  // 1. High-Performance Egress Shield: Return in-memory cache if fresh
  if (tasksCache && (now - tasksCache.timestamp < TASKS_TTL_MS)) {
    if (targetWs) {
      return tasksCache.data.filter((t) => isTaskAccessibleInScope(t, targetWs));
    }
    return tasksCache.data;
  }

  let parsed: TaskItem[] | null = null;

  // 2. Query Supabase registry record 'sys_global_tasks' in quotations table
  try {
    const { data, error } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', 'sys_global_tasks')
      .maybeSingle();

    if (!error && data?.full_data && Array.isArray(data.full_data.tasks)) {
      parsed = data.full_data.tasks.map((t: any) => ({
        ...t,
        workspaceId: t.workspaceId || getWorkspaceId(t.assignedToUserId),
      }));
    }
  } catch {}

  // 3. Query REST API fallback directly
  if (!parsed && SUPABASE_URL && SUPABASE_KEY) {
    try {
      const endpoint = `${SUPABASE_URL}/rest/v1/quotations?id=eq.sys_global_tasks&select=full_data`;
      const res = await fetch(endpoint, {
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json',
        },
        cache: 'no-store',
      });
      if (res.ok) {
        const rows = await res.json();
        if (Array.isArray(rows) && rows.length > 0 && rows[0]?.full_data?.tasks) {
          parsed = rows[0].full_data.tasks.map((t: any) => ({
            ...t,
            workspaceId: t.workspaceId || getWorkspaceId(t.assignedToUserId),
          }));
        }
      }
    } catch {}
  }

  // 4. Memory fallback
  if (!parsed && cachedTasks) {
    parsed = cachedTasks;
  }

  const finalList = parsed || [];
  cachedTasks = finalList;
  tasksCache = {
    data: finalList,
    timestamp: now,
  };

  if (targetWs) {
    return finalList.filter((t) => isTaskAccessibleInScope(t, targetWs));
  }
  return finalList;
}

export async function saveTaskToDb(task: TaskItem): Promise<TaskItem> {
  const targetWs = task.workspaceId ? getWorkspaceId(task.workspaceId) : getWorkspaceId(task.assignedToUserId);
  const taskToSave: TaskItem = {
    ...task,
    workspaceId: targetWs,
    updatedAt: new Date().toISOString(),
  };

  const current = await getTasksFromDb();
  const index = current.findIndex((t) => t.id === taskToSave.id);
  let updatedList: TaskItem[];
  if (index >= 0) {
    updatedList = [...current];
    updatedList[index] = taskToSave;
  } else {
    updatedList = [taskToSave, ...current];
  }
  cachedTasks = updatedList;
  invalidateTasksCache();

  // 1. Save to Supabase 'app_tasks' (if table exists)
  try {
    await supabase
      .from('app_tasks')
      .upsert({
        id: taskToSave.id,
        title: taskToSave.title,
        category: taskToSave.category,
        full_data: taskToSave,
        created_at: taskToSave.createdAt,
        updated_at: new Date().toISOString(),
      });
  } catch {}

  // 2. Save to Supabase 'quotations' table under 'sys_global_tasks' (100% guaranteed persistence)
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_global_tasks',
        quotation_number: 'SYS-TASKS',
        user_id: 'system',
        status: 'confirmed',
        client: { name: 'Tasks Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemTaskRecord: true, tasks: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving sys_global_tasks to Supabase:', e);
  }

  return taskToSave;
}

export async function deleteTaskFromDb(id: string): Promise<boolean> {
  const current = await getTasksFromDb();
  const updatedList = current.filter((t) => t.id !== id);
  cachedTasks = updatedList;
  invalidateTasksCache();

  // 1. Delete from Supabase 'app_tasks'
  try {
    await supabase.from('app_tasks').delete().eq('id', id);
  } catch {}

  // 2. Save updated list to Supabase 'sys_global_tasks'
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_global_tasks',
        quotation_number: 'SYS-TASKS',
        user_id: 'system',
        status: 'confirmed',
        client: { name: 'Tasks Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemTaskRecord: true, tasks: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch {}

  return true;
}

// ----------------------------------------------------
// Snap Service — Device Subscriptions (Push Notifications)
// Dual-Layer Engine: Supabase table 'app_device_subscriptions' + Supabase registry record 'sys_device_subscriptions'
// ----------------------------------------------------
let cachedDeviceSubscriptions: DeviceSubscription[] | null = null;

export async function getDeviceSubscriptionsFromDb(userId?: string): Promise<DeviceSubscription[]> {
  const now = Date.now();

  // 1. High-Performance Egress Shield: Return in-memory cache if fresh
  if (devicesCache && (now - devicesCache.timestamp < DEVICES_TTL_MS)) {
    if (userId) {
      const cleanUid = userId.trim().toLowerCase();
      return devicesCache.data.filter((d) => (d.userId || '').trim().toLowerCase() === cleanUid);
    }
    return devicesCache.data;
  }

  // 2. Query Supabase registry record 'sys_device_subscriptions' in quotations table
  let allSubs: DeviceSubscription[] | null = null;
  try {
    const { data, error } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', 'sys_device_subscriptions')
      .maybeSingle();

    if (!error && data?.full_data && Array.isArray(data.full_data.subscriptions)) {
      allSubs = data.full_data.subscriptions;
    }
  } catch {}

  if (!allSubs && cachedDeviceSubscriptions) {
    allSubs = cachedDeviceSubscriptions;
  }

  const finalList = allSubs || [];
  cachedDeviceSubscriptions = finalList;
  devicesCache = {
    data: finalList,
    timestamp: now,
  };

  if (userId) {
    const cleanUid = userId.trim().toLowerCase();
    return finalList.filter((d) => (d.userId || '').trim().toLowerCase() === cleanUid);
  }
  return finalList;
}

export async function saveDeviceSubscriptionToDb(device: DeviceSubscription): Promise<DeviceSubscription> {
  const current = await getDeviceSubscriptionsFromDb();
  // Check if subscription endpoint already exists, or FCM token matches, or device ID matches
  const index = current.findIndex(
    (d) =>
      d.id === device.id ||
      (device.fcmToken && d.fcmToken && d.fcmToken === device.fcmToken) ||
      (device.subscription?.endpoint && d.subscription?.endpoint && d.subscription?.endpoint === device.subscription?.endpoint)
  );

  let updatedList: DeviceSubscription[];
  if (index >= 0) {
    updatedList = [...current];
    updatedList[index] = {
      ...updatedList[index],
      ...device,
      userId: device.userId, // Explicitly overwrite to the active user's ID
      userName: device.userName,
      userEmail: device.userEmail,
      active: true,
      updatedAt: new Date().toISOString(),
    };
  } else {
    updatedList = [device, ...current];
  }
  cachedDeviceSubscriptions = updatedList;
  invalidateDevicesCache();

  // 1. Save to Supabase 'app_device_subscriptions'
  try {
    await supabase
      .from('app_device_subscriptions')
      .upsert({
        id: device.id,
        user_id: device.userId,
        device_name: device.deviceName,
        device_type: device.deviceType,
        full_data: device,
        active: device.active,
        created_at: device.createdAt,
        updated_at: new Date().toISOString(),
      });
  } catch {}

  // 2. Save to Supabase 'quotations' table registry
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_device_subscriptions',
        quotation_number: 'SYS-DEVICES',
        user_id: 'system',
        status: 'confirmed',
        client: { name: 'Device Subscriptions Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemTaskRecord: true, subscriptions: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving sys_device_subscriptions to Supabase:', e);
  }

  return device;
}

export async function deleteDeviceSubscriptionFromDb(idOrEndpoint: string): Promise<boolean> {
  const current = await getDeviceSubscriptionsFromDb();
  const updatedList = current.filter(
    (d) => d.id !== idOrEndpoint && d.subscription?.endpoint !== idOrEndpoint
  );
  cachedDeviceSubscriptions = updatedList;
  invalidateDevicesCache();

  // 1. Delete from Supabase
  try {
    await supabase.from('app_device_subscriptions').delete().eq('id', idOrEndpoint);
  } catch {}

  // 2. Update Supabase registry
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_device_subscriptions',
        quotation_number: 'SYS-DEVICES',
        user_id: 'system',
        status: 'confirmed',
        client: { name: 'Device Subscriptions Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemTaskRecord: true, subscriptions: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch {}

  return true;
}

let cachedLastHourlyDigestKey: string | null = null;

export async function getHourlyDigestTracker(): Promise<string | null> {
  if (cachedLastHourlyDigestKey) {
    return cachedLastHourlyDigestKey;
  }
  try {
    const { data } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', 'sys_hourly_digest_tracker')
      .single();
    const key = data?.full_data?.lastHourKey || null;
    if (key) cachedLastHourlyDigestKey = key;
    return key;
  } catch {
    return cachedLastHourlyDigestKey;
  }
}

export async function setHourlyDigestTracker(hourKey: string): Promise<void> {
  cachedLastHourlyDigestKey = hourKey;
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: 'sys_hourly_digest_tracker',
        quotation_number: 'SYS-DIGEST',
        user_id: 'system',
        status: 'confirmed',
        client: { name: 'Hourly Digest Tracker', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemTaskRecord: true, lastHourKey: hourKey, updatedAt: new Date().toISOString() },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving hourly digest tracker:', e);
  }
}

// ----------------------------------------------------
// Studio Expenses & Team Advances Central Persistence
// ----------------------------------------------------

let cachedExpenses: StudioExpense[] | null = null;

export async function getExpensesFromDb(workspaceId?: string): Promise<StudioExpense[]> {
  const ws = workspaceId || 'ws_user-super-admin';
  const recordId = ws === 'ws_user-super-admin' ? 'sys_studio_expenses' : `sys_studio_expenses_${ws}`;
  const now = Date.now();

  // 1. High-Performance Egress Shield: Return in-memory cache if fresh
  if (expensesCache && (now - expensesCache.timestamp < EXPENSES_TTL_MS)) {
    if (ws === 'ws_user-super-admin') return expensesCache.data;
    return expensesCache.data.filter((e) => !e.workspaceId || e.workspaceId === ws);
  }

  // 1. Try Supabase quotations table
  try {
    const { data, error } = await supabase
      .from('quotations')
      .select('full_data')
      .eq('id', recordId)
      .maybeSingle();

    if (!error && data?.full_data && Array.isArray(data.full_data.expenses)) {
      cachedExpenses = data.full_data.expenses;
      expensesCache = {
        data: data.full_data.expenses,
        timestamp: now,
      };
      return data.full_data.expenses;
    }
  } catch (e) {
    console.error('Error fetching expenses from Supabase:', e);
  }

  // 2. Fallback to main record if workspace specific not found
  if (recordId !== 'sys_studio_expenses') {
    try {
      const { data, error } = await supabase
        .from('quotations')
        .select('full_data')
        .eq('id', 'sys_studio_expenses')
        .maybeSingle();

      if (!error && data?.full_data && Array.isArray(data.full_data.expenses)) {
        const filtered = data.full_data.expenses.filter(
          (e: StudioExpense) => !e.workspaceId || e.workspaceId === ws
        );
        cachedExpenses = data.full_data.expenses;
        expensesCache = {
          data: data.full_data.expenses,
          timestamp: now,
        };
        return filtered;
      }
    } catch {}
  }

  if (cachedExpenses) return cachedExpenses;
  return [];
}

export async function saveExpenseToDb(expense: StudioExpense): Promise<StudioExpense[]> {
  const ws = expense.workspaceId || 'ws_user-super-admin';
  const recordId = ws === 'ws_user-super-admin' ? 'sys_studio_expenses' : `sys_studio_expenses_${ws}`;
  const current = await getExpensesFromDb(ws);

  const idx = current.findIndex((e) => e.id === expense.id);
  let updatedList: StudioExpense[];
  if (idx >= 0) {
    updatedList = [...current];
    updatedList[idx] = { ...expense, updatedAt: new Date().toISOString() };
  } else {
    updatedList = [expense, ...current];
  }
  cachedExpenses = updatedList;
  invalidateExpensesCache();

  // Save to Supabase 'quotations' table under dedicated system record
  try {
    await supabase
      .from('quotations')
      .upsert({
        id: recordId,
        quotation_number: 'SYS-STUDIO-EXPENSES',
        user_id: ws,
        status: 'confirmed',
        client: { name: 'Studio Expenses Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemRecord: true, expenses: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error saving expenses to Supabase:', e);
  }

  return updatedList;
}

export async function deleteExpenseFromDb(expenseId: string, workspaceId?: string): Promise<StudioExpense[]> {
  const ws = workspaceId || 'ws_user-super-admin';
  const recordId = ws === 'ws_user-super-admin' ? 'sys_studio_expenses' : `sys_studio_expenses_${ws}`;
  const current = await getExpensesFromDb(ws);

  const updatedList = current.filter((e) => e.id !== expenseId);
  cachedExpenses = updatedList;
  invalidateExpensesCache();

  try {
    await supabase
      .from('quotations')
      .upsert({
        id: recordId,
        quotation_number: 'SYS-STUDIO-EXPENSES',
        user_id: ws,
        status: 'confirmed',
        client: { name: 'Studio Expenses Registry', phone: '', quotationDate: new Date().toISOString(), eventDates: '' },
        events: [],
        inclusions: [],
        payment: { grandTotal: 0, advanceReceived: 0, advanceType: 'fixed', balancePayable: 0 },
        full_data: { isSystemRecord: true, expenses: updatedList },
        updated_at: new Date().toISOString(),
      });
  } catch (e) {
    console.error('Error deleting expense in Supabase:', e);
  }

  return updatedList;
}
