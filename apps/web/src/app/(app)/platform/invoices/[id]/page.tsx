'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import InvoiceDocument from '@/components/billing/InvoiceDocument';
import { api } from '@/lib/api';
import type { Invoice } from '@/lib/billing';

export default function PlatformInvoicePage() {
  const { id } = useParams<{ id: string }>();
  const [invoice, setInvoice] = useState<Invoice | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api
      .get<Invoice>(`/platform/invoices/${id}`)
      .then((r) => setInvoice(r.data))
      .catch(() => setError('Invoice not found.'));
  }, [id]);

  return (
    <div className="space-y-4">
      <div className="no-print flex items-center justify-between">
        <Link href="/platform" className="text-sm hover:underline" style={{ color: 'var(--text-dim)' }}>← Platform</Link>
        {invoice && <button className="btn btn-primary" onClick={() => window.print()}>Print / save PDF</button>}
      </div>
      {error && <p style={{ color: 'var(--bad)' }}>{error}</p>}
      {invoice && <InvoiceDocument invoice={invoice} />}
    </div>
  );
}
