/**
 * WiFi configuration helpers
 * Radio detection, band settings, and WiFi interface configuration
 */

const { CHANNEL_FREQ_24GHZ, CHANNEL_FREQ_5GHZ } = require('./constants');
const { escapeMikroTik, getWifiPath, getCapsmanPath } = require('./utils');
const { q, must, integer, ifaceName } = require('./routeros-args');

/**
 * Detect board type and return correct interface mapping for WiFi radios
 * Some MikroTik devices have swapped radio layouts
 * @param {MikroTikSSH} mt - Connected SSH session
 * @returns {Object} - { interface24: string, interface5: string }
 */
async function detectRadioLayout(mt) {
  let interface24 = 'wifi1';
  let interface5 = 'wifi2';

  try {
    const resource = await mt.exec('/system resource print');
    const boardMatch = resource.match(/board-name:\s*([^\n]+)/);
    const boardName = boardMatch ? boardMatch[1].trim().toLowerCase() : '';
    const swappedRadioDevices = ['cap ax', 'cap ac'];

    if (swappedRadioDevices.some(d => boardName.includes(d))) {
      interface24 = 'wifi2';
      interface5 = 'wifi1';
      console.log(`ℹ️  ${boardMatch[1].trim()}: Swapped radio layout`);
    }
  } catch (e) {
    console.log('⚠️  Could not detect board, assuming standard layout');
  }

  return { interface24, interface5 };
}

// Best-to-worst band token per band. A radio that predates 802.11ax has no
// -ax token, and setting one fails outright, which is why this is detected
// rather than assumed.
const BAND_PREFERENCE = {
  '2.4GHz': ['2ghz-ax', '2ghz-n', '2ghz-g', '2ghz-b'],
  '5GHz': ['5ghz-ax', '5ghz-ac', '5ghz-n', '5ghz-a']
};

/**
 * Work out which band token a radio actually supports.
 *
 * Reads the radio's advertised bands and picks the best one it lists. Falls
 * back to the -ax token when detection fails, which is what the code did
 * before this existed, so ax hardware behaves exactly as it always has.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {string} interfaceName - Interface the radio is attached to
 * @param {string} band - '2.4GHz' or '5GHz'
 * @returns {Promise<string>} - A band token such as '5ghz-ac'
 */
async function detectBandToken(mt, wifiPath, interfaceName, band) {
  const preference = BAND_PREFERENCE[band];
  const fallback = band === '2.4GHz' ? '2ghz-ax' : '5ghz-ax';
  if (!preference) return fallback;

  try {
    const out = await mt.exec(`${wifiPath}/radio print detail without-paging`);
    // Records start at the left margin with their index; continuation lines are
    // indented far more. A looser split breaks on wrapped numeric lists such as
    // 2g-channels, whose last line can look exactly like a new record.
    const record = out
      .split(/\r?\n(?=\s{0,3}\d+\s)/)
      .find(r => new RegExp(`interface=${interfaceName}(\\s|$)`).test(r));

    if (!record) {
      console.log(`⚠️  No radio found for ${interfaceName}, assuming ${fallback}`);
      return fallback;
    }

    // Band tokens only ever appear in the bands= field, and that field wraps
    // across lines, so scan the whole record instead of parsing the field.
    const supported = new Set([...record.matchAll(/\b(?:2ghz|5ghz)-[a-z]+/g)].map(m => m[0]));
    const best = preference.find(token => supported.has(token));

    if (best) {
      console.log(`  ✓ ${interfaceName} (${band}) supports ${[...supported].join(', ')} - using ${best}`);
      return best;
    }
    console.log(`⚠️  ${interfaceName} lists no known ${band} band, assuming ${fallback}`);
  } catch (e) {
    console.log(`⚠️  Could not read radio bands: ${e.message}, assuming ${fallback}`);
  }

  return fallback;
}

/**
 * Apply WiFi channel settings for a specific band
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} band - '2.4GHz' or '5GHz'
 * @param {string} interfaceName - WiFi interface name
 * @param {Object} bandConfig - Band configuration (channel, txPower, width, country)
 * @param {string} wifiPath - WiFi command path
 */
async function applyBandSettings(mt, band, interfaceName, bandConfig, wifiPath) {
  if (!bandConfig) return;

  const commands = [];
  const channelFreqMap = band === '2.4GHz' ? CHANNEL_FREQ_24GHZ : CHANNEL_FREQ_5GHZ;

  if (bandConfig.channel) {
    const freq = channelFreqMap[bandConfig.channel];
    if (freq) commands.push(`channel.frequency=${integer(freq, `${band} frequency`)}`);
  }
  if (bandConfig.txPower) {
    commands.push(`channel.tx-power=${integer(bandConfig.txPower, `${band} txPower`)}`);
  }
  if (bandConfig.width) {
    commands.push(`channel.width=${must(bandConfig.width, /^[0-9a-zA-Z/+-]{1,32}$/, `${band} width`)}`);
  }
  if (bandConfig.country) commands.push(`channel.country=${q(bandConfig.country)}`);

  if (commands.length > 0) {
    try {
      await mt.exec(`${wifiPath} set ${ifaceName(interfaceName)} ${commands.join(' ')}`);
      console.log(`✓ Applied ${band} settings: ${commands.join(', ')}`);
    } catch (e) {
      console.log(`⚠️  ${band} settings: ${e.message}`);
    }
  }
}

/**
 * Configure a single WiFi interface with SSID, security, and datapath
 * Used for both standalone and CAPsMAN CAP interface configuration
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {string} interfaceName - Interface name to configure
 * @param {Object} ssidConfig - SSID configuration {ssid, passphrase, vlan, roaming}
 * @param {string} country - Country code for WiFi
 * @param {Object} bandSettings - Optional band-specific settings {txPower, channel, width}
 */
async function configureWifiInterface(mt, wifiPath, interfaceName, ssidConfig, country, bandSettings = {}, upOptions = {}) {
  const { ssid, passphrase, vlan, roaming } = ssidConfig;

  const useFT = roaming?.fastTransition === true;
  const useRRM = roaming?.rrm === true;
  const useWNM = roaming?.wnm === true;
  const transitionThreshold = roaming?.transitionThreshold || -80;
  const escapedSsid = escapeMikroTik(ssid);
  const escapedPassphrase = escapeMikroTik(passphrase);

  // Create or update steering profile if RRM or WNM is enabled
  // wifi-qcom requires steering profiles as separate objects, not inline properties
  let steeringParam = '';
  if (useRRM || useWNM) {
    const steeringName = `steering-${interfaceName}`;
    try {
      // Remove existing steering profile if it exists
      await mt.exec(`${wifiPath}/steering remove [find name="${steeringName}"]`);
    } catch (e) {
      // Ignore if doesn't exist
    }
    // Create new steering profile
    // Note: transition-threshold cannot be set during 'add', must use 'set' after creation
    // Note: Unsolicited 802.11v BSS transition management requires RouterOS 7.21beta2+
    // On earlier versions, the transition-threshold is accepted but may not be functional
    const steeringCmd = `${wifiPath}/steering add name="${steeringName}" ` +
      `rrm=${useRRM ? 'yes' : 'no'} wnm=${useWNM ? 'yes' : 'no'}`;
    try {
      await mt.exec(steeringCmd);
      // Set transition-threshold separately (MikroTik quirk: can't be in add command)
      if (useWNM) {
        try {
          await mt.exec(`${wifiPath}/steering set [find name="${steeringName}"] transition-threshold=${transitionThreshold}`);
        } catch (e) {
          // May fail on older RouterOS versions - this is expected
        }
      }
      steeringParam = ` steering="${steeringName}"`;
    } catch (e) {
      console.log(`  ⚠️  Could not create steering profile: ${e.message}`);
    }
  }

  // Build configuration command
  // Uses security.ft=yes for Fast Transition (wifi-qcom)
  // A router owns an untagged LAN, so it configures SSIDs with no vlan. The AP
  // roles always tag, for an upstream switch to sort out.
  // RouterOS `set` leaves unspecified properties alone, so an SSID moving from
  // tagged to untagged would silently keep its old VLAN. Clear it explicitly.
  const vlanClause = vlan === undefined || vlan === null
    ? ' !datapath.vlan-id'
    : ` datapath.vlan-id=${integer(vlan, 'vlan')}`;

  let cmd = `${wifiPath} set ${interfaceName} ` +
    `configuration.ssid="${escapedSsid}" ` +
    `configuration.country=${q(country)} ` +
    `security.authentication-types=wpa2-psk ` +
    `security.passphrase="${escapedPassphrase}" ` +
    `datapath.bridge=bridge${vlanClause}`;

  if (useFT) {
    cmd += ` security.ft=yes security.ft-over-ds=yes`;
  } else {
    // Explicitly disable FT when not configured to clear any previous settings
    cmd += ` security.ft=no security.ft-over-ds=no`;
  }

  // Add steering profile reference if created
  cmd += steeringParam;

  // Add txPower from band settings if specified
  if (bandSettings.txPower !== undefined) {
    cmd += ` configuration.tx-power=${integer(bandSettings.txPower, 'txPower')}`;
  }

  cmd += ` disabled=no`;

  try {
    await mt.exec(cmd);
  } catch (e) {
    // `!datapath.vlan-id` is the RouterOS unset form, needed so an SSID moving
    // from tagged to untagged actually loses its VLAN. It has not been
    // exercised on every RouterOS build this tool supports, and this function
    // configures every SSID for every role - so if the device rejects it,
    // fall back to the previous behaviour rather than failing the whole apply.
    if (vlanClause === ' !datapath.vlan-id' && /syntax|expected|unknown|invalid/i.test(e.message)) {
      console.log(`  ⚠️  This RouterOS build rejected the VLAN unset form: ${e.message.trim()}`);
      console.log('     Retrying without it. An SSID changing from tagged to untagged may keep its old VLAN.');
      try {
        await mt.exec(cmd.replace(' !datapath.vlan-id', ''));
      } catch (retryErr) {
        console.log(`  ✗ Failed to configure ${interfaceName}: ${retryErr.message}`);
        throw retryErr;
      }

      // The fallback cannot clear an existing VLAN, so verify rather than
      // assume. Silently leaving an SSID tagged when the config says untagged
      // is exactly the bug the unset form was added to fix.
      try {
        const check = await mt.exec(`${wifiPath} print detail without-paging where name="${interfaceName}"`);
        const stuck = check.match(/(?:datapath)?\.vlan-id=(\d+)/);
        if (stuck) {
          console.log(`  ✗ ${interfaceName} is still tagged with VLAN ${stuck[1]} but the config says untagged.`);
          console.log('     This RouterOS build rejected the unset form. Clear it by hand:');
          console.log(`     ${wifiPath} set ${interfaceName} !datapath.vlan-id`);
        }
      } catch (verifyErr) {
        console.log(`  ⚠️  Could not confirm the VLAN was cleared on ${interfaceName}: ${verifyErr.message}`);
      }
    } else {
      console.log(`  ✗ Failed to configure ${interfaceName}: ${e.message}`);
      throw e;
    }
  }

  try {
    const roamingStatus = [
      useFT ? '802.11r' : '',
      useRRM ? '802.11k' : '',
      useWNM ? `802.11v(${transitionThreshold}dBm)` : ''
    ].filter(Boolean).join(', ');
    const txPowerStatus = bandSettings.txPower !== undefined ? `, TX=${bandSettings.txPower}dBm` : '';
    const vlanStatus = vlan === undefined || vlan === null ? 'untagged' : `VLAN=${vlan}`;
    console.log(`  ✓ Configured ${interfaceName}: SSID="${ssid}", ${vlanStatus}${roamingStatus ? `, ${roamingStatus}` : ''}${txPowerStatus}`);
  } catch (e) {
    // Logging only - the interface is already configured at this point.
    console.log(`  ✓ Configured ${interfaceName}: SSID="${ssid}"`);
  }

  // Writing the config is not proof the radio accepted it. See the helper.
  return ensureWifiInterfaceUp(mt, wifiPath, interfaceName, upOptions);
}

/**
 * Ask the device whether an interface is running.
 *
 * MUST be wrapped in `:put`. A bare `/interface get ... running` prints NOTHING
 * over an SSH exec - RouterOS returns the value to an interactive console, not
 * to stdout. Without the wrapper every read comes back as an empty string, so
 * every interface looks not-running and every lookup looks empty.
 *
 * That is not hypothetical: v6.2.2 shipped the bare form. On a live Chateau it
 * reported a perfectly healthy master as "not running after 90s" and classified
 * a virtual AP as a master, so the retry this whole feature exists for never
 * fired. Unit tests missed it because the fake returned canned values and never
 * checked that the command was one RouterOS actually answers.
 *
 * @param {string} name - Interface name
 * @returns {string} - Command whose stdout is "true" or "false"
 */
function runningQuery(name) {
  return `:put [/interface/get [find name=${q(name)}] running]`;
}

/**
 * Poll `running` on a set of interfaces against ONE shared deadline.
 *
 * Both callers need the same awkward properties, and having two copies of them
 * is how they drift apart:
 *
 *   - ONE deadline for all the names, not one each. A controller with 20 dead
 *     CAP radios would otherwise stall the apply for the timeout times twenty,
 *     and the device runs those channel checks concurrently anyway.
 *   - Time is measured against the CLOCK, not against the time we asked to
 *     sleep for. A slow or timing-out SSH read burns real time too, and
 *     counting only sleeps ran well past the budget exactly when reads were
 *     slowest - the failure mode the budget exists to bound.
 *   - KNOWN BOUND, accepted deliberately: `timeoutMs` caps when a NEW round may
 *     start, not how long a round already in flight may take. exec() has its own
 *     30s timeout, so a round over N unresponsive interfaces can overrun by up to
 *     N x 30s. Cutting a round short instead would judge the interfaces later in
 *     the map on a stale result and report healthy DFS radios as dead - a wrong
 *     answer, where this is only a slow one. It only happens once the device has
 *     already stopped answering.
 *   - A round is an ATOMIC SNAPSHOT. Once a round starts, every unresolved name
 *     is read in it. Breaking out mid-round on the deadline would judge the
 *     names later in the map on their previous round's result, so several
 *     radios finishing near the deadline would see the first pass and the rest
 *     falsely reported dead. The deadline is checked BETWEEN rounds; the
 *     overrun is bounded by one round of reads.
 *   - A read failure is NOT fatal. A transient error mid-recovery must not
 *     condemn an interface that is about to come up; it is only reported if it
 *     never resolves.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {Iterable<string>} names - Interfaces to watch
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=90000] - Shared budget
 * @param {number} [options.pollMs=5000] - Gap between rounds
 * @param {Function} [options.sleep] - Injectable delay, for tests
 * @param {Function} [options.now] - Injectable clock, for tests
 * @param {Function} [options.onUp] - Called with (name, elapsedMs) as each comes up
 * @returns {Promise<{pending: Map<string, Error|null>, elapsedMs: number}>}
 *          `pending` holds the names still not running, mapped to the last read
 *          error when the reads themselves were failing.
 */
async function pollUntilRunning(mt, names, options = {}) {
  const {
    timeoutMs = 90000,
    pollMs = 5000,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now(),
    onUp = () => {}
  } = options;

  // A Map also de-duplicates the names.
  const pending = new Map([...names].map(name => [name, null]));
  if (pending.size === 0) return { pending, elapsedMs: 0 };

  const started = now();
  const elapsed = () => now() - started;

  // Belt and braces: even a caller that passes a frozen clock and a no-op
  // sleep cannot spin here for ever.
  const maxRounds = Math.ceil(Math.max(timeoutMs, 0) / Math.max(pollMs, 1)) + 1;

  for (let round = 1; ; round++) {
    for (const name of [...pending.keys()]) {
      try {
        const out = await mt.exec(runningQuery(name));
        if (/true/i.test(out || '')) {
          onUp(name, elapsed());
          pending.delete(name);
        } else {
          pending.set(name, null);
        }
      } catch (e) {
        pending.set(name, e);
      }
    }

    if (pending.size === 0) break;
    if (elapsed() >= timeoutMs || round >= maxRounds) break;

    // Never overshoot the shared budget.
    const step = Math.min(pollMs, timeoutMs - elapsed());
    if (step <= 0) break;
    await sleep(step);
  }

  return { pending, elapsedMs: elapsed() };
}

/**
 * Look again at master radios that were still starting up.
 *
 * A master is never bounced, so the only safe way to tell a DFS availability
 * check from a genuinely dead radio is to wait and look again. Returning
 * "healthy" for every not-running master would reintroduce the very bug this
 * change exists to fix, just on the primary SSID instead of a virtual one.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string[]} names - Interfaces deferred earlier
 * @param {Object} [options]
 * @param {number} [options.timeoutMs=90000] - Shared budget for all the radios
 * @param {number} [options.pollMs=5000] - Gap between rounds
 * @param {Function} [options.sleep] - Injectable delay, for tests
 * @returns {Promise<string[]>} - Problems for interfaces still not running
 */
async function recheckPendingMasters(mt, names, options = {}) {
  const problems = [];
  if (!names || names.length === 0) return problems;

  const {
    // A DFS channel availability check can take ~60s, and applying channel
    // settings can restart it - CAPsMAN does exactly that immediately before
    // this runs. A short fixed wait would report every healthy DFS radio as
    // dead, so poll until they come up instead.
    timeoutMs = 90000,
    pollMs = 5000,
    sleep,
    now
  } = options;

  console.log('\n=== Re-checking radios that were still starting ===');
  console.log(`  Waiting up to ${Math.round(timeoutMs / 1000)}s in total for ${new Set(names).size} radio(s).`);
  console.log('  A DFS availability check takes about 60s, and setting a channel can restart it.');

  const { pending, elapsedMs } = await pollUntilRunning(mt, names, {
    timeoutMs,
    pollMs,
    ...(sleep ? { sleep } : {}),
    ...(now ? { now } : {}),
    onUp: (name, ms) => {
      const secs = Math.round(ms / 1000);
      console.log(`  \u2713 ${name} is now running${secs ? ` (after ${secs}s)` : ''}`);
    }
  });

  const waitedSecs = Math.round(elapsedMs / 1000);
  for (const [name, readError] of pending) {
    const problem = readError
      ? `${name} could not be re-checked: ${readError.message}`
      : `${name} is configured but still not running after ${waitedSecs}s - ` +
        'its SSID is not on the air';
    console.log(`  \u2717 ${problem}`);
    problems.push(problem);
  }

  return problems;
}

/**
 * Confirm an SSID actually made it onto the air, retrying if it did not.
 *
 * Writing the configuration is not the same as the radio accepting it. A
 * virtual AP created while its master is being reconfigured in the same pass
 * can be rejected by the radio, and RouterOS records that only as a comment on
 * the interface:
 *
 *   ;;; failed to create interface
 *   2  BI wifi2-ssid2  wifi2  PartlyWork
 *
 * The `set` that configured it returns no error, so an apply that only writes
 * config reports success while the SSID is silently dead. Observed on a
 * Chateau LTE6 (RouterOS 7.18.2, wifi-qcom): the second SSID was absent for a
 * day behind a fully green apply.
 *
 * The failure appears to be a race rather than a hard rejection - disabling and
 * re-enabling just that interface brings it up, without touching the master or
 * disturbing associated clients. So: read back, and retry the interface alone.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - Base wifi path for this package
 * @param {string} interfaceName - Interface to check
 * WHY THE WAIT IS A POLL AND NOT A FIXED DELAY (fixed in 6.2.4). 6.2.3 waited a
 * flat 3s after the toggle and gave up after two of them - about 6s of settle.
 * On the live Chateau that produced a FALSE NEGATIVE: the apply exhausted the
 * budget, reported "wifi2-ssid2 is configured but not running" and exited
 * INCOMPLETE, and the interface came up on its own moments later. A later apply
 * on the same device recovered inside the budget and passed. So it was marginal,
 * and it failed in the direction that breaks any automation gating on the exit
 * code. Recovery after a FRESH create is slower than recovery from a disabled
 * state, which was measured at 3.9s.
 *
 * Polling costs nothing when the interface is healthy - it returns on the first
 * read - so the budget only spends time on a genuine failure. That makes a
 * generous budget nearly free, which is why it is 60s rather than something
 * tuned tightly to the observed 6s.
 *
 * The honest failure is kept: when the budget genuinely expires the problem is
 * still reported, and that was the good part of 6.2.3.
 *
 * @param {Object} [options]
 * @param {number} [options.attempts=3] - Total attempts, including the first check
 * @param {number} [options.timeoutMs=60000] - Settle budget shared across the retries
 * @param {number} [options.pollMs=3000] - Gap between `running` reads while settling
 * @param {Function} [options.sleep] - Injectable delay, for tests
 * @param {Function} [options.now] - Injectable clock, for tests
 * @returns {Promise<string|null>} - A problem description, or null when up
 */
async function ensureWifiInterfaceUp(mt, wifiPath, interfaceName, options = {}) {
  const {
    attempts = 3,
    // Shared across every retry, so raising `attempts` cannot multiply the
    // worst-case wait. 60s is an order of magnitude above every recovery
    // actually observed on hardware, and still well under the 90s budget the
    // master re-check uses for a DFS availability check.
    timeoutMs = 60000,
    pollMs = 3000,
    pendingMasters = null,
    sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
    now = () => Date.now()
  } = options;

  // `running` is the authoritative signal and is unambiguous, unlike parsing
  // the flag column out of `print detail`.
  const isUp = async () => {
    const out = await mt.exec(runningQuery(interfaceName));
    return /true/i.test(out || '');
  };

  // Only a VIRTUAL AP may be bounced. This function is called for the primary
  // SSID on each band too, and that is the MASTER radio - which carries every
  // associated client, very possibly including the operator running this tool
  // over that same radio. A master can also be legitimately not-running for a
  // while: DFS channel availability check, a CAP still provisioning, CAPsMAN
  // not finished activating it. Bouncing it would turn a benign wait into an
  // outage, and reporting it as a failure would be a false alarm.
  let isVirtual = false;
  let classified = false;
  let classifyError = null;
  try {
    const master = await mt.exec(
      `:put [${wifiPath}/get [find name=${q(interfaceName)}] master-interface]`
    );
    // Structural, not merely non-empty. exec() now rejects a RouterOS failure,
    // so error text can no longer arrive here wearing a success exit - but the
    // consequence of getting this wrong is bouncing a MASTER radio and cutting
    // every client, including possibly the operator's own link. So require the
    // answer to actually look like an interface name before believing it.
    const value = (master || '').trim();
    if (value === '') {
      isVirtual = false;          // no master-interface => this IS a master
      classified = true;
    } else if (/^[A-Za-z0-9_.:-]{1,64}$/.test(value)) {
      isVirtual = true;
      classified = true;
    } else {
      // Something we do not recognise. Do not toggle on a guess.
      classifyError = new Error(`unrecognised master-interface value ${JSON.stringify(value)}`);
    }
  } catch (e) {
    // Cannot tell what this is. Never toggle it - but do not call it healthy
    // either, or a dead VAP could hide behind a failed lookup.
    isVirtual = false;
    classifyError = e;
  }

  // Attempt 1 is a plain read, not a poll: a healthy interface must not cost a
  // poll cycle, and the overwhelmingly common case is that it is already up.
  let lastError = null;
  try {
    if (await isUp()) return null;
  } catch (e) {
    // Cannot read state; there is nothing useful to retry against.
    const problem = `${interfaceName} could not be read back after configuration: ${e.message}`;
    console.log(`  \u2717 ${problem}`);
    return problem;
  }

  if (!isVirtual) {
    // Never touch a master. But "not running" is not proof of health either: a
    // bad channel, a radio rejection or a driver fault reads exactly like a DFS
    // availability check. So defer it and look again once the rest of the apply
    // has given it time to settle.
    if (!classified) {
      const problem = `${interfaceName} could not be identified as master or virtual` +
        `${classifyError ? `: ${classifyError.message}` : ''} - left untouched, and it is not running`;
      console.log(`  \u2717 ${problem}`);
      return problem;
    }
    console.log(`  \u26a0\ufe0f  ${interfaceName} is not running yet - it is a master radio, so it is left alone.`);
    console.log('     A DFS availability check or a CAP still provisioning looks like this.');
    if (pendingMasters) {
      if (!pendingMasters.includes(interfaceName)) pendingMasters.push(interfaceName);
      console.log('     Will re-check before the run finishes.');
      return null;
    }
    const problem = `${interfaceName} is configured but not running - its SSID is not on the air`;
    console.log(`  \u2717 ${problem}`);
    return problem;
  }

  // A virtual AP, and it is down. Toggle it, then WAIT AND WATCH rather than
  // waiting a fixed moment and asking once.
  const retries = Math.max(attempts - 1, 0);
  const perRetryMs = Math.ceil(Math.max(timeoutMs, 0) / Math.max(retries, 1));
  const started = now();

  for (let retry = 1; retry <= retries; retry++) {
    console.log(`  \u26a0\ufe0f  ${interfaceName} is not running, retrying (${retry}/${retries})`);
    try {
      // This interface only. Never the master.
      await mt.exec(`${wifiPath} set [find name=${q(interfaceName)}] disabled=yes`);
      await sleep(500);
      await mt.exec(`${wifiPath} set [find name=${q(interfaceName)}] disabled=no`);
    } catch (e) {
      const problem = `${interfaceName} could not be restarted: ${e.message}`;
      console.log(`  \u2717 ${problem}`);
      return problem;
    }

    // Split evenly so a later retry still gets a turn, and clamped by what is
    // left of the shared budget so the total cannot run away.
    const remaining = Math.max(timeoutMs - (now() - started), 0);
    const { pending } = await pollUntilRunning(mt, [interfaceName], {
      timeoutMs: Math.min(perRetryMs, remaining),
      pollMs,
      sleep,
      now,
      onUp: (name, ms) => {
        const secs = Math.round(ms / 1000);
        console.log(`  \u2713 ${name} came up on attempt ${retry + 1}${secs ? ` (after ${secs}s)` : ''}`);
      }
    });
    if (pending.size === 0) return null;
    lastError = pending.get(interfaceName) || lastError;
  }

  // Surface the device's own explanation when it left one.
  let reason = '';
  try {
    const detail = await mt.exec(`${wifiPath} print detail without-paging where name=${q(interfaceName)}`);
    const comment = (detail || '').match(/;;; *(.+)/);
    if (comment) reason = ` (device says: ${comment[1].trim()})`;
  } catch (e) { /* the problem below stands on its own */ }

  const problem = `${interfaceName} is configured but not running${reason}` +
    (lastError ? ` - last error: ${lastError.message}` : '');
  // Logged here as well as returned, because not every caller consumes the
  // return value. An SSID nobody can see must never be silent.
  console.log(`  ✗ ${problem}`);
  return problem;
}

/**
 * Get list of CAP identities with swapped radios from remote-cap information
 * Queries CAPsMAN to find connected CAPs and checks their board type
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPackage - WiFi package type (wifi-qcom or wifiwave2)
 * @returns {Set<string>} - Set of CAP identities that have swapped radios
 */
async function getSwappedRadioCaps(mt, wifiPackage) {
  const swappedCaps = new Set();

  // Known devices with swapped radios (wifi1=5GHz, wifi2=2.4GHz)
  // Includes both user-friendly names and internal product codes
  const swappedRadioPatterns = [
    // cAP ax variants
    'cap ax',           // User-friendly name (from /system resource)
    'capgi-5haxd2haxd', // Product code (from remote-cap)
    // cAP ac variants
    'cap ac',           // User-friendly name
    'capgi-5acd2nd',    // Product code (estimated)
  ];

  try {
    const capsmanPath = getCapsmanPath(wifiPackage);
    const remoteCaps = await mt.exec(`${capsmanPath}/remote-cap print detail without-paging`);

    // Parse each CAP entry
    // Format: identity="cap-name" ... board-name="cAPGi-5HaxD2HaxD"
    const capEntries = remoteCaps.split(/\n(?=\s*\d+\s+)/);

    for (const entry of capEntries) {
      const identityMatch = entry.match(/identity="?([^"\s]+)"?/);
      // Match both board= and board-name= formats
      const boardMatch = entry.match(/board(?:-name)?="([^"]+)"/);

      if (identityMatch && boardMatch) {
        const identity = identityMatch[1];
        const board = boardMatch[1].toLowerCase();

        if (swappedRadioPatterns.some(pattern => board.includes(pattern))) {
          swappedCaps.add(identity);
          console.log(`ℹ️  CAP "${identity}" (${boardMatch[1]}): Has swapped radios (wifi1=5GHz, wifi2=2.4GHz)`);
        }
      }
    }
  } catch (e) {
    console.log(`⚠️  Could not query remote CAPs: ${e.message}`);
  }

  return swappedCaps;
}

/**
 * Build a mapping of interface name to actual radio band from radio hardware info
 * The radio 'bands' property definitively shows 2ghz-* or 5ghz-* supported bands
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @returns {Map<string, string>} - Map of interface name to band ('2.4GHz' or '5GHz')
 */
async function getRadioBandMapping(mt, wifiPath) {
  const bandMap = new Map();

  try {
    // Query all radio info - this shows actual hardware capabilities
    const radioOutput = await mt.exec(`${wifiPath}/radio print detail without-paging`);

    // Split into entry blocks (each starts with a number)
    // Format: " 2   cap="name" radio-mac=...\n     bands=5ghz-...\n     interface=name ..."
    const entries = radioOutput.split(/\n(?=\s*\d+\s+)/);

    for (const entry of entries) {
      if (!entry.trim()) continue;

      // Look for interface= and bands= within the entry block
      const interfaceMatch = entry.match(/interface=([^\s]+)/);
      const bandsMatch = entry.match(/bands=([^\s]+)/);

      if (interfaceMatch && bandsMatch) {
        const ifaceName = interfaceMatch[1];
        const bands = bandsMatch[1].toLowerCase();

        if (bands.includes('2ghz')) {
          bandMap.set(ifaceName, '2.4GHz');
        } else if (bands.includes('5ghz')) {
          bandMap.set(ifaceName, '5GHz');
        }
      }
    }
  } catch (e) {
    // Radio query failed, caller will use fallback methods
  }

  return bandMap;
}

/**
 * Rename misnamed CAP interfaces to match their actual radio band
 * For devices with swapped radios, the -2g/-5g suffix doesn't match the actual band.
 * This function renames interfaces so the suffix correctly reflects the radio band.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {Array<{name: string, band: string}>} interfaces - Interfaces with detected bands
 * @returns {Array<{name: string, band: string}>} - Interfaces with corrected names
 */
async function renameCapInterfacesToMatchBand(mt, wifiPath, interfaces) {
  const correctedInterfaces = [];

  // Group interfaces by CAP identity to handle swaps together
  const byIdentity = new Map();
  for (const iface of interfaces) {
    const identity = iface.name.replace(/-2g$/, '').replace(/-5g$/, '');
    if (!byIdentity.has(identity)) {
      byIdentity.set(identity, []);
    }
    byIdentity.get(identity).push(iface);
  }

  for (const [identity, capInterfaces] of byIdentity) {
    // Check if any interface needs renaming
    const needsRenaming = capInterfaces.filter(iface => {
      const currentSuffix = iface.name.endsWith('-2g') ? '2g' : '5g';
      const correctSuffix = iface.band === '2.4GHz' ? '2g' : '5g';
      return currentSuffix !== correctSuffix;
    });

    if (needsRenaming.length === 0) {
      // No renaming needed, keep as-is
      correctedInterfaces.push(...capInterfaces);
      continue;
    }

    // For swapped devices, we need to swap both interface names
    // Use temp names to avoid conflicts
    console.log(`\n=== Renaming interfaces for ${identity} ===`);

    // Find the -2g and -5g interfaces
    const if2g = capInterfaces.find(i => i.name.endsWith('-2g'));
    const if5g = capInterfaces.find(i => i.name.endsWith('-5g'));

    if (if2g && if5g && needsRenaming.length === 2) {
      // Both need swapping - use temp name approach
      const name2g = `${identity}-2g`;
      const name5g = `${identity}-5g`;
      const tempName = `${identity}-swap-temp`;

      try {
        // Step 1: Rename -2g to temp
        await mt.exec(`${wifiPath} set [find name="${name2g}"] name="${tempName}"`);
        console.log(`  ✓ ${name2g} → ${tempName} (temp)`);

        // Step 2: Rename -5g to -2g
        await mt.exec(`${wifiPath} set [find name="${name5g}"] name="${name2g}"`);
        console.log(`  ✓ ${name5g} → ${name2g}`);

        // Step 3: Rename temp to -5g
        await mt.exec(`${wifiPath} set [find name="${tempName}"] name="${name5g}"`);
        console.log(`  ✓ ${tempName} → ${name5g}`);

        // Step 4: Fix virtual interface names
        // When master interfaces are renamed, MikroTik updates the virtual's master-interface
        // property to follow the renamed master. But the virtual interface NAME is not updated.
        // So a virtual like "cap-2g-ssid2" with master="cap-2g" now has master="cap-5g" after swap.
        // We need to rename the virtual to match its (renamed) master.
        await renameVirtualInterfacesForSwappedMasters(mt, wifiPath, identity);

        // Update the interface objects with new names (swapped)
        correctedInterfaces.push({ name: name2g, band: if5g.band }); // Was -5g, now -2g
        correctedInterfaces.push({ name: name5g, band: if2g.band }); // Was -2g, now -5g
      } catch (e) {
        console.log(`  ⚠️  Rename failed: ${e.message}`);
        // Keep original names on failure
        correctedInterfaces.push(...capInterfaces);
      }
    } else {
      // Single interface or partial rename (shouldn't happen normally)
      for (const iface of capInterfaces) {
        const currentSuffix = iface.name.endsWith('-2g') ? '2g' : '5g';
        const correctSuffix = iface.band === '2.4GHz' ? '2g' : '5g';

        if (currentSuffix !== correctSuffix) {
          const newName = `${identity}-${correctSuffix}`;
          try {
            await mt.exec(`${wifiPath} set [find name="${iface.name}"] name="${newName}"`);
            console.log(`  ✓ ${iface.name} → ${newName}`);
            correctedInterfaces.push({ name: newName, band: iface.band });
          } catch (e) {
            console.log(`  ⚠️  Rename ${iface.name} failed: ${e.message}`);
            correctedInterfaces.push(iface);
          }
        } else {
          correctedInterfaces.push(iface);
        }
      }
    }
  }

  return correctedInterfaces;
}

/**
 * Rename virtual interfaces after their master interfaces have been swapped
 * When master interfaces are renamed, MikroTik updates the virtual's master-interface
 * property to follow the renamed master. But the virtual interface NAME is not updated.
 * This function fixes virtual interface names to match their (renamed) masters.
 *
 * Example: After swapping masters, a virtual named "cap-2g-ssid2" has master-interface="cap-5g"
 * This function renames it to "cap-5g-ssid2" to match.
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path
 * @param {string} identity - CAP identity (e.g., "managed-wap-north")
 */
async function renameVirtualInterfacesForSwappedMasters(mt, wifiPath, identity) {
  try {
    // Find all virtual interfaces for this CAP identity
    // Virtual interfaces have names like "identity-2g-ssid2" or "identity-5g-ssid3"
    const output = await mt.exec(`${wifiPath} print terse without-paging`);

    const virtualInterfaces = [];
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      const nameMatch = line.match(/name="?([^"\s]+)"?/);
      const masterMatch = line.match(/master-interface="?([^"\s]+)"?/);

      if (!nameMatch || !masterMatch) continue;

      const name = nameMatch[1];
      const master = masterMatch[1];

      // Check if this is a virtual interface for our CAP identity
      // Virtual names: identity-2g-ssidN or identity-5g-ssidN
      const virtualPattern = new RegExp(`^${identity}-(2g|5g)-ssid\\d+$`);
      if (virtualPattern.test(name)) {
        virtualInterfaces.push({ name, master });
      }
    }

    if (virtualInterfaces.length === 0) {
      return; // No virtual interfaces to rename
    }

    console.log(`  Checking ${virtualInterfaces.length} virtual interface(s) for ${identity}...`);

    // Check each virtual interface and rename if needed
    for (const virt of virtualInterfaces) {
      // Extract the band suffix from the virtual interface name
      const nameBandMatch = virt.name.match(new RegExp(`^${identity}-(2g|5g)(-ssid\\d+)$`));
      if (!nameBandMatch) continue;

      const nameBand = nameBandMatch[1]; // "2g" or "5g" from the name
      const ssidSuffix = nameBandMatch[2]; // "-ssid2", "-ssid3", etc.

      // Extract the band from the master interface
      const masterBandMatch = virt.master.match(/-(2g|5g)$/);
      if (!masterBandMatch) continue;

      const masterBand = masterBandMatch[1]; // "2g" or "5g" from master

      // If the virtual name doesn't match its master, rename it
      if (nameBand !== masterBand) {
        const newName = `${identity}-${masterBand}${ssidSuffix}`;
        try {
          await mt.exec(`${wifiPath} set [find name="${virt.name}"] name="${newName}"`);
          console.log(`  ✓ Virtual: ${virt.name} → ${newName}`);
        } catch (e) {
          console.log(`  ⚠️  Virtual rename ${virt.name} failed: ${e.message}`);
        }
      }
    }
  } catch (e) {
    console.log(`  ⚠️  Could not check virtual interfaces: ${e.message}`);
  }
}

/**
 * Discover CAP-operated interfaces on a CAPsMAN controller
 * For wifi-qcom, these interfaces appear after CAPs connect with naming like:
 * - "<cap-identity>-2g" for 2.4GHz
 * - "<cap-identity>-5g" for 5GHz
 *
 * IMPORTANT: The interface naming (-2g/-5g) comes from MikroTik's CAPsMAN and
 * represents the physical interface number, NOT the actual radio band. Some devices
 * like cAP ax have swapped radios where wifi1 is actually 5GHz.
 *
 * This function:
 * 1. Detects actual radio bands via hardware query
 * 2. Renames misnamed interfaces to match actual bands
 * 3. Returns interfaces with correct names
 *
 * @param {MikroTikSSH} mt - Connected SSH session
 * @param {string} wifiPath - WiFi command path (/interface/wifi or /interface/wifiwave2)
 * @param {string} wifiPackage - WiFi package type (wifi-qcom or wifiwave2)
 * @returns {Array<{name: string, band: string}>} - List of CAP interfaces with correct names
 */
async function discoverCapInterfaces(mt, wifiPath, wifiPackage) {
  const capInterfaces = [];

  try {
    // Method 1: Get actual bands from radio hardware (most reliable)
    const radioBandMap = await getRadioBandMapping(mt, wifiPath);

    // Method 2: Get list of CAPs with swapped radios based on board type (fallback)
    const swappedCaps = await getSwappedRadioCaps(mt, wifiPackage);

    // List all WiFi interfaces
    const output = await mt.exec(`${wifiPath} print terse without-paging`);

    // Parse each line for CAP interface names
    for (const line of output.split('\n')) {
      if (!line.trim()) continue;

      // Extract interface name
      const nameMatch = line.match(/name="?([^"\s]+)"?/);
      if (!nameMatch) continue;

      const name = nameMatch[1];

      // Skip local interfaces (wifi1, wifi2, wifi1-ssid2, etc.)
      if (/^wifi\d/.test(name)) continue;

      // CAP interfaces end with -2g or -5g (master interfaces only, not virtuals)
      if (!name.endsWith('-2g') && !name.endsWith('-5g')) continue;

      let band = null;
      let detectionMethod = null;

      // Method 1: Use radio hardware band detection (most reliable)
      if (radioBandMap.has(name)) {
        band = radioBandMap.get(name);
        detectionMethod = 'radio hardware';
      }

      // Method 2: Check if device has swapped radios based on board type
      if (!band) {
        const capIdentity = name.replace(/-2g$/, '').replace(/-5g$/, '');
        const isSwappedDevice = swappedCaps.has(capIdentity);
        const suffix = name.endsWith('-2g') ? '2g' : '5g';

        if (isSwappedDevice) {
          // Swapped radios: -2g suffix is actually 5GHz, -5g suffix is actually 2.4GHz
          band = suffix === '2g' ? '5GHz' : '2.4GHz';
          detectionMethod = 'board type (swapped)';
        } else {
          // Method 3: Use interface name suffix (fallback, may be wrong)
          band = suffix === '2g' ? '2.4GHz' : '5GHz';
          detectionMethod = 'interface name';
        }
      }

      // Log misnamed interfaces
      const nameSuggestsBand = name.endsWith('-2g') ? '2.4GHz' : '5GHz';
      if (band !== nameSuggestsBand) {
        console.log(`ℹ️  ${name}: Actual band is ${band} (via ${detectionMethod}) - will rename`);
      }

      if (band) {
        capInterfaces.push({ name, band });
      }
    }

    // Rename misnamed interfaces to match actual bands
    if (capInterfaces.length > 0) {
      const correctedInterfaces = await renameCapInterfacesToMatchBand(mt, wifiPath, capInterfaces);
      return correctedInterfaces;
    }
  } catch (e) {
    console.log(`⚠️  Could not discover CAP interfaces: ${e.message}`);
  }

  return capInterfaces;
}

module.exports = {
  detectBandToken,
  detectRadioLayout,
  applyBandSettings,
  configureWifiInterface,
  ensureWifiInterfaceUp,
  recheckPendingMasters,
  pollUntilRunning,
  runningQuery,
  getSwappedRadioCaps,
  getRadioBandMapping,
  renameCapInterfacesToMatchBand,
  discoverCapInterfaces
};
