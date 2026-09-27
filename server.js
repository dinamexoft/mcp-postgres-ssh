#!/usr/bin/env node
import {Client} from 'pg';
import {Client as SSHClient} from 'ssh2';
import fs from 'fs';
import readline from 'readline';

// Support `mcp-postgres-ssh --env-file path/to/.env` for global/npx installs,
// where Node's own --env-file flag can't be applied (the shim invokes this
// file directly, not `node --env-file=... server.js`). Values already present
// in the environment win, so `node --env-file=... server.js` keeps working too.
function loadEnvFile(path) {
  const content = fs.readFileSync(path, 'utf8');
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const envFileFlagIndex = process.argv.findIndex((arg) => arg === '--env-file' || arg.startsWith('--env-file='));
if (envFileFlagIndex !== -1) {
  const flag = process.argv[envFileFlagIndex];
  const envFilePath = flag.includes('=') ? flag.slice(flag.indexOf('=') + 1) : process.argv[envFileFlagIndex + 1];
  loadEnvFile(envFilePath);
}

const USAGE = `Usage: mcp-postgres-ssh --env-file <path/to/.env>

Required variables in that env file (see README.md section 3):
  SSH_HOST      SSH host to tunnel through
  SSH_USER      SSH username on that host
  SSH_KEY       path to the SSH private key
  DB_USER       Postgres user
  DB_PASSWORD   Postgres password

Optional:
  SSH_PORT        (default 22)
  REMOTE_DB_HOST  (default 127.0.0.1)
  REMOTE_DB_PORT  (default 5432)
  DB_NAME         (default postgres)`;

function fail(message) {
  console.error(`[Config error] ${message}\n\n${USAGE}`);
  process.exit(1);
}

const REQUIRED_ENV_VARS = ['SSH_HOST', 'SSH_USER', 'SSH_KEY', 'DB_USER', 'DB_PASSWORD'];
for (const name of REQUIRED_ENV_VARS) {
  if (!process.env[name]) {
    fail(`Missing required environment variable ${name}. Set it in the env file passed to --env-file, or export it before running.`);
  }
}

let sshPrivateKey;
try {
  sshPrivateKey = fs.readFileSync(process.env.SSH_KEY);
} catch (e) {
  fail(`Could not read SSH_KEY at "${process.env.SSH_KEY}": ${e.message}`);
}

const CONFIG = {
  sshHost: process.env.SSH_HOST,
  sshPort: parseInt(process.env.SSH_PORT || '22'),
  sshUsername: process.env.SSH_USER,
  sshPrivateKey,
  remoteDbHost: process.env.REMOTE_DB_HOST || '127.0.0.1',
  remoteDbPort: parseInt(process.env.REMOTE_DB_PORT || '5432'),
  dbUser: process.env.DB_USER,
  dbPassword: process.env.DB_PASSWORD,
  dbDatabase: process.env.DB_NAME || 'postgres',
};

let sshConnection = null;
let pgClient = null;

function connectSSH() {
  return new Promise((resolve, reject) => {
    const conn = new SSHClient();
    conn.on('ready', () => {
      console.error('[SSH] Connected to ' + CONFIG.sshHost);
      resolve(conn);
    });
    conn.on('error', reject);
    conn.on('close', () => {
      console.error('[SSH] Connection closed');
      sshConnection = null;
      pgClient = null;
    });
    conn.connect({
      host: CONFIG.sshHost,
      port: CONFIG.sshPort,
      username: CONFIG.sshUsername,
      privateKey: CONFIG.sshPrivateKey,
      readyTimeout: 30000, // give it more room before giving up
      keepaliveInterval: 10000,
    });
  });
}

async function getSSHConnection() {
  if (!sshConnection) {
    sshConnection = await connectSSH();
  }
  return sshConnection;
}

function forwardToPostgres(ssh) {
  return new Promise((resolve, reject) => {
    ssh.forwardOut('127.0.0.1', 0, CONFIG.remoteDbHost, CONFIG.remoteDbPort, (err, stream) => {
      if (err) return reject(err);
      resolve(stream);
    });
  });
}

async function executeSQLQuery(query) {
  if (!pgClient) {
    const ssh = await getSSHConnection();
    const stream = await forwardToPostgres(ssh);
    // ssh2's forwarded channel is a plain Duplex, not a net.Socket — pg's
    // Connection assumes TCP-socket methods exist and calls them unconditionally.
    stream.setNoDelay = stream.setNoDelay || (() => {
    });
    stream.setKeepAlive = stream.setKeepAlive || (() => {
    });
    stream.ref = stream.ref || (() => {
    });
    stream.unref = stream.unref || (() => {
    });
    // pg's Connection.connect() unconditionally calls stream.connect(port, host)
    // and then waits for a 'connect' event — but our stream is an ssh2 forwarded
    // channel that's already open and has no .connect() of its own. Stub it to
    // just announce "connected" immediately.
    stream.connect = () => {
      process.nextTick(() => stream.emit('connect'));
    };

    pgClient = new Client({
      stream,
      user: CONFIG.dbUser,
      password: CONFIG.dbPassword,
      database: CONFIG.dbDatabase,
      ssl: false,
    });
    pgClient.on('error', (e) => {
      console.error('[PG] Connection error, resetting:', e.message);
      pgClient = null;
    });
    await pgClient.connect();
  }
  return (await pgClient.query(query)).rows;
}

async function closeConnections() {
  if (pgClient) {
    try {
      await pgClient.end();
    } catch {
    }
    pgClient = null;
  }
  if (sshConnection) {
    sshConnection.end();
    sshConnection = null;
  }
}

// Close the tunnel after a period of inactivity — "open on request, close after" —
// rather than holding it open (or tearing it down) after every single query,
// which would force a full SSH handshake for every request.
let idleTimer = null;
const IDLE_CLOSE_MS = 60000;

function resetIdleTimer() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    console.error('[Idle] Closing tunnel after inactivity');
    closeConnections();
  }, IDLE_CLOSE_MS);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handleRequest(request) {
  const {id, method, params} = request;

  if (id === undefined) {
    console.error(`[Notify] ${method}`);
    return;
  }

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          capabilities: {tools: {}},
          serverInfo: {name: 'mcp-postgres-ssh', version: '1.1.0'},
        },
      });
    } else if (method === 'tools/list') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          tools: [
            {
              name: 'query',
              description: 'Execute SQL query (read-only)',
              inputSchema: {
                type: 'object',
                properties: {sql: {type: 'string'}},
                required: ['sql'],
              },
            },
          ],
        },
      });
    } else if (method === 'tools/call') {
      resetIdleTimer();
      const sql = params.arguments.sql;
      if (/^\s*(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|GRANT|REVOKE)\s/i.test(sql)) {
        send({jsonrpc: '2.0', id, error: {code: -1, message: 'Read-only: SELECT only'}});
      } else {
        const result = await executeSQLQuery(sql);
        send({
          jsonrpc: '2.0',
          id,
          result: {content: [{type: 'text', text: JSON.stringify(result, null, 2)}]},
        });
      }
    } else {
      send({jsonrpc: '2.0', id, error: {code: -32601, message: 'Method not found'}});
    }
  } catch (e) {
    send({jsonrpc: '2.0', id, error: {code: -1, message: e.message}});
  }
}

const rl = readline.createInterface({input: process.stdin});
rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    handleRequest(JSON.parse(line));
  } catch (e) {
    console.error('[Parse error]', e.message);
  }
});

process.on('SIGINT', async () => {
  await closeConnections();
  process.exit(0);
});

console.error('[Ready] MCP server ready — tunnel opens on first query, closes after 60s idle');
