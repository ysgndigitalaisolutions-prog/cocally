'use client';

import { useRouter } from 'next/navigation';
import QRCode from 'qrcode';
import { useState } from 'react';
import { OPS_OPERATOR_KEY, OPS_TOKEN_KEY, opsApi, opsError, type OperatorProfile } from '@/lib/ops-api';

type Step = { kind: 'password' } | { kind: 'code' } | { kind: 'enrol'; enrolToken: string; qr: string; secret: string };

/** CoCally staff sign-in. Separate from the tenant login: different accounts, different session. */
export default function OpsLoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<Step>({ kind: 'password' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  function signedIn(data: { token: string; operator: OperatorProfile }) {
    localStorage.setItem(OPS_TOKEN_KEY, data.token);
    localStorage.setItem(OPS_OPERATOR_KEY, JSON.stringify(data.operator));
    router.replace('/ops');
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (step.kind === 'enrol') {
        const { data } = await opsApi.post('/auth/enrol', { enrolToken: step.enrolToken, code });
        signedIn(data);
        return;
      }
      const { data } = await opsApi.post('/auth/login', { email, password, ...(step.kind === 'code' ? { code } : {}) });
      if (data.token) signedIn(data);
      else if (data.requires2fa) setStep({ kind: 'code' });
      else if (data.enrolmentRequired) {
        setStep({
          kind: 'enrol',
          enrolToken: data.enrolToken,
          secret: data.secret,
          qr: await QRCode.toDataURL(data.otpauthUrl, { margin: 1, width: 200 }),
        });
      }
      setCode('');
    } catch (err) {
      setError(opsError(err, 'Could not sign in'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-4 p-6">
        <div>
          <p className="text-xl font-bold">
            Co<span className="text-accent">Cally</span> <span className="text-sm font-semibold" style={{ color: 'var(--text-dim)' }}>Ops</span>
          </p>
          <p className="text-sm" style={{ color: 'var(--text-dim)' }}>CoCally staff only. Client users sign in at /login.</p>
        </div>

        {step.kind === 'password' && (
          <>
            <input className="input" type="email" autoComplete="username" placeholder="Work email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <input className="input" type="password" autoComplete="current-password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </>
        )}
        {step.kind === 'code' && (
          <input className="input text-center font-mono text-lg tracking-widest" inputMode="numeric" autoFocus maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
        )}
        {step.kind === 'enrol' && (
          <div className="space-y-3 text-sm">
            <p>Scan this with your authenticator app (Google Authenticator, 1Password, Authy), then enter the code it shows.</p>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={step.qr} alt="Authenticator QR code" className="mx-auto rounded bg-white p-2" width={200} height={200} />
            <p className="break-all text-center font-mono text-xs" style={{ color: 'var(--text-dim)' }}>{step.secret}</p>
            <input className="input text-center font-mono text-lg tracking-widest" inputMode="numeric" autoFocus maxLength={6} placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} required />
          </div>
        )}

        {error && <p className="text-sm" style={{ color: 'var(--bad)' }}>{error}</p>}
        <button className="btn btn-primary w-full" disabled={busy}>
          {step.kind === 'password' ? 'Continue' : step.kind === 'code' ? 'Sign in' : 'Turn on and sign in'}
        </button>
        {step.kind !== 'password' && (
          <button type="button" className="btn btn-ghost w-full text-sm" onClick={() => { setStep({ kind: 'password' }); setCode(''); setError(''); }}>
            Start again
          </button>
        )}
      </form>
    </main>
  );
}
