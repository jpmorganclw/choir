// Small formatting helpers. Amounts are yoctoNEAR strings or BigInts everywhere except the screen.

const YOCTO = 10n ** 24n;

/** yoctoNEAR -> "12.5", trimming to at most `digits` decimals without ever rounding up. */
export function near(yocto, digits = 2) {
  const value = BigInt(yocto ?? 0);
  const scale = 10n ** BigInt(digits);
  const scaled = (value * scale) / YOCTO;
  const whole = scaled / scale;
  const frac = (scaled % scale).toString().padStart(digits, '0').replace(/0+$/, '');
  const grouped = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac ? `${grouped}.${frac}` : grouped;
}

/** For headline totals only: rounded to the nearest hundredth, so 1.799 reads as 1.8. */
export function about(yocto) {
  return near(BigInt(yocto ?? 0) + YOCTO / 200n, 2);
}

/** "12.5" -> yoctoNEAR BigInt, or null if it is not a plain positive number. */
export function toYocto(text) {
  const clean = String(text ?? '').trim();
  if (!/^\d+(\.\d{1,24})?$/.test(clean)) return null;
  const [whole, frac = ''] = clean.split('.');
  return BigInt(whole) * YOCTO + BigInt(frac.padEnd(24, '0'));
}

/** maya.testnet -> maya ; builders.choir-hall.testnet -> builders */
export const short = (account) => String(account ?? '').split('.')[0];

export function ago(ms, now) {
  const seconds = Math.max(0, Math.floor((now - ms) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function until(ms, now) {
  const seconds = Math.floor((ms - now) / 1000);
  if (seconds <= 0) return 'now';
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 90) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.floor(hours / 24)} days`;
}

export function span(ms) {
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h`;
  const days = Math.round(hours / 24);
  return days === 7 ? '1 week' : `${days} days`;
}

export const plural = (n, one, many) => `${n} ${Number(n) === 1 ? one : many}`;
export const percent = (bps) => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 1)}%`;

/** One line of a Choir's history, in plain words. `who` turns an account into a display name. */
export function describe(event, who = short) {
  const [kind, data] = typeof event.kind === 'string' ? [event.kind, {}] : Object.entries(event.kind)[0];
  switch (kind) {
    case 'Created':
      return { icon: 'seat', text: `${who(data.conductor)} started this Choir and took the conductor's seat.` };
    case 'Joined':
      return { icon: 'member', text: `${who(data.member)} joined${BigInt(data.dues) > 0n ? ` and paid ${near(data.dues)} NEAR in dues` : ''}.` };
    case 'Admitted':
      return { icon: 'member', text: `${who(data.by)} brought ${who(data.member)} in.` };
    case 'Left':
      return { icon: 'member', text: `${who(data.member)} left.` };
    case 'Removed':
      return { icon: 'member', text: `${who(data.by)} removed ${who(data.member)}.` };
    case 'Tip':
      return {
        icon: 'in',
        amount: data.amount,
        text: `${who(data.from)} tipped ${near(data.amount)} NEAR: ${near(BigInt(data.amount) - BigInt(data.seat_cut))} to the pot, ${near(data.seat_cut)} to the seat.${data.memo ? ` “${data.memo}”` : ''}`,
      };
    case 'Swept':
      return { icon: 'in', amount: data.amount, text: `${near(data.amount)} NEAR sent by plain transfer was counted as a tip.` };
    case 'Amplified':
      return { icon: 'amp', text: data.by === data.author ? `${who(data.author)} amplified one of their posts.` : `${who(data.by)} amplified a post by ${who(data.author)}.` };
    case 'Unamplified':
      return { icon: 'amp', text: `${who(data.by)} took down a repost of ${who(data.author)}.` };
    case 'Settled':
      return { icon: 'round', text: `Round ${data.round + 1} closed: ${near(data.pot)} NEAR shared between ${plural(data.contributors, 'member', 'members')} for ${plural(data.points, 'post', 'posts')}.` };
    case 'Claimed':
      return { icon: 'out', amount: data.amount, text: `${who(data.member)} was paid ${near(data.amount, 3)} NEAR.` };
    case 'SeatWithdrawn':
      return { icon: 'out', amount: data.amount, text: `${who(data.to)} took ${near(data.amount, 3)} NEAR from the seat.` };
    case 'PayoutReturned':
      return { icon: 'in', text: `A payout of ${near(data.amount)} NEAR to ${who(data.to)} bounced and was credited back.` };
    case 'ProfileSet':
      return { icon: 'seat', text: `${who(data.by)} changed the profile.` };
    case 'RulesQueued':
      return { icon: 'seat', text: `${who(data.by)} queued new rules for the next round.` };
    case 'RulesApplied':
      return { icon: 'round', text: 'The queued rules took effect.' };
    case 'CuratorSet':
      return { icon: 'seat', text: data.on ? `${who(data.account)} was made a curator.` : `${who(data.account)} is no longer a curator.` };
    case 'Frozen':
      return { icon: 'seat', text: 'The seat was listed for sale and frozen.' };
    case 'Unfrozen':
      return { icon: 'seat', text: 'The seat was released.' };
    case 'Rotated':
      return { icon: 'seat', text: `The seat passed from ${who(data.from)} to ${who(data.to)}.` };
    default:
      return { icon: 'seat', text: kind };
  }
}
