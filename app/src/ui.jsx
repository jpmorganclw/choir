// Small pieces every page uses.

import { useState } from 'react';
import { short } from './format.js';

/** Five voices of different heights over one line: the mark of the collection. */
export function Mark({ dark = false }) {
  return (
    <svg viewBox="0 0 96 96" aria-hidden="true">
      <rect width="96" height="96" rx="20" fill={dark ? '#FFF8E7' : '#14213D'} />
      <g fill="#F2C14E">
        <rect x="20" y="45" width="8" height="12" rx="4" />
        <rect x="32" y="33" width="8" height="24" rx="4" />
        <rect x="44" y="21" width="8" height="36" rx="4" />
        <rect x="56" y="37" width="8" height="20" rx="4" />
        <rect x="68" y="29" width="8" height="28" rx="4" />
      </g>
      <rect x="20" y="65" width="56" height="4" rx="2" fill={dark ? '#14213D' : '#FFF8E7'} opacity=".55" />
    </svg>
  );
}

const TINTS = ['#F2C14E', '#9FB0D0', '#E8A598', '#A8D5BA', '#D7B8E8', '#F0D9A0', '#9ED0D9'];
const tint = (account) => {
  let sum = 0;
  for (const ch of String(account)) sum = (sum * 31 + ch.charCodeAt(0)) % 9973;
  return TINTS[sum % TINTS.length];
};

export function Avatar({ account, name, small = false, choir = false }) {
  if (choir) {
    return (
      <span className={`avatar choir ${small ? 'sm' : ''}`}>
        <svg viewBox="20 18 56 42" width={small ? 14 : 18} height={small ? 14 : 18} aria-hidden="true">
          <g fill="#F2C14E">
            <rect x="20" y="45" width="8" height="12" rx="4" />
            <rect x="32" y="33" width="8" height="24" rx="4" />
            <rect x="44" y="21" width="8" height="36" rx="4" />
            <rect x="56" y="37" width="8" height="20" rx="4" />
            <rect x="68" y="29" width="8" height="28" rx="4" />
          </g>
        </svg>
      </span>
    );
  }
  const letter = (name ?? short(account)).trim().charAt(0).toUpperCase() || '?';
  return (
    <span className={`avatar ${small ? 'sm' : ''}`} style={{ background: tint(account) }}>
      {letter}
    </span>
  );
}

/** A button that shows it is working and cannot be pressed twice. */
export function Do({ onClick, children, className = 'btn', disabled = false, ...rest }) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={disabled || busy}
      onClick={async (event) => {
        event.preventDefault();
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
      {...rest}
    >
      {busy ? <span className="spin" /> : null}
      {children}
    </button>
  );
}

export function Loading({ what = 'Loading' }) {
  return (
    <div className="empty">
      <span className="spin" /> &nbsp;{what}…
    </div>
  );
}

export function Problem({ error }) {
  return <div className="notice bad">{String(error?.message ?? error)}</div>;
}
