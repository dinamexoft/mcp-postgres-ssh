# mcp-postgres-ssh

An MCP (Model Context Protocol) server that gives **read-only** SQL access to a Postgres database that sits behind an
SSH auth — no VPN, no exposed DB port. Agent spawns `server.js` per session; it opens an SSH tunnel on the first query
and tears it down after 60s of inactivity. Only `SELECT` statements are allowed — any `INSERT`/`UPDATE`/`DELETE`/`DROP`/
`ALTER`/`CREATE`/`TRUNCATE`/`GRANT`/`REVOKE` is rejected before it reaches the database.

## How it works

- `server.js` — the MCP server agent launches. Connects over SSH to your host, forwards to Postgres, runs the query,
  closes after idle timeout.
- `tunnel-daemon.js` — optional standalone daemon that holds a persistent SSH tunnel on a local TCP port, if you'd
  rather not pay the SSH handshake cost per agent session.

This tool is installed once and configured **per environment** you want SQL access to (one env file + one agent config
entry per environment). See [Running multiple projects in parallel](#running-multiple-projects-in-parallel) at the end.

## 1. Server-side setup: read-only DB user

Run these on the Postgres server (as a superuser / `postgres` role), once per database you want to expose:

<!-- @formatter:off -->
```sql
CREATE ROLE mcp_readonly WITH LOGIN PASSWORD 'change-me-strong-password';
GRANT CONNECT ON DATABASE myprojectdb TO mcp_readonly;
GRANT USAGE ON SCHEMA public TO mcp_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO mcp_readonly;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO mcp_readonly;
```
<!-- @formatter:on -->
Repeat the last three lines for any other schema you want visible. The `mcp_readonly` role name can be reused as-is
across every project/server — it's the SSH identity below that must be unique per server.

## 2. Server-side setup: SSH key for the tunnel user

On the SSH host, create an MCP tunnel user:

```bash
sudo useradd -m -s /usr/sbin/nologin mcp_tunnel
sudo mkdir -p /home/mcp_tunnel/.ssh
```

On your **client** machine, generate a dedicated keypair (don't reuse your personal key, and don't reuse this one across
projects):

Linux/macOS:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/myproject_dev_mcp_postgres_ssh -N ""
```

Windows (PowerShell — `-N ""` doesn't reliably pass an empty passphrase; use this instead):

```powershell
ssh-keygen -t ed25519 -f "$env:USERPROFILE\.ssh\myproject_dev_mcp_postgres_ssh" -N "`"`""
```

Copy the **public** key to the server:

On the remote:
```bash
nano /home/mcp_tunnel/.ssh/authorized_keys
```

Windows:

```powershell
Get-Content $env:USERPROFILE\.ssh\myproject_dev_mcp_postgres_ssh.pub | Set-Clipboard
```

Linux/macOS:

```bash
cat ~/.ssh/myproject_dev_mcp_postgres_ssh.pub | pbcopy
```

On the remote:

```bash
# paste, save & exit
chmod 600 /home/mcp_tunnel/.ssh/authorized_keys
chown -R mcp_tunnel:mcp_tunnel /home/mcp_tunnel/.ssh
nano /etc/ssh/sshd_config
```
Restrict this user to port-forwarding only, no shell — add this in `/etc/ssh/sshd_config` (or a `Match User` block):

```
Match User mcp_tunnel
    AllowTcpForwarding yes
    X11Forwarding no
    PermitTunnel no
    ForceCommand /usr/sbin/nologin
```

Reload sshd:

```bash
sudo systemctl reload sshd
```

## 3. Client install

Requires Node.js 20+.

**Windows / Linux / macOS — same steps:**

Installs the `mcp-postgres-ssh` command globally

```bash
npm install -g mcp-postgres-ssh
```

Create an env file for the project:

```ini
SSH_HOST=your-ssh-host
SSH_PORT=22
SSH_USER=mcp_tunnel
SSH_KEY=/home/you/.ssh/myproject_dev_mcp_postgres_ssh

DB_USER=mcp_readonly
DB_PASSWORD=change-me-strong-password
DB_NAME=myprojectdb
```

Save it as `.env.myproject-dev-mcp-postgres-ssh` (or similar). On Windows, `SSH_KEY` can use a Windows path, e.g.
`C:\Users\you\.ssh\myproject_dev_mcp_postgres_ssh`. Keep this file out of any git repo — it holds the DB password.

Sanity-check it works before wiring it with the agent:

```bash
mcp-postgres-ssh --env-file /path/to/.env.myproject-dev-mcp-postgres-ssh
```

It should print `[Ready] MCP server ready ...` to stderr and then sit waiting for input — `Ctrl+C` to stop.

## 4. Add it to Claude

Edit your Claude Desktop / Claude Code MCP config (create the file if it doesn't exist):

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

The same block on every OS — only the `--env-file` path syntax differs:

**Windows:**

```json
{
  "mcpServers": {
    "myproject-dev-postgres": {
      "command": "mcp-postgres-ssh",
      "args": [
        "--env-file",
        "C:\\Users\\you\\.env.myproject-dev-mcp-postgres-ssh"
      ]
    }
  }
}
```

**Linux / macOS:**

```json
{
  "mcpServers": {
    "myproject-dev-postgres": {
      "command": "mcp-postgres-ssh",
      "args": [
        "--env-file",
        "/home/you/.env.myproject-dev-mcp-postgres-ssh"
      ]
    }
  }
}
```

Restart Claude. You should see a `query` tool available under `myproject-dev-postgres`.

<sub>Prefer running from a local checkout instead of a global installation? `git clone` the repo, `npm install`, then
use `"command": "node"` with `"args": ["--env-file=/path/to/.env", "/path/to/server.js"]` — both invocation styles read
the same env vars. `.gitignore` already excludes `.env*`.</sub>

## Running multiple projects in parallel

The whole setup above is designed to be repeated per environment, side by side, without collisions:

- **DB role**: `mcp_readonly` username can be the same.
- **SSH identity**: each server gets its own SSH keypair (`myproject_dev_mcp_postgres_ssh`,
  `myproject_uat_mcp_postgres_ssh`, ...), so access can be revoked per server without affecting the others.
- **Env files**: `/home/you/.env.<project>-<environment>-mcp-postgres-ssh` or `path/to/project/.env.mcp-postgres-ssh`
  (remember to gitignore it)
- Set a unique MCP_PORT per environment.
- **Claude config**: one `mcpServers` entry per environment (`myproject-dev-postgres`, `myproject-uat-postgres`, ...),
  each pointing at its own `--env-file`.

Agent spawns a separate `server.js` process per configured entry, repeat sections 1–4 above for a new instance.

## Optional: persistent tunnel daemon

If you don't want an SSH handshake on every agent session's first query, run `tunnel-daemon.js` once in its own terminal
(or as a background service) with the same `.env` variables plus `LOCAL_PG_PORT`, then point `server.js` at
`127.0.0.1:LOCAL_PG_PORT` instead of SSH-ing directly. Use a distinct `LOCAL_PG_PORT` per environment if running more
than one daemon. See `tunnel-daemon.js` for details.

## Security notes

- The `query` tool rejects any statement starting with a write/DDL keyword — treat this as a safety net, not a
  substitute for a genuinely read-only DB role.
- Never commit `.env*` files or SSH private keys.
- Use a dedicated SSH key and DB role for this tool — don't reuse personal credentials.
