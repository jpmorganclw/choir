// The four views of a Choir: what it shows on near.social, its members, its books, and the proof.

import { useEffect } from 'react';
import { accountInfo, call, cfg, reader, view } from '../../api.js';
import { ago, describe, near, plural } from '../../format.js';
import { namespace, pair, provenance } from '../../lib/verify.js';
import { useLoad, useSession } from '../../session.jsx';
import { feedOf, followsOf, socialLink } from '../../social.js';
import { Avatar, Do, Loading, Problem } from '../../ui.jsx';

// ---------------------------------------------------------------------------------------------

export function Feed({ id, choir }) {
  const { now, nameOf } = useSession();
  const { data, error, loading } = useLoad(() => feedOf(id), [id]);
  const link = socialLink(id);
  return (
    <div className="card" data-film="feed">
      <div className="pad" data-film="feed-intro" style={{ paddingBottom: 12, borderBottom: '1px solid var(--line-2)' }}>
        <p style={{ fontSize: 14.5 }} className="muted">
          This is what <span className="mono">@{id}</span> shows on near.social. Every line was written by the account's contract: it repeats
          its members' own posts and publishes its own receipts. Nobody can type a post in its name.
          {link ? (
            <>
              {' '}
              <a href={link} target="_blank" rel="noreferrer">
                Open it on near.social
              </a>
            </>
          ) : null}
        </p>
      </div>
      {error ? (
        <div className="pad">
          <Problem error={error} />
        </div>
      ) : null}
      {loading && !data ? <Loading what="Reading near.social" /> : null}
      {data && data.length === 0 ? <div className="empty">Nothing here yet. When a member's post is amplified it appears here.</div> : null}
      {(data ?? []).map((item) =>
        item.kind === 'own' ? (
          <article className="post own" key={`own-${item.postId}`}>
            <div className="meta">
              <span className="chip dark">Posted by the account itself</span>
              <span>{ago(item.at, now)}</span>
            </div>
            <div className="who">
              <Avatar choir />
              <div>
                <b>{choir.name}</b> <span className="mono muted">@{id}</span>
              </div>
            </div>
            <p className="text">{item.text}</p>
          </article>
        ) : (
          <article className="post" key={`re-${item.author}-${item.postId}`}>
            <div className="meta">
              <span>↻ {choir.name} repeated this</span>
              <span>· {ago(item.at, now)}</span>
            </div>
            <div className="who">
              <Avatar account={item.author} name={item.name ?? nameOf(item.author)} />
              <div>
                <b>{item.name ?? nameOf(item.author)}</b> <span className="mono muted">@{item.author}</span>
              </div>
            </div>
            <p className="text">{item.text ?? <span className="muted">The original post is not visible in the data layer yet.</span>}</p>
          </article>
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

export function Members({ id, choir, members, canCurate }) {
  const { user, act, nameOf } = useSession();
  const { data: follows } = useLoad(() => followsOf(id).catch(() => null), [id]);
  const active = members.filter((m) => m.active);
  const former = members.filter((m) => !m.active && BigInt(m.claimable) > 0n);
  const rows = [...active, ...former];
  return (
    <div className="card">
      {rows.length === 0 ? (
        <div className="empty">No members yet.</div>
      ) : (
        <table className="list" data-film="members">
          <thead>
            <tr>
              <th>Member</th>
              <th className="r">This round</th>
              <th className="r">Earned</th>
              <th className="r">To claim</th>
              {canCurate ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.account}>
                <td>
                  <div className="row">
                    <Avatar account={m.account} name={nameOf(m.account)} />
                    <div>
                      <b>{nameOf(m.account)}</b>{' '}
                      {m.account === choir.conductor ? <span className="chip gold">conductor</span> : null}{' '}
                      {choir.curators.includes(m.account) ? <span className="chip">curator</span> : null}{' '}
                      {!m.active ? <span className="chip">left</span> : null}
                      <div className="mono muted">
                        @{m.account}
                        {follows?.includes(m.account) ? ' · followed by the account' : ''}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="r">{m.points ? plural(m.points, 'post', 'posts') : <span className="muted">—</span>}</td>
                <td className="r mono">{near(m.earned)}</td>
                <td className="r mono">{near(m.claimable, 3)}</td>
                {canCurate ? (
                  <td className="r">
                    {m.active && m.account !== user ? (
                      <Do className="btn danger small" onClick={() => act(() => call(user, id, 'remove_member', { account: m.account }), `${nameOf(m.account)} was removed. What they earned is still theirs.`)}>
                        Remove
                      </Do>
                    ) : null}
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

const ICONS = { in: '+', out: '−', amp: '↻', round: '◷', member: '☺', seat: '♪' };

async function loadBooks(id, total) {
  const from = Math.max(0, total - 80);
  const [events, holders] = await Promise.all([view(id, 'get_events', { from_index: from, limit: 80 }), view(id, 'get_holders')]);
  return { events: events.slice().reverse(), holders };
}

export function Books({ id, choir }) {
  const { now, nameOf, learn } = useSession();
  const { data, error, loading } = useLoad(() => loadBooks(id, choir.events), [id, choir.events]);
  useEffect(() => {
    if (data) learn(data.holders.map((h) => h.account));
  }, [data, learn]);
  const totals = choir.totals;
  return (
    <div className="stack-lg">
      <div className="card pad">
        <div className="eyebrow">Money, all time</div>
        <dl className="kv" style={{ gridTemplateColumns: '1fr auto', marginTop: 12 }}>
          <dt>Came in (tips, dues and plain transfers)</dt>
          <dd className="mono">{near(totals.received, 3)} NEAR</dd>
          <dt>Paid out to members</dt>
          <dd className="mono">{near(totals.paid_members, 3)} NEAR</dd>
          <dt>Paid out to the seat</dt>
          <dd className="mono">{near(totals.paid_seat, 3)} NEAR</dd>
          <dt>On the seat now (moves with the NFT)</dt>
          <dd className="mono">{near(choir.seat_balance, 3)} NEAR</dd>
          <dt>Owed in total right now (pot, unclaimed earnings, seat)</dt>
          <dd className="mono">{near(choir.reserved, 3)} NEAR</dd>
        </dl>
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 8 }}>
          <div className="eyebrow">Who has held the seat</div>
        </div>
        <ul className="ledger">
          {(data?.holders ?? []).map((h, i, all) => (
            <li key={h.seq}>
              <span className="ic">♪</span>
              <span>
                <b>{nameOf(h.account)}</b> <span className="mono muted">@{h.account}</span>
                {i === all.length - 1 ? <span className="chip gold" style={{ marginLeft: 8 }}>now</span> : null}
              </span>
              <time>since {new Date(h.since_ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}</time>
            </li>
          ))}
        </ul>
      </div>

      <div className="card">
        <div className="pad" style={{ paddingBottom: 8 }}>
          <div className="eyebrow">Everything that happened, newest first</div>
        </div>
        {error ? (
          <div className="pad">
            <Problem error={error} />
          </div>
        ) : null}
        {loading && !data ? <Loading what="Reading the account's history" /> : null}
        <ul className="ledger">
          {(data?.events ?? []).map((event, i) => {
            const line = describe(event, nameOf);
            return (
              <li key={`${event.at_ms}-${i}`}>
                <span className={`ic ${line.icon}`}>{ICONS[line.icon] ?? '·'}</span>
                <span>{line.text}</span>
                <time>{ago(event.at_ms, now)}</time>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------

async function loadProof(id) {
  const collection = cfg().collection;
  const [t2, t3, account, config] = await Promise.all([
    pair(reader(), collection, id),
    provenance(reader(), collection),
    accountInfo(id),
    view(collection, 'get_config'),
  ]);
  return { t0: namespace(id, collection), t2, t3, account, config };
}

function Check({ ok, title, children }) {
  return (
    <div className="check">
      <span className={`mark ${ok === false ? 'no' : ok === null ? 'wait' : ''}`}>{ok === false ? '×' : ok === null ? '…' : '✓'}</span>
      <div>
        <b>{title}</b>
        {children}
      </div>
    </div>
  );
}

export function Proof({ id, choir }) {
  const { nameOf } = useSession();
  const { data, error, loading } = useLoad(() => loadProof(id), [id]);
  const collection = cfg().collection;
  const explorer = cfg().explorer;
  if (error && !data) return <Problem error={error} />;
  if (loading && !data) return <Loading what="Checking the account against the collection" />;
  const { t0, t2, t3, account, config } = data;
  const sameCode = account.codeHash === config.item_code;
  return (
    <div className="stack-lg">
      <div className="card" data-film="proof">
        <div className="pad" style={{ paddingBottom: 10 }}>
          <div className="eyebrow">Checked just now, from your browser</div>
          <p className="muted" style={{ fontSize: 14.5, marginTop: 6 }}>
            These are read from the chain each time you open this tab. They are the same checks this app runs before it treats anyone as the
            conductor.
          </p>
        </div>
        <Check ok={account.keys === 0} title={`This account has ${plural(account.keys, 'access key', 'access keys')}`}>
          <p>With no key, nobody can sign a transaction as <code>{id}</code>. Not the conductor, not the person who started it. Only its contract can act.</p>
        </Check>
        <Check ok={sameCode} title="It runs the published Choir code, by hash">
          <p>
            Code <code>{account.codeHash}</code>
            {sameCode ? ' matches the hash the collection mints with. It is referenced by hash, so it cannot be swapped for other code.' : ` does not match the collection's ${config.item_code}.`}
          </p>
        </Check>
        <Check ok title="Nobody can post in its name">
          <p>The code has no method that takes text and posts it. The account only repeats members' own posts and publishes receipts it composes itself.</p>
        </Check>
        <Check ok={t0.ok} title="Its name could only have been made by the collection">
          <p>
            Only <code>{collection}</code> can create an account ending in <code>.{collection}</code>. That is a rule of NEAR itself.
          </p>
        </Check>
        <Check ok={t2.ok} title={t2.ok ? `The account and the collection agree: ${nameOf(t2.owner)} holds the seat` : 'The account and the collection do not agree'}>
          {t2.ok ? (
            <dl className="kv">
              <dt>The account says</dt>
              <dd>
                owner <code>{t2.item.owner_id}</code>, rotation <code>{t2.item.rotation_seq}</code>, status <code>{t2.item.status}</code>
              </dd>
              <dt>The collection says</dt>
              <dd>
                owner <code>{t2.token.owner_id}</code> for token <code>{t2.token.token_id}</code>
              </dd>
              <dt>Both read at</dt>
              <dd>
                final block <code>{t2.block.height}</code>
              </dd>
            </dl>
          ) : (
            <p>
              Refused: <code>{t2.reason}</code>. Until the two agree, this app treats nobody as the conductor.
            </p>
          )}
        </Check>
        <Check ok={t3.sealed} title={t3.sealed ? 'The collection has no access keys either' : `The collection still has ${plural(t3.keys, 'access key', 'access keys')}`}>
          <p>
            {t3.sealed
              ? 'So only its code can create Choirs or move a seat. It has no owner, no admin method and no upgrade method.'
              : 'Whoever holds that key could replace the collection. On a finished deployment this must be zero.'}{' '}
            Configuration counter: <code>{String(t3.configEpoch)}</code>.
          </p>
        </Check>
        <Check ok={choir.status === 'Active' ? true : null} title={choir.status === 'Active' ? 'The seat is active' : `The seat is ${choir.status.toLowerCase()}`}>
          <p>
            {choir.status === 'Active'
              ? 'The conductor can use their powers right now.'
              : 'It is listed for sale or being handed over, so conductor actions wait. An account can be authentic and still not accept requests.'}
          </p>
        </Check>
      </div>
      {explorer ? (
        <p className="muted" style={{ fontSize: 14 }}>
          Check it yourself:{' '}
          <a href={`${explorer}/address/${id}`} target="_blank" rel="noreferrer">
            the account
          </a>{' '}
          ·{' '}
          <a href={`${explorer}/address/${collection}`} target="_blank" rel="noreferrer">
            the collection
          </a>
        </p>
      ) : null}
    </div>
  );
}
