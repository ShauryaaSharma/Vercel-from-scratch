# Vercel From Scratch

This project is a simplified, from-scratch rebuild of Vercel — the platform that takes a GitHub link and turns it into a live website, without you ever touching a server.

The whole system is split into three backend services, plus a small web frontend:

1. **[Ingestion Service](#ingestion-service)** (`vercel_upload`) — takes a GitHub repo URL, clones it, and stores every file.
2. **[Build Service](#build-service)** (`vercel_deploy`) — picks up a queued deployment, downloads it back, builds it, and publishes the output.
3. **[Request Router](#request-router)** (`vercel_request_handler`) — serves each built site to real visitors on its own URL.
4. **[Frontend](#frontend)** (`frontend`) — a React dashboard to trigger a deployment and watch it go live.

All three services are built and a frontend ties them together. Each piece is documented below.

### End-to-end flow

```
Frontend  ──POST /deploy──▶  Ingestion Service ──┬─▶ upload files ─▶ Storage (output/<id>)
 (:5173)                        (:3000)          └─▶ push id ─────▶ Redis (build-queue)
                                                                        │
                                                          BRPOP         ▼
Storage (dist/<id>) ◀── upload built site ── Build Service ◀── pull job
       │                                       (worker)
       ▼
Request Router (:3001)  ──serves──▶  http://localhost:3001/<id>/  (the live site)
```

Along the way the Frontend polls `GET /status?id=<id>` on the Ingestion
Service to show the deployment moving from `uploaded` to `deployed`.

## Ingestion Service

Part 1 of a 3-part project: building a simplified version of Vercel from scratch.

This service is the entry point. It takes a GitHub repository URL, clones it,
uploads every file to object storage, and queues the deployment for the next
stage — the Build Service — to pick up.

> Series: **Ingestion Service** (this repo) → Build Service → Request Router

### What it does

1. Accepts a GitHub repo URL, and optionally a set of environment variables,
   via `POST /deploy`
2. Generates a random 5-character deployment ID
3. Clones the repo locally under `output/<id>`
4. Recursively collects every file in the cloned repo
5. Uploads each file to an S3-compatible bucket (Cloudflare R2), preserving
   the folder structure as the object key
6. Validates and stores any requested environment variables in Redis
   (`hSet("env", id, ...)`), for the Build Service to inject into that
   deployment's build
7. Pushes the deployment ID onto a Redis queue (`build-queue`) for the Build
   Service to consume
8. Returns the deployment ID to the caller

### Architecture

```
User → POST /deploy {repoURL} → Upload Server
                                    │
                                    ├─→ clone repo (simple-git)
                                    ├─→ upload files (S3 / R2)
                                    └─→ push id (Redis list: build-queue)
                                    │
                                    └─→ res.json({ id })
```

### Tech stack

| Concern            | Choice                          |
|---------------------|----------------------------------|
| HTTP server         | Express                          |
| Repo cloning         | simple-git                       |
| Object storage       | Cloudflare R2 (S3-compatible API, via `aws-sdk` v2) |
| Job queue            | Redis (`lPush` on a list)        |
| Language / runtime    | TypeScript, compiled to ESM, Node.js |

### Project structure

```
src/
  index.ts   → Express server, /deploy route, orchestrates the flow
  aws.ts     → S3/R2 client setup, uploadFile()
  file.ts    → getAllFiles(), recursive file walker
  utils.ts   → generate(), random deployment ID
```

### Setup

#### 1. Install dependencies

```
npm install
```

#### 2. Environment variables

Create a `.env` file in the project root:

```
ACCESS_KEY_ID=<your R2 access key id>
SECRET_ACCESS_KEY=<your R2 secret access key>
ENDPOINT_FOR_S3=<your R2 endpoint URL>
```

These are required — the server throws on startup if any are missing.
Never commit this file.

#### 3. Redis

A Redis instance must be running and reachable. By default the service
connects to `redis://localhost:6379`, but this is configurable via a
`REDIS_URL` environment variable:

```ts
const publisher = process.env.REDIS_URL
    ? createClient({ url: process.env.REDIS_URL })
    : createClient();
publisher.connect();
```

> If you're also running the Build Service via Docker (see below), point
> this at whatever host port its Redis container publishes — the two
> services must agree on the same Redis instance, or deployments will be
> pushed to a queue nobody is listening on. See
> [Design notes](#design-notes-1) in the Build Service section for why this
> matters more than it sounds like it should.

#### 4. Build and run

```
npx tsc -b
node dist/index.js
```

The server listens on port `3000`.

### API

#### `POST /deploy`

**Request body**

```
{
  "repoURL": "https://github.com/<user>/<repo>.git",
  "envVars": {
    "VITE_APP_NAME": "hello"
  }
}
```

`envVars` is optional. Each entry must have a valid identifier as its key
(`/^[A-Za-z_][A-Za-z0-9_]*$/`) and a string value; anything else (bad key
names, non-string values, more than 30 entries, oversized keys/values) is
silently dropped rather than rejecting the whole deploy. These become real
environment variables during the Build Service's `npm install`/`npm run
build` for this deployment only — see
[Build Service → Design notes](#design-notes-1) for how that's isolated from
the worker's own secrets, and note that they only affect the *build*: a
framework like Vite only inlines vars prefixed `VITE_` into the shipped
client bundle, and nothing here re-reads them at request time (see
[Frontend](#frontend) for the practical implications).

**Response**

```
{
  "id": "7vrtl"
}
```

The returned `id` identifies this deployment. It's also the S3/R2 prefix
under which all files were uploaded (`output/<id>/...`), and the value
pushed onto the `build-queue` Redis list for the next service to consume.

### Design notes

- **Servers are disposable.** Cloned files are uploaded to object storage
  immediately rather than kept on local disk, so a server restart or crash
  doesn't lose anyone's code.
- **S3 keys use forward slashes, always.** Local file paths are normalized
  (`path.sep` → `/`) before being used as object keys, since S3/R2 has no
  real folder structure — only a `/`-delimited naming convention. Using
  Windows-style backslashes produces one flat, malformed key instead of a
  nested path.
- **Decoupled from the build step.** This service never runs a build. It
  only clones, uploads, and queues. The Build Service (next phase) is a
  separate process that consumes from `build-queue`, so a slow or failing
  build never blocks new uploads.
- **Uploads are awaited as a batch before queuing.** Every file upload is
  fired via `Promise.all(files.map(...))`, and the deployment ID is only
  pushed onto `build-queue` after every upload has actually settled. This
  used to be a `files.forEach(async file => ...)` — which looks like it
  awaits each upload, but `forEach` never waits on the promises its
  callback returns. In practice, the ID was reaching the queue before
  uploads had finished (or after some had silently failed), so the Build
  Service would sometimes race ahead and find an empty or partial folder
  in storage. Awaiting a real `Promise.all` closed that race.

### Known limitations / not yet handled

- No validation on `repoURL` (private repos, invalid URLs, non-existent
  repos will throw unhandled errors)
- No cleanup of the local `output/<id>` folder after upload — files remain
  on disk after being pushed to storage
- No de-duplication or collision handling if two deployments generate the
  same random ID (low probability, not yet guarded against)

### What's next

**Build Service** — listens on `build-queue`, pulls the deployment's files
back from storage, runs the project's install/build commands, and publishes
the output. See [Build Service](#build-service) below.

---

## Build Service

Part 2 of a 3-part project: building a simplified version of Vercel from
scratch.

This service is the part that actually *does* something with the code the
Ingestion Service uploaded. It listens on a queue, pulls a deployment's
files back down from storage, installs dependencies, runs the project's own
build command, and uploads the finished, built site back to storage —
ready for the next phase (Request Router) to serve.

> Series: Ingestion Service → **Build Service** (this repo) → Request Router

Getting this working reliably was a much longer road than it sounds. The
sections below cover not just what it does, but every real bug and
environment quirk that had to be understood and fixed along the way —
because most of them will bite anyone building something similar.

### What it does

1. Connects to Redis and blocks on `BRPOP build-queue 0` — waiting,
   indefinitely, for a deployment ID to appear
2. Validates the ID against `/^[a-zA-Z0-9_-]+$/` — rejecting anything else
   before it ever touches a file path or a shell command
3. Downloads every object under `output/<id>/` from S3/R2 back onto local
   disk, recreating the folder structure
4. Confirms a `package.json` actually exists in the downloaded project —
   refusing to proceed otherwise, rather than letting `npm` silently run
   against the wrong project
5. Reads back any environment variables stored for this deployment
   (`hGet("env", id)`) and runs `npm install --include=dev`, then
   `npm run build -- --base=/<id>/`, inside that project's own folder —
   using those variables and an otherwise minimal, explicit environment
   (see [Design notes](#design-notes-1))
6. Walks the resulting `output/<id>/dist/` folder and uploads every file
   back to storage under `dist/<id>/...`
7. Catches and logs any failure per job, so one bad deployment never brings
   down the worker or blocks the next one in the queue

### Architecture

```
Redis (build-queue) → BRPOP → Build Worker
                                  │
                                  ├─→ download files (S3 / R2)     → output/<id>/
                                  ├─→ read env vars (Redis: env)   → id-specific build env
                                  ├─→ npm install --include=dev
                                  ├─→ npm run build -- --base=/<id>/  → output/<id>/dist/
                                  └─→ upload built files (S3 / R2) → dist/<id>/...
```

The worker never stops. It's a `while (1)` loop — pull a job, process it,
log any failure, go back to waiting. There's no HTTP server here; this
service has no API of its own. It only reacts to the queue.

### Tech stack

| Concern             | Choice                                              |
|----------------------|-------------------------------------------------------|
| Job queue            | Redis (`BRPOP` on a list), via the `redis` npm package (v6 / node-redis v5 API) |
| Object storage        | Cloudflare R2 (S3-compatible API, via `aws-sdk` v2)  |
| Running builds         | Node's `child_process.spawn`, no shell involved by default |
| Containerization        | Docker (multi-stage build) + Docker Compose         |
| Language / runtime      | TypeScript, compiled to ESM, Node.js                |

### Project structure

```
src/
  index.ts   → connects to Redis, runs the main BRPOP loop, orchestrates the flow
  aws.ts     → S3/R2 client setup, downloadS3Folder(), copyFinalDist()
  utils.ts   → isValidId(), buildProject() — npm install/build via spawn
Dockerfile          → two-stage build: compile TS, then a slim runtime image
docker-compose.yml  → wires up the worker + its own Redis instance
.dockerignore
```

### Setup

#### 1. Install dependencies

```
npm install
```

#### 2. Environment variables

Create a `.env` file in the project root:

```
ACCESS_KEY_ID=<your R2 access key id>
SECRET_ACCESS_KEY=<your R2 secret access key>
ENDPOINT_FOR_S3=<your R2 endpoint URL>
```

Same as the Ingestion Service — the process throws on startup if any of
these are missing.

#### 3. Redis

Same rule as the Ingestion Service: reachable via `redis://localhost:6379`
by default, or wherever `REDIS_URL` points. **Both services must agree on
the same Redis instance** — see the [Design notes](#design-notes-1) below
for a real, very confusing bug this caused.

#### 4. Build and run locally

```
npx tsc -b
node dist/index.js
```

#### 5. Running with Docker (recommended)

```
docker compose up -d --build
```

This starts two containers:

- `redis` — a `redis:7-alpine` instance, published on host port `6380`
  (not the Redis default of `6379` — see [Design notes](#design-notes-1)
  for why)
- `worker` — the build service itself, connecting to that Redis over the
  internal Docker network at `redis://redis:6379` (the port only looks
  different from the host because of how it's published outward)

The worker's `output/` volume is bind-mounted to a folder on the host too:

```yaml
volumes:
  - ./output:/app/dist/output
```

Without this, everything the container downloads and builds only exists
inside the container's own filesystem — invisible from the host machine,
and gone the moment the container is rebuilt. With it, `vercel_deploy/output/<id>/`
shows up as a real folder on disk, live, while the worker runs.

Useful commands:

```
docker compose up -d --build     # rebuild + (re)start after code changes
docker compose logs -f worker    # stream logs live
docker compose ps                # confirm both containers are Up, not restarting
docker compose down              # stop everything
```

### Design notes

This service went through a long list of real bugs before it worked
reliably. Each one is documented here because the fix wasn't always
obvious, and most of them aren't specific to this project — they're the
kind of thing that bites anyone building a background worker like this.

- **`spawn`, never `exec`, for running untrusted commands.** The
  deployment ID comes from a queue — something that, depending on how the
  Ingestion Service is exposed, could end up attacker-influenced. The
  first version of this code built a shell command by string interpolation:
  `` exec(`cd ${outputPath} && npm install && npm run build`) `` — which
  hands the whole string to a shell to interpret. Anything shell-special
  in `id` (`;`, `&&`, backticks) would execute as a real command. The fix
  was to stop building command strings entirely, and instead use
  `spawn(cmd, [args...], { cwd })`, where `id` only ever becomes a working
  directory, never text a shell parses.
- **`isValidId()` guards every entry point.** Even with `spawn`, the ID
  still becomes part of a filesystem path (`output/<id>`). An ID like
  `../../etc` would be a path-traversal risk, unrelated to the shell
  injection issue above but just as real. Every job is checked against
  `/^[a-zA-Z0-9_-]+$/` before it's used anywhere, and rejected (logged and
  skipped) otherwise.
- **A missing `package.json` check, added after silent false successes.**
  Without it, running `npm install`/`npm run build` inside a folder with
  no `package.json` doesn't fail — npm walks *up* the directory tree,
  exactly like Git looking for `.git`, until it finds one. In testing,
  this meant a downloaded project with no `package.json` silently caused
  npm to install and build **this worker's own project** instead,
  reporting success while never touching the actual deployment. Explicitly
  checking for `package.json` in `outputPath` before running anything
  turns that into a clear, correct failure instead.
- **One bad job can't take down the worker.** Early versions let a single
  failure — like a `spawn` error from a missing `cwd`, or a non-zero exit
  code — become an uncaught exception, killing the entire `while (1)`
  loop and abandoning every other queued job. Every `spawn` call now has
  an `'error'` listener that rejects instead of throwing, exit codes are
  checked explicitly, and the main loop wraps each job in `try/catch` —
  so a failure is logged against that one deployment and the loop moves
  on to the next.
- **`__dirname` doesn't exist here — `import.meta.dirname` does.** This
  project runs as an ES Module (`"type": "module"` in `package.json`).
  `__dirname` is a CommonJS-only global; Node never injects it into ESM
  files. The code compiled fine (`@types/node` declares `__dirname`
  ambiently, for both module systems, so TypeScript doesn't complain) but
  crashed the moment it actually ran. `import.meta.dirname` is the real,
  working ESM equivalent.
- **`--include=dev` is required, because of the container's own
  `NODE_ENV`.** The Dockerfile sets `ENV NODE_ENV=production` for the
  worker itself — normal, sensible practice. But `spawn` inherits the
  parent process's environment by default, so the *downloaded project's*
  `npm install` also saw `NODE_ENV=production`, and npm's classic behavior
  is to skip `devDependencies` entirely under that setting. Since tools
  like Vite live in `devDependencies`, builds failed with `Cannot find
  module 'vite'` even though `npm install` had "succeeded." Passing
  `--include=dev` on the install forces dev dependencies in regardless of
  the worker's own environment.
- **`shell: true`, only on Windows, only because it's safe here.** On
  Windows, `npm` resolves to `npm.cmd`, a batch file. Recent Node.js
  versions (a fix for CVE-2024-27980) refuse to `spawn` `.bat`/`.cmd`
  files directly without `shell: true`, throwing `EINVAL` immediately
  instead. Enabling `shell: true` reopens a general risk — shell-invoked
  argument arrays aren't escaped, only concatenated — but it's safe in
  this specific case because the only variable input (`id`) is passed via
  `cwd`, never as part of the command or its arguments, which are always
  hardcoded literals (`"install"`, `"run"`, `"build"`).
- **The untrusted build never sees this worker's own environment.**
  `spawn` inherits the parent process's entire environment by default. Early
  versions of this worker relied on that default — which meant a downloaded
  project's `postinstall` or build script could read `process.env` and find
  this worker's own R2 credentials and `REDIS_URL` sitting right there,
  ready to exfiltrate. The fix was to stop relying on the default and pass
  an explicit `env` to every `spawn` call: just `PATH`/`HOME` (so `node`/`npm`
  still resolve) plus whatever variables the deployer requested via
  `envVars` — nothing belonging to the worker itself. This matters more once
  arbitrary users can request custom env vars for their build: it closes off
  the obvious next question of "can I just ask for `ACCESS_KEY_ID` as one of
  my variables and read it back" — no, because the worker's real env was
  never in the child's environment to begin with.
- **`--base=/<id>/` turns the build into something servable without a
  domain.** By default, Vite emits asset URLs rooted at `/` (`/assets/x.js`),
  which only works if the site owns the whole domain. Passing
  `--base=/<id>/` on the build (via `npm run build -- --base=/<id>/`, which
  npm forwards straight to the underlying Vite CLI) makes every emitted
  asset URL start with `/<id>/` instead. That's what lets the Request
  Router serve every deployment from one shared domain, keyed by a path
  prefix, with no wildcard subdomain or custom domain required — see
  [Request Router](#request-router).
- **A pre-existing native Redis service can silently steal your traffic.**
  On the development machine this was built on, a native Windows Redis
  service was already running on the default port, bound specifically to
  `127.0.0.1`. Docker's own published port binds more broadly (`0.0.0.0`/
  `[::]`), but Windows routes `localhost` connections to the more specific
  bind — the native service — not Docker's. Every job pushed from outside
  the container was landing on a completely different, invisible Redis
  instance that the worker never saw, with zero errors on either side.
  The fix was to move the containerized Redis to a different host port
  (`6380`) and make sure every producer (the Ingestion Service included)
  pointed at that same port explicitly via `REDIS_URL`. If a queue
  "swallows" jobs with no errors anywhere, check what's *actually*
  listening on that port before assuming the code is wrong.

### Known limitations / not yet handled

- **The build itself isn't sandboxed per job.** `npm install`/`npm run
  build` still runs inside the same long-lived worker container as the
  worker's own code — not a fresh, disposable container per deployment. The
  worker's own secrets are no longer exposed to it (see
  [Design notes](#design-notes-1)), but a malicious build script still
  shares the container's filesystem, CPU, and network with every other job.
  True isolation (a fresh, throwaway container per build) is a larger
  follow-up.
- **No build timeout.** A hung `npm install` or `npm run build` (for
  example, a build script that accidentally starts a dev server instead of
  exiting) blocks that job forever. It won't crash the worker or block
  other jobs already queued, but nothing currently kills a runaway build.
- **Assumes the build output lands in `dist/`.** This matches Vite (used
  for testing), but frameworks like Create React App output to `build/`
  instead. `copyFinalDist` doesn't currently detect or handle that
  difference.
- **No retry or dead-letter handling.** A failed job is logged and
  dropped — it isn't re-queued, retried, or moved anywhere for later
  inspection.
- **No resource limits.** A build with a huge dependency tree or memory
  footprint can consume as much CPU/RAM as the host allows; nothing caps
  it per job.

### What's next

The built output now has a home: the **Request Router** below picks up
`dist/<id>/...` from storage and serves it to real visitors.

---

## Request Router

Part 3 of a 3-part project: building a simplified version of Vercel from
scratch.

This is the service real visitors actually hit. Every deployment is
addressed by a path prefix — `<request-handler-domain>/<id>/` — and this
router pulls that deployment's built files back out of storage and serves
them. It's the piece that turns `dist/<id>/...` in a bucket into a reachable
website.

> Series: Ingestion Service → Build Service → **Request Router** (this repo)

### What it does

1. Accepts any GET request on any path (`/{*any}` — a catch-all route)
2. Reads the deployment ID from the **first path segment**
   (`/abc12/assets/x.js` → `abc12`)
3. Rewrites directory-style paths so a request for `/<id>` or `/<id>/` (or
   any path ending in `/`) maps to that folder's `index.html`
4. Fetches the matching object from storage at `dist/<id>/<rest-of-path>`
5. Sets a `Content-Type` from the file extension and sends the bytes back
6. Returns a clean `404 Not found` if the object doesn't exist, instead of
   leaking a storage error to the page

### Architecture

```
Visitor → GET <domain>/<id>/<path> → Request Router
                                        │
                                        ├─→ id   = first path segment
                                        ├─→ key  = dist/<id>/<path>
                                        ├─→ getObject (S3 / R2)
                                        └─→ res.send(body, Content-Type)
```

There's no queue and no Redis here — this service only reads from storage.
It's the one part of the system a normal end user ever talks to directly.
Every deployment lives under the **same** domain — there's no wildcard
subdomain or custom domain to configure; see
[Design notes](#design-notes-2) for why, and
[Build Service → Design notes](#design-notes-1) for the build-side half of
how this works.

### Tech stack

| Concern            | Choice                                              |
|--------------------|-----------------------------------------------------|
| HTTP server        | Express (catch-all `/{*any}` route)                 |
| Object storage     | Cloudflare R2 (S3-compatible API, via `aws-sdk` v2) |
| Routing key        | First path segment of the request URL               |
| Language / runtime | TypeScript, compiled to ESM, Node.js                |

### Project structure

```
src/
  index.ts   → Express server, catch-all route, path prefix → storage lookup
```

### Setup

#### 1. Install dependencies

```
npm install
```

#### 2. Environment variables

Same three credentials as the other services:

```
ACCESS_KEY_ID=<your R2 access key id>
SECRET_ACCESS_KEY=<your R2 secret access key>
ENDPOINT_FOR_S3=<your R2 endpoint URL>
```

#### 3. Build and run

```
npx tsc -b
node dist/index.js
```

The server listens on port `3001`.

#### 4. Reaching a deployment

Open `http://localhost:3001/<id>/` in a browser, where `<id>` is a
deployment ID returned by the Ingestion Service. The trailing slash matters
on the bare `/<id>` root — see Design notes.

### Design notes

- **Path-based routing instead of subdomains, deliberately.** The natural
  design for something like this is one subdomain per deployment
  (`<id>.example.com`), the way the real Vercel does it. That requires a
  domain you control, with a wildcard DNS record and a wildcard TLS
  certificate pointed at this service — none of which a platform's
  auto-generated URL (like `*.up.railway.app`) gives you, since you don't
  control its DNS. Routing by the **first path segment** instead means
  every deployment can be served from one single domain — including a free
  platform-generated one — with no DNS or certificate work at all. The
  trade-off: the deployed site itself has to be built aware of that prefix
  (see [Build Service → Design notes](#design-notes-1) for the `--base`
  flag that makes this transparent to whatever's deployed) rather than
  legitimately owning the whole origin the way a subdomain would.
- **`/<id>` or `/<id>/` has no object in storage — it has to become
  `/<id>/index.html`.** S3/R2 has no real folders, only keys. A request for
  a deployment's root arrives as a path ending at (or before) a `/`, which
  would look up a key ending in `/` — a prefix, not an actual object — and
  fail with `NoSuchKey`. A static file server has to supply the
  `index.html` itself; storage never will. Any such path is rewritten to
  append `index.html` before the lookup.
- **Errors return 404, not a stack trace.** A missing key throws from the
  storage SDK. Without handling, that exception rendered a raw AWS error
  (and its internals) straight onto the page. Wrapping the lookup in
  try/catch turns any miss into a plain `404 Not found`.
- **`Content-Type` is derived from an explicit extension → MIME map,
  because storage doesn't tell you.** The bytes come back the same
  regardless of file type, so the router labels them itself. An earlier
  version only recognized `.html` and `.css`, silently labeling everything
  else — including every image and font — as `application/javascript`,
  which browsers correctly refuse to render. The map now covers HTML, CSS,
  JS, JSON, common image formats (`svg`, `png`, `jpg`, `gif`, `webp`, `ico`)
  and fonts (`woff`, `woff2`, `ttf`), falling back to
  `application/octet-stream` for anything unrecognized.

### Known limitations / not yet handled

- **No SPA fallback for deep links.** Only trailing-slash paths fall back to
  `index.html`. A client-side route like `/<id>/about` with no matching
  object returns 404 rather than serving the app's `index.html`, so
  refreshing a deep link in a single-page app breaks.
- **No caching headers.** Every request is a fresh storage fetch; there's no
  `Cache-Control`, `ETag`, or CDN layer in front.

---

## Frontend

A small React dashboard that puts a face on the three services — how you
actually drive a deployment without hand-crafting `curl` requests.

> Talks only to the Ingestion Service's HTTP API; it never touches Redis or
> storage directly.

### What it does

- A **landing page** describing the project and its architecture
- A **deploy page** that:
  1. Takes a repo URL and, optionally, a set of key/value environment
     variables (add/remove rows) to pass into that deployment's build
  2. `POST`s both to the Ingestion Service (`/deploy`)
  3. Polls the deployment's status (`/status?id=<id>`) and shows a live
     two-step progress checklist — *uploading*, then *building & deploying*,
     each ticking green as it completes
  4. Surfaces the finished site's URL
     (`<request-handler-domain>/<id>/`) once the status flips to `deployed`

### Architecture

```
Frontend (Vite/React, :5173)
   │
   ├─→ POST /deploy {repoURL, envVars}   → Ingestion Service (:3000) → { id }
   ├─→ GET  /status?id=<id>              → Ingestion Service (:3000) → { status }
   └─→ link to <request-handler-domain>/<id>/ → Request Router (the live site)
```

### Tech stack

| Concern    | Choice                       |
|------------|------------------------------|
| Framework  | React 18                     |
| Build tool | Vite                         |
| Routing    | react-router-dom             |
| API calls  | `fetch` (CORS, no dev proxy) |

### Project structure

```
src/
  main.jsx          → router setup (/ and /deploy)
  config.js         → API base URL + Request Router base URL (env-configurable)
  index.css         → styling
  pages/
    Landing.jsx     → landing page + architecture walkthrough
    Deploy.jsx      → deploy form (repo URL + env vars), status polling, progress UI
```

### Setup

```
cd frontend
npm install
npm run dev
```

Opens on `http://localhost:5173`. Two env vars control where it points:

| Variable                   | Default                  | Purpose                                    |
|-----------------------------|---------------------------|---------------------------------------------|
| `VITE_API_BASE_URL`         | `http://localhost:3000`   | Ingestion Service — `/deploy` and `/status` |
| `VITE_REQUEST_HANDLER_URL`  | `http://localhost:3001`   | Request Router — where the "Live URL" link points |

All three backend services (and Redis) must be running for a deployment to
complete end to end.

### A note on environment variables and build-time-only effects

The env vars entered on the deploy form only affect the **build** — they
become real environment variables for that one `npm install`/`npm run
build` run (see [Build Service](#build-service)), and if the deployed
project's own code reads them (e.g. `import.meta.env.VITE_APP_NAME` in a
Vite app), their values get inlined into the compiled output. There is no
server running per deployment to re-read them afterward — the Request
Router only streams static files back out of storage. So changing a
variable's value never affects an already-built deployment; it only takes
effect on the next fresh deploy. This mirrors how any static-site host
(including the real Vercel, for a purely static project) treats build-time
environment variables.
