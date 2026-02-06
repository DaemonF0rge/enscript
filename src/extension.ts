import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext) {
    const serverModule = path.join(__dirname, '..', 'server', 'out', 'index.js');

    const debugOptions = { execArgv: ['--nolazy', '--inspect=6009'] };

    const serverOptions: ServerOptions = {
        run:   { module: serverModule, transport: TransportKind.ipc },
        debug: { module: serverModule, transport: TransportKind.ipc, options: debugOptions }
    };

    const clientOptions: LanguageClientOptions = {
        documentSelector: [{ language: 'enscript' }],
        synchronize: {
            configurationSection: 'enscript',
            fileEvents: vscode.workspace.createFileSystemWatcher('**/*.c'),
        },
        initializationOptions: {
            includePaths: vscode.workspace.getConfiguration('enscript').get<string[]>('includePaths') || []
        },
    };

    client = new LanguageClient(
        'EnscriptLS',
        'Enscript Language Server',
        serverOptions,
        clientOptions
    );
    client.start();
    context.subscriptions.push(client);
    
    // Listen for indexing complete notification - refresh diagnostics on open files
    client.onNotification('enscript/indexingComplete', (params: { fileCount: number }) => {
        vscode.window.showInformationMessage(`Enscript: Indexed ${params.fileCount} files. Refreshing diagnostics...`);
        
        // Trigger a re-validation of all open enscript documents
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'enscript') {
                // Force a change event by doing a no-op edit
                const edit = new vscode.WorkspaceEdit();
                // Insert and immediately remove an empty string to trigger didChangeContent
                edit.insert(doc.uri, new vscode.Position(0, 0), '');
                vscode.workspace.applyEdit(edit);
            }
        }
    });

    context.subscriptions.push(
        vscode.commands.registerCommand('enscript.restartServer', () => client?.restart())
    );
    
    context.subscriptions.push(
        vscode.commands.registerCommand('enscript.checkWorkspace', async () => {
            vscode.window.showInformationMessage('Enscript: Checking all workspace files...');
            
            const response = await client?.sendRequest('enscript/checkWorkspace') as { 
                filesChecked: number; 
                filesWithIssues: number; 
                totalIssues: number 
            } | undefined;
            
            if (response) {
                vscode.window.showInformationMessage(
                    `Enscript: Checked ${response.filesChecked} files. ` +
                    `Found ${response.totalIssues} issues in ${response.filesWithIssues} files.`
                );
            }
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('enscript.dumpDiagnostics', async () => {
        const response = await client?.sendRequest('enscript/dumpDiagnostics');

        if (!response) {
            vscode.window.showInformationMessage('No diagnostics returned.');
            return;
        }

        const json = JSON.stringify(response, null, 4); // Pretty-print with 4 spaces

        const doc = await vscode.workspace.openTextDocument({
            language: 'json',
            content: json
        });

        await vscode.window.showTextDocument(doc);
    })
    )
}

export function deactivate(): Thenable<void> | undefined {
    return client?.stop();
}
