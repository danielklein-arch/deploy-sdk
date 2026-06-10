// Topology schéma — VLASTNÍ package (budoucí npm). Konzument (lab / dbu-txs) dodá `Topology`
// objekt jako DATA; engine funkce ho berou parametrem (žádný import konkrétní topologie).

export type ServiceBinding = { binding: string; target: string } // target = base name jiného workeru
// External service binding — cíl běží mimo tuhle topologii (jiný repo/pipeline, např. MDM).
// Literální jméno per env (neprefixuje se, neprovisionuje se, necleanupuje se).
export type ExternalServiceBinding = { binding: string; namesByEnv: Record<string, string> }
export type D1Binding = { binding: string; resource: string } // resource = base name DB
export type KvBinding = { binding: string; resource: string }
export type QueueProducer = { binding: string; resource: string }
// Consumer config per queue (dbu-txs: notifications batch=1+DLQ, audit-logs batch=100, queue-bus retries=3).
// deadLetter.resource = base name DLQ queue (musí být v queueResources → ensure/cleanup).
// maxRetries funguje i BEZ deadLetter; default batchSize=10, batchTimeout=5.
export type QueueConsumer = {
  resource: string
  batchSize?: number
  batchTimeout?: number
  maxRetries?: number
  deadLetter?: { resource: string; maxRetries: number }
}
export type R2Binding = { binding: string; resource: string } // resource = base name bucketu
export type SecretStoreBinding = { binding: string; secretName: string } // secretName = jméno v CF Secrets Store
export type DurableObjectBinding = { binding: string; className: string } // className = exportovaná DO třída
// limits.steps: per-workflow override (dbu-txs bank sync = 25000)
export type WorkflowBinding = { binding: string; name: string; className: string; limits?: { steps?: number } }
// VPC service binding (dbu-txs bank → CBS backoffice). service_id per env, neprovisionuje/necleanupuje se.
export type VpcServiceBinding = { binding: string; serviceIdByEnv: Record<string, string>; remote?: boolean }
// Build-before-deploy (Nuxt apod.): deploy spustí `command`, pak deployuje built output místo src.
// main = entry buildu (relativní k worker dir, např. `.output/server/index.mjs`),
// assets = static dir (relativní k worker dir, např. `.output/public`) → wrangler assets binding.
export type BuildSpec = { command: string; main: string; assets?: string }

export type WorkerDescriptor = {
  base: string // base worker name, finální = `${prefix}${base}`
  dir: string // cesta k workeru (kde je src/ a wrangler.dev.jsonc)
  main: string
  build?: BuildSpec // build-before-deploy (Nuxt) → deployuje built output + assets, ne src
  services?: ServiceBinding[]
  externalServices?: ExternalServiceBinding[] // bindingy na workery mimo topologii (per-env literální jméno)
  vpcServices?: VpcServiceBinding[]
  d1?: D1Binding[]
  kv?: KvBinding[]
  r2?: R2Binding[]
  secretsStore?: SecretStoreBinding[] // bind na centrální CF Secrets Store (topology.secretsStoreId)
  durableObjects?: DurableObjectBinding[] // DO třídy exportované tímto workerem (+ SQLite migrace)
  workflows?: WorkflowBinding[] // Workflow třídy (cloud-side identita → cleanup je maže)
  crons?: string[] // cron triggery (worker potřebuje `scheduled` handler)
  queueProducers?: QueueProducer[]
  queueConsumers?: QueueConsumer[]
  vars?: Record<string, string>
  // Per-worker per-env override varů (klíč = env.key: 'preview'|'dev'|'staging'|'production'). Vyhrává nad flat `vars`.
  // Řeší env-specific config (FINBRICKS_BASE_URI sandbox vs prod, STORAGE_URL) BEZ resetu — každý env renderuje svou hodnotu.
  varsByEnv?: Record<string, Record<string, string>>
  // Injektuj custom-domain URL JINÉHO workeru jako var (generické — nahrazuje hardcoded frontend→GATEWAY_URL).
  // var = jméno env proměnné, worker = base name workeru s custom doménou.
  injectUrlOf?: { var: string; worker: string }
  // custom domain `${prefix}${base}.${topology.previewZone}` (řeší worker→worker fetch; workers.dev hází CF 1042)
  customDomain?: boolean
  // Per-env FQDN šablona workeru, `{pr}` placeholder pro preview (dbu-txs: preview '{pr}.api.dbutxs.develit.dev',
  // dev 'dev.api.dbutxs.develit.dev', production 'api.txs.devizovaburza.cz'). Priorita: env.domains > tohle > default.
  domainsByEnv?: Record<string, string>
  // Custom migrate command (drizzle-kit apod.) — `migrate`/deployOne ho spustí MÍSTO `wrangler d1 migrations apply`.
  // Env dostane ENVIRONMENT + D1_ID_<BINDING>/D1_NAME_<BINDING> pro každý d1 binding workeru.
  migrateCommand?: string
  // version_metadata binding (CF_VERSION_METADATA u dbu-txs gateway/frontend)
  versionMetadata?: string
  // pořadí deploye: nižší dřív (services 0 → gateway 1 → frontend 2). Pozn.: plně paralelní matrix
  // pořadí nevynucuje (deployWorker retry-uje 10143); deployOrder používá jen lokální sériový wrapper.
  deployOrder: number
}

// Kompletní deklarace topologie. Jediný vstup, který engine potřebuje znát.
export type Topology = {
  workers: WorkerDescriptor[]
  d1Resources: readonly string[] // base názvy sdílených zdrojů (per-PR prefixované)
  kvResources: readonly string[]
  queueResources: readonly string[]
  r2Resources: readonly string[]
  // Sdílené R2 buckety: preview kolabuje na 1 (`preview-${r}`), stable per-env (`dev-`/`staging-`/`prod-`).
  // NEteardownují se na PR close (persistují). Vhodné pro dokumenty s public custom domain.
  sharedR2Resources?: readonly string[]
  previewZone: string // zóna pro per-PR custom domény (gateway)
  secretsStoreId: string // CF Secrets Store id (account-specific)
  // Suffix naming mode (dbu-txs): jména = `${naming.prefix}${base}${suffix}` — preview `dbu-txs-order-1577`,
  // dev `-dev`, staging `-staging`, production '' (EnvConfig.suffix). Bez naming = legacy prefix mode (`pr-N-order`).
  naming?: { prefix: string }
  compat: { date: string; flags: string[] } // compatibility_date + flags (consumer policy, ne engine)
  // observability blok pro všechny workery (dbu-txs: { enabled: true, head_sampling_rate: 1 }). Default: žádný.
  observability?: Record<string, unknown>
  // base name veřejného workeru (cíl smoke/komentáře). Single-worker projekt = ten jediný worker.
  entrypoint: string
  // Stálá prostředí (dev/staging/prod). Previews jsou odvozené (ephemeral, prefix pr-<N>-).
  environments: Record<string, EnvConfig>
}

// Per-prostředí konfigurace stálého env (dev/staging/prod).
export type EnvConfig = {
  prefix?: string // resource prefix (legacy mode); default `${name}-`
  // Suffix v naming mode (`topology.naming`); default `-${key}`. Production = '' (bare jména s živými daty).
  suffix?: string
  // Git branch mapující na tento env, když se jméno liší (branch 'prod' → env 'production').
  // resolveEnv: přímý klíč má přednost, pak scan podle branch.
  branch?: string
  // workers_dev toggle (default true). dbu-txs stable = false (jen custom domains).
  workersDev?: boolean
  // Per-env CF Secrets Store id (multi-account: každý account má vlastní store). Fallback topology.secretsStoreId.
  secretsStoreId?: string
  vars?: Record<string, string> // env-level vars do VŠECH workerů (ENVIRONMENT se přidá automaticky)
  domains?: Record<string, string> // worker base → custom-domain FQDN (override; prod = apex)
  secrets?: Record<string, string> // secret binding → env-specific secret name (override descriptoru)
  // CF account pro tento env (declarative, není secret). Když chybí → ambient CLOUDFLARE_ACCOUNT_ID.
  // Pro multi-account setupy (dbu-txs: dev≠prod účet). CLI aktivuje do process.env před wrangler/API cally.
  accountId?: string
  // Jméno env proměnné s API tokenem pro tenhle account (token JE secret → zůstává v env).
  // Když chybí → ambient CLOUDFLARE_API_TOKEN. Např. prod → 'CLOUDFLARE_API_TOKEN_PROD'.
  apiTokenEnv?: string
}

// Vyřešené prostředí (preview nebo stable) — engine podle něj renderuje. Pure data.
export type DeployEnv = {
  name: string // 'pr-123' | 'dev' | 'staging' | 'production'
  key: string // lookup klíč pro varsByEnv / externalServices: 'preview' | stable name ('dev'|'staging'|'production')
  prefix: string // legacy: 'pr-123-' | 'dev-'; naming mode: projektový prefix ('dbu-txs-')
  suffix: string // naming mode: '-1577' | '-dev' | '' ; legacy: ''
  pr?: number // PR číslo (jen preview) — pro `{pr}` placeholder v domainsByEnv
  workersDev: boolean // workers_dev v configu (default true)
  ephemeral: boolean // preview=true (teardown), stable=false (persistuje)
  vars: Record<string, string> // env vars merge do všech workerů (vč. ENVIRONMENT)
  domains: Record<string, string> // base → FQDN override (custom-domain workery)
  secrets: Record<string, string> // binding → secretName override
  accountId?: string // CF account pro env (jinak ambient CLOUDFLARE_ACCOUNT_ID)
  apiTokenEnv?: string // env proměnná s tokenem pro account (jinak ambient CLOUDFLARE_API_TOKEN)
  secretsStoreId: string // resolved store id (env override ?? topology.secretsStoreId)
}
