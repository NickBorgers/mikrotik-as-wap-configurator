# Changelog

## [6.2.5] - 2026-08-28 - Management Cannot Reach the WAN, and a Realistic VAP Settle Budget

Two fixes. The first closes a real exposure in the `role: router` path; the
second stops that same role failing applies on healthy hardware.

### 1. `/ip service` is bound to the LAN, not left listening on any address

On a live router configured by this tool, every management service listened on
`address=""` — any source:

```
0   name="telnet" port=23   address=""
2   name="www" port=80      address=""
3   name="ssh" port=22      address=""
6   name="winbox" port=8291 address=""
```

The only thing keeping that off the uplinks was a single firewall rule,
`router:input-drop-wan`. That rule works — 34,937 packets dropped on the test
device, and no logins from the WAN-side subnet — but it is one object. Delete
it, reorder it, or add a permissive input rule above it, and the entire
management surface is on the internet behind whatever password the device has.

Now every entry in `/ip service` is bound to the LAN network derived from
`lan.address`. The check moves into RouterOS's own accept path, where no
firewall edit can reach it. The firewall rule stays; the two layers fail
independently.

Also closed, because they bypass both of those layers:

- **telnet and ftp are disabled.** Cleartext, and this tool drives devices over
  SSH. Opt out with `lan.management.cleartext: true` — they stay LAN-bound.
- **MAC-telnet, MAC-winbox and neighbor discovery are scoped to the `LAN`
  interface list.** These run over layer 2. They ignore `/ip service address=`
  *and* the IP firewall input chain, so an attacker on the WAN broadcast domain
  reaches them without needing an IP at all. RouterOS defconf sets them
  correctly; nothing enforced or verified it.
- **Disabled services are bound too**, so re-enabling one by hand later cannot
  reopen the WAN.

RoMON is reported when enabled, not switched off. It is layer 2 as well, this
tool does not own it, and it is off from the factory.

**No user config can undo this.** The escape hatch, `lan.management.allow`,
takes additional source ranges, and its grammar cannot express a WAN address:
every entry must be non-globally-routable (RFC1918, CGNAT, link-local,
loopback), which is checked on the entry's *network* so `10.0.0.1/1` cannot
smuggle in half the internet. Private is not sufficient on its own — the test
device's own `ether1` sits on `192.168.4.0/22` behind another router — so every
entry is checked again at apply time against the addresses actually on the
uplinks, and one that covers a live uplink address is dropped and reported.

### The lockout guard, which outranks all of the above

This tool connects over SSH. Restricting `/ip service` while the operator is
reaching the device from somewhere the restriction excludes locks them out of a
remote gateway permanently. That is far worse than the exposure being fixed, so
the device is asked who is connected to it right now:

```
/user active print terse
0 when=2026-08-28 12:14:40 name=admin address=192.168.80.199 via=ssh group=full
```

Unless **every** active session is covered by the allow list, nothing is
restricted. The device's own view is used rather than this process's idea of its
source address, because a jump host, a NAT gateway or a VPN concentrator all
rewrite it on the way. Not being able to tell counts as not covered — an
unreadable session list, or an empty one, both mean "restrict nothing".

Skipping is a loud warning, not a failed apply, matching what the firewall step
already does when it cannot verify the LAN list. The WAN drop rule still stands
in that case.

Two more consequences worth knowing:

- Changing `lan.address` leaves the operator on the old subnet, so the first
  apply skips the restriction and the second one — made over the new address —
  lands it. This is the same two-run shape the LAN address migration already
  has.
- SSH is bound **last**, after every other service has proved the command shape.
  If it still reads back excluding the current session, the restriction is
  cleared again automatically: RouterOS applies `address=` to new connections
  only, so a wrong value does not drop the live session and the lockout would
  not surface until the next connect. The apply still fails.

Every write is verified by reading it back, and this turned out to matter more
than expected: **RouterOS reports an invalid argument on stdout, not stderr**,
so the SSH client resolves rather than throwing. "The command did not error" is
not evidence that it did anything.

`lan.management` round-trips through backup, but only when the restriction is
demonstrably in place. A device whose `ssh` service still listens on any address
has simply never been hardened, and recording `cleartext: true` off the back of
that would let a backup/restore cycle silently carry "leave telnet on" forward
for ever.

### 2. The virtual-AP settle budget is a poll, not a 6-second guess

6.2.3 waited a flat 3 seconds after toggling a virtual AP and gave up after two
toggles — about 6 seconds of settle. On the live Chateau that produced a **false
negative**: the apply exhausted the budget, reported
`wifi2-ssid2 is configured but not running`, exited INCOMPLETE, and the
interface came up on its own moments later. A second apply on the same device
recovered inside the budget and passed. So it was marginal, and it failed in the
direction that breaks any automation gating on the exit code.

After the toggle the tool now polls `running` until the interface comes up or a
60-second budget expires, instead of sleeping a fixed moment and asking once.
Polling costs nothing on a healthy interface — it returns on the first read —
so the budget is only spent on a genuine failure, which is what makes a generous
one nearly free. The budget is **shared** across the retries rather than granted
per retry, so raising `attempts` divides it instead of multiplying the wait.

The honest failure is kept: when the budget genuinely expires the problem is
still reported, with the device's own explanation. And the master-radio safety
property is unchanged — a master is never toggled and never enters the settle
poll, because it carries every associated client, very possibly including the
operator running this tool over that radio.

`recheckPendingMasters()` already did exactly this polling, correctly: one
shared deadline, a wall clock rather than accumulated sleep time, bounded and
atomic rounds. Both callers now share that one implementation
(`pollUntilRunning`) rather than keeping a second copy to drift.

### Verified on hardware

Every new device command was run against a live Chateau LTE6 (RouterOS 7.18.2)
before being relied on, and the tests assert command *form*, not just behaviour:

- `address=` rejects any value with a host bit set, so the LAN network is masked
  before it is sent.
- `:put [... get address]` renders a multi-entry list **semicolon**-separated
  while `print terse` renders the same list **comma**-separated. Both are parsed.
- `/tool mac-server print terse` is a syntax error; those settings must be read
  with `:put [... get ...]`.

### Hardened after review

The first draft of this change could have permanently locked an operator out of
a remote router. Review caught it, and these are the corrections:

- **Every write is verified immediately, and a failure rolls the whole run
  back.** Previously services were bound one after another and verified only at
  the end. A failure partway through left a device half-restricted - and if it
  landed before `ssh`, every alternative recovery path was bound while the
  lifeline was not. The prior value of each service is recorded first, so a
  rollback restores what was actually there rather than blanking it.
- **The ssh self-heal now confirms the clear took.** It cleared the restriction
  and assumed success. Since 6.2.4 a failed command throws, but a command can
  also be accepted and not do what was asked, and this is the one place where
  being wrong means never reaching the device again. It reads back, and says
  `URGENT` with console instructions if the clear did not land.
- **A session we cannot parse now blocks the restriction.** The code claimed
  "not being able to tell counts as not covered" and then silently skipped
  unparseable sessions, so a readable session elsewhere let the guard pass. An
  IPv6 peer or an address-less record now stops the whole thing.
- **A LAN that contains a live uplink address binds nothing.** It used to bind
  anyway and report it. That installs an allow-list which *admits the WAN* while
  reporting that management was locked to the LAN - claiming a protection that
  is not being provided, which is worse than not providing it.
- **An allow entry is dropped when any uplink has no address yet.** A private
  range proves nothing: this hardware's own WAN is `192.168.4.0/22`. The only
  real check is against the address actually on the uplink, and a DHCP or LTE
  uplink can acquire one inside an allowed range moments after the apply
  finishes.
- **Interface classification requires an interface-name shape.** Any non-empty
  answer used to mean "virtual AP". Getting that wrong means bouncing a *master*
  radio and cutting every client, possibly including the operator's own link.

A second review round found three more, all fixed:

- **A service is added to the rollback set the moment its write lands**, not
  after it verifies. Adding it on success meant the one service whose write
  landed but whose read-back failed was the one service never rolled back.
- **Rollback writes are verified too.** "Accepted but did no work" is the exact
  failure that made immediate verification necessary going in, and it is no
  less possible on the way back out. A rollback that does not read back correct
  reports `URGENT` with console instructions.
- **Unknown uplink state now binds nothing at all**, where it previously still
  bound the LAN range. The LAN is not exempt: if an unresolved DHCP, LTE or
  PPPoE uplink later takes an address inside it, binding to that network admits
  the WAN exactly as an allow entry would. A PPPoE uplink's address also lands
  on `pppoe-<name>` rather than the ethernet the config names, so the client
  interface REPLACES the parent in the watch set — on a normal PPPoE setup the
  parent never carries an address, so keeping both would leave the router
  permanently unhardenable.

One finding was accepted rather than fixed: a polling round that has already
started runs to completion even past its deadline, so a round over many
unresponsive radios can overrun by up to 30s each. Cutting the round short
would judge the remaining radios on a stale result and report healthy DFS
radios as dead. A slow answer is a better failure than a wrong one, and it only
occurs when the device has already stopped responding.

## [6.2.4] - 2026-08-28 - Failed Commands Now Actually Fail

`MikroTikSSH.exec()` resolved whenever stderr was empty. RouterOS prints its
errors to **stdout** and leaves stderr empty, so a rejected command looked
exactly like a successful one, and its error message was handed back as if it
were data.

Every `try { await mt.exec(...) } catch` in this codebase was therefore
decorative. Read-back verification was the only thing that ever caught a failed
write, and code that relied on a throw — including safety checks — was relying
on something that could not happen.

Verified on a live Chateau LTE6 running RouterOS 7.18.2:

```
/ip service set [find name="ssh"] address=999.999.999.999/99
  exit 1, stderr "", stdout "invalid value for argument address: ..."
/bogus/command
  exit 1, stderr "", stdout "syntax error (line 1 column 7)"
:put [/interface/wifi/get [find name="nope"] master-interface]
  exit 1, stderr "", stdout "no such item (...)"
```

RouterOS does set a non-zero **exit status**, and `exec()` was ignoring it. It
now rejects on a non-zero exit, on a signal kill, and on stderr as before.

### Why the exit code and not the text

Matching on the output would be worse than useless. `/log print` legitimately
returns lines containing "failure" and "error"; rejecting those would break
reads of real data. The exit status is unambiguous. There is a test asserting
that error-looking text with exit 0 still resolves, so this does not get
"improved" into a string heuristic later.

### What newly fails

Almost nothing, by design. Checked against real hardware: `remove`, `set` and
`disable` against an empty `[find ...]`, and `print`/`find` with no matches,
all exit 0 — so the idempotent patterns this tool is built on are unaffected.

What does now throw is `get` on an item that does not exist, which is a genuine
error the caller should handle, and any command RouterOS rejects outright.
Those previously passed silently.

Handled errors are respected. `:do {...} on-error={...}` catching a runtime
error exits 0, so deliberately-tolerated failures do not start throwing.
Compound commands separated by `;` propagate a failure in any statement.

One class this does **not** catch: a command that is accepted but answers
nothing, such as a bare `/interface get ... running` without `:put`. That exits
0. It is guarded separately by the command-form tests added in 6.2.3.

### Errors never carry secrets

Callers routinely log `e.message`, and WiFi commands carry
`security.passphrase="..."`. Errors no longer include the command text at all,
and device output is passed through a redactor before it reaches an exception,
so a failure cannot be the reason a wireless password lands in a console or a
CI log.

### A missing exit status is its own case

`ssh2` reports no code when a channel closes without an exit-status request.
That is not a RouterOS rejection, and reporting it as "exit null" would send
someone hunting a device error that never happened. It gets a distinct message
— and still rejects, because an unknown outcome must not be reported as
success.

## [6.2.3] - 2026-08-26 - Fix: `get` Needs `:put` (6.2.2 Did Not Work)

**6.2.2 did not work.** The SSID verification it added never functioned on real
hardware, and it made applies fail spuriously. Upgrade straight to 6.2.3.

A bare `/interface get [find name=X] running` prints **nothing** over an SSH
exec. RouterOS returns the value to an interactive console, not to stdout. It
has to be wrapped:

```
:put [/interface/get [find name="wifi2"] running]
```

6.2.2 sent the bare form for both of its queries. Every read came back as an
empty string, so:

- every interface looked not-running, and
- every `master-interface` lookup looked empty, so every interface was
  classified as a master radio.

On a live Chateau LTE6 that produced an apply which reported a perfectly
healthy master as `not running after 90s`, classified the virtual AP as a
master, and therefore **never ran the retry the feature exists for**. The
apply then failed with two unmet requirements while the WiFi was fine.

### What changed

Both queries are wrapped in `:put`. The command forms were verified against
live hardware before release this time, rather than only against a test double.

Two regression tests: one pins the query form, and one scans this module for
any `exec()` sending a bare `get [find ...]`, so the whole class of bug is
caught rather than the single instance.

### Why the tests missed it

The fake device returned canned values for whatever it was asked. It never
checked that the command was one RouterOS would actually answer. A mock that
answers a question the real device ignores will pass every time.

## [6.2.2] - 2026-08-26 - Verify SSIDs Actually Come Up

An apply could report complete success while an SSID was silently off the air.

Writing an interface's configuration is not the same as the radio accepting it.
A virtual AP created while its master is being reconfigured in the same pass can
be rejected, and RouterOS records that only as a comment on the interface:

```
;;; failed to create interface
2  BI wifi2-ssid2  wifi2  PartlyWork
```

The `set` that configured it returns no error, so the tool logged
`✓ Configured wifi2-ssid2` and moved on. Observed on a Chateau LTE6 running
RouterOS 7.18.2 with wifi-qcom: one of two configured SSIDs was missing for a
day behind a fully green apply, and the verification step had no WiFi check at
all to catch it.

### What changed

Every configured SSID is now read back after it is written.

**Virtual APs** that are not running are disabled and re-enabled — that
interface alone — and checked again, up to three attempts. The failure behaves
like a race rather than a hard rejection, and bouncing the virtual AP brings it
up. One that still will not come up is reported as an unmet requirement, so
`role: router` applies now fail instead of claiming success. The device's own
explanation is included when it left one.

**Master radios are never bounced.** The primary SSID on each band is
configured on the master, so this check runs against masters in normal
operation, and a master carries every associated client — very possibly
including whoever is running this tool over that radio.

A master also has entirely benign reasons to read as not-running: a DFS channel
availability check, a CAP still provisioning, CAPsMAN not finished activating
it. But so does a bad channel or a driver fault, and treating every one of them
as healthy would reintroduce this same bug on the primary SSID. So a
not-yet-running master is **deferred**, then polled until it comes up, on a
budget that covers a DFS availability check (~60s; up to 90s is allowed). A
fixed short wait would have condemned every healthy DFS radio — especially
under CAPsMAN, which applies channel settings immediately beforehand and can
restart the check. The budget is shared across all deferred radios rather than
applied to each in turn, so a controller with many inactive CAP radios does not
multiply the wait, and each poll round reads every outstanding radio so none is
judged on a stale result. Only a master still down when the budget runs out is
reported.

Whether an interface is virtual is decided by asking the device for its
`master-interface`, not by guessing from the name. If that cannot be
determined, the interface is treated as a master and left alone.

Interfaces whose state cannot be read are reported without pointless retries,
and a restart that itself fails is reported rather than swallowed.

The check lives in the shared interface-configuration path, so the CAPsMAN
roles get the retry and reporting too. Those roles have no postcondition
mechanism, so a dead SSID there is surfaced as a prominent summary at the end
of the run rather than failing the apply.

## [6.2.1] - 2026-08-25 - MSS Clamping On WAN Uplinks

The router role installed no TCP MSS clamp at all. On an uplink narrower than
1500 bytes — PPPoE at 1492, some LTE bearers — that shows up as connections
opening fine and then dying the moment real data flows: small requests work,
large transfers stall.

The usual defence is path MTU discovery, which depends on an ICMP
"fragmentation needed" reply that plenty of networks drop. Clamping the MSS on
the SYN says the limit up front instead, so the far end never sends a segment
the link cannot carry.

### What it installs

One mangle rule on `chain=forward`, commented `router:mss-clamp`, matching
`out-interface-list=WAN` with `new-mss=clamp-to-pmtu`. It is on by default and
costs nothing on a 1500-byte uplink, where it clamps to the value already in
use. Opt out with:

```yaml
lan:
  mssClamp: false
```

### Why there is no ingress rule

An earlier draft added a second rule on `in-interface-list=WAN` to cap what LAN
clients send outbound. That rule was wrong and never shipped. `clamp-to-pmtu`
derives the MSS from the route toward the packet's destination, so for an
inbound SYN-ACK it computes against the LAN bridge — normally 1500 — and clamps
to 1460 no matter how narrow the uplink is. It would have looked like it covered
the upload direction while doing nothing.

That direction is covered instead by the router's own ICMP "fragmentation
needed" back to the LAN client. It is generated one hop away, so it is rarely
the reply being filtered.

### Replacing an existing rule is failure-safe

A rule that has drifted — disabled by hand, edited to a fixed MSS, moved to
another chain — may still be doing useful work, so it is never removed before
the replacement is proven to exist. The new rule is added under
`router:mss-clamp-staged`, read back and checked, and only then does the old
rule go and the staged one take its name.

If the process dies between those last two steps, the staged rule *is* the live
clamp. The next apply adopts it by renaming rather than rebuilding, because
deleting a proven-good rule risks leaving the gateway with none.

A rule that is already correct is left completely untouched, so re-applying
never briefly unclamps a working gateway.

### Scope

This changes segment size, never rate. A slow uplink stays slow. It is a
robustness fix for MTU-constrained uplinks, not a throughput fix.

Not yet verified on a genuinely MTU-constrained path: the uplink available for
testing reports and carries a full 1500 bytes, so there was nothing to clamp.

## [6.2.0] - 2026-08-25 - WAN Failover Notifications

Adds an optional `notify` block to `role: router`. When the active uplink
changes — wired to LTE, and back — the device POSTs a short message to an
endpoint you choose.

Failover is silent by default, which is the actual problem with it: the router
moves to LTE, everything keeps working, and you find out weeks later from the
data bill.

### Configuration

```yaml
role: router

notify:
  url: https://ntfy.sh/your-topic-here   # required; any http(s) POST target
  title: office router failover          # optional; sent as an X-Title header
  interval: 30s                          # optional; default 30s
  checkCertificate: false                # optional; default false
```

The message body names the uplinks from your own `wan` block, prefixed with the
router's identity so one topic can carry several routers:

```
nick-office-router WAN: primary -> backup
```

Leaving the block out installs nothing. Removing it later removes the notifier
from the device on the next apply, so deleting the config really does turn it
off. The settings round-trip through `backup-config.js` like everything else.

### What it installs

A `wan-notify` script and a scheduler of the same name, both commented
`router:wan-notify` — the same comment-ownership convention the rest of the
router role uses. Re-applying replaces them and leaves hand-added objects
alone. A `wan-notify` object that does *not* carry that comment is reported and
left untouched rather than overwritten.

The active uplink is read from the routes the role already writes
(`/ip route find comment="wan:<name> default" active=yes`), so there is no
second source of truth about which uplink is preferred.

### State lives in the script's comment, not in a `:global`

This is the one detail that took hardware to get right.

**A `:global` set by a script the scheduler runs is discarded before the next
tick.** After clearing the variable and letting the scheduler run repeatedly, it
was absent from `/system/script/environment` entirely. Every tick would see
"unknown" and notify again.

The trap is that the same script run by hand with `/system script run` *does*
persist its globals, so the bug passes every interactive test.

The state is therefore written into the script object's own comment,
`router:wan-notify state=<uplink>`. That is configuration, so unlike a global it
also survives a reboot, and it is written only when the uplink actually changes,
so there is no flash wear.

### A failed send is retried, not lost

The stored state advances only *after* the POST succeeds. A failover that took
the internet with it therefore notifies as soon as the backup link is carrying
traffic, instead of being swallowed. Both outcomes are logged:

```
/log print where message~"wan-notify"
```

A total outage resolves to the state `none`, which is a transition of its own
rather than a stale "still on primary".

### RouterOS device-mode blocks this on a factory device

The Chateau LTE6 ships in `mode: home`, where **both `fetch` and `scheduler` are
disabled**. `/system/scheduler/add` fails outright with "failure: not allowed by
device-mode", and `/tool/fetch` fails the same way at runtime.

Applying now checks `/system/device-mode/print` first and stops at this feature
with the fix spelled out, rather than surfacing RouterOS's error:

```
/system/device-mode/update scheduler=yes fetch=yes
```

followed by a physical power cycle or reset-button press within five minutes.
RouterOS wants proof of physical access and no tool can supply it. Everything
else in the config is applied normally; only the notifier is skipped.

### Smaller decisions

- **`check-certificate=no` by default.** A factory device has zero CA
  certificates (`/certificate print count-only` returns 0) and the test device
  had ~292 KiB of flash free, far too little for a bundle. HTTPS works out of
  the box; `checkCertificate: true` turns verification on once you have imported
  a certificate, and warns that an empty store will fail every send.
- **`output=none` on the fetch**, so nothing writes a result file to that flash.
- **A comma in `title` is rejected.** RouterOS separates multiple
  `http-header-field` values with commas, so a comma would split the header.
- **An interval under 10 s warns.** A POST to an unreachable endpoint took about
  ten seconds to give up, and the check blocks for that whole time.
- **A plain `http://` endpoint warns.** For ntfy and most webhook services the
  URL *is* the credential.

### New in lib/routeros-args.js

`scriptSource()` encodes a multi-line RouterOS script as a `source=` argument. A
command reaches the device as one line, so real newlines would end the string
mid-command; they are rewritten to RouterOS's `\n` escape *after* the body is
escaped, which also leaves `$cur` intact (`\$` on the wire, `$` once stored).
Two new patterns, `HTTP_URL` and `NOTIFY_TITLE`, are shared by the validator and
the applier so a config applied as a library call is checked the same way.

### Verified

On the Chateau LTE6 (`D53G-5HacD2HnD&EG06-A`, RouterOS 7.18.2), against a local
HTTP sink: the generated script round-tripped through escaping unchanged, read
the live routes and resolved the active uplink correctly, delivered the POST
with its `X-Title` header, advanced its comment, sent nothing at all on a second
run, and — pointed at a dead endpoint — left the state untouched and logged that
it would retry.


## [6.1.2] - 2026-08-23 - Command Injection and Lockout Fixes

Fixes fourteen findings from a second, independent adversarial review (Codex)
of the router role. Two were Critical and six High. **Anyone running v6.1.0 or
v6.1.1 with `role: router` should upgrade.**

### Security — command injection via configuration values (Critical)

Every value from a YAML config was interpolated raw into RouterOS CLI command
strings. `escapeMikroTik()` existed in `lib/utils.js` but was not imported or
used anywhere in `lib/router.js`.

This had two consequences. The mundane one: a legitimate value containing a
quote or a dollar sign — an ISP PPPoE password is the obvious case — produced a
malformed command that failed or configured the wrong object. The serious one:
a crafted value could close the quoted string and append further commands,
which RouterOS runs with the SSH account's full privileges.

```
# before, with password: pa"ss;word
/interface pppoe-client add ... password="pa"ss;word" add-default-route=no
```

New `lib/routeros-args.js` provides one encoder used everywhere. It draws the
distinction that matters: quoted arguments are escaped with `q()`, while
unquoted ones (interface names, addresses, durations, distances) cannot be
rescued by escaping and are instead checked against strict patterns that
**throw** on anything unexpected. A bad value now stops the apply rather than
being silently rewritten into something else.

Applies to `lib/wifi-config.js` too, which the AP roles share.

### Lockout — cleanup ran even when the new address was never added (Critical)

`addLanAddress()` returned `false` on failure and `configureRouter()` ignored
it, then ran `removeStaleLanAddresses()` anyway. Cleanup now runs only when the
desired address is confirmed present on the device, read back after the fact.

### Lockout — the firewall drop rule trusted an unverified accept rule (High)

Replacement rules are added with `execWithWarning()`, which logs failures and
continues. A failed `router:input-lan` accept therefore did not stop the
subsequent WAN drop rule from being added, and the LAN-list check proved only
that `bridge` was a list member. The drop rule is now added only after the
accept rule is confirmed to exist; otherwise it is skipped and the router is
left open on its uplinks rather than unreachable.

### Ownership — cleanup deleted addresses it did not own (High)

`removeStaleLanAddresses()` removed every non-desired static address on the
bridge. A hand-added secondary or recovery address was silently deleted,
contradicting the comment-ownership model used everywhere else. It now removes
only addresses commented `router:lan` or the factory `defconf` address it
replaces. Static WAN configuration likewise removed every non-dynamic address
on the interface, and is now scoped to its own `wan:<name>` comment.

### Availability — applying during an outage made the outage worse (High)

All managed routes were removed up front, then recreated only for gateways
resolvable in a single read. An uplink that was down at apply time lost its
routes with nothing to put back. Gateways are now resolved before anything is
removed, each uplink's routes are replaced independently, a down uplink keeps
what it had, and an apply where no uplink resolves leaves the route table
untouched rather than emptying it.

### Correctness — an SSID could not move from tagged to untagged (High)

RouterOS `set` leaves unspecified properties unchanged, so omitting the VLAN
clause left the previous `datapath.vlan-id` in place. Untagged SSIDs now
explicitly unset it. Because that syntax is not exercised on every RouterOS
build and this code path configures every SSID for every role, a rejection
falls back to the previous behaviour with a warning rather than failing the
apply.

### Validation — checks only looked at what the user typed (High/Medium)

Distances and probes are filled in by `normalizeWans()`, but validation
inspected only explicit values. An omitted distance colliding with an explicit
one passed, as did the common case of a default probe of `8.8.8.8` alongside
`lan.dns.servers: [8.8.8.8]`. Validation now runs against the normalized list.

Also added: duplicate uplink names are rejected (names key route comments,
PPPoE client names, APN profile names and the backup map, so a collision made
one uplink overwrite another's objects); `CIDR_RE` checked shape only, so
`999.999.999.999/99` passed; and `lan.ports`, `lan.dns.servers`,
`dhcpServer.pool` and `dhcpServer.leaseTime` are now type- and
format-checked.

### Reporting — apply claimed success regardless of outcome (Medium)

Phases log warnings and continue, so an apply could report "Complete" with no
default route, no NAT, no DHCP and no LAN address. `verifyRouterState()` now
checks the LAN address, a managed default route, the masquerade rule, the
management accept rule and the DHCP server, and throws listing whatever is
missing.

### Backup — PPPoE passwords were silently dropped (Medium)

The password was written during apply but never read back, so applying a
generated backup reset the uplink with an empty password. It now round-trips,
and if it cannot be read the backup says so explicitly.

### Fixed — v6.1.1 rejected a working production config

The probe/resolver overlap check, added in v6.1.1, was an error. A real
deployment using `probe: 8.8.8.8` / `1.1.1.1` alongside
`lan.dns.servers: [1.1.1.1, 8.8.8.8]` therefore stopped applying on upgrade.

The overlap degrades DNS in one failure mode — queries picking the pinned
resolver stall until they time out and fall back — it does not break the
config. Refusing to apply a working production router over a slow path is the
worse trade, so it is now a warning. `validateRouterConfig()` returns
`{errors, warnings}` and both entry points print the warnings.

### Fixed — backup reported interfaces the device was not using

Three defects found by round-tripping a live production router:

- **RouterOS internal ids leaked into `lan.ports`.** A bridge port whose
  interface no longer resolves prints as `*2`. The widened port match added in
  v6.1.1 swept those up, so a backup could contain `interface=*2`, which is not
  usable in a config.
- **Disabled radios were backed up.** `print detail` never emits
  `disabled=yes`; disabled shows as an `X` in the flag field, so the existing
  check never matched and a disabled radio's SSIDs were reported as though the
  device were broadcasting them.
- **Band settings for a disabled radio were reported**, putting channel and
  width into the backup that the source config never declared.

With these fixed, a backup of a production router round-trips exactly.

### Fixed — third review round (Codex): 8 findings

**`applyBandSettings()` was still injectable (Critical).** The v6.1.2 encoding
pass covered `lib/router.js` and `configureWifiInterface()`, but missed this
function, which interpolates `txPower`, `width`, `country` and the interface
name straight into a command. It is called from five places in
`lib/capsman.js`, so this affected the AP roles, not just the router role.

**A disabled radio carrying a comment read as enabled.** The flag-field regex
required a `key=value` on the same line, but RouterOS can put a `;;;` comment
between the flags and the first property. Now parsed independently, with the
`X`-inside-a-value false positive covered by tests.

**Records past index 5 were merged or lost.** The WiFi interface scan treated
any trimmed line starting with `0`-`5` as a new record. Two radios plus four
virtual SSIDs is six interfaces, so real devices hit this: later interfaces
merged into their predecessor and a continuation line beginning with a digit
split a record in half. It now uses the same splitter as every other reader.

**The probe/resolver warning promised a fallback that might not exist.**
Downgrading the overlap to a blanket warning went too far the other way.
Severity now depends on what is actually left standing:

| Situation | Result |
|---|---|
| Some resolver is not a probe target | Warning — a fallback exists |
| Pinned resolvers span two or more uplinks | Warning — one stays reachable |
| Every resolver pinned to a single uplink | **Error** — that uplink failing takes DNS out |

**The VLAN-unset fallback assumed success.** If a RouterOS build rejects
`!datapath.vlan-id`, the retry cannot clear an existing VLAN. It now reads the
interface back and reports the interface as still tagged, with the manual
command, instead of reporting success.

**Orphaned bridge ports and unsupported names are now distinguished.** An
internal id such as `*2` is skipped quietly — it is not usable in a config — but
a real interface name this YAML format cannot express is reported, because
silently dropping a live LAN port from a backup is worse than saying so.

### Known: the AP roles still interpolate raw values

The encoding work so far covers `lib/router.js` and `lib/wifi-config.js`. A
repo-wide sweep found roughly forty further sites in `lib/configure.js`,
`lib/infrastructure.js` and `lib/capsman.js` — bond names, interface names,
VLAN ids, syslog server and topics, device identity, MAC addresses — that still
interpolate configuration values directly.

These predate the router role and are lower risk in practice: the values are
low-entropy identifiers unlikely to contain quotes, and the config author
already holds the device credentials. They are not fixed here because those
paths run against a production access-point fleet that this change set has no
way to test. Tracked rather than quietly half-done.

### Tests

49 assertions, up from 39. New coverage for the backup record parsing (flagged
and unflagged records, `;;;` comments, `X` inside a value, eight-record
splitting), band-setting injection, and each branch of the overlap severity
rule.

### Superseded

`test/router.test.js` grows to 39 assertions, adding command-argument safety
(quote, dollar sign, semicolon and `[find]` injection attempts against both
quoted and unquoted positions) and the validation gaps above.

### Verified on hardware

Exercised against a production Chateau LTE6 (RouterOS 7.18.2) running wired
Ethernet with LTE failover:

- The `!datapath.vlan-id` unset form is accepted; the fallback was not needed.
- All five postcondition checks pass on a healthy router.
- A second apply converges with no changes, and DHCP leases survive it.
- Backup round-trips exactly against the live config.
- Applying while the primary uplink is down keeps both routes and does not
  interrupt traffic.

Connectivity was never lost at any point during the test.

### Files
- `lib/routeros-args.js` — new; the one place command arguments are encoded
- `lib/router.js` — encoding throughout, ownership-scoped cleanup, route
  reconciliation, postcondition verification, PPPoE password readback
- `lib/wifi-config.js` — encoding, VLAN unset with fallback
- `lib/validate-router.js` — validates normalized values, unique names, strict types
- `test/router.test.js` — 38 assertions

## [6.1.1] - 2026-08-23 - Router Role Review Fixes

Fixes from an independent adversarial review of the v6.1.0 router role. All
thirteen findings were verified against the code and, where possible, against
RouterOS output captured from hardware. Two were crashes, one was a lockout
risk, and one meant an entire class of config went unvalidated.

### Fixed — multi-device backup crashed on any fleet containing a router

`lib/backup.js` deletes `managementInterfaces` and `disabledInterfaces` for
`role: router` (a router owns its LAN; it has no management interfaces).
`backup-multiple-devices.js` then read both unconditionally and threw
`TypeError: Cannot read properties of undefined`.

Worse, the throw happened *after* the config was pushed and counted as a
success, so the catch block appended a second `_backup_error` entry for the
same host — the written YAML got a duplicated device and a wrong failure count.

### Fixed — the lockout guard did nothing for FQDN hosts

`removeStaleLanAddresses()` refuses to delete the address carrying the current
session. It compared `config.host` directly, but that value is routinely an
FQDN in this project — device identity is derived from it. `ipToInt()` returns
null for a hostname, so `cidrContains()` returned false, the guard never fired,
and the tool would delete the address it was connected through.

The host is now resolved to an IPv4 address first. If it cannot be resolved,
nothing is removed and the situation is reported, rather than guessing.

### Fixed — router configs in a fleet were never validated

`validateRouterConfig()` lived inside `apply-config.js` and was only called
there. `apply-multiple-devices.js` had a comment claiming routers were
"validated by apply-config's router rules" — they were not. A router in a
multi-device deployment reached `configureRouter()` with no checks at all.

Validation now lives in `lib/validate-router.js` and both entry points call it.

### Fixed — a malformed lan.address crashed mid-apply

`configureDhcpServer()` dereferenced `parseCidr(lan.address).address` unguarded.
Combined with the missing fleet validation above, a router with a
`lan.dhcpServer` block and a bad `lan.address` threw *after* NAT, the firewall
and the routes had already been rewritten. It now skips the DHCP server with a
warning, and validation rejects the combination up front.

### Fixed — a removed uplink resurrected itself

Interface-list rebuild removed only the members named in the *current* config,
so an uplink deleted from the YAML kept its `WAN` list member forever. Since
those member comments are the authoritative record for backup, the deleted
uplink reappeared on the next backup and was re-applied. Members are now
cleared by comment.

### Fixed — tagged SSIDs backed up without their VLAN

Nothing in this codebase assigns a *named* datapath to an interface;
`configureWifiInterface()` writes `datapath.bridge=... datapath.vlan-id=N`
inline. Backup only ever looked for a named datapath, so tagged SSIDs were
previously skipped entirely, and after the v6.1.0 untagged-SSID change they
were recorded with `vlan` silently missing.

The VLAN is now read inline off the interface, in both spellings RouterOS
prints (`datapath.vlan-id=` and the bare `.vlan-id=` continuation).

### Fixed — probe addresses could collide with resolvers

A probe address is pinned to its uplink by a `/32` route with no health check.
If that uplink is up but the path beyond it is dead, the pin remains and the
address stops answering. The shipped example used `8.8.8.8` and `1.1.1.1` as
both probe targets *and* `lan.dns.servers`, so a resolver would be pinned to a
failing uplink and stall every query that picked it.

Validation now rejects the overlap, and the example uses separate addresses.

### Fixed — more than four uplinks silently shared a probe

`normalizeWans()` fell back to the last default probe once its list of four ran
out, giving two uplinks the same target. Two `/32` routes on one destination
with different gateways make the recursive lookup follow whichever won,
disabling failover for those links. It now throws and asks for explicit probes.

### Fixed — smaller correctness issues

- `addLanAddress()` compared only the host part of the address, so changing
  `/24` to `/25` read as "already present"; it was also a substring match, so
  `10.0.0.1/24` matched inside `110.0.0.1/24`. It now compares whole tokens.
- LAN port discovery matched only `ether\d+`, dropping `sfp`, `sfp-sfpplus`
  and bond members from backups.
- `splitDetailRecords()` assumed a `Flags:` header always precedes record 0.
  RouterOS omits it for object types with no flags — `/ip pool print detail` is
  one — so record 0 was discarded. It now detects whether a header is present.
- `lan.dhcpServer.dns` and a PPPoE `user` were written during apply but never
  read back, violating the project rule that every configurable knob must
  round-trip.
- `configureRouterWifi()` created a datapath object that nothing referenced.

### Added — regression tests

`test/router.test.js`, 29 assertions, run by `npm test` and now by CI. Covers
the address helpers, WAN normalisation, the member-comment round-trip,
validation, and the RouterOS output parsing — using fixtures captured from
hardware rather than invented output, since every parsing bug so far came from
a format that looked plausible but was not what the device prints.

### Files
- `lib/validate-router.js` — new; shared validation for both entry points
- `test/router.test.js` — new; regression suite
- `lib/router.js` — host resolution, probe exhaustion, member cleanup, guards, parsing
- `lib/backup.js` — inline VLAN readback
- `backup-multiple-devices.js` — router-aware summary
- `apply-config.js`, `apply-multiple-devices.js` — use the shared validator
- `router.example.yaml` — resolvers no longer collide with probe targets
- `.github/workflows/ci.yml`, `package.json` — run the tests

## [6.1.0] - 2026-08-23 - Router Role with Multi-WAN Failover

### Added — `role: router`

A fourth role, alongside `standalone`, `controller` and `cap`. Those three roles
configure access points and deliberately strip router functions. This one keeps
them: the device is the gateway.

It was built for the MikroTik Chateau LTE6 (`D53G-5HacD2HnD&EG06-A`), which
pairs five Ethernet ports with a built-in LTE modem, and was verified on that
hardware running RouterOS 7.18.2.

```yaml
role: router

lan:
  address: 192.168.80.1/24
  ports: [ether2, ether3, ether4, ether5]
  dhcpServer:
    pool: 192.168.80.100-192.168.80.200
    leaseTime: 12h
  dns:
    servers: [1.1.1.1, 8.8.8.8]
    allowRemoteRequests: true

wan:
  - name: primary
    interface: ether1
    type: dhcp          # dhcp | static | pppoe | lte
    distance: 1         # lower wins
    probe: 8.8.8.8
  - name: backup
    interface: lte1
    type: lte
    apn: fast.t-mobile.com
    distance: 2
    probe: 1.1.1.1      # must differ from every other probe
```

The role configures the LAN bridge, a DHCP server, a DNS cache, masquerade NAT,
an ordered firewall, and the uplinks with failover between them.

### Failover design

Each uplink gets a probe route pinning one address to that uplink, plus a
default route whose gateway is that probe address. RouterOS resolves the default
route recursively through the probe route, and `check-gateway=ping` tests the
whole path rather than just the first hop.

This catches the case a next-hop check misses: a modem that has lost its own
uplink but still answers pings on its LAN side.

Measured on a Chateau LTE6 failing over from wired Ethernet to LTE and back:

| What broke | Mechanism | Measured |
|---|---|---|
| Link down (cable pulled) | Probe route's next hop stops resolving; default route drops out at once | 1.2 s |
| Link up, path beyond dead | Probe pings time out: every 10 s, two consecutive failures | 20–30 s |
| Link restored | DHCP re-binds before the probe route resolves again | ~36 s |

Failover is fast, not invisible. Each uplink has its own public address, so open
connections through a dead uplink break and new ones use the live uplink.

Known limit: the probe route pins the gateway learned at apply time. A dhcp or
pppoe uplink that returns with a different gateway leaves that route stale, and
the uplink will not recover until a re-apply. Applying is idempotent, so a
scheduled re-apply covers this.

Two settings exist to keep failover honest, and both are applied automatically:

- Every uplink is created with `add-default-route=no`, so nothing competes with
  the failover routes.
- Every uplink is created with `use-peer-dns=no` and the router uses the
  resolvers from `lan.dns.servers`. Keeping ISP-supplied resolvers would leave
  the router pointing at unreachable servers after a failover — routing works,
  every lookup times out, and it reads as a failed failover.

### Interface lists

The role maintains the `WAN` and `LAN` interface lists that RouterOS default
configs already use, so one NAT rule and one firewall rule cover every uplink
however many there are.

The `WAN` list member comment is the authoritative record of each uplink's
settings, in the form `wan:<name> type=... distance=... probe=...`. Routes only
exist while a link is up, so reading settings back from routes alone would drop
an unplugged uplink from the backup. The list member is always present.

### Lockout safety

Changing `lan.address` cuts the session applying the change. The role adds the
new address before removing the old one, and refuses to remove the address
carrying the current session. So the first run leaves both addresses in place,
and a second run made over the new address clears the old one. There is never a
moment when the device has no reachable address.

### Idempotent re-apply

The DHCP server, its pool and its network entry are updated in place rather
than removed and re-added. Removing a DHCP server discards its lease table, so
the earlier approach would have dropped every lease on a second apply. Verified
on hardware: a seeded lease survives a re-apply.

### Fixed — WiFi band token was hardcoded to 802.11ax

`lib/configure.js` set `channel.band=2ghz-ax` / `5ghz-ax` unconditionally. On a
radio that predates 802.11ax the command fails outright. New
`detectBandToken()` in `lib/wifi-config.js` reads the radio's advertised bands
and picks the best it supports (`2ghz-ax` > `n` > `g` > `b`; `5ghz-ax` > `ac` >
`n` > `a`), falling back to the `-ax` token so existing ax hardware behaves
exactly as before.

Verified on an IPQ4019 radio, which advertises `2ghz-g,2ghz-n` and
`5ghz-a,5ghz-n,5ghz-ac` and is now configured as `2ghz-n` and `5ghz-ac`.

### Fixed — `country` was never read back

RouterOS prints this value unquoted even though it contains a space
(`.country=United States`). The backup matched a quoted form only, so the
country silently never round-tripped on any role. `parseCountry()` in
`lib/backup.js` now accepts both forms.

### Fixed — untagged SSIDs were dropped from backups

The SSID reader required a datapath with a VLAN, so an SSID with no `vlan` was
skipped entirely. Untagged SSIDs are now read back, and `vlan` is omitted from
the result rather than emitted as null. The empty `wifi.roaming` placeholder is
no longer written either; it was not valid input.

### Fixed — RouterOS detail records split on wrapped numeric lists

Record splitting used `\n(?=\s*\d+\s)`, which also matches the final line of a
wrapped numeric list such as `2g-channels=...,\n      2472`. That silently cut
records in half and made band detection return nothing. Both splitters now
require the index to sit at the left margin.

### Backup

`backupMikroTikConfig()` detects a router by its `router:masquerade` NAT rule and
reads back `lan` and `wan`, setting `role: router` so a backup re-applies
cleanly. Verified as an exact round-trip on hardware, including an uplink whose
cable was unplugged.

### Validation

`apply-config.js` rejects, before touching the device:

- a missing or malformed `lan.address`
- an empty `wan` list, or an uplink with no interface or an unknown type
- a `static` uplink with no address or no gateway
- two uplinks sharing a distance
- two uplinks sharing a probe address, which would silently break the recursive
  lookup
- an interface listed as both a WAN and a LAN port

`ssids` are optional for this role, and so is each SSID's `vlan`: a router owns
an untagged LAN, unlike the AP roles that tag for an upstream switch.

### Files
- `lib/router.js` — new; the role, its helpers, WiFi setup and its backup reader
- `lib/wifi-config.js` — `detectBandToken()`; `configureWifiInterface()` accepts an undefined vlan
- `lib/configure.js` — dispatches `role: router`
- `lib/backup.js` — router backup reader, `parseCountry()`, untagged-SSID support
- `lib/index.js`, `mikrotik-no-vlan-filtering.js` — export `configureRouter`
- `apply-config.js` — router validation and dispatch
- `apply-multiple-devices.js` — passes `lan`/`wan` through, deploys routers alongside standalone devices
- `router.example.yaml` — new, fully commented
- `README.md`, `Dockerfile`, `docker-entrypoint.sh` (`example-router`) — docs and packaging
- `package.json` — version 6.1.0

## [6.0.0] - 2026-05-01 - Fleet-Wide Device Blocking

### Added — `blockedDevices` (top-level)

A new top-level configuration field rejects a MAC at 802.11 association on every interface across the entire fleet. Useful for stopping reconnect storms from misbehaving clients (e.g., appliances that are firewalled at the gateway but keep retrying their cloud connection every ~20 minutes, burning airtime).

Compare to existing `lockedDevices`, which pins a MAC to one specific AP (accept on target, reject elsewhere). `blockedDevices` issues reject rules everywhere with no corresponding accept rules.

```yaml
# Top level alongside ssids, devices, country
blockedDevices:
  - hostname: refrigerator
    mac: FC:B9:7E:79:59:FA
  - hostname: laundry
    mac: FC:B9:7E:51:30:3C
```

Rules are tagged with the comment `<hostname> - blocked everywhere`. Diff-based update logic from v4.x applies: re-running with the same `blockedDevices` is a no-op.

To temporarily allow a blocked device (e.g., for firmware updates):
1. Comment the entry out, re-run apply (rules are removed).
2. Allow at upstream firewall.
3. After update, restore the entry, re-run apply.

### Breaking — `backupAccessLists()` return shape

`lib/access-list.js#backupAccessLists()` now returns `{lockedDevices, blockedDevices}` instead of a bare array of locked devices. Callers must destructure:

```js
// before (5.x)
const lockedDevices = await backupAccessLists(mt, wifiPath);

// after (6.0)
const { lockedDevices, blockedDevices } = await backupAccessLists(mt, wifiPath);
```

In-tree callers (`lib/backup.js`, `backup-multiple-devices.js`) have been updated. External consumers using this function directly need the same change. Top-level `apply-config.js` / `apply-multiple-devices.js` flows are unaffected — `blockedDevices` is opt-in and the existing config keeps working unchanged.

### Files modified
- `lib/access-list.js` — `buildDesiredRules` accepts `blockedDevices`, `getCurrentLockingRules` filter expanded, `configureAccessLists` signature extended, `backupAccessLists` return shape changed
- `apply-multiple-devices.js` — reads top-level `config.blockedDevices`, threads into access-list phase
- `lib/backup.js` — destructures new return shape, stores blocked list on the config
- `backup-multiple-devices.js` — promotes per-device `blockedDevices` to deployment level
- `multiple-devices.example.yaml` — documents the new field
- `package.json` — version 6.0.0

## [5.3.0] - 2026-02-09 - Fix CAPsMAN Channel Propagation

### Fixed - CAPsMAN Channel Settings Not Applied to CAP Interfaces

Channel frequency settings from device configuration were only applied to local WiFi fallback configuration, not to CAPsMAN-provisioned interfaces on the controller. This caused CAPsMAN to auto-select channels, ignoring the configured channel plan.

- Fixes [Issue #10](https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/10)

### Root Cause

Phase 2.5 configured SSID, security, datapath, and VLAN on CAPsMAN-provisioned interfaces, but did not set `channel.frequency`. The channel settings from each CAP's config were available but never applied to the controller-side interfaces.

### Solution

Apply channel settings AFTER all SSID/security/datapath configuration is complete:
1. Configure all master interfaces and virtual interfaces first
2. Apply channel settings using `applyBandSettings()` as the final step

Channel settings must be applied last because CAPsMAN operations during virtual interface creation can reset `channel.frequency` to auto-select.

### Log Output
```
=== Configuring CAP Interfaces ===
Configuring far-bedroom-wap-2g with SSID: PartlySonos
  ✓ Configured far-bedroom-wap-2g: SSID="PartlySonos", VLAN=100
...
=== Applying Channel Settings ===
✓ Applied 2.4GHz settings: channel.frequency=2412, channel.width=20mhz
  ✓ far-bedroom-wap-2g: channel applied
✓ Applied 5GHz settings: channel.frequency=5500, channel.tx-power=15, channel.width=20/40/80mhz
  ✓ far-bedroom-wap-5g: channel applied
```

### Files Modified
- `lib/capsman.js` - Apply channel settings as final step after all interface configuration

## [5.2.0] - 2026-02-08 - Fix Controller Local Radios Not Configured

### Fixed - Controller Local Radio Interfaces Not Configured by Deploy
- **Bug**: In CAPsMAN deployments, the controller's own local radios (wifi1/wifi2) were never configured with SSID/security/datapath settings
- **Symptom**: Controller local radios retained stale settings from previous runs. IoT SSIDs had `security.ft=yes` when they should have had `ft=no`, causing hundreds of FT authentication failures per day
- **Root cause**: Phase 1 set `configuration.manager=capsman-or-local` but never applied SSID settings. Phase 2.5 configured remote CAP interfaces but explicitly skipped local interfaces (`wifi1`/`wifi2`)
- Fixes [Issue #9](https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/9)

### Solution
Phase 2.5 (`configureCapInterfacesOnController()`) now configures controller local radios after configuring remote CAP interfaces:

1. **Detect radio layout** - Handles swapped radios on cAP ax, etc.
2. **Clean up old virtual interfaces** - Removes only virtuals whose master is `wifi1`/`wifi2` (not remote CAP virtuals)
3. **Configure master interfaces** - Applies primary SSID with correct FT, steering, datapath/VLAN settings
4. **Create virtual interfaces** - Additional SSIDs get virtual interfaces with bridge ports and correct PVID
5. **Disable unused bands** - If no SSIDs target a band, the master interface is disabled

### Verification
After applying configuration, verify on controller:
```bash
# Check controller local interfaces have correct FT settings
/interface/wifi print detail where name~"wifi"
# IoT SSIDs should show security.ft=no
# Roaming SSIDs should show security.ft=yes

# Check steering profiles exist
/interface/wifi/steering print

# Check virtual interfaces have bridge ports with correct PVID
/interface/bridge/port print where interface~"wifi"
```

### Files Modified
- `lib/capsman.js` - Added controller local radio configuration to `configureCapInterfacesOnController()`
- `CHANGELOG.md` - This entry
- `package.json` - Version bump to 5.2.0
- `CLAUDE.md` - Updated CAPsMAN documentation

## [5.1.1] - 2026-01-19 - Fix Radio Disable for Per-WAP SSID

### Fixed
- CAP interfaces are now properly disabled when no SSIDs are configured for a band
- Previously, skipping configuration left interfaces enabled with stale config
- Now Phase 2.5 explicitly runs `disabled=yes` on unused band interfaces
- CAPsMAN propagates this to CAP devices, powering down the unused radio

### Example
```yaml
# shed-wap configured with 5GHz only
ssids:
  - ssid: PartlyPrimary
    bands: [5GHz]
```
Results in:
- `shed-wap-2g` on controller: disabled
- `wifi1` on shed-wap CAP: disabled (MBX flag)
- 2.4GHz radio powered off

## [5.1.0] - 2026-01-19 - Per-WAP SSID Customization

### Added - Per-WAP SSID Customization for CAPsMAN Deployments

Enable each access point to broadcast different SSIDs on different bands. This is possible because wifi-qcom CAPsMAN configures CAP interfaces directly on the controller.

### Schema Design

**Deployment-level SSIDs** define PSKs, VLANs, and roaming settings once:
```yaml
ssids:
  - ssid: PartlyPrimary
    passphrase: secret-password
    vlan: 100
    roaming:
      fastTransition: true
  - ssid: PartlyIoT
    passphrase: iot-password
    vlan: 200
```

**Per-device SSIDs** specify which SSIDs to broadcast and on which bands:
```yaml
devices:
  - device: { host: indoor-wap.example.com, ... }
    role: cap
    ssids:
      - ssid: PartlyPrimary
        bands: [2.4GHz, 5GHz]    # All bands
      - ssid: PartlyIoT
        bands: [2.4GHz]          # 2.4GHz only

  - device: { host: outdoor-wap.example.com, ... }
    role: cap
    ssids:
      - ssid: PartlyPrimary
        bands: [2.4GHz]          # 2.4GHz only for range
      # No PartlyIoT on this AP
```

### Key Features

- **Fully declarative**: PSKs defined once at deployment level, devices list SSIDs by name
- **Band control**: Each device specifies which bands for each SSID
- **SSID selection**: Devices can omit SSIDs to not broadcast them
- **Backwards compatible**: Legacy full-SSID format still works

### Implementation

- **`resolveSsidsForDevice()`**: Merges device SSID references with deployment templates
- **Phase 2.5**: Passes per-CAP resolved SSIDs to controller interface configuration
- **Phase 2.6**: Uses per-CAP resolved SSIDs for local fallback configuration
- **Backup**: Automatically promotes SSIDs to deployment level in CAPsMAN deployments

### Use Cases

1. **Indoor vs Outdoor**: Indoor APs broadcast all SSIDs; outdoor only primary network
2. **Guest isolation**: Only lobby APs broadcast guest network
3. **IoT placement**: Only APs near IoT devices broadcast IoT SSID
4. **Band selection**: High-throughput areas use 5GHz; coverage-focused use 2.4GHz

### Files Modified

- `apply-multiple-devices.js` - Added `resolveSsidsForDevice()`, updated validation, Phase 2.5/2.6
- `lib/capsman.js` - Updated `configureCapInterfacesOnController()` to use per-CAP SSIDs
- `backup-multiple-devices.js` - Promotes SSIDs to deployment level for CAPsMAN
- `multiple-devices.example.yaml` - Updated with per-device SSID examples
- `package.json` - Version bump to 5.1.0

## [5.0.0] - 2026-01-19 - Remove wifiwave2 Support (BREAKING CHANGE)

### Breaking Change: wifiwave2 WiFi Package No Longer Supported

**This release removes support for the wifiwave2 WiFi package.** Only wifi-qcom devices are now supported.

**If you have wifiwave2 devices, you must stay on v4.x releases.**

### Why This Change?

- All 6 devices in the deployment are confirmed wifi-qcom
- wifi-qcom and wifiwave2 have fundamentally different CAPsMAN implementations
- Maintaining dual code paths added complexity with no benefit
- Simplifies the codebase significantly

### What Changed

#### Removed
- **wifiwave2 CAPsMAN provisioning/configuration objects** - These were only used by wifiwave2
- **wifiwave2 FT authentication type** (`ft-psk`) - wifi-qcom uses `security.ft=yes` instead
- **wifiwave2 interface verification** - Used `name=wifi1` instead of `default-name=wifi1`
- **Phase 2.5 skip logic** - wifiwave2 used provisioning rules, wifi-qcom uses direct configuration

#### Simplified
- `getWifiPath()` - Always returns `/interface/wifi/*` paths
- `getCapsmanPath()` - Always returns `/interface/wifi/capsman/*` paths
- `getCapPath()` - Always returns `/interface/wifi/cap`
- `detectWifiPackage()` - Returns `wifi-qcom` or `null` (wifiwave2 is rejected with error message)

### Migration Guide

**For wifi-qcom devices (no action needed):**
- Your devices will continue to work with no configuration changes

**For wifiwave2 devices:**
- Stay on v4.x releases
- Use `npm install network-config-as-code@4.8.0` to pin to last compatible version
- Docker: Use `ghcr.io/nickborgers/mikrotik-as-wap-configurator:4.8.0`

### Files Modified
- `lib/utils.js` - Simplified path helpers
- `lib/infrastructure.js` - Updated `detectWifiPackage()` to reject wifiwave2
- `lib/backup.js` - Removed package detection, always use wifi-qcom
- `lib/configure.js` - Removed wifiwave2 interface queries and FT auth branching
- `lib/capsman.js` - Removed CAPsMAN provisioning/configuration object code
- `lib/wifi-config.js` - Updated comments
- `CLAUDE.md` - Updated documentation
- `package.json` - Version bump to 5.0.0

## [4.9.0] - 2026-01-19 - Fix Virtual SSID Traffic on CAP Devices

### Fixed - Virtual SSID Traffic Not Flowing on CAP Devices
- **Critical Bug**: Clients on virtual SSIDs could connect but had no network connectivity
- **Symptom**: Clients associated successfully but weren't in bridge host table, couldn't be pinged
- **Root cause**: wifi-qcom CAPsMAN "traffic processing on CAP" mode requires two settings that were missing
- Fixes [Issue #5](https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/5)

### Technical Root Cause

With wifi-qcom CAPsMAN in "traffic processing on CAP" mode:
1. CAPsMAN manages the control plane (SSID broadcast, client association)
2. CAP handles the data plane locally (bridging traffic)

The problem was:
1. **`slaves-static=no` (default)**: CAPsMAN didn't enable local virtual interfaces for data traffic
2. **No bridge ports for virtual interfaces**: Even with `datapath.bridge=bridge`, virtual WiFi interfaces weren't added as bridge ports

### Solution

Two changes were required:

1. **Enable `slaves-static=yes`** in CAP settings
   - This tells CAPsMAN to use local static virtual interfaces for data traffic
   - Virtual interfaces now show as "Bound, Running" instead of "Inactive"

2. **Add virtual interfaces as bridge ports with correct PVID**
   - Each virtual interface needs a bridge port entry
   - PVID must match the SSID's VLAN for proper traffic handling

### Implementation

**configureCap()** - Now enables `slaves-static=yes`:
```routeros
/interface/wifi/cap set ... slaves-static=yes
```

**configureLocalCapFallback()** - Now adds bridge ports and restarts CAP mode:
```routeros
# Add virtual interfaces to bridge with PVID
/interface/bridge/port add interface=wifi2-ssid2 bridge=bridge pvid=100

# Restart CAP mode to force CAPsMAN rebind
/interface/wifi/cap set enabled=no
/interface/wifi/cap set enabled=yes slaves-static=yes
```

The CAP mode restart is necessary because CAPsMAN needs to rebind to the newly created/updated local static interfaces. Without this restart, virtual interfaces remain "Inactive" even with `slaves-static=yes`.

### Verification

After applying configuration, verify on CAP devices:
```bash
# Virtual interfaces should show BR (Bound, Running)
/interface/wifi print
# Should show: wifi2-ssid2 BR, wifi2-ssid3 BR, etc.

# Interface traffic stats should show non-zero values
/interface print stats where name~"ssid"
# Should show RX/TX bytes for virtual interfaces

# Clients should appear on virtual interfaces in bridge host table
/interface/bridge/host print where on-interface~"ssid"
# Should show client MACs on wifi1-ssid2, wifi2-ssid2, etc.
```

### Files Modified
- `lib/capsman.js` - Added `slaves-static=yes` to CAP configuration
- `lib/capsman.js` - Added bridge port creation for virtual interfaces in `configureLocalCapFallback()`

### Affected Devices
- All wifi-qcom CAP devices using CAPsMAN with multiple SSIDs

### References
- [MikroTik Forum: wifi CAPsMAN and slave interfaces](https://forum.mikrotik.com/t/wifi-capsman-wifi-qcom-ac-caps-and-slave-interfaces-in-vlan-environnent/181308)
- [VLANs on MikroTik cAP ac with wifi-qcom-ac](https://www.jaburjak.cz/posts/mikrotik-wifi-qcom-ac-vlans/)

## [4.8.0] - 2026-01-19 - IGMP Snooping Support

### Added - IGMP Snooping
- **Optional per-device IGMP snooping** - Enable multicast optimization on the bridge
- **Use case**: Optimizes multicast traffic for Sonos, Chromecast, and similar devices
- **Behavior**: When enabled, multicast is only forwarded to ports with interested receivers
- **Default**: `false` (disabled) - matches MikroTik's default behavior
- **Configuration**: `igmpSnooping: true` at device level in YAML
- **Backup support**: IGMP snooping state is backed up from devices (stored only when enabled)

### Configuration Example
```yaml
# Single device (config.yaml)
igmpSnooping: true

# Multi-device (multiple-devices.yaml)
devices:
  - device:
      host: wap.example.com
    igmpSnooping: true
```

## [4.7.0] - 2026-01-18 - Graceful Access-List Updates

### Added - Diff-Based Access-List Updates
- **Non-disruptive WAP locking rule updates** - Devices already on correct AP are no longer disconnected
- Fixes [Issue #4](https://github.com/NickBorgers/mikrotik-as-wap-configurator/issues/4)

### How It Works
1. **Fetch current rules** - Read existing access-list rules from controller
2. **Compute desired state** - Build target rules from config
3. **Diff comparison** - Identify rules to add vs remove
4. **Add-first strategy** - Create new ACCEPT rules before any deletions
5. **Remove stale rules** - Only delete rules that are no longer needed
6. **Orphaned rule handling** - Detect and replace rules with `interface=*xxx` (internal IDs)

### Benefits
- **No unnecessary disconnections** - If a rule already matches, it's left untouched
- **Idempotent** - Running apply multiple times produces same result without churn
- **Graceful interface rebuilds** - When Phase 2.5 recreates WiFi interfaces, orphaned rules are detected and replaced
- **Add-before-remove** - Devices get new ACCEPT rules before any are removed

### Technical Details
- New helper functions: `getCurrentLockingRules()`, `buildDesiredRules()`, `diffRules()`
- Rule comparison uses key: `MAC|interface|action`
- Orphaned rules (interface field = `*xxx`) are filtered out and removed
- Phases: Phase 1 (ACCEPT adds) → Phase 2 (REJECT adds) → Phase 3a (orphaned removal) → Phase 3b (stale removal)

### Output Example
```
=== Computing Access-List Changes (diff-based) ===
  Rules unchanged: 120
  Rules to add: 0
  Rules to remove: 0

✓ All rules already match desired state - no changes needed
  (No devices will be disconnected)
```

## [4.6.0] - 2026-01-18 - Local WiFi Fallback for CAP Devices

### Added - Local WiFi Fallback (Phase 2.6)
- **CAP devices now have local WiFi configuration** - When a CAP loses connection to the CAPsMAN controller, WiFi continues working
- **Problem solved**: Previously, if the controller went down, all CAP WiFi stopped broadcasting
- **Solution**: Phase 2.6 applies the same WiFi configuration locally on each CAP device
- Since CAPs use `capsman-or-local` manager mode, they automatically fall back to local config when the controller is unavailable

### How It Works
- **Phase 2.6** added to `apply-multiple-devices.js` after Phase 2.75 (access-lists)
- For each CAP device:
  1. Connects via SSH
  2. Detects WiFi package and radio layout (including swapped radios on cAP ax)
  3. Cleans up old local datapaths and virtual interfaces (idempotent)
  4. Configures each SSID on appropriate interfaces (wifi1/wifi2)
  5. Applies per-CAP band settings (txPower, channel)

### Configuration
No YAML changes required - local fallback is automatic when using CAPsMAN mode with deployment-level SSIDs.

### Verification
After applying configuration:
```bash
# Check local WiFi config on a CAP
/interface/wifi print detail
# Should show configuration.ssid, security.*, datapath.* on all interfaces
# Manager mode should be capsman-or-local
```

Test fallback by disconnecting the controller - CAP WiFi should continue broadcasting.

### Files Added/Modified
- `lib/capsman.js` - Added `configureLocalCapFallback()` function
- `lib/index.js` - Export new function
- `mikrotik-no-vlan-filtering.js` - Re-export new function
- `apply-multiple-devices.js` - Added Phase 2.6 orchestration

### Benefits
- **High availability** - WiFi continues working during controller outages
- **Graceful degradation** - Clients stay connected even if management fails
- **No config changes needed** - Works automatically with existing CAPsMAN deployments
- **Non-fatal errors** - If one CAP fails local config, others continue

## [4.5.3] - 2026-01-18 - Fix WAP Locking Rule Cleanup

### Fixed
- **WAP locking rules now properly cleaned up when devices are removed from config**
- Previously, cleanup only removed rules for MACs currently in the config
- If a device was removed from `lockedDevices`, its access-list rules remained orphaned on the controller
- Fix: Now removes ALL rules matching "lock to" or "locked to" comment patterns before applying new rules
- This ensures removed devices have their rules cleaned up and the controller state matches config

### Technical Details
- Changed cleanup from per-MAC iteration to pattern-based removal
- Uses MikroTik's `find` with `comment~"lock to" or comment~"locked to"` to match all locking rules
- Cleanup runs even when `lockedDevices` is empty (cleanup-only mode)
- The comment patterns are stable and won't match user-created rules

### Files Modified
- `lib/access-list.js` - Rewrote cleanup logic to remove all locking rules before applying config

## [4.5.2] - 2026-01-17 - Fix Bridge MAC for DHCP Static Leases

### Fixed
- **Bridge admin-mac now set to match management interface** - DHCP static leases were failing because the bridge was using ether2's MAC instead of ether1's
- Root cause: MikroTik's default config sets `auto-mac=no` with a manually assigned `admin-mac` that doesn't match the bond's `forced-mac-address`
- The DHCP client runs on the bridge, so it was sending requests with the wrong MAC (ether2) instead of the bond's MAC (ether1)
- Fix: After configuring management interfaces, explicitly set bridge `admin-mac` to match the management interface MAC

### Technical Details
- For LACP bonds: Bridge admin-mac is set to the bond's `forced-mac-address` (which is ether1's `orig-mac-address`)
- For simple interfaces: Bridge admin-mac is set to the first management interface's `orig-mac-address`
- This ensures DHCP requests use the same MAC as the static lease binding

### Files Modified
- `lib/infrastructure.js` - Added `setBridgeAdminMac()` function, modified `configureManagementInterfaces()` to track and set bridge MAC
- `lib/configure.js` - Added same bridge admin-mac logic for standalone mode

## [4.5.1] - 2026-01-17 - Fix Docker Smoke Tests

### Fixed
- **Docker entrypoint passthrough** - Allow `sh`, `bash`, `node` commands to bypass config file checks
- Smoke tests were failing because `sh -c '...'` was falling through to the `apply` case which requires config.yaml
- Added passthrough for debugging and smoke test commands

## [4.5.0] - 2026-01-17 - Unified CAPsMAN Config Structure

### Changed - Config Structure Consolidation
- **Unified `capsman` block** - All CAPsMAN-related settings now consolidated under `capsman` key
- **Old format** (still supported for backwards compatibility):
  ```yaml
  role: cap
  capsmanAddress: 10.252.50.2
  cap:
    controllerAddresses:
      - 10.252.50.1
  ```
- **New unified format**:
  ```yaml
  role: cap
  capsman:
    controllerAddresses:
      - 10.252.50.1
    vlan:
      address: 10.252.50.2
  ```

### Benefits
- **Cleaner config** - All CAPsMAN settings in one place
- **Consistent naming** - Uses `capsman` instead of `cap` for CAPsMAN settings
- **Better structure** - VLAN settings nested under `capsman.vlan` with `id`, `network`, `address`
- **Backwards compatible** - Legacy formats still work

### Files Modified
- `lib/backup.js` - Output unified format (`capsman.vlan.id/network/address`)
- `lib/infrastructure.js` - Read from both unified and legacy formats
- `lib/capsman.js` - Support `capsman.controllerAddresses` and `cap.controllerAddresses`
- `apply-multiple-devices.js` - Build unified config from various sources
- `backup-multiple-devices.js` - Extract using new format
- `multiple-devices.example.yaml` - Updated example to use unified format
- `CLAUDE.md` - Updated documentation

## [4.4.3] - 2026-01-17 - Single-Device CAP/Controller Support

### Added - apply-config.js CAP/Controller Mode Support
- **CAP role support**: `apply-config.js` now properly configures CAP devices using the `configureCap()` function
- **Controller role support**: `apply-config.js` now properly configures CAPsMAN controllers using the `configureController()` function
- Previously, `apply-config.js` only worked for standalone mode - CAP/controller configs would partially apply

### Fixed
- **SSID validation for CAP mode**: CAP devices no longer require SSIDs in config (they receive SSIDs from controller)
- **Config structure handling**: Properly flattens `device.host/username/password` for CAP/controller functions
- **Display output**: Shows "Role: CAP (SSIDs received from controller)" instead of trying to list non-existent SSIDs

### Notes
- Single-device CAP configs require: `capsmanVlan.vlan`, `capsmanVlan.network`, and `capsmanAddress` at root level
- For multi-device deployments, use `apply-multiple-devices.js` which handles the full CAPsMAN lifecycle

## [4.4.2] - 2026-01-17 - Add Docker Image Smoke Tests

### Added - Post-Push Verification
- **Smoke tests for Docker images** - Verify pushed images actually work
- Runs after every Docker image push to catch packaging issues early
- Tests include:
  1. `help` command works
  2. `example` command outputs valid config
  3. All required modules can be loaded (catches missing `lib/` etc)
  4. `apply-multiple-devices.js` syntax is valid

### Prevention
This test would have caught the missing `lib/` directory issue in v4.3.2-v4.4.0 before it reached users.

### Reference
Prompted by: https://github.com/NickBorgers/home-automation/issues/477

## [4.4.1] - 2026-01-17 - Fix Docker Build

### Fixed - Docker Image Missing lib/ Directory
- **Bug**: Docker images since v4.3.2 were broken - missing `lib/` directory
- **Symptom**: `Error: Cannot find module './lib'` when running Docker image
- **Root cause**: Dockerfile was not updated when code was modularized in v4.3.2
- **Fix**: Added `COPY lib ./lib` to Dockerfile
- Also added missing `backup-config.js` and `backup-multiple-devices.js` to Docker image

## [4.4.0] - 2026-01-17 - WAP Locking via Access-List Rules

### Added - WAP Locking Feature
- **Lock WiFi clients to specific APs** - Prevent stationary devices from roaming unnecessarily
- **YAML-based configuration** - Define `lockedDevices` per device in `multiple-devices.yaml`
- **Automatic rule generation** - Creates ACCEPT rules on target AP and REJECT rules on all others
- **SSID-specific locking** - Optionally lock to specific SSID only, or all SSIDs the AP serves
- **Idempotent operation** - Removes existing rules for MAC before creating new ones

### Use Cases
- **Sonos speakers** - Prevent audio dropouts from unnecessary roaming
- **IoT devices** - Keep stationary devices like SPAN panels, Powerwalls on nearest AP
- **Smart home devices** - Ensure reliable connectivity for devices that shouldn't roam

### Configuration
```yaml
devices:
  - device:
      host: shed-wap.nickborgers.net
    role: cap
    lockedDevices:
      - hostname: sonos-barn        # Human-readable name
        mac: "80:4A:F2:8B:D2:FA"    # Client MAC address
        ssid: PartlySonos           # Optional: specific SSID only
      - hostname: smart-thermostat  # No ssid = all SSIDs
        mac: "48:A6:B8:8E:49:2C"
```

### Implementation Details
- **Phase 2.75** - New deployment phase after CAP interface configuration
- **Rules on controller** - Access-list rules stored on CAPsMAN controller
- **Backup support** - `backup-multiple-devices.js` reads rules and distributes to target device configs
- **Debug command**: `/interface/wifi/access-list print detail` on controller

### Files Added/Modified
- `lib/access-list.js` - NEW: Core access-list logic (`configureAccessLists`, `backupAccessLists`)
- `lib/index.js` - Export new functions
- `lib/backup.js` - Add access-list backup step
- `apply-multiple-devices.js` - Add Phase 2.75 for access-list configuration
- `backup-multiple-devices.js` - Distribute locked devices to target device configs
- `mikrotik-no-vlan-filtering.js` - Re-export new functions
- `multiple-devices.example.yaml` - Add lockedDevices example
- `CLAUDE.md` - Document the feature

### Verification
After applying, check rules on controller:
```
/interface/wifi/access-list print detail
# Shows ACCEPT rules for target APs, REJECT rules for all others
```

## [4.3.10] - 2026-01-17 - Fix DHCP Client Removal for LACP Bond Slaves

### Fixed - Invalid DHCP Clients on Bond Slave Interfaces
- **Bug**: When configuring LACP bonds, the default DHCP client on ether1 becomes invalid but wasn't removed
- **Symptom**: Devices with LACP bonds lose internet connectivity - pings fail, DNS resolution fails, software updates fail
- **Root cause**: MikroTik marks DHCP clients on slave interfaces as invalid, but they still obtain IP addresses and create duplicate routes, causing incorrect source address selection
- **Impact**: Affected devices with LACP bonding (typically those with redundant uplinks)

### Solution
When configuring LACP bonds, the script now removes DHCP clients from bond member interfaces before making them slaves. This prevents:
1. Invalid DHCP clients obtaining IP addresses on slave interfaces
2. Duplicate default routes causing ECMP behavior
3. Wrong source address selection for outbound traffic

### Technical Details
- DHCP clients cannot run on slave/passthrough interfaces in MikroTik
- Even when marked as INVALID, the DHCP client was still receiving an IP and creating routes
- The duplicate routes caused the device to use the slave interface's IP as source address
- Upstream routers/gateways wouldn't respond to traffic from the unexpected source IP

### Files Modified
- `lib/configure.js` - Added DHCP client removal step before bond creation
- `lib/infrastructure.js` - Added DHCP client removal step in `configureLacpBond()`

### Verification
After applying configuration, devices should have only one DHCP client (on bridge):
```
/ip/dhcp-client print
# INTERFACE  USE-PEER-DNS  ADD-DEFAULT-ROUTE  STATUS  ADDRESS
0 bridge     yes           yes                bound   10.x.x.x/24
```

## [4.3.9] - 2026-01-17 - Apply Transition Threshold to wifi-qcom Steering Profiles

### Fixed - Transition Threshold Not Applied (Issue 006)
- **Bug**: The `transitionThreshold` value from YAML configuration was not being applied to wifi-qcom steering profiles
- **Symptom**: 802.11v BSS Transition Management didn't have proper signal thresholds configured
- **Root cause**: The steering profile creation only set `rrm` and `wnm` properties, missing the `transition-threshold` parameter

### Solution
When creating wifi-qcom steering profiles with WNM enabled, now also set the `transition-threshold` parameter:
1. Create steering profile with `rrm` and `wnm` settings
2. Set `transition-threshold` separately (MikroTik quirk: can't be in add command)
3. Handles gracefully on older RouterOS versions that may not support the parameter

### Important Note
Unsolicited 802.11v BSS transition management (which uses `transition-threshold`) requires **RouterOS 7.21beta2 or newer**. On earlier versions (like 7.18.x), the parameter is accepted but may not be functional until firmware is upgraded.

### Example Log Output
```
Configuring far-bedroom-wap-2g with SSID: PartlyPrimary
  ✓ Configured far-bedroom-wap-2g: SSID="PartlyPrimary", VLAN=100, 802.11r, 802.11k, 802.11v(-80dBm)

Creating virtual interface far-bedroom-wap-2g-ssid3 for SSID: PartlyIoT
  ✓ Configured far-bedroom-wap-2g-ssid3: SSID="PartlyIoT", VLAN=100, 802.11r, 802.11k, 802.11v(-75dBm)
```

### Files Modified
- `lib/wifi-config.js` - Added transition-threshold setting to steering profile creation

### Related
- Fixes issue 006 (Transition Threshold Not Applied)
- Transition thresholds: PartlyPrimary/PartlyWork: -80 dBm, PartlyIoT: -75 dBm

## [4.3.8] - 2026-01-17 - Fix Virtual Interface Master-Interface References After Rename

### Fixed - Controller Virtual Interface master-interface References Swapped
- **Bug**: After master interface renaming (v4.3.1 feature), virtual interfaces had incorrect `master-interface` references
- **Symptom**: Interfaces named `-2g-ssidX` pointed to `-5g` master interfaces and vice versa
- **Root cause**: When master interfaces are swapped, MikroTik updates the virtual's `master-interface` property to follow the renamed master, but the virtual interface NAME is not updated
- **Example**: After swap, `cap-2g-ssid2` with `master-interface=cap-5g` (name says 2g, master says 5g)

### Solution
After swapping master interface names, also rename virtual interfaces to match their (renamed) masters:
1. Find all virtual interfaces for the swapped CAP identity
2. Compare virtual interface name band (`-2g-` or `-5g-`) with master-interface band
3. If mismatched, rename virtual interface to match its master

### Example Log Output
```
=== Renaming interfaces for managed-wap-north ===
  ✓ managed-wap-north-2g → managed-wap-north-swap-temp (temp)
  ✓ managed-wap-north-5g → managed-wap-north-2g
  ✓ managed-wap-north-swap-temp → managed-wap-north-5g
  Checking 4 virtual interface(s) for managed-wap-north...
  ✓ Virtual: managed-wap-north-2g-ssid2 → managed-wap-north-5g-ssid2
  ✓ Virtual: managed-wap-north-2g-ssid3 → managed-wap-north-5g-ssid3
```

### Files Modified
- `lib/wifi-config.js` - Added `renameVirtualInterfacesForSwappedMasters()` function

### Related
- Completes fix for issue 005 (Controller Virtual Interface master-interface References Swapped)
- Related to v4.3.1 CAPsMAN Radio Detection & Interface Renaming feature

## [4.3.7] - 2026-01-17 - Fix TX Power Not Applied on CAP Interfaces

### Fixed - Per-Device TX Power in CAPsMAN Phase 2.5
- **TX power now applied correctly to CAP interfaces** during Phase 2.5 configuration
- Per-device `wifi.2.4GHz.txPower` and `wifi.5GHz.txPower` settings are now passed from CAP device configs to the controller when configuring CAP interfaces

### Root Cause
The `configureCapInterfacesOnController()` function was only receiving the controller's configuration, not the individual CAP device configurations. This meant per-device settings like `txPower` were never applied to CAP interfaces.

### Technical Details
**Problem:** CAP interfaces like `managed-wap-north-2g` were not receiving their configured TX power values.

**Solution:**
1. Modified `configureCapInterfacesOnController()` to accept an array of CAP device configs
2. Updated `apply-multiple-devices.js` to pass CAP device configs (host, identity, wifi) to Phase 2.5
3. Extended `configureWifiInterface()` to accept and apply `bandSettings.txPower`
4. CAP identity is extracted from interface name (e.g., `managed-wap-north-2g` → `managed-wap-north`) to look up the correct device config

### Files Modified
- `lib/capsman.js` - Accept `capDeviceConfigs` array, pass band settings to interface configuration
- `lib/wifi-config.js` - Accept `bandSettings` parameter, apply `configuration.tx-power` when specified
- `apply-multiple-devices.js` - Build and pass CAP device configs to Phase 2.5

### Example
With this fix, a CAP configuration like:
```yaml
- device:
    host: managed-wap-north.nickborgers.net
  role: cap
  wifi:
    2.4GHz:
      txPower: 10
```

Now correctly results in:
```
managed-wap-north-2g configuration.tx-power=10
```

## [4.3.6] - 2026-01-17 - Consolidate wifi-qcom/wifiwave2 Handling

### Refactored - WiFi Package Detection and Path Handling
- **Consolidated duplicate code** - `lib/configure.js` now uses centralized helpers instead of inline logic
- **Uses `detectWifiPackage()`** from `lib/infrastructure.js` instead of duplicate detection code
- **Uses `getWifiPath()`** from `lib/utils.js` instead of scattered inline ternary expressions
- **Removed dead code** - Removed unreachable 'wireless' package branch (legacy package not supported)

### Technical Details
The codebase had two patterns for handling wifi-qcom vs wifiwave2:
1. **Good pattern** (in lib/utils.js, lib/infrastructure.js, lib/capsman.js): Centralized helpers
2. **Scattered pattern** (in lib/configure.js): Duplicate detection and inline path construction

This release consolidates to the good pattern:

**Before (duplicate detection in configure.js):**
```javascript
const packages = await mt.exec('/system package print terse where name~"wifi"');
if (packages.includes('wifiwave2')) { ... }
else if (packages.includes('wifi-qcom')) { ... }
const wifiCmd = wifiPackage === 'wifiwave2' ? '/interface/wifiwave2' : '/interface/wifi';
```

**After (using centralized helpers):**
```javascript
const wifiPackage = await detectWifiPackage(mt);
const wifiCmd = getWifiPath(wifiPackage);
```

### Files Modified
- `lib/configure.js` - Refactored to use centralized `detectWifiPackage()` and `getWifiPath()`
- `lib/wifi-config.js` - Updated comment for clarity on security.ft usage

### Benefits
- Single source of truth for package detection logic
- Easier maintenance when package behavior changes
- Cleaner, more readable code in configure.js
- Reduced code duplication across modules

## [4.3.5] - 2026-01-17 - Add 802.11k (RRM) and 802.11v (WNM) Support

### Added - 802.11k/v Support for wifi-qcom and Standalone Modes
- **802.11k (RRM)** - Radio Resource Management / Neighbor Reports
- **802.11v (WNM)** - Wireless Network Management / BSS Transition
- Support added to both CAPsMAN (wifi-qcom) and standalone configurations
- Steering profiles created automatically when RRM or WNM is enabled

### Technical Details - wifi-qcom Steering Profiles
wifi-qcom requires steering configuration as separate profile objects, not inline properties:

```bash
# Steering profile created per interface
/interface/wifi/steering add name="steering-shed-wap-2g" rrm=yes wnm=yes

# Interface references the profile
/interface/wifi set shed-wap-2g steering="steering-shed-wap-2g" ...
```

### Configuration
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: password
    vlan: 100
    bands: [2.4GHz, 5GHz]
    roaming:
      fastTransition: true  # 802.11r
      rrm: true             # 802.11k - NEW
      wnm: true             # 802.11v - NEW
      transitionThreshold: -80  # Signal threshold for steering
```

### Files Modified
- `lib/wifi-config.js` - Added steering profile creation for CAP interfaces
- `lib/configure.js` - Added steering profile creation for standalone mode

### Verification
Steering profiles visible on controller:
```
/interface/wifi/steering print
  - steering-shed-wap-2g rrm=yes wnm=yes
  - steering-shed-wap-2g-ssid3 rrm=yes wnm=yes
  - ...
```

Interface references steering profile:
```
/interface/wifi get shed-wap-2g steering
steering=steering-shed-wap-2g
```

## [4.3.4] - 2026-01-17 - Fix 802.11r Incorrectly Enabled on SSIDs Without Roaming

### Fixed - Fast Transition (802.11r) Applied to SSIDs Without Roaming Configuration
- **Bug**: SSIDs without `roaming.fastTransition` were still getting 802.11r enabled
- **Symptom**: PartlySonos SSID (no roaming configured) had `.ft=yes` on most devices
- **Root cause**: `configureWifiInterface()` in `lib/wifi-config.js` only added `.ft=yes` when enabled, but didn't explicitly set `.ft=no` when disabled
- **Impact**: Stationary devices like Sonos could experience unnecessary roaming behavior

### Affected Devices
- All wifi-qcom CAPsMAN CAP devices
- Example SSIDs: PartlySonos (should have NO roaming, was getting 802.11r)

### Solution
- Explicitly set `security.ft=no security.ft-over-ds=no` when SSID does not have `roaming.fastTransition: true`
- Ensures any previous FT settings are cleared
- Matches behavior of standalone configuration in `lib/configure.js`

### Example
YAML configuration:
```yaml
- ssid: PartlySonos
  passphrase: password
  vlan: 100
  bands: [2.4GHz]
  # No roaming - Sonos devices are stationary
```

Before fix:
```
security.authentication-types=wpa2-psk .passphrase="password" .ft=yes
```

After fix:
```
security.authentication-types=wpa2-psk .passphrase="password" .ft=no
```

## [4.3.3] - 2026-01-17 - Fix Missing SSIDs on CAP Devices

### Fixed - CAP Virtual Interface Cleanup
- **Bug**: CAP devices were missing SSIDs that should be broadcast according to YAML configuration
- **Symptom**: Only some SSIDs appeared on CAP devices (e.g., only 1 of 4 SSIDs on 2.4GHz)
- **Root cause**: `configureCapInterfacesOnController()` did not clean up existing virtual interfaces before creating new ones
- **Impact**: Running configuration multiple times left stale virtual interfaces, causing inconsistent SSID configurations

### Affected Devices
- All wifi-qcom CAP devices using CAPsMAN Phase 2.5 configuration
- Examples: shed-wap, outdoor-wap-east, outdoor-wap-north

### Solution
- Added cleanup step that removes existing virtual interfaces for each CAP master interface before configuration
- Ensures idempotent operation - running multiple times produces consistent results
- Mirrors the cleanup behavior already present in standalone configuration

### Example Log Output
```
=== Cleaning Up Old CAP Virtual Interfaces ===
  ✓ Removed 3 virtual interface(s) from shed-wap-2g
  ✓ Removed 1 virtual interface(s) from shed-wap-5g

=== Configuring CAP Interfaces ===
Configuring shed-wap-2g with SSID: PartlyPrimary
  ✓ Configured shed-wap-2g: SSID="PartlyPrimary", VLAN=100

Creating virtual interface shed-wap-2g-ssid2 for SSID: PartlySonos
  ✓ Created virtual interface shed-wap-2g-ssid2
  ✓ Configured shed-wap-2g-ssid2: SSID="PartlySonos", VLAN=200
```

## [4.3.2] - 2026-01-17 - Modular Code Refactoring

### Changed - Code Organization
- **Refactored monolithic file** - Split 3,051-line `mikrotik-no-vlan-filtering.js` into 9 logical modules
- **New `lib/` directory** containing:
  - `constants.js` - Band maps, frequency/channel lookup tables
  - `utils.js` - Path helpers, string escaping utilities
  - `ssh-client.js` - MikroTikSSH class for device connectivity
  - `infrastructure.js` - Bridge, DHCP, bonding, syslog configuration
  - `wifi-config.js` - Radio detection, band settings, interface configuration
  - `capsman.js` - CAPsMAN controller/CAP functions
  - `backup.js` - Device backup functionality
  - `configure.js` - Main configureMikroTik entry point
  - `index.js` - Facade re-exporting all public APIs

### Fixed
- **diag/check-device.js** - Fixed incorrect relative path for module import

### Backward Compatibility
- **No breaking changes** - All existing imports continue to work unchanged
- `mikrotik-no-vlan-filtering.js` now re-exports from `lib/index.js`
- All 6 public APIs preserved: `configureMikroTik`, `configureController`, `configureCap`, `configureCapInterfacesOnController`, `backupMikroTikConfig`, `MikroTikSSH`

## [4.3.1] - 2026-01-17 - CAPsMAN Radio Detection & Interface Renaming

### Fixed - CAP Interface Band Detection and Naming
- **Bug**: CAP interfaces were incorrectly named - `-2g` interfaces were actually 5GHz radios (and vice versa)
- **Symptom**: Clients connecting to `<cap>-2g` SSIDs were actually on 5GHz
- **Root cause**: MikroTik names CAP interfaces based on physical interface number, not actual radio band
- **Affected devices**: cAP ax, cAP ac, and some wAP ax units
- **Important discovery**: Even identical board models can have different radio layouts!

### Solution - Automatic Interface Renaming
- **Detect actual bands** via radio hardware query
- **Rename misnamed interfaces** so `-2g` is ALWAYS 2.4GHz and `-5g` is ALWAYS 5GHz
- Virtual interfaces inherit correct naming from master interfaces

### How It Works
1. **Detect actual bands** from `/interface/wifi/radio print detail`
2. **Identify misnamed interfaces** where suffix doesn't match actual band
3. **Swap interface names** using temp name to avoid conflicts:
   ```
   managed-wap-north-2g → managed-wap-north-swap-temp (temp)
   managed-wap-north-5g → managed-wap-north-2g
   managed-wap-north-swap-temp → managed-wap-north-5g
   ```
4. **Configure SSIDs** on correctly-named interfaces

### New Functions
- `getRadioBandMapping()` - Query radio hardware to get actual band for each interface
- `renameCapInterfacesToMatchBand()` - Rename interfaces so suffix matches actual band
- `getSwappedRadioCaps()` - Fallback: identify swapped devices by board type

### Example Log Output
```
ℹ️  managed-wap-north-2g: Actual band is 5GHz (via radio hardware) - will rename

=== Renaming interfaces for managed-wap-north ===
  ✓ managed-wap-north-2g → managed-wap-north-swap-temp (temp)
  ✓ managed-wap-north-5g → managed-wap-north-2g
  ✓ managed-wap-north-swap-temp → managed-wap-north-5g

Found 10 CAP interface(s):
  - managed-wap-north-2g (2.4GHz)  ← Correct!
  - managed-wap-north-5g (5GHz)    ← Correct!
```

## [4.3.0] - 2026-01-16 - wifi-qcom CAPsMAN Support

### Added - wifi-qcom CAPsMAN Direct Interface Configuration
- **wifi-qcom CAPsMAN support** - Fixed CAPsMAN configuration for wifi-qcom devices
- **Problem**: wifi-qcom doesn't support `/interface/wifi/capsman/configuration` or `/provisioning` commands
- **Solution**: Configure CAP-operated interfaces directly on the controller after CAPs connect
- **New Phase 2.5** - Multi-device deployment now includes automatic CAP interface configuration

### New Functions
- `discoverCapInterfaces()` - Discover CAP-operated interfaces on controller by naming pattern
- `configureCapInterfacesOnController()` - Configure CAP interfaces with SSID/security/datapath
- `configureWifiInterface()` - Reusable helper for inline WiFi interface configuration

### How It Works
1. **Phase 1**: Controller enables CAPsMAN service (no configuration/provisioning objects for wifi-qcom)
2. **Phase 2**: CAPs connect to controller, creating CAP interfaces (e.g., `shed-wap-2g`, `indoor-wap-5g`)
3. **Phase 2.5** (NEW): Controller configures each CAP interface directly:
   ```
   /interface/wifi set shed-wap-2g \
       configuration.ssid="MySSID" \
       security.authentication-types=wpa2-psk \
       security.passphrase="..." \
       datapath.bridge=bridge datapath.vlan-id=100 \
       disabled=no
   ```

### Backward Compatibility
- **wifiwave2 devices**: Continue using existing configuration/provisioning approach
- Phase 2.5 automatically detects wifiwave2 and skips (not needed)
- No changes to YAML schema required

## [4.2.0] - 2026-01-16 - Code Simplification & Refactoring

### Changed - Major Code Refactoring
- **Extracted shared helper functions** - Reduced code duplication across `configureMikroTik()`, `configureController()`, and `configureCap()`
- **New reusable helpers** - Added 10 shared helper functions for common operations:
  - `execIdempotent()` - Execute commands with graceful "already exists" handling
  - `execWithWarning()` - Execute commands with warning-level error handling
  - `setDeviceIdentity()` - Set device identity from FQDN hostname
  - `detectWifiPackage()` - Detect WiFiWave2 vs wifi-qcom package
  - `ensureBridgeInfrastructure()` - Create bridge and disable VLAN filtering
  - `configureManagementInterfaces()` - Configure bridge ports and LACP bonds
  - `configureDisabledInterfaces()` - Disable unused Ethernet interfaces
  - `enableDhcpClient()` - Enable DHCP client on bridge
  - `configureSyslog()` - Configure remote syslog
  - `detectRadioLayout()` - Detect WiFi radio layout (standard vs swapped)
  - `applyBandSettings()` - Apply channel/power/country settings per band

### Technical Details
- Reduced `configureController()` from 314 to ~180 lines
- Reduced `configureCap()` from 296 to ~130 lines
- Reduced total file size from 2534 to 2447 lines (~87 lines / 3.4%)
- Eliminated ~150 lines of duplicated try-catch error handling
- Eliminated ~100 lines of duplicated setup code across 3 functions
- All helper functions include JSDoc documentation

### Backward Compatibility
- No changes to YAML schema or API
- All existing configurations work unchanged
- No changes to CLI tools or Docker commands

## [4.1.1] - 2026-01-16 - LACP Bond Support for CAPsMAN

### Fixed - LACP Bond Configuration in CAPsMAN Mode
- **Missing bond support** - `configureController()` and `configureCap()` were not handling LACP bonds
- **Deterministic MAC addresses** - Bonded CAPsMAN devices now use `forced-mac-address` from first interface
- **Shared helper function** - Extracted `configureLacpBond()` for consistent bond configuration across all modes

### Technical Details
- Previously, LACP bonds with deterministic MACs only worked in standalone mode
- CAPsMAN devices with bonds (controller or CAP) would lose their forced MAC if reset and re-provisioned
- Now all three modes (standalone, controller, cap) properly configure bonds with `orig-mac-address`

## [4.1.0] - 2026-01-16 - Dedicated CAPsMAN VLAN & Docker Multi-Device Support

### Added - Docker Multi-Device Support
- **`apply-multiple` command** - Apply configurations to multiple devices from Docker
- **`example-multiple` command** - Output example `multiple-devices.yaml` configuration
- **Full flag support** - Pass `--parallel`, `--delay <secs>`, `--no-delay` to control deployment
- Multi-device configuration is now a first-class Docker feature

### Docker Usage
```bash
# Get example multi-device configuration
docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator example-multiple > multiple-devices.yaml

# Apply to multiple devices (sequential with 5s delay)
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple

# Apply in parallel (faster, but network-wide outage)
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --parallel

# Custom delay between devices
docker run -v $(pwd)/multiple-devices.yaml:/config/multiple-devices.yaml \
  ghcr.io/nickborgers/mikrotik-as-wap-configurator apply-multiple --delay 10
```

### Added - CAPsMAN VLAN for L2 Connectivity
- **Dedicated CAPsMAN VLAN** - Solves wifi-qcom L3 connectivity issues
- **Problem**: wifi-qcom CAPsMAN has issues with L3/IP layer CAP↔Controller connections
- **Solution**: Put all CAP↔Controller traffic on a dedicated L2 VLAN
- **Static IP addressing** - Each device gets a predictable IP on the CAPsMAN VLAN
- **Firewall protection** - Admin access (SSH/HTTP) blocked via CAPsMAN VLAN
- **Only CAPWAP allowed** - UDP 5246-5247 traffic permitted on CAPsMAN VLAN

### New YAML Schema
```yaml
# Deployment-level CAPsMAN VLAN configuration
capsmanVlan:
  vlan: 2525                    # VLAN ID for CAPsMAN traffic
  network: 10.252.50.0/24       # Network for static IP addressing

devices:
  # Controller
  - device:
      host: controller.example.com
    role: controller
    capsmanAddress: 10.252.50.1      # Static IP on CAPsMAN VLAN
    capsman:
      certificate: auto

  # CAP
  - device:
      host: cap1.example.com
    role: cap
    capsmanAddress: 10.252.50.2      # Static IP on CAPsMAN VLAN
    cap:
      controllerAddresses:
        - 10.252.50.1                # Controller's CAPsMAN VLAN IP
```

### Implementation Details
- Creates VLAN interface `capsman-vlan` on bridge
- Assigns static IP with network prefix
- Adds firewall rules (place-before=0 for priority):
  - Allow CAPWAP (UDP 5246-5247) from CAPsMAN VLAN
  - Block all other traffic from CAPsMAN VLAN
- CAPs use `capsman-vlan` as discovery interface when configured
- Backup reads CAPsMAN VLAN config and stores `capsmanAddress` per device

### Backward Compatibility
- `capsmanVlan` is optional - existing CAPsMAN configs work unchanged
- Without `capsmanVlan`, CAPs use bridge interface for discovery (L3 mode)
- CAPsMAN VLAN only used when both `capsmanVlan` and `capsmanAddress` are set

### Rollback
```bash
# Remove CAPsMAN VLAN on a device
/interface vlan remove [find name=capsman-vlan]
/ip firewall filter remove [find comment~"CAPsMAN"]
```

## [4.0.0] - 2026-01-16 - CAPsMAN Support with 802.11r/k/v Roaming

### Added - CAPsMAN Centralized WiFi Management
- **Three device roles**: `standalone` (default), `controller`, `cap`
- **Controller mode**: Runs CAPsMAN service, manages CAP devices, also acts as AP
- **CAP mode**: Receives WiFi configuration from controller, applies local channel overrides
- **Coordinated roaming**: 802.11r/k/v work properly with CAPsMAN coordination

### Added - 802.11k/v Support (CAPsMAN)
- **802.11k (RRM)**: Neighbor reports - APs tell clients about nearby APs
- **802.11v (WNM)**: BSS Transition Management - APs steer weak-signal clients
- **Per-SSID config**: `roaming: { rrm: true, wnm: true, transitionThreshold: -80 }`
- Note: 802.11k/v only effective in CAPsMAN mode, not standalone

### Added - Cross-VLAN/L3 Support
- **No shared broadcast domain needed** - CAPsMAN works over L3 routing
- **DTLS encryption** - CAP-to-controller management traffic encrypted
- **Certificate authentication** - Optional mutual certificate auth for security
- **Firewall**: Allow UDP 5246-5247 from CAP management VLANs to controller

### Added - Controller-First Deployment
- `apply-multiple-devices.js` auto-detects CAPsMAN mode
- Controller configured first, then 5-second wait for service initialization
- CAPs configured after controller is ready
- Deployment summary shows device roles

### New YAML Schema
```yaml
# Controller example
role: controller
capsman:
  certificate: auto
  requirePeerCertificate: false
ssids:
  - ssid: MyNetwork
    roaming:
      fastTransition: true  # 802.11r
      rrm: true             # 802.11k
      wnm: true             # 802.11v

# CAP example
role: cap
cap:
  controllerAddresses:
    - 10.212.254.1
  certificate: request
  lockToController: true
wifi:
  2.4GHz: { channel: 6 }   # Local override
```

### Backward Compatibility
- `role` defaults to `standalone` - existing configs work unchanged
- Migration is opt-in by adding `role` field

## [3.0.0] - 2026-01-15 - Per-SSID 802.11r Configuration

### Breaking Change
**Roaming configuration moved from device-level to per-SSID**

This allows disabling 802.11r (Fast Transition) for specific SSIDs where stationary devices (like Sonos speakers, IoT devices) may have compatibility issues.

#### Old Schema (v2.x)
```yaml
wifi:
  roaming:
    enabled: yes
    fastTransition: yes   # Applied to ALL SSIDs
ssids:
  - ssid: MyNetwork
    vlan: 100
    bands: [2.4GHz, 5GHz]
```

#### New Schema (v3.0)
```yaml
ssids:
  - ssid: MyNetwork
    vlan: 100
    bands: [2.4GHz, 5GHz]
    roaming:
      fastTransition: true   # Per-SSID control

  - ssid: Sonos
    vlan: 100
    bands: [2.4GHz]
    # No roaming = 802.11r disabled for this SSID
```

### Migration Guide
1. Remove `wifi.roaming` from your configuration
2. Add `roaming: { fastTransition: true }` to SSIDs that need 802.11r
3. Leave `roaming` absent for stationary device SSIDs

### Benefits
- **Fix Sonos/IoT issues**: Disable 802.11r for networks with stationary devices
- **Granular control**: Enable roaming only where mobile devices benefit
- **Cleaner config**: Roaming is now with the SSID it affects

### Technical Details
- Apply: Per-SSID `roaming.fastTransition` determines FT authentication type
- Backup: Detects FT per-interface and adds `roaming` to appropriate SSIDs
- wifi-qcom devices: Uses `security.ft=yes/no` parameter
- wifiwave2 devices: Uses `ft-psk,wpa2-psk` or `wpa2-psk` auth types

## [2.8.0] - 2026-01-12 - Graceful Client Handling During Updates

### Added - Staggered Multi-Device Deployment
- **Configurable delay between devices** - Default 5-second pause allows WiFi clients to roam to stable APs
- **`--delay <secs>`** - Set custom delay between devices (e.g., `--delay 10` for 10 seconds)
- **`--no-delay`** - Skip delays for faster deployment when client disruption is acceptable
- Delay only applies in sequential mode (not parallel)

### Added - WiFi Client Evacuation
- **Pre-reconfiguration client disconnect** - Clients are disconnected before interface cleanup begins
- **2-second roaming window** - Brief pause after disconnect gives clients time to find other APs
- Clients get a head start reconnecting elsewhere before interfaces are torn down
- Non-fatal: reconfiguration proceeds even if evacuation fails

### Improved - Client Experience During Fleet Updates
- Combined staggered deployment + client evacuation minimizes disruption
- Typical update flow: evacuate clients → reconfigure → wait → next device
- Clients on 802.11r/k/v networks benefit most from the roaming windows

### Usage
```bash
# Default: 5s delay between devices
./apply-multiple-devices.js multiple-devices.yaml

# Custom delay for slower client roaming
./apply-multiple-devices.js multiple-devices.yaml --delay 10

# Fast mode (no delays)
./apply-multiple-devices.js multiple-devices.yaml --no-delay
```

## [2.7.1] - 2026-01-10 - Critical VLAN Tagging Fix

### Fixed
- **VLAN tagging not applied** - WiFi clients were being placed on the untagged management VLAN instead of their configured VLAN. Root cause: referencing named datapath objects (`datapath="wifi1-vlan100"`) wasn't applying VLAN settings to interfaces. Fix: set `datapath.vlan-id` directly inline on each WiFi interface.
- **Interface name reset** - Added step to reset WiFi interface names to defaults during cleanup, ensuring idempotency when interfaces have been manually renamed.

## [2.7.0] - 2026-01-10 - Managed WAP Mode, LACP Bonding & Device Identity

### Added - Managed WAP Mode
- **Pure Layer 2 WAP operation** - Device now configured as a proper managed WAP
- **DHCP client on bridge** - Gets management IP from upstream network automatically
- **Router functions disabled** - Removes DHCP servers, static IPs, NAT rules, and DNS serving
- Ensures device operates purely as a VLAN-aware wireless access point

### Added - LACP Bonding Support
- **Bond management interfaces** - Combine multiple interfaces into LACP bonds (802.3ad)
- **High availability** - Redundant management connectivity for critical infrastructure
- **New YAML syntax** - Define bonds in `managementInterfaces` configuration
- **Backup support** - Bond configurations detected and exported during backup
- Uses layer-2-and-3 transmit hash policy with 30-second LACP rate

```yaml
managementInterfaces:
  - bond:
      - ether1
      - ether2
```

### Added - Automatic Device Identity
- **FQDN-based identity** - Automatically extract and set device identity from hostname
- Example: `indoor-wap-south.nickborgers.net` sets identity to `indoor-wap-south`
- **Override support** - Identity can be explicitly set in config.yaml
- **Smart backup** - Only stores identity if it differs from expected hostname

### Added - Deployment-Level Country Configuration
- **Centralized country setting** - Specify WiFi regulatory country at deployment level
- Applies to all devices in `multiple-devices.yaml`
- Maintains backward compatibility with per-band country settings
- Backup promotes country to deployment level when consistent across devices

### Fixed - WiFi-QCOM Package Support (cAP ax)
- **Package detection** - Correctly identifies wifi-qcom vs wifiwave2 by checking installed package name
- **Fast Transition auth** - wifi-qcom uses `security.ft=yes` instead of `ft-psk` auth type
- **Virtual interface timing** - Added delay after creating virtual interfaces
- **Special character escaping** - Fixed passphrase handling for #, !, ^, %, etc.
- **Direct interface naming** - Use direct names instead of `[find name=...]` for reliability

### Fixed - Radio Band Detection
- **Board-based detection** - Uses board name to detect devices with swapped radio layout
- **Per-model handling** - Correctly identifies which physical radio is 2.4GHz vs 5GHz
- **Channel band setting** - Explicitly sets channel.band during WiFi optimization

### Fixed - Configuration Reliability
- **Old SSID persistence** - Master interfaces now disabled when no SSIDs configured for band
- **Fresh device support** - Improved configuration for newly reset devices
- **SSH connection tracking** - Fixed state tracking for newer ssh2 versions
- **802.11r Fast Transition** - Fixed authentication for seamless roaming
- **Country code format** - Uses 'United States' not 'united_states'
- **Country regex** - Captures country values containing spaces
- **WiFi interface names** - Reset to defaults for idempotency

### Improved
- **Error messages** - Better feedback for authentication and connection failures
- **Code simplification** - Streamlined WiFi configuration code

## [2.6.0] - 2025-10-18 - Channel Width Control and Enhanced Backup

### Added - Channel Width Configuration
- **Channel width control** - Configure 2.4GHz and 5GHz channel widths via YAML
- **2.4GHz optimization** - Set to 20MHz to avoid interference in multi-AP deployments
- **5GHz flexibility** - Support for 20/40/80MHz or 20/40/80/160MHz widths
- Channel width settings apply during configuration and preserved in backups
- Automatic width detection and backup from devices

### Enhanced - Roaming Settings Backup
- **Automatic roaming detection** - Backup now detects Fast Transition (802.11r) configuration
- **Complete roaming backup** - All roaming settings (802.11k/v/r) preserved during backup
- Backup intelligently detects FT-enabled WiFi interfaces
- Roaming configuration automatically added to backup YAML when detected

### New YAML Schema Extensions
```yaml
wifi:
  2.4GHz:
    channel: 1
    width: 20mhz            # NEW: Enforce 20MHz for non-overlapping channels
  5GHz:
    channel: 36
    width: 20/40/80mhz      # NEW: Wider channels for better throughput
  roaming:                  # Now backed up automatically
    enabled: yes
    neighborReport: yes
    bssTransition: yes
    fastTransition: yes
```

### Enhanced - Backup Display
- Backup summary now shows channel width settings
- Roaming status displayed in backup output
- Multi-device backup shows roaming as a feature when detected
- Clearer indication of WiFi optimization settings

### Benefits
- **Reduced 2.4GHz interference** - 20MHz channel width prevents overlap
- **Optimal 5GHz performance** - Wider channels improve throughput
- **Complete backup fidelity** - All WiFi settings now preserved
- **Easier multi-AP management** - Consistent width settings across devices

### Use Cases
- **Dense WiFi environments** - 20MHz on 2.4GHz minimizes interference
- **High-performance 5GHz** - 80MHz or 160MHz widths for maximum speed
- **Configuration migration** - Full backup/restore including all WiFi settings
- **Multi-AP consistency** - Ensure all APs use same channel width policy

### Technical Details
- Channel width applies via `channel.width` property in RouterOS v7
- Backup reads width from WiFi interface detail output
- Roaming detection checks for `.ft=yes` flag in WiFi interface configuration
- Width settings validated: `20mhz`, `20/40mhz`, `20/40/80mhz`, `20/40/80/160mhz`

## [2.5.0] - 2025-10-18 - WiFi Optimization and Multi-AP Management

### Added - WiFi Channel & Power Configuration
- **WiFi optimization settings** in YAML schema - Configure channels, TX power, and regulatory domain
- **Channel configuration** - Set specific WiFi channels (2.4GHz: 1-13, 5GHz: 36-165)
- **TX power control** - Adjust transmission power in dBm for optimal coverage
- **Country/regulatory domain** - Ensure compliance with local regulations
- Automatic channel-to-frequency mapping for both 2.4GHz and 5GHz bands
- Settings apply during configuration and are preserved in backups

### Added - Fast Roaming (802.11k/v/r)
- **802.11k** - Radio Resource Management (neighbor reports)
- **802.11v** - BSS Transition Management (client steering)
- **802.11r** - Fast BSS Transition (reduced handoff time)
- Enable seamless roaming between multiple access points
- Configurable per-device via `wifi.roaming` section

### Added - Channel Optimization Tool
- **`diag/optimize-wifi-channels.js`** - Intelligent channel planning for multi-AP deployments
- Analyzes current channel usage across all devices
- Detects channel conflicts (multiple APs on same channel)
- Suggests optimal non-overlapping channels for 3+ device deployments
  - 2.4GHz: Assigns channels 1, 6, 11 (non-overlapping)
  - 5GHz: Assigns channels 36, 52, 149 (well-separated)
- **Dry-run mode** - Preview suggestions without making changes
- **Auto-apply mode** - Automatically update YAML with optimal channels
- Preserves existing TX power and country settings when optimizing

### Enhanced - Backup Functionality
- WiFi optimization settings now exported during backup
- Channel, TX power, and country settings captured from device
- Backup summary displays WiFi optimization status
- Multi-device backups show optimization per device

### New YAML Schema
```yaml
wifi:
  2.4GHz:
    channel: 1              # Channel number (1-13)
    txPower: 15             # TX power in dBm
    country: united_states  # Regulatory domain
  5GHz:
    channel: 36             # Channel number (36-165)
    txPower: 18             # TX power in dBm
    country: united_states
  roaming:
    enabled: yes            # Enable fast roaming
    neighborReport: yes     # 802.11k
    bssTransition: yes      # 802.11v
    fastTransition: yes     # 802.11r
```

### Usage - WiFi Optimization

#### Configure Channels Manually
```bash
# Edit config.yaml to add wifi section
vim config.yaml

# Apply configuration
./apply-config.js config.yaml
```

#### Optimize Multiple APs Automatically
```bash
# Analyze current channel usage (dry-run)
node diag/optimize-wifi-channels.js multiple-devices.yaml

# Apply suggested channels
node diag/optimize-wifi-channels.js multiple-devices.yaml --apply

# Deploy optimized configuration to devices
./apply-multiple-devices.js multiple-devices.yaml
```

### Benefits
- **Reduced interference**: Non-overlapping channels minimize WiFi conflicts
- **Better performance**: Optimal channel spacing improves throughput and reliability
- **Seamless roaming**: Fast handoff between APs for mobile devices
- **Simplified multi-AP deployment**: Automatic channel planning for 3+ devices
- **Compliance**: Country settings ensure regulatory compliance
- **Fine-tuned coverage**: TX power control for optimal signal strength

### Use Cases
- **Office deployments**: Multiple APs on same floor need non-overlapping channels
- **Large homes**: Multiple floors with several APs benefit from roaming
- **Dense environments**: Minimize interference in crowded WiFi spaces
- **Enterprise**: Fast roaming for mobile devices (laptops, phones, tablets)

### Documentation
- Updated `config.example.yaml` with WiFi optimization examples
- Updated `multiple-devices.example.yaml` showing 3-AP optimized deployment
- Added `diag/README.md` documentation for channel optimization tool
- Example configurations show recommended channel assignments

### Technical Details
- RouterOS v7 WiFi property names correctly mapped (`channel.frequency`, `configuration.tx-power`, `configuration.country`)
- Channel-to-frequency conversion for both 2.4GHz (2412-2472 MHz) and 5GHz (5180-5825 MHz)
- Backup function extracts and preserves WiFi settings from device
- Apply function configures all WiFi settings before SSIDs (Step 3 of 5)

## [2.4.0] - 2025-10-18 - Backup and Multi-Device Support

### Added - Backup Functionality
- **Backup tool** (`backup-config.js`) - Export current MikroTik configuration to config.yaml format
- `backupMikroTikConfig()` function in mikrotik-no-vlan-filtering.js library
- Reads current device state including:
  - WiFi SSIDs, passphrases, VLANs, and band assignments
  - WiFi datapath configurations
  - Bridge port assignments (management interfaces)
  - Disabled interface status
- Generates valid config.yaml compatible with apply-config.js
- NPM script: `npm run backup`
- Binary: `mikrotik-backup` (when installed globally)

### Added - Multi-Device Support
- **Multi-device backup tool** (`backup-multiple-devices.js`) - Backup multiple devices to single YAML file
- **Multi-device apply tool** (`apply-multiple-devices.js`) - Configure multiple devices from single YAML file
- Support for sequential (default) and parallel (--parallel) execution modes
- Comprehensive error handling and progress reporting for multi-device operations
- `multiple-devices.yaml` - Example multi-device configuration file
- NPM scripts: `npm run backup-multiple`, `npm run apply-multiple`
- Binaries: `mikrotik-backup-multiple`, `mikrotik-apply-multiple`

### Usage

#### Single Device Backup
```bash
# Backup to default file (config-backup.yaml)
./backup-config.js 192.168.88.1 admin password

# Backup to specific file
./backup-config.js 192.168.88.1 admin password my-backup.yaml

# Or via npm
npm run backup -- 192.168.88.1 admin password config.yaml
```

#### Multi-Device Operations
```bash
# Backup all devices (updates file in-place by default)
./backup-multiple-devices.js multiple-devices.yaml

# Or save to different file
./backup-multiple-devices.js multiple-devices.yaml --output backup.yaml

# Apply configuration to all devices (sequential)
./apply-multiple-devices.js multiple-devices.yaml

# Apply configuration in parallel (faster)
./apply-multiple-devices.js multiple-devices.yaml --parallel
```

**Passphrase Handling:**
- Most WiFi passphrases are successfully extracted from devices during backup
- Some passphrases may appear as `UNKNOWN` if MikroTik doesn't expose them via SSH (depends on RouterOS version/settings)
- You **must** manually edit any `UNKNOWN` passphrases before applying the configuration
- Attempting to apply a configuration with `UNKNOWN` passphrases will fail validation with a clear error message
- This prevents accidentally setting weak or placeholder passwords on production devices

### Fixed
- **Backup parsing bug - SSIDs**: Now correctly captures SSIDs from master WiFi interfaces (was only capturing virtual interfaces)
  - Uses regex to match both full format (`configuration.ssid=`) and shorthand (`.ssid=`) used by master interfaces
  - Passphrases are now extracted correctly from most devices
- **Backup parsing bug - Disabled interfaces**: Now correctly detects disabled ethernet interfaces by parsing the "X" flag
  - Previous code looked for `disabled=yes` in output, but MikroTik shows disabled status as "X" flag
  - Disabled interfaces are properly excluded from managementInterfaces list
  - Fixed for both single-device and multi-device backups

### Benefits
- **Document existing configurations**: Export config from running devices
- **Migration**: Easy transfer of config between devices
- **Version control**: Generate config.yaml for devices configured manually
- **Audit**: Review current device state in YAML format
- **Fleet management**: Configure multiple APs with one command
- **Consistency**: Ensure all devices have identical or custom configurations
- **Efficiency**: Parallel execution for faster deployment

## [2.3.0] - Bug Fixes and Diagnostic Tools

### Added
- **Diagnostic tools folder** (`diag/`) with troubleshooting utilities
- `diag/check-status.js` - View WiFi interfaces, datapaths, and bridge configuration
- `diag/check-running.js` - Monitor runtime status and connected clients
- `diag/README.md` - Documentation for diagnostic tools
- Diagnostic scripts now included in Docker image

### Fixed
- **Bug #2**: `disabledInterfaces` not passed through in apply-config.js
- **Bug #9**: Outdated default `managementInterfaces` (now defaults to `['ether1']`)
- **Bug #7**: Improved error handling - no longer swallows real errors in cleanup
- **Bug #8**: Fixed race condition - datapaths now removed before interfaces

### Improved
- Cleaner repository root - diagnostic scripts organized in dedicated folder
- Better error visibility during configuration cleanup
- More robust cleanup sequence prevents "in use" errors

## [2.2.0] - Interface Management and Topology Improvements

### Added
- **`disabledInterfaces` configuration option** - Disable unused Ethernet interfaces for security
- Interfaces listed in `disabledInterfaces` are automatically disabled during configuration
- Flexible configuration - enable/disable any interface based on your topology

### Changed
- **Single trunk port topology** - ether1 is now the default trunk port (untagged management + tagged VLANs)
- Default `managementInterfaces` changed from `[ether1, ether2]` to `[ether1]`
- ether2 disabled by default for security (can be re-enabled via config)
- Updated network diagram to accurately show single trunk port design
- Added upstream switch to Mermaid diagram for topology clarity

### Improved
- **Security**: Unused interfaces are now disabled by default
- **Documentation**: Clarified VLAN isolation mechanism (WiFi datapaths + upstream switch)
- **Topology**: Better alignment with common deployment scenarios
- Summary output now shows disabled interfaces

### Notes
- **No breaking changes for most users**: If you use ether1 for management, no config changes needed
- **If you use ether2**: Remove it from `disabledInterfaces` and add to `managementInterfaces`
- **VLAN isolation**: Works via WiFi datapaths and upstream switch, not bridge VLAN filtering

## [2.1.3] - GitHub Container Registry Migration

### Changed
- **Breaking Change**: Docker images now published to GitHub Container Registry (ghcr.io)
- Updated all documentation to reference `ghcr.io/nickborgers/mikrotik-as-wap-configurator`
- GitHub Actions workflow now uses GITHUB_TOKEN for authentication
- Updated README badges to point to GitHub Container Registry

### Migration Guide
Update your docker commands from:
```bash
docker run nickborgers/mikrotik-as-wap-configurator
```
to:
```bash
docker run ghcr.io/nickborgers/mikrotik-as-wap-configurator
```

## [2.1.2] - CI/CD Fix

### Fixed
- Fix PAT reference in GitHub Actions pipeline

## [2.1.1] - Production Deployment

### Changed
- Production deployment verification

## [2.1.0] - Configuration Cleanup and Idempotency

### Added
- **Automatic cleanup**: Script now removes old virtual WiFi interfaces and datapaths before applying new configuration
- **Full idempotency**: Device state matches config.yaml exactly - removed SSIDs are cleaned up automatically
- **Ethernet management warning**: Clear documentation that management must be performed via Ethernet, not WiFi

### Fixed
- Old SSIDs no longer persist on device after removal from config.yaml
- Virtual WiFi interfaces are properly cleaned up on each run
- Datapaths are recreated fresh on each configuration apply

## [2.0.0] - Band-Based SSID Configuration

### Changed

**Breaking Change**: Complete redesign of SSID configuration schema to support band-based assignment.

#### Old Schema (v1.0)
```yaml
ssids:
  - name: ssid1-config
    ssid: SSID-1
    vlan: 100
    interface: wifi1
```

#### New Schema (v2.0)
```yaml
ssids:
  - ssid: SSID-1
    passphrase: password
    vlan: 100
    bands:
      - 2.4GHz
      - 5GHz
```

### Added

- **Virtual WiFi interface support**: Multiple SSIDs can now broadcast on the same frequency band
- **WiFi datapath VLAN tagging**: Proper VLAN isolation for WiFi clients
- **Per-SSID passphrases**: Each SSID can now have its own password
- **Band selection**: Choose 2.4GHz, 5GHz, or both for each SSID
- **Multi-VLAN support**: Different SSIDs can be on different VLANs with different passwords
- **Validation**: Configuration validation checks for required fields and valid band names
- **Docker support**: Official Docker image with multi-architecture support (linux/amd64, linux/arm64)
- **Automated publishing**: GitHub Actions workflow for Docker Hub releases
- **Comprehensive documentation**: DOCKER.md, GETTING-STARTED.md, QUICK-REFERENCE.md
- **MIT License**: Open source license added

### Benefits

1. **Intuitive Configuration**: Think in terms of SSIDs and bands, not interfaces
2. **Easier Management**: Same SSID on both bands for seamless roaming
3. **More Flexible**: Different SSIDs can have different passwords and VLANs
4. **Clearer Intent**: Configuration explicitly shows which bands an SSID uses

### Example Use Cases

**Single SSID on both bands (most common):**
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: mypassword
    vlan: 100
    bands: [2.4GHz, 5GHz]
```

**Separate SSIDs for different purposes:**
```yaml
ssids:
  - ssid: Corporate
    passphrase: corp-password
    vlan: 100
    bands: [2.4GHz, 5GHz]

  - ssid: Guest
    passphrase: guest-password
    vlan: 200
    bands: [2.4GHz, 5GHz]

  - ssid: IoT-Devices
    passphrase: iot-password
    vlan: 300
    bands: [2.4GHz]  # Many IoT devices only support 2.4GHz
```

### Migration Guide

To migrate from v1.0 to v2.0 configuration:

1. Remove the `name` field (no longer needed)
2. Remove the `interface` field
3. Add `bands` array with desired bands
4. Move password from global `security.passphrase` to per-SSID `passphrase`

**Before:**
```yaml
security:
  passphrase: password

ssids:
  - name: ssid1-config
    ssid: MyNetwork
    vlan: 100
    interface: wifi1
```

**After:**
```yaml
ssids:
  - ssid: MyNetwork
    passphrase: password
    vlan: 100
    bands: [2.4GHz]
```

## [1.0.0] - Initial Release

- Basic YAML configuration for MikroTik devices
- Interface-based SSID assignment
- Safe configuration without VLAN filtering
- Prevention of device lockouts
