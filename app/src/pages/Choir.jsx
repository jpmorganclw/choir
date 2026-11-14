// One Choir: what it shows on near.social, who is in it, its books, and the proof that nobody
// holds its keys. The panel on the right is where a visitor joins, amplifies, tips and claims.

import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { cfg, tryView, view } from '../api.js';
import { about, near, percent, plural, span } from '../format.js';
import { useLoad, useSession } from '../session.jsx';
import { Loading, Problem } from '../ui.jsx';
import Actions from './choir/Actions.jsx';
import { Books, Feed, Members, Proof } from './choir/Tabs.jsx';

export async function loadChoir(id, user) {
  const [choir, listing, members, me] = await Promise.all([
    view(id, 'get_choir'),
    tryView(cfg().collection, 'get_listing', { token_id: id }),
    view(id, 'get_members', { limit: 100 }),
    user ? tryView(id, 'get_member', { account: user }) : null,
  ]);
  return { choir, listing, members, me };
}

const TABS = [
  ['feed', 'On near.social'],
  ['members', 'Members'],
  ['books', 'Books'],
  ['proof', 'Proof'],
];

export default function Choir() {
  const { id } = useParams();
  const { user, learn, nameOf } = useSession();
  const [tab, setTab] = useState('feed');
  const { data, error, loading } = useLoad(() => loadChoir(id, user), [id, user]);

  useEffect(() => {
    if (data) learn([data.choir.conductor, ...data.choir.curators, ...data.members.map((m) => m.account)]);
  }, [data, learn]);

  if (error && !data) {
    return (
      <div className="wrap" style={{ padding: '60px 24px' }}>
        <Problem error={error} />
        <p style={{ marginTop: 16 }}>
          <Link to="/">Back to all Choirs</Link>
        </p>
      </div>
    );
  }
  if (loading && !data) return <Loading what="Asking the account about itself" />;

  const { choir, listing, members, me } = data;
  const isConductor = user === choir.conductor;
  const isCurator = choir.curators.includes(user);

  return (
    <>
      <section className="masthead">
        <div className="wrap">
          <div className="eyebrow" style={{ color: '#9FB0D0' }}>
            A Choir on near.social
          </div>
          <h1 style={{ marginTop: 6 }}>{choir.name}</h1>
          <div className="id mono" data-film="id">@{choir.id}</div>
          {choir.about ? <p className="about">{choir.about}</p> : null}
          <div className="chips" data-film="chips">
            <button className="chip" style={{ cursor: 'pointer' }} onClick={() => setTab('proof')} title="See the proof">
              <span className="dot" style={{ color: '#7fd59d' }} /> 0 access keys · see the proof
            </button>
            <span className="chip">Conducted by {nameOf(choir.conductor)}</span>
            <span className="chip">
              Seat's cut {percent(choir.rules.seat_bps)} · rounds of {span(choir.rules.round_ms)}
            </span>
            {listing ? <span className="chip gold">Seat for sale · {near(listing.price)} NEAR</span> : null}
            {isConductor ? (
              <Link to={`/c/${id}/desk`} className="chip gold" style={{ textDecoration: 'none' }}>
                Open your desk →
              </Link>
            ) : null}
          </div>
          <div className="statbar" data-film="stats">
            <div className="stat">
              <b>{choir.members}</b>
              <span>{choir.members === 1 ? 'member' : 'members'}, each followed by the account</span>
            </div>
            <div className="stat" data-film="pot">
              <b>
                {near(choir.pot)}
                <small>NEAR</small>
              </b>
              <span>in this round's pot</span>
            </div>
            <div className="stat">
              <b>
                {about(choir.totals.paid_members)}
                <small>NEAR</small>
              </b>
              <span>paid to members so far</span>
            </div>
            <div className="stat">
              <b>{choir.totals.amplified}</b>
              <span>{plural(choir.totals.amplified, 'post', 'posts').replace(/^\d+ /, '')} amplified</span>
            </div>
          </div>
        </div>
      </section>

      <div className="wrap cols">
        <main>
          <div className="tabs" role="tablist" data-film="tabs">
            {TABS.map(([key, label]) => (
              <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>
          {tab === 'feed' ? <Feed id={id} choir={choir} /> : null}
          {tab === 'members' ? <Members id={id} choir={choir} members={members} canCurate={isConductor || isCurator} /> : null}
          {tab === 'books' ? <Books id={id} choir={choir} /> : null}
          {tab === 'proof' ? <Proof id={id} choir={choir} /> : null}
        </main>
        <aside className="side">
          <Actions id={id} choir={choir} members={members} me={me} listing={listing} isConductor={isConductor} isCurator={isCurator} />
        </aside>
      </div>
    </>
  );
}
