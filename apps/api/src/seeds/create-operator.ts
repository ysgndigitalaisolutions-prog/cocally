/**
 * Create a CoCally ops-console operator (or re-issue their set-password link)
 * and print a one-time link. This is the only way to create the FIRST
 * operator; after that, operators add each other from Ops → Settings.
 *
 *   node apps/api/dist/seeds/create-operator.js --email you@company.com --name "Your Name"
 *
 * No password is created or printed. The link (valid 48 h) sets one; the first
 * sign-in then enrols an authenticator app, which is required for every
 * operator.
 */
import 'reflect-metadata';
import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../common/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('name')?.trim();
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || !name) {
    console.error('Usage: --email <email> --name "<name>" [--base-url https://app.co-cally.com]');
    process.exit(2);
  }
  await mongoose.connect(config.mongoUri);
  const col = mongoose.connection.db!.collection('operators');
  const now = new Date();
  const raw = randomBytes(32).toString('base64url');
  const expiresAt = new Date(now.getTime() + 48 * 3600_000);
  const existing = await col.findOne({ email });
  if (existing) {
    await col.updateOne(
      { _id: existing._id },
      { $set: { inviteTokenHash: createHash('sha256').update(raw).digest('hex'), inviteExpiresAt: expiresAt, active: true, updatedAt: now } },
    );
    console.log(`Operator ${email} exists — issued a new set-password link.`);
  } else {
    await col.insertOne({
      email,
      name,
      totpEnabled: false,
      active: true,
      tokenVersion: 0,
      inviteTokenHash: createHash('sha256').update(raw).digest('hex'),
      inviteExpiresAt: expiresAt,
      createdAt: now,
      updatedAt: now,
    });
    console.log(`Operator ${name} <${email}> created.`);
  }
  await mongoose.connection.db!.collection('opsauditlogs').insertOne({
    operatorId: 'create-operator-script',
    operatorEmail: 'script',
    action: existing ? 'operator.link_reissued' : 'operator.create',
    entityType: 'Operator',
    after: { email },
    createdAt: now,
  });
  const base = (arg('base-url') ?? config.corsOrigins[0] ?? 'http://localhost:3000').replace(/\/$/, '');
  console.log('');
  console.log('One-time link (48 hours) to set the password:');
  console.log(`  ${base}/ops/invite/${raw}`);
  console.log('');
  console.log(`Then sign in at ${base}/ops/login and scan the authenticator QR code.`);
  await mongoose.disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
