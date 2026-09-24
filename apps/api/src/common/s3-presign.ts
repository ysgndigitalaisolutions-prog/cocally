import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature V4 presigned GET URL, hand-rolled so the API does not carry
 * the whole AWS SDK for one read-only link. Works for S3 and S3-compatible
 * stores (an `endpoint` switches to path-style addressing).
 */
export function presignS3Get(input: {
  bucket: string;
  key: string;
  region: string;
  accessKey: string;
  secret: string;
  endpoint?: string;
  expiresSeconds?: number;
  now?: Date;
}): string {
  const now = input.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, ''); // YYYYMMDDTHHMMSSZ
  const dateStamp = amzDate.slice(0, 8);
  const region = input.region || 'us-east-1';
  const service = 's3';
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const expires = Math.min(Math.max(input.expiresSeconds ?? 900, 1), 7 * 24 * 3600);

  const encodeKey = (k: string) =>
    k
      .split('/')
      .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
      .join('/');

  let host: string;
  let canonicalUri: string;
  let base: string;
  if (input.endpoint) {
    const u = new URL(input.endpoint);
    host = u.host;
    canonicalUri = `/${input.bucket}/${encodeKey(input.key)}`;
    base = `${u.protocol}//${host}${canonicalUri}`;
  } else {
    host = `${input.bucket}.s3.${region}.amazonaws.com`;
    canonicalUri = `/${encodeKey(input.key)}`;
    base = `https://${host}${canonicalUri}`;
  }

  const query: Record<string, string> = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.accessKey}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query)
    .sort()
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k]!)}`)
    .join('&');
  const canonicalRequest = ['GET', canonicalUri, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, createHash('sha256').update(canonicalRequest).digest('hex')].join('\n');

  const hmac = (key: Buffer | string, data: string) => createHmac('sha256', key).update(data).digest();
  const kDate = hmac(`AWS4${input.secret}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

  return `${base}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
