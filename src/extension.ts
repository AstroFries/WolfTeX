// src/extension.ts
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
    // 使用与 package.json 中完全相同的命令名
    let disposableHello = vscode.commands.registerCommand('mmatex.helloWorld', () => {
        vscode.window.showInformationMessage('Hello, VSCode!');
    });

    // 注册新命令：显示光标所在行的内容
    let disposableShowCursorLine = vscode.commands.registerCommand('mmatex.showCursorLine', () => {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showInformationMessage('No active text editor');
            return;
        }

        const lineNumber = editor.selection.active.line;
        const lineText = editor.document.lineAt(lineNumber).text;
        vscode.window.showInformationMessage(lineText);
    });

    context.subscriptions.push(disposableHello, disposableShowCursorLine);
}

export function deactivate() {}