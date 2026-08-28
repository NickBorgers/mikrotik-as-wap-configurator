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
  resolveHostAddress, configureMssClamp, mssClampRuleIsCurrent, terseRecords,
  parseTerseRecord
} = require('../lib/router');
const { parseCountry } = require('../lib/backup');
const { MikroTikSSH, redactSecrets } = require('../lib/ssh-client');
const { EventEmitter } = require('events');
const {
  ensureWifiInterfaceUp, recheckPendingMasters, runningQuery
} = require('../lib/wifi-config');
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

console.log('\n=== Backup record parsing (real device fixtures) ===');
const { isDisabledRecord } = require('../lib/backup');
const { splitDetailRecords, recordComment } = require('../lib/router');

test('a disabled radio is detected from the X flag, not disabled=yes', () => {
  // print detail never emits disabled=yes; disabled is an X in the flag field.
  assert.strictEqual(isDisabledRecord(' 0 M BX default-name="wifi1" name="wifi1" mac-address=04:F4'), true);
  assert.strictEqual(isDisabledRecord(' 1 M B  default-name="wifi2" name="wifi2" l2mtu=1560'), false);
});
test('a disabled radio carrying a comment is still detected', () => {
  // The flag field is followed by ";;;" rather than a key, which an earlier
  // version could not parse - so a commented disabled radio read as enabled.
  assert.strictEqual(isDisabledRecord(' 0 X   ;;; managed radio name="wifi1"'), true);
  assert.strictEqual(isDisabledRecord(' 0 M B ;;; some note name="wifi2"'), false);
});
test('an X inside a value is not mistaken for the disabled flag', () => {
  assert.strictEqual(isDisabledRecord(' 3 M B  configuration.ssid="XRAY" country=US'), false);
});
test('a record with no flags at all is not disabled', () => {
  // /ip pool print detail has no flag column.
  assert.strictEqual(isDisabledRecord(' 0 name="lan-pool" ranges=192.168.80.100-192.168.80.200'), false);
});
test('every record is parsed, not just indexes 0-5', () => {
  // Two radios plus four virtual SSIDs is six interfaces; the old loop only
  // recognised 0-5, so later ones merged into their predecessor.
  const out = 'Flags: M - master; B - bound; X - disabled\r\n' +
    Array.from({ length: 8 }, (_, i) => ` ${i} M B  name="wifi${i}" \r\n        mac-address=00:00:00:00:00:0${i} `).join('\r\n');
  const records = splitDetailRecords(out);
  assert.strictEqual(records.length, 8, 'all eight interfaces must survive parsing');
  assert.ok(records[7].includes('wifi7'));
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
test('band settings reject injection in width and txPower', () => {
  // applyBandSettings() feeds these into an unquoted command position.
  assert.throws(() => args.must('20mhz; /user add name=x', /^[0-9a-zA-Z/+-]{1,32}$/, 'width'), /Unsafe or malformed/);
  assert.throws(() => args.integer('15; /user add name=x', 'txPower'), /Unsafe or malformed/);
  assert.strictEqual(args.must('20/40/80mhz', /^[0-9a-zA-Z/+-]{1,32}$/, 'width'), '20/40/80mhz');
});
test('a country name with a quote cannot escape its argument', () => {
  assert.strictEqual(args.q('United States" ; /user add name=x'), '"United States\\" ; /user add name=x"');
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
  }).errors, []);
});
test('rejects a bare IP as lan.address', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({ lan: { address: '192.168.80.1' }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /not valid CIDR/.test(x)));
});
test('rejects an interface used as both WAN and LAN port', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', ports: ['ether1'] },
    wan: [{ name: 'p', interface: 'ether1' }]
  });
  assert.ok(e.some(x => /both as a WAN and in lan.ports/.test(x)));
});
test('rejects two uplinks sharing a probe address', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', probe: '8.8.8.8' }, { name: 'b', interface: 'e2', probe: '8.8.8.8' }]
  });
  assert.ok(e.some(x => /both probe/.test(x)));
});
test('warns when pinned resolvers sit on different uplinks (the production shape)', () => {
  // Each resolver is pinned, but to a different uplink, so whenever any uplink
  // is live at least one resolver answers. Degraded, not broken - and this is
  // a real deployment, so rejecting it would be wrong.
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['1.1.1.1', '8.8.8.8'] } },
    wan: [
      { name: 'primary', interface: 'e1', distance: 1, probe: '8.8.8.8' },
      { name: 'backup', interface: 'lte1', distance: 2, probe: '1.1.1.1' }
    ]
  });
  assert.deepStrictEqual(e, [], 'must not be an error');
  assert.strictEqual(warn.length, 1);
  assert.ok(/different uplinks/.test(warn[0]), `warning should explain why it is survivable: ${warn[0]}`);
});
test('errors when every resolver is pinned to one uplink', () => {
  // Nothing is left to fall back to: that uplink losing its path takes DNS out.
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['8.8.8.8'] } },
    wan: [{ name: 'a', interface: 'e1', probe: '8.8.8.8' }]
  });
  assert.strictEqual(warn.length, 0);
  assert.ok(e.some(x => /every lan.dns resolver is pinned/.test(x)), `expected an error, got: ${e.join('; ')}`);
});
test('warns when one resolver is pinned and another is independent', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['8.8.8.8', '9.9.9.9'] } },
    wan: [
      { name: 'a', interface: 'e1', distance: 1, probe: '8.8.8.8' },
      { name: 'b', interface: 'e2', distance: 2, probe: '1.1.1.1' }
    ]
  });
  assert.deepStrictEqual(e, []);
  assert.ok(warn.some(x => /9\.9\.9\.9 stays reachable/.test(x)));
});
test('says nothing when probes and resolvers are disjoint', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['9.9.9.9'] } },
    wan: [{ name: 'a', interface: 'e1', probe: '8.8.8.8' }]
  });
  assert.deepStrictEqual(e, []);
  assert.deepStrictEqual(warn, []);
});
test('rejects duplicate explicit distances', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', distance: 1 }, { name: 'b', interface: 'e2', distance: 1 }]
  });
  assert.ok(e.some(x => /end up at distance/.test(x)));
});
test('rejects an implicit distance colliding with an explicit one', () => {
  // 'a' has no distance, so it defaults to 1 - the same as 'b'. Checking only
  // what the user typed let this through.
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1' }, { name: 'b', interface: 'e2', distance: 1 }]
  });
  assert.ok(e.some(x => /end up at distance 1/.test(x)));
});
test('catches an overlap created by a default-assigned probe', () => {
  // No explicit probe, so 'a' gets 8.8.8.8 by default - which is the only
  // resolver. Checking only what the user typed missed this entirely.
  const { errors: e } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dns: { servers: ['8.8.8.8'] } },
    wan: [{ name: 'a', interface: 'e1' }]
  });
  assert.ok(e.some(x => /every lan.dns resolver is pinned/.test(x)));
});
test('rejects duplicate uplink names', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1', distance: 1 }, { name: 'a', interface: 'e2', distance: 2 }]
  });
  assert.ok(e.some(x => /both named/.test(x)));
});
test('rejects a syntactically valid but impossible CIDR', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({ lan: { address: '999.999.999.999/99' }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /not valid CIDR/.test(x)));
});
test('rejects a malformed pool and lease time', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24', dhcpServer: { pool: 'not-a-range', leaseTime: 'forever' } },
    wan: [{ name: 'a', interface: 'e1' }]
  });
  assert.ok(e.some(x => /pool .* must look like/.test(x)));
  assert.ok(e.some(x => /leaseTime .* must look like/.test(x)));
});
test('rejects static and pppoe uplinks missing required fields', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 's', interface: 'e1', type: 'static' }, { name: 'd', interface: 'e2', type: 'pppoe' }]
  });
  assert.ok(e.some(x => /static but has no address/.test(x)));
  assert.ok(e.some(x => /static but has no gateway/.test(x)));
  assert.ok(e.some(x => /pppoe but has no user/.test(x)));
});
test('rejects a dhcpServer with no usable lan.address', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({ lan: { dhcpServer: { pool: 'a-b' } }, wan: [{ interface: 'e1' }] });
  assert.ok(e.some(x => /needs a valid lan.address/.test(x)));
});
test('rejects the same interface used by two uplinks', () => {
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'e1' }, { name: 'b', interface: 'e1' }]
  });
  assert.ok(e.some(x => /one uplink per interface/.test(x)));
});

test('a real production config validates cleanly', () => {
  // Regression guard: v6.1.1 rejected this shape outright, which would have
  // broken a working deployment on upgrade.
  const { errors: e, warnings: warn } = validateRouterConfig({
    lan: {
      address: '192.168.80.1/24',
      ports: ['ether2', 'ether3', 'ether4', 'ether5'],
      dhcpServer: { pool: '192.168.80.100-192.168.80.200', leaseTime: '12h' },
      dns: { servers: ['1.1.1.1', '8.8.8.8'], allowRemoteRequests: true }
    },
    wan: [
      { name: 'primary', interface: 'ether1', type: 'dhcp', distance: 1, probe: '8.8.8.8' },
      { name: 'backup', interface: 'lte1', type: 'lte', apn: 'fast.t-mobile.com', distance: 2, probe: '1.1.1.1' }
    ]
  });
  assert.deepStrictEqual(e, [], `expected no errors, got: ${e.join('; ')}`);
  // It should still say something: the overlap is survivable, not invisible.
  assert.strictEqual(warn.length, 1, 'the probe/resolver overlap should still warn');
});

console.log('\n=== WAN failover notification: generated script ===');
const {
  wanNotifyScript, parseWanNotifyScript, parseDeviceMode, notifyLabel
} = require('../lib/router');

const notifyWans = normalizeWans([
  { name: 'primary', interface: 'ether1', type: 'dhcp', distance: 1, probe: '8.8.8.8' },
  { name: 'backup', interface: 'lte1', type: 'lte', distance: 2, probe: '1.1.1.1' }
]);
const script = wanNotifyScript(notifyWans, {
  url: 'https://ntfy.sh/example-topic',
  title: 'office router failover',
  label: 'nick-office-router'
});

test('state lives in the script comment, never in a :global', () => {
  // The trap this whole design exists for. A :global set by a script the
  // SCHEDULER runs is discarded before the next tick - verified on hardware,
  // the variable was absent from /system/script/environment entirely. It looks
  // like it works when tested by hand, because /system/script/run DOES persist
  // globals. A comment is config, so it also survives a reboot.
  assert.ok(!/:global/.test(script), 'a :global would be discarded between scheduler ticks');
  assert.ok(script.includes('/system script get $id comment'), 'state must be read from the comment');
  assert.ok(script.includes('/system script set $id comment=$want'), 'state must be written to the comment');
});
test('the active uplink is read off the routes the role already writes', () => {
  assert.ok(script.includes('/ip route find comment="wan:primary default" active=yes'));
  assert.ok(script.includes('/ip route find comment="wan:backup default" active=yes'));
});
test('uplinks are tested worst-first so the preferred one wins', () => {
  // Last assignment wins, so the lowest distance must come last.
  assert.ok(script.indexOf('"wan:backup default"') < script.indexOf('"wan:primary default"'));
});
test('a total outage resolves to "none" rather than to the last uplink', () => {
  assert.ok(/:local cur "none"/.test(script));
});
test('state advances only after the POST succeeds', () => {
  // Otherwise a failover that took the internet with it loses its own
  // notification: the send fails and the state moves on anyway.
  const send = script.indexOf('/tool fetch');
  const advance = script.indexOf('/system script set $id comment=$want');
  const onError = script.indexOf('on-error=');
  assert.ok(send > -1 && advance > send, 'the comment must be written after the fetch');
  assert.ok(onError > advance, 'both must sit inside the :do block, before on-error');
  assert.ok(/on-error=\{[\s\S]*will retry/.test(script), 'a failed send must say it will retry');
});
test('fetch writes no file and skips certificate checking by default', () => {
  // A default device has no CA certificates and this one had 292KiB of flash
  // free, so both of these are the difference between working and not.
  assert.ok(/\/tool fetch [^\n]*output=none/.test(script));
  assert.ok(/\/tool fetch [^\n]*check-certificate=no/.test(script));
});
test('checkCertificate: true turns verification back on', () => {
  const strict = wanNotifyScript(notifyWans, { url: 'https://x.example/y', label: 'r', checkCertificate: true });
  assert.ok(/check-certificate=yes/.test(strict));
});
test('a title becomes an X-Title header, and is omitted entirely when unset', () => {
  assert.ok(script.includes(':local hdr ("X-Title: " . $title)'));
  assert.ok(/\/tool fetch [^\n]*http-header-field=\$hdr/.test(script));
  const untitled = wanNotifyScript(notifyWans, { url: 'https://x.example/y', label: 'r' });
  assert.ok(!/http-header-field/.test(untitled), 'no title means no header argument at all');
});
test('the message names the router, so one topic can carry several', () => {
  assert.ok(script.includes(':local msg ($label . " WAN: " . $prev . " -> " . $cur)'));
  assert.ok(script.includes(':local label "nick-office-router"'));
});
test('notifyLabel prefers identity, then the hostname, and never an IP', () => {
  assert.strictEqual(notifyLabel({ identity: 'gw1', host: 'other.example.net' }), 'gw1');
  assert.strictEqual(notifyLabel({ host: 'nick-office-router.example.net' }), 'nick-office-router');
  assert.strictEqual(notifyLabel({ host: '192.168.80.1' }), 'router');
  assert.strictEqual(notifyLabel({}), 'router');
});

console.log('\n=== WAN failover notification: script encoding ===');
const { scriptSource } = require('../lib/routeros-args');

test('the script reaches the device as one line with escaped newlines', () => {
  const wire = scriptSource(script);
  assert.ok(!/\n/.test(wire), 'a real newline would end the command mid-string');
  assert.ok(wire.includes('\\n'), 'newlines must be sent as the RouterOS \\n escape');
});
test('script variables survive the round trip through escaping', () => {
  // q() escapes $ to \$, which is exactly right here: RouterOS un-escapes it
  // when it stores the source, so the script still reads $cur, not \$cur.
  const wire = scriptSource(':set cur $x');
  assert.strictEqual(wire, '":set cur \\$x"');
});
test('a quote inside a value cannot break out of the generated script', () => {
  const nasty = wanNotifyScript(notifyWans, { url: 'https://x.example/a"b', label: 'r' });
  assert.ok(nasty.includes(':local url "https://x.example/a\\"b"'), 'inner literal is escaped');
  assert.strictEqual(scriptSource('"'), '"\\""');
});

console.log('\n=== WAN failover notification: backup round trip ===');
test('url, title and certificate checking are recovered from the source', () => {
  const parsed = parseWanNotifyScript(script);
  assert.strictEqual(parsed.url, 'https://ntfy.sh/example-topic');
  assert.strictEqual(parsed.title, 'office router failover');
  assert.strictEqual(parsed.checkCertificate, false);
  assert.strictEqual(parseWanNotifyScript(wanNotifyScript(notifyWans, {
    url: 'https://x.example/y', label: 'r', checkCertificate: true
  })).checkCertificate, true);
});
test('an absent title reads back as absent, not as an empty string', () => {
  assert.strictEqual(parseWanNotifyScript(wanNotifyScript(notifyWans, { url: 'https://x.example/y', label: 'r' })).title, null);
});
test('print detail carries the SOURCE, so state must be read from the field', () => {
  // Captured shape from /system/script/print on a Chateau LTE6. A freshly
  // installed notifier has no state yet, and grepping the whole record for
  // state= then matches the code that WRITES the comment - yielding the
  // fragment `"` rather than "no state recorded".
  const fresh = ' 1   ;;; router:wan-notify\r\n' +
    '     name="wan-notify" owner="admin" policy=read,write,test source=\r\n' +
    '       :local want ("router:wan-notify state=" . $cur)\r\n';
  assert.ok(/state=/.test(fresh), 'the blob does contain state=, which is the trap');
  assert.strictEqual(recordComment(fresh).match(/state=(\S+)/), null, 'the comment field has no state yet');

  const settled = fresh.replace(';;; router:wan-notify', ';;; router:wan-notify state=primary');
  assert.strictEqual(recordComment(settled).match(/state=(\S+)/)[1], 'primary');
});

console.log('\n=== WAN failover notification: device-mode gate ===');
test('an unlocked Chateau reports both features on', () => {
  // Real output, /system/device-mode/print, RouterOS 7.18.2.
  const real = '                 mode: home         \r\n     allowed-versions: 7.13+,6.49.8+\r\n' +
    '            scheduler: yes           \r\n                socks: no           \r\n' +
    '                fetch: yes           \r\n          routerboard: no           \r\n';
  assert.deepStrictEqual(parseDeviceMode(real), { mode: 'home', scheduler: true, fetch: true });
});
test('a factory device in mode home blocks both, which is the shipped default', () => {
  // Both off means /system/scheduler/add fails with "not allowed by
  // device-mode" and /tool fetch fails the same way at runtime. Unlocking
  // needs a physical power cycle, so the tool has to say so rather than
  // surface the low-level failure.
  const locked = '                 mode: home\r\n            scheduler: no\r\n                fetch: no\r\n';
  assert.deepStrictEqual(parseDeviceMode(locked), { mode: 'home', scheduler: false, fetch: false });
});
test('one feature off is still reported precisely', () => {
  assert.deepStrictEqual(parseDeviceMode('mode: enterprise\r\nscheduler: yes\r\nfetch: no\r\n'),
    { mode: 'enterprise', scheduler: true, fetch: false });
});
test('a device that reports no device-mode at all yields null, not a false lock', () => {
  assert.strictEqual(parseDeviceMode(''), null);
  assert.strictEqual(parseDeviceMode('bad command name device-mode'), null);
});

console.log('\n=== WAN failover notification: validation ===');
const notifyBase = {
  lan: { address: '192.168.80.1/24', dns: { servers: ['9.9.9.9'] } },
  wan: [{ name: 'primary', interface: 'ether1', probe: '8.8.8.8' }]
};
test('a minimal notify block is accepted', () => {
  const { errors: e, warnings: w } = validateRouterConfig({ ...notifyBase, notify: { url: 'https://ntfy.sh/topic' } });
  assert.deepStrictEqual(e, []);
  assert.deepStrictEqual(w, []);
});
test('notify.url is required and must be an http(s) URL', () => {
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { title: 'x' } })
    .errors.some(x => /notify.url is required/.test(x)));
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { url: 'ntfy.sh/topic' } })
    .errors.some(x => /must be an http/.test(x)));
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { url: 'https://x/y" ; /user add name=z' } })
    .errors.some(x => /must be an http/.test(x)));
});
test('a plain-http endpoint warns, because the URL is usually the credential', () => {
  const { errors: e, warnings: w } = validateRouterConfig({ ...notifyBase, notify: { url: 'http://ntfy.sh/topic' } });
  assert.deepStrictEqual(e, []);
  assert.ok(w.some(x => /clear text/.test(x)));
});
test('a comma in the title is rejected - it would split the header field', () => {
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { url: 'https://x.example/y', title: 'a,b' } })
    .errors.some(x => /notify.title/.test(x)));
});
test('a zero or malformed interval is rejected', () => {
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { url: 'https://x.example/y', interval: 'often' } })
    .errors.some(x => /must look like 30s/.test(x)));
  assert.ok(validateRouterConfig({ ...notifyBase, notify: { url: 'https://x.example/y', interval: '0' } })
    .errors.some(x => /cannot be zero/.test(x)));
});
test('an interval shorter than the fetch timeout warns about piling up', () => {
  // Measured on hardware: a POST to a dead endpoint took ~10s to give up, and
  // the tick blocks for that whole time.
  const { errors: e, warnings: w } = validateRouterConfig({ ...notifyBase, notify: { url: 'https://x.example/y', interval: '5s' } });
  assert.deepStrictEqual(e, []);
  assert.ok(w.some(x => /pile up/.test(x)));
  assert.deepStrictEqual(validateRouterConfig({ ...notifyBase, notify: { url: 'https://x.example/y', interval: '1m' } }).warnings, []);
});
test('turning certificate checking on warns about the empty certificate store', () => {
  const { errors: e, warnings: w } = validateRouterConfig({
    ...notifyBase, notify: { url: 'https://x.example/y', checkCertificate: true }
  });
  assert.deepStrictEqual(e, []);
  assert.ok(w.some(x => /CA certificates/.test(x)));
});
test('notify must be a mapping', () => {
  assert.ok(validateRouterConfig({ ...notifyBase, notify: 'https://x.example/y' })
    .errors.some(x => /must be a mapping/.test(x)));
});

console.log('\n=== WAN failover notification: apply behaviour ===');
const { configureWanNotify } = require('../lib/router');

/**
 * Minimal stand-in for a device, so the apply path can be exercised without
 * one. It understands only the handful of command shapes configureWanNotify()
 * issues, and records every command for assertions.
 */
function fakeDevice({ deviceMode = 'mode: home\r\nscheduler: yes\r\nfetch: yes\r\n',
  scripts = [], schedulers = [] } = {}) {
  const commands = [];
  const listFor = kind => (kind === 'script' ? scripts : schedulers);
  const terse = objects => objects.map((o, i) => `${i} name="${o.name}" comment="${o.comment || ''}"`).join('\n');

  return {
    commands, scripts, schedulers,
    async exec(cmd) {
      commands.push(cmd);
      if (/device-mode/.test(cmd)) return deviceMode;

      let m = cmd.match(/^:foreach s in=\[\/system script find comment~"([^"]+)"\]/);
      if (m) {
        return scripts.filter(s => new RegExp(m[1]).test(s.comment || '')).map(s => s.comment).join('\n');
      }

      m = cmd.match(/^\/system (script|scheduler) print terse where name="([^"]+)"/);
      if (m) return terse(listFor(m[1]).filter(o => o.name === m[2]));

      m = cmd.match(/^\/system (script|scheduler) print terse where comment="([^"]+)"/);
      if (m) return terse(listFor(m[1]).filter(o => (o.comment || '') === m[2]));

      m = cmd.match(/^\/system (script|scheduler) remove \[find comment(~|=)"([^"]+)"\]/);
      if (m) {
        const list = listFor(m[1]);
        const keep = list.filter(o => (m[2] === '~'
          ? !new RegExp(m[3]).test(o.comment || '')
          : (o.comment || '') !== m[3]));
        list.length = 0;
        list.push(...keep);
        return '';
      }

      m = cmd.match(/^\/system (script|scheduler) add name=(\S+)/);
      if (m) {
        const comment = cmd.match(/comment="((?:[^"\\]|\\.)*)"/);
        listFor(m[1]).push({ name: m[2], comment: comment ? comment[1] : '', command: cmd });
        return '';
      }

      return '';
    }
  };
}

const notifyConfig = { host: 'gw.example.net', notify: { url: 'https://ntfy.sh/topic', title: 'failover' } };

console.log('\n=== MSS clamp validation ===');
test('mssClamp accepts booleans and rejects anything else', () => {
  const base = { lan: { address: '192.168.80.1/24' }, wan: [{ name: 'a', interface: 'ether1', type: 'dhcp' }] };
  const ok = validateRouterConfig({ ...base, lan: { ...base.lan, mssClamp: false } });
  assert.deepStrictEqual(ok.errors, [], `expected no errors, got: ${ok.errors.join('; ')}`);
  // A stringy "false" out of YAML would pass the `!== false` check and clamp
  // anyway, doing the opposite of what was written. It has to be rejected.
  const bad = validateRouterConfig({ ...base, lan: { ...base.lan, mssClamp: 'false' } });
  assert.ok(bad.errors.some(e => /mssClamp/.test(e)), 'a non-boolean mssClamp should be an error');
});
test('terseRecords counts records, not blank lines or headers', () => {
  assert.strictEqual(terseRecords('').length, 0);
  assert.strictEqual(terseRecords('Flags: X - disabled\n\n').length, 0, 'a header alone is not a record');
  assert.strictEqual(terseRecords(' 0    chain=forward \n 1    chain=forward ').length, 2);
});

test('parseTerseRecord keeps quoted values whole', () => {
  const f = parseTerseRecord(' 0    chain=forward comment="router:mss-clamp" protocol=tcp ');
  assert.strictEqual(f.chain, 'forward');
  assert.strictEqual(f.comment, 'router:mss-clamp', 'quotes must be stripped, value kept intact');
  assert.strictEqual(f.protocol, 'tcp');
});

test('mssClampRuleIsCurrent rejects anything that is not the exact live rule', () => {
  const ok = ' 0    chain=forward action=change-mss new-mss=clamp-to-pmtu passthrough=yes'
    + ' protocol=tcp tcp-flags=syn out-interface-list=WAN comment="router:mss-clamp" ';
  assert.ok(mssClampRuleIsCurrent(ok), 'the correct rule should be accepted');
  // A disabled rule matches every field but does nothing. Accepting it is
  // precisely the silent failure this predicate exists to prevent.
  assert.ok(!mssClampRuleIsCurrent(ok.replace(' 0    ', ' 0  X ')), 'disabled must be rejected');
  assert.ok(!mssClampRuleIsCurrent(''), 'empty is not a rule');

  // SUPERSETS AND PREFIXES. These are the dangerous ones: each CONTAINS the
  // expected text, so any substring-based check waves them through even though
  // every one of them behaves differently from the intended rule.
  const supersets = [
    ['chain=forward', 'chain=forward-custom'],
    ['out-interface-list=WAN', 'out-interface-list=WAN-backup'],
    ['tcp-flags=syn', 'tcp-flags=syn,!ack'],
    ['action=change-mss', 'action=change-mss-custom'],
    ['new-mss=clamp-to-pmtu', 'new-mss=clamp-to-pmtu-ish']
  ];
  for (const [from, to] of supersets) {
    assert.ok(!mssClampRuleIsCurrent(ok.replace(from, to)), `must reject ${to}`);
  }

  // An ingress match is the mistake this feature shipped once already, so a
  // rule carrying one is rejected however well its other fields match.
  assert.ok(!mssClampRuleIsCurrent(ok.replace('passthrough=yes', 'passthrough=yes in-interface-list=WAN')),
    'a rule with an ingress match must be rejected');
});

test('omitting mssClamp is valid and leaves it on', () => {
  const { errors: e } = validateRouterConfig({
    lan: { address: '192.168.80.1/24' },
    wan: [{ name: 'a', interface: 'ether1', type: 'dhcp' }]
  });
  assert.deepStrictEqual(e, [], `expected no errors, got: ${e.join('; ')}`);
});

(async () => {
  const installed = fakeDevice();
  const installProblems = await configureWanNotify(installed, notifyConfig, notifyWans);

  test('a healthy device gets one script and one scheduler, both owned by comment', () => {
    assert.deepStrictEqual(installProblems, []);
    assert.strictEqual(installed.scripts.length, 1);
    assert.strictEqual(installed.schedulers.length, 1);
    assert.strictEqual(installed.scripts[0].name, 'wan-notify');
    assert.strictEqual(installed.scripts[0].comment, 'router:wan-notify');
    assert.strictEqual(installed.schedulers[0].comment, 'router:wan-notify');
  });
  test('the script and scheduler carry the policies /tool fetch needs', () => {
    // Without `test` in the policy list, /tool fetch is refused at runtime.
    assert.ok(/policy=read,write,test/.test(installed.scripts[0].command));
    assert.ok(/policy=read,write,test/.test(installed.schedulers[0].command));
  });
  test('the scheduler runs the script at the configured interval', () => {
    assert.ok(/interval=30s/.test(installed.schedulers[0].command), 'defaults to 30s');
    assert.ok(installed.schedulers[0].command.includes('/system/script/run wan-notify'));
  });

  const restated = fakeDevice({
    scripts: [{ name: 'wan-notify', comment: 'router:wan-notify state=primary' }],
    schedulers: [{ name: 'wan-notify', comment: 'router:wan-notify' }]
  });
  await configureWanNotify(restated, notifyConfig, notifyWans);
  test('re-applying keeps the recorded state, so an apply does not itself notify', () => {
    assert.strictEqual(restated.scripts.length, 1, 'the old script is replaced, not duplicated');
    assert.strictEqual(restated.scripts[0].comment, 'router:wan-notify state=primary');
  });

  const stale = fakeDevice({ scripts: [{ name: 'wan-notify', comment: 'router:wan-notify state=fibre' }] });
  await configureWanNotify(stale, notifyConfig, notifyWans);
  test('a state naming an uplink that no longer exists is dropped', () => {
    // That really is a change worth announcing, so the next tick should send.
    assert.strictEqual(stale.scripts[0].comment, 'router:wan-notify');
  });

  const locked = fakeDevice({ deviceMode: 'mode: home\r\nscheduler: no\r\nfetch: no\r\n' });
  const lockedProblems = await configureWanNotify(locked, notifyConfig, notifyWans);
  test('device-mode being locked is reported, and nothing is attempted', () => {
    assert.strictEqual(lockedProblems.length, 1);
    assert.ok(/device-mode blocks scheduler and fetch/.test(lockedProblems[0]));
    assert.ok(/device-mode\/update scheduler=yes fetch=yes/.test(lockedProblems[0]), 'the fix must be in the message');
    assert.ok(/power-cycle/.test(lockedProblems[0]), 'and so must the physical step');
    assert.strictEqual(locked.scripts.length, 0);
    assert.ok(!locked.commands.some(c => /add/.test(c)), 'no add is even attempted');
  });

  const clash = fakeDevice({ scripts: [{ name: 'wan-notify', comment: 'mine, hands off' }] });
  const clashProblems = await configureWanNotify(clash, notifyConfig, notifyWans);
  test('a wan-notify object this tool does not own is left alone', () => {
    assert.strictEqual(clashProblems.length, 1);
    assert.ok(/not commented/.test(clashProblems[0]));
    assert.strictEqual(clash.scripts[0].comment, 'mine, hands off', 'the existing object survives');
    assert.strictEqual(clash.schedulers.length, 0, 'and nothing is installed alongside it');
  });

  const removing = fakeDevice({
    scripts: [{ name: 'wan-notify', comment: 'router:wan-notify state=primary' }],
    schedulers: [{ name: 'wan-notify', comment: 'router:wan-notify' }]
  });
  const removeProblems = await configureWanNotify(removing, { host: 'gw.example.net' }, notifyWans);
  test('deleting the notify block removes the notifier from the device', () => {
    assert.deepStrictEqual(removeProblems, []);
    assert.strictEqual(removing.scripts.length, 0);
    assert.strictEqual(removing.schedulers.length, 0);
  });

  const rejected = fakeDevice();
  const badProblems = await configureWanNotify(rejected, { host: 'gw.example.net', notify: { url: 'ftp://nope/x' } }, notifyWans);
  test('a value that never passed validation stops before the device is touched', () => {
    // configureRouter() is usable as a library function, so validation is not
    // guaranteed to have run. Failing halfway would leave a script with no
    // scheduler to run it.
    assert.strictEqual(badProblems.length, 1);
    assert.ok(/notify.url/.test(badProblems[0]));
    assert.ok(!rejected.commands.some(c => /remove|add/.test(c)), 'nothing was removed or added');
  });

  console.log('\n=== MSS clamp commands ===');

  // A fake that can FAIL, and that tells the canonical query apart from the
  // staged one. The clamp's job is to leave a live firewall in a known state,
  // so the paths worth testing are the ones where a command errors or the
  // device answers unexpectedly - not the happy path.
  const RULE = ' 0    chain=forward action=change-mss new-mss=clamp-to-pmtu passthrough=yes'
    + ' protocol=tcp tcp-flags=syn out-interface-list=WAN comment="router:mss-clamp" ';
  const CANON_Q = 'comment="router:mss-clamp"';
  const STAGED_Q = 'comment="router:mss-clamp-staged"';

  // responses: [substringToMatch, replyOrError][] - first match wins, so list
  // the staged query first (the canonical needle ends in a quote, so the two
  // never collide, but explicit ordering documents the intent).
  const device = (responses = []) => {
    const sent = [];
    return {
      sent,
      exec: async cmd => {
        sent.push(cmd);
        for (const [needle, reply] of responses) {
          if (cmd.includes(needle)) {
            if (reply instanceof Error) throw reply;
            return reply;
          }
        }
        return '';
      }
    };
  };
  const adds = d => d.sent.filter(c => c.includes('mangle add'));
  const removesCanon = d => d.sent.filter(c => c.includes('mangle remove') && c.includes(CANON_Q));
  const removesStaged = d => d.sent.filter(c => c.includes('mangle remove') && c.includes(STAGED_Q));

  const fresh = device();
  const freshProblems = await configureMssClamp(fresh, true);
  test('a device with no rule gets one directly, with no staging dance', () => {
    assert.deepStrictEqual(freshProblems, []);
    assert.strictEqual(adds(fresh).length, 1, 'expected exactly one add');
    assert.ok(adds(fresh)[0].includes(CANON_Q), 'a fresh add goes straight to the real comment');
    assert.strictEqual(removesCanon(fresh).length, 0, 'there is no existing rule to remove');
  });
  test('the rule is a single WAN-egress rule, never an ingress one', () => {
    const cmd = adds(fresh)[0];
    assert.ok(cmd.includes('out-interface-list=WAN'), 'must clamp on WAN egress');
    // clamp-to-pmtu computes from the route to the DESTINATION, so an ingress
    // rule would clamp against the LAN bridge and quietly do nothing.
    assert.ok(!cmd.includes('in-interface'), 'must NOT add an ingress rule');
    assert.ok(cmd.includes('new-mss=clamp-to-pmtu'), 'a fixed MSS penalises a 1500 uplink');
    assert.ok(/chain=forward/.test(cmd) && /tcp-flags=syn/.test(cmd));
  });
  test('objects are matched by EXACT comment, not a prefix pattern', () => {
    // "~^router:mss-clamp" would also delete router:mss-clamp-custom.
    for (const cmd of fresh.sent) {
      assert.ok(!cmd.includes('~'), `must not use a regex match: ${cmd}`);
    }
  });

  const correct = device([[CANON_Q, RULE]]);
  const correctProblems = await configureMssClamp(correct, true);
  test('an already-correct rule is left completely alone', () => {
    assert.deepStrictEqual(correctProblems, []);
    assert.strictEqual(adds(correct).length, 0, 're-applying must not churn the firewall');
    assert.strictEqual(correct.sent.filter(c => c.includes('mangle remove')).length, 0,
      'must not briefly unclamp a working gateway');
  });

  for (const [label, record] of [
    ['disabled by hand', RULE.replace(' 0    ', ' 0  X ')],
    ['edited to a fixed MSS', RULE.replace('new-mss=clamp-to-pmtu', 'new-mss=1360')],
    ['moved to another chain', RULE.replace('chain=forward', 'chain=output')]
  ]) {
    const drifted = device([[STAGED_Q, RULE], [CANON_Q, record]]);
    const problems = await configureMssClamp(drifted, true);
    test(`a rule ${label} is replaced via staging, old rule removed last`, () => {
      assert.deepStrictEqual(problems, []);
      const order = drifted.sent.map((c, i) => [i, c]);
      const stagedAdd = order.find(([, c]) => c.includes('mangle add') && c.includes(STAGED_Q));
      const canonRemove = order.find(([, c]) => c.includes('mangle remove') && c.includes(CANON_Q));
      const promote = order.find(([, c]) => c.includes('mangle set') && c.includes(STAGED_Q));
      assert.ok(stagedAdd, 'the replacement must be staged first');
      assert.ok(canonRemove, 'the old rule must be removed');
      assert.ok(promote, 'the staged rule must be promoted to the real comment');
      // The whole point: never destroy the working rule before the replacement
      // is proven to exist.
      assert.ok(stagedAdd[0] < canonRemove[0], 'staged add must precede removing the old rule');
      assert.ok(canonRemove[0] < promote[0], 'promotion must come after removal');
    });
  }

  const stageFails = device([
    [STAGED_Q, RULE],
    [CANON_Q, RULE.replace('new-mss=clamp-to-pmtu', 'new-mss=1360')]
  ]);
  // Make only the staged ADD fail.
  const origExec = stageFails.exec;
  stageFails.exec = async cmd => {
    if (cmd.includes('mangle add')) { stageFails.sent.push(cmd); throw new Error('no such command'); }
    return origExec(cmd);
  };
  const stageProblems = await configureMssClamp(stageFails, true);
  test('a failed staged add leaves the existing rule in place', () => {
    assert.strictEqual(stageProblems.length, 1, `expected one problem, got: ${stageProblems}`);
    assert.ok(/left the existing one in place/i.test(stageProblems[0]), stageProblems[0]);
    // A fixed-MSS rule is worse than clamp-to-pmtu but far better than nothing.
    assert.strictEqual(removesCanon(stageFails).length, 0, 'the working rule must survive');
  });

  const stageBad = device([
    [STAGED_Q, RULE.replace('chain=forward', 'chain=output')],
    [CANON_Q, RULE.replace('new-mss=clamp-to-pmtu', 'new-mss=1360')]
  ]);
  const stageBadProblems = await configureMssClamp(stageBad, true);
  test('a staged rule that reads back wrong is cleaned up, old rule kept', () => {
    assert.ok(stageBadProblems.some(p => /failed verification/i.test(p)), stageBadProblems.join('; '));
    assert.strictEqual(removesCanon(stageBad).length, 0, 'the existing rule must survive');
    assert.ok(removesStaged(stageBad).length >= 1, 'the bad staged rule must be cleaned up');
  });

  // Interrupted mid-swap: canonical removed, staged verified and live.
  const interrupted = device([[STAGED_Q, RULE], [CANON_Q, '']]);
  const interruptedProblems = await configureMssClamp(interrupted, true);
  test('an interrupted swap adopts the staged rule instead of rebuilding', () => {
    assert.deepStrictEqual(interruptedProblems, []);
    // Deleting a proven-good rule to add a fresh one would leave the gateway
    // unclamped if that add failed - the failure staging exists to prevent.
    assert.strictEqual(removesStaged(interrupted).length, 0, 'must not destroy the live clamp');
    assert.strictEqual(adds(interrupted).length, 0, 'must not add a duplicate');
    assert.ok(interrupted.sent.some(c => c.includes('mangle set') && c.includes(STAGED_Q)),
      'the staged rule must be promoted to the canonical comment');
  });

  // Stranded staged rule that is NOT usable: clearing it must succeed.
  const strandedBad = device([
    [STAGED_Q, RULE.replace('chain=forward', 'chain=output')],
    [CANON_Q, '']
  ]);
  const origStranded = strandedBad.exec;
  strandedBad.exec = async cmd => {
    if (cmd.includes('mangle remove') && cmd.includes(STAGED_Q)) {
      strandedBad.sent.push(cmd);
      throw new Error('permission denied');
    }
    return origStranded(cmd);
  };
  const strandedProblems = await configureMssClamp(strandedBad, true);
  test('a stranded staged rule that cannot be cleared stops the apply', () => {
    assert.ok(strandedProblems.some(p => /stranded/i.test(p)), strandedProblems.join('; '));
    assert.strictEqual(adds(strandedBad).length, 0, 'must not stage on top of a collision');
  });

  // A correct canonical rule PLUS a stranded staged one: the duplicate must go.
  const dupe = device([[STAGED_Q, RULE], [CANON_Q, RULE]]);
  const dupeProblems = await configureMssClamp(dupe, true);
  test('a stranded staged rule is cleared even when the real rule is correct', () => {
    assert.deepStrictEqual(dupeProblems, []);
    assert.strictEqual(removesStaged(dupe).length, 1, 'two active clamp rules must not persist');
    assert.strictEqual(adds(dupe).length, 0);
  });

  const readFails = device([[CANON_Q, new Error('timeout')]]);
  const readProblems = await configureMssClamp(readFails, true);
  test('a failed read stops before touching the firewall', () => {
    assert.strictEqual(readProblems.length, 1);
    assert.strictEqual(adds(readFails).length, 0, 'must not add blind');
    assert.strictEqual(readFails.sent.filter(c => c.includes('mangle remove')).length, 0,
      'must not remove blind');
  });

  const off = device();
  const offProblems = await configureMssClamp(off, false);
  test('opting out removes the rule and confirms it is gone', () => {
    assert.deepStrictEqual(offProblems, []);
    assert.strictEqual(removesCanon(off).length, 1);
    assert.strictEqual(adds(off).length, 0);
    assert.ok(off.sent.some(c => c.includes('mangle print')), 'removal must be verified, not assumed');
  });

  const offStuckStaged = device([[STAGED_Q, RULE], [CANON_Q, '']]);
  const stuckStagedProblems = await configureMssClamp(offStuckStaged, false);
  test('opting out also notices a surviving STAGED rule', () => {
    // Checking only the canonical comment would report a clean opt-out while a
    // staged rule was still clamping.
    assert.ok(stuckStagedProblems.some(p => /still present/i.test(p)),
      stuckStagedProblems.join('; '));
  });

  const offStuck = device([[CANON_Q, RULE]]);
  const stuckProblems = await configureMssClamp(offStuck, false);
  test('opting out reports failure when the rule survives removal', () => {
    // Reporting a clean apply while the rule is still live is the worst case.
    assert.ok(stuckProblems.some(p => /still present/i.test(p)), stuckProblems.join('; '));
  });

  const offErrors = device([['mangle remove', new Error('permission denied')]]);
  const offErrProblems = await configureMssClamp(offErrors, false);
  test('opting out reports a removal error instead of swallowing it', () => {
    assert.ok(/could not remove/i.test(offErrProblems.join('; ')), offErrProblems.join('; '));
  });

  console.log('\n=== RouterOS query FORM (get needs :put) ===');

  // v6.2.2 shipped `/interface get [find name=X] running` with no `:put`. Over
  // an SSH exec that prints NOTHING - RouterOS returns the value to an
  // interactive console, not to stdout. Every read came back empty, so every
  // interface looked not-running and every classification lookup looked empty.
  // On live hardware it reported a healthy master as dead and treated a virtual
  // AP as a master, so the retry never fired. The old tests could not catch it:
  // the fake returned canned values and never checked the command form.
  test('the running query is wrapped in :put', () => {
    const cmd = runningQuery('wifi2-ssid2');
    assert.ok(cmd.startsWith(':put ['), `a bare get prints nothing over SSH: ${cmd}`);
    assert.ok(cmd.endsWith(']'), cmd);
    assert.ok(cmd.includes('running'), cmd);
    assert.ok(cmd.includes('name="wifi2-ssid2"'), cmd);
  });

  test('every device query this module sends is :put-wrapped', () => {
    // Guards the whole class of bug, not just the one instance.
    const src = require('fs').readFileSync(require.resolve('../lib/wifi-config'), 'utf8');
    const bare = src.split('\n').filter(line =>
      /exec\(/.test(line) && /\bget \[find/.test(line) && !/:put \[/.test(line));
    assert.deepStrictEqual(bare, [],
      `these send a bare get and will read back empty:\n${bare.join('\n')}`);
  });

  console.log('\n=== WiFi interface comes up (VAP creation retry) ===');

  // A VAP created while its master is being reconfigured can be rejected by the
  // radio. RouterOS reports that ONLY as a comment on the interface - the `set`
  // that configured it returns no error - so an apply that just writes config
  // reports success while the SSID is silently off the air.
  const FAILED_DETAIL = ' 2   BI ;;; failed to create interface\n'
    + '        name="wifi2-ssid2" master-interface=wifi2 configuration.ssid="PartlyWork"';

  // running=false until the Nth read, then true. `master` decides whether the
  // device presents this interface as a virtual AP or as a master radio.
  const wifiDevice = (upFromRead, opts = {}) => {
    let reads = 0;
    const sent = [];
    return {
      sent,
      exec: async cmd => {
        sent.push(cmd);
        if (cmd.includes('master-interface')) {
          if (opts.masterLookupThrows) throw new Error('no such item');
          return opts.isMaster ? '' : 'wifi2';
        }
        if (cmd.includes('running')) {
          reads++;
          if (opts.readThrows) throw new Error('no such item');
          return reads >= upFromRead ? 'true' : 'false';
        }
        if (cmd.includes('disabled=') && opts.toggleThrows) throw new Error('permission denied');
        if (cmd.includes('print detail')) return FAILED_DETAIL;
        return '';
      }
    };
  };
  const noSleep = { sleep: async () => {}, delayMs: 0 };
  const toggles = d => d.sent.filter(c => c.includes('disabled='));

  const upFirstTry = wifiDevice(1);
  const upFirstProblem = await ensureWifiInterfaceUp(upFirstTry, '/interface/wifi', 'wifi2-ssid2', noSleep);
  test('an interface that is already running is left alone', () => {
    assert.strictEqual(upFirstProblem, null);
    assert.strictEqual(toggles(upFirstTry).length, 0, 'must not bounce a working interface');
  });

  const upAfterRetry = wifiDevice(2);
  const retryProblem = await ensureWifiInterfaceUp(upAfterRetry, '/interface/wifi', 'wifi2-ssid2', noSleep);
  test('a virtual AP that failed to create is retried and comes up', () => {
    assert.strictEqual(retryProblem, null, `expected recovery, got: ${retryProblem}`);
    assert.deepStrictEqual(
      toggles(upAfterRetry).map(c => /disabled=(\w+)/.exec(c)[1]), ['yes', 'no'],
      'recovery is disable-then-enable'
    );
  });

  // THE SAFETY PROPERTY. The primary SSID on each band is configured on the
  // MASTER radio, so this function is called with a master in normal operation.
  // The master carries every associated client - very possibly including the
  // operator running this tool over that radio. It must never be bounced.
  // A master also has benign reasons to read not-running: DFS channel
  // availability check, a CAP still provisioning, CAPsMAN not done activating.
  const masterDown = wifiDevice(99, { isMaster: true });
  const masterProblem = await ensureWifiInterfaceUp(masterDown, '/interface/wifi', 'wifi2', noSleep);
  test('a MASTER radio that is not running is NEVER bounced', () => {
    assert.strictEqual(toggles(masterDown).length, 0,
      `must not touch a master radio, sent: ${JSON.stringify(toggles(masterDown))}`);
  });
  test('a not-running master is DEFERRED, never silently called healthy', async () => {
    // Returning "fine" for every not-running master would reintroduce this very
    // bug on the primary SSID. A bad channel or a driver fault reads exactly
    // like a DFS check, so the only safe answer is to look again later.
    const pendingMasters = [];
    const deferred = wifiDevice(99, { isMaster: true });
    const problem = await ensureWifiInterfaceUp(deferred, '/interface/wifi', 'wifi2',
      { ...noSleep, pendingMasters });
    assert.strictEqual(problem, null, 'deferred, so not an immediate failure');
    assert.deepStrictEqual(pendingMasters, ['wifi2'], 'must be queued for re-check');
    assert.strictEqual(toggles(deferred).length, 0, 'still must not bounce it');
  });

  test('a not-running master with nowhere to defer is reported, not passed', async () => {
    const orphan = wifiDevice(99, { isMaster: true });
    const problem = await ensureWifiInterfaceUp(orphan, '/interface/wifi', 'wifi2', noSleep);
    assert.ok(problem, 'must not report a dead master as healthy');
    assert.ok(/not running/i.test(problem), problem);
    assert.strictEqual(toggles(orphan).length, 0, 'still must not bounce it');
  });

  const neverUp = wifiDevice(99);
  const neverProblem = await ensureWifiInterfaceUp(neverUp, '/interface/wifi', 'wifi2-ssid2',
    { ...noSleep, attempts: 3 });
  test('a virtual AP that never comes up is reported, not passed', () => {
    assert.ok(neverProblem, 'a dead SSID must produce a problem');
    assert.ok(/not running/i.test(neverProblem), neverProblem);
    // The device's own explanation is worth surfacing to whoever reads the log.
    assert.ok(/failed to create interface/.test(neverProblem),
      `expected the device's reason, got: ${neverProblem}`);
  });
  test('retries are bounded', () => {
    const bounces = neverUp.sent.filter(c => c.includes('disabled=yes')).length;
    assert.strictEqual(bounces, 2, `3 attempts means 2 retries, got ${bounces}`);
  });

  const unreadable = wifiDevice(1, { readThrows: true });
  const unreadableProblem = await ensureWifiInterfaceUp(unreadable, '/interface/wifi', 'wifi2-ssid2', noSleep);
  test('an unreadable interface is reported without blind retries', () => {
    assert.ok(unreadableProblem, 'must report');
    assert.ok(/could not be read back/i.test(unreadableProblem), unreadableProblem);
    assert.strictEqual(toggles(unreadable).length, 0,
      'no point bouncing an interface whose state cannot be read');
  });

  const stuck = wifiDevice(99, { toggleThrows: true });
  const stuckProblem = await ensureWifiInterfaceUp(stuck, '/interface/wifi', 'wifi2-ssid2', noSleep);
  test('a failed restart is reported rather than swallowed', () => {
    assert.ok(/could not be restarted/i.test(stuckProblem), stuckProblem);
  });

  console.log('\n=== Deferred master re-check ===');

  const recheckDevice = replies => {
    const sent = [];
    let i = 0;
    return {
      sent,
      exec: async cmd => {
        sent.push(cmd);
        // Past the end of the script, keep answering with the last value.
        const reply = replies[Math.min(i++, replies.length - 1)];
        if (reply instanceof Error) throw reply;
        return reply;
      }
    };
  };
  // A fake clock that advances only when the code sleeps, so the suite is
  // deterministic and never waits out a real DFS check. Fresh per call.
  const fastPoll = (extra = {}) => {
    let t = 0;
    return {
      timeoutMs: 20000,
      pollMs: 5000,
      now: () => t,
      sleep: async ms => { t += ms; },
      ...extra
    };
  };

  test('a master that came up during the apply is not reported', async () => {
    const d = recheckDevice(['true']);
    const problems = await recheckPendingMasters(d, ['wifi2'], fastPoll());
    assert.deepStrictEqual(problems, [], 'a DFS check that finished is not a failure');
  });

  test('a DFS master that comes up mid-poll is not reported', async () => {
    // CAC finishing after the first look is the common healthy case; a fixed
    // short wait would have condemned it.
    const d = recheckDevice(['false', 'false', 'true']);
    const problems = await recheckPendingMasters(d, ['wifi2'], fastPoll());
    assert.deepStrictEqual(problems, [], 'must keep polling, not give up at the first look');
    assert.ok(d.sent.length >= 3, `expected repeated polling, got ${d.sent.length} reads`);
  });

  test('polling is bounded by the timeout', async () => {
    const d = recheckDevice(['false']);
    await recheckPendingMasters(d, ['wifi2'], fastPoll());
    // 20s budget at 5s steps = 5 reads (t=0,5,10,15,20), never unbounded.
    assert.ok(d.sent.length <= 6, `polling must be bounded, got ${d.sent.length} reads`);
  });

  test('a master still down at the end IS reported', async () => {
    const d = recheckDevice(['false']);
    const problems = await recheckPendingMasters(d, ['wifi2'], fastPoll());
    assert.strictEqual(problems.length, 1, `expected a problem, got: ${problems}`);
    assert.ok(/not on the air/i.test(problems[0]), problems[0]);
  });

  test('a transient read failure does not condemn a radio that recovers', async () => {
    const d = recheckDevice([new Error('timeout'), 'true']);
    assert.deepStrictEqual(await recheckPendingMasters(d, ['wifi2'], fastPoll()), [],
      'one failed read mid-CAC must not be fatal');
  });

  test('a master that can never be re-checked is reported', async () => {
    const d = recheckDevice([new Error('timeout')]);
    const problems = await recheckPendingMasters(d, ['wifi2'], fastPoll());
    assert.ok(/could not be re-checked/i.test(problems.join('; ')), problems.join('; '));
  });

  test('many down radios share ONE deadline, not one each', async () => {
    // A controller with a fleet of dead CAP radios must not stall the apply for
    // 90s per radio. CAC runs concurrently on the device anyway.
    const d = recheckDevice(['false']);
    const problems = await recheckPendingMasters(d, ['wifi1', 'wifi2', 'wifi3', 'wifi4'], fastPoll());
    assert.strictEqual(problems.length, 4, 'every dead radio is still reported');
    // 20s budget / 5s steps = 5 rounds x 4 radios = 20 reads. Per-radio budgets
    // would be ~4x that.
    assert.ok(d.sent.length <= 24, `expected one shared deadline, got ${d.sent.length} reads`);
  });

  test('a repeated master name is only checked once', async () => {
    const d = recheckDevice(['false']);
    const problems = await recheckPendingMasters(d, ['wifi2', 'wifi2'], fastPoll());
    assert.strictEqual(problems.length, 1, 'duplicates must collapse');
  });

  test('SLOW READS consume the budget, not just sleeps', async () => {
    // Counting only requested sleep time let this run far past its budget
    // precisely when reads were slowest - the failure mode the timeout exists
    // to bound. Here each read burns 8s of clock and nothing ever sleeps.
    let t = 0;
    const d = {
      sent: [],
      exec: async cmd => { d.sent.push(cmd); t += 8000; return 'false'; }
    };
    const problems = await recheckPendingMasters(d, ['wifi2'], {
      timeoutMs: 20000, pollMs: 5000, now: () => t, sleep: async () => {}
    });
    assert.strictEqual(problems.length, 1, 'still reported');
    // 20s budget at 8s per read = 3 reads. Without a wall clock this never ends.
    assert.ok(d.sent.length <= 4, `slow reads must count, got ${d.sent.length} reads`);
  });

  test('a clock that never advances cannot spin forever', async () => {
    // Belt and braces: the round cap bounds it even if a caller passes a
    // no-op sleep and a frozen clock.
    const d = recheckDevice(['false']);
    const problems = await recheckPendingMasters(d, ['wifi2'], {
      timeoutMs: 20000, pollMs: 5000, now: () => 0, sleep: async () => {}
    });
    assert.strictEqual(problems.length, 1);
    assert.ok(d.sent.length <= 6, `round cap must bound it, got ${d.sent.length} reads`);
  });

  test('a round is atomic: every radio is read in the round that starts', async () => {
    // Radios later in map order must not be judged on a stale previous-round
    // result just because the deadline passed mid-round. Several DFS checks
    // completing near the deadline would otherwise be reported dead.
    let t = 0;
    const upAt = { wifi1: 2, wifi2: 2, wifi3: 2, wifi4: 2 };
    const reads = {};
    const d = {
      sent: [],
      exec: async cmd => {
        d.sent.push(cmd);
        const name = /name="([^"]+)"/.exec(cmd)[1];
        reads[name] = (reads[name] || 0) + 1;
        t += 3000;                       // each read burns clock
        return reads[name] >= upAt[name] ? 'true' : 'false';
      }
    };
    const problems = await recheckPendingMasters(d, ['wifi1', 'wifi2', 'wifi3', 'wifi4'], {
      timeoutMs: 20000, pollMs: 1000, now: () => t, sleep: async ms => { t += ms; }
    });
    // Round 2 runs t=13->25 and the 20s deadline passes partway through it.
    // Cutting the round short there would leave wifi4 unresolved and reported
    // dead even though it comes up in the very same round.
    assert.deepStrictEqual(problems, [],
      `all four came up in round 2; none should be reported: ${problems}`);
    for (const name of Object.keys(upAt)) {
      assert.ok(reads[name] >= 2, `${name} only got ${reads[name]} reads - round was cut short`);
    }
  });

  test('nothing deferred means no device round trip', async () => {
    const d = recheckDevice([]);
    assert.deepStrictEqual(await recheckPendingMasters(d, [], fastPoll()), []);
    assert.strictEqual(d.sent.length, 0, 'must not talk to the device for an empty list');
  });

  console.log('\n=== SSH exec must reject RouterOS failures ===');

  // RouterOS prints its errors to STDOUT and leaves stderr empty, so exec()
  // used to resolve on a rejected command and hand back the error text as if
  // it were data. Every try/catch around mt.exec in this codebase was therefore
  // decorative. It DOES set a non-zero exit status, verified on live hardware.
  const fakeSsh = (opts = {}) => {
    // NOT destructuring defaults: `code: undefined` must stay undefined, since
    // a missing exit status is exactly one of the cases under test. A default
    // would silently turn it into 0 and the test would pass vacuously.
    const stdout = opts.stdout || '';
    const stderr = opts.stderr || '';
    const code = 'code' in opts ? opts.code : 0;
    const signal = opts.signal;
    const mt = new MikroTikSSH('192.0.2.1', 'admin', 'admin');
    mt.connected = true;
    mt.conn = {
      exec: (cmd, cb) => {
        const stream = new EventEmitter();
        stream.stderr = new EventEmitter();
        cb(null, stream);
        setImmediate(() => {
          if (stdout) stream.emit('data', Buffer.from(stdout));
          if (stderr) stream.stderr.emit('data', Buffer.from(stderr));
          stream.emit('close', code, signal);
        });
      }
    };
    return mt;
  };
  const rejects = async mt => {
    try { await mt.exec('/anything'); return null; } catch (e) { return e.message; }
  };

  test('a successful command resolves with its output', async () => {
    const out = await fakeSsh({ stdout: '2d20:57:00\r\n', code: 0 }).exec('/x');
    assert.strictEqual(out, '2d20:57:00\r\n');
  });

  test('a non-zero exit REJECTS, even with empty stderr', async () => {
    // The exact shape observed on a Chateau LTE6 running RouterOS 7.18.2.
    const msg = await rejects(fakeSsh({
      stdout: "invalid value for argument address:\r\n    value of address must have ip address before '/'\n",
      stderr: '', code: 1
    }));
    assert.ok(msg, 'must not resolve a rejected command');
    assert.ok(/exit 1/.test(msg), msg);
    assert.ok(/invalid value for argument address/.test(msg),
      `the device's own explanation must survive: ${msg}`);
  });

  test('stderr still rejects, as it always did', async () => {
    const msg = await rejects(fakeSsh({ stderr: 'ssh: connection lost', code: 0 }));
    assert.ok(/connection lost/.test(msg), msg);
  });

  test('a signal kill rejects', async () => {
    const msg = await rejects(fakeSsh({ code: null, signal: 'SIGKILL' }));
    assert.ok(/signal SIGKILL/.test(msg), msg);
  });

  test('a non-zero exit with no output still rejects, legibly', async () => {
    const msg = await rejects(fakeSsh({ stdout: '', code: 1 }));
    assert.ok(/exit 1/.test(msg) && /no output/.test(msg), msg);
  });

  test('a killed command NEVER leaks the command text', async () => {
    // WiFi commands carry security.passphrase="..." and callers log e.message.
    // An error must not be how a wireless password reaches a CI log.
    const mt = fakeSsh({ code: null, signal: 'SIGKILL' });
    let msg = '';
    try {
      await mt.exec('/interface/wifi set wifi2 security.passphrase="Q#F4Gm8jFM"');
    } catch (e) { msg = e.message; }
    assert.ok(/signal SIGKILL/.test(msg), msg);
    assert.ok(!/Q#F4Gm8jFM/.test(msg), `passphrase leaked into the error: ${msg}`);
    assert.ok(!/passphrase/i.test(msg), `command text leaked into the error: ${msg}`);
  });

  test('secrets in device OUTPUT are redacted too', () => {
    const dirty = '/interface/wifi set x security.passphrase="Q#F4Gm8jFM" ssid="X"';
    const clean = redactSecrets(dirty);
    assert.ok(!/Q#F4Gm8jFM/.test(clean), clean);
    assert.ok(/ssid="X"/.test(clean), 'non-secret arguments must survive for diagnosis');
    assert.strictEqual(redactSecrets('no such item (/ip/service/get; line 1)'),
      'no such item (/ip/service/get; line 1)', 'ordinary errors must pass through untouched');
  });

  test('a MISSING exit status is distinguished from a rejection', async () => {
    // ssh2 reports no code when the channel closes without an exit-status
    // request. Calling that "exit null" sends someone hunting a RouterOS
    // rejection that never happened - but it must still not resolve.
    for (const code of [null, undefined]) {
      const msg = await rejects(fakeSsh({ stdout: 'partial', code }));
      assert.ok(msg, 'an unknown outcome must not resolve');
      assert.ok(/without an exit status/.test(msg), msg);
      assert.ok(!/exit null|exit undefined/.test(msg), `misleading message: ${msg}`);
    }
  });

  test('legitimate output containing error words is NOT rejected', async () => {
    // The guard is the EXIT CODE, never the text. `/log print` genuinely
    // returns lines containing "failure" and "error"; matching on those would
    // reject real data. Do not "improve" this into a string heuristic.
    const logLines = '18:25:02 system,error,critical router rebooted without proper shutdown\n'
      + '18:26:10 script,warning wan-notify: send failed, will retry\n';
    const out = await fakeSsh({ stdout: logLines, code: 0 }).exec('/log print');
    assert.strictEqual(out, logLines, 'exit 0 means success no matter what the text says');
  });

  console.log('\n=== Host resolution (lockout guard) ===');
  const ip = await resolveHostAddress('192.168.80.1');
  test('an IP passes through unchanged', () => assert.strictEqual(ip, '192.168.80.1'));
  const bad = await resolveHostAddress('this-host-does-not-exist.invalid');
  test('an unresolvable host yields null so the caller can refuse to delete', () => assert.strictEqual(bad, null));

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
})();
