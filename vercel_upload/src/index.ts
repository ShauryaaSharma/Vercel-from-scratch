import express from "express";
import cors from "cors";
import {simpleGit} from "simple-git";
import { generate } from "./utils.js";
import { getAllFiles } from "./file.js";
import { fileURLToPath } from "url";
import path from "path";
import { uploadFile } from "./aws.js";
import { createClient } from "redis";
const subscriber = process.env.REDIS_URL
    ? createClient({ url: process.env.REDIS_URL })
    : createClient();
subscriber.connect();

const publisher = process.env.REDIS_URL
    ? createClient({url: process.env.REDIS_URL})
    : createClient();
publisher.connect();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_ENV_VARS = 30;
const MAX_KEY_LENGTH = 100;
const MAX_VALUE_LENGTH = 4096;

// Only pass through well-formed, size-bounded string entries. Everything
// else (bad key names, non-string values, oversized payloads) is silently
// dropped rather than rejecting the whole deploy.
function sanitizeEnvVars(input: unknown): Record<string, string> {
    const result: Record<string, string> = {};
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        return result;
    }
    const entries = Object.entries(input as Record<string, unknown>).slice(0, MAX_ENV_VARS);
    for (const [key, value] of entries) {
        if (
            typeof value === "string" &&
            ENV_KEY_PATTERN.test(key) &&
            key.length <= MAX_KEY_LENGTH &&
            value.length <= MAX_VALUE_LENGTH
        ) {
            result[key] = value;
        }
    }
    return result;
}

app.post("/deploy", async (req, res) => {
    const repoURL = req.body.repoURL;
    const envVars = sanitizeEnvVars(req.body.envVars);
    console.log(repoURL);
    const id = generate();
    await simpleGit().clone(repoURL, path.join(__dirname, `output/${id}`));

    const files = getAllFiles(path.join(__dirname, `output/${id}`));
    console.log(files);

    await Promise.all(files.map(file =>
        uploadFile(file.slice(__dirname.length+1).split(path.sep).join("/"), file)
    ));

    await publisher.hSet("env", id, JSON.stringify(envVars));
    await publisher.lPush("build-queue", id);
    await publisher.hSet("status", id, "uploaded");

    res.json({
        id: id
    })
})

app.get("/status", async (req, res) => {
    const id = req.query.id;
    const response = await subscriber.hGet("status", id as string);
    res.json({
        status: response
    })
})

const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(PORT);