# Multi Account Dashboard Plugin

Private dashboard companion for [`pi-multi-account`](https://github.com/Sarrius/pi-multi-account).

The package contributes:

- a Pi bridge that activates `pi-multi-account@1.21.3` unchanged;
- a dashboard **Settings → Plugins → Multi Account** page;
- redacted account, quota, cooldown, and switch status;
- allowlisted configuration controls;
- session-scoped `next`, `rediscover`, and `reload` actions;
- **+ Account** using the dashboard's existing Anthropic or Codex OAuth login.

## Security boundary

OAuth credentials never reach the React client, plugin API responses, or logs. The server reads only the upstream redacted state sidecar for status. When adding an account, it copies the current base OAuth credential to the next alias slot while holding Pi's `proper-lockfile` lock, then starts the dashboard's existing login flow for the base provider. The copy preserves the working account if login is cancelled.

Do not install `pi-multi-account` separately when this package's bridge is active. The bridge skips activation when it detects an already-loaded `/multi-account` command, but load ordering can still create duplicate registrations.

## Local dashboard installation

The current dashboard client registry is generated at build time. Keep this repository outside the dashboard source tree, then link it locally:

```bash
ln -s /path/to/multi-account-plugin /path/to/pi-agent-dashboard/packages/multi-account-plugin
cd /path/to/pi-agent-dashboard
npm run build
curl -X POST http://localhost:8000/api/restart
npm run reload
```

The link is local-only and must not be committed to the dashboard repository.

## Development

```bash
npm install
npm run check
```
