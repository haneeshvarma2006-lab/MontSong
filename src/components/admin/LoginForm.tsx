'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

import { SpinnerIcon } from '@/components/icons';

import { AdminApiError, api } from './api';

/**
 * Sign-in.
 *
 * The failure message is whatever the server said, and the server says the same
 * thing for a wrong username, a wrong password and an unknown account — so this
 * form cannot be used to work out which one exists. A rate-limit response is
 * shown differently, because that one the owner genuinely needs to understand.
 */
export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const onSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);

    try {
      await api.post('/api/admin/auth/login', { username, password });
      router.replace('/admin');
      router.refresh();
    } catch (caught) {
      if (caught instanceof AdminApiError) {
        setError(caught.message);
      } else {
        setError('Could not reach the server. Check your connection and try again.');
      }
      setPassword('');
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="admin__auth-form" onSubmit={onSubmit} noValidate>
      {error ? (
        <p className="banner banner--error" role="alert">
          {error}
        </p>
      ) : null}

      <div className="field">
        <label className="field__label" htmlFor="username">
          Username
        </label>
        <input
          id="username"
          className="field__input"
          type="text"
          value={username}
          onChange={(event) => setUsername(event.target.value)}
          autoComplete="username"
          autoCapitalize="none"
          spellCheck={false}
          required
        />
      </div>

      <div className="field">
        <label className="field__label" htmlFor="password">
          Password
        </label>
        <input
          id="password"
          className="field__input"
          type="password"
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          autoComplete="current-password"
          required
        />
      </div>

      <button type="submit" className="btn btn--primary btn--block" disabled={pending}>
        {pending ? <SpinnerIcon size={18} /> : null}
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
