'use client';

import React, { useState, useEffect } from 'react';
import { useParams, useRouter } from 'next/navigation';
import { Quotation, AppSettings } from '@/lib/types';
import { storage } from '@/lib/storage';
import { apiFetchQuotationById, apiFetchSettings, apiSaveQuotation } from '@/lib/api-client';
import { useSettings } from '@/hooks/use-settings';
import { QuotationPreview } from '@/components/quotation/quotation-preview';
import { QuotationActions } from '@/components/quotation/quotation-actions';
import { PaymentLedgerModal } from '@/components/quotation/payment-ledger-modal';
import { formatCurrency } from '@/lib/utils';
import { ArrowLeft, Edit3, Sparkles, Receipt, Trash2, RotateCcw } from 'lucide-react';
import Link from 'next/link';

export default function QuotationDetailPage() {
  const params = useParams();
  const router = useRouter();
  const id = params.id as string;

  const [quotation, setQuotation] = useState<Quotation | null>(null);
  const [loading, setLoading] = useState(true);
  const [showLedgerModal, setShowLedgerModal] = useState(false);
  const { settings: defaultSettings } = useSettings();
  const [quotationSettings, setQuotationSettings] = useState<AppSettings>(defaultSettings);

  useEffect(() => {
    if (id) {
      apiFetchQuotationById(id).then((fromDb) => {
        setQuotation(fromDb);
        if (fromDb) {
          const qWs = fromDb.workspaceId || (fromDb.userId === 'user-super-admin' ? 'ws_user-super-admin' : `ws_${fromDb.userId}`);
          const local = storage.getSettings(qWs);
          setQuotationSettings(local);
          apiFetchSettings(qWs).then((cloud) => {
            if (cloud && cloud.bank) {
              setQuotationSettings(cloud);
            }
          });
        }
        setLoading(false);
      });
    }
  }, [id]);

  if (loading) {
    return (
      <div className="text-center py-16 space-y-4">
        <p className="text-xs text-slate-400 font-medium animate-pulse">Loading quotation from database...</p>
      </div>
    );
  }

  if (!quotation) {
    return (
      <div className="text-center py-16 space-y-4">
        <h2 className="text-lg font-serif font-bold text-slate-700">Quotation Not Found</h2>
        <p className="text-xs text-slate-500">The quotation you are looking for does not exist or was deleted.</p>
        <Link
          href="/quotations"
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#0D4F4F] text-[#D4AF37] text-xs font-bold"
        >
          <ArrowLeft className="w-4 h-4" /> Back to Quotations List
        </Link>
      </div>
    );
  }

  const handleSaveStatus = (status: Quotation['status']) => {
    const updated = { ...quotation, status };
    storage.saveQuotation(updated);
    setQuotation(updated);
    apiSaveQuotation(updated).catch(() => {});
  };

  const handleDuplicate = () => {
    const dup = storage.duplicateQuotation(quotation.id);
    if (dup) {
      router.push(`/quotations/${dup.id}`);
    }
  };

  const isQuotationInTrash = quotation.status === 'trash' || quotation.isDeleted;

  const handleDelete = async () => {
    if (confirm(`Move quotation #${quotation.quotationNumber} to Trash? Client link will immediately show "Quotation Not Found".`)) {
      const updated: Quotation = {
        ...quotation,
        previousStatus: quotation.status !== 'trash' ? quotation.status : (quotation.previousStatus || 'sent'),
        status: 'trash',
        isDeleted: true,
        deletedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      storage.saveQuotation(updated);
      try {
        await apiSaveQuotation(updated);
      } catch {}
      router.push('/quotations?status=trash');
    }
  };

  const handleRestore = async () => {
    const hasAdvance = (quotation.payment?.transactions?.length || 0) > 0 || (Number(quotation.payment?.advanceReceived) || 0) > 0;
    const hasAcceptedVar = Boolean(quotation.variations && quotation.variations.some(v => v.isAccepted));
    let restoredStatus = (quotation.previousStatus as Quotation['status']) || 'sent';
    if (hasAdvance || hasAcceptedVar) {
      restoredStatus = 'confirmed';
    } else if (restoredStatus === 'trash') {
      restoredStatus = 'sent';
    }

    const updated: Quotation = {
      ...quotation,
      status: restoredStatus,
      isDeleted: false,
      deletedAt: undefined,
      autoExpired: false,
      autoExpiredReason: undefined,
      restoredAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    storage.saveQuotation(updated);
    setQuotation(updated);
    try {
      await apiSaveQuotation(updated);
    } catch {}
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto pb-12">
      {/* Trash Warning Banner */}
      {isQuotationInTrash && (
        <div className="bg-rose-50 border-2 border-rose-300 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 text-rose-900 shadow-sm animate-in fade-in">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-rose-200 flex items-center justify-center shrink-0 text-rose-700">
              <Trash2 className="w-5 h-5" />
            </div>
            <div>
              <p className="font-bold text-sm text-rose-950">This Quotation is in Trash</p>
              <p className="text-rose-700 text-xs mt-0.5">
                Public client links are deactivated. If opened by the client, they will see <strong>"Quotation Not Found"</strong>.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleRestore}
            className="px-4 py-2 bg-emerald-700 hover:bg-emerald-800 text-white rounded-xl font-bold text-xs flex items-center gap-1.5 transition-colors shadow-xs cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" /> Restore Quotation
          </button>
        </div>
      )}

      {/* Action Header */}
      <div className="no-print flex flex-wrap items-center justify-between gap-4 bg-white p-4 rounded-xl border border-slate-200 shadow-xs">
        <div className="flex items-center gap-3">
          <Link
            href="/quotations"
            className="p-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 transition-colors"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div>
            <h1 className="font-serif font-bold text-lg text-[#0D4F4F] flex items-center gap-2">
              Quotation Preview — {quotation.quotationNumber}
              <Sparkles className="w-4 h-4 text-[#D4AF37]" />
            </h1>
            <p className="text-xs text-slate-500">
              Client: {quotation.client.name || 'Unnamed Client'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowLedgerModal(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-100/90 text-emerald-900 border border-emerald-300 text-xs font-bold hover:bg-emerald-200 transition-all shadow-xs"
            title="Live Payment Ledger & Bill Management"
          >
            <Receipt className="w-4 h-4 text-emerald-800" /> Payment Ledger
          </button>

          <Link
            href={`/quotations/new?id=${quotation.id}`}
            className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[#0D4F4F] text-[#D4AF37] text-xs font-bold hover:bg-[#093A3A] transition-all shadow-sm"
          >
            <Edit3 className="w-4 h-4" /> Edit Quotation
          </Link>
        </div>
      </div>

      {/* Client Proposed Advance Banner */}
      {(() => {
        const selectedVar = quotation.variations?.find(
          (v) => v.id === quotation.selectedVariationId || v.isAccepted
        );
        const clientProposedAdvance = Number(
          quotation.payment?.clientProposedAdvance || selectedVar?.payment?.clientProposedAdvance || 0
        );
        const totalPaid = (quotation.payment?.transactions || []).reduce(
          (sum, t) => sum + (Number(t.amount) || 0),
          0
        );
        const advanceReceived = Number(quotation.payment?.advanceReceived) || totalPaid;

        if (clientProposedAdvance > 0 && advanceReceived === 0) {
          return (
            <div className="no-print bg-gradient-to-r from-amber-50 via-orange-50 to-amber-50 border-2 border-amber-300 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3 text-amber-950 shadow-xs">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-2xl bg-amber-500 text-white flex items-center justify-center font-bold text-lg shrink-0 shadow-xs">
                  💰
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-amber-900 bg-amber-200/80 px-2 py-0.5 rounded-full">
                      Client Online Confirmation
                    </span>
                  </div>
                  <p className="font-bold text-sm text-slate-900 mt-0.5">
                    Client Specified Advance: <span className="text-emerald-700 font-serif font-black">{formatCurrency(clientProposedAdvance)}</span>
                  </p>
                  <p className="text-slate-600 text-xs mt-0.5">
                    Client ne portal par quotation confirm karte waqt yeh advance amount confirm ki hai. Ledger me record karein:
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setShowLedgerModal(true)}
                className="px-4 py-2.5 bg-[#0D4F4F] hover:bg-[#093A3A] text-[#D4AF37] rounded-xl font-bold text-xs flex items-center gap-2 transition-all shadow-xs cursor-pointer"
              >
                <Receipt className="w-4 h-4" /> Open Payment Ledger
              </button>
            </div>
          );
        }
        return null;
      })()}

      {/* Floating Action Buttons */}
      <QuotationActions
        quotation={quotation}
        onSave={handleSaveStatus}
        onDuplicate={handleDuplicate}
        onDelete={handleDelete}
      />

      {/* Full Screen High-Res Preview */}
      <div className="bg-white p-2 md:p-6 rounded-xl border border-slate-200 shadow-md">
        <QuotationPreview quotation={quotation} settings={quotationSettings} />
      </div>

      {/* Payment Ledger Modal */}
      {showLedgerModal && (
        <PaymentLedgerModal
          isOpen={showLedgerModal}
          quotation={quotation}
          onClose={() => setShowLedgerModal(false)}
          onQuotationUpdate={(updated) => {
            setQuotation(updated);
            storage.saveQuotationLocally(updated);
          }}
        />
      )}
    </div>
  );
}
