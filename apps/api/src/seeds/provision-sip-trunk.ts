/**
 * Create (or update) the LiveKit SIP trunks for a carrier that authenticates
 * with a username/password (SIP digest) instead of an IP allow-list — which is
 * what makes LiveKit's Australian SIP region usable at all, since its gateway
 * addresses are not published (see claude-dev/2026-09-21 §D).
 *
 *   node apps/api/dist/seeds/provision-sip-trunk.js \
 *     --address sip.carrier.net.au[:5060] --username <user> --password <pass> \
 *     --numbers +61280000001,+61380000001 [--transport udp|tcp|tls] [--name "Carrier AU"] \
 *     [--inbound] [--inbound-addresses 203.0.113.0/24] [--srtp]
 *
 * Prints the outbound trunk id → set it as LIVEKIT_SIP_TRUNK_ID. With --inbound
 * it also creates an inbound trunk for the same numbers (digest-protected with
 * the same credentials unless --inbound-addresses is given) and a dispatch rule
 * that puts each inbound call in its own `inbound-<callid>` room.
 *
 * Re-running with the same --name updates the existing outbound trunk in place.
 */
import { SIPMediaEncryption, SIPTransport } from '@livekit/protocol';
import { SipClient } from 'livekit-server-sdk';
import { config } from '../common/config';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const TRANSPORTS: Record<string, SIPTransport> = {
  auto: SIPTransport.SIP_TRANSPORT_AUTO,
  udp: SIPTransport.SIP_TRANSPORT_UDP,
  tcp: SIPTransport.SIP_TRANSPORT_TCP,
  tls: SIPTransport.SIP_TRANSPORT_TLS,
};

async function main(): Promise<void> {
  const address = arg('address') ?? process.env.SIP_TRUNK_ADDRESS;
  const username = arg('username') ?? process.env.SIP_TRUNK_USERNAME;
  const password = arg('password') ?? process.env.SIP_TRUNK_PASSWORD;
  const numbers = (arg('numbers') ?? process.env.SIP_TRUNK_NUMBERS ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  const name = arg('name') ?? 'CoCally carrier trunk';
  const transport = TRANSPORTS[(arg('transport') ?? process.env.SIP_TRUNK_TRANSPORT ?? 'udp').toLowerCase()];
  // Carriers authenticate either by digest (username+password) or by IP
  // allow-list (no credentials; they whitelist LiveKit's static ranges — see
  // destinationCountry below). Both are valid; only address+numbers are required.
  const destinationCountry = (arg('destination-country') ?? process.env.SIP_DESTINATION_COUNTRY ?? 'AU').toUpperCase();
  if (!address || numbers.length === 0 || transport === undefined) {
    console.error('Usage: --address <host[:port]> [--username <u> --password <p>] --numbers +61...,+61... [--transport udp|tcp|tls] [--destination-country AU|IN|JP|...] [--name ...] [--inbound] [--inbound-addresses cidr,...] [--srtp]');
    process.exit(2);
  }
  if ((username && !password) || (!username && password)) {
    console.error('--username and --password must be given together');
    process.exit(2);
  }
  const { url, apiKey, apiSecret } = config.livekit;
  if (!url || !apiKey || !apiSecret) {
    console.error('LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET must be set');
    process.exit(2);
  }
  const host = url.replace(/^wss?:\/\//, 'https://');
  const sip = new SipClient(host, apiKey, apiSecret);
  const bad = numbers.filter((n) => !/^\+61\d{9}$/.test(n));
  if (bad.length) console.warn(`warning: numbers not in AU E.164 form: ${bad.join(', ')}`);

  const mediaEncryption = flag('srtp') ? SIPMediaEncryption.SIP_MEDIA_ENCRYPT_REQUIRE : SIPMediaEncryption.SIP_MEDIA_ENCRYPT_DISABLE;
  const existing = (await sip.listSipOutboundTrunk()).find((t) => t.name === name);
  const outbound = existing
    ? await sip.updateSipOutboundTrunkFields(existing.sipTrunkId, {
        address,
        numbers,
        transport,
        ...(username ? { authUsername: username, authPassword: password } : {}),
        destinationCountry,
        mediaEncryption,
      } as never)
    : await sip.createSipOutboundTrunk(name, address, numbers, {
        transport,
        ...(username ? { authUsername: username, authPassword: password } : {}),
        // Which LiveKit region the call ORIGINATES from. 'AU' = Sydney (no static
        // IPs published). 'IN' or 'JP' = regions with published static ranges, for
        // carriers that only allow-list IPs (143.223.88.0/21, 161.115.160.0/19, 153.57.128.0/18).
        destinationCountry,
        mediaEncryption,
      });
  console.log(`${existing ? 'updated' : 'created'} outbound trunk ${outbound.sipTrunkId} → ${address} (${numbers.length} CLI number(s), ${username ? `digest auth as ${username}` : 'no digest auth (IP allow-list)'}, originates from region for ${destinationCountry})`);
  console.log(`\nLIVEKIT_SIP_TRUNK_ID=${outbound.sipTrunkId}\n`);

  if (flag('inbound')) {
    const allowed = (arg('inbound-addresses') ?? '').split(',').map((a) => a.trim()).filter(Boolean);
    const inbound = await sip.createSipInboundTrunk(`${name} (inbound)`, numbers, {
      ...(allowed.length ? { allowedAddresses: allowed } : { authUsername: username, authPassword: password }),
      krispEnabled: true,
      mediaEncryption,
      ringingTimeout: 45,
    });
    const rule = await sip.createSipDispatchRule(
      { type: 'individual', roomPrefix: 'inbound-' },
      { name: `${name} inbound → own room`, trunkIds: [inbound.sipTrunkId] },
    );
    console.log(`created inbound trunk ${inbound.sipTrunkId} (${allowed.length ? `IP allow-list ${allowed.join(', ')}` : 'digest auth'}) and dispatch rule ${rule.sipDispatchRuleId}`);
    console.log('Point the carrier at: ' + url.replace(/^wss?:\/\//, '').replace(/\.livekit\.cloud$/, '.aus.sip.livekit.cloud') + ' (UDP/TCP 5060, TLS 5061)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
