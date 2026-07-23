import test from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG, RARITIES } from '../src/routes/rewards.js';
import { MODELS } from '../src/routes/ai.js';

test('collectible catalog contains ten unique cards in all six rarities', () => {
  assert.equal(CATALOG.length, 60);
  assert.equal(new Set(CATALOG.map(card => card.id)).size, 60);
  for (const rarity of RARITIES) assert.equal(CATALOG.filter(card => card.rarity === rarity.id).length, 10);
  assert.equal(RARITIES.reduce((total, rarity) => total + rarity.chance, 0), 100);
});

test('AI uses Gemini 3.6 Flash with a hidden rate-limit fallback', () => {
  assert.equal(MODELS[0].id, 'gemini-3.6-flash');
  assert.equal(MODELS[1].id, 'gemini-3.5-flash-lite');
  assert.equal(MODELS.some(model => model.id === 'gemini-2.5-flash'), false);
});
