// Render ephemerálního wrangler configu pro JEDEN worker z topology descriptoru + resolved env + ids.
// Čistá funkce (žádné process.env). env (DeployEnv) řídí prefix/domény/vars/secrets per prostředí.
import type { WorkerDescriptor, DeployEnv } from './types'
import type { Ids } from './cf-client'
import { resolveDomain } from './env'

const PREVIEW_DIR = '.preview'

export type RenderOpts = {
  env: DeployEnv
  ids: Ids
  previewZone: string // zóna pro default custom domény
  secretsStoreId: string // CF Secrets Store id (account-specific → injektuje volající)
  compat: { date: string; flags: string[] } // compatibility_date + flags (consumer policy)
  sharedR2Resources?: readonly string[] // shared buckety (preview kolabuje na `preview-`, neteardownují se)
}

// Vrací cestu k zapsanému `.preview/<base>.json`. Async — write se musí flushnout, než cestu
// předáme wrangleru (jinak read-after-write race).
export async function renderConfig(
  w: WorkerDescriptor,
  { env, ids, previewZone, secretsStoreId, compat, sharedR2Resources }: RenderOpts,
): Promise<string> {
  const p = env.prefix
  const sharedR2 = new Set(sharedR2Resources ?? [])
  // Shared bucket: preview všech PR sdílí `preview-${r}`; stable = `${prefix}${r}`. Non-shared = per-PR `${prefix}${r}`.
  const bucketName = (resource: string): string =>
    sharedR2.has(resource) ? `${env.ephemeral ? 'preview-' : p}${resource}` : `${p}${resource}`
  const cfg: Record<string, unknown> = {
    name: `${p}${w.base}`,
    main: `../${w.dir}/${w.main}`, // cesta relativní k .preview/
    compatibility_date: compat.date,
    compatibility_flags: compat.flags,
    workers_dev: true,
  }
  const services = [
    ...(w.services?.map((s) => ({ binding: s.binding, service: `${p}${s.target}` })) ?? []),
    ...(w.externalServices?.map((s) => {
      const name = s.namesByEnv[env.key]
      if (!name) throw new Error(`external service '${s.binding}': chybí jméno pro env '${env.key}'`)
      return { binding: s.binding, service: name } // literální jméno, BEZ prefixu
    }) ?? []),
  ]
  if (services.length) cfg.services = services
  if (w.d1?.length)
    cfg.d1_databases = w.d1.map((d) => ({
      binding: d.binding,
      database_name: `${p}${d.resource}`,
      database_id: ids.d1[d.resource],
      migrations_dir: `../${w.dir}/migrations`,
    }))
  if (w.kv?.length) cfg.kv_namespaces = w.kv.map((k) => ({ binding: k.binding, id: ids.kv[k.resource] }))
  if (w.r2?.length) cfg.r2_buckets = w.r2.map((b) => ({ binding: b.binding, bucket_name: bucketName(b.resource) }))
  if (w.secretsStore?.length)
    cfg.secrets_store_secrets = w.secretsStore.map((s) => ({
      binding: s.binding,
      store_id: secretsStoreId,
      // per-env secret name override, jinak descriptor default
      secret_name: env.secrets[s.binding] ?? s.secretName,
    }))
  if (w.durableObjects?.length) {
    cfg.durable_objects = {
      bindings: w.durableObjects.map((d) => ({ name: d.binding, class_name: d.className })),
    }
    // Jedna migrace na třídu (tag = className) → přidání další DO třídy později = nový tag.
    cfg.migrations = w.durableObjects.map((d) => ({ tag: d.className, new_sqlite_classes: [d.className] }))
  }
  if (w.workflows?.length)
    cfg.workflows = w.workflows.map((wf) => ({
      binding: wf.binding,
      name: `${p}${wf.name}`, // cloud-side název je per-env → cleanup maže podle něj
      class_name: wf.className,
    }))
  if (w.crons?.length) cfg.triggers = { crons: w.crons }
  if (w.customDomain)
    cfg.routes = [{ pattern: resolveDomain(env, w.base, previewZone), custom_domain: true }]
  const producers = w.queueProducers?.map((q) => ({ binding: q.binding, queue: `${p}${q.resource}` }))
  const consumers = w.queueConsumers?.map((q) => ({
    queue: `${p}${q.resource}`,
    max_batch_size: 10,
    max_batch_timeout: 5,
    ...(q.deadLetter && {
      dead_letter_queue: `${p}${q.deadLetter.resource}`,
      max_retries: q.deadLetter.maxRetries,
    }),
  }))
  if (producers?.length || consumers?.length)
    cfg.queues = { ...(producers?.length && { producers }), ...(consumers?.length && { consumers }) }
  // Precedence: env-level (všem workerům) < worker flat < per-worker per-env override. Per-env vyhrává → žádný reset.
  const vars: Record<string, string> = { ...env.vars, ...w.vars, ...(w.varsByEnv?.[env.key] ?? {}) }
  // Generická injekce custom-domain URL jiného workeru (env-aware: prod apex override).
  if (w.injectUrlOf)
    vars[w.injectUrlOf.var] = `https://${resolveDomain(env, w.injectUrlOf.worker, previewZone)}`
  if (Object.keys(vars).length) cfg.vars = vars

  const path = `${PREVIEW_DIR}/${w.base}.json`
  await Bun.write(path, JSON.stringify(cfg, null, 2))
  return path
}
