import express from "express";
import path from "path";
import dotenv from "dotenv"
dotenv.config();
import pkg from "aws-sdk";
const { S3 } = pkg;

const app = express();

// Map file extensions to their MIME type so assets (images, fonts, json…)
// are served with the correct Content-Type and render in the browser.
const MIME_TYPES: Record<string, string> = {
    ".html": "text/html",
    ".css": "text/css",
    ".js": "application/javascript",
    ".mjs": "application/javascript",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".webp": "image/webp",
    ".ico": "image/x-icon",
    ".woff": "font/woff",
    ".woff2": "font/woff2",
    ".ttf": "font/ttf",
    ".txt": "text/plain",
};

function requireEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

const ACCESS_KEY_ID = requireEnv("ACCESS_KEY_ID");
const SECRET_ACCESS_KEY = requireEnv("SECRET_ACCESS_KEY");
const ENDPOINT_FOR_S3 = requireEnv("ENDPOINT_FOR_S3");

const s3 = new S3({
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET_ACCESS_KEY,
    endpoint: ENDPOINT_FOR_S3
})

app.get("/{*any}", async (req, res) => {
    const host = req.hostname;
    console.log(host);
    const id = host.split(".")[0];
    console.log(id);
    let filePath = req.path;
    // Directory paths (e.g. "/") have no object in S3; serve their index.html.
    if (filePath === "/" || filePath.endsWith("/")) {
        filePath += "index.html";
    }

    try {
        const contents = await s3.getObject({
            Bucket: "vercel",
            Key: `dist/${id}${filePath}`
        }).promise();

        const type = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        res.set("Content-Type", type);

        res.send(contents.Body);
    } catch (err) {
        res.status(404).send("Not found");
    }
})

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT);