import { ChildProcess, spawn } from 'child_process';
import { OutputChannel } from 'vscode';
import * as net from 'net';
import * as path from 'path';

export type WolframEvaluationMode = 'plain' | 'latex';

export interface WolframConfig {
    wolframPath?: string;
    imageDirectory?: string;
    imageResolution?: number;
}

export class WolframKernelService {
    private process?: ChildProcess;
    private port?: number;
    private initPromise: Promise<void> = Promise.resolve();
    private disposed = false;
    private outputChannel?: OutputChannel;

    private systemNames: string[] = [];
    private currentEvaluationOutputs: string[] = [];
    private isEvaluating: boolean = false;

    // Configuration
    private wolframPath: string = 'wolframscript';
    private imageDirectory: string = 'wolf_image';
    private imageResolution: number = 150;

    private extensionPath: string;

    constructor(extensionPath: string, outputChannel?: OutputChannel, config?: WolframConfig) {
        this.outputChannel = outputChannel;
        this.extensionPath = extensionPath;
        if (config) this.updateConfig(config, false);
        this.initPromise = this.startKernel(this.extensionPath).then(() => {
            this.getSystemNames().catch(err => this.error(`Failed to fetch system names: ${err}`));
        });
    }

    /** Update configuration. If restartKernel is true and wolframPath changed, restart kernel. */
    updateConfig(config: WolframConfig, restartKernel = true) {
        const prevPath = this.wolframPath;
        if (config.wolframPath) this.wolframPath = config.wolframPath;
        if (config.imageDirectory) this.imageDirectory = config.imageDirectory;
        if (typeof config.imageResolution === 'number') this.imageResolution = config.imageResolution;

        if (restartKernel && config.wolframPath && config.wolframPath !== prevPath) {
            // restart kernel with new executable
            this.log(`Wolfram path changed from ${prevPath} to ${this.wolframPath}, restarting kernel.`);
            this.restart().catch(err => this.error(`Failed to restart kernel: ${err}`));
        }
    }

    /** Restart the kernel process. */
    async restart(): Promise<void> {
        try {
            this.dispose();
            this.disposed = false;
            this.initPromise = this.startKernel(this.extensionPath);
            await this.initPromise;
            await this.getSystemNames();
        } catch (e) {
            this.error(`Restart failed: ${e}`);
            throw e;
        }
    }

    private log(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[Kernel] ${message}`);
        } else {
            console.log(`[Kernel] ${message}`);
        }
    }

    private error(message: string) {
        if (this.outputChannel) {
            this.outputChannel.appendLine(`[Kernel Error] ${message}`);
        } else {
            console.error(`[Kernel Error] ${message}`);
        }
    }

    private startKernel(extensionPath: string): Promise<void> {
        return new Promise((resolve, reject) => {
            const scriptPath = path.join(extensionPath, 'dist', 'kernel.wls');
            this.log(`Starting kernel server from: ${scriptPath}`);

            // Use configured wolframPath if provided
            const execPath = this.wolframPath || 'wolframscript';
            this.process = spawn(execPath, ['-f', scriptPath], {
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, QT_QPA_PLATFORM: 'offscreen' }
            });

            if (!this.process.stdout) {
                reject(new Error('Failed to open stdout for kernel process'));
                return;
            }

            this.process.stderr?.on('data', (data) => {
                const str = data.toString();
                this.log(`STDERR: ${str}`);
                if (this.isEvaluating) {
                    // Split by newline to handle multiple lines in one chunk
                    const lines = str.split(/\r?\n/);
                    this.currentEvaluationOutputs.push(...lines);
                }
            });

            this.process.on('error', (err) => {
                this.error(`Failed to start kernel: ${err.message}`);
                reject(err);
            });

            this.process.on('close', (code) => {
                this.log(`Kernel exited with code ${code}`);
                this.process = undefined;
                this.port = undefined;
            });

            // Listen for stdout
            let stdoutBuffer = '';
            let portFound = false;

            this.process.stdout.on('data', (data: Buffer) => {
                const str = data.toString();
                this.log(`STDOUT: ${str.trim()}`);
                
                if (this.isEvaluating) {
                    // Split by newline to handle multiple lines in one chunk
                    const lines = str.split(/\r?\n/);
                    this.currentEvaluationOutputs.push(...lines);
                }

                if (!portFound) {
                    stdoutBuffer += str;
                    const match = stdoutBuffer.match(/PORT:(\d+)/);
                    if (match) {
                        this.port = parseInt(match[1], 10);
                        this.log(`Kernel server listening on port ${this.port}`);
                        portFound = true;
                        resolve();
                    }
                }
            });
        });
    }

    async getSystemNames(): Promise<string[]> {
        if (this.systemNames.length > 0) {
            return this.systemNames;
        }
        try {
            const result = await this.sendRequest({ type: 'completion' });
            if (Array.isArray(result)) {
                this.systemNames = result;
                this.log(`Fetched ${result.length} system names for completion.`);
                return result;
            }
        } catch (e) {
            this.error(`Failed to fetch system names: ${e}`);
        }
        return [];
    }

    async getFunctionUsage(name: string): Promise<string> {
        try {
            const result = await this.sendRequest({ type: 'usage', name });
            return typeof result === 'string' ? result : "";
        } catch (e) {
            this.error(`Failed to fetch usage for ${name}: ${e}`);
            return "";
        }
    }

    private async sendRequest(requestObj: any): Promise<any> {
        if (this.disposed) {
            throw new Error('Wolfram kernel service has been disposed.');
        }

        await this.initPromise;

        if (!this.port) {
            throw new Error('Kernel server is not running.');
        }

        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            
            socket.connect(this.port!, '127.0.0.1', () => {
                // Prepare request (Newline Delimited JSON)
                const request = JSON.stringify(requestObj) + '\n';
                socket.write(request);
            });

            let responseBuffer = '';

            socket.on('data', (data) => {
                responseBuffer += data.toString('utf8');

                // Check for newline
                if (responseBuffer.includes('\n')) {
                    const parts = responseBuffer.split('\n');
                    // Take the first part as the response
                    const responseStr = parts[0];
                    
                    try {
                        const result = JSON.parse(responseStr);
                        socket.end();
                        resolve(result);
                    } catch (e: any) {
                        this.error(`Failed to parse response: ${e.message}`);
                        reject(e);
                    }
                }
            });

            socket.on('error', (err) => {
                this.error(`Socket error: ${err.message}`);
                reject(err);
            });
        });
    }

    async evaluate(code: string, mode: WolframEvaluationMode, cwd?: string, filename?: string): Promise<string> {
        this.log(`Evaluating: ${code.substring(0, 50)}...`);
        this.isEvaluating = true;
        this.currentEvaluationOutputs = [];
        
        try {
            const result = await this.sendRequest({ type: 'evaluate', code, mode, cwd: cwd || '', filename: filename || '' });
            
            if (result === "Error: Evaluation failed") {
                // Give a small grace period for stdout to flush to avoid race conditions
                await new Promise(resolve => setTimeout(resolve, 100));

                // Try to find a relevant error message in the outputs
                // Filter out internal kernel logs
                const errorMessages = this.currentEvaluationOutputs
                    .map(s => s.trim())
                    .filter(s => s.length > 0 && !s.startsWith('[Kernel]') && !s.startsWith('STDOUT:') && !s.startsWith('STDERR:'));
                
                if (errorMessages.length > 0) {
                    // Join them or take the first one that looks like a message (contains ::)
                    const specificError = errorMessages.find(s => s.includes('::')) || errorMessages[0];
                    return `Error: ${specificError}`;
                }
            }
            return result;
        } finally {
            this.isEvaluating = false;
        }
    }

    dispose() {
        this.disposed = true;
        this.log('Wolfram kernel service disposed.');
        if (this.process) {
            this.log('Killing Wolfram process (SIGKILL)...');
            this.process.kill('SIGKILL');
            this.process = undefined;
        }
    }
}
