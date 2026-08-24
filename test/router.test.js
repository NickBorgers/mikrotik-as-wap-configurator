#!/usr/bin/env node
/**
 * Regression tests for the router role.
 *
 * These cover the pure functions and the RouterOS output parsing, which is
 * where every bug found in review lived. The fixtures below are real output
 * captured from a MikroTik Chateau LTE6 running RouterOS 7.18.2, not invented
 * examples - the parsing bugs all came from formats that looked plausible but
 * were not what the device actually prints.
 */

const assert = require('assert');
const {
  parseCidr, cidrContains, networkOf, defaultPoolFor,
  normalizeWans, wanMemberComment, parseWanMemberComment,
  resolveHostAddress
} = require('../lib/router');
const { parseCountry } = require('../lib/backup');
const { validateRouterConfig } = require('../lib/validate-router');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.log(`  ✗ ${name}\n      ${e.message}`); failed++; }
}

console.log('\n=== Address helpers ===');
test('networkOf masks the host part', () => {
  assert.strictEqual(networkOf('192.168.80.1/24'), '192.168.80.0/24');
  assert.strictEqual(networkOf('10.0.5.7/16'), '10.0.0.0/16');
});
test('parseCidr rejects malformed input', () => {
  assert.strictEqual(parseCidr('192.168.80.1'), null);
  assert.strictEqual(parseCidr('300.1.1.1/24'), null);
  assert.strictEqual(parseCidr('nonsense'), null);
});
test('defaultPoolFor derives a usable range', () => {
  assert.strictEqual(defaultPoolFor('192.168.80.1/24'), '192.168.80.100-192.168.80.200');
});
test('cidrContains decides subnet membership', () => {
  assert.strictEqual(cidrContains('192.168.88.1', '192.168.88.1/24'), true);
  assert.strictEqual(cidrContains('192.168.80.5', '192.168.80.1/24'), true);
  assert.strictEqual(cidrContains('192.168.88.1', '192.168.80.1/24'), false);
});
test('cidrContains refuses a hostname rather than guessing (lockout guard)', () => {
  // Returning false here is what made the guard useless for FQDN hosts.
  // resolveHostAddress() must run first; this asserts the raw helper's contract.
  assert.strictEqual(cidrContains('router.example.net', '192.168.80.1/24'), false);
});

console.log('\n=== WAN normalisation ===');
test('uplinks sort by distance, best first', () => {
  const w = normalizeWans([
    { name: 'backup', interface: 'lte1', distance: 2 },
    { name: 'primary', interface: 'ether1', distance: 1 }
  ]);
  assert.deepStrictEqual(w.map(x => x.name), ['primary', 'backup']);
});
test('the preferred uplink gets the first default probe', () => {
  const w = normalizeWans([
    { name: 'backup', interface: 'lte1', distance: 2 },
    { name: 'primary', interface: 'ether1', distance: 1 }
  ]);
  assert.deepStrictEqual(w.map(x => x.probe), ['8.8.8.8', '1.1.1.1']);
});
test('an explicitly set probe is never handed to another uplink', () => {
  const w = normalizeWans([
    { name: 'a', interface: 'e1', distance: 1, probe: '1.1.1.1' },
    { name: 'b', interface: 'e2', distance: 2 }
  ]);
  assert.deepStrictEqual(w.map(x => x.probe), ['1.1.1.1', '8.8.8.8']);
});
test('running out of default probes throws instead of duplicating one', () => {
  // Two /32 routes on one destination with different gateways would make the
  // recursive lookup follow whichever won, silently disabling failover.
  assert.throws(
    () => normalizeWans(Array.from({ length: 5 }, (_, i) => ({ name: `w${i}`, interface: `e${i}`, distance: i + 1 }))),
    /Ran out of default probe addresses/
  );
});

console.log('\n=== WAN member comment round-trip ===');
test('comment survives a write/read cycle', () => {
  const wan = normalizeWans([{ name: 'backup', interface: 'lte1', type: 'lte', distance: 2, probe: '1.1.1.1', apn: 'fast.t-mobile.com' }])[0];
  const parsed = parseWanMemberComment(wanMemberComment(wan));
  assert.strictEqual(parsed.name, 'backup');
  assert.strictEqual(parsed.type, 'lte');
  assert.strictEqual(parsed.distance, 2);
  assert.strictEqual(parsed.probe, '1.1.1.1');
  assert.strictEqual(parsed.apn, 'fast.t-mobile.com');
});
test('a non-wan comment is ignored', () => {
  assert.strictEqual(parseWanMemberComment('defconf'), null);
  assert.strictEqual(parseWanMemberComment(''), null);
});

console.log('\n=== RouterOS output parsing (real device fixtures) ===');
test('country parses unquoted, which is how RouterOS prints it', () => {
  // Captured from /interface wifi print detail. Note: no quotes, and a space.
  const real = 'configuration.ssid="ChateauTest" .country=United States \r\n        security.authentication-types=wpa2-psk';
  assert.strictEqual(parseCountry(real), 'United States');
});
test('country also parses when quoted', () => {
  assert.strictEqual(parseCountry('configuration.country="United States" other=1'), 'United States');
});
test('country returns null when absent', () => {
  assert.strictEqual(parseCountry('configuration.ssid="X"'), null);
});
test('inline VLAN is read in both spellings RouterOS uses', () => {
  const full = 'configuration.ssid="A" datapath.bridge=bridge datapath.vlan-id=100 channel.x=1';
  const shorthand = 'configuration.ssid="A" datapath.bridge=bridge .vlan-id=200 channel.x=1';
  const untagged = 'configuration.ssid="A" datapath.bridge=bridge channel.x=1';
  const re = /(?:datapath)?\.vlan-id=(\d+)/;
  assert.strictEqual(full.match(re)[1], '100');
  assert.strictEqual(shorthand.match(re)[1], '200');
  assert.strictEqual(untagged.match(re), null);
});
test('a wrapped numeric list does not split one record into two', () => {
  // /interface/wifi/radio print detail wraps 2g-channels so its last line is
  // "            2472 " - which a looser splitter reads as a new record.
  const real = 'Flags: L - local \r\n 0 L radio-mac=04:F4:1C:9F:2C:70 bands=2ghz-g:20mhz,2ghz-n:20mhz \r\n     2g-channels=2412,2417,2422,\r\n            2472 \r\n     interface=wifi1 \r\n';
  const records = real.split(/\r?\n(?=\s{0,3}\d+\s)/);
  const chunks = /^\s{0,3}\d+\s/.test(records[0]) ? records : records.slice(1);
  assert.strictEqual(chunks.length, 1, 'record was split by the wrapped channel list');
  assert.ok(chunks[0].includes('bands='), 'bands= must stay in the same record as interface=');
  assert.ok(chunks[0].includes('interface=wifi1'));
});
test('a headerless print detail keeps record 0', () => {
  // /ip pool print detail emits no "Flags:" header, because pools have no flags.
  const real = ' 0 name="lan-pool" ranges=192.168.80.100-192.168.80.200 \r\n';
  const records = real.split(/\r?\n(?=\s{0,3}\d+\s)/);
  const chunks = /^\s{0,3}\d+\s/.test(records[0]) ? records : records.slice(1);
  assert.strictEqual(chunks.length, 1);
  assert.ok(chunks[0].includes('lan-pool'), 'record 0 was dropped');
});
test('comments render as ;;; lines, not comment="..."', () => {
  const real = ' 0  As   ;;; wan:backup default\r\n         dst-address=0.0.0.0/0 gateway=1.1.1.1 \r\n';
  assert.strictEqual(real.match(/;;;\s*([^\r\n]+)/)[1].trim(), 'wan:backup default');
  assert.strictEqual(real.match(/comment="([^"]+)"/), null, 'detail output has no comment= form');
});

console.log('\n=== Command argument safety ===');
const args = require('../lib/routeros-args');
test('q() neutralises a quote, so a value cannot end the string', () => {
  // An ISP password containing a quote used to produce a malformed command;
  // a crafted one could append further commands.
  const out = args.q('pa"ss;word');
  assert.strictEqual(out, '"pa\\"ss;word"');
  assert.ok(!/[^\\]"/.test(out.slice(1, -1)), 'no unescaped quote survives inside the string');
});
test('q() escapes dollar signs so RouterOS does not expand them', () => {
  assert.strictEqual(args.q('pa$$word'), '"pa\\$\\$word"');
});
test('unquoted positions reject anything but a plain identifier', () => {
  assert.strictEqual(args.ifaceName('ether1'), 'ether1');
  assert.throws(() => args.ifaceName('ether2; /ip firewall filter remove [find]'), /Unsafe or malformed/);
  assert.throws(() => args.ifaceName('ether2 comment=x'), /Unsafe or malformed/);
});
test('addresses, ranges and durations are checked, not escaped', () => {
  assert.throws(() => args.cidr('999.999.999.999/99'), /Unsafe or malformed/);
  assert.throws(() => args.ipv4('8.8.8.8; /user add name=x'), /Unsafe or malformed/);
  assert.throws(() => args.duration('12h; /user add name=x'), /Unsafe or malformed/);
  assert.throws(() => args.ipRange('1.1.1.1-2.2.2.2 extra=1'), /Unsafe or malformed/);
  assert.strictEqual(args.ipv4List(['1.1.1.1', '8.8.8.8']), '1.1.1.1,8.8.8.8');
  assert.throws(() => args.ipv4List(['1.1.1.1', 'evil']), /Unsafe or malformed/);
});

console.log('\n=== Validation ===');
test('accepts a well-formed config', () => {
  assert.deepStrictEqual(validateRouterConfig({
    lan: { address: '192.168.80.1/24', ports: ['ether2'], dns: { servers: ['9.9.9.9'] } },
    wan: [{ name: 'p', interface: 'ether1', type: 'dhcp', distance: 1, probe: '8.8.8.8' }]
  }), []);
});
test('rejects a bare IP as lan.address', () => {
  const e = validateRouterConfig({ lan: { address: '192.168.80.1' }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /not valid CIDR/.test(x)));
});
test('rejects an interface used as both WAN and LAN port', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24', ports: ['ether1'] },
    wan: [{ name: 'p', interface: 'ether1' }]
  });
  assert.ok(e.some(x => /both as a WAN and in lan.ports/.test(x)));
});
test('rejects two uplinks sharing a probe address', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', probe: '8.8.8.8' }, { name: 'b', interface: 'e2', probe: '8.8.8.8' }]
  });
  assert.ok(e.some(x => /both probe/.test(x)));
});
test('rejects a probe address that is also a resolver', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['8.8.8.8'] } },
    wan: [{ name: 'a', interface: 'e1', probe: '8.8.8.8' }]
  });
  assert.ok(e.some(x => /probe target and a lan.dns resolver/.test(x)));
});
test('rejects duplicate explicit distances', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', distance: 1 }, { name: 'b', interface: 'e2', distance: 1 }]
  });
  assert.ok(e.some(x => /end up at distance/.test(x)));
});
test('rejects an implicit distance colliding with an explicit one', () => {
  // 'a' has no distance, so it defaults to 1 - the same as 'b'. Checking only
  // what the user typed let this through.
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1' }, { name: 'b', interface: 'e2', distance: 1 }]
  });
  assert.ok(e.some(x => /end up at distance 1/.test(x)));
});
test('rejects a default-assigned probe that is also a resolver', () => {
  // No explicit probe, so 'a' gets 8.8.8.8 by default - which is also the
  // configured resolver.
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['8.8.8.8'] } },
    wan: [{ name: 'a', interface: 'e1' }]
  });
  assert.ok(e.some(x => /assigned by default/.test(x)));
});
test('rejects duplicate uplink names', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', distance: 1 }, { name: 'a', interface: 'e2', distance: 2 }]
  });
  assert.ok(e.some(x => /both named/.test(x)));
});
test('rejects a syntactically valid but impossible CIDR', () => {
  const e = validateRouterConfig({ lan: { address: '999.999.999.999/99' }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /not valid CIDR/.test(x)));
});
test('rejects a malformed pool and lease time', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dhcpServer: { pool: 'not-a-range', leaseTime: 'forever' } },
    wan: [{ name: 'a', interface: 'e1' }]
  });
  assert.ok(e.some(x => /pool .* must look like/.test(x)));
  assert.ok(e.some(x => /leaseTime .* must look like/.test(x)));
});
test('rejects static and pppoe uplinks missing required fields', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 's', interface: 'e1', type: 'static' }, { name: 'd', interface: 'e2', type: 'pppoe' }]
  });
  assert.ok(e.some(x => /static but has no address/.test(x)));
  assert.ok(e.some(x => /static but has no gateway/.test(x)));
  assert.ok(e.some(x => /pppoe but has no user/.test(x)));
});
test('rejects a dhcpServer with no usable lan.address', () => {
  const e = validateRouterConfig({ lan: { dhcpServer: { pool: 'a-b' } }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /needs a valid lan.address/.test(x)));
});
test('rejects the same interface used by two uplinks', () => {
  const e = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1' }, { name: 'b', interface: 'e1' }]
  });
  assert.ok(e.some(x => /one uplink per interface/.test(x)));
});

(async () => {
  console.log('\n=== Host resolution (lockout guard) ===');
  const ip = await resolveHostAddress('192.168.80.1');
  test('an IP passes through unchanged', () => assert.strictEqual(ip, '192.168.80.1'));
  const bad = await resolveHostAddress('this-host-does-not-exist.invalid');
  test('an unresolvable host yields null so the caller can refuse to delete', () => assert.strictEqual(bad, null));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
