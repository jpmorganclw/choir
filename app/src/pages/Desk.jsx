// The conductor's desk: a page only the current holder of the seat can open.
//
// The page first runs the pair check (the account's own answer and the collection's answer, at
// one final block) and opens only if both name the person signed in. Every action on it is then
// enforced again by the contract. The handover notes are served by the desk server, which asks
// the chain who holds the seat on every request.

import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { ONE_YOCTO, call, cfg, deskEnter, deskOpen, deskSave, hasGate, reader, tryView, usesServer, view } from '../api.js';
import { near, percent, span, toYocto } from '../format.js';
import { isActiveConductor } from '../lib/verify.js';
import { useLoad, useSession } from '../session.jsx';
import { Do, Loading } from '../ui.jsx';

function Locked({ title, children, id }) {
  return (
    <div className="wrap">
      <div className="card locked" data-film="locked">
        <div className="lock">♪</div>
        <h2>{title}</h2>
        <div className="muted stack">{children}</div>
        <p style={{ marginTop: 20 }}>
          <Link to={`/c/${id}`} className="btn ghost">
            Back to the Choir
          </Link>
        </p>
      </div>
    </div>
  );
}

function Seat({ id, choir, frozen }) {
  const { user, act } = useSession();
  const balance = BigInt(choir.seat_balance);
  return (
    <div className="card pad" data-film="seat">
      <div className="eyebrow">The seat</div>
      <div className="big" style={{ margin: '10px 0 6px' }}>
        {near(balance, 3)}
        <small>NEAR on the seat</small>
      </div>
      <p className="muted" style={{ fontSize: 14 }}>
        Your cut is {percent(choir.rules.seat_bps)} of every tip. It gathers here and moves with the NFT. You cannot reach the members' pot or
        their earnings, and neither can anyone else.
      </p>
      <Do
        className="btn wide"
        style={{ marginTop: 14 }}
        disabled={frozen || balance <= 10n ** 21n}
        onClick={() => act(() => call(user, id, 'withdraw_seat', {}), `Paid. ${near(balance - 10n ** 21n, 3)} NEAR is in your wallet.`)}
      >
        Withdraw to my wallet
      </Do>
    </div>
  );
}

function Sale({ id, choir, listing }) {
  const { user, act, nameOf } = useSession();
  const navigate = useNavigate();
  const collection = cfg().collection;
  const [price, setPrice] = useState('12');
  const [to, setTo] = useState('');
  const yocto = toYocto(price);
  if (listing) {
    return (
      <div className="card pad">
        <div className="eyebrow">For sale</div>
        <div className="big" style={{ margin: '10px 0 6px' }}>
          {near(listing.price)}
          <small>NEAR asking price</small>
        </div>
        <p className="muted" style={{ fontSize: 14 }}>
          The seat is frozen: until it sells or you take it down, you cannot withdraw, change rules or appoint curators. That is what lets a
          buyer trust what they see. The seat held {near(listing.sealed_seat_balance, 3)} NEAR when it was listed.
        </p>
        <Do
          className="btn ghost wide"
          style={{ marginTop: 14 }}
          onClick={() => act(() => call(user, collection, 'unlist', { token_id: id }, { deposit: ONE_YOCTO }), 'The listing is down and the seat is yours to use again.')}
        >
          Take the listing down
        </Do>
      </div>
    );
  }
  return (
    <div className="card pad" data-film="pass">
      <div className="eyebrow">Pass the seat on</div>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 14px' }}>
        Whoever holds the NFT is the conductor. A handover moves the seat and its balance in one step, resets every curator, and the account
        announces it itself. Members keep everything they earned.
      </p>
      <label className="field">
        <span>Hand it to</span>
        <div className="row">
          <input className="input grow" placeholder="sam.testnet" spellCheck={false} autoComplete="off" value={to} onChange={(e) => setTo(e.target.value.trim().toLowerCase())} />
          <Do
            className="btn"
            disabled={!to || to === user}
            onClick={async () => {
              const done = await act(
                () => call(user, collection, 'nft_transfer', { receiver_id: to, token_id: id }, { deposit: ONE_YOCTO }),
                `The seat is ${nameOf(to)}'s now. This desk is theirs.`,
              );
              if (done) navigate(`/c/${id}`);
            }}
          >
            Hand over
          </Do>
        </div>
      </label>
      <hr className="divider" />
      <label className="field">
        <span>Or sell it at a fixed price</span>
        <div className="row">
          <div className="unit grow" data-unit="NEAR">
            <input className="input" inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} />
          </div>
          <Do
            className="btn gold"
            disabled={!yocto}
            onClick={() => act(() => call(user, collection, 'list', { token_id: id, price: String(yocto) }, { deposit: ONE_YOCTO }), 'Listed. The seat is frozen until it sells or you take it down.')}
          >
            List the seat
          </Do>
        </div>
        <small>Listing freezes the seat, so a buyer gets exactly what they were shown.</small>
      </label>
    </div>
  );
}

function Curators({ id, choir, frozen }) {
  const { user, act, nameOf } = useSession();
  const [account, setAccount] = useState('');
  return (
    <div className="card pad">
      <div className="eyebrow">Curators</div>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 12px' }}>
        Curators can amplify any member's post and bring members in. They cannot touch money. Every curator is reset when the seat changes
        hands.
      </p>
      {choir.curators.length === 0 ? <p className="muted" style={{ fontSize: 14 }}>No curators. You are the only one who can amplify for others.</p> : null}
      {choir.curators.map((curator) => (
        <div className="row" key={curator} style={{ justifyContent: 'space-between', padding: '6px 0' }}>
          <span>
            <b>{nameOf(curator)}</b> <span className="mono muted">@{curator}</span>
          </span>
          <Do className="btn danger small" disabled={frozen} onClick={() => act(() => call(user, id, 'set_curator', { account: curator, on: false }), `${nameOf(curator)} is no longer a curator.`)}>
            Dismiss
          </Do>
        </div>
      ))}
      <div className="row" style={{ marginTop: 12 }}>
        <input className="input grow" placeholder="leo.testnet" spellCheck={false} autoComplete="off" value={account} onChange={(e) => setAccount(e.target.value.trim().toLowerCase())} />
        <Do
          className="btn"
          disabled={frozen || !account}
          onClick={async () => {
            const done = await act(() => call(user, id, 'set_curator', { account, on: true }, { deposit: 10n ** 21n * 3n }), `${nameOf(account)} is a curator now.`);
            if (done) setAccount('');
          }}
        >
          Appoint
        </Do>
      </div>
    </div>
  );
}

const ROUNDS = [
  ['2 minutes (for a demo)', 120_000],
  ['1 hour', 3_600_000],
  ['1 day', 86_400_000],
  ['1 week', 604_800_000],
  ['30 days', 2_592_000_000],
];

function Rules({ id, choir, frozen }) {
  const { user, act } = useSession();
  const current = choir.pending_rules ?? choir.rules;
  const [open, setOpen] = useState(current.open);
  const [dues, setDues] = useState(near(current.dues, 3).replace(/,/g, ''));
  const [cap, setCap] = useState(String(current.self_cap));
  const [round, setRound] = useState(String(current.round_ms));
  const [cut, setCut] = useState(String(current.seat_bps / 100));
  const duesYocto = toYocto(dues || '0');
  const cutBps = Math.round(Number(cut) * 100);
  const valid = duesYocto !== null && Number.isInteger(cutBps) && cutBps >= 0 && cutBps <= 2000 && Number(cap) >= 0 && Number(cap) <= 50;
  const options = ROUNDS.some(([, ms]) => String(ms) === round) ? ROUNDS : [...ROUNDS, [span(Number(round)), Number(round)]];
  return (
    <div className="card pad">
      <div className="eyebrow">Rules</div>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 12px' }}>
        New rules never change a round in progress. They wait in public and take effect when the next round opens.
      </p>
      {choir.pending_rules ? <div className="notice" style={{ marginBottom: 12 }}>Changes are queued for the next round. Saving again replaces them.</div> : null}
      <div className="stack">
        <label className="field">
          <span>Who can join</span>
          <select className="input" value={open ? 'open' : 'invite'} onChange={(e) => setOpen(e.target.value === 'open')}>
            <option value="open">Anyone</option>
            <option value="invite">By invitation only</option>
          </select>
        </label>
        <div className="row">
          <label className="field grow">
            <span>Dues to join</span>
            <div className="unit" data-unit="NEAR">
              <input className="input" inputMode="decimal" value={dues} onChange={(e) => setDues(e.target.value)} />
            </div>
          </label>
          <label className="field grow">
            <span>Seat's cut of each tip</span>
            <div className="unit" data-unit="%">
              <input className="input" inputMode="decimal" value={cut} onChange={(e) => setCut(e.target.value)} />
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
              {options.map(([label, ms]) => (
                <option key={ms} value={ms}>
                  {label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <small className="muted">The cut can never be above 20%. That limit is in the contract, not in this form.</small>
        <Do
          className="btn wide"
          disabled={frozen || !valid}
          onClick={() =>
            act(
              () =>
                call(
                  user,
                  id,
                  'set_rules',
                  { rules: { open, dues: String(duesYocto), self_cap: Number(cap), round_ms: Number(round), seat_bps: cutBps } },
                  { deposit: 10n ** 21n * 3n },
                ),
              'Queued. The new rules start with the next round.',
            )
          }
        >
          Queue these rules
        </Do>
      </div>
    </div>
  );
}

function Profile({ id, choir, frozen }) {
  const { user, act } = useSession();
  const [name, setName] = useState(choir.name);
  const [about, setAbout] = useState(choir.about);
  return (
    <div className="card pad">
      <div className="eyebrow">How the account presents itself</div>
      <div className="stack" style={{ marginTop: 12 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" value={name} maxLength={64} onChange={(e) => setName(e.target.value)} />
        </label>
        <label className="field">
          <span>About</span>
          <textarea className="input" value={about} maxLength={600} onChange={(e) => setAbout(e.target.value)} />
          <small>The account adds a line of its own saying it is run by a contract and nobody holds its keys.</small>
        </label>
        <Do
          className="btn wide"
          disabled={frozen || !name.trim() || (name === choir.name && about === choir.about)}
          onClick={() => act(() => call(user, id, 'set_profile', { name: name.trim(), about }, { deposit: 10n ** 22n }), 'The profile on near.social is updated.')}
        >
          Save profile
        </Do>
      </div>
    </div>
  );
}

function Notes({ id }) {
  const { user, toast } = useSession();
  const [session, setSession] = useState(null);
  const [desk, setDesk] = useState(null);
  const [notes, setNotes] = useState('');
  const [problem, setProblem] = useState(null);

  const unlock = async () => {
    setProblem(null);
    try {
      const token = await deskEnter(user, id);
      const opened = await deskOpen(id, token);
      setSession(token);
      setDesk(opened);
      setNotes(opened.notes);
    } catch (error) {
      setProblem(error.message);
    }
  };
  // With demo accounts the server signs, so the notes can open without a wallet prompt.
  useEffect(() => {
    if (hasGate() && usesServer()) unlock();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, user]);

  if (!hasGate()) {
    return (
      <div className="card pad">
        <div className="eyebrow">Handover notes</div>
        <p className="muted" style={{ fontSize: 14, marginTop: 8 }}>
          Private notes need the desk server, which checks the chain on every request. This copy of the app is a static page with no server
          behind it, so notes are not available here. Run the project locally to use them.
        </p>
      </div>
    );
  }
  return (
    <div className="card pad">
      <div className="eyebrow">Handover notes · private to whoever holds the seat</div>
      <p className="muted" style={{ fontSize: 14, margin: '8px 0 12px' }}>
        What the next conductor needs to know. Kept by the desk server, not on chain. The server asks the chain who holds the seat each time,
        so a previous conductor's session opens nothing.
      </p>
      {problem ? <div className="notice bad" style={{ marginBottom: 12 }}>{problem}</div> : null}
      {!session ? (
        <button className="btn wide" onClick={unlock}>
          Sign to open the notes
        </button>
      ) : (
        <div className="stack">
          <textarea className="input" style={{ minHeight: 120 }} value={notes} maxLength={4000} onChange={(e) => setNotes(e.target.value)} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Holder checked at block {desk.proof.block}
            </span>
            <Do
              className="btn small"
              onClick={async () => {
                try {
                  await deskSave(id, session, notes);
                  toast('Notes saved.', 'good');
                } catch (error) {
                  setProblem(error.message);
                  setSession(null);
                }
              }}
            >
              Save notes
            </Do>
          </div>
        </div>
      )}
    </div>
  );
}

export default function Desk() {
  const { id } = useParams();
  const { user, nameOf, learn } = useSession();
  const collection = cfg().collection;
  const gate = useLoad(() => (user ? isActiveConductor(reader(), collection, id, user) : null), [id, user]);
  const inside = useLoad(
    async () => {
      const [choir, listing] = await Promise.all([view(id, 'get_choir'), tryView(collection, 'get_listing', { token_id: id })]);
      return { choir, listing };
    },
    [id],
  );
  useEffect(() => {
    if (gate.data?.owner) learn([gate.data.owner]);
    if (inside.data) learn(inside.data.choir.curators);
  }, [gate.data, inside.data, learn]);

  if (!user) {
    return (
      <Locked title="Sign in to open the desk" id={id}>
        <p>This page is only for the person who holds the conductor's seat.</p>
      </Locked>
    );
  }
  if (gate.loading && !gate.data) return <Loading what="Asking the account and the collection who holds the seat" />;
  const check = gate.data;
  if (!check || !check.ok) {
    return (
      <Locked title="This desk cannot be opened" id={id}>
        <p>
          The account and the collection do not both confirm this Choir right now
          {check?.reason ? (
            <>
              {' '}
              (<span className="mono">{check.reason}</span>)
            </>
          ) : null}
          . Until they agree, nobody is treated as the conductor.
        </p>
      </Locked>
    );
  }
  if (!check.holds) {
    return (
      <Locked title="Only the conductor can open this desk" id={id}>
        <p>
          The seat is held by <b>{nameOf(check.owner)}</b> <span className="mono">@{check.owner}</span>.
        </p>
        <p style={{ fontSize: 13.5 }}>
          Checked at final block {check.block.height}: the account and the collection both say so. You are signed in as{' '}
          <span className="mono">{user}</span>.
        </p>
      </Locked>
    );
  }
  if (!inside.data) return <Loading what="Opening the desk" />;

  const { choir, listing } = inside.data;
  const frozen = choir.status !== 'Active';
  return (
    <div className="wrap desk">
      <div className="row wrapit" style={{ justifyContent: 'space-between', marginBottom: 18 }}>
        <div>
          <div className="eyebrow">The conductor's desk</div>
          <h1 style={{ fontSize: 36, marginTop: 4 }}>{choir.name}</h1>
          <div className="muted" style={{ fontSize: 14, marginTop: 4 }}>
            Open to you because the account and the collection both name <span className="mono">{user}</span> as the holder, at final block{' '}
            {check.block.height}.
          </div>
        </div>
        <Link to={`/c/${id}`} className="btn ghost">
          Back to the Choir
        </Link>
      </div>
      {frozen ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          The seat is listed for sale, so it is frozen. You can take the listing down below. Everything else waits.
        </div>
      ) : null}
      <div className="desk-grid">
        <div className="stack-lg">
          <Seat id={id} choir={choir} frozen={frozen} />
          <Sale id={id} choir={choir} listing={listing} />
          <Notes id={id} />
        </div>
        <div className="stack-lg">
          <Curators id={id} choir={choir} frozen={frozen} />
          <Rules key={`${choir.round}-${choir.pending_rules ? 'p' : 'c'}`} id={id} choir={choir} frozen={frozen} />
          <Profile key={choir.name + choir.about} id={id} choir={choir} frozen={frozen} />
        </div>
      </div>
    </div>
  );
}
