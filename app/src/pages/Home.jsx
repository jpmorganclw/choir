import { Link } from 'react-router-dom';
import { cfg, tryView, view } from '../api.js';
import { about, near, plural } from '../format.js';
import { useLoad, useSession } from '../session.jsx';
import { Loading, Problem } from '../ui.jsx';

/** Every Choir of the collection, each asked about itself. */
export async function loadChoirs() {
  const tokens = await view(cfg().collection, 'nft_tokens', { limit: 60 });
  const views = await Promise.all(tokens.map((token) => tryView(token.token_id, 'get_choir')));
  return tokens
    .map((token, i) => ({ token, choir: views[i] }))
    .filter((entry) => entry.choir)
    .sort((a, b) => Number(BigInt(b.choir.totals.received) - BigInt(a.choir.totals.received)));
}

function Voices() {
  // A row of voices of different heights, drawn once behind the headline.
  const heights = [80, 150, 230, 120, 190, 100, 260, 170, 90, 210, 140, 250];
  return (
    <svg className="voices" viewBox="0 0 520 320" preserveAspectRatio="xMaxYMax meet" aria-hidden="true">
      {heights.map((h, i) => (
        <rect key={i} x={20 + i * 41} y={300 - h} width="24" height={h} rx="12" fill="#F2C14E" opacity={0.1 + (i % 4) * 0.045} />
      ))}
    </svg>
  );
}

export function ChoirTile({ token, choir }) {
  const { nameOf } = useSession();
  return (
    <Link to={`/c/${token.token_id}`} className="card tile">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <span className="eyebrow">{plural(choir.members, 'member', 'members')}</span>
        {choir.status === 'Frozen' ? <span className="chip gold">Seat for sale</span> : null}
      </div>
      <h3 style={{ marginTop: 8 }}>{choir.name}</h3>
      <div className="mono muted" style={{ marginTop: 2 }}>
        @{token.token_id}
      </div>
      <p className="about">{choir.about}</p>
      <div className="nums">
        <div className="num">
          <b>{near(choir.pot)}</b>
          <span>NEAR in this round's pot</span>
        </div>
        <div className="num">
          <b>{about(choir.totals.paid_members)}</b>
          <span>NEAR paid to members</span>
        </div>
        <div className="num">
          <b>{choir.totals.amplified}</b>
          <span>posts amplified</span>
        </div>
      </div>
      <div className="muted" style={{ fontSize: 13, marginTop: 12 }}>
        Conducted by {nameOf(choir.conductor)}
      </div>
    </Link>
  );
}

export default function Home() {
  const { data, error, loading } = useLoad(loadChoirs);
  return (
    <>
      <section className="hero">
        <Voices />
        <div className="wrap">
          <h1>
            The community account <em>nobody</em> can speak through.
          </h1>
          <p className="lead">
            A Choir is a near.social account with no keys. It follows its members, repeats their posts, and splits every tip between the people
            it repeated. The seat that curates it is an NFT you can hand to the next person.
          </p>
          <div className="row wrapit">
            <Link to="/start" className="btn gold">
              Start a Choir
            </Link>
            <a href="#choirs" className="btn ghost">
              See the Choirs
            </a>
          </div>
        </div>
      </section>

      <div className="wrap">
        <div className="facts">
          <div className="card fact">
            <b>No password to lose</b>
            <p>The account has zero access keys. Only its contract can act for it, and anyone can check that.</p>
          </div>
          <div className="card fact">
            <b>It pays the people who post</b>
            <p>Each round, the pot is shared between the members whose posts were amplified. The seat takes a public, capped cut.</p>
          </div>
          <div className="card fact">
            <b>The seat moves, the community stays</b>
            <p>Hand over or sell the NFT and the seat changes hands in one step. Curators reset. Members keep what they earned.</p>
          </div>
        </div>

        <section className="section" id="choirs">
          <div className="head">
            <div>
              <div className="eyebrow">On {cfg().network === 'local' ? 'the practice chain' : cfg().network}</div>
              <h2>Choirs</h2>
            </div>
            <Link to="/start" className="btn ghost small">
              Start one
            </Link>
          </div>
          {error ? <Problem error={error} /> : null}
          {loading && !data ? <Loading what="Reading the collection" /> : null}
          {data && data.length === 0 ? (
            <div className="card empty">No Choirs yet. Be the first to start one.</div>
          ) : (
            <div className="grid">{(data ?? []).map((entry) => <ChoirTile key={entry.token.token_id} {...entry} />)}</div>
          )}
        </section>
      </div>
    </>
  );
}
