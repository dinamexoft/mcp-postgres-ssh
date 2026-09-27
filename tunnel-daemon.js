#!/usr/bin/env node
// Standalone SSH port-forward daemon.
// Run this ONCE, outside of Claude, in its own terminal (or as a background
// service — see run-daemon.ps1 / instructions). It holds the SSH connection
// and re-exposes the remote Postgres as a plain TCP port on 127.0.0.1.
//
// Claude's spawned MCP process (server.js) never touches SSH at all — it
// just connects to 127.0.0.1:LOCAL_PG_PORT like any local Postgres.

import {Client as SSHClient} from 'ssh2';
import fs from 'fs';
import net from 'net';

const CONFIG = {
  sshHost: process.env.SSH_HOST,
  sshPort: parseInt(process.env.SSH_PORT || '22'),
  sshUsername: process.env.SSH_USER,
  sshPrivateKey: fs.readFileSync(process.env.SSH_KEY),
  remoteDbHost: process.env.REMOTE_DB_HOST || '127.0.0.1',
  remoteDbPort: parseInt(process.env.REMOTE_DB_PORT || '5432'),
  localPort: parseInt(process.env.LOCAL_PG_PORT || '5433'),
};

let sshConnection = null;

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => {
      console.log(`[SSH] Connected to ${CONFIG.sshHost}`);
      resolve(conn);
    });
    conn.on('error', reject);
    conn.on('close', () => {
      console.log('[SSH] Connection closed — will retry on next connection attempt');
      sshConnection = null;
    });
    conn.connect({
      host: CONFIG.sshHost,
      port: CONFIG.sshPort,
      username: CONFIG.sshUsername,
      privateKey: CONFIG.sshPrivateKey,
      keepaliveInterval: 15000,
      readyTimeout: 20000,
    });
  });
}

async function getSSHConnection() {
  if (!sshConnection) {
    sshConnection = await connectSSH();
  }
  return sshConnection;
}

const server = net.createServer(async (localSocket) => {
  try {
    const ssh = await getSSHConnection();
    ssh.forwardOut(
      '127.0.0.1',
      localSocket.remotePort,
      CONFIG.remoteDbHost,
      CONFIG.remoteDbPort,
      (err, stream) => {
        if (err) {
          console.error('[Forward] Failed:', err.message);
          localSocket.destroy();
          return;
        }
        localSocket.pipe(stream).pipe(localSocket);
        stream.on('close', () => localSocket.destroy());
        localSocket.on('close', () => stream.destroy());
        localSocket.on('error', () => stream.destroy());
        stream.on('error', () => localSocket.destroy());
      }
    );
  } catch (e) {
    console.error('[Connect] SSH unavailable:', e.message);
    localSocket.destroy();
  }
});

server.listen(CONFIG.localPort, '127.0.0.1', () => {
  console.log(`[Ready] Forwarding 127.0.0.1:${CONFIG.localPort} -> (via SSH) -> ${CONFIG.remoteDbHost}:${CONFIG.remoteDbPort}`);
  console.log('[Ready] Keep this window open. Claude connects through this daemon.');
});

process.on('SIGINT', () => {
  if (sshConnection) sshConnection.end();
  server.close();
  process.exit(0);
});
