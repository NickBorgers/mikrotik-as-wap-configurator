/**
 * MikroTik SSH Client
 * Wrapper around ssh2 for connecting to MikroTik devices
 */

const { Client } = require('ssh2');

/**
 * Strip secrets from anything that might be logged.
 *
 * Callers routinely log `e.message`, and WiFi commands carry
 * `security.passphrase="..."`. An error must never be the reason a wireless
 * password lands in a console, a CI log, or a bug report.
 *
 * @param {string} text
 * @returns {string}
 */
function redactSecrets(text) {
  return String(text === undefined || text === null ? '' : text)
    .replace(/((?:passphrase|password|psk|secret|pre-shared-key)[^\s=]*\s*=\s*)("(?:[^"\\]|\\.)*"|\S+)/gi, '$1<redacted>');
}

/**
 * RouterOS CLI error replies, as they appear at the START of a line of output.
 *
 * exec() decides failure by the exit status, and that stays the rule (see the
 * long comment in exec()). But a parse error has been seen to come back with
 * exit 0. Live on a cAP ax, RouterOS 7.21 stable, wifi-qcom, 2026-11-18:
 *
 *   /interface/wifi set wifi1 channel.frequency=5745 channel.tx-power=17 ...
 *     stdout "expected end of command (line 1 column 50)", exit 0
 *
 * RouterOS rejected the whole line, and the caller logged "✓ Applied".
 *
 * These patterns are NOT applied by exec(). Only execStrict() uses them, and
 * only for commands that print nothing on success (`set`). A read such as
 * `/log print` can contain "failure" or "error" mid-line, and must never be
 * passed through this check. Every pattern is anchored at the start of a line
 * for the same reason.
 */
const ROUTEROS_CLI_ERRORS = [
  /^expected end of command\b/,
  /^syntax error\b/,
  /^input does not match any value\b/,
  /^bad command name\b/,
  /^failure:/,
  /^no such item\b/,
  /^invalid value\b/,
  /^ambiguous value\b/
];

/**
 * Return the first line of `output` that is a RouterOS CLI error, or null.
 * @param {string} output
 * @returns {string|null}
 */
function routerOsCliError(output) {
  const lines = String(output === undefined || output === null ? '' : output).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (ROUTEROS_CLI_ERRORS.some(re => re.test(line))) return line;
  }
  return null;
}

/**
 * exec() for commands that print NOTHING on success, such as `set`.
 *
 * It rejects in every case where exec() rejects, and ALSO when the output
 * holds a RouterOS CLI error, even though the exit status was 0. Use it
 * where a silent rejection would be reported as success. Do NOT use it for
 * reads (`print`, `:put`, `export`): their output is data.
 *
 * Opt-in on purpose. Callers that tolerate errors (`remove [find ...]`,
 * execIdempotent's "already exists") keep using exec() and are unaffected.
 *
 * @param {{exec: function(string): Promise<string>}} mt
 * @param {string} command
 * @returns {Promise<string>}
 */
async function execStrict(mt, command) {
  const output = await mt.exec(command);
  const err = routerOsCliError(output);
  if (err) {
    // Like exec(): the device's text only, never the command, and redacted.
    throw new Error(`RouterOS rejected the command (exit 0): ${redactSecrets(err)}`);
  }
  return output;
}

class MikroTikSSH {
  constructor(host, username, password) {
    this.host = host;
    this.username = username;
    this.password = password;
    this.conn = new Client();
    this.connected = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.conn.on('ready', () => {
        console.log('✓ Connected to MikroTik device');
        this.connected = true;
        resolve();
      }).on('close', () => {
        this.connected = false;
      }).on('error', (err) => {
        this.connected = false;
        // Improve error messages for common issues
        if (err.message.includes('All configured authentication methods failed')) {
          reject(new Error(`Authentication failed for user '${this.username}' at ${this.host} - check username and password`));
        } else if (err.message.includes('ECONNREFUSED')) {
          reject(new Error(`Connection refused to ${this.host}:22 - check if device is reachable and SSH is enabled`));
        } else if (err.message.includes('ETIMEDOUT') || err.message.includes('Timed out')) {
          reject(new Error(`Connection timeout to ${this.host} - check network connectivity and firewall rules`));
        } else if (err.message.includes('EHOSTUNREACH')) {
          reject(new Error(`Host ${this.host} is unreachable - check network path and routing`));
        } else {
          reject(err);
        }
      }).connect({
        host: this.host,
        port: 22,
        username: this.username,
        password: this.password,
        readyTimeout: 30000,
        algorithms: {
          serverHostKey: ['ssh-rsa', 'rsa-sha2-256', 'rsa-sha2-512', 'ecdsa-sha2-nistp256', 'ecdsa-sha2-nistp384', 'ecdsa-sha2-nistp521', 'ssh-ed25519']
        }
      });
    });
  }

  async exec(command) {
    return new Promise((resolve, reject) => {
      // Check if connection is still alive
      if (!this.connected) {
        reject(new Error('Not connected'));
        return;
      }

      const timeout = setTimeout(() => {
        reject(new Error('Command timeout'));
      }, 30000);

      this.conn.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timeout);
          reject(err);
          return;
        }

        let output = '';
        let errorOutput = '';

        stream.on('close', (code, signal) => {
          clearTimeout(timeout);

          if (errorOutput) {
            reject(new Error(errorOutput));
            return;
          }

          if (signal) {
            // Deliberately WITHOUT the command. WiFi commands contain
            // security.passphrase="..." and callers log e.message.
            reject(new Error(`Command killed by signal ${signal}`));
            return;
          }

          // RouterOS prints its errors to STDOUT, not stderr, and this method
          // used to resolve whenever stderr was empty. Every `try { await
          // mt.exec(...) } catch` in this codebase was therefore decorative: a
          // rejected command looked exactly like a successful one, and its
          // error text was returned as if it were data.
          //
          // It does, however, set a non-zero exit status. Verified on a live
          // Chateau LTE6 (RouterOS 7.18.2):
          //
          //   /ip service set [find name="ssh"] address=999.999.999.999/99
          //     exit 1, stderr "", stdout "invalid value for argument address:..."
          //   /bogus/command
          //     exit 1, stderr "", stdout "syntax error (line 1 column 7)"
          //   :put [/interface/wifi/get [find name="nope"] master-interface]
          //     exit 1, stderr "", stdout "no such item (...)"
          //
          // The exit status is the signal to use. Matching on the text would
          // be worse than useless: `/log print` legitimately returns lines
          // containing "failure" and "error", and rejecting those would break
          // reads of real data.
          const detail = redactSecrets((output || '').trim()) || '(no output)';

          // A missing exit status is NOT the same as a non-zero one. ssh2
          // reports the code as null/undefined when the channel closes without
          // an exit-status request, and calling that "exit null" would send
          // someone hunting a RouterOS rejection that never happened. It still
          // rejects: an unknown outcome must not be reported as success, which
          // is the whole point of this change.
          if (typeof code !== 'number') {
            reject(new Error(
              `Connection closed without an exit status, so the command's outcome is unknown. Output: ${detail}`
            ));
            return;
          }

          if (code !== 0) {
            reject(new Error(`RouterOS rejected the command (exit ${code}): ${detail}`));
            return;
          }

          resolve(output);
        }).on('data', (data) => {
          output += data.toString();
        }).stderr.on('data', (data) => {
          errorOutput += data.toString();
        });
      });
    });
  }

  isConnected() {
    return this.connected;
  }

  async close() {
    this.connected = false;
    this.conn.end();
  }
}

module.exports = { MikroTikSSH, redactSecrets, routerOsCliError, execStrict, ROUTEROS_CLI_ERRORS };
