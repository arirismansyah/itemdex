// Sign in / create an account / join a household (only when the service runs with ACCOUNTS=true).

import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { setToken, signIn, signOut, useHousehold } from '../lib/api';
import { say } from '../lib/dialog';

export function AuthScreen() {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const session = await signIn(mode, Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>);
      qc.clear();
      setToken(session.token);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="app auth-screen">
      <form className="panel auth-form" onSubmit={submit}>
        <h1>ITEMDEX</h1>
        <small>{mode === 'login' ? 'SIGN IN TO YOUR DEX' : 'CREATE YOUR TRAINER ACCOUNT'}</small>
        {mode === 'register' && <label className="field"><span>NAME</span><input name="name" title="Shown to your household members" maxLength={60} autoComplete="name" /></label>}
        <label className="field"><span>EMAIL</span><input name="email" title="Your sign-in email" type="email" required autoComplete="email" /></label>
        <label className="field">
          <span>PASSWORD {mode === 'register' && <em>(8+ characters)</em>}</span>
          <input name="password" title="At least 8 characters when creating an account" type="password" required minLength={mode === 'register' ? 8 : 1} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} />
        </label>
        {mode === 'register' && (
          <label className="field"><span>INVITE CODE <em>(join a household, or leave empty to start your own)</em></span><input name="invite_code" title="Code from someone in the household you want to join" maxLength={40} /></label>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
        <button className="btn btn-primary" disabled={busy} title={mode === 'login' ? 'Sign in' : 'Create the account'}>{busy ? '...' : mode === 'login' ? '▶ SIGN IN' : '▶ CREATE ACCOUNT'}</button>
        <button type="button" className="btn btn-small" title="Switch between signing in and creating an account" onClick={() => { setError(''); setMode(mode === 'login' ? 'register' : 'login'); }}>
          {mode === 'login' ? 'NEW HERE? CREATE ACCOUNT' : 'HAVE AN ACCOUNT? SIGN IN'}
        </button>
      </form>
    </div>
  );
}

export function AccountMenu() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  return (
    <span className="account">
      <button className="icon-btn" onClick={() => setOpen((o) => !o)} title="Household" aria-label="Household" aria-expanded={open}>☺</button>
      {open && <HouseholdPanel onLogout={async () => { await signOut(); qc.clear(); setToken(''); }} />}
    </span>
  );
}

function HouseholdPanel({ onLogout }: { onLogout: () => void }) {
  const { data: h, isLoading } = useHousehold(true);
  return (
    <div className="panel account-panel">
      {isLoading || !h ? <p>...</p> : (
        <>
          <b>{h.name}</b>
          <p className="muted small">{h.members.map((m) => m.name || m.email).join(', ')}</p>
          <p className="small">INVITE CODE</p>
          <button
            className="btn btn-small"
            title="Copy the code and send it to someone so they can join this household"
            onClick={() => navigator.clipboard.writeText(h.invite_code).then(() => say('Invite code copied!', { sound: 'select' }), () => say(h.invite_code))}
          >{h.invite_code} ⧉</button>
        </>
      )}
      <button className="btn btn-small btn-danger" onClick={onLogout} title="Sign out of this browser">SIGN OUT</button>
    </div>
  );
}
