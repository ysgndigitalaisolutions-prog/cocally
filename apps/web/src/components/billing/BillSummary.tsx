'use client';

import { inr, minutes, monthLabel, num, statusColor, STATUS_LABEL, type MonthSummary } from '@/lib/billing';

/**
 * The month's usage and running bill, in plain numbers. Shown to the tenant's
 * admins on Usage & billing and to CoCally on the Platform screen, so it holds
 * only what the tenant is charged — never CoCally's costs.
 */
export default function BillSummary({ summary }: { summary: MonthSummary }) {
  const u = summary.usage;
  const issued = summary.invoice && summary.invoice.status !== 'DRAFT' ? summary.invoice : null;
  const answerRate = u.dials > 0 ? Math.round((u.answered / u.dials) * 100) : 0;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
        <Figure label="AI talk time" value={`${minutes(u.aiSeconds)} min`} strong />
        <Figure label="Dialled" value={num(u.dials)} />
        <Figure label="Answered" value={num(u.answered)} hint={`${answerRate}% of dials`} />
        <Figure label="Voicemail / no one" value={num(u.voicemail)} />
        <Figure label="Transferred to agents" value={num(u.transfers)} />
        <Figure label="Agent talk time" value={`${minutes(u.humanSeconds)} min`} hint="Not charged" />
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <section className="card p-5">
          <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
            <h2 className="font-semibold">
              {issued ? `Invoice ${issued.number}` : 'Bill so far'} — {monthLabel(summary.period)}
            </h2>
            {issued ? (
              <span className="rounded-full px-2 py-0.5 text-xs font-bold" style={{ background: statusColor(issued.status), color: '#0b1220' }}>
                {STATUS_LABEL[issued.status]}
              </span>
            ) : (
              <span className="text-xs" style={{ color: 'var(--text-dim)' }}>Estimate · updates as calls happen</span>
            )}
          </div>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                <th className="pb-2">Item</th>
                <th className="pb-2 text-right">Quantity</th>
                <th className="pb-2 text-right">Rate</th>
                <th className="pb-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {(issued?.lines ?? summary.lines).map((l) => (
                <tr key={l.label} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="py-2 pr-3">{l.label}</td>
                  <td className="py-2 text-right tabular-nums">
                    {num(l.quantity, l.unit === 'min' ? 2 : 0)} {l.unit}
                  </td>
                  <td className="py-2 text-right tabular-nums">{inr(l.rateInr)}</td>
                  <td className="py-2 text-right tabular-nums">{inr(l.amountInr)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <dl className="mt-3 space-y-1 border-t pt-3 text-sm" style={{ borderColor: 'var(--border)' }}>
            <Row label="Subtotal" value={inr(issued?.subtotalInr ?? summary.subtotalInr)} />
            <Row label="Less: paid from advance" value={`− ${inr(issued?.advanceAppliedInr ?? summary.advanceAppliedInr)}`} dim />
            <Row label="Taxable amount" value={inr(issued?.taxableInr ?? summary.taxableInr)} />
            <Row label={`GST ${summary.billing.gstPercent}%`} value={inr(issued?.gstInr ?? summary.gstInr)} dim />
            <div className="flex justify-between border-t pt-2 text-base font-bold" style={{ borderColor: 'var(--border)' }}>
              <dt>{issued ? 'Invoice total' : 'Payable if billed today'}</dt>
              <dd className="tabular-nums">{inr(issued?.totalInr ?? summary.totalInr)}</dd>
            </div>
          </dl>
        </section>

        <div className="space-y-4">
          <section className="card p-5">
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Advance balance</p>
            <p className="text-3xl font-bold tabular-nums" style={{ color: summary.creditBalanceInr > 0 ? 'var(--good)' : undefined }}>
              {inr(summary.creditBalanceInr)}
            </p>
            <p className="mt-1 text-xs" style={{ color: 'var(--text-dim)' }}>
              {summary.billing.advanceRule === 'CARRY_FORWARD'
                ? 'Unused advance carries forward to next month.'
                : 'The advance covers its own month; any unused part lapses when the month is billed.'}{' '}
              Monthly advance: {inr(summary.billing.monthlyAdvanceInr, 0)} + GST.
            </p>
          </section>

          <section className="card p-5">
            <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>Your rate this month</p>
            <p className="mt-1 text-lg font-bold">{summary.tier.label}</p>
            <p className="text-sm">
              {inr(summary.tier.aiPerMinInr)} per AI minute · {inr(summary.tier.perDialInr)} per dial
            </p>
            {summary.nextTier && (
              <p className="mt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
                {num(Math.max(0, summary.nextTier.minutesToGo), 0)} more AI minutes this month moves every minute to{' '}
                {summary.nextTier.label}: {inr(summary.nextTier.aiPerMinInr)}/min, {inr(summary.nextTier.perDialInr)}/dial.
              </p>
            )}
          </section>
        </div>
      </div>

      {summary.byCampaign.length > 0 && (
        <section className="card overflow-x-auto p-0">
          <h2 className="px-5 pt-4 font-semibold">By campaign</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>
                <th className="px-5 py-2">Campaign</th>
                <th className="px-3 py-2 text-right">Dials</th>
                <th className="px-3 py-2 text-right">Answered</th>
                <th className="px-3 py-2 text-right">Transfers</th>
                <th className="px-3 py-2 text-right">AI minutes</th>
                <th className="px-5 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody>
              {summary.byCampaign.map((c) => (
                <tr key={c.campaignId} className="border-t" style={{ borderColor: 'var(--border)' }}>
                  <td className="px-5 py-2">{c.name}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(c.usage.dials)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(c.usage.answered)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(c.usage.transfers)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{num(c.aiMinutes, 2)}</td>
                  <td className="px-5 py-2 text-right tabular-nums">{inr(c.amountInr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="px-5 pb-4 pt-2 text-xs" style={{ color: 'var(--text-dim)' }}>
            Amounts before advance and GST, at this month&apos;s rate.
          </p>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, hint, strong }: { label: string; value: string; hint?: string; strong?: boolean }) {
  return (
    <div className="card p-4">
      <p className="text-xs uppercase tracking-wide" style={{ color: 'var(--text-dim)' }}>{label}</p>
      <p className={`font-bold tabular-nums ${strong ? 'text-2xl' : 'text-xl'}`} style={strong ? { color: 'var(--accent)' } : undefined}>
        {value}
      </p>
      {hint && <p className="text-xs" style={{ color: 'var(--text-dim)' }}>{hint}</p>}
    </div>
  );
}

function Row({ label, value, dim }: { label: string; value: string; dim?: boolean }) {
  return (
    <div className="flex justify-between" style={dim ? { color: 'var(--text-dim)' } : undefined}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}
