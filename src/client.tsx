import { useSettingsDraftSource } from "@blackbelt-technology/dashboard-plugin-runtime";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

interface EditableConfig {
  enabled: boolean;
  autoContinue: boolean;
  showUsage: boolean;
  maxAutoContinuesPerPrompt: number;
}

interface UsageWindow {
  usedPercent: number;
  resetAt: number;
  windowSeconds?: number;
}

interface Account {
  provider: string;
  family?: string;
  account?: string;
  plan?: string;
  serviceable?: boolean;
  status: "ready" | "cooling" | "invalid";
  cooldownUntil?: number;
  primary?: UsageWindow;
  secondary?: UsageWindow;
}

interface DashboardState {
  engineVersion: string;
  config: EditableConfig;
  accounts: Account[];
  recentSwitches: Array<{ from: string; to: string; at: number }>;
}

interface ProviderStatus {
  id: string;
  authenticated: boolean;
  expires?: number;
}

interface DashboardSession {
  id: string;
  cwd?: string;
  status?: string;
}

interface SessionsResponse {
  success: boolean;
  data: DashboardSession[];
}

const API = "/api/plugins/multi-account";
const OAUTH_PROVIDERS = [
  { id: "anthropic", label: "Anthropic Claude Pro / Max" },
  { id: "openai-codex", label: "OpenAI ChatGPT Plus / Pro" },
] as const;

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body ? String(body.error) : `Request failed (${response.status})`;
    throw new Error(error);
  }
  return body as T;
}

function formatReset(timestamp: number | undefined): string | null {
  if (!timestamp) return null;
  const remaining = timestamp - Date.now();
  if (remaining <= 0) return "reset due";
  const minutes = Math.ceil(remaining / 60_000);
  if (minutes < 60) return `resets in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `resets in ${hours}h ${minutes % 60}m`;
}

function WindowMeter({ label, value }: { label: string; value?: UsageWindow }) {
  if (!value) return null;
  const reset = formatReset(value.resetAt);
  return (
    <div className="ma-window">
      <div className="ma-window-label">
        <span>{label}</span>
        <span>{Math.round(value.usedPercent)}% used{reset ? ` · ${reset}` : ""}</span>
      </div>
      <progress max={100} value={value.usedPercent} aria-label={`${label}: ${Math.round(value.usedPercent)} percent used`} />
    </div>
  );
}

function sessionLabel(session: DashboardSession): string {
  const cwd = session.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return `${cwd || "Session"} · ${session.id.slice(0, 8)}`;
}

export function MultiAccountSettings() {
  const [sessions, setSessions] = useState<DashboardSession[]>([]);
  const activeSessions = useMemo(
    () => sessions.filter((session) => session.status !== "ended"),
    [sessions],
  );
  const [state, setState] = useState<DashboardState | null>(null);
  const [draft, setDraft] = useState<EditableConfig | null>(null);
  const [selectedSession, setSelectedSession] = useState("");
  const [oauthProvider, setOauthProvider] = useState<(typeof OAUTH_PROVIDERS)[number]["id"]>("anthropic");
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ kind: "ok" | "error" | "info"; text: string } | null>(null);
  const alive = useRef(true);
  const baseline = useRef<EditableConfig | null>(null);

  const refresh = useCallback(async (rebaseDraft = true) => {
    const [next, sessionResponse] = await Promise.all([
      request<DashboardState>(`${API}/status`),
      request<SessionsResponse>("/api/sessions"),
    ]);
    if (!alive.current) return;
    setState(next);
    if (rebaseDraft) {
      baseline.current = next.config;
      setDraft(next.config);
    }
    setSessions(sessionResponse.success && Array.isArray(sessionResponse.data) ? sessionResponse.data : []);
  }, []);

  useEffect(() => {
    alive.current = true;
    void refresh().catch((error: Error) => setNotice({ kind: "error", text: error.message }));
    return () => {
      alive.current = false;
    };
  }, [refresh]);

  useEffect(() => {
    if (!selectedSession && activeSessions[0]) setSelectedSession(activeSessions[0].id);
  }, [activeSessions, selectedSession]);

  const commit = useCallback(async () => {
    if (!draft) return;
    setBusy("save");
    setNotice(null);
    try {
      await request(`${API}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      let reloaded = false;
      if (selectedSession) {
        try {
          await request(`${API}/action`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ sessionId: selectedSession, action: "reload" }),
          });
          reloaded = true;
        } catch {
          // Configuration is already persisted; a disconnected session must not
          // make the host Save bar report that persistence failed.
        }
      }
      await refresh(true);
      setNotice({
        kind: reloaded || !selectedSession ? "ok" : "info",
        text: reloaded
          ? "Saved and reloaded in the selected session."
          : selectedSession
            ? "Saved. The selected session was not connected; reload it manually."
            : "Saved. New sessions will use this configuration.",
      });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Save failed" });
      throw error;
    } finally {
      setBusy(null);
    }
  }, [draft, refresh, selectedSession]);

  const reset = useCallback(() => {
    if (baseline.current) setDraft(baseline.current);
    setNotice(null);
  }, []);

  useSettingsDraftSource({
    id: "plugin:multi-account",
    isDirty: Boolean(draft && baseline.current && JSON.stringify(draft) !== JSON.stringify(baseline.current)),
    commit,
    reset,
  });

  const runAction = async (action: "next" | "rediscover" | "reload") => {
    if (!selectedSession) return;
    setBusy(action);
    setNotice(null);
    try {
      await request(`${API}/action`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: selectedSession, action }),
      });
      await new Promise((resolve) => setTimeout(resolve, 500));
      await refresh(false);
      setNotice({ kind: "ok", text: `${action === "next" ? "Switched account" : "Command sent"}.` });
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Action failed" });
    } finally {
      setBusy(null);
    }
  };

  const addAccount = async () => {
    setBusy("add");
    setNotice(null);
    try {
      const before = await request<ProviderStatus[]>("/api/provider-auth/status");
      const previous = before.find((provider) => provider.id === oauthProvider);
      const prepared = await request<{ targetProvider: string; copied: boolean }>(`${API}/accounts/prepare-login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: oauthProvider }),
      });
      await request<{ flowId: string }>("/api/provider-auth/authorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider: oauthProvider }),
      });
      setNotice({
        kind: "info",
        text: prepared.copied
          ? `Previous account preserved as ${prepared.targetProvider}. Complete login with a different account in the browser.`
          : "Complete login in the browser.",
      });

      const deadline = Date.now() + 5 * 60_000;
      while (alive.current && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const statuses = await request<ProviderStatus[]>("/api/provider-auth/status");
        const current = statuses.find((provider) => provider.id === oauthProvider);
        const changed = current?.authenticated &&
          (!previous?.authenticated || current.expires !== previous.expires);
        if (!changed) continue;
        if (selectedSession) await runAction("rediscover");
        else await refresh(false);
        setNotice({ kind: "ok", text: "Account added. Multi-account rotation was rediscovered." });
        return;
      }
      throw new Error("Login timed out. The preserved account remains available; retry when ready.");
    } catch (error) {
      setNotice({ kind: "error", text: error instanceof Error ? error.message : "Unable to add account" });
    } finally {
      setBusy(null);
    }
  };

  if (!state || !draft) return <div className="ma-loading">Loading multi-account status…</div>;

  return (
    <section className="ma-root" aria-labelledby="ma-title">
      <style>{styles}</style>
      <div className="ma-heading">
        <div>
          <h3 id="ma-title">Multi-account failover</h3>
          <p>pi-multi-account v{state.engineVersion}. Credentials remain in Pi&apos;s protected auth store.</p>
        </div>
        <span className={`ma-badge ${draft.enabled ? "is-on" : "is-off"}`}>{draft.enabled ? "Enabled" : "Disabled"}</span>
      </div>

      {notice && <div role={notice.kind === "error" ? "alert" : "status"} className={`ma-notice ${notice.kind}`}>{notice.text}</div>}

      <div className="ma-grid">
        <div className="ma-panel">
          <h4>Behavior</h4>
          <label className="ma-toggle">
            <span><strong>Automatic failover</strong><small>Move to another authenticated account after quota or transient failures.</small></span>
            <input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />
          </label>
          <label className="ma-toggle">
            <span><strong>Continue interrupted work</strong><small>Resume the task after account rotation.</small></span>
            <input type="checkbox" checked={draft.autoContinue} onChange={(event) => setDraft({ ...draft, autoContinue: event.target.checked })} />
          </label>
          <label className="ma-toggle">
            <span><strong>Show quota usage</strong><small>Fetch and display provider-reported limits.</small></span>
            <input type="checkbox" checked={draft.showUsage} onChange={(event) => setDraft({ ...draft, showUsage: event.target.checked })} />
          </label>
          <label className="ma-field">
            <span>Maximum automatic continuations</span>
            <input type="number" min={1} max={32} value={draft.maxAutoContinuesPerPrompt} onChange={(event) => setDraft({ ...draft, maxAutoContinuesPerPrompt: Number(event.target.value) })} />
          </label>
        </div>

        <div className="ma-panel">
          <h4>Session controls</h4>
          <label className="ma-field">
            <span>Target session</span>
            <select value={selectedSession} onChange={(event) => setSelectedSession(event.target.value)}>
              {activeSessions.length === 0 && <option value="">No active sessions</option>}
              {activeSessions.map((session) => <option key={session.id} value={session.id}>{sessionLabel(session)}</option>)}
            </select>
          </label>
          <div className="ma-actions">
            <button type="button" onClick={() => void runAction("next")} disabled={!selectedSession || busy !== null}>Use next account</button>
            <button type="button" onClick={() => void runAction("rediscover")} disabled={!selectedSession || busy !== null}>Rediscover</button>
            <button type="button" onClick={() => void refresh(false)} disabled={busy !== null}>Refresh status</button>
          </div>
          <hr />
          <h4>Add subscription account</h4>
          <p className="ma-help">Uses the dashboard&apos;s existing OAuth login. Sign in with a different account. The current account is copied to the next protected alias slot first.</p>
          <label className="ma-field">
            <span>Provider</span>
            <select value={oauthProvider} onChange={(event) => setOauthProvider(event.target.value as typeof oauthProvider)}>
              {OAUTH_PROVIDERS.map((provider) => <option key={provider.id} value={provider.id}>{provider.label}</option>)}
            </select>
          </label>
          <button type="button" className="ma-secondary" onClick={() => void addAccount()} disabled={busy !== null}>{busy === "add" ? "Waiting for login…" : "+ Account"}</button>
        </div>
      </div>

      <div className="ma-accounts">
        <div className="ma-section-title"><h4>Accounts</h4><span>{state.accounts.length}</span></div>
        {state.accounts.length === 0 ? (
          <p className="ma-empty">No discovered rotation accounts yet. Add an account or run Rediscover.</p>
        ) : state.accounts.map((account) => (
          <article key={account.provider} className="ma-account">
            <div className="ma-account-top">
              <div><strong>{account.account || account.provider}</strong><small>{account.provider}{account.plan ? ` · ${account.plan}` : ""}</small></div>
              <span className={`ma-state ${account.status}`}>{account.status}</span>
            </div>
            {account.status === "cooling" && <p className="ma-cooling">{formatReset(account.cooldownUntil)}</p>}
            <WindowMeter label="5-hour window" value={account.primary} />
            <WindowMeter label="Weekly window" value={account.secondary} />
          </article>
        ))}
      </div>

      {state.recentSwitches.length > 0 && (
        <div className="ma-history">
          <h4>Recent switches</h4>
          <ol>{state.recentSwitches.map((item) => <li key={`${item.at}-${item.to}`}><span>{item.from}</span><b>→</b><span>{item.to}</span><time>{new Date(item.at).toLocaleString()}</time></li>)}</ol>
        </div>
      )}
    </section>
  );
}

const styles = `
.ma-root{display:grid;gap:16px;color:var(--text-primary);font-size:13px}.ma-heading{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.ma-heading h3,.ma-panel h4,.ma-section-title h4,.ma-history h4{margin:0;font-weight:650}.ma-heading h3{font-size:16px}.ma-heading p,.ma-help,.ma-empty{margin:4px 0 0;color:var(--text-muted);line-height:1.45}.ma-badge,.ma-state{border:1px solid var(--border-secondary);border-radius:999px;padding:3px 8px;font-size:11px;text-transform:capitalize}.ma-badge.is-on,.ma-state.ready{color:var(--status-idle);background:color-mix(in srgb,var(--status-idle) 10%,transparent)}.ma-badge.is-off,.ma-state.invalid{color:var(--status-error);background:color-mix(in srgb,var(--status-error) 10%,transparent)}.ma-state.cooling{color:var(--status-working);background:color-mix(in srgb,var(--status-working) 10%,transparent)}.ma-notice{border:1px solid var(--border-primary);border-radius:8px;padding:9px 11px}.ma-notice.error{color:var(--status-error)}.ma-notice.ok{color:var(--status-idle)}.ma-notice.info{color:var(--text-secondary)}.ma-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.ma-panel,.ma-account,.ma-history{border:1px solid var(--border-primary);border-radius:10px;background:var(--bg-tertiary);padding:12px}.ma-panel{display:grid;gap:11px}.ma-toggle{display:flex;align-items:center;justify-content:space-between;gap:14px}.ma-toggle span{display:grid;gap:2px}.ma-toggle small,.ma-account small{display:block;color:var(--text-muted);font-weight:400}.ma-toggle input{width:18px;height:18px;accent-color:var(--accent-blue)}.ma-field{display:grid;gap:5px;color:var(--text-secondary)}.ma-field input,.ma-field select{min-height:36px;border:1px solid var(--border-secondary);border-radius:7px;background:var(--bg-secondary);color:var(--text-primary);padding:6px 8px}.ma-actions{display:flex;flex-wrap:wrap;gap:7px}.ma-root button{min-height:36px;border:1px solid var(--border-secondary);border-radius:7px;padding:6px 10px;background:var(--bg-secondary);color:var(--text-primary);cursor:pointer}.ma-root button:hover:not(:disabled){border-color:var(--text-muted)}.ma-root button:focus-visible,.ma-root input:focus-visible,.ma-root select:focus-visible{outline:2px solid var(--accent-blue);outline-offset:2px}.ma-root button:disabled{opacity:.5;cursor:not-allowed}.ma-secondary{justify-self:start}.ma-panel hr{width:100%;border:0;border-top:1px solid var(--border-primary);margin:2px 0}.ma-section-title{display:flex;align-items:center;gap:7px}.ma-section-title span{color:var(--text-muted)}.ma-accounts{display:grid;gap:8px}.ma-account{display:grid;gap:8px}.ma-account-top{display:flex;align-items:flex-start;justify-content:space-between;gap:10px}.ma-window{display:grid;gap:4px}.ma-window-label{display:flex;justify-content:space-between;gap:12px;color:var(--text-muted);font-size:11px}.ma-window progress{width:100%;height:7px;accent-color:var(--accent-blue)}.ma-cooling{margin:0;color:var(--status-working);font-size:12px}.ma-history ol{list-style:none;padding:0;margin:8px 0 0;display:grid;gap:6px}.ma-history li{display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr) auto;gap:7px;align-items:center;color:var(--text-secondary);font-size:11px}.ma-history time{color:var(--text-muted)}.ma-loading{color:var(--text-muted);padding:8px 0}@media(max-width:720px){.ma-grid{grid-template-columns:1fr}.ma-history li{grid-template-columns:1fr auto 1fr}.ma-history time{grid-column:1/-1}.ma-heading{align-items:center}.ma-window-label{align-items:flex-end}}
`;
