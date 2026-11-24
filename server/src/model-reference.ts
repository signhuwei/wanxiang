import type { Hono } from 'hono';
import { invalid } from './api';
import { platformActor, type ManagementOptions } from './management';
import { boundPage } from './routing-http';
import type { Store } from './store';
import referenceData from './model-reference-data.json';

type Reference = {
  maker_id: string; model_family: string; model_variant: string; model_snapshot?: string | null;
  display_name: string; context_tokens: number | null; output_tokens: number | null; capabilities_claim: string[];
  source: string; source_url: string; aliases: string[]; provider_names?: string[];
};
const references: readonly Reference[] = referenceData;
const normalized = (value: string) => value.trim().toLowerCase();
const visible = ({ aliases, provider_names, ...row }: Reference) => ({
  id: [row.maker_id, row.model_family, row.model_variant, row.model_snapshot ?? '', row.display_name].join('/'),
  ...row, aliases, provider_names: provider_names ?? [], model_snapshot: row.model_snapshot ?? null
});

export function modelReferenceSuggestions(rawModel: string, providerName?: string) {
  const model = normalized(rawModel);
  return references.filter(row => row.aliases.some(alias => normalized(alias) === model)
    && (!row.provider_names?.length || (providerName && row.provider_names.some(name => normalized(name) === normalized(providerName)))))
    .map(visible);
}

export function modelReferenceRoutes(app: Hono, store: Store, opts: ManagementOptions) {
  app.get('/v1/platform/model-references', c => {
    const actor = platformActor(store, c, opts.now());
    const q = normalized(c.req.query('q') ?? '');
    const maker = normalized(c.req.query('maker_id') ?? '');
    if (q.length > 200) invalid('q');
    if (maker.length > 100) invalid('maker_id');
    const page = boundPage(c, opts.codeSecret, actor, { q, maker });
    const selected = references.filter(row => (!maker || normalized(row.maker_id) === maker)
      && (!q || [row.maker_id, row.display_name, row.model_family, ...row.aliases].some(value => normalized(value).includes(q))));
    return c.json({ ...page.page(selected.slice(page.offset, page.offset + page.limit).map(visible), selected.length, ['read']),
      makers: [...new Set(references.map(row => row.maker_id))].sort() });
  });
}
