// A reader over a real NEAR RPC, for the verifier in ./verify.js. It pins every read of one check
// to the same FINAL block, which is what makes the pair check mean something. Runs in the
// browser and in Node 22+ (it only needs fetch).

const encode = (args) => {
  const text = JSON.stringify(args ?? {});
  if (typeof btoa === 'function') return btoa(unescape(encodeURIComponent(text)));
  return Buffer.from(text).toString('base64');
};
const decode = (bytes) => JSON.parse(new TextDecoder().decode(new Uint8Array(bytes)));

export function rpcClient(urls) {
  const list = Array.isArray(urls) ? urls : [urls];
  return async function rpc(method, params) {
    let last;
    for (const url of list) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'choir', method, params }),
        });
        const data = await response.json();
        if (data.error) {
          const cause = data.error.cause?.name ?? '';
          const error = new Error(`${cause} ${data.error.data ?? data.error.message ?? ''}`.trim());
          error.cause = cause;
          // An answer from the chain (unknown account, method not found) is final; only transport
          // failures move on to the next endpoint.
          if (cause) throw Object.assign(error, { final: true });
          throw error;
        }
        if (data.result?.error) throw Object.assign(new Error(data.result.error), { final: true });
        return data.result;
      } catch (error) {
        last = error;
        if (error.final) throw error;
      }
    }
    throw last;
  };
}

/** `block` is what `finalBlock` returned; without it the read is of the latest final block. */
const at = (block) => (block?.hash ? { block_id: block.hash } : { finality: 'final' });

export function rpcReader(urls) {
  const rpc = rpcClient(urls);
  return {
    rpc,
    async finalBlock() {
      const block = await rpc('block', { finality: 'final' });
      return { height: block.header.height, hash: block.header.hash, timestampMs: Math.floor(Number(block.header.timestamp) / 1e6) };
    },
    async view(accountId, method, args, block) {
      const result = await rpc('query', {
        request_type: 'call_function',
        account_id: accountId,
        method_name: method,
        args_base64: encode(args),
        ...at(block),
      });
      return decode(result.result);
    },
    async keys(accountId, block) {
      const result = await rpc('query', { request_type: 'view_access_key_list', account_id: accountId, ...at(block) });
      return result.keys.length;
    },
    async hasKey(accountId, publicKey) {
      try {
        await rpc('query', { request_type: 'view_access_key', account_id: accountId, public_key: publicKey, finality: 'final' });
        return true;
      } catch {
        return false;
      }
    },
    async account(accountId, block) {
      try {
        const [account, keys] = await Promise.all([
          rpc('query', { request_type: 'view_account', account_id: accountId, ...at(block) }),
          rpc('query', { request_type: 'view_access_key_list', account_id: accountId, ...at(block) }),
        ]);
        return {
          exists: true,
          balance: account.amount,
          storageBytes: account.storage_usage,
          // An account running a global contract reports the hash it points at.
          codeHash: account.global_contract_hash ?? account.code_hash,
          global: Boolean(account.global_contract_hash),
          keys: keys.keys.length,
        };
      } catch (error) {
        if (/UNKNOWN_ACCOUNT|does not exist/i.test(`${error.cause} ${error.message}`)) return { exists: false };
        throw error;
      }
    },
  };
}
