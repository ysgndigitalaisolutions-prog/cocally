'use client';

import { inr, minutes, monthLabel, num, STATUS_LABEL, type Invoice } from '@/lib/billing';

const fmtDate = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—';

/**
 * A printable invoice. Always black on white (it is a paper document), and
 * wrapped in `.print-area` so the browser's Print → Save as PDF gives just this.
 */
export default function InvoiceDocument({ invoice }: { invoice: Invoice }) {
  const s = invoice.seller ?? {};
  const b = invoice.billTo ?? {};
  const u = invoice.usage ?? {};
  const ink = '#111827';
  const dim = '#6b7280';
  const rule = '#e5e7eb';

  return (
    <article
      className="print-area mx-auto max-w-3xl rounded-lg p-8 text-sm shadow"
      style={{ background: '#ffffff', color: ink }}
    >
      <header className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className="text-xl font-bold">{s.name || 'CoCally'}</p>
          {s.address && <p className="whitespace-pre-line" style={{ color: dim }}>{s.address}</p>}
          {s.gstin && <p style={{ color: dim }}>GSTIN {s.gstin}</p>}
          <p style={{ color: dim }}>{[s.email, s.phone].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold tracking-wide">{invoice.status === 'DRAFT' ? 'DRAFT INVOICE' : s.gstin ? 'TAX INVOICE' : 'INVOICE'}</p>
          <p>
            <span style={{ color: dim }}>No.</span> {invoice.number ?? '—'}
          </p>
          <p>
            <span style={{ color: dim }}>Date</span> {fmtDate(invoice.issuedAt)}
          </p>
          <p>
            <span style={{ color: dim }}>Due</span> {fmtDate(invoice.dueAt)}
          </p>
          <p>
            <span style={{ color: dim }}>Period</span> {monthLabel(invoice.period)}
          </p>
          <p className="mt-1 font-semibold" style={{ color: invoice.status === 'PAID' ? '#15803d' : invoice.status === 'VOID' ? '#b91c1c' : ink }}>
            {STATUS_LABEL[invoice.status]}
            {invoice.paidAt ? ` · ${fmtDate(invoice.paidAt)}` : ''}
          </p>
        </div>
      </header>

      <section className="mt-6 rounded p-4" style={{ background: '#f9fafb' }}>
        <p className="text-xs font-semibold uppercase tracking-wide" style={{ color: dim }}>Bill to</p>
        <p className="font-semibold">{b.name || '—'}</p>
        {b.address && <p className="whitespace-pre-line" style={{ color: dim }}>{b.address}</p>}
        {b.gstin && <p style={{ color: dim }}>GSTIN {b.gstin}</p>}
        {b.email && <p style={{ color: dim }}>{b.email}</p>}
      </section>

      <table className="mt-6 w-full">
        <thead>
          <tr className="text-left text-xs uppercase tracking-wide" style={{ color: dim, borderBottom: `1px solid ${rule}` }}>
            <th className="pb-2">Description</th>
            <th className="pb-2 text-right">Qty</th>
            <th className="pb-2 text-right">Rate</th>
            <th className="pb-2 text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {invoice.lines.map((l) => (
            <tr key={l.label} style={{ borderBottom: `1px solid ${rule}` }}>
              <td className="py-2 pr-4">{l.label}</td>
              <td className="py-2 text-right tabular-nums">
                {num(l.quantity, l.unit === 'min' ? 2 : 0)} {l.unit}
              </td>
              <td className="py-2 text-right tabular-nums">{inr(l.rateInr)}</td>
              <td className="py-2 text-right tabular-nums">{inr(l.amountInr)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {invoice.tierLabel && (
        <p className="mt-1 text-xs" style={{ color: dim }}>Rate band for the month: {invoice.tierLabel}</p>
      )}

      <dl className="ml-auto mt-4 w-full max-w-xs space-y-1">
        <Line label="Subtotal" value={inr(invoice.subtotalInr)} />
        <Line label="Less: paid from advance" value={`− ${inr(invoice.advanceAppliedInr)}`} color={dim} />
        <Line label="Taxable value" value={inr(invoice.taxableInr)} />
        <Line label={`GST @ ${invoice.gstPercent}%`} value={inr(invoice.gstInr)} color={dim} />
        <div className="flex justify-between pt-2 text-base font-bold" style={{ borderTop: `2px solid ${ink}` }}>
          <dt>Total payable</dt>
          <dd className="tabular-nums">{inr(invoice.totalInr)}</dd>
        </div>
      </dl>

      <section className="mt-6 grid grid-cols-2 gap-x-6 gap-y-1 text-xs sm:grid-cols-4" style={{ color: dim }}>
        <span>Dials: {num(u.dials ?? 0)}</span>
        <span>Answered: {num(u.answered ?? 0)}</span>
        <span>Transfers: {num(u.transfers ?? 0)}</span>
        <span>AI talk: {minutes(u.aiSeconds ?? 0)} min</span>
      </section>

      {(s.paymentDetails || invoice.notes || invoice.paymentReference) && (
        <footer className="mt-6 space-y-2 pt-4 text-xs" style={{ borderTop: `1px solid ${rule}`, color: dim }}>
          {s.paymentDetails && <p className="whitespace-pre-line"><span className="font-semibold" style={{ color: ink }}>Payment details: </span>{s.paymentDetails}</p>}
          {invoice.paymentReference && <p>Payment reference: {invoice.paymentReference}</p>}
          {invoice.notes && <p>{invoice.notes}</p>}
        </footer>
      )}
      <p className="mt-6 text-xs" style={{ color: dim }}>
        AI conversation is billed per second of live AI-to-customer talk time. Carrier / telephony charges are billed by your carrier directly.
      </p>
    </article>
  );
}

function Line({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between" style={color ? { color } : undefined}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
