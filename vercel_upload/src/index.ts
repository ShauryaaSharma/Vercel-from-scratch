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

app.post("/deploy", async (req, res) => {
    const repoURL = req.body.repoURL;
    console.log(repoURL);
    const id = generate();
    await simpleGit().clone(repoURL, path.join(__dirname, `output/${id}`));
    
    const files = getAllFiles(path.join(__dirname, `output/${id}`));
    console.log(files);

    await Promise.all(files.map(file =>
        uploadFile(file.slice(__dirname.length+1).split(path.sep).join("/"), file)
    ));

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

app.listen(3000);