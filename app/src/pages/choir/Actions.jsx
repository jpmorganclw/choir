// The right-hand panel of a Choir: the round, tipping, joining, amplifying and claiming.

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FEES, call, usesServer, view } from '../../api.js';
import { ago, near, percent, plural, toYocto, until } from '../../format.js';
import { useLoad, useSession } from '../../session.jsx';
import { postsOf, writePost } from '../../social.js';
import { Do } from '../../ui.jsx';

function Round({ id, choir }) {
  const { user, act, now } = useSession();
  const due = now >= choir.round_end_ms;
  return (
    <div className="card pad" data-film="round">
      <div className="eyebrow">Round {choir.round + 1}</div>
      <div className="big" style={{ marginTop: 8 }}>
        {near(choir.pot)}
        <small>NEAR in the pot</small>
      </div>
      <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
        {choir.points === 0
          ? 'No post has been amplified yet this round. A pot with nobody to share it waits for the next round.'
          : `Shared between ${plural(choir.contributors, 'member', 'members')} for ${plural(choir.points, 'amplified post', 'amplified posts')}.`}
      </p>
      <hr className="divider" />
      {due ? (
        <div className="stack">
          <div className="notice">This round is over. Anyone can close it, and the account will post the receipt itself.</div>
          <Do className="btn wide" disabled={!user} onClick={() => act(() => call(user, id, 'settle', {}), 'Round closed. Members can claim their share.')}>
            Close the round
          </Do>
        </div>
      ) : (
        <div className="row" style={{ justifyContent: 'space-between', fontSize: 14 }}>
          <span className="muted">Closes in</span>
          <b>{until(choir.round_end_ms, now)}</b>
        </div>
      )}
    </div>
  );
}

function Tip({ id, choir }) {
  const { user, act } = useSession();
  const [amount, setAmount] = useState('5');
  const [memo, setMemo] = useState('');
  const yocto = toYocto(amount);
  const valid = yocto !== null && yocto + FEES.tip >= FEES.minTip;
  const cut = valid ? (yocto * BigInt(choir.rules.seat_bps)) / 10_000n : 0n;
  const potShare = 100 - choir.rules.seat_bps / 100;
  return (
    <div className="card pad" data-film="tip">
      <h3>Tip this Choir</h3>
      <p className="hint">Your tip is split the moment it arrives. Nobody can redirect it.</p>
      <div className="stack">
        <label className="field">
          <span>Amount</span>
          <div className="unit" data-unit="NEAR">
            <input className="input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Tip amount in NEAR" />
          </div>
        </label>
        <label className="field">
          <span>Note (optional)</span>
          <input className="input" value={memo} maxLength={140} placeholder="for the guide" onChange={(e) => setMemo(e.target.value)} />
        </label>
        <div>
          <div className="split" aria-hidden="true">
            <i className="pot" style={{ width: `${potShare}%` }} />
            <i className="seat" style={{ width: `${100 - potShare}%` }} />
          </div>
          <div className="legend">
            <span>
              <b>{valid ? near(yocto - cut, 3) : '0'}</b> to the members' pot
            </span>
            <span>
              <b>{valid ? near(cut, 3) : '0'}</b> to the seat ({percent(choir.rules.seat_bps)})
            </span>
          </div>
        </div>
        <Do
          className="btn gold wide"
          disabled={!user || !valid}
          onClick={async () => {
            const done = await act(
              () => call(user, id, 'tip', memo.trim() ? { memo: memo.trim() } : {}, { deposit: yocto + FEES.tip }),
              `Tipped ${near(yocto)} NEAR. ${near(yocto - cut, 3)} went to the pot.`,
            );
            if (done) setMemo('');
          }}
        >
          Tip {valid ? near(yocto) : ''} NEAR
        </Do>
        <small className="muted" style={{ display: 'block', fontSize: 12.5 }}>
          Plus 0.005 NEAR that pays for the tip's own record on the account.
        </small>
      </div>
    </div>
  );
}

function Join({ id, choir }) {
  const { user, act, connect } = useSession();
  const dues = BigInt(choir.rules.dues);
  if (!user) {
    return (
      <div className="card pad">
        <h3>Join in</h3>
        <p className="hint">Connect a NEAR wallet to join, amplify your posts and tip.</p>
        {usesServer() ? null : (
          <button className="btn wide" onClick={connect}>
            Connect wallet
          </button>
        )}
      </div>
    );
  }
  if (!choir.rules.open) {
    return (
      <div className="card pad">
        <h3>Members are invited</h3>
        <p className="hint" style={{ marginBottom: 0 }}>
          This Choir admits members by invitation. Ask the conductor or a curator to bring you in.
        </p>
      </div>
    );
  }
  return (
    <div className="card pad">
      <h3>Join this Choir</h3>
      <p className="hint">
        The account will follow you on near.social. Then you can have your own posts repeated here and share the pot with the other members.
      </p>
      <Do
        className="btn wide"
        onClick={() => act(() => call(user, id, 'join', {}, { deposit: dues + FEES.join }), 'You are in. The account now follows you.')}
      >
        Join{dues > 0n ? ` · ${near(dues)} NEAR dues` : ''}
      </Do>
      <small className="muted" style={{ display: 'block', fontSize: 12.5, marginTop: 8 }}>
        Costs 0.01 NEAR once, for the bytes of your membership record.
      </small>
    </div>
  );
}

/** A member's own recent posts on near.social, each with whether this Choir already repeats it. */
async function loadMyPosts(id, account) {
  const posts = await postsOf(account, 6);
  const states = await Promise.all(posts.map((post) => view(id, 'amplified', { author: account, post_id: post.id }).catch(() => null)));
  return posts.map((post, i) => ({ ...post, amplified: states[i] }));
}

function PostList({ id, author, own, allowed, choir }) {
  const { user, act, now, nameOf } = useSession();
  const { data, loading } = useLoad(() => loadMyPosts(id, author), [id, author]);
  if (loading && !data) return <p className="hint">Looking for posts…</p>;
  if (!data?.length) {
    return <p className="hint" style={{ marginBottom: 0 }}>{own ? 'You have not posted on near.social yet. Write something above.' : `${nameOf(author)} has not posted yet.`}</p>;
  }
  return data.map((post) => (
    <div className="mine" key={post.id}>
      <p>{post.text}</p>
      <div className="row">
        <span>{ago(post.at, now)}</span>
        {post.amplified === true ? (
          <span className="chip good">Repeated by {choir.name}</span>
        ) : post.amplified === false ? (
          <span className="chip">Taken down</span>
        ) : (
          <Do
            className="btn small"
            disabled={!allowed}
            onClick={() =>
              act(
                () =>
                  own
                    ? call(user, id, 'amplify_own', { post_id: post.id }, { deposit: FEES.amplify })
                    : call(user, id, 'amplify', { author, post_id: post.id }, { deposit: FEES.amplify }),
                `${choir.name} now repeats that post. One more share of this round's pot.`,
              )
            }
          >
            Amplify
          </Do>
        )}
      </div>
    </div>
  ));
}

function MyPosts({ id, choir, me }) {
  const { user, act, now } = useSession();
  const [text, setText] = useState('');
  const left = Math.max(0, choir.rules.self_cap - me.self_amps);
  return (
    <div className="card pad" data-film="myposts">
      <h3>Your posts</h3>
      <p className="hint">
        {choir.rules.self_cap === 0
          ? 'In this Choir only the conductor and curators choose what is amplified.'
          : `You can amplify ${plural(left, 'more post', 'more posts')} of your own this round. Each one is a share of the pot.`}
      </p>
      <label className="field">
        <span>Write a post from your own account</span>
        <textarea className="input" value={text} maxLength={1000} placeholder="What did you ship today?" onChange={(e) => setText(e.target.value)} />
      </label>
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 8 }}>
        <Do
          className="btn ghost small"
          disabled={!text.trim()}
          onClick={async () => {
            const done = await act(async () => {
              await writePost(user, text.trim(), now);
              return null;
            }, 'Posted on near.social from your account.');
            if (done) setText('');
          }}
        >
          Post as {user.split('.')[0]}
        </Do>
      </div>
      <hr className="divider" />
      <PostList id={id} author={user} own allowed={left > 0} choir={choir} />
    </div>
  );
}

function Earnings({ id, choir, me }) {
  const { user, act } = useSession();
  const claimable = BigInt(me.claimable);
  const estimate = choir.points > 0 ? (BigInt(choir.pot) * BigInt(me.points)) / BigInt(choir.points) : 0n;
  return (
    <div className="card pad" data-film="earnings">
      <h3>Your earnings</h3>
      <div className="big" style={{ margin: '10px 0 6px' }}>
        {near(claimable, 3)}
        <small>NEAR ready to claim</small>
      </div>
      <p className="hint">
        {me.points === 0
          ? 'Nothing amplified yet this round.'
          : estimate > 0n
            ? `This round you have ${plural(me.points, 'amplified post', 'amplified posts')}. At the moment that is worth about ${near(estimate)} NEAR when the round closes.`
            : `This round you have ${plural(me.points, 'amplified post', 'amplified posts')}. The pot is empty so far; a tip would change that.`}{' '}
        All time: {near(me.earned)} NEAR.
      </p>
      <Do className="btn wide" disabled={claimable <= FEES.payout} onClick={() => act(() => call(user, id, 'claim', {}), `Paid. ${near(claimable - FEES.payout, 3)} NEAR is in your wallet.`)}>
        Claim
      </Do>
    </div>
  );
}

function Curate({ id, choir, members }) {
  const { nameOf } = useSession();
  const active = members.filter((m) => m.active);
  const [author, setAuthor] = useState(active[0]?.account ?? '');
  if (!active.length) return null;
  return (
    <div className="card pad">
      <h3>Curate</h3>
      <p className="hint">As a curator you can amplify any member's post. It counts towards their share of the pot.</p>
      <label className="field">
        <span>Member</span>
        <select className="input" value={author} onChange={(e) => setAuthor(e.target.value)}>
          {active.map((m) => (
            <option key={m.account} value={m.account}>
              {nameOf(m.account)} · {m.account}
            </option>
          ))}
        </select>
      </label>
      <div style={{ marginTop: 10 }}>{author ? <PostList id={id} author={author} own={false} allowed choir={choir} /> : null}</div>
    </div>
  );
}

export default function Actions({ id, choir, members, me, listing, isConductor, isCurator }) {
  const { user } = useSession();
  const member = me?.active;
  return (
    <div>
      {listing ? (
        <div className="card pad">
          <div className="eyebrow">Seat for sale</div>
          <p style={{ marginTop: 8, fontSize: 14.5 }}>
            The conductor's seat is listed for <b>{near(listing.price)} NEAR</b>. While it is listed the conductor cannot touch the seat. The
            community carries on as usual.
          </p>
          <Link to="/market" className="btn ghost small" style={{ marginTop: 12 }}>
            See the listing
          </Link>
        </div>
      ) : null}
      <Round id={id} choir={choir} />
      {member ? <MyPosts id={id} choir={choir} me={me} /> : null}
      {me && (member || BigInt(me.claimable) > 0n) ? <Earnings id={id} choir={choir} me={me} /> : null}
      <Tip id={id} choir={choir} />
      {member ? null : <Join id={id} choir={choir} />}
      {user && (isCurator || (isConductor && choir.status === 'Active')) ? <Curate id={id} choir={choir} members={members} /> : null}
    </div>
  );
}
