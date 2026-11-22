import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hono } from 'hono';
import { ApiError } from '../src/api';
import { commerceRates, commerceRoutes } from '../src/commerce';
import { hash, randomToken } from '../src/credentials';
import { policyRoutes } from '../src/policy-routes';
import { ensureUser, seedTenant } from '../src/seed';
import { Store, type Transaction } from '../src/store';
import { body, clock, minutes, seedSupply } from './routing-fixture';

function insertPublishedRate(sql: Transaction, source: string, input: number) {
  sql.run(`INSERT INTO platform_rate_versions (source_rate_key, model_id, input_multiplier_basis, input_multiplier_ppm,
    input_milli_per_mtok, output_milli_per_mtok, cache_read_milli_per_mtok, cache_write_milli_per_mtok,
    sales_rates_source, pool_revision, pricing_at, calculation_status, source_digest, status, created_by, created_at)
    VALUES (?, 'mdl_m', 'cny_1_per_mtok_input', ?, ?, 12000, 1000, 5000, 'fixture', 6, ?,
      'complete', ?, 'available_to_sign', 'fixture', ?)`, [source, input * 1000, input, minutes(0), hash(source), minutes(0)]);
}

test('immutable plan prices survive repricing, signature replay, tenant narrowing and a rolled-back signature', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'onex-signing-'));
  const store = new Store(dir, 2);
  try {
    const { tenantId, userId } = await seedTenant(store, {target:'owner@signing.test', platformAdmin:true, now:clock});
    const platform = randomToken(), tenant = randomToken(), admin = randomToken(), other = randomToken();
    const otherTenant = await seedTenant(store,{target:'other@signing.test',now:clock});
    const adminId=await store.system.write(sql => {
      seedSupply(sql);
      insertPublishedRate(sql, 'prate_4', 4000);
      const otherAdmin = ensureUser(sql,{kind:'email',value:'admin@signing.test'},clock);
      sql.run(`INSERT INTO sessions (token_hash,user_id,tenant_id,kind,expires_at)
        VALUES (?,?,NULL,'web',?),(?,?,?,'web',?),(?,?,?,'web',?),(?,?,?,'web',?)`,
      [hash(platform),userId,minutes(60),hash(tenant),userId,tenantId,minutes(60),
        hash(admin),otherAdmin.id,tenantId,minutes(60),hash(other),otherTenant.userId,otherTenant.tenantId,minutes(60)]);
      // Clauses may be customized: the adapter selects the policy meaning.
      for (const id of ['access.models', 'billing.plan']) {
        sql.run(`INSERT INTO policy_definitions SELECT ?,version,json_set(definition_json,'$.id',?)
          FROM policy_definitions WHERE id=? AND version=1`, ['custom.'+id,'custom.'+id,id]);
      }
      return otherAdmin.id;
    });
    const db = store.tenant(tenantId), app = new Hono(), opts = {codeSecret:'test', now:()=>clock, dataDir:dir};
    await db.write(sql=>sql.run("INSERT INTO members (user_id,role,status) VALUES (?,'admin','active')",[adminId]));
    app.onError((err,c) => err instanceof ApiError ? c.json(err.body(),err.status) : c.json({error:'write failed'},500));
    commerceRoutes(app,store,opts); policyRoutes(app,store,opts);
    const call = (path:string, payload?:unknown, key=randomToken(), token=platform, method=payload?'POST':'GET') =>
      app.request('/v1'+path, {method, headers:{authorization:'Bearer '+token, 'content-type':'application/json', 'idempotency-key':key},
        ...(payload!==undefined && {body:JSON.stringify(payload)})});
    const planPath='/platform/commerce/plans', contract='/platform/policy/contracts/'+tenantId, signatures=contract+'/signatures';
    const modelPrice = { model_id:'mdl_m', source_rate_key:'prate_4' };
    const rates = {input_milli_per_mtok:4000,output_milli_per_mtok:12000,cache_read_milli_per_mtok:1000,cache_write_milli_per_mtok:5000};
    const plan = (model_prices:unknown[]) => call(planPath,{name:'test',expected_version:0,terms:{model_prices,monthly_grant_milli:500}});
    for (const invalid of [
      {...modelPrice,model_id:'mdl_legacy'}, {...modelPrice,source_rate_key:'missing'}, {...modelPrice,input_milli_per_mtok:0},
      {model_id:'mdl_m',output_milli_per_mtok:12000}, {...modelPrice,...rates,input_milli_per_mtok:Number.MAX_SAFE_INTEGER},
    ]) expect((await plan([invalid])).status).toBe(422);
    const firstResponse=await plan([modelPrice,{model_id:'mdl_legacy',...rates}]);
    expect(firstResponse.status).toBe(201);
    const first=await body(firstResponse);
    expect(first.terms.model_prices[0]).toEqual({...modelPrice,...rates});
    expect(commerceRates(store,{commerce_plan_id:first.id},[{model_id:'mdl_m'}])).toEqual([{model_id:'mdl_m',...rates}]);
    const terms=(cmp:string, revision:number, policyRevision=revision) => ({
      expected_platform_revision:revision,expected_policy_revision:policyRevision,base_revision:revision||null,reason:'signed test',
      entries:[['custom.access.models',['mdl_m']],['custom.billing.plan',[cmp]]].map(([id,adjustment])=>({
        template_ref:null,clause_ref:{id,version:1},adjustment,
      })),
    });
    const count=()=>db.get<{n:number}>('SELECT count(*) n FROM sales_rate_snapshots')!.n;
    const draft=terms(first.id,0);
    const preview=await body(await call(contract+'/preview', draft));
    expect(preview.sales_rate_snapshots).toMatchObject([{model_id:'mdl_m',source_rate_key:'prate_4',input_multiplier_ppm:4000000,...rates}]);
    expect(preview.sales_rate_snapshots[0]).not.toHaveProperty('rate_version_id');
    expect(count()).toBe(0);
    const response=await call(signatures,draft,'first');
    expect(response.status).toBe(201);
    const issued=await body(response), [snapshot]=issued.sales_rate_snapshots;
    expect(issued.sales_rate_snapshots).toHaveLength(1);
    expect(snapshot).toMatchObject({...preview.sales_rate_snapshots[0], platform_revision:1,valid_from:minutes(0),valid_until:null});
    expect(snapshot.rate_version_id).toMatch(/^rate_/);
    const tenantAccount = await body(await call('/commerce/account', undefined, 'tenant-account', tenant));
    expect(tenantAccount.plan.terms.model_prices[0]).toEqual({ model_id: 'mdl_m', ...rates });
    const platformAccount = await body(await call('/platform/commerce/tenants/' + tenantId));
    expect(platformAccount.plan.terms.model_prices[0]).toEqual({ ...modelPrice, ...rates });
    const signatureHistory='/policy/signatures';
    const ownerHistory=await body(await call(signatureHistory,undefined,'owner-history',tenant));
    expect(ownerHistory.items[0].actions).toEqual(['read','read_rates']);
    const adminHistory=await body(await call(signatureHistory,undefined,'admin-history',admin));
    expect(adminHistory.items[0].actions).toEqual(['read']);
    const tenantDetail=await body(await call(signatureHistory+'/1',undefined,'tenant-signature',tenant));
    expect(tenantDetail).toEqual({ revision:1,issued_at:minutes(0),actions:['read'],sales_rate_snapshots:[{
      rate_version_id:snapshot.rate_version_id,model_id:'mdl_m',input_multiplier_basis:'cny_1_per_mtok_input',
      input_multiplier_ppm:4000000,valid_from:minutes(0),valid_until:null,...rates,
    }] });
    expect((await call(signatureHistory+'/1',undefined,'admin-signature',admin)).status).toBe(403);
    expect((await call(signatureHistory+'/1',undefined,'foreign-signature',other)).status).toBe(404);
    await expect(db.write(sql => sql.run('UPDATE sales_rate_snapshots SET output_milli_per_mtok=1'))).rejects.toThrow('immutable');
    await expect(db.write(sql => sql.run('DELETE FROM sales_rate_snapshots'))).rejects.toThrow('immutable');
    expect(await body(await call(signatures,draft,'first'))).toEqual(issued);
    expect((await call(signatures,{...draft,reason:'different'},'first')).status).toBe(409);
    expect((await call(signatures,draft)).status).toBe(409);
    expect(count()).toBe(1);

    await store.system.write(sql=>insertPublishedRate(sql,'prate_5',5000));
    const latest=await body(await plan([{...modelPrice,source_rate_key:'prate_5', ...rates,input_milli_per_mtok:4500}]));
    expect(latest.terms.model_prices[0].input_milli_per_mtok).toBe(4500);
    const next=terms(latest.id,1);
    const changed=await call('/policy/configurations/tenant/'+tenantId,{
      expected_platform_revision:1,expected_policy_revision:1,template_ref:null,
      selections:[{clause_ref:{id:'custom.access.models',version:1},value:[]}],
    },'narrow',tenant,'PUT');
    expect(changed.status).toBe(200);
    next.expected_policy_revision=2;
    expect((await body(await call(contract+'/preview',terms(first.id,1,2)))).sales_rate_snapshots[0].input_multiplier_ppm).toBe(4000000);
    expect((await body(await call(contract+'/preview',next))).sales_rate_snapshots[0].input_multiplier_ppm).toBe(4500000);
    await db.write(sql=>sql.run(`CREATE TRIGGER fail_signature_audit BEFORE INSERT ON audit
      WHEN NEW.action='policy.signature.publish' BEGIN SELECT RAISE(ABORT,'injected failure'); END`));
    expect((await call(signatures,next,'retry')).status).toBe(500);
    expect(count()).toBe(1);
    expect(db.get('SELECT platform_revision,policy_revision FROM policy_head')).toEqual({platform_revision:1,policy_revision:2});
    expect(db.get('SELECT max(revision) AS head FROM policy_signatures')).toEqual({head:1});
    await db.write(sql=>sql.run('DROP TRIGGER fail_signature_audit'));
    const newIssue=await call(signatures,next,'retry');
    expect(newIssue.status).toBe(201);
    const current=await body(newIssue);
    expect(current.sales_rate_snapshots[0]).toMatchObject({model_id:'mdl_m',commerce_plan_id:latest.id,
      source_rate_key:'prate_5',platform_revision:2,input_multiplier_ppm:4500000,input_milli_per_mtok:4500});
    expect(current.sales_rate_snapshots[0].rate_version_id).not.toBe(snapshot.rate_version_id);
    expect(count()).toBe(2);
    expect((await body(await call(signatures+'/1'))).sales_rate_snapshots).toEqual(issued.sales_rate_snapshots);
    expect((await call(signatures+'/1',undefined,'forbidden',tenant)).status).toBe(403);

    const legacy = await body(await plan([{model_id:'mdl_m', ...rates}]));
    const legacyIssue = await call(signatures,terms(legacy.id,2,3));
    expect(legacyIssue.status).toBe(201);
    expect((await body(legacyIssue)).sales_rate_snapshots[0]).toMatchObject({source_rate_key:null,input_multiplier_ppm:4000000});
    const noPlan = terms(legacy.id,3,4);
    noPlan.entries = noPlan.entries.filter(entry => entry.clause_ref.id === 'custom.access.models');
    const unpriced = await call(signatures,noPlan);
    expect(unpriced.status).toBe(201);
    expect((await body(unpriced)).sales_rate_snapshots).toEqual([]);
    expect((await body(await call(signatureHistory+'/4',undefined,'empty-price-history',tenant))).sales_rate_snapshots).toEqual([]);
    expect(count()).toBe(3);
  } finally { store.close(); rmSync(dir,{recursive:true,force:true}); }
});
