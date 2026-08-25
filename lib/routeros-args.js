/**
 * Safe construction of RouterOS command arguments.
 *
 * Every value that reaches a device command originates in a YAML file. Those
 * values were previously interpolated raw, which had two consequences:
 *
 *   - A legitimate value containing a quote or a dollar sign - an ISP PPPoE
 *     password, say - produced a malformed command that either failed or
 *     configured the wrong thing.
 *   - A crafted value could close the quoted string and append further
 *     commands, which RouterOS would run with the SSH account's privileges.
 *
 * There are two distinct contexts and they need different treatment:
 *
 *   Quoted   `comment="..."`, `passphrase="..."` - escape and quote with q().
 *   Unquoted `interface=ether1`, `distance=2`    - quoting is not an option,
 *                                                  so the value must be proven
 *                                                  to match a strict shape.
 *
 * Escaping cannot rescue an unquoted argument, which is why the checkers below
 * throw rather than sanitise. A value that fails is a configuration error and
 * should stop the apply, not be silently rewritten into something else.
 */

const { escapeMikroTik } = require('./utils');

/**
 * Render a value as a quoted, escaped RouterOS string argument.
 * @param {*} value
 * @returns {string} - including the surrounding quotes
 */
function q(value) {
  return `"${escapeMikroTik(String(value === undefined || value === null ? '' : value))}"`;
}

/**
 * Throw unless the value matches a pattern, for use in unquoted argument
 * positions where escaping offers no protection.
 *
 * @param {*} value - Value to check
 * @param {RegExp} pattern - Shape the value must match
 * @param {string} what - Human-readable field name for the error
 * @returns {string} - The value, unchanged, when it is safe
 */
function must(value, pattern, what) {
  const str = String(value === undefined || value === null ? '' : value);
  if (!pattern.test(str)) {
    throw new Error(
      `Unsafe or malformed ${what}: ${JSON.stringify(str)}. ` +
      'It goes into a device command unquoted, so it must match ' + pattern
    );
  }
  return str;
}

// Interface and object names. RouterOS permits more than this, but everything
// this tool creates or references fits, and widening it widens the blast radius.
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const IPV4 = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const CIDR = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\/(?:3[0-2]|[12]?\d)$/;
const IP_RANGE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)-(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const DURATION = /^\d+[smhdw]?$/;
const INTEGER = /^\d{1,5}$/;
// An http(s) endpoint this tool POSTs to from the device. Deliberately narrow:
// no whitespace, quotes or backslashes, because the value is also written into
// a generated RouterOS script that backup reads back by pattern.
const HTTP_URL = /^https?:\/\/[^\s"'\\`]{1,250}$/;
// A notification title. It is sent as an "X-Title:" header and RouterOS
// separates several header fields with commas, so a comma would split it into
// a second, malformed header. A quote would end the string literal in the
// generated script that backup reads back by pattern.
const NOTIFY_TITLE = /^[^",\r\n]{1,64}$/;

const ifaceName = (v, what = 'interface name') => must(v, IDENTIFIER, what);
const ipv4 = (v, what = 'IPv4 address') => must(v, IPV4, what);
const cidr = (v, what = 'CIDR address') => must(v, CIDR, what);
const ipRange = (v, what = 'address range') => must(v, IP_RANGE, what);
const duration = (v, what = 'duration') => must(v, DURATION, what);
const integer = (v, what = 'number') => must(v, INTEGER, what);

/**
 * Validate a comma-separated list of IPv4 addresses (DNS server lists).
 * @param {Array<string>|string} value
 * @param {string} what
 * @returns {string} - Comma-joined, safe to interpolate unquoted
 */
function ipv4List(value, what = 'address list') {
  const items = Array.isArray(value) ? value : String(value).split(',');
  const clean = items.map(v => String(v).trim()).filter(Boolean);
  if (clean.length === 0) throw new Error(`Empty ${what}`);
  clean.forEach(v => ipv4(v, what));
  return clean.join(',');
}

/**
 * Render a multi-line RouterOS script body as a quoted `source=` argument.
 *
 * Two things make this different from q(). A command is sent to the device as
 * one line, so a real newline in the body would end the command mid-string;
 * RouterOS spells a newline inside a quoted string as `\n`, so that is what has
 * to go on the wire. And the body is code, so the `$` in `$cur` must survive:
 * q() escapes it to `\$`, which RouterOS un-escapes back to `$` when it stores
 * the source. Escaping first and rewriting newlines second keeps the two from
 * interfering - by the time newlines are rewritten, every backslash that the
 * body itself contained has already been doubled.
 *
 * @param {string} body - Script text with real newlines
 * @returns {string} - Including the surrounding quotes
 */
function scriptSource(body) {
  return `"${escapeMikroTik(String(body)).replace(/\r/g, '').replace(/\n/g, '\\n')}"`;
}

module.exports = {
  q, must, scriptSource,
  ifaceName, ipv4, cidr, ipRange, duration, integer, ipv4List,
  IDENTIFIER, IPV4, CIDR, IP_RANGE, DURATION, HTTP_URL, NOTIFY_TITLE
};
