'use client';

import { useParams, useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import InvoiceDocument from '@/components/billing/InvoiceDocument';
import { api } from '@/lib/api';
import type { Invoice } from '@/lib/billing';

/** One issued invoice, printable (Print → Save as PDF gives just the invoice). */
export default function ClientInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Invoice>(`/billing/invoices/${id}`)
      .then((r) => setInvoice(r.data))
      .catch(() => setError('Invoice not found.'));
  }, [id]);

  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between">
        <button className="text-sm hover:underline" style={{ color: 'var(--text-dim)' }} onClick={() => router.push('/billing')}>
          ← Billing
        </button>
        {invoice && (
          <button className="btn btn-primary" onClick={() => window.print()}>
            Print / save PDF
          </button>
        )}
      </div>
      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {invoice && <InvoiceDocument invoice={invoice} />}
    </div>
  );
}
