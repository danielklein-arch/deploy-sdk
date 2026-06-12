// Render ephemerálního wrangler configu pro JEDEN worker z topology descriptoru + resolved env + ids.
// Čistá funkce (žádné process.env). env (DeployEnv) řídí jména/domény/vars/secrets per prostředí.
import type { Topology, WorkerDescriptor, DeployEnv } from './types'
import type { Ids } from './cf-client'
import { nameFor, sharedNameFor, aiGatewayName, resolveDomain } from './env'

const PREVIEW_DIR = '.preview'

// Resolved vars workeru pro daný env (sdílené renderem i build hookem → SPA build dostane stejné NUXT_PUBLIC_*).
// Precedence: env-level < worker flat < per-worker per-env override; + injektnutá custom-domain URL jiného workeru.
export function computeVars(w: WorkerDescriptor, env: DeployEnv, topology: Topology): Record<string, string> {
  const vars: Record<string, string> = { ...env.vars, ...w.vars, ...(w.varsByEnv?.[env.key] ?? {}) }
  if (w.injectUrlOf) vars[w.injectUrlOf.var] = `https://${resolveDomain(env, w.injectUrlOf.worker, topology)}`
  // Resolved jméno AI Gateway (gateway nemá config binding → runtime reference přes var). Vyhrává nad vars.
  for (const g of w.aiGateways ?? []) vars[g.binding] = aiGatewayName(env, g.resource, topology)
  return vars
}

export type RenderOpts = { env: DeployEnv; ids: Ids; topology: Topology }

// Vrací cestu k zapsanému `.preview/<base>.json`. Async — write se musí flushnout, než cestu
// předáme wrangleru (jinak read-after-write race).
export async function renderConfig(w: WorkerDescriptor, { env, ids, topology }: RenderOpts): Promise<string> {
  const name = (base: string): string => nameFor(env, base)
  const sharedR2 = new Set(topology.sharedR2Resources ?? [])
  // Shared bucket: preview všech PR sdílí `preview-${r}`; stable = per-env jméno. Non-shared = per-env/PR jméno.
  const bucketName = (resource: string): string =>
    sharedR2.has(resource) ? sharedNameFor(env, resource) : name(resource)
  const cfg: Record<string, unknown> = {
    name: name(w.base),
    // build worker → entry = built output (např. .output/server/index.mjs), jinak src. Cesta relativní k .preview/.
    main: `../${w.dir}/${w.build?.main ?? w.main}`,
    compatibility_date: topology.compat.date,
    compatibility_flags: topology.compat.flags,
    workers_dev: env.workersDev,
  }
  if (topology.observability) cfg.observability = topology.observability
  // Static assets (Nuxt .output/public) — wrangler je servíruje, SSR worker je fallback.
  if (w.build?.assets) cfg.assets = { directory: `../${w.dir}/${w.build.assets}` }
  const services = [
    ...(w.services?.map((s) => ({ binding: s.binding, service: name(s.target) })) ?? []),
    ...(w.externalServices?.map((s) => {
      const n = s.namesByEnv[env.key]
      if (!n) throw new Error(`external service '${s.binding}': chybí jméno pro env '${env.key}'`)
      return { binding: s.binding, service: n } // literální jméno, BEZ prefixu
    }) ?? []),
  ]
  if (services.length) cfg.services = services
  if (w.vpcServices?.length)
    cfg.vpc_services = w.vpcServices.map((v) => {
      const id = v.serviceIdByEnv[env.key]
      if (!id) throw new Error(`vpc service '${v.binding}': chybí service_id pro env '${env.key}'`)
      return { binding: v.binding, service_id: id, remote: v.remote ?? true }
    })
  if (w.d1?.length)
    cfg.d1_databases = w.d1.map((d) => ({
      binding: d.binding,
      database_name: name(d.resource),
      database_id: ids.d1[d.resource],
      migrations_dir: `../${w.dir}/migrations`,
    }))
  if (w.kv?.length) cfg.kv_namespaces = w.kv.map((k) => ({ binding: k.binding, id: ids.kv[k.resource] }))
  if (w.r2?.length) cfg.r2_buckets = w.r2.map((b) => ({ binding: b.binding, bucket_name: bucketName(b.resource) }))
  if (w.ai) cfg.ai = { binding: w.ai.binding }
  if (w.secretsStore?.length)
    cfg.secrets_store_secrets = w.secretsStore.map((s) => ({
      binding: s.binding,
      store_id: env.secretsStoreId,
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
      name: name(wf.name), // cloud-side název je per-env → cleanup maže podle něj
      class_name: wf.className,
      ...(wf.limits && { limits: wf.limits }),
    }))
  if (w.versionMetadata) cfg.version_metadata = { binding: w.versionMetadata }
  if (w.crons?.length) cfg.triggers = { crons: w.crons }
  if (w.customDomain) cfg.routes = [{ pattern: resolveDomain(env, w.base, topology), custom_domain: true }]
  const producers = w.queueProducers?.map((q) => ({ binding: q.binding, queue: name(q.resource) }))
  const consumers = w.queueConsumers?.map((q) => ({
    queue: name(q.resource),
    max_batch_size: q.batchSize ?? 10,
    max_batch_timeout: q.batchTimeout ?? 5,
    ...((q.maxRetries ?? q.deadLetter) && { max_retries: q.maxRetries ?? q.deadLetter?.maxRetries }),
    ...(q.deadLetter && { dead_letter_queue: name(q.deadLetter.resource) }),
  }))
  if (producers?.length || consumers?.length)
    cfg.queues = { ...(producers?.length && { producers }), ...(consumers?.length && { consumers }) }
  const vars = computeVars(w, env, topology)
  if (Object.keys(vars).length) cfg.vars = vars

  const path = `${PREVIEW_DIR}/${w.base}.json`
  await Bun.write(path, JSON.stringify(cfg, null, 2))
  return path
}
