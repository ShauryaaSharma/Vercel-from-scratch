import express from "express";
import cors from "cors";
import {simpleGit} from "simple-git";
import { generate } from "./utils.js";
import { getAllFiles } from "./file.js";
import { fileURLToPath } from "url";
import path from "path";
import { uploadFile } from "./aws.js";
import { createClient } from "redis";
const publisher = createClient();
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

    files.forEach(async file => {
        await uploadFile(file.slice(__dirname.length+1).split(path.sep).join("/"), file);
    })

    publisher.lPush("build-queue", id);

    res.json({
        id: id
    })
})

app.listen(3000);