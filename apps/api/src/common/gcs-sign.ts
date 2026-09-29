import { createHash, createSign } from 'node:crypto';

/**
 * V4 signed GET URL for a Google Cloud Storage object, signed with a service
 * account key (the same JSON the recording egress uploads with). No SDK: this
 * is the documented canonical-request scheme, as `presignS3Get` is for S3.
 * The service account needs read access (Storage Object Viewer) on the bucket.
 */
export function signGcsGet(opts: { bucket: string; key: string; credentialsJson: string; expiresSeconds: number; now?: Date }): string {
  const creds = JSON.parse(opts.credentialsJson) as { client_email?: string; private_key?: string };
  if (!creds.client_email || !creds.private_key) throw new Error('GCS credentials are missing client_email/private_key');
  const now = opts.now ?? new Date();
  const datetime = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // 20260929T101500Z
  const date = datetime.slice(0, 8);
  const scope = `${date}/auto/storage/goog4_request`;
  const host = 'storage.googleapis.com';
  const path = `/${opts.bucket}/${opts.key.split('/').map(encodeURIComponent).join('/')}`;
  const params: Record<string, string> = {
    'X-Goog-Algorithm': 'GOOG4-RSA-SHA256',
    'X-Goog-Credential': `${creds.client_email}/${scope}`,
    'X-Goog-Date': datetime,
    'X-Goog-Expires': String(opts.expiresSeconds),
    'X-Goog-SignedHeaders': 'host',
  };
  const query = Object.keys(params)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(params[k]!)}`)
    .join('&');
  const canonical = ['GET', path, query, `host:${host}`, '', 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const toSign = ['GOOG4-RSA-SHA256', datetime, scope, createHash('sha256').update(canonical).digest('hex')].join('\n');
  const signature = createSign('RSA-SHA256').update(toSign).sign(creds.private_key, 'hex');
  return `https://${host}${path}?${query}&X-Goog-Signature=${signature}`;
}
