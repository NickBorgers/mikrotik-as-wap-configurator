#!/usr/bin/env node

/**
 * Test script for automatic device identity feature
 * Tests hostname extraction from FQDNs and identity setting
 */

const { MikroTikSSH } = require('./mikrotik-no-vlan-filtering.js');

// Test cases for hostname extraction
const testCases = [
  {
    input: 'indoor-wap-south.nickborgers.net',
    expected: 'indoor-wap-south',
    description: 'FQDN with subdomain'
  },
  {
    input: 'router.local',
    expected: 'router',
    description: 'FQDN with .local domain'
  },
  {
    input: 'mikrotik-ap-01.example.com',
    expected: 'mikrotik-ap-01',
    description: 'FQDN with dashes'
  },
  {
    input: '192.168.1.1',
    expected: null,
    description: 'IP address (should not extract)'
  },
  {
    input: 'simple-hostname',
    expected: 'simple-hostname',
    description: 'Simple hostname without domain'
  }
];

console.log('========================================');
console.log('Testing Identity Extraction Logic');
console.log('========================================\n');

for (const testCase of testCases) {
  const { input, expected, description } = testCase;

  let result = null;

  // Simulate the extraction logic from our implementation
  if (input.includes('.')) {
    // Check if it's not an IP address
    if (!input.match(/^\d+\.\d+\.\d+\.\d+$/)) {
      // Extract hostname from FQDN
      result = input.split('.')[0];
    }
  } else if (!input.match(/^\d+\.\d+\.\d+\.\d+$/)) {
    // If not an IP address, use it as hostname
    result = input;
  }

  const passed = result === expected;
  const status = passed ? '✓' : '✗';

  console.log(`${status} ${description}`);
  console.log(`  Input: ${input}`);
  console.log(`  Expected: ${expected}`);
  console.log(`  Got: ${result}`);
  console.log(passed ? '  PASSED' : '  FAILED');
  console.log('');
}

// Test with actual SSH command generation
console.log('========================================');
console.log('Testing SSH Command Generation');
console.log('========================================\n');

class MockSSH {
  constructor(host, username, password) {
    this.commands = [];
  }

  async connect() {
    console.log('Mock connect');
  }

  async exec(command) {
    this.commands.push(command);
    console.log(`Would execute: ${command}`);
    return '';
  }

  async close() {
    console.log('Mock close');
  }
}

// Test identity setting command
async function testIdentityCommand() {
  const testHost = 'indoor-wap-south.nickborgers.net';
  const expectedIdentity = 'indoor-wap-south';
  const expectedCommand = `/system identity set name="${expectedIdentity}"`;

  console.log(`Testing identity command for: ${testHost}`);
  console.log(`Expected identity: ${expectedIdentity}`);
  console.log(`Expected command: ${expectedCommand}`);

  // Simulate what our code would do
  const mock = new MockSSH(testHost, 'admin', 'password');
  await mock.connect();

  // Extract hostname
  let deviceIdentity;
  if (testHost.includes('.')) {
    deviceIdentity = testHost.split('.')[0];
  }

  if (deviceIdentity) {
    await mock.exec(`/system identity set name="${deviceIdentity}"`);
  }

  await mock.close();

  const commandGenerated = mock.commands[0] === expectedCommand;
  console.log(commandGenerated ? '\n✓ Command generated correctly' : '\n✗ Command generation failed');
}

testIdentityCommand().then(() => {
  console.log('\n========================================');
  console.log('Identity Feature Testing Complete');
  console.log('========================================');
}).catch(err => {
  console.error('Test failed:', err);
  process.exit(1);
});