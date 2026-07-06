import { createClient } from "redis";
import { downloadS3Folder, copyFinalDist } from "./aws.js";
import { buildProject, isValidId } from "./utils.js";
const subscriber = process.env.REDIS_URL
    ? createClient({ url: process.env.REDIS_URL })
    : createClient();
subscriber.connect();

async function main(){
    while(1){
        const res = await subscriber.brPop('build-queue', 0);
        // @ts-ignore
        const id = res.element;

        if (!isValidId(id)) {
            console.error(`Skipping job with invalid id: ${id}`);
            continue;
        }

        try {
            await downloadS3Folder(`output/${id}`);
            console.log(res);
            await buildProject(id);
            await copyFinalDist(id);
        } catch (err) {
            console.error(`Job failed for id ${id}:`, err);
        }
    }
}

main();