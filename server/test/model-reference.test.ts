import { expect, test } from 'bun:test';
import { modelReferenceSuggestions } from '../src/model-reference';

test('public reference suggestions preserve exact IDs and channel aliases', () => {
  const kimi = modelReferenceSuggestions(' K3 ', 'Kimi Code');
  expect(kimi).toHaveLength(1);
  expect(kimi[0]!.maker_id).toBe('moonshotai');
  expect(modelReferenceSuggestions('k3', 'other relay')).toEqual([]);
  expect(modelReferenceSuggestions('k3-256k', 'Kimi Code')[0]!.id).not.toBe(kimi[0]!.id);
  const snapshot = 'claude-haiku-4-5-20251001';
  expect(modelReferenceSuggestions(snapshot)[0]!.model_snapshot).toBe(snapshot);
  expect(modelReferenceSuggestions('Qwen3.8-27B')).toEqual([]);
});
