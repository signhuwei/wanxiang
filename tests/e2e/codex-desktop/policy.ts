/** Policy shared by the signed Codex app-server qualification runs. */
import { isAbsolute } from 'node:path';

export const providerId = 'onex_codex_desktop';
export const tokenVariable = 'ONEX_CODEX_DESKTOP_TOKEN';

function quote(value: string): string {
  return JSON.stringify(value).replaceAll('\u007f', '\\u007f');
}

export function managedPolicy(model: string, endpoint: URL, catalogPath?: string) {
  if (model.length === 0 || model.trim() !== model || /[\u0000-\u001f\u007f]/.test(model)) {
    throw new Error('Expected an exact OneX model alias');
  }
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || !endpoint.port ||
      endpoint.username || endpoint.password || endpoint.pathname !== '/v1' || endpoint.search || endpoint.hash) {
    throw new Error('Expected the private OneX IPv4 loopback /v1 endpoint');
  }
  if (catalogPath !== undefined && !isAbsolute(catalogPath)) {
    throw new Error('Expected an absolute path for the approved Codex model catalog');
  }

  const provider = [
    `[model_providers.${providerId}]`,
    'name = "OneX"',
    `base_url = ${quote(endpoint.href)}`,
    `env_key = ${quote(tokenVariable)}`,
    'wire_api = "responses"',
    'requires_openai_auth = false',
    'supports_websockets = false',
    'request_max_retries = 0',
    'stream_max_retries = 0',
  ];
  const selectedProvider = `model_provider = ${quote(providerId)}`;
  const selectedCatalog = catalogPath === undefined ? [] : [`model_catalog_json = ${quote(catalogPath)}`];
  const config = [
    `model = ${quote(model)}`,
    selectedProvider,
    ...selectedCatalog,
    'check_for_update_on_startup = false',
    'project_doc_max_bytes = 0',
    'web_search = "disabled"',
    '',
    '[features]',
    'plugins = false',
    '',
    '[analytics]',
    'enabled = false',
    '',
    '[feedback]',
    'enabled = false',
    '',
    '[shell_environment_policy]',
    `exclude = [${quote(tokenVariable)}]`,
    '',
    ...provider,
    '',
  ].join('\n');
  // This file is an output for administrators. A private user profile alone cannot enforce it.
  const requirements = [selectedProvider, ...selectedCatalog, '', ...provider, ''].join('\n');
  return { config, requirements };
}
