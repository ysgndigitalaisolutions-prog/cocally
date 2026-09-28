'use client';

import Link from 'next/link';
import { useState } from 'react';
import { LinkBox } from '@/components/ops/ui';
import { opsApi, opsError } from '@/lib/ops-api';

interface Created {
  tenant: { id: string; name: string };
  owner: { name: string; phone: string };
  invite: { url: string; expiresAt: string };
}

const slugify = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/**
 * New tenant = the tenant, a first client (campaigns are filed under one) and
 * an Owner with a one-time link. Billing starts on the pilot quote until the
 * terms are confirmed on the tenant's Billing tab.
 */
export default function NewTenantPage() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [slugTouched, setSlugTouched] = useState(false);
  const [region, setRegion] = useState<'in' | 'au'>('au');
  const [clientName, setClientName] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [ownerPhone, setOwnerPhone] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [retentionDays, setRetentionDays] = useState(365);
  const [quota, setQuota] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { data } = await opsApi.post<Created>('/tenants', {
        name,
        slug,
        region,
        clientName: clientName || undefined,
        owner: { name: ownerName, phone: ownerPhone, email: ownerEmail || undefined },
        retentionDays,
        dailyDialQuota: quota,
      });
      setCreated(data);
    } catch (err) {
      setError(opsError(err, 'Could not create the tenant.'));
    } finally {
      setBusy(false);
    }
  }

  if (created) {
    return (
      <div className="max-w-2xl space-y-4">
        <h1 className="text-2xl font-bold">{created.tenant.name} is ready</h1>
        <LinkBox
          title={`Owner invite for ${created.owner.name} (${created.owner.phone})`}
          url={created.invite.url}
          expiresAt={created.invite.expiresAt}
          onClose={() => undefined}
        />
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          <li>Send the link to the owner. They set a password, sign in with their phone and enrol an authenticator.</li>
          <li>On the tenant&apos;s Billing tab: confirm the billing terms and fill in their Bill-to details.</li>
          <li>When their advance arrives, record it on the Billing tab.</li>
          <li>Set their AI voice on the Settings tab if they should not use the default.</li>
        </ol>
        <Link href={`/ops/tenants/${created.tenant.id}`} className="btn btn-primary">Open {created.tenant.name}</Link>
      </div>
    );
  }

  const field = 'block text-xs';
  return (
    <form onSubmit={submit} className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New tenant</h1>
        <p className="text-sm" style={{ color: 'var(--text-dim)' }}>A call centre (BPO) that will use CoCally.</p>
      </div>

      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">Company</h2>
        <label className={field} style={{ color: 'var(--text-dim)' }}>
          Name
          <input className="input mt-1" required value={name} onChange={(e) => { setName(e.target.value); if (!slugTouched) setSlug(slugify(e.target.value)); }} placeholder="e.g. Mantri Solutions BPO" />
        </label>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Short name (unique, a–z 0–9 -)
            <input className="input mt-1 font-mono" required value={slug} onChange={(e) => { setSlugTouched(true); setSlug(slugify(e.target.value)); }} />
          </label>
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Customers are in
            <select className="input mt-1" value={region} onChange={(e) => setRegion(e.target.value as 'in' | 'au')}>
              <option value="au">Australia</option>
              <option value="in">India</option>
            </select>
          </label>
        </div>
        <label className={field} style={{ color: 'var(--text-dim)' }}>
          First client / brand they call for (optional — defaults to the company name)
          <input className="input mt-1" value={clientName} onChange={(e) => setClientName(e.target.value)} placeholder="e.g. Energy Bill Review" />
        </label>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">Owner</h2>
        <p className="text-xs" style={{ color: 'var(--text-dim)' }}>Their admin. They get a one-time link to set a password; sign-in is with this phone number.</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Name
            <input className="input mt-1" required value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
          </label>
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Mobile (with country code)
            <input className="input mt-1" required value={ownerPhone} onChange={(e) => setOwnerPhone(e.target.value)} placeholder="+91…" />
          </label>
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Email (optional)
            <input className="input mt-1" type="email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} />
          </label>
        </div>
      </section>

      <section className="card space-y-3 p-5">
        <h2 className="font-semibold">Limits</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Keep recordings and transcripts for (days)
            <input className="input mt-1" type="number" min={30} max={3650} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))} />
          </label>
          <label className={field} style={{ color: 'var(--text-dim)' }}>
            Daily dial limit (0 = no limit)
            <input className="input mt-1" type="number" min={0} value={quota} onChange={(e) => setQuota(Number(e.target.value))} />
          </label>
        </div>
      </section>

      {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary" disabled={busy}>Create tenant</button>
        <Link href="/ops/tenants" className="btn btn-ghost">Cancel</Link>
      </div>
    </form>
  );
}
