import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ASHA, HALL, SITE, choir, create, info, setup, social, token } from './harness.mjs';

test('smoke: a Choir is created as its own keyless account and introduces itself on near.social', () => {
  const { chain } = setup();
  const id = create(chain);
  assert.equal(id, `builders.${HALL}`);
  assert.equal(chain.keys(id), 0);

  const view = choir(chain, id);
  assert.equal(view.conductor, ASHA);
  assert.equal(view.status, 'Active');
  assert.equal(view.name, 'NEAR Builders');

  const item = info(chain, id);
  assert.deepEqual(item, {
    spec: 'sharded-item-1.0.0',
    init: true,
    status: 'Active',
    collection_id: HALL,
    token_id: id,
    owner_id: ASHA,
    rotation_seq: '0',
    rotation_epoch: 0,
  });
  assert.equal(token(chain, id).owner_id, ASHA);

  const profile = social(chain, id, 'profile/');
  assert.equal(profile['profile/name'], 'NEAR Builders');
  assert.match(profile['profile/about'], /Nobody holds its keys/);
  assert.equal(profile['profile/links/website'], `${SITE}#/c/${id}`);
});
