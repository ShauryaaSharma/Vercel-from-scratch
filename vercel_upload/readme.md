# Vercel From Scratch

This project is a simplified, from-scratch rebuild of Vercel — the platform that takes a GitHub link and turns it into a live website, without you ever touching a server.

The whole system is split into three phases, each one a separate service:

1. **[Ingestion Service](#ingestion-service)** — takes a GitHub repo URL, clones it, and stores every file.
2. **Build Service** — picks up a queued deployment, runs the actual build, and publishes the output. *(not built yet)*
3. **Request Router** — serves the built site to real visitors on a real URL. *(not built yet)*

Only the Ingestion Service exists so far. That's what the rest of this README documents.

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

A Redis instance must be running and reachable on the default connection
(`redis://localhost:6379`). The service connects on startup via:

```
const publisher = createClient();
publisher.connect();
```

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

### Known limitations / not yet handled

- No validation on `repoURL` (private repos, invalid URLs, non-existent
  repos will throw unhandled errors)
- No cleanup of the local `output/<id>` folder after upload — files remain
  on disk after being pushed to storage
- No de-duplication or collision handling if two deployments generate the
  same random ID (low probability, not yet guarded against)
- No response for upload failures — `files.forEach` fires uploads without
  awaiting them together or reporting partial failures

### What's next

**Build Service** — listens on `build-queue`, pulls the deployment's files
back from storage, runs the project's install/build commands, and publishes
the output.