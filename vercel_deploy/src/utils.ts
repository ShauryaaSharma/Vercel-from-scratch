import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function isValidId(id: string): boolean {
    return SAFE_ID.test(id);
}

export function buildProject(id: string, envVars: Record<string, string> = {}) {
    return new Promise<void>((resolve, reject) => {
        if (!isValidId(id)) {
            reject(new Error(`Invalid id: ${id}`));
            return;
        }

        const outputPath = path.join(import.meta.dirname, `output/${id}`);

        if (!fs.existsSync(outputPath)) {
            reject(new Error(`Output path does not exist, nothing was downloaded for id: ${id}`));
            return;
        }

        if (!fs.existsSync(path.join(outputPath, "package.json"))) {
            reject(new Error(`No package.json found in downloaded project for id: ${id}`));
            return;
        }

        const npmCmd = process.platform === "win32" ? "npm.cmd" : "npm";
        const useShell = process.platform === "win32";

        // Explicit, minimal environment for the untrusted project's install/build
        // scripts. Deliberately does NOT spread process.env — this worker's own
        // env holds R2/S3 credentials and the Redis URL, which a malicious
        // postinstall/build script could otherwise read and exfiltrate. Only
        // PATH/HOME (needed to resolve node/npm and caches) and the deployer's
        // own requested variables are passed through.
        const childEnv: NodeJS.ProcessEnv = {
            ...envVars,
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
        };
        if (process.env.ComSpec) {
            childEnv.ComSpec = process.env.ComSpec;
        }

        const install = spawn(npmCmd, ["install", "--include=dev"], { cwd: outputPath, shell: useShell, env: childEnv });

        install.stdout?.on('data', function(data) {
            console.log('stdout: ' + data);
        });
        install.stderr?.on('data', function(data) {
            console.log('stderr: ' + data);
        });
        install.on('error', function(err) {
            reject(err);
        });

        install.on('close', function(code) {
            if (code !== 0) {
                reject(new Error(`npm install failed with code ${code}`));
                return;
            }

            // --base=/<id>/ makes Vite emit asset URLs like /<id>/assets/x.js
            // instead of /assets/x.js, so the site works when served from a
            // path prefix (no wildcard subdomain/custom domain required).
            const build = spawn(npmCmd, ["run", "build", "--", `--base=/${id}/`], { cwd: outputPath, shell: useShell, env: childEnv });

            build.stdout?.on('data', function(data) {
                console.log('stdout: ' + data);
            });
            build.stderr?.on('data', function(data) {
                console.log('stderr: ' + data);
            });
            build.on('error', function(err) {
                reject(err);
            });

            build.on('close', function(code) {
                if (code !== 0) {
                    reject(new Error(`npm run build failed with code ${code}`));
                    return;
                }
                resolve();
            });
        });
    })
}
