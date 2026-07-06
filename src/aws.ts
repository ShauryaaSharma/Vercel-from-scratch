import dotenv from "dotenv"
dotenv.config();
import pkg from "aws-sdk";
const { S3 } = pkg;
import fs from "fs";

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

export const uploadFile = async (fileName: string, localFilePath: string) => {
    console.log("called");
    const fileContent = fs.readFileSync(localFilePath);
    const response = await s3.upload({
        Body: fileContent,
        Bucket: "vercel",
        Key: fileName
    }).promise();
    console.log(response);
}