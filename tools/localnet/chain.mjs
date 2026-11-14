// A small NEAR-compatible host that runs compiled contracts in Node, with no neard.
//
// It keeps a FastData index: every `__fastdata_kv` function call is recorded with its
// predecessor and receiver whether or not the receipt succeeds, which is how the real FastData
// indexer treats writes to near.social.
//
// What it models: registers, storage, promises and callbacks, receipts that run one at a time
// (and can be stepped, to interleave transactions), failed receipts refunding their deposit, batch
// actions that roll back together, storage staking, access keys, global contracts, and a check
// that gas handed to child calls fits the gas attached.
//
// What it does not model: gas burnt by execution, shards or block-level timing.

import { createHash } from 'node:crypto';

const enc = new TextEncoder();
const dec = new TextDecoder();
const U64_MAX = (1n << 64n) - 1n;

export const STORAGE_BYTE_COST = 10_000_000_000_000_000_000n;
export const YOCTO = 10n ** 24n;
export const TGAS = 10n ** 12n;
export const near = (n) => (BigInt(Math.round(Number(n) * 1e6)) * YOCTO) / 1_000_000n;
export const toNear = (y) => Number(BigInt(y) / 10n ** 18n) / 1e6;

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function base58encode(bytes) {
  let n = 0n;
  for (const b of bytes) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

export class Panic extends Error {}

const hex = (u8) => Buffer.from(u8).toString('hex');
const toBytes = (value) => {
  if (value === undefined) return new Uint8Array();
  if (value instanceof Uint8Array) return value;
  return enc.encode(JSON.stringify(value));
};

/** One run of a contract method: its registers, its storage overlay and the promises it creates. */
class Execution {
  constructor(chain, account, ctx) {
    this.chain = chain;
    this.account = account;
    this.ctx = ctx;
    this.registers = new Map();
    this.storage = new Map(account.storage);
    this.balance = account.balance;
    this.promises = [];
    this.logs = [];
    this.returned = undefined;
    this.returnPromise = null;
    this.memory = null;
    this.gasForChildren = 0n;
  }

  mem() {
    return new Uint8Array(this.memory.buffer);
  }

  read(len, ptr) {
    const start = Number(ptr);
    return this.mem().slice(start, start + Number(len));
  }

  text(len, ptr) {
    return dec.decode(this.read(len, ptr));
  }

  /** The guest passes either a plain string or a register holding one. */
  readString(len, ptr) {
    if (len === U64_MAX) return dec.decode(this.registers.get(ptr));
    return this.text(len, ptr);
  }

  writeU128(ptr, value) {
    const view = new DataView(this.memory.buffer, Number(ptr), 16);
    view.setBigUint64(0, value & U64_MAX, true);
    view.setBigUint64(8, value >> 64n, true);
  }

  readU128(ptr) {
    const view = new DataView(this.memory.buffer, Number(ptr), 16);
    return view.getBigUint64(0, true) + (view.getBigUint64(8, true) << 64n);
  }

  storageUsage() {
    let bytes = 100 + this.account.codeBytes;
    for (const [k, v] of this.storage) bytes += k.length / 2 + v.length + 40;
    return bytes;
  }

  promise(index) {
    const p = this.promises[Number(index)];
    if (!p) throw new Panic(`invalid promise index ${index}`);
    return p;
  }

  charge(amount) {
    if (amount > this.balance) {
      throw new Panic(`BalanceExceeded: ${this.account.id} has ${this.balance}, needs ${amount}`);
    }
    this.balance -= amount;
  }

  attachGas(gas) {
    this.gasForChildren += gas;
    const limit = this.ctx.gas ?? 300n * TGAS;
    if (this.gasForChildren > limit) {
      throw new Panic(`Exceeded the prepaid gas: children need ${this.gasForChildren}, had ${limit}`);
    }
  }

  imports() {
    const self = this;
    const view = !!this.ctx.view;
    const refuseInView = (name) => {
      if (view) throw new Panic(`ProhibitedInView: ${name}`);
    };
    const impl = {
      read_register(id, ptr) {
        const reg = self.registers.get(id);
        if (!reg) throw new Panic(`InvalidRegisterId ${id}`);
        self.mem().set(reg, Number(ptr));
      },
      register_len(id) {
        const reg = self.registers.get(id);
        return reg ? BigInt(reg.length) : U64_MAX;
      },
      input(id) {
        self.registers.set(id, self.ctx.input);
      },
      current_account_id(id) {
        self.registers.set(id, enc.encode(self.account.id));
      },
      predecessor_account_id(id) {
        refuseInView('predecessor_account_id');
        self.registers.set(id, enc.encode(self.ctx.predecessor));
      },
      signer_account_id(id) {
        refuseInView('signer_account_id');
        self.registers.set(id, enc.encode(self.ctx.signer));
      },
      block_timestamp: () => self.chain.now,
      block_index: () => self.chain.height,
      epoch_height: () => self.chain.epoch,
      storage_usage: () => BigInt(self.storageUsage()),
      account_balance: (ptr) => self.writeU128(ptr, self.balance),
      account_locked_balance: (ptr) => self.writeU128(ptr, self.account.locked ?? 0n),
      attached_deposit: (ptr) => self.writeU128(ptr, view ? 0n : self.ctx.deposit),
      prepaid_gas: () => (view ? 0n : (self.ctx.gas ?? 300n * TGAS)),
      used_gas: () => 0n,
      validator_stake(_len, _ptr, stakePtr) {
        self.writeU128(stakePtr, 0n);
      },
      validator_total_stake(stakePtr) {
        self.writeU128(stakePtr, 0n);
      },
      sha256(len, ptr, id) {
        self.registers.set(id, createHash('sha256').update(self.read(len, ptr)).digest());
      },
      value_return(len, ptr) {
        self.returned = self.read(len, ptr);
      },
      panic() {
        throw new Panic('explicit guest panic');
      },
      panic_utf8(len, ptr) {
        throw new Panic(self.readString(len, ptr));
      },
      log_utf8(len, ptr) {
        self.logs.push(self.readString(len, ptr));
      },
      storage_write(klen, kptr, vlen, vptr, id) {
        refuseInView('storage_write');
        const key = hex(self.read(klen, kptr));
        const old = self.storage.get(key);
        self.storage.set(key, self.read(vlen, vptr));
        if (old) self.registers.set(id, old);
        return old ? 1n : 0n;
      },
      storage_read(klen, kptr, id) {
        const value = self.storage.get(hex(self.read(klen, kptr)));
        if (!value) return 0n;
        self.registers.set(id, value);
        return 1n;
      },
      storage_remove(klen, kptr, id) {
        refuseInView('storage_remove');
        const key = hex(self.read(klen, kptr));
        const old = self.storage.get(key);
        if (!old) return 0n;
        self.storage.delete(key);
        self.registers.set(id, old);
        return 1n;
      },
      storage_has_key(klen, kptr) {
        return self.storage.has(hex(self.read(klen, kptr))) ? 1n : 0n;
      },
      promise_batch_create(len, ptr) {
        refuseInView('promise_batch_create');
        self.promises.push({ receiver: self.text(len, ptr), actions: [], after: [] });
        return BigInt(self.promises.length - 1);
      },
      promise_batch_then(index, len, ptr) {
        refuseInView('promise_batch_then');
        self.promise(index);
        self.promises.push({ receiver: self.text(len, ptr), actions: [], after: [Number(index)] });
        return BigInt(self.promises.length - 1);
      },
      promise_create(alen, aptr, mlen, mptr, arglen, argptr, amountPtr, gas) {
        const index = impl.promise_batch_create(alen, aptr);
        impl.promise_batch_action_function_call(index, mlen, mptr, arglen, argptr, amountPtr, gas);
        return index;
      },
      promise_then(prev, alen, aptr, mlen, mptr, arglen, argptr, amountPtr, gas) {
        const index = impl.promise_batch_then(prev, alen, aptr);
        impl.promise_batch_action_function_call(index, mlen, mptr, arglen, argptr, amountPtr, gas);
        return index;
      },
      promise_and(ptr, count) {
        const view64 = new DataView(self.memory.buffer, Number(ptr), Number(count) * 8);
        const after = [];
        for (let i = 0; i < Number(count); i++) after.push(Number(view64.getBigUint64(i * 8, true)));
        self.promises.push({ receiver: null, actions: [], after, joint: true });
        return BigInt(self.promises.length - 1);
      },
      promise_return(index) {
        self.promise(index);
        self.returnPromise = Number(index);
      },
      promise_results_count: () => BigInt(self.ctx.results?.length ?? 0),
      promise_result(index, id) {
        const result = self.ctx.results?.[Number(index)];
        if (!result) throw new Panic(`InvalidPromiseResultIndex ${index}`);
        if (result.ok) {
          self.registers.set(id, result.value);
          return 1n;
        }
        return 2n;
      },
      promise_batch_action_create_account(index) {
        self.promise(index).actions.push({ type: 'create' });
      },
      promise_batch_action_transfer(index, amountPtr) {
        const amount = self.readU128(amountPtr);
        self.charge(amount);
        self.promise(index).actions.push({ type: 'transfer', amount });
      },
      promise_batch_action_stake(index, amountPtr) {
        self.promise(index).actions.push({ type: 'stake', amount: self.readU128(amountPtr) });
      },
      promise_batch_action_use_global_contract(index, len, ptr) {
        self.promise(index).actions.push({ type: 'use_global', hash: hex(self.read(len, ptr)) });
      },
      promise_batch_action_function_call(index, mlen, mptr, alen, aptr, amountPtr, gas) {
        const amount = self.readU128(amountPtr);
        self.charge(amount);
        self.attachGas(gas);
        self.promise(index).actions.push({
          type: 'call',
          method: self.text(mlen, mptr),
          args: self.read(alen, aptr),
          deposit: amount,
          gas,
        });
      },
      promise_batch_action_function_call_weight(i, ml, mp, al, ap, amountPtr, gas) {
        impl.promise_batch_action_function_call(i, ml, mp, al, ap, amountPtr, gas);
      },
    };
    const env = new Proxy(impl, {
      get(target, name) {
        return (
          target[name] ??
          (() => {
            throw new Panic(`host function not implemented: ${String(name)}`);
          })
        );
      },
    });
    return { env };
  }

  run(method) {
    const module = this.account.code;
    if (!module) throw new Panic(`CodeDoesNotExist: ${this.account.id}`);
    const instance = new WebAssembly.Instance(module, this.imports());
    this.memory = instance.exports.memory;
    const fn = instance.exports[method];
    if (!fn) throw new Panic(`MethodNotFound: ${method}`);
    try {
      fn();
    } catch (err) {
      if (err instanceof Panic) throw err;
      throw new Panic(`wasm trap in ${this.account.id}.${method}: ${err.message}`);
    }
  }
}

export class Chain {
  constructor({ now = 1_800_000_000_000_000_000n } = {}) {
    this.accounts = new Map();
    this.globals = new Map();
    this.now = now;
    this.height = 1_000n;
    this.epoch = 100n;
    this.fastdata = [];
    this.queue = [];
    this.nextReceipt = 1;
    this.txCounter = 0;
    this.current = null;
  }

  // ---- setup ----

  account(id, balance = near(100), { keys = 1 } = {}) {
    if (this.accounts.has(id)) throw new Error(`account exists: ${id}`);
    const acct = { id, balance, locked: 0n, pendingStake: null, storage: new Map(), code: null, codeBytes: 0, mock: null, keys, codeHash: null };
    this.accounts.set(id, acct);
    return acct;
  }

  get(id) {
    return this.accounts.get(id);
  }

  exists(id) {
    return this.accounts.has(id);
  }

  balance(id) {
    return this.accounts.get(id)?.balance ?? 0n;
  }

  keys(id) {
    return this.accounts.get(id)?.keys ?? 0;
  }

  deploy(id, wasm) {
    const acct = this.accounts.get(id) ?? this.account(id, near(1000));
    acct.code = new WebAssembly.Module(wasm);
    acct.codeBytes = wasm.length;
    acct.codeHash = base58encode(createHash('sha256').update(wasm).digest());
    acct.mock = null;
  }

  publishGlobal(wasm) {
    const hash = createHash('sha256').update(wasm).digest();
    this.globals.set(hash.toString('hex'), new WebAssembly.Module(wasm));
    return base58encode(hash);
  }

  /** A contract written in JS, for failure injection and hostile callers. */
  mock(id, handler, { balance = near(0) } = {}) {
    const acct = this.accounts.get(id) ?? this.account(id, balance);
    acct.mock = handler;
    return acct;
  }

  advance(ns) {
    this.now += BigInt(ns);
    this.height += 1n;
  }

  /** Moves to the next epoch: stake reductions take effect and validators receive their reward. */
  advanceEpoch(rewards = {}) {
    this.epoch += 1n;
    this.height += 43_200n;
    this.now += 7n * 3_600n * 1_000_000_000n;
    for (const acct of this.accounts.values()) {
      if (acct.pendingStake !== null) {
        acct.balance += acct.locked - acct.pendingStake;
        acct.locked = acct.pendingStake;
        acct.pendingStake = null;
      }
    }
    for (const [id, amount] of Object.entries(rewards)) this.accounts.get(id).locked += amount;
  }

  // ---- reading ----

  view(account, method, args = {}) {
    const acct = this.accounts.get(account);
    if (!acct) throw new Panic(`AccountDoesNotExist: ${account}`);
    if (acct.mock) {
      return acct.mock({ method, args, view: true, predecessor: '', signer: '', deposit: 0n, chain: this, self: acct });
    }
    const exec = new Execution(this, acct, { input: toBytes(args), view: true });
    exec.run(method);
    return exec.returned?.length ? JSON.parse(dec.decode(exec.returned)) : undefined;
  }

  // ---- writing ----

  /** Queues a transaction without running it. Pair with `step` to interleave transactions. */
  submit(signer, receiver, method, args = {}, { deposit = 0n, gas = 300n * TGAS } = {}) {
    const from = this.accounts.get(signer);
    if (!from) throw new Panic(`signer does not exist: ${signer}`);
    if (from.keys === 0) throw new Panic(`InvalidAccessKey: ${signer} has no access keys, so nobody can sign as it`);
    if (deposit > from.balance) throw new Panic(`NotEnoughBalance: ${signer}`);
    from.balance -= deposit;
    const tx = { id: ++this.txCounter, logs: [], failures: [], social: [], signer };
    tx.root = this.receipt({
      predecessor: signer,
      signer,
      receiver,
      actions: [{ type: 'call', method, args: toBytes(args), deposit, gas }],
      tx,
    });
    this.queue.push(tx.root);
    return tx;
  }

  /** Sends a transaction and runs receipts until nothing can run. */
  call(signer, receiver, method, args = {}, options = {}) {
    const tx = this.submit(signer, receiver, method, args, options);
    this.drain();
    return this.summary(tx);
  }

  /** Plain NEAR transfer from a signer. */
  send(signer, receiver, amount) {
    const from = this.accounts.get(signer);
    if (!from) throw new Panic(`signer does not exist: ${signer}`);
    if (from.keys === 0) throw new Panic(`InvalidAccessKey: ${signer} has no access keys, so nobody can sign as it`);
    if (amount > from.balance) throw new Panic(`NotEnoughBalance: ${signer}`);
    from.balance -= amount;
    const tx = { id: ++this.txCounter, logs: [], failures: [], social: [], signer };
    tx.root = this.receipt({ predecessor: signer, signer, receiver, actions: [{ type: 'transfer', amount }], tx });
    this.queue.push(tx.root);
    this.drain();
    return this.summary(tx);
  }

  /** A transaction that creates an account, as a signer would send it. */
  createAccount(signer, newId, amount = 0n) {
    const from = this.accounts.get(signer);
    if (!from) throw new Panic(`signer does not exist: ${signer}`);
    if (from.keys === 0) throw new Panic(`InvalidAccessKey: ${signer} has no access keys, so nobody can sign as it`);
    from.balance -= amount;
    const tx = { id: ++this.txCounter, logs: [], failures: [], social: [], signer };
    tx.root = this.receipt({ predecessor: signer, signer, receiver: newId, actions: [{ type: 'create' }, { type: 'transfer', amount }], tx });
    this.queue.push(tx.root);
    this.drain();
    return this.summary(tx);
  }

  /** What is waiting to run, in order: `receiver.method`, or `receiver.transfer` for a payment. */
  waiting() {
    return this.queue.map((r) => `${r.receiver}.${r.actions.find((a) => a.method)?.method ?? r.actions[0]?.type}`);
  }

  /** Runs the first waiting receipt whose label (see `waiting`) matches, out of turn. */
  stepOn(label) {
    const index = this.waiting().findIndex((name) => name === label || name.endsWith(`.${label}`));
    if (index < 0) throw new Error(`no waiting receipt matches ${label}; waiting: ${this.waiting().join(', ')}`);
    this.execute(this.queue.splice(index, 1)[0]);
  }

  /** Runs the next `count` receipts. */
  step(count = 1) {
    for (let i = 0; i < count && this.queue.length; i++) this.execute(this.queue.shift());
  }

  summary(tx) {
    let at = tx.root;
    while (at.outcome?.forward) at = at.outcome.forward;
    const outcome = at.outcome;
    const pending = !outcome || outcome.pending;
    let value;
    if (outcome?.ok && outcome.value?.length) {
      try {
        value = JSON.parse(dec.decode(outcome.value));
      } catch {
        value = dec.decode(outcome.value);
      }
    }
    return {
      ok: !!outcome?.ok,
      pending: !!pending,
      value,
      error: outcome?.ok === false ? outcome.error : undefined,
      logs: tx.logs,
      failures: tx.failures,
      social: tx.social,
      events: tx.logs.filter((l) => l.log.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.log.slice('EVENT_JSON:'.length))),
    };
  }

  receipt({ predecessor, signer, receiver, actions, tx, deps = 0 }) {
    const r = { id: this.nextReceipt++, predecessor, signer, receiver, actions, tx, results: [], waiting: deps, waiters: [], outcome: null };
    if (!tx.root) tx.root = r;
    return r;
  }

  drain() {
    while (this.queue.length) this.execute(this.queue.shift());
  }

  refund(receipt) {
    for (const action of receipt.actions) {
      const amount = action.type === 'transfer' ? action.amount : action.deposit;
      if (!amount) continue;
      const payer = this.accounts.get(receipt.predecessor);
      if (payer) payer.balance += amount;
    }
  }

  /** What the FastData indexer does: it reads the arguments of every receipt, ignoring status. */
  indexFastData(r) {
    for (const action of r.actions) {
      if (action.type !== 'call' || action.method !== '__fastdata_kv') continue;
      let args;
      try {
        args = JSON.parse(dec.decode(action.args));
      } catch {
        continue;
      }
      if (!args || typeof args !== 'object' || Array.isArray(args)) continue;
      const keys = Object.keys(args);
      if (keys.length > 256) continue;
      for (const key of keys) {
        if (Buffer.byteLength(key) > 1024) continue;
        const row = {
          predecessor_id: r.predecessor,
          current_account_id: r.receiver,
          block_height: Number(this.height),
          block_timestamp: Number(this.now),
          key,
          value: args[key],
          order: this.fastdata.length,
        };
        this.fastdata.push(row);
        r.tx.social.push(row);
      }
    }
  }

  /** The latest value of every key an account wrote to `receiver`, like FastData's /v0/latest. */
  kvLatest(receiver, predecessor, prefix = '') {
    const latest = new Map();
    for (const row of this.fastdata) {
      if (row.current_account_id !== receiver || row.predecessor_id !== predecessor) continue;
      if (!row.key.startsWith(prefix)) continue;
      latest.set(row.key, row);
    }
    return [...latest.values()];
  }

  execute(r) {
    const tx = r.tx;
    this.current = r;
    this.indexFastData(r);
    this.height += 1n;
    const creating = r.actions[0]?.type === 'create';
    if (!creating && !this.accounts.has(r.receiver)) {
      this.refund(r);
      tx.failures.push({ receipt: r.id, error: `AccountDoesNotExist: ${r.receiver}` });
      this.finish(r, { ok: false, error: `AccountDoesNotExist: ${r.receiver}` });
      return;
    }
    if (creating && !r.receiver.endsWith(`.${r.predecessor}`)) {
      this.refund(r);
      const error = `CreateAccountNotAllowed: ${r.receiver} can only be created by its parent, not by ${r.predecessor}`;
      tx.failures.push({ receipt: r.id, error });
      this.finish(r, { ok: false, error });
      return;
    }
    if (creating && this.accounts.has(r.receiver)) {
      this.refund(r);
      tx.failures.push({ receipt: r.id, error: `AccountAlreadyExists: ${r.receiver}` });
      this.finish(r, { ok: false, error: `AccountAlreadyExists: ${r.receiver}` });
      return;
    }

    let acct = this.accounts.get(r.receiver);
    const before = acct ? { balance: acct.balance, code: acct.code, codeHash: acct.codeHash, locked: acct.locked, pendingStake: acct.pendingStake } : null;
    let created = false;
    let result = { ok: true, value: new Uint8Array() };
    const spawned = [];
    try {
      for (const action of r.actions) {
        if (action.type === 'create') {
          acct = this.account(r.receiver, 0n, { keys: 0 });
          created = true;
        } else if (action.type === 'transfer') {
          acct.balance += action.amount;
        } else if (action.type === 'use_global') {
          const module = this.globals.get(action.hash);
          if (!module) throw new Panic(`GlobalContractDoesNotExist: ${action.hash}`);
          acct.code = module;
          acct.codeBytes = 0;
          acct.codeHash = base58encode(Buffer.from(action.hash, 'hex'));
        } else if (action.type === 'stake') {
          const increase = action.amount - acct.locked;
          if (increase > 0n) {
            if (increase > acct.balance) throw new Panic(`TriesToStake: ${acct.id}`);
            acct.balance -= increase;
            acct.locked = action.amount;
            acct.pendingStake = null;
          } else {
            acct.pendingStake = action.amount;
          }
        } else if (action.type === 'call') {
          const out = this.runCall(r, acct, action, spawned);
          if (out !== undefined) result = out;
        }
      }
    } catch (err) {
      if (!(err instanceof Panic)) throw err;
      if (created) this.accounts.delete(r.receiver);
      else if (before) Object.assign(acct, before);
      this.refund(r);
      tx.failures.push({ receipt: r.id, account: r.receiver, method: r.actions.find((a) => a.method)?.method, error: err.message });
      this.finish(r, { ok: false, error: err.message });
      return;
    }
    this.finish(r, result);
  }

  runCall(r, acct, action, spawned) {
    const tx = r.tx;
    if (acct.mock) {
      acct.balance += action.deposit;
      let args = {};
      if (action.args.length) {
        try {
          args = JSON.parse(dec.decode(action.args));
        } catch {
          args = action.args;
        }
      }
      const out = acct.mock({ method: action.method, args, view: false, predecessor: r.predecessor, signer: r.signer, deposit: action.deposit, chain: this, self: acct, receipt: r, tx });
      return { ok: true, value: toBytes(out) };
    }

    acct.balance += action.deposit;
    const exec = new Execution(this, acct, { input: action.args, predecessor: r.predecessor, signer: r.signer, deposit: action.deposit, results: r.results, gas: action.gas });
    exec.run(action.method);

    const required = BigInt(exec.storageUsage()) * STORAGE_BYTE_COST;
    if (exec.balance + acct.locked < required) {
      throw new Panic(`LackBalanceForState: ${acct.id} has ${exec.balance}, needs ${required} for storage`);
    }

    acct.storage = exec.storage;
    acct.balance = exec.balance;
    for (const log of exec.logs) tx.logs.push({ account: acct.id, log });

    // Promises become receipts only now that the call has succeeded.
    const receipts = exec.promises.map((p) =>
      p.joint ? { joint: p.after } : this.receipt({ predecessor: acct.id, signer: r.signer, receiver: p.receiver, actions: p.actions, tx }),
    );
    exec.promises.forEach((p, i) => {
      if (p.joint) return;
      const sources = p.after.flatMap((a) => (receipts[a].joint ? receipts[a].joint.map((j) => receipts[j]) : [receipts[a]]));
      receipts[i].waiting = sources.length;
      sources.forEach((source, slot) => source.waiters.push({ receipt: receipts[i], slot }));
      if (sources.length === 0) spawned.push(receipts[i]);
    });
    for (const receipt of spawned.splice(0)) this.queue.push(receipt);

    if (exec.returnPromise !== null) return { forward: receipts[exec.returnPromise] };
    return { ok: true, value: exec.returned ?? new Uint8Array() };
  }

  finish(r, outcome) {
    r.outcome = outcome;
    if (outcome.forward) {
      outcome.forward.waiters.push(...r.waiters);
      r.waiters = [];
      return;
    }
    for (const { receipt, slot } of r.waiters) {
      receipt.results[slot] = outcome.ok ? { ok: true, value: outcome.value } : { ok: false };
      receipt.waiting -= 1;
      if (receipt.waiting === 0) this.queue.push(receipt);
    }
    r.waiters = [];
  }
}
