import {
    createConnection,
    TextDocuments,
    TextDocumentSyncKind,
    ProposedFeatures,
    InitializeParams,
    InitializeResult,
    ConfigurationItem
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { registerAllHandlers } from './lsp/registerAll';
import * as url from 'node:url';
import * as fs from 'fs/promises';
import { findAllFiles, readFileUtf8 } from './util/fs';
import { Analyzer } from './analysis/project/graph';
import { getConfiguration } from './util/config';


// Create LSP connection (stdio or Node IPC autodetect).
const connection = createConnection(ProposedFeatures.all);

// Track open documents — in-memory mirror of the client.
export const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

let workspaceRoots: string[] = [];

connection.onInitialize((_params: InitializeParams): InitializeResult => {
    const folders = _params.workspaceFolders ?? [];
    if (folders.length > 0) {
        workspaceRoots = folders.map(f => url.fileURLToPath(f.uri));
    } else if (_params.rootUri) {
        workspaceRoots = [url.fileURLToPath(_params.rootUri)];
    }

    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            completionProvider: { resolveProvider: false, triggerCharacters: ['.', '>', ':'] },
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true,
            renameProvider: true,
            workspaceSymbolProvider: true
        }
    };
});

connection.onInitialized(async () => {
    const config = await getConfiguration(connection);
    const includePaths = config.includePaths as string[] || [];
    const preprocessorDefines = config.preprocessorDefines as string[] || [];
    
    // Store include paths on the analyzer so diagnostics can be suppressed
    if (includePaths.length > 0) {
        Analyzer.instance().setIncludePaths(includePaths);
    }
    Analyzer.instance().setWorkspaceRoots(workspaceRoots);
    
    // Configure preprocessor defines
    if (preprocessorDefines.length > 0) {
        Analyzer.instance().setPreprocessorDefines(preprocessorDefines);
        console.log(`Preprocessor defines: ${preprocessorDefines.join(', ')}`);
    }

    const pathsToIndex = [...workspaceRoots, ...includePaths];
    const allFiles: string[] = [];
    const seenRealPaths = new Set<string>();

    for (const basePath of pathsToIndex) {
        console.log(`Adding folder ${basePath} to indexing`);
        try {
            const files = await findAllFiles(basePath, ['.c']);
            for (const file of files) {
                // Deduplicate by resolved real path (handles subst drives, junctions, symlinks)
                try {
                    const realPath = await fs.realpath(file);
                    const normalizedReal = realPath.toLowerCase();
                    if (!seenRealPaths.has(normalizedReal)) {
                        seenRealPaths.add(normalizedReal);
                        allFiles.push(file);
                    }
                } catch {
                    // If realpath fails, include the file anyway
                    allFiles.push(file);
                }
            }
        } catch (err) {
            console.warn(`Failed to scan path: ${basePath} – ${String(err)}`);
        }
    }

    console.log(`Indexing ${allFiles.length} EnScript files (${seenRealPaths.size} unique)...`);

    // Notify client that indexing is starting
    connection.sendNotification('enscript/indexingStart', { 
        fileCount: allFiles.length
    });

    const startTime = Date.now();
    let lastProgressUpdate = 0;

    for (let i = 0; i < allFiles.length; i++) {
        const filePath = allFiles[i];
        const uri = url.pathToFileURL(filePath).toString();
        
        const text = await readFileUtf8(filePath);
        const doc = TextDocument.create(uri, 'enscript', 1, text);
        Analyzer.instance().parseAndCache(doc);

        // Send progress updates at most every 500ms
        const now = Date.now();
        if (now - lastProgressUpdate >= 500) {
            connection.sendNotification('enscript/indexingProgress', { 
                current: i + 1,
                total: allFiles.length,
                percent: Math.round((i + 1) / allFiles.length * 100)
            });
            lastProgressUpdate = now;
        }
    }
    
    const elapsed = Date.now() - startTime;

    const stats = Analyzer.instance().getIndexStats();
    const moduleNames: Record<number, string> = { 1: '1_Core', 2: '2_GameLib', 3: '3_Game', 4: '4_World', 5: '5_Mission' };
    console.log(
        `Indexing complete in ${elapsed}ms: ${stats.files} files, ` +
        `${stats.classes} classes, ${stats.functions} functions, ` +
        `${stats.enums} enums, ${stats.typedefs} typedefs, ${stats.globals} globals` +
        (stats.parseErrors > 0 ? ` (${stats.parseErrors} parse errors)` : '')
    );
    // Log per-module file counts
    const modParts = Object.entries(stats.moduleCounts)
        .sort(([a], [b]) => Number(a) - Number(b))
        .map(([m, count]) => `${moduleNames[Number(m)] || m}: ${count}`);
    if (modParts.length > 0) {
        console.log(`  Modules: ${modParts.join(', ')}`);
    }
    
    // Notify client that indexing is complete - trigger refresh of open files
    connection.sendNotification('enscript/indexingComplete', { 
        fileCount: allFiles.length,
        workspaceRoots: workspaceRoots 
    });
});

// Handle request to check all workspace files
connection.onRequest('enscript/checkWorkspace', async () => {
    console.log(`Checking all workspace files in ${workspaceRoots.join(', ')}...`);
    
    const allCheckFiles: string[] = [];
    for (const root of workspaceRoots) {
        const found = await findAllFiles(root, ['.c']);
        allCheckFiles.push(...found);
    }
    const files = allCheckFiles;
    const allDiagnostics: Array<{ uri: string; diagnostics: any[] }> = [];
    
    for (const filePath of files) {
        const uri = url.pathToFileURL(filePath).toString();
        const text = await readFileUtf8(filePath);
        const doc = TextDocument.create(uri, 'enscript', 1, text);
        
        const diagnostics = Analyzer.instance().runDiagnostics(doc);
        if (diagnostics.length > 0) {
            allDiagnostics.push({ uri, diagnostics });
            // Publish diagnostics so they show in Problems panel
            connection.sendDiagnostics({ uri, diagnostics });
        }
    }
    
    console.log(`Checked ${files.length} files, found issues in ${allDiagnostics.length} files`);

    // Verbose breakdown by diagnostic category
    if (allDiagnostics.length > 0) {
        let unknownTypes = 0, typeMismatches = 0, duplicateVars = 0, multiLine = 0, crossModule = 0, parserDiags = 0;
        for (const { diagnostics } of allDiagnostics) {
            for (const d of diagnostics) {
                const msg = d.message;
                if (msg.startsWith('Unknown type') || msg.startsWith('Unknown base class')) unknownTypes++;
                else if (msg.includes('cannot be used from') || msg.includes('cannot be extended from')) crossModule++;
                else if (msg.startsWith('Type mismatch') || msg.startsWith('Unsafe downcast')) typeMismatches++;
                else if (msg.includes('already declared')) duplicateVars++;
                else if (msg.includes('Multi-line')) multiLine++;
                else parserDiags++;
            }
        }
        const parts: string[] = [];
        if (unknownTypes)   parts.push(`${unknownTypes} unknown types`);
        if (crossModule)     parts.push(`${crossModule} cross-module`);
        if (typeMismatches)  parts.push(`${typeMismatches} type mismatches`);
        if (duplicateVars)   parts.push(`${duplicateVars} duplicate vars`);
        if (multiLine)       parts.push(`${multiLine} multi-line`);
        if (parserDiags)     parts.push(`${parserDiags} parser warnings`);
        console.log(`  Breakdown: ${parts.join(', ')}`);
    }
    return { 
        filesChecked: files.length, 
        filesWithIssues: allDiagnostics.length,
        totalIssues: allDiagnostics.reduce((sum, d) => sum + d.diagnostics.length, 0)
    };
});

// Re-validate every open enscript document (called by the client after indexing completes)
connection.onNotification('enscript/revalidateOpenFiles', () => {
    const analyser = Analyzer.instance();
    for (const doc of documents.all()) {
        if (!analyser.isWorkspaceFile(doc.uri)) {
            continue;
        }
        const diagnostics = analyser.runDiagnostics(doc);
        connection.sendDiagnostics({ uri: doc.uri, diagnostics });
    }
});

// Wire all feature handlers.
registerAllHandlers(connection, documents);

documents.listen(connection);

// Start listening after the handlers were registered.
connection.listen();
