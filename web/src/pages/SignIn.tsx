import { useState } from "react";
import type { AccountDto } from "../../../shared/types";
import { api } from "../api";

/** The only screen before signing in. On a new server it creates the owner account instead. */
export function SignInPage({ setup, onSignedIn }: { setup: boolean; onSignedIn: (a: AccountDto) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setError(null);
    if (setup && password !== repeat) return setError("The two passwords are not the same.");
    setBusy(true);
    try {
      const r = setup ? await api.setup(username, password) : await api.login(username, password);
      onSignedIn(r.account);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page narrow signin">
      <h2>{setup ? "Create the owner account" : "Welcome back"}</h2>
      {!setup && <p className="muted">Sign in to open your library.</p>}
      {setup && (
        <p className="muted small">
          This server has no accounts yet. The first account is the owner: it can add other people, each with their own private library. If this computer already had a library, it becomes yours.
        </p>
      )}
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <label className="field">
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoFocus required />
        </label>
        <label className="field">
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete={setup ? "new-password" : "current-password"}
            required
          />
        </label>
        {setup && (
          <label className="field">
            Password again
            <input type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} autoComplete="new-password" required />
          </label>
        )}
        {setup && <p className="muted small">At least 10 characters.</p>}
        {error && <p className="warn small">{error}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {setup ? "Create account" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
