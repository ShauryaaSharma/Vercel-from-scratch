import dotenv from "dotenv"
dotenv.config();
import pkg from "aws-sdk";
const { S3 } = pkg;
import fs from "fs";
import path from "path";

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

export async function downloadS3Folder(prefix: string){
    console.log(prefix);
    const allFiles = await s3.listObjectsV2({
        Bucket: "vercel",
        Prefix: prefix
    }).promise();

    const allPromise = allFiles.Contents?.map(async({Key}) =>{
        return new Promise(async(resolve) => {
            if(!Key){
                resolve("");
                return;
            }
            const finalOutputPath = path.join(import.meta.dirname, Key);
            const dirName = path.dirname(finalOutputPath);
            if(!fs.existsSync(dirName)){
                fs.mkdirSync(dirName, {recursive: true});
            }
            const outputFile = fs.createWriteStream(finalOutputPath);
            s3.getObject({
                Bucket: "vercel",
                Key
            }).createReadStream().pipe(outputFile).on("finish", () => {
                resolve("");
            })
        })
    }) || []
    console.log("awaiting");

    await Promise.all(allPromise?.filter(x => x !== undefined));
    console.log("downloaded");
}

export async function copyFinalDist(id: string){
    const folderPath = path.join(import.meta.dirname, `output/${id}/dist`);
    const allFiles = getAllFiles(folderPath);
    await Promise.all(allFiles.map(file =>
        uploadFile(`dist/${id}/` + file.slice(folderPath.length + 1), file)
    ));
}

const getAllFiles = (folderPath: string) => {
    let response: string[] = [];

    const allFilesAndFolder = fs.readdirSync(folderPath);
    allFilesAndFolder.forEach(file => {
        const fullFilePath = path.join(folderPath, file);
        if (fs.statSync(fullFilePath).isDirectory()){
            response = response.concat(getAllFiles(fullFilePath));
        }else{
            response.push(fullFilePath);
        }
    });

    return response;
}

const uploadFile = async (fileName: string, localFilePath: string) => {
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: "vercel",
        Key: fileName
    }).promise();
    console.log(response);
}