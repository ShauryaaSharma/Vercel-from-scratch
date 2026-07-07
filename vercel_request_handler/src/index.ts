import express from "express";
import dotenv from "dotenv"
dotenv.config();
import pkg from "aws-sdk";
const { S3 } = pkg;

const app = express();

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

        const type = filePath.endsWith("html") ? "text/html" : filePath.endsWith("css") ? "text/css" : "application/javascript"
        res.set("Content-Type", type);

        res.send(contents.Body);
    } catch (err) {
        res.status(404).send("Not found");
    }
})

app.listen(3001);