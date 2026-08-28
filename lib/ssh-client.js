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

module.exports = { MikroTikSSH, redactSecrets };
