#!/usr/bin/env node

const { Client } = require('ssh2');
const net = require('net');

let password = process.argv[2];

if (!password) {
  console.log('Usage: node wait-for-device.js <password>');
  console.log('Example: node wait-for-device.js DQ45LVEQRZ');
  process.exit(1);
}

function testPort() {
  return new Promise((resolve) => {
    const socket = net.connect(22, '192.168.88.1');
    socket.setTimeout(2000);

    socket.on('connect', () => {
      socket.end();
      resolve(true);
    });

    socket.on('error', () => {
      resolve(false);
    });

    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function testSSH(password) {
  return new Promise((resolve) => {
    const conn = new Client();
    const timeout = setTimeout(() => {
      conn.end();
      resolve(false);
    }, 5000);

    conn.on('ready', () => {
      clearTimeout(timeout);
      conn.end();
      resolve(true);
    });

    conn.on('error', () => {
      clearTimeout(timeout);
      resolve(false);
    });

    conn.connect({
      host: '192.168.88.1',
      port: 22,
      username: 'admin',
      password: password,
      readyTimeout: 5000
    });
  });
}

async function waitForDevice() {
  console.log('Waiting for device to be ready...');
  console.log('Testing with password:', password);
  console.log('');

  let attempts = 0;
  const maxAttempts = 60; // 60 seconds

  while (attempts < maxAttempts) {
    attempts++;
    process.stdout.write(`\rAttempt ${attempts}/${maxAttempts}... `);

    // First check if port is open
    const portOpen = await testPort();
    if (!portOpen) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      continue;
    }

    process.stdout.write('Port open, testing SSH... ');

    // Then check if SSH works
    const sshWorks = await testSSH(password);
    if (sshWorks) {
      console.log('\n');
      console.log('✓✓✓ Device is ready! ✓✓✓');
      console.log('');
      console.log('You can now run:');
      console.log('  node apply-config.js config.yaml');
      console.log('');
      process.exit(0);
    }

    await new Promise(resolve => setTimeout(resolve, 1000));
  }

  console.log('\n');
  console.log('✗ Timeout waiting for device');
  console.log('Please check:');
  console.log('  1. Device is powered on');
  console.log('  2. Device is connected to network');
  console.log('  3. Device IP is 192.168.88.1');
  console.log('  4. Password is correct');
  process.exit(1);
}

waitForDevice();
