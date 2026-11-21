import { describe, expect, test } from 'bun:test';
import { managedPolicy, providerId, tokenVariable } from './policy';

const endpoint = new URL('http://127.0.0.1:18703/v1');

describe('Codex desktop provider profile', () => {
  test('uses one stable provider across native process restarts and sends only Responses', () => {
    const first = managedPolicy('OneX approved "exact" model', endpoint, '/tmp/private/catalog.json');
    const next = managedPolicy('another approved model', new URL('http://127.0.0.1:18704/v1'));
    for (const { config, requirements } of [first, next]) {
      expect(config).toContain(`model_provider = "${providerId}"`);
      expect(config).toContain(`exclude = ["${tokenVariable}"]`);
      for (const policy of [config, requirements]) {
        expect(policy).toContain(`[model_providers.${providerId}]`);
        expect(policy).toContain('wire_api = "responses"');
        expect(policy).toContain('supports_websockets = false');
        expect(policy).toContain('requires_openai_auth = false');
        expect(policy).toContain(`env_key = "${tokenVariable}"`);
      }
    }
    expect(first.config).toContain('model = "OneX approved \\"exact\\" model"');
    expect(first.config).toContain('model_catalog_json = "/tmp/private/catalog.json"');
    expect(first.requirements).toContain('model_catalog_json = "/tmp/private/catalog.json"');
  });

  test('rejects ambiguous destinations and malformed configuration inputs', () => {
    for (const url of [
      'https://127.0.0.1:18703/v1', 'http://localhost:18703/v1', 'http://127.0.0.1/v1',
      'http://foo:bar@127.0.0.1:18703/v1', 'http://127.0.0.1:18703/something',
      'http://127.0.0.1:18703/v1?tenant=1', 'http://127.0.0.1:18703/v1#one',
    ]) expect(() => managedPolicy('model', new URL(url))).toThrow();
    expect(() => managedPolicy('model\nmodel_provider', endpoint)).toThrow();
    expect(() => managedPolicy('model', endpoint, 'catalog.json')).toThrow();
  });
});
