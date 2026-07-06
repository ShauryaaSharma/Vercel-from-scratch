# Vercel From Scratch

This project is a simplified, from-scratch rebuild of Vercel — the platform that takes a GitHub link and turns it into a live website, without you ever touching a server.

The whole system is split into three phases, each one a separate service:

1. **[Ingestion Service](#ingestion-service)** — takes a GitHub repo URL, clones it, and stores every file.
2. **[Build Service](#build-service)** — picks up a queued deployment, downloads it back, builds it, and publishes the output.
3. **Request Router** — serves the built site to real visitors on a real URL. *(not built yet)*

The Ingestion Service and Build Service both exist so far. That's what the rest of this README documents.

## Ingestion Service

Part 1 of a 3-part project: building a simplified version of Vercel from scratch.

This service is the entry point. It takes a GitHub repository URL, clones it,
uploads every file to object storage, and queues the deployment for the next
stage — the Build Service — to pick up.

> Series: **Ingestion Service** (this repo) → Build Service → Request Router

### What it does

1. Accepts a GitHub repo URL via `POST /deploy`
2. Generates a random 5-character deployment ID
3. Clones the repo locally under `output/<id>`
4. Recursively collects every file in the cloned repo
5. Uploads each file to an S3-compatible bucket (Cloudflare R2), preserving
   the folder structure as the object key
6. Pushes the deployment ID onto a Redis queue (`build-queue`) for the Build
   Service to consume
7. Returns the deployment ID to the caller

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
  "repoURL": "https://github.com/<user>/<repo>.git"
}
```

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
5. Runs `npm install --include=dev`, then `npm run build`, inside that
   project's own folder
6. Walks the resulting `output/<id>/dist/` folder and uploads every file
   back to storage under `dist/<id>/...`
7. Catches and logs any failure per job, so one bad deployment never brings
   down the worker or blocks the next one in the queue

### Architecture

```
Redis (build-queue) → BRPOP → Build Worker
                                  │
                                  ├─→ download files (S3 / R2) → output/<id>/
                                  ├─→ npm install --include=dev
                                  ├─→ npm run build              → output/<id>/dist/
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
  worker's own code and credentials — not a fresh, disposable container
  per deployment. A malicious `postinstall` script could still read this
  container's environment. True isolation (spawning a fresh container per
  build, with no access to the worker's own secrets) is a larger follow-up.
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

**Request Router** — takes a deployment ID (or a custom domain mapped to
one), fetches the matching built files from `dist/<id>/...` in storage, and
serves them to real visitors as an actual, reachable website.