/**
 * Provision a new tenant with its first OWNER and print a one-time invite link.
 * Run once per client, from the API container or a dev shell with MONGODB_URI
 * pointing at the target database:
 *
 *   node apps/api/dist/seeds/provision-tenant.js \
 *     --name "Acme BPO" --slug acme --owner-name "Jane Citizen" \
 *     --owner-phone "+61412000104" [--owner-email jane@acme.com.au] [--region au] [--client-name "Aurora Solar"]
 *
 * No password is created or printed. The owner sets their own through the
 * invite link (valid 48 h), then must enrol TOTP before doing anything else.
 * The AU country pack is upserted so compliance rules exist from the start.
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import mongoose, { Types } from 'mongoose';
import { config } from '../common/config';
import { AU_PACK } from '../modules/country-packs/au.pack';
import { normalizePhone, regionOf } from '../modules/leads/phone.util';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const name = arg('name');
  const slug = arg('slug')?.toLowerCase();
  const ownerName = arg('owner-name');
  const ownerPhoneRaw = arg('owner-phone');
  const ownerEmail = arg('owner-email')?.toLowerCase();
  const region = arg('region') ?? 'au';
  if (!name || !slug || !ownerName || !ownerPhoneRaw) {
    console.error('Usage: --name <tenant> --slug <slug> --owner-name <name> --owner-phone <+61...> [--owner-email <email>] [--region au]');
    process.exit(2);
  }
  if (!/^[a-z0-9-]{3,40}$/.test(slug)) {
    console.error('slug must be 3-40 chars of a-z, 0-9, -');
    process.exit(2);
  }
  // The owner's phone is validated against its own country code when given in
  // E.164 (+91..., +61...); the tenant region only applies to bare numbers. An
  // AU tenant can be owned by someone with a non-AU mobile.
  const phone = normalizePhone(ownerPhoneRaw, regionOf(ownerPhoneRaw, region.toUpperCase()));
  if (!phone.ok) {
    console.error(`owner-phone rejected: ${phone.reason}`);
    process.exit(2);
  }

  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db;
  if (!db) throw new Error('No database connection');
  const now = new Date();

  if (await db.collection('tenants').findOne({ slug })) {
    console.error(`Tenant with slug "${slug}" already exists. Nothing changed.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const tenantId = new Types.ObjectId();
  await db.collection('tenants').insertOne({
    _id: tenantId,
    name,
    slug,
    region,
    branding: {},
    retentionDays: 365,
    dailyDialQuota: 0,
    paused: false,
    active: true,
    createdAt: now,
    updatedAt: now,
  });
  await db
    .collection('countrypacks')
    .updateOne({ code: 'AU' }, { $setOnInsert: { ...AU_PACK, createdAt: now, updatedAt: now } }, { upsert: true });
  // Every campaign belongs to a client (the brand being called for). Without one
  // the owner cannot create the first campaign, so start with a client named
  // after the tenant; more can be added later.
  const clientName = arg('client-name') ?? name;
  await db.collection('clients').insertOne({
    tenantId,
    name: clientName,
    branding: {},
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const ownerId = new Types.ObjectId();
  await db.collection('users').insertOne({
    _id: ownerId,
    tenantId,
    phone: phone.value.e164,
    email: ownerEmail,
    name: ownerName,
    roles: ['OWNER'],
    skills: [],
    languages: ['en'],
    presence: 'OFFLINE',
    talkTimeTodaySeconds: 0,
    adminIpAllowlist: [],
    totpEnabled: false,
    tokenVersion: 0,
    active: true,
    createdAt: now,
    updatedAt: now,
  });

  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + 48 * 3600_000);
  await db.collection('userinvites').insertOne({
    tenantId,
    userId: ownerId,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    purpose: 'INVITE',
    expiresAt,
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('auditlogs').insertOne({
    tenantId,
    actorLabel: 'provision-tenant',
    action: 'tenant.provision',
    entityType: 'Tenant',
    entityId: tenantId.toString(),
    after: { name, slug, region, owner: phone.value.e164 },
    createdAt: now,
  });

  const base = (config.corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log('');
  console.log(`Tenant "${name}" (${slug}) created: ${tenantId.toString()}`);
  console.log(`Client "${clientName}" created (campaigns are filed under it; add more from Campaigns).`);
  console.log(`Owner ${ownerName} <${phone.value.e164}> created: ${ownerId.toString()}`);
  console.log('');
  console.log('Send this one-time link to the owner (expires in 48 hours):');
  console.log(`  ${base}/invite/${raw}`);
  console.log('');
  console.log('They will set a password, sign in with their phone number, and be asked to enrol an authenticator app.');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
