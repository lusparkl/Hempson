import { useCallback, useEffect, useRef, useState } from 'react';

const TOKEN_KEY = 'hepson-session';
export const token = {
  get: () => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (v: string | null) => {
    try {
      if (v) localStorage.setItem(TOKEN_KEY, v);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* storage blocked: the session lasts until reload */
    }
  },
};

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** Fired when the server says the session is gone, so the shell can show the login form. */
export const UNAUTHORIZED = 'hepson-unauthorized';

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const t = token.get();
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) {
    if (res.status === 401 && t) window.dispatchEvent(new Event(UNAUTHORIZED));
    throw new ApiError(json?.error?.code ?? 'ERROR', json?.error?.message ?? res.statusText, res.status);
  }
  return json as T;
}

/** Loads on mount and when `deps` change; optional polling. Keeps the last data while reloading. */
export function useLoad<T>(fn: () => Promise<T>, deps: unknown[], pollMs?: number) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const reload = useCallback(async () => {
    try {
      setData(await fnRef.current());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => {
    setData(null);
    void reload();
    if (!pollMs) return;
    const id = setInterval(() => void reload(), pollMs);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload, pollMs, ...deps]);
  return { data, error, reload };
}

export const money = (minor: number, currency: string) => `${(minor / 100).toFixed(2)} ${currency}`;
export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString('uk-UA') : '—');
export const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export type Role = 'owner' | 'manager';
export type Shop = { shopId: string; name: string; slug: string; role: Role; defaultCurrency: string };
