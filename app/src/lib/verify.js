// The consumer side of the sharded-item draft: deciding whether an account really is a Choir of
// the collection this app is pinned to, and who holds it. No dependencies, so the app, the gate
// server and the tests all run the same code.
//
// `reader` is anything with:
//   finalBlock()                               -> { height } of a FINAL block
//   view(accountId, method, args, block)       -> the JSON a view call returns at that block
//   keys(accountId, block)                     -> number of access keys on the account

export const SPEC = 'sharded-item-1.0.0';

/** T0: free and offline. Only `collection` could have created an id that ends with its name. */
export function namespace(accountId, collection) {
  const suffix = `.${collection}`;
  const label = accountId.endsWith(suffix) ? accountId.slice(0, -suffix.length) : null;
  if (!label || label.includes('.')) return { ok: false, reason: 'outside-namespace' };
  return { ok: true, parent: collection, label };
}

const refuse = (reason, extra = {}) => ({ ok: false, reason, retryable: false, ...extra });

/**
 * T2, the pair: the account's own answer and the collection's answer, read at ONE final block.
 * `collection` must come from the caller's own configuration, never from the item.
 * Returns { ok: true, owner, status, seq, block, item, token } or { ok: false, reason, retryable }.
 */
export async function pairOnce(reader, collection, accountId) {
  const block = await reader.finalBlock();
  let item;
  try {
    item = await reader.view(accountId, 'nft_item_info', {}, block);
  } catch (error) {
    return refuse('item-unreadable', { block, detail: String(error?.message ?? error).slice(0, 200) });
  }
  if (!item || item.spec !== SPEC) return refuse('unknown-spec', { block, item });
  if (item.collection_id !== collection) return refuse('names-another-collection', { block, item });
  if (item.token_id !== accountId) return refuse('answers-for-another-token', { block, item });
  if (item.init !== true) return refuse('not-initialised', { block, item });

  const token = await reader.view(collection, 'nft_token', { token_id: item.token_id }, block);
  if (!token) return refuse('collection-denies-membership', { block, item });
  if (token.token_id !== item.token_id) return refuse('collection-answers-for-another-token', { block, item, token });

  if (token.owner_id !== item.owner_id) {
    // The item and the index update in separate receipts. The direction of the gap is the signal.
    let rotation = null;
    try {
      rotation = await reader.view(collection, 'nft_rotation', { token_id: item.token_id }, block);
    } catch {
      rotation = null;
    }
    const itemSeq = BigInt(item.rotation_seq);
    if (!rotation || rotation.rotation_epoch !== item.rotation_epoch) {
      return { ok: false, reason: 'owners-differ', retryable: true, block, item, token };
    }
    const indexSeq = BigInt(rotation.rotation_seq);
    if (itemSeq > indexSeq) return { ok: false, reason: 'index-catching-up', retryable: true, block, item, token };
    if (itemSeq < indexSeq) return refuse('index-claims-a-rotation-the-account-never-made', { block, item, token });
    return refuse('owners-differ-at-the-same-rotation', { block, item, token });
  }

  return {
    ok: true,
    owner: item.owner_id,
    status: item.status,
    seq: item.rotation_seq,
    epoch: item.rotation_epoch,
    block,
    item,
    token,
  };
}

/** T2 with the bounded retry the draft asks for when the index is only catching up. */
export async function pair(reader, collection, accountId, { tries = 4, delayMs = 700, sleep } = {}) {
  const pause = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let last;
  for (let attempt = 0; attempt < tries; attempt += 1) {
    last = await pairOnce(reader, collection, accountId);
    if (last.ok || !last.retryable) return last;
    if (attempt < tries - 1) await pause(delayMs);
  }
  return { ...last, retryable: false, reason: `${last.reason}-and-did-not-converge` };
}

/**
 * T3: the parent can only have minted legitimate ids. Step 2 (no keys) is terminal once true;
 * step 3 is tied to `config_epoch`, which a cache must store and compare.
 */
export async function provenance(reader, collection) {
  const block = await reader.finalBlock();
  const keys = await reader.keys(collection, block);
  let configEpoch = null;
  try {
    configEpoch = await reader.view(collection, 'config_epoch', {}, block);
  } catch {
    configEpoch = null;
  }
  return { ok: keys === 0 && configEpoch !== null, keys, configEpoch, sealed: keys === 0, block };
}

/** True only if `accountId` holds this Choir right now and the seat would accept its requests. */
export async function isActiveConductor(reader, collection, choirId, accountId) {
  const result = await pair(reader, collection, choirId);
  return { ...result, holds: result.ok && result.owner === accountId, active: result.ok && result.status === 'Active' };
}
