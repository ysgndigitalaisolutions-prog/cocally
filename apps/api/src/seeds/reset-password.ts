/**
 * Issue a one-time password-reset link for a user, by phone or email, without
 * needing to be signed in. For the owner who has locked themself out.
 *
 *   node apps/api/dist/seeds/reset-password.js --identifier +919902352425
 *
 * The link is valid 48 h and works on /invite/<token>, same as a new invite.
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../common/config';
import { normalizePhone, regionOf } from '../modules/leads/phone.util';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const identifier = arg('identifier');
  if (!identifier) {
    console.error('Usage: --identifier <+CC phone | email>');
    process.exit(2);
  }
  await mongoose.connect(config.mongoUri);
  const db = mongoose.connection.db!;

  let query: Record<string, unknown>;
  if (identifier.includes('@')) query = { email: identifier.toLowerCase() };
  else {
    const p = normalizePhone(identifier, regionOf(identifier, 'IN'));
    if (!p.ok) { console.error(`bad phone: ${p.reason}`); process.exit(2); }
    query = { phone: p.value.e164 };
  }
  const user = await db.collection('users').findOne(query);
  if (!user) { console.error(`no user for ${identifier}`); process.exit(1); }

  const now = new Date();
  const raw = randomBytes(32).toString('base64url');
  const purpose = user.passwordHash ? 'RESET' : 'INVITE';
  await db.collection('userinvites').insertOne({
    tenantId: user.tenantId,
    userId: user._id,
    tokenHash: createHash('sha256').update(raw).digest('hex'),
    purpose,
    expiresAt: new Date(Date.now() + 48 * 3600_000),
    createdAt: now,
    updatedAt: now,
  });
  await db.collection('auditlogs').insertOne({
    tenantId: user.tenantId,
    actorLabel: 'reset-password seed',
    action: 'user.reset_link_created',
    entityType: 'User',
    entityId: user._id.toString(),
    createdAt: now,
  });
  const base = (config.corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log('');
  console.log(`${purpose === 'RESET' ? 'Password reset' : 'Invite'} link for ${user.name} (${user.phone ?? user.email}), valid 48 h:`);
  console.log(`  ${base}/invite/${raw}`);
  console.log('');
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
