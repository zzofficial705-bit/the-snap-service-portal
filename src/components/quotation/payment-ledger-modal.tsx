'use client';

import React, { useState, useEffect } from 'react';
import { Quotation, PaymentTransaction, PaymentMethod } from '@/lib/types';
import { storage } from '@/lib/storage';
import { apiSaveQuotation } from '@/lib/api-client';
import { formatCurrency, getTodayDateString } from '@/lib/utils';
import { generateSecureId } from '@/lib/crypto';
import { 
  X, 
  DollarSign, 
  Calendar, 
  CreditCard, 
  Landmark, 
  Wallet, 
  Plus, 
  Trash2, 
  Edit3, 
  Check, 
  Receipt, 
  Clock, 
  AlertCircle, 
  FileText,
  Building2,
  Phone,
  Sparkles
} from 'lucide-react';

interface PaymentLedgerModalProps {
  isOpen: boolean;
  onClose: () => void;
  quotation: Quotation;
  onQuotationUpdate: (updated: Quotation) => void;
}

export function PaymentLedgerModal({
  isOpen,
  onClose,
  quotation,
  onQuotationUpdate,
}: PaymentLedgerModalProps) {
  const [transactions, setTransactions] = useState<PaymentTransaction[]>(
    quotation.payment?.transactions || []
  );

  // New transaction form state
  const [newAmount, setNewAmount] = useState<number | ''>('');
  const [newDate, setNewDate] = useState<string>(getTodayDateString());
  const [newMethod, setNewMethod] = useState<PaymentMethod>('bank_transfer');
  const [newNotes, setNewNotes] = useState<string>('');

  // Editing transaction state
  const [editingTxId, setEditingTxId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState<number | ''>('');
  const [editDate, setEditDate] = useState<string>('');
  const [editMethod, setEditMethod] = useState<PaymentMethod>('bank_transfer');
  const [editNotes, setEditNotes] = useState<string>('');

  const [savingMsg, setSavingMsg] = useState<string>('');

  if (!isOpen) return null;

  const grandTotal = quotation.payment?.grandTotal || 0;
  const totalPaid = transactions.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const balancePayable = Math.max(0, grandTotal - totalPaid);

  let paymentStatus: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
  if (totalPaid >= grandTotal && grandTotal > 0) paymentStatus = 'paid_in_full';
  else if (totalPaid > 0) paymentStatus = 'partially_paid';

  const selectedVar = quotation.variations?.find(
    (v) => v.id === quotation.selectedVariationId || v.isAccepted
  );
  const clientProposedAdvance = Number(
    quotation.payment?.clientProposedAdvance || selectedVar?.payment?.clientProposedAdvance || 0
  );

  const syncAndSave = async (newTxList: PaymentTransaction[]) => {
    const calcPaid = newTxList.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const calcBalance = Math.max(0, grandTotal - calcPaid);

    let status: 'unpaid' | 'partially_paid' | 'paid_in_full' = 'unpaid';
    if (calcPaid >= grandTotal && grandTotal > 0) status = 'paid_in_full';
    else if (calcPaid > 0) status = 'partially_paid';

    let updatedVariations = quotation.variations;
    if (updatedVariations && updatedVariations.length > 0) {
      updatedVariations = updatedVariations.map((v) => {
        const isTarget = v.id === quotation.selectedVariationId || v.isAccepted;
        if (!isTarget) return v;
        const vGrandTotal = Number(v.payment?.grandTotal) || grandTotal;
        const vBalance = Math.max(0, vGrandTotal - calcPaid);
        return {
          ...v,
          payment: {
            ...v.payment,
            grandTotal: vGrandTotal,
            advanceReceived: calcPaid,
            balancePayable: vBalance,
            transactions: newTxList,
            paymentStatus: status,
            clientProposedAdvance: v.payment?.clientProposedAdvance ?? (clientProposedAdvance > 0 ? clientProposedAdvance : undefined),
          },
        };
      });
    }

    const updated: Quotation = {
      ...quotation,
      variations: updatedVariations,
      payment: {
        ...quotation.payment,
        advanceReceived: calcPaid,
        balancePayable: calcBalance,
        transactions: newTxList,
        paymentStatus: status,
        clientProposedAdvance: quotation.payment?.clientProposedAdvance ?? (clientProposedAdvance > 0 ? clientProposedAdvance : undefined),
      },
      updatedAt: new Date().toISOString(),
    };

    setTransactions(newTxList);
    storage.saveQuotationLocally(updated);
    onQuotationUpdate(updated);

    setSavingMsg('Syncing ledger to database...');
    try {
      await apiSaveQuotation(updated);
      setSavingMsg('✅ Saved and synced live!');
    } catch (e) {
      console.error('Error syncing payment to DB', e);
      setSavingMsg('✅ Saved locally');
    }
    setTimeout(() => setSavingMsg(''), 2500);
  };

  useEffect(() => {
    if (!isOpen) return;
    const existing = quotation.payment?.transactions || [];
    setTransactions(existing);
  }, [quotation.id, isOpen, quotation.payment?.transactions]);

  // Add new payment
  const handleAddPayment = async (e: React.FormEvent) => {
    e.preventDefault();
    const amt = Number(newAmount);
    if (!amt || amt <= 0) return;

    const newTx: PaymentTransaction = {
      id: generateSecureId('tx'),
      date: newDate || getTodayDateString(),
      amount: amt,
      method: newMethod,
      notes: newNotes.trim() || undefined,
      createdAt: new Date().toISOString(),
    };

    const nextList = [newTx, ...transactions];
    await syncAndSave(nextList);

    // Reset inputs
    setNewAmount('');
    setNewNotes('');
    setNewDate(getTodayDateString());
  };

  // Start editing transaction
  const handleStartEdit = (tx: PaymentTransaction) => {
    setEditingTxId(tx.id);
    setEditAmount(tx.amount);
    setEditDate(tx.date || getTodayDateString());
    setEditMethod(tx.method || 'bank_transfer');
    setEditNotes(tx.notes || '');
  };

  // Save edited transaction
  const handleSaveEdit = async () => {
    if (!editingTxId) return;
    const amt = Number(editAmount);
    if (!amt || amt <= 0) return;

    const nextList = transactions.map((t) =>
      t.id === editingTxId
        ? {
            ...t,
            amount: amt,
            date: editDate || getTodayDateString(),
            method: editMethod,
            notes: editNotes.trim() || undefined,
          }
        : t
    );

    await syncAndSave(nextList);
    setEditingTxId(null);
  };

  // Delete transaction
  const handleDeleteTx = async (id: string) => {
    if (confirm('Are you sure you want to delete this payment record?')) {
      const nextList = transactions.filter((t) => t.id !== id);
      await syncAndSave(nextList);
    }
  };

  const getMethodBadge = (method: PaymentMethod) => {
    switch (method) {
      case 'cash':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0 whitespace-nowrap">
            💵 Cash
          </span>
        );
      case 'bank_transfer':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-300 shrink-0 whitespace-nowrap">
            🏦 Bank Transfer
          </span>
        );
      case 'online':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-300 shrink-0 whitespace-nowrap">
            📱 Online / JazzCash / EasyPaisa
          </span>
        );
      case 'cheque':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 text-amber-800 border border-amber-300 shrink-0 whitespace-nowrap">
            📜 Cheque
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-slate-100 text-slate-700 shrink-0 whitespace-nowrap">
            💳 Other
          </span>
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4 overflow-y-auto">
      <div className="bg-white w-full max-w-3xl rounded-3xl shadow-2xl border-2 border-[#E5E0D5] overflow-hidden flex flex-col max-h-[92vh] animate-in fade-in zoom-in duration-200">
        {/* Modal Header */}
        <div className="bg-gradient-to-r from-[#0D4F4F] via-[#093A3A] to-[#1B2A4A] text-white p-5 flex items-center justify-between border-b border-[#D4AF37]/40 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-[#D4AF37] text-[#0D4F4F] flex items-center justify-center font-bold shadow-md shrink-0">
              <Receipt className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-serif font-bold text-lg text-white">Live Payment Ledger & Bill</h3>
                <span className="font-mono text-xs px-2 py-0.5 rounded-full bg-[#D4AF37]/20 border border-[#D4AF37]/50 text-[#D4AF37] font-bold">
                  {quotation.quotationNumber}
                </span>
              </div>
              <p className="text-xs text-[#C3DFDF] mt-0.5">
                Client: <span className="font-semibold text-white">{quotation.client.name || 'Unnamed Client'}</span> • {quotation.client.phone || 'No Phone'}
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-2 rounded-xl text-slate-300 hover:text-white hover:bg-white/10 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 md:p-6 overflow-y-auto space-y-6 flex-1 text-slate-800">
          {/* Status Message Notification */}
          {savingMsg && (
            <div className="p-3 bg-emerald-50 border border-emerald-300 text-emerald-800 text-xs rounded-xl font-bold flex items-center justify-between animate-pulse">
              <span>{savingMsg}</span>
            </div>
          )}

          {/* Top 4 Financial Summary Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            {/* Grand Total */}
            <div className="bg-[#FAF9F6] p-3.5 rounded-2xl border border-[#E5E0D5] flex flex-col justify-between">
              <span className="text-[11px] font-medium text-slate-500">Total Grand Bill</span>
              <span className="font-serif font-bold text-base md:text-lg text-slate-900 mt-1">
                {formatCurrency(grandTotal)}
              </span>
            </div>

            {/* Total Paid */}
            <div className="bg-emerald-50/80 p-3.5 rounded-2xl border border-emerald-200 flex flex-col justify-between">
              <span className="text-[11px] font-medium text-emerald-700">Total Received</span>
              <span className="font-serif font-bold text-base md:text-lg text-emerald-800 mt-1">
                {formatCurrency(totalPaid)}
              </span>
            </div>

            {/* Remaining Balance */}
            <div className={`p-3.5 rounded-2xl border flex flex-col justify-between ${
              balancePayable > 0 ? 'bg-amber-50/80 border-amber-200 text-amber-900' : 'bg-emerald-50/80 border-emerald-200 text-emerald-900'
            }`}>
              <span className="text-[11px] font-medium opacity-80">Remaining Balance</span>
              <span className="font-serif font-bold text-base md:text-lg mt-1">
                {formatCurrency(balancePayable)}
              </span>
            </div>

            {/* Status */}
            <div className="bg-white p-3.5 rounded-2xl border border-slate-200 flex flex-col justify-between">
              <span className="text-[11px] font-medium text-slate-500">Payment Status</span>
              <div className="mt-1">
                {paymentStatus === 'paid_in_full' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-600 text-white shadow-2xs">
                    ✅ Paid in Full
                  </span>
                )}
                {paymentStatus === 'partially_paid' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500 text-white shadow-2xs">
                    ⏳ Partially Paid
                  </span>
                )}
                {paymentStatus === 'unpaid' && (
                  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-red-600 text-white shadow-2xs">
                    ❌ Unpaid
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* Client Acceptance Proposed Advance Alert */}
          {clientProposedAdvance > 0 && totalPaid === 0 && (
            <div className="p-4 bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-2 border-amber-300 rounded-2xl flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3 shadow-xs">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500 text-white flex items-center justify-center font-bold text-lg shrink-0 shadow-xs">
                  💰
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-bold uppercase tracking-wider text-amber-900 bg-amber-200/80 px-2 py-0.5 rounded-full">
                      Client Online Confirmation
                    </span>
                  </div>
                  <p className="text-sm font-bold text-slate-900 mt-1">
                    Client Entered Advance: <span className="text-emerald-700 font-serif text-base font-black">{formatCurrency(clientProposedAdvance)}</span>
                  </p>
                  <p className="text-xs text-slate-600 mt-0.5">
                    Client ne quotation accept karte waqt yeh advance amount confirm ki thi. Niche 1-click se record karein:
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => {
                  setNewAmount(clientProposedAdvance);
                  if (!newNotes) setNewNotes('Online Booking Confirmation Advance');
                }}
                className="w-full sm:w-auto px-4 py-2.5 bg-[#0D4F4F] hover:bg-[#093A3A] text-[#D4AF37] font-bold text-xs rounded-xl shadow-xs transition-all cursor-pointer flex items-center justify-center gap-2 shrink-0"
              >
                <Plus className="w-4 h-4" />
                <span>Record Advance ({formatCurrency(clientProposedAdvance)})</span>
              </button>
            </div>
          )}

          {/* Record New Payment Box */}
          <div className="bg-slate-50 p-4 md:p-5 rounded-2xl border border-slate-200 space-y-3">
            <div className="flex items-center justify-between">
              <h4 className="font-serif font-bold text-sm text-[#0D4F4F] flex items-center gap-2">
                <Plus className="w-4 h-4 text-[#D4AF37]" /> Record New Payment Entry
              </h4>
              {balancePayable > 0 && (
                <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                  <span className="text-slate-400 font-medium">Quick Amount:</span>
                  {clientProposedAdvance > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setNewAmount(clientProposedAdvance);
                        if (!newNotes) setNewNotes('Online Booking Confirmation Advance');
                      }}
                      className="px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 border border-amber-300 text-amber-900 font-bold shadow-2xs"
                      title="Client Proposed Advance Amount"
                    >
                      Client Adv: {formatCurrency(clientProposedAdvance)}
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setNewAmount(Math.round(grandTotal * 0.5))}
                    className="px-2 py-0.5 rounded bg-white hover:bg-slate-200 border text-slate-700 font-semibold"
                  >
                    50% ({formatCurrency(Math.round(grandTotal * 0.5))})
                  </button>
                  <button
                    type="button"
                    onClick={() => setNewAmount(balancePayable)}
                    className="px-2 py-0.5 rounded bg-[#0D4F4F] text-[#D4AF37] font-bold shadow-2xs"
                  >
                    Full Balance ({formatCurrency(balancePayable)})
                  </button>
                </div>
              )}
            </div>

            <form onSubmit={handleAddPayment} className="grid grid-cols-1 sm:grid-cols-4 gap-3 text-xs">
              {/* Amount */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Amount (PKR) <span className="text-red-500">*</span>
                </label>
                <div className="relative">
                  <input
                    type="number"
                    required
                    placeholder="e.g. 20000"
                    value={newAmount}
                    onChange={(e) => setNewAmount(e.target.value ? Number(e.target.value) : '')}
                    className="w-full pl-3 pr-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-bold focus:ring-2 focus:ring-[#0D4F4F] focus:border-transparent outline-hidden"
                  />
                </div>
              </div>

              {/* Date */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">
                  Payment Date <span className="text-red-500">*</span>
                </label>
                <input
                  type="date"
                  required
                  value={newDate}
                  onChange={(e) => setNewDate(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-medium focus:ring-2 focus:ring-[#0D4F4F] focus:border-transparent outline-hidden"
                />
              </div>

              {/* Method */}
              <div>
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Payment Method</label>
                <select
                  value={newMethod}
                  onChange={(e) => setNewMethod(e.target.value as PaymentMethod)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 font-medium focus:ring-2 focus:ring-[#0D4F4F] focus:border-transparent outline-hidden"
                >
                  <option value="bank_transfer">🏦 Bank Transfer</option>
                  <option value="cash">💵 Cash Payment</option>
                  <option value="online">📱 Online / JazzCash / EasyPaisa</option>
                  <option value="cheque">📜 Cheque</option>
                  <option value="other">💳 Other</option>
                </select>
              </div>

              {/* Action Button */}
              <div className="flex items-end">
                <button
                  type="submit"
                  className="w-full py-2.5 rounded-xl bg-gradient-to-r from-[#0D4F4F] to-[#093A3A] text-[#D4AF37] font-bold text-xs shadow-md hover:brightness-110 transition-all flex items-center justify-center gap-1.5"
                >
                  <Plus className="w-4 h-4" /> Add Payment
                </button>
              </div>

              {/* Notes (Full Width) */}
              <div className="sm:col-span-4">
                <label className="block text-[11px] font-bold text-slate-700 mb-1">Notes / Description (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Booking Advance via Meezan Bank, Cash received at Barat night, etc."
                  value={newNotes}
                  onChange={(e) => setNewNotes(e.target.value)}
                  className="w-full px-3 py-2 bg-white border border-slate-300 rounded-xl text-slate-800 text-xs focus:ring-2 focus:ring-[#0D4F4F] focus:border-transparent outline-hidden"
                />
              </div>
            </form>
          </div>

          {/* Payment History Table */}
          <div className="space-y-2">
            <h4 className="font-serif font-bold text-sm text-[#0D4F4F] flex items-center justify-between">
              <span>Transaction History & Receipts</span>
              <span className="text-xs text-slate-500 font-normal">
                {transactions.length} record{transactions.length === 1 ? '' : 's'}
              </span>
            </h4>

            {transactions.length === 0 ? (
              <div className="p-8 bg-[#FAF9F6] rounded-2xl border-2 border-dashed border-[#E5E0D5] text-center space-y-2">
                <AlertCircle className="w-8 h-8 text-slate-400 mx-auto" />
                <p className="text-xs text-slate-600 font-medium">No payment transactions recorded yet.</p>
                <p className="text-[11px] text-slate-400">
                  Use the form above to record advance or installment payments.
                </p>
              </div>
            ) : (
              <div className="border border-slate-200 rounded-2xl overflow-hidden shadow-2xs">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="bg-[#0D4F4F] text-white text-[11px] font-serif uppercase tracking-wider">
                      <th className="p-3">Date</th>
                      <th className="p-3">Amount</th>
                      <th className="p-3">Method</th>
                      <th className="p-3">Notes</th>
                      <th className="p-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 bg-white">
                    {transactions.map((tx) => {
                      const isEditing = editingTxId === tx.id;

                      if (isEditing) {
                        return (
                          <tr key={tx.id} className="bg-amber-50/70">
                            <td className="p-2.5">
                              <input
                                type="date"
                                value={editDate}
                                onChange={(e) => setEditDate(e.target.value)}
                                className="px-2 py-1 bg-white border border-amber-300 rounded text-xs"
                              />
                            </td>
                            <td className="p-2.5">
                              <input
                                type="number"
                                value={editAmount}
                                onChange={(e) => setEditAmount(e.target.value ? Number(e.target.value) : '')}
                                className="w-28 px-2 py-1 bg-white border border-amber-300 rounded font-bold text-xs"
                              />
                            </td>
                            <td className="p-2.5">
                              <select
                                value={editMethod}
                                onChange={(e) => setEditMethod(e.target.value as PaymentMethod)}
                                className="px-2 py-1 bg-white border border-amber-300 rounded text-xs"
                              >
                                <option value="bank_transfer">🏦 Bank Transfer</option>
                                <option value="cash">💵 Cash</option>
                                <option value="online">📱 Online</option>
                                <option value="cheque">📜 Cheque</option>
                                <option value="other">💳 Other</option>
                              </select>
                            </td>
                            <td className="p-2.5">
                              <input
                                type="text"
                                value={editNotes}
                                onChange={(e) => setEditNotes(e.target.value)}
                                placeholder="Notes..."
                                className="w-full px-2 py-1 bg-white border border-amber-300 rounded text-xs"
                              />
                            </td>
                            <td className="p-2.5 text-right space-x-1 whitespace-nowrap">
                              <button
                                type="button"
                                onClick={handleSaveEdit}
                                className="px-2.5 py-1 bg-emerald-600 text-white rounded font-bold text-xs hover:bg-emerald-700 shadow-2xs"
                              >
                                Save
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditingTxId(null)}
                                className="px-2 py-1 bg-slate-200 text-slate-700 rounded text-xs hover:bg-slate-300"
                              >
                                Cancel
                              </button>
                            </td>
                          </tr>
                        );
                      }

                      return (
                        <tr key={tx.id} className="hover:bg-slate-50 transition-colors">
                          <td className="p-3 font-medium text-slate-800 whitespace-nowrap flex items-center gap-1.5">
                            <Calendar className="w-3.5 h-3.5 text-slate-400" />
                            <span>
                              {new Date(tx.date).toLocaleDateString('en-GB', {
                                day: 'numeric',
                                month: 'short',
                                year: 'numeric',
                              })}
                            </span>
                          </td>
                          <td className="p-3 font-bold text-slate-900 whitespace-nowrap">
                            {formatCurrency(tx.amount)}
                          </td>
                          <td className="p-3 whitespace-nowrap">{getMethodBadge(tx.method)}</td>
                          <td className="p-3 text-slate-600 max-w-xs truncate">
                            {tx.notes || <span className="text-slate-400 italic">No notes</span>}
                          </td>
                          <td className="p-3 text-right space-x-2 whitespace-nowrap">
                            <button
                              type="button"
                              onClick={() => handleStartEdit(tx)}
                              className="p-1 rounded-lg text-slate-500 hover:text-[#0D4F4F] hover:bg-slate-100 transition-colors"
                              title="Edit payment amount / date / mode"
                            >
                              <Edit3 className="w-4 h-4" />
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteTx(tx.id)}
                              className="p-1 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors"
                              title="Delete record"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Modal Footer */}
        <div className="p-4 bg-slate-100 border-t border-slate-200 flex items-center justify-between shrink-0 text-xs">
          <div className="flex items-center gap-2 text-slate-600">
            <span className="font-bold">Total Bill:</span>
            <span>{formatCurrency(grandTotal)}</span>
            <span>•</span>
            <span className="font-bold text-emerald-700">Paid:</span>
            <span className="text-emerald-800 font-bold">{formatCurrency(totalPaid)}</span>
            <span>•</span>
            <span className="font-bold text-amber-800">Remaining:</span>
            <span className="text-amber-900 font-bold">{formatCurrency(balancePayable)}</span>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="px-5 py-2 rounded-xl bg-[#0D4F4F] text-[#D4AF37] font-bold text-xs hover:bg-[#093A3A] transition-all shadow-xs"
          >
            Done & Close
          </button>
        </div>
      </div>
    </div>
  );
}
