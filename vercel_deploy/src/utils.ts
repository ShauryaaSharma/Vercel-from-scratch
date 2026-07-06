import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const SAFE_ID = /^[a-zA-Z0-9_-]+$/;

export function isValidId(id: string): boolean {
    return SAFE_ID.test(id);
}

export function buildProject(id: string) {
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

        const install = spawn(npmCmd, ["install", "--include=dev"], { cwd: outputPath, shell: useShell });

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

            const build = spawn(npmCmd, ["run", "build"], { cwd: outputPath, shell: useShell });

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
