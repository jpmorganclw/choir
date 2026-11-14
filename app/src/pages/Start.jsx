// Starting a Choir: one transaction creates the account with no keys and makes you its conductor.

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FEES, call, cfg, usesServer } from '../api.js';
import { near, toYocto } from '../format.js';
import { useSession } from '../session.jsx';
import { Do } from '../ui.jsx';

const ROUNDS = [
  ['2 minutes (for a demo)', 120_000],
  ['1 day', 86_400_000],
  ['1 week', 604_800_000],
  ['30 days', 2_592_000_000],
];

const slugify = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32);

export default function Start() {
  const { user, act, connect } = useSession();
  const navigate = useNavigate();
  const collection = cfg().collection;
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [touched, setTouched] = useState(false);
  const [about, setAbout] = useState('');
  const [open, setOpen] = useState(true);
  const [dues, setDues] = useState('0');
  const [cap, setCap] = useState('2');
  const [round, setRound] = useState('604800000');
  const [cut, setCut] = useState('10');
  const [fund, setFund] = useState('0.5');

  const handle = touched ? slug : slugify(name);
  const duesYocto = toYocto(dues || '0');
  const fundYocto = toYocto(fund);
  const cutBps = Math.round(Number(cut) * 100);
  const slugOk = /^[a-z0-9]+(-[a-z0-9]+)*$/.test(handle) && handle.length >= 2 && handle.length <= 32;
  const valid =
    name.trim().length > 0 && slugOk && duesYocto !== null && fundYocto !== null && fundYocto >= FEES.minCreate && cutBps >= 0 && cutBps <= 2000 && Number(cap) >= 0;
  const id = `${handle || 'your-name'}.${collection}`;

  return (
    <div className="wrap section" style={{ maxWidth: 780 }}>
      <div className="eyebrow">Start a Choir</div>
      <h2 style={{ fontSize: 36, marginTop: 4 }}>An account for your community that nobody holds the keys to</h2>
      <p className="muted" style={{ margin: '12px 0 24px', maxWidth: '64ch' }}>
        One transaction creates the account, gives it the shared Choir code and no access keys, and makes you its conductor. It writes its own
        profile on near.social straight away.
      </p>

      <div className="card pad stack-lg">
        <div className="stack">
          <label className="field">
            <span>Name</span>
            <input className="input" value={name} maxLength={64} placeholder="NEAR Builders" onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="field">
            <span>Account name on near.social</span>
            <input
              className="input mono"
              spellCheck={false}
              autoComplete="off"
              value={handle}
              maxLength={32}
              placeholder="near-builders"
              onChange={(e) => {
                setTouched(true);
                setSlug(e.target.value.toLowerCase());
              }}
            />
            <small>
              The account will be <span className="mono">@{id}</span>. Lowercase letters, digits and hyphens.
            </small>
          </label>
          <label className="field">
            <span>What is it for?</span>
            <textarea className="input" value={about} maxLength={600} placeholder="People who ship on NEAR. Post what you built and we will repeat it." onChange={(e) => setAbout(e.target.value)} />
          </label>
        </div>

        <div>
          <div className="eyebrow">The rules, public from the first block</div>
          <div className="stack" style={{ marginTop: 12 }}>
            <div className="row">
              <label className="field grow">
                <span>Who can join</span>
                <select className="input" value={open ? 'open' : 'invite'} onChange={(e) => setOpen(e.target.value === 'open')}>
                  <option value="open">Anyone</option>
                  <option value="invite">By invitation only</option>
                </select>
              </label>
              <label className="field grow">
                <span>Dues to join</span>
                <div className="unit" data-unit="NEAR">
                  <input className="input" inputMode="decimal" value={dues} onChange={(e) => setDues(e.target.value)} />
                </div>
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                <span>Own posts a member may amplify per round</span>
                <input className="input" inputMode="numeric" value={cap} onChange={(e) => setCap(e.target.value)} />
              </label>
              <label className="field grow">
                <span>A round lasts</span>
                <select className="input" value={round} onChange={(e) => setRound(e.target.value)}>
                  {ROUNDS.map(([label, ms]) => (
                    <option key={ms} value={ms}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="row">
              <label className="field grow">
                <span>Your cut of each tip, as conductor</span>
                <div className="unit" data-unit="%">
                  <input className="input" inputMode="decimal" value={cut} onChange={(e) => setCut(e.target.value)} />
                </div>
                <small>Never above 20%. The rest of every tip goes to the members whose posts were amplified.</small>
              </label>
              <label className="field grow">
                <span>NEAR to open the account with</span>
                <div className="unit" data-unit="NEAR">
                  <input className="input" inputMode="decimal" value={fund} onChange={(e) => setFund(e.target.value)} />
                </div>
                <small>At least {near(FEES.minCreate)}. It stays in the Choir's own account and pays for its storage.</small>
              </label>
            </div>
          </div>
        </div>

        {!user && !usesServer() ? (
          <button className="btn wide" onClick={connect}>
            Connect a wallet to start
          </button>
        ) : (
          <Do
            className="btn gold wide"
            disabled={!user || !valid}
            onClick={async () => {
              const done = await act(
                () =>
                  call(
                    user,
                    collection,
                    'create_choir',
                    {
                      slug: handle,
                      name: name.trim(),
                      about: about.trim(),
                      rules: { open, dues: String(duesYocto), self_cap: Number(cap), round_ms: Number(round), seat_bps: cutBps },
                    },
                    { deposit: fundYocto },
                  ),
                `${name.trim()} exists. You hold its seat.`,
              );
              if (done) navigate(`/c/${id}`);
            }}
          >
            Start {name.trim() || 'the Choir'}
          </Do>
        )}
      </div>
    </div>
  );
}
