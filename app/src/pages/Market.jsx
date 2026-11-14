// Seats for sale. A listed seat is frozen on its own account, and the purchase carries what the
// buyer was shown: the account refuses the handover if anything is less than that.

import { useEffect } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { call, cfg, tryView, view } from '../api.js';
import { ago, near, percent, plural } from '../format.js';
import { useLoad, useSession } from '../session.jsx';
import { Do, Loading, Problem } from '../ui.jsx';

async function loadListings() {
  const listings = await view(cfg().collection, 'get_listings', { limit: 50 });
  const choirs = await Promise.all(listings.map((listing) => tryView(listing.token_id, 'get_choir')));
  return listings.map((listing, i) => ({ listing, choir: choirs[i] })).filter((entry) => entry.choir);
}

function Listing({ listing, choir }) {
  const { user, act, now, nameOf } = useSession();
  const navigate = useNavigate();
  const mine = user === listing.seller;
  return (
    <div className="card pad">
      <div className="row wrapit" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="eyebrow">The conductor's seat of</div>
          <h3 style={{ fontSize: 26, marginTop: 4 }}>
            <Link to={`/c/${listing.token_id}`} style={{ textDecoration: 'none' }}>
              {choir.name}
            </Link>
          </h3>
          <div className="mono muted">@{listing.token_id}</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="big">
            {near(listing.price)}
            <small>NEAR</small>
          </div>
          <div className="muted" style={{ fontSize: 13 }}>
            listed {ago(listing.listed_ms, now)} by {nameOf(listing.seller)}
          </div>
        </div>
      </div>

      <div className="nums" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <div className="num">
          <b>{near(choir.seat_balance, 3)}</b>
          <span>NEAR on the seat, yours on purchase</span>
        </div>
        <div className="num">
          <b>{percent(choir.rules.seat_bps)}</b>
          <span>of every future tip</span>
        </div>
        <div className="num">
          <b>{choir.members}</b>
          <span>{plural(choir.members, 'member', 'members').replace(/^\d+ /, '')}</span>
        </div>
        <div className="num">
          <b>{near(choir.totals.received)}</b>
          <span>NEAR received all time</span>
        </div>
      </div>

      <div className="notice good" style={{ marginTop: 16 }}>
        Frozen since it was listed: the seller cannot withdraw, change the rules or appoint curators. Your purchase says "the seat holds at
        least {near(choir.seat_balance, 3)} NEAR". If it holds less when your payment arrives, the account refuses and you get everything back.
      </div>

      <div className="row" style={{ marginTop: 16, justifyContent: 'flex-end' }}>
        <Link to={`/c/${listing.token_id}`} className="btn ghost">
          Look at the Choir
        </Link>
        {mine ? (
          <Link to={`/c/${listing.token_id}/desk`} className="btn">
            Manage at your desk
          </Link>
        ) : (
          <Do
            className="btn gold"
            disabled={!user}
            onClick={async () => {
              const done = await act(
                () =>
                  call(
                    user,
                    cfg().collection,
                    'buy',
                    { token_id: listing.token_id, expect_seq: listing.rotation_seq, min_seat_balance: choir.seat_balance },
                    { deposit: listing.price },
                  ),
                `The seat is yours. You are the conductor of ${choir.name}.`,
              );
              if (done) navigate(`/c/${listing.token_id}/desk`);
            }}
          >
            Buy the seat for {near(listing.price)} NEAR
          </Do>
        )}
      </div>
    </div>
  );
}

export default function Market() {
  const { learn } = useSession();
  const { data, error, loading } = useLoad(loadListings);
  useEffect(() => {
    if (data) learn(data.map((entry) => entry.listing.seller));
  }, [data, learn]);
  return (
    <div className="wrap section">
      <div className="head">
        <div>
          <div className="eyebrow">The market</div>
          <h2>Seats for sale</h2>
        </div>
      </div>
      <p className="muted" style={{ maxWidth: '68ch', marginBottom: 22 }}>
        Buying a seat makes you the conductor: you choose curators, set the rules from the next round and earn the seat's cut. You do not buy
        the members' money. The pot and everything members have earned stay theirs.
      </p>
      {error ? <Problem error={error} /> : null}
      {loading && !data ? <Loading what="Reading the listings" /> : null}
      {data && data.length === 0 ? <div className="card empty">No seat is for sale right now.</div> : null}
      <div className="stack-lg">{(data ?? []).map((entry) => <Listing key={entry.listing.token_id} {...entry} />)}</div>
    </div>
  );
}
