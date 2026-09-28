'use client';

import { inr, LEDGER_LABEL, type LedgerEntry } from '@/lib/billing';

/** The advance ledger, newest first: + credit in, − credit used. */
export default function LedgerTable({ entries }: { entries: LedgerEntry[] }) {
  return (
    <table className="w-full text-sm">
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
            <td className="py-2 pr-3 whitespace-nowrap" style={{ color: 'var(--text-dim)' }}>
              {new Date(e.at).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })}
            </td>
            <td className="py-2 pr-3">
              {LEDGER_LABEL[e.kind]}
              {e.note && <span className="block text-xs" style={{ color: 'var(--text-dim)' }}>{e.note}</span>}
            </td>
            <td className="py-2 text-right font-semibold tabular-nums" style={{ color: e.amountInr >= 0 ? 'var(--good)' : undefined }}>
              {e.amountInr >= 0 ? '+' : '−'} {inr(Math.abs(e.amountInr))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
