// What every page shares: who is acting, what time the chain thinks it is, and a way to tell the
// person what just happened.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { cfg, connectWallet, disconnectWallet, explain, isLocal, nowMs, onWalletChange, restoreWallet, usesServer } from './api.js';
import { names } from './social.js';

const Session = createContext(null);
export const useSession = () => useContext(Session);

export function SessionProvider({ children }) {
  const config = cfg();
  const [user, setUserState] = useState(() => {
    if (!usesServer()) return null;
    const saved = sessionStorage.getItem('choir-persona');
    return config.personas.some((p) => p.id === saved) ? saved : (config.personas[0]?.id ?? null);
  });
  const [now, setNow] = useState(Date.now());
  const [version, setVersion] = useState(0);
  const [toasts, setToasts] = useState([]);
  const [labels, setLabels] = useState({});
  const nextToast = useRef(1);

  const setUser = useCallback((id) => {
    setUserState(id);
    if (usesServer() && id) sessionStorage.setItem('choir-persona', id);
  }, []);

  // A real wallet: pick up an existing sign-in, and follow sign-in and sign-out.
  useEffect(() => {
    if (usesServer()) return undefined;
    restoreWallet().then((id) => id && setUserState(id));
    return onWalletChange((id) => setUserState(id));
  }, []);

  /** Re-reads everything on screen. Call after anything that changes the chain. */
  const refresh = useCallback(() => setVersion((v) => v + 1), []);

  // The clock. On the practice chain time only moves when someone skips it, so ask the chain.
  useEffect(() => {
    let live = true;
    const tick = () => nowMs().then((ms) => live && setNow(ms)).catch(() => {});
    tick();
    const timer = setInterval(tick, isLocal() ? 4000 : 1000);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [version]);

  // On a live network other people act too, so look again every few seconds.
  useEffect(() => {
    if (isLocal()) return undefined;
    const timer = setInterval(refresh, 9000);
    return () => clearInterval(timer);
  }, [refresh]);

  const toast = useCallback((text, tone = 'plain', hash = null) => {
    const id = nextToast.current++;
    setToasts((list) => [...list, { id, text, tone, hash }]);
    setTimeout(() => setToasts((list) => list.filter((t) => t.id !== id)), tone === 'bad' ? 7000 : 4200);
  }, []);

  /**
   * Runs one action against the chain and reports it. `work` returns a call result (or throws);
   * `done` is the sentence shown when it went through. Answers true on success.
   */
  const act = useCallback(
    async (work, done) => {
      try {
        const result = await work();
        const problem = result && typeof result === 'object' && 'ok' in result ? explain(result) : null;
        if (problem) {
          toast(problem, 'bad');
          refresh();
          return false;
        }
        if (done) toast(done, 'good', result?.hash ?? null);
        refresh();
        return true;
      } catch (error) {
        toast(String(error?.message ?? error), 'bad');
        refresh();
        return false;
      }
    },
    [toast, refresh],
  );

  /** Display names for accounts, learned from near.social profiles as pages ask for them. */
  const learn = useCallback((accounts) => {
    const wanted = accounts.filter(Boolean);
    if (!wanted.length) return;
    names(wanted).then((found) => setLabels((old) => ({ ...old, ...found }))).catch(() => {});
  }, []);
  const personaNames = useMemo(() => Object.fromEntries((config.personas ?? []).map((p) => [p.id, p.name])), [config]);
  const nameOf = useCallback((account) => labels[account] ?? personaNames[account] ?? String(account ?? '').split('.')[0], [labels, personaNames]);

  const value = {
    config,
    user,
    setUser,
    now,
    version,
    refresh,
    toast,
    act,
    learn,
    nameOf,
    connect: async () => {
      try {
        const id = await connectWallet();
        if (id) setUserState(id);
      } catch (error) {
        toast(String(error?.message ?? error), 'bad');
      }
    },
    disconnect: async () => {
      await disconnectWallet();
      setUserState(null);
    },
  };

  return (
    <Session.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone}`}>
            {t.text}
            {t.hash && config.explorer ? (
              <>
                {' '}
                <a href={`${config.explorer}/txns/${t.hash}`} target="_blank" rel="noreferrer" data-film="tx">
                  See the transaction
                </a>
              </>
            ) : null}
          </div>
        ))}
      </div>
    </Session.Provider>
  );
}

/** Loads something from the chain and reloads it whenever the session says things changed. */
export function useLoad(loader, deps = []) {
  const { version } = useSession();
  const [state, setState] = useState({ data: undefined, error: null, loading: true });
  useEffect(() => {
    let live = true;
    Promise.resolve()
      .then(loader)
      .then((data) => live && setState({ data, error: null, loading: false }))
      .catch((error) => live && setState((old) => ({ data: old.data, error, loading: false })));
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version, ...deps]);
  return state;
}
