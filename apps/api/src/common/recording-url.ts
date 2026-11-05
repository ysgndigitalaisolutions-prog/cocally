import { config } from './config';
import { signGcsGet } from './gcs-sign';
import { presignS3Get } from './s3-presign';

/**
 * Where a recording lives, from any of the shapes `Call.recordingUri` has held:
 *   s3://bucket/key                                   (set when egress starts)
 *   https://bucket.storage.googleapis.com/key         (GCS egress result)
 *   https://storage.googleapis.com/bucket/key
 *   bucket-relative key                               (older egress results)
 */
export function recordingLocation(uri: string): { bucket: string; key: string } | null {
  const s3 = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (s3) return { bucket: s3[1]!, key: s3[2]! };
  const vhost = /^https:\/\/([^/.]+(?:[.-][^/.]+)*)\.storage\.googleapis\.com\/(.+)$/.exec(uri);
  if (vhost) return { bucket: vhost[1]!, key: decodeURIComponent(vhost[2]!) };
  const path = /^https:\/\/storage\.googleapis\.com\/([^/]+)\/(.+)$/.exec(uri);
  if (path) return { bucket: path[1]!, key: decodeURIComponent(path[2]!) };
  if (!/^[a-z]+:\/\//i.test(uri) && config.recording.bucket) return { bucket: config.recording.bucket, key: uri.replace(/^\/+/, '') };
  return null;
}

/** Short-lived signed link to a recording, or null if it can't be signed with the configured credentials. */
export function signedRecordingUrl(uri: string, expiresSeconds = 15 * 60): string | null {
  const loc = recordingLocation(uri);
  if (!loc) return null;
  const { s3Region, s3AccessKey, s3Secret, s3Endpoint, gcpCredentials } = config.recording;
  if (gcpCredentials) {
    const json = gcpCredentials.trim().startsWith('{') ? gcpCredentials : Buffer.from(gcpCredentials, 'base64').toString('utf8');
    return signGcsGet({ bucket: loc.bucket, key: loc.key, credentialsJson: json, expiresSeconds });
  }
  if (s3AccessKey && s3Secret) {
    return presignS3Get({
      bucket: loc.bucket,
      key: loc.key,
      region: s3Region ?? 'ap-southeast-2',
      accessKey: s3AccessKey,
      secret: s3Secret,
      endpoint: s3Endpoint,
      expiresSeconds,
    });
  }
  return null;
}

/**
 * Recording starts before the dial, so the file opens with the ring. Start playback
 * just before the answer: egress starts about 2 s after the dial, plus 1 s of margin.
 */
export function playFromAnswer(url: string, ringMs?: number | null): string {
  const seconds = Math.floor((ringMs ?? 0) / 1000) - 3;
  return seconds > 0 ? `${url}#t=${seconds}` : url;
}
