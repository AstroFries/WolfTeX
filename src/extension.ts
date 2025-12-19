// src/extension.ts
import * as vscode from 'vscode';
import * as path from 'path';
import { WolframKernelService } from './wolframKernelService';

let kernelService: WolframKernelService | undefined;

export function activate(context: vscode.ExtensionContext) {
    const outputChannel = vscode.window.createOutputChannel('Wolfram Kernel');
    
    // Load configuration
    const config = vscode.workspace.getConfiguration('wolftex');
    const wolframPath = config.get<string>('wolframPath');
    const imageDirectory = config.get<string>('imageDirectory');
    const imageResolution = config.get<number>('imageResolution');

    kernelService = new WolframKernelService(context.extensionPath, outputChannel, {
        wolframPath,
        imageDirectory,
        imageResolution
    });
    context.subscriptions.push(outputChannel);

    // Register configuration change listener
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('wolftex')) {
            const newConfig = vscode.workspace.getConfiguration('wolftex');
            kernelService?.updateConfig({
                wolframPath: newConfig.get<string>('wolframPath'),
                imageDirectory: newConfig.get<string>('imageDirectory'),
                imageResolution: newConfig.get<number>('imageResolution')
            });
        }
    }));

    // Register restart command
    context.subscriptions.push(vscode.commands.registerCommand('wolftex.restartKernel', async () => {
        if (kernelService) {
            await vscode.window.withProgress({
                location: vscode.ProgressLocation.Notification,
                title: "Restarting Wolfram Kernel...",
                cancellable: false
            }, async () => {
                await kernelService!.restart();
            });
            vscode.window.showInformationMessage('Wolfram Kernel restarted.');
        }
    }));

    // 使用与 package.json 中完全相同的命令名
    let disposableHello = vscode.commands.registerCommand('wolftex.helloWorld', () => {
        vscode.window.showInformationMessage('Hello, VSCode!');
    });

    // 注册新命令：显示光标所在行的内容
    let disposableShowCursorLine = vscode.commands.registerCommand('wolftex.showCursorLine', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        const lineNumber = editor.selection.active.line;
        const lineText = editor.document.lineAt(lineNumber).text;
        vscode.window.showInformationMessage(lineText);
    });

    // 注册新命令：复制当前行到下一行（类似 Alt+Shift+Down）
    let disposableDuplicateLineBelow = vscode.commands.registerCommand('wolftex.duplicateLineBelow', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        const document = editor.document;
        const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        const lineNumbers = Array.from(new Set(editor.selections.map(selection => selection.active.line))).sort((a, b) => b - a);

        if (lineNumbers.length === 0) {
            return;
        }

        editor.edit(editBuilder => {
            for (const lineNumber of lineNumbers) {
                const lineText = document.lineAt(lineNumber).text;
                editBuilder.insert(document.lineAt(lineNumber).range.end, eol + lineText);
            }
        });
    });

    // 注册新命令：使用 wolframscript 执行当前行内容并插入输出
    let disposableEvaluateLineWithWolfram = vscode.commands.registerCommand('wolftex.evaluateLineWithWolfram', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        await evaluateLineWithWolfram(editor, {
            successMessage: 'Wolfram evaluation inserted.'
        });
    });

    // 注册新命令：将 wolframscript 输出转成 LaTeX 并插入
    let disposableEvaluateLineWithWolframLatex = vscode.commands.registerCommand('wolftex.evaluateLineWithWolframLatex', async () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        await evaluateLineWithWolfram(editor, {
            mode: 'latex',
            formatOutput: (output, indentation, eol) => {
                const wrapper = vscode.workspace.getConfiguration('wolftex').get<string>('latexWrapper') || 'inline';
                return formatAsLatexBlock(output, indentation, wrapper);
            },
            successMessage: 'Wolfram LaTeX inserted.'
        });
    });

    // Register Completion Item Provider
    const completionProvider = vscode.languages.registerCompletionItemProvider(
        ['latex', 'tex'],
        {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
                // Only trigger if the cursor is inside a comment (after an unescaped %)
                const lineText = document.lineAt(position.line).text;
                const prefix = lineText.substring(0, position.character);
                let isComment = false;
                for (let i = 0; i < prefix.length; i++) {
                    if (prefix[i] === '\\') {
                        i++; // Skip escaped character
                        continue;
                    }
                    if (prefix[i] === '%') {
                        isComment = true;
                        break;
                    }
                }

                if (!isComment) {
                    return undefined;
                }

                if (!kernelService) {
                    return undefined;
                }

                return kernelService.getSystemNames().then(names => {
                    return names.map(name => {
                        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Function);
                        item.detail = "Wolfram System Name";
                        return item;
                    });
                });
            }
        }
    );

    // Register Signature Help Provider
    const signatureProvider = vscode.languages.registerSignatureHelpProvider(
        ['latex', 'tex'],
        {
            async provideSignatureHelp(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.SignatureHelpContext) {
                if (!kernelService) {
                    return undefined;
                }

                // 1. Check if inside comment
                const lineText = document.lineAt(position.line).text;
                const prefix = lineText.substring(0, position.character);
                let isComment = false;
                for (let i = 0; i < prefix.length; i++) {
                    if (prefix[i] === '\\') {
                        i++; // Skip escaped character
                        continue;
                    }
                    if (prefix[i] === '%') {
                        isComment = true;
                        break;
                    }
                }
                if (!isComment) return undefined;

                // 2. Find the function name by walking backwards
                // We need to find the nearest unclosed '['
                let balance = 0;
                let functionName = "";
                
                // Scan backwards from cursor
                for (let i = position.character - 1; i >= 0; i--) {
                    const char = lineText[i];
                    if (char === ']') {
                        balance++;
                    } else if (char === '[') {
                        if (balance > 0) {
                            balance--;
                        } else {
                            // Found the opening bracket!
                            // Now get the word before it
                            const textBefore = lineText.substring(0, i);
                            const match = textBefore.match(/([a-zA-Z0-9`]+)\s*$/);
                            if (match) {
                                functionName = match[1];
                            }
                            break;
                        }
                    }
                }

                if (!functionName) {
                    return undefined;
                }

                // 3. Fetch usage
                const usage = await kernelService.getFunctionUsage(functionName);
                if (!usage) {
                    return undefined;
                }

                const signatureHelp = new vscode.SignatureHelp();
                signatureHelp.signatures = [
                    new vscode.SignatureInformation(functionName, new vscode.MarkdownString(usage))
                ];
                signatureHelp.activeSignature = 0;
                signatureHelp.activeParameter = 0;

                return signatureHelp;
            }
        },
        '[', ','
    );

    context.subscriptions.push(
        disposableHello,
        disposableShowCursorLine,
        disposableDuplicateLineBelow,
        disposableEvaluateLineWithWolfram,
        disposableEvaluateLineWithWolframLatex,
        completionProvider,
        signatureProvider
    );
}

export function deactivate() {
    if (kernelService) {
        kernelService.dispose();
    }
}

type EvaluateLineOptions = {
    mode?: 'plain' | 'latex';
    formatOutput?: (output: string, indentation: string, eol: string) => string[];
    successMessage?: string;
};

async function evaluateLineWithWolfram(editor: vscode.TextEditor, options?: EvaluateLineOptions) {
    if (!kernelService) {
        vscode.window.showErrorMessage('Wolfram kernel service is not initialized.');
        return;
    }

    const document = editor.document;
    const eol = document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    
    // Get unique line numbers from all selections
    const lineNumbers = Array.from(new Set(editor.selections.map(s => s.active.line))).sort((a, b) => a - b);
    
    if (lineNumbers.length === 0) {
        return;
    }

    const cwd = document.uri.scheme === 'file' ? path.dirname(document.uri.fsPath) : undefined;
    const filename = document.uri.scheme === 'file' ? path.basename(document.uri.fsPath) : undefined;

    try {
        await vscode.window.withProgress({
            location: vscode.ProgressLocation.Notification,
            title: lineNumbers.length > 1 ? `Wolfram Kernel: Evaluating ${lineNumbers.length} lines...` : "Wolfram Kernel: Evaluating...",
            cancellable: false
        }, async (progress) => {
            const results: { lineNumber: number, text: string, lineCount: number }[] = [];
            const isDebug = vscode.workspace.getConfiguration('wolftex').get<boolean>('debug') || false;
            
            for (let i = 0; i < lineNumbers.length; i++) {
                const lineNumber = lineNumbers[i];
                const rawLineText = document.lineAt(lineNumber).text;
                const indentation = rawLineText.match(/^\s*/)?.[0] ?? '';
                const code = stripLeadingPercent(rawLineText);

                if (!code) {
                    continue;
                }

                if (lineNumbers.length > 1) {
                    progress.report({ message: `Line ${lineNumber + 1}...`, increment: (1 / lineNumbers.length) * 100 });
                }

                const startTime = Date.now();
                const result = await kernelService!.evaluate(code, options?.mode ?? 'plain', cwd, filename);
                const duration = Date.now() - startTime;
                
                if (result.startsWith("Error:")) {
                    vscode.window.showErrorMessage(`Line ${lineNumber + 1} Failed: ${result.substring(6).trim()}`);
                }

                let formattedLines = options?.formatOutput
                    ? options.formatOutput(result, indentation, eol)
                    : formatAsComments(result, indentation);

                if (isDebug) {
                    formattedLines.push(`${indentation}% [Debug] Execution time: ${duration}ms`);
                }

                results.push({
                    lineNumber,
                    text: `${eol}${formattedLines.join(eol)}`,
                    lineCount: formattedLines.length
                });
            }

            if (results.length > 0) {
                await editor.edit(editBuilder => {
                    for (const res of results) {
                        const insertPosition = document.lineAt(res.lineNumber).range.end;
                        editBuilder.insert(insertPosition, res.text);
                    }
                });

                // Select the newly inserted lines
                const newSelections: vscode.Selection[] = [];
                let cumulativeOffset = 0;
                for (const res of results) {
                    if (res.lineCount > 0) {
                        const startLine = res.lineNumber + cumulativeOffset + 1;
                        const endLine = startLine + res.lineCount - 1;
                        const lastLine = editor.document.lineAt(endLine);
                        newSelections.push(new vscode.Selection(
                            new vscode.Position(startLine, 0),
                            lastLine.range.end
                        ));
                    }
                    cumulativeOffset += res.lineCount;
                }
                
                if (newSelections.length > 0) {
                    editor.selections = newSelections;
                }
            }
        });

        if (options?.successMessage) {
            vscode.window.showInformationMessage(options.successMessage);
        }
    } catch (error: any) {
        vscode.window.showErrorMessage(`Wolfram error: ${error.message ?? error}`);
    }
}

function stripLeadingPercent(text: string): string {
    return text.replace(/^\s*%+\s*/, '').trim();
}

function formatAsComments(output: string, indentation: string): string[] {
    return output.split(/\r?\n/).map(line => `${indentation}% ${line}`);
}

function formatAsLatexBlock(output: string, indentation: string, wrapper: string = 'inline'): string[] {
    // 如果输出中已经包含 `$` 或 `\[`，认为不需要再包裹，直接插入原始输出
    if (output.includes('$') || output.includes('\\[') || wrapper === 'none') {
        return output.split(/\r?\n/).map(line => `${indentation}${line}`);
    }

    const lines = output.split(/\r?\n/);
    if (lines.length === 0) {
        return [];
    }

    const startDelim = wrapper === 'display' ? '\\[' : '$';
    const endDelim = wrapper === 'display' ? '\\]' : '$';

    // 单行情况
    if (lines.length === 1) {
        return [`${indentation}${startDelim} ${lines[0]} ${endDelim}`];
    }
    const result: string[] = [];
    result.push(`${indentation}${startDelim} ${lines[0]}`);
    for (let i = 1; i < lines.length - 1; i++) {
        result.push(`${indentation}${lines[i]}`);
    }
    result.push(`${indentation}${lines[lines.length - 1]} ${endDelim}`);
    return result;
}