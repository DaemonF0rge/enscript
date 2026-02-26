/**
 * Analyzer (Graph) Module - Enforce Script LSP
 * ==============================================
 * 
 * Central code intelligence facade that coordinates parsing, symbol indexing,
 * and LSP query handling. Uses singleton pattern for shared state.
 * 
 * KEY RESPONSIBILITIES:
 *   - Document parsing and caching (ensure())
 *   - Symbol resolution at cursor position
 *   - Workspace-wide symbol search
 *   - Go-to-definition navigation
 *   - Hover information
 *   - Code completions
 *   - Reference finding
 * 
 * CACHING STRATEGY:
 *   - Documents are parsed on-demand and cached by URI + version
 *   - Cache hit returns immediately if version matches
 *   - Parse errors return empty stubs to allow graceful degradation
 * 
 * IMPROVEMENTS NEEDED (from JS version fixes):
 * 
 * 1. THREE-TIER SYMBOL SEARCH PRIORITY
 *    Current: Simple .includes() matching
 *    Needed: Prioritize exact > prefix > contains matches
 * 
 * 2. ENUM MEMBER KIND FILTERING
 *    Current: All symbols returned regardless of kind filter
 *    Needed: Respect kinds filter for enum members
 * 
 * 3. NON-VOID RETURN TYPE PREFERENCE
 *    When multiple symbols have same name, prefer ones with return types
 *    Why: Breaks method chaining resolution when wrong symbol selected
 * 
 * @module enscript/server/src/analysis/project/graph
 */

import { TextDocument } from 'vscode-languageserver-textdocument';
import { Position, Range, Location, SymbolInformation, SymbolKind, Diagnostic, DiagnosticSeverity } from 'vscode-languageserver';
import { parse, ParseError, ClassDeclNode, File, SymbolNodeBase, FunctionDeclNode, VarDeclNode, TypedefNode, toSymbolKind, EnumDeclNode, EnumMemberDeclNode, TypeNode, ReturnStatementInfo } from '../ast/parser';
import { prettyPrint } from '../ast/printer';
import { Token, TokenKind } from '../lexer/token';
import { keywords } from '../lexer/rules';
import { normalizeUri } from '../../util/uri';
import * as url from 'node:url';

interface SymbolEntry {
    name: string;
    kind: 'function' | 'class' | 'variable' | 'parameter' | 'field' | 'typedef' | 'enum';
    type?: string;
    location: {
        uri: string;
        range: Range;
    };
    scope: 'global' | 'class' | 'function';
}

/**
 * Completion result with optional metadata
 */
interface CompletionResult {
    name: string;
    kind: string;
    detail?: string;
    insertText?: string;
    returnType?: string;
}

/**
 * Global symbol entry for the pre-built symbol index
 */
interface GlobalSymbolEntry {
    name: string;
    nameLower: string;  // Pre-computed lowercase for fast prefix matching
    kind: string;
    detail?: string;
    insertText?: string;
    returnType?: string;
    uri: string;  // Source file URI for deduplication on updates
}

/**
 * Returns the token at a specific offset (e.g. mouse hover or cursor position).
 *
 * Uses a simple regex scan instead of the full lexer so that preprocessor
 * directives (#ifdef / #else / #endif) in the surrounding context can never
 * accidentally "eat" the identifier under the cursor.
 */
export function getTokenAtPosition(text: string, offset: number): Token | null {
    // 1 · Detect if the cursor sits inside a // or /* */ comment.
    //     If so, return null immediately (no hover/def on comments).
    //     We only need to scan the current line for //, and a short
    //     window for /* */.
    const lineStart = text.lastIndexOf('\n', offset - 1) + 1;
    const lineText  = text.substring(lineStart, text.indexOf('\n', offset));
    const colInLine = offset - lineStart;

    // Check for // comment: everything after // on this line is a comment
    const slashSlash = lineText.indexOf('//');
    if (slashSlash >= 0 && colInLine > slashSlash) return null;

    // Quick check for block comment: scan backward for /* without closing */
    const windowBack = Math.max(0, offset - 500);
    const before = text.substring(windowBack, offset);
    const lastOpen  = before.lastIndexOf('/*');
    const lastClose = before.lastIndexOf('*/');
    if (lastOpen >= 0 && (lastClose < 0 || lastClose < lastOpen)) return null;

    // 2 · Check if cursor is inside a string literal (" ... ").
    //     Count unescaped quotes from the start of the line to the cursor.
    let inString = false;
    for (let i = 0; i < colInLine; i++) {
        if (lineText[i] === '"' && (i === 0 || lineText[i - 1] !== '\\')) {
            inString = !inString;
        }
    }
    if (inString) return null;

    // 3 · Walk outward from the offset to find the word (identifier/keyword)
    //     boundaries. Identifiers are [_A-Za-z0-9]+.
    let lo = offset;
    let hi = offset;
    while (lo > 0 && /[_A-Za-z0-9]/.test(text[lo - 1])) lo--;
    while (hi < text.length && /[_A-Za-z0-9]/.test(text[hi])) hi++;
    if (lo === hi) return null;          // cursor is not on a word

    const value = text.substring(lo, hi);

    // 4 · Classify: keyword vs identifier vs number
    if (/^\d/.test(value)) return null; // pure numeric — not useful for hover/def

    const kind = keywords.has(value) ? TokenKind.Keyword : TokenKind.Identifier;
    return { kind, value, start: lo, end: hi };
}

function formatDeclaration(node: SymbolNodeBase, templateMap?: Map<string, string>): string {
    // Helper: substitute generic type params with concrete types from templateMap
    const subst = (typeName: string): string => {
        if (!templateMap || templateMap.size === 0) return typeName;
        return templateMap.get(typeName) || typeName;
    };

    let fmt: string | null = null;
    switch (node.kind) {
        case 'FunctionDecl': {
            const _node = node as FunctionDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}${subst(_node.returnType.identifier)} ${_node.name}(${_node.parameters?.map(p => (p.modifiers.length ? p.modifiers.join(' ') + ' ': '') + subst(p.type.identifier) + ' ' + p.name).join(', ') ?? ''})`;
            break;
        }

        case 'VarDecl': {
            const _node = node as VarDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}${subst(_node.type.identifier)} ${_node.name}`;
            break;
        }

        case 'ClassDecl': {
            const _node = node as ClassDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}class ${_node.name}` + (_node.base?.identifier ? ` : ${_node.base.identifier}` : '');
            break;
        }

        case 'EnumDecl': {
            const _node = node as ClassDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}enum ${_node.name}`;
            break;
        }

        case 'EnumMemberDecl': {
            const _node = node as EnumMemberDeclNode;
            fmt = `${_node.name}`;
            break;
        }

        case 'Typedef': {
            const _node = node as TypedefNode;
            fmt = `typedef ${_node.oldType.identifier} ${_node.name}`;
            break;
        }
    }

    if (fmt)
        return '```enscript\n' + fmt + '\n```'

    return `(Unknown ${node.kind}) ${node.name}`;
}

// ====================================================================
// Script Module Detection
// ====================================================================
// DayZ scripts are organised into numbered modules:
//   1_Core → 2_GameLib → 3_Game → 4_World → 5_Mission
// A lower module CANNOT reference types from a higher module.
// Modders sometimes use shorter names like "game", "world", "mission".

const MODULE_NAMES: Record<number, string> = {
    1: '1_Core',
    2: '2_GameLib',
    3: '3_Game',
    4: '4_World',
    5: '5_Mission',
};

/** Numbered format: /1_core/, /4_World/ etc. */
const MODULE_NUMBERED = /[/\\]([1-5])_[a-z]+[/\\]/i;

/** Short-name lookup for un-numbered folders like /world/, /game/, /mission/ */
const MODULE_SHORT_NAMES: Record<string, number> = {
    core: 1,
    gamelib: 2,
    game: 3,
    world: 4,
    mission: 5,
};
const MODULE_SHORT = /[/\\](core|gamelib|game|world|mission)[/\\]/i;

/** Extract the script module level (1–5) from a file URI or path.  Returns 0 if unknown. */
function getModuleLevel(uriOrPath: string): number {
    // Try the canonical numbered format first (e.g. 4_World)
    const num = MODULE_NUMBERED.exec(uriOrPath);
    if (num) return parseInt(num[1], 10);

    // Fall back to short names (e.g. just "world" or "game")
    const short = MODULE_SHORT.exec(uriOrPath);
    if (short) return MODULE_SHORT_NAMES[short[1].toLowerCase()] ?? 0;

    return 0;
}

/** Singleton façade that lazily analyses files and answers LSP queries. */
export class Analyzer {
    private static _instance: Analyzer;
    static instance(): Analyzer {
        if (!Analyzer._instance) Analyzer._instance = new Analyzer();
        return Analyzer._instance;
    }

    private docCache = new Map<string, File>();
    private parseErrorCount = 0;
    private preprocessorDefines: Set<string> = new Set();
    
    // ================================================================
    // GLOBAL SYMBOL INDEX for fast completions
    // ================================================================
    // Pre-built index partitioned by first letter for O(1) bucket lookup.
    // Each bucket is a sorted array for deterministic ordering.
    // Updated incrementally when files change.
    // ================================================================
    
    /** Main symbol map: name -> entry */
    private globalSymbolIndex: Map<string, GlobalSymbolEntry> = new Map();
    
    /** Prefix buckets: first lowercase letter -> sorted array of names */
    private symbolsByPrefix: Map<string, string[]> = new Map();
    
    /** All symbol names sorted (for no-prefix completions) */
    private sortedSymbolNames: string[] = [];
    
    /** Flag to mark when sorted arrays need rebuild */
    private symbolIndexDirty = false;
    
    // ================================================================
    // CLASS INDEX for fast class lookups
    // ================================================================
    // Maps class names to their ClassDeclNode references.
    // Supports multiple entries per name (modded classes).
    // Avoids iterating docCache on every findAllClassesByName call.
    // ================================================================
    
    /** Class index: className -> array of ClassDeclNode (supports modded classes) */
    private classIndex: Map<string, ClassDeclNode[]> = new Map();
    
    /** Enum index: enumName -> EnumDeclNode */
    private enumIndex: Map<string, EnumDeclNode> = new Map();
    
    /** Function index: funcName -> FunctionDeclNode[] */
    private functionIndex: Map<string, FunctionDeclNode[]> = new Map();
    
    /** Typedef index: name -> TypedefNode */
    private typedefIndex: Map<string, TypedefNode> = new Map();
    
    /** Constructor index: className -> className (tracks which class names have constructors) */
    private constructorIndex: Map<string, string> = new Map();
    
    /** Update all indexes from a file's AST */
    private updateAllIndexes(uri: string, ast: File): void {
        // Remove old entries from this URI
        this.removeIndexEntriesForUri(uri);
        
        // Add new entries
        for (const node of ast.body) {
            if (!node.name) continue;
            
            if (node.kind === 'ClassDecl') {
                const classNode = node as ClassDeclNode;
                (classNode as any)._sourceUri = uri;
                let existing = this.classIndex.get(node.name);
                if (!existing) {
                    existing = [];
                    this.classIndex.set(node.name, existing);
                }
                existing.push(classNode);
                
                // Track constructors: any member function whose name matches the class name
                for (const member of classNode.members || []) {
                    if (member.kind === 'FunctionDecl' && member.name === node.name) {
                        this.constructorIndex.set(node.name, node.name);
                        break;
                    }
                }
            } else if (node.kind === 'EnumDecl') {
                (node as any)._sourceUri = uri;
                this.enumIndex.set(node.name, node as EnumDeclNode);
            } else if (node.kind === 'FunctionDecl') {
                const funcNode = node as FunctionDeclNode;
                (funcNode as any)._sourceUri = uri;
                let existing = this.functionIndex.get(node.name);
                if (!existing) {
                    existing = [];
                    this.functionIndex.set(node.name, existing);
                }
                existing.push(funcNode);
            } else if (node.kind === 'Typedef') {
                (node as any)._sourceUri = uri;
                this.typedefIndex.set(node.name, node as TypedefNode);
            }
        }
    }
    
    /** Remove all index entries from a specific URI */
    private removeIndexEntriesForUri(uri: string): void {
        // Remove from class index
        for (const [name, classes] of this.classIndex) {
            const filtered = classes.filter((c: any) => c._sourceUri !== uri);
            if (filtered.length === 0) {
                this.classIndex.delete(name);
            } else if (filtered.length !== classes.length) {
                this.classIndex.set(name, filtered);
            }
        }
        
        // Remove from enum index
        for (const [name, node] of this.enumIndex) {
            if ((node as any)._sourceUri === uri) {
                this.enumIndex.delete(name);
            }
        }
        
        // Remove from function index
        for (const [name, funcs] of this.functionIndex) {
            const filtered = funcs.filter((f: any) => f._sourceUri !== uri);
            if (filtered.length === 0) {
                this.functionIndex.delete(name);
            } else if (filtered.length !== funcs.length) {
                this.functionIndex.set(name, filtered);
            }
        }
        
        // Remove from typedef index
        for (const [name, node] of this.typedefIndex) {
            if ((node as any)._sourceUri === uri) {
                this.typedefIndex.delete(name);
            }
        }
        
        // Remove constructor index entries for classes that were removed
        // Re-check: if classIndex no longer has the name, remove from constructorIndex
        for (const [name] of this.constructorIndex) {
            if (!this.classIndex.has(name)) {
                this.constructorIndex.delete(name);
            }
        }
    }

    /** Rebuild sorted arrays from the symbol index */
    private rebuildSortedSymbolArrays(): void {
        if (!this.symbolIndexDirty) return;
        
        // Clear prefix buckets
        this.symbolsByPrefix.clear();
        
        // Build buckets by first letter
        for (const name of this.globalSymbolIndex.keys()) {
            const firstChar = name[0]?.toLowerCase() || '_';
            let bucket = this.symbolsByPrefix.get(firstChar);
            if (!bucket) {
                bucket = [];
                this.symbolsByPrefix.set(firstChar, bucket);
            }
            bucket.push(name);
        }
        
        // Sort each bucket for deterministic ordering
        for (const bucket of this.symbolsByPrefix.values()) {
            bucket.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        }
        
        // Build sorted master list
        this.sortedSymbolNames = Array.from(this.globalSymbolIndex.keys())
            .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
        
        this.symbolIndexDirty = false;
    }
    
    /** Rebuild the global symbol index from a file's AST */
    private updateGlobalSymbolIndex(uri: string, ast: File): void {
        // First remove any existing symbols from this URI
        for (const [name, entry] of this.globalSymbolIndex) {
            if (entry.uri === uri) {
                this.globalSymbolIndex.delete(name);
            }
        }
        
        // Add new symbols from the AST
        for (const node of ast.body) {
            if (!node.name) continue;
            
            let entry: GlobalSymbolEntry | undefined;
            
            if (node.kind === 'ClassDecl') {
                const classNode = node as ClassDeclNode;
                entry = {
                    name: node.name,
                    nameLower: node.name.toLowerCase(),  // Pre-compute for fast matching
                    kind: 'class',
                    detail: classNode.base?.identifier 
                        ? `extends ${classNode.base.identifier}` 
                        : 'class',
                    uri
                };
            } else if (node.kind === 'FunctionDecl') {
                const func = node as FunctionDeclNode;
                entry = {
                    name: func.name,
                    nameLower: func.name.toLowerCase(),
                    kind: 'function',
                    detail: func.returnType?.identifier || 'void',
                    insertText: `${func.name}()`,
                    returnType: func.returnType?.identifier,
                    uri
                };
            } else if (node.kind === 'VarDecl') {
                const v = node as VarDeclNode;
                entry = {
                    name: v.name,
                    nameLower: v.name.toLowerCase(),
                    kind: 'variable',
                    detail: v.type?.identifier || 'auto',
                    uri
                };
            } else if (node.kind === 'EnumDecl') {
                entry = {
                    name: node.name,
                    nameLower: node.name.toLowerCase(),
                    kind: 'enum',
                    detail: 'enum',
                    uri
                };
            } else if (node.kind === 'Typedef') {
                entry = {
                    name: node.name,
                    nameLower: node.name.toLowerCase(),
                    kind: 'typedef',
                    detail: `typedef ${(node as TypedefNode).oldType?.identifier}`,
                    uri
                };
            }
            
            if (entry) {
                this.globalSymbolIndex.set(node.name, entry);
            }
        }
        
        // Mark sorted arrays as needing rebuild
        this.symbolIndexDirty = true;
    }

    /** Set preprocessor defines that should be treated as active in #ifdef directives */
    setPreprocessorDefines(defines: string[]): void {
        this.preprocessorDefines = new Set(defines);
    }

    /** Store include paths so diagnostics can be suppressed for external files */
    private includePaths: string[] = [];
    private workspaceRoots: string[] = [];

    setIncludePaths(paths: string[]): void {
        this.includePaths = paths.map(p => p.replace(/\\/g, '/').toLowerCase());
    }

    setWorkspaceRoot(root: string): void {
        this.workspaceRoots = [root.replace(/\\/g, '/').toLowerCase()];
    }

    setWorkspaceRoots(roots: string[]): void {
        this.workspaceRoots = roots.map(r => r.replace(/\\/g, '/').toLowerCase());
    }

    /** Check if a URI belongs to any workspace folder (not an external include path file) */
    isWorkspaceFile(uri: string): boolean {
        if (this.workspaceRoots.length === 0) return true; // no workspace root set, allow all
        let fsPath: string;
        try {
            fsPath = url.fileURLToPath(uri).replace(/\\/g, '/').toLowerCase();
        } catch {
            fsPath = uri.replace(/\\/g, '/').toLowerCase();
        }
        return this.workspaceRoots.some(root => fsPath.startsWith(root));
    }

    /**
     * Compute character ranges that should be blanked for #ifdef/#ifndef regions.
     * Returns an array of { start, end } pairs (character offsets) covering:
     *   - All directive lines (#ifdef, #ifndef, #else, #endif) — always blanked
     *   - Content in skipped branches — conditionally blanked
     *
     * Uses the same logic as the lexer: skip first branch by default, process #else;
     * if a define is in the defines set, process the first branch and skip #else.
     *
     * The result is stored on the cached AST so it doesn't need to be recomputed
     * on every diagnostic run.
     */
    static computeSkippedRegions(text: string, defines: Set<string>): { start: number, end: number }[] {
        const regions: { start: number, end: number }[] = [];
        const lines = text.split('\n');

        interface IfdefState {
            processFirstBranch: boolean;
            inElseBranch: boolean;
        }
        const stack: IfdefState[] = [];

        const isSkipping = (): boolean => {
            for (const s of stack) {
                if (!s.processFirstBranch && !s.inElseBranch) return true;
                if (s.processFirstBranch && s.inElseBranch) return true;
            }
            return false;
        };

        let offset = 0;
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            const trimmed = line.trim();
            const lineEnd = offset + line.length;

            const ifdefMatch = trimmed.match(/^#\s*(ifdef|ifndef)\s+(\w+)/);
            if (ifdefMatch) {
                const isIfdef = ifdefMatch[1] === 'ifdef';
                const symbol = ifdefMatch[2];
                const isDefined = defines.has(symbol);
                const processFirst = isIfdef ? isDefined : !isDefined;

                stack.push({ processFirstBranch: processFirst, inElseBranch: false });
                regions.push({ start: offset, end: lineEnd });
                offset = lineEnd + 1;
                continue;
            }

            if (trimmed.match(/^#\s*else\b/) && stack.length > 0) {
                stack[stack.length - 1].inElseBranch = true;
                regions.push({ start: offset, end: lineEnd });
                offset = lineEnd + 1;
                continue;
            }

            if (trimmed.match(/^#\s*endif\b/) && stack.length > 0) {
                stack.pop();
                regions.push({ start: offset, end: lineEnd });
                offset = lineEnd + 1;
                continue;
            }

            if (isSkipping()) {
                regions.push({ start: offset, end: lineEnd });
            }

            offset = lineEnd + 1;
        }

        return regions;
    }

    /**
     * Apply pre-computed skipped regions to blank out text.
     * Replaces skipped content with spaces, preserving newlines so
     * line/column positions remain valid.
     */
    static applySkippedRegions(text: string, regions?: { start: number, end: number }[]): string {
        if (!regions || regions.length === 0) return text;
        const result = text.split('');
        for (const region of regions) {
            for (let i = region.start; i < region.end && i < result.length; i++) {
                if (result[i] !== '\n' && result[i] !== '\r') {
                    result[i] = ' ';
                }
            }
        }
        return result.join('');
    }

    /** Return summary stats about everything indexed so far. */
    getIndexStats() {
        let classes = 0, functions = 0, enums = 0, typedefs = 0, globals = 0;
        const moduleCounts: Record<number, number> = {};
        for (const file of this.docCache.values()) {
            if (file.module && file.module > 0) {
                moduleCounts[file.module] = (moduleCounts[file.module] || 0) + 1;
            }
            for (const node of file.body) {
                switch (node.kind) {
                    case 'ClassDecl':    classes++;   break;
                    case 'FunctionDecl': functions++; break;
                    case 'EnumDecl':     enums++;     break;
                    case 'Typedef':      typedefs++;  break;
                    case 'VarDecl':      globals++;   break;
                }
            }
        }
        return { files: this.docCache.size, classes, functions, enums, typedefs, globals, parseErrors: this.parseErrorCount, moduleCounts };
    }

    /**
     * Parse a document and return the AST (used during indexing)
     * @param doc The TextDocument to parse
     * @returns The parsed AST (or a stub on error)
     */
    parseAndCache(doc: TextDocument): File {
        return this.ensure(doc);
    }

    /**
     * Lightweight re-parse + index update for the active document.
     * Called on every keystroke so hover/definition always have a fresh AST,
     * without blocking on heavy diagnostic checks.
     */
    ensureIndexed(doc: TextDocument): File {
        return this.ensure(doc);
    }

    private ensure(doc: TextDocument): File {
        // 1 · cache hit
        const normalizedUri = normalizeUri(doc.uri);
        const currVersion = doc.version;
        const cachedFile = this.docCache.get(normalizedUri);

        if (cachedFile && cachedFile.version === currVersion) {
            return cachedFile;
        }

        try {
            // 2 · happy path ─ parse & cache
            const ast = parse(doc, undefined, this.preprocessorDefines);           // pass full TextDocument + defines
            ast.module = getModuleLevel(doc.uri);
            // Pre-compute skipped #ifdef regions so runDiagnostics can
            // apply them from cache instead of re-scanning directives.
            ast.skippedRegions = Analyzer.computeSkippedRegions(doc.getText(), this.preprocessorDefines);
            this.docCache.set(normalizedUri, ast);
            // Update indexes for fast lookups — only for real files.
            // Non-file URIs (e.g. vscode-chat-code-block://, untitled:)
            // must not pollute the global class/function indexes.
            if (normalizedUri.startsWith('file:')) {
                this.updateGlobalSymbolIndex(normalizedUri, ast);
                this.updateAllIndexes(normalizedUri, ast);
            }
            return ast;
        } catch (err) {
            // 3 · graceful error handling
            if (err instanceof ParseError) {
                this.parseErrorCount++;
                // VS Code recognises “path:line:col” as a jump-to link
                const fsPath = url.fileURLToPath(err.uri);          // file:/// → p:\foo\bar.c
                console.error(`${fsPath}:${err.line}:${err.column}  ${err.message}`);

                // Return stub with parse error diagnostic attached
                // so runDiagnostics() picks it up via ast.diagnostics
                const parseErrorDiag: Diagnostic = {
                    message: `${err.message} (parse error — other diagnostics for this file are suppressed until this is fixed)`,
                    range: {
                        start: { line: err.line - 1, character: err.column - 1 },
                        end:   { line: err.line - 1, character: err.column     }
                    },
                    severity: DiagnosticSeverity.Error,
                    source: 'enfusion-script'
                };
                const stub: File = { body: [], version: doc.version, diagnostics: [parseErrorDiag] };
                this.docCache.set(normalizeUri(doc.uri), stub);
                return stub;
            } else {
                // unexpected failure
                console.error(String(err));
            }

            // 4 · return an empty stub so callers can continue
            return { body: [], version: 0, diagnostics: [] };
        }
    }

    resolveSymbolAtPosition(doc: TextDocument, pos: Position) {
        const ast = this.ensure(doc);

        const result: SymbolEntry[] = [];

        const candidates: any[] = [];

        // Flatten top-level
        for (const node of ast.body) {
            if (node.name)
                candidates.push({ ...node, scope: 'global' });

            if (node.kind === 'ClassDecl') {
                for (const member of (node as ClassDeclNode).members || []) {
                    if (member.name) {
                        candidates.push({ ...member, scope: 'class', parent: node });
                    }
                }
            }
        }

        // Try to find closest match
        for (const c of candidates) {
            if (pos >= c.start && pos <= c.end) {
                result.push({
                    name: c.name,
                    kind: c.kind,
                    type: c.returnType || c.type || undefined,
                    location: {
                        uri: doc.uri,
                        range: {
                            start: c.start,
                            end: c.end
                        }
                    },
                    scope: c.scope
                });
            }
        }

        return result;
    }

    // ========================================================================
    // COMPLETIONS - Enhanced with parameter type resolution & member access
    // ========================================================================
    // This is a major improvement over the basic implementation.
    //
    // FEATURES:
    // 1. CONTEXT DETECTION: Detects if cursor is after a dot (member access)
    // 2. PARAMETER TYPE RESOLUTION: Resolves types of function parameters
    //    Example: void SomeFunc(PlayerBase p) { p. } → shows PlayerBase methods
    // 3. LOCAL VARIABLE TYPE RESOLUTION: Resolves types of local variables
    //    Example: PlayerBase player = GetPlayer(); player. → shows methods
    // 4. INHERITANCE CHAIN: Walks up class hierarchy for complete method list
    // 5. GLOBAL COMPLETIONS: Shows classes, functions, enums when not after dot
    // 6. CLASS CONTEXT: When inside a class, show methods from this class + parents
    // 7. FUNCTION RETURN TYPES: GetGame(). → resolves return type of GetGame()
    // ========================================================================
    getCompletions(doc: TextDocument, pos: Position): CompletionResult[] {
        const ast = this.ensure(doc);
        const text = doc.getText();
        const offset = doc.offsetAt(pos);
        
        // Check if we're after a dot (member completion)
        const textBeforeCursor = text.substring(0, offset);
        
        // ================================================================
        // UNIFIED CHAIN COMPLETION — handles all dot-chain patterns:
        //   variable.prefix, func().prefix, var.field.method().prefix,
        //   func().field.method().prefix, Class.prefix, this.prefix,
        //   and arbitrarily deep chains with nested parentheses.
        // ================================================================
        // Extract the prefix (partial identifier being typed after the last dot)
        // and the "before-dot" text for chain resolution.
        const completionDotMatch = textBeforeCursor.match(/\.\s*(\w*)$/);
        if (completionDotMatch) {
            const prefix = completionDotMatch[1] || '';
            // Text up to (and including) the dot, for chain parsing
            const textUpToDot = textBeforeCursor.substring(0, textBeforeCursor.length - completionDotMatch[0].length + 1);
            // textUpToDot ends with '.', which is what parseExpressionChainBackward expects
            
            const chainResult = this.resolveFullChain(textUpToDot, doc, pos, ast);
            if (chainResult) {
                // Check if it's an enum type → show enum members
                const enumNode = this.findEnumByName(chainResult.type);
                if (enumNode) {
                    return this.getEnumMemberCompletions(enumNode, prefix);
                }
                // Show class members (methods, fields, statics)
                return this.getClassMemberCompletions(
                    chainResult.type,
                    prefix,
                    chainResult.templateMap.size > 0 ? chainResult.templateMap : undefined
                );
            }
            
            // Fallback for simple `name.` where the name is a class for statics
            // or an unresolved variable — try class static completion  
            const simpleNameMatch = textUpToDot.match(/(\w+)\s*\.$/);
            if (simpleNameMatch) {
                const name = simpleNameMatch[1];
                
                // Handle 'this' keyword
                if (name === 'this') {
                    const containingClass = this.findContainingClass(ast, pos);
                    if (containingClass) {
                        return this.getClassMemberCompletions(containingClass.name, prefix);
                    }
                }
                
                // Handle 'super' keyword
                if (name === 'super') {
                    const containingClass = this.findContainingClass(ast, pos);
                    if (containingClass?.base?.identifier) {
                        return this.getClassMemberCompletions(containingClass.base.identifier, prefix);
                    }
                }
                
                if (name[0] === name[0].toUpperCase()) {
                    // Check for enum
                    const enumNode2 = this.findEnumByName(name);
                    if (enumNode2) {
                        return this.getEnumMemberCompletions(enumNode2, prefix);
                    }
                    // Check for class statics
                    const classNode = this.findClassByName(name);
                    if (classNode) {
                        return this.getStaticMemberCompletions(classNode, prefix);
                    }
                }
            }
            
            return [];
        }
        
        // Get the prefix being typed (for filtering)
        const prefixMatch = textBeforeCursor.match(/(\w+)$/);
        const prefix = prefixMatch ? prefixMatch[1].toLowerCase() : '';
        
        // CONTEXT-AWARE COMPLETION MODE
        const results: CompletionResult[] = [];
        const seen = new Set<string>();
        
        // Check if we're inside a class
        const containingClass = this.findContainingClass(ast, pos);
        
        if (containingClass) {
            // Add methods/fields from current class hierarchy (including modded)
            const classHierarchy = this.getClassHierarchyOrdered(containingClass.name, new Set());
            
            for (const classNode of classHierarchy) {
                for (const member of classNode.members || []) {
                    if (!member.name) continue;
                    if (seen.has(member.name)) continue;
                    if (prefix && !member.name.toLowerCase().startsWith(prefix)) continue;
                    
                    seen.add(member.name);
                    
                    if (member.kind === 'FunctionDecl') {
                        const func = member as FunctionDeclNode;
                        const params = func.parameters?.map(p => 
                            `${p.type?.identifier || 'auto'} ${p.name}`
                        ).join(', ') || '';
                        
                        results.push({
                            name: func.name,
                            kind: 'function',
                            detail: `${func.returnType?.identifier || 'void'} (${classNode.name})`,
                            insertText: `${func.name}()`,
                            returnType: func.returnType?.identifier
                        });
                    } else if (member.kind === 'VarDecl') {
                        const field = member as VarDeclNode;
                        results.push({
                            name: field.name,
                            kind: 'field',
                            detail: `${field.type?.identifier || 'auto'} (${classNode.name})`
                        });
                    }
                }
            }
        }
        
        // ================================================================
        // FAST GLOBAL SYMBOL LOOKUP using pre-built sorted index
        // ================================================================
        // Uses prefix-partitioned buckets for O(bucket_size) lookup instead
        // of O(total_symbols). Sorted arrays ensure deterministic ordering.
        // Pre-computed lowercase names avoid repeated .toLowerCase() calls.
        // ================================================================
        
        // Ensure sorted arrays are up to date
        this.rebuildSortedSymbolArrays();
        
        // Choose which symbol names to iterate based on prefix
        let symbolNames: string[];
        if (prefix.length > 0) {
            // Use prefix bucket for faster lookup
            const bucket = this.symbolsByPrefix.get(prefix[0]) || [];
            symbolNames = bucket;
        } else {
            // No prefix - use full sorted list
            symbolNames = this.sortedSymbolNames;
        }
        
        for (const name of symbolNames) {
            if (seen.has(name)) continue;
            
            const entry = this.globalSymbolIndex.get(name);
            if (!entry) continue;
            
            // Use pre-computed lowercase for fast prefix matching
            if (prefix && !entry.nameLower.startsWith(prefix)) continue;
            
            seen.add(name);
            results.push({
                name: entry.name,
                kind: entry.kind,
                detail: entry.detail,
                insertText: entry.insertText,
                returnType: entry.returnType
            });
        }
        
        return results;
    }

    /**
     * Resolve the type of a variable at a given position.
     * Checks AST lookup first, then falls back to regex patterns
     * for variables the AST misses.
     */
    private resolveVariableType(doc: TextDocument, pos: Position, varName: string): string | null {
        
        // Handle 'this' keyword — resolve to containing class type
        if (varName === 'this') {
            const ast = this.ensure(doc);
            const containingClass = this.findContainingClass(ast, pos);
            return containingClass?.name ?? null;
        }
        
        // Delegate the AST-based lookup to resolveVariableTypeNode
        const typeNode = this.resolveVariableTypeNode(doc, pos, varName);
        if (typeNode) {
            return typeNode.identifier || null;
        }
        
        // Regex fallbacks for cases the AST-based lookup misses
        // (e.g., variables in unparsed regions)
        const text = doc.getText();
        const regexKeywords = new Set(['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'else', 'foreach', 'void', 'override', 'static', 'private', 'protected', 'const', 'ref', 'autoptr', 'proto', 'native', 'modded', 'sealed', 'event', 'typedef', 'case', 'break', 'continue', 'this', 'super', 'null', 'true', 'false', 'out', 'inout', 'volatile']);
        
        // Pattern: Type varName; or Type varName = or Type varName[  (C-style array)
        // Also handles generic types: Type<GenericArg> varName;
        // Use word boundary to avoid matching inside larger expressions
        const varDeclMatch = text.match(new RegExp(`(?:^|[{;,\\s])\\s*(\\w+)(?:\\s*<[^>]*>)?\\s+${varName}\\s*[;=\\[(]`));
        if (varDeclMatch && !regexKeywords.has(varDeclMatch[1])) {
            return varDeclMatch[1];
        }
        
        // Pattern: (Type varName) or (Type varName,) or (Type varName[) - function parameters
        // Also handles generic types
        const paramMatch = text.match(new RegExp(`[,(]\\s*(\\w+)(?:\\s*<[^>]*>)?\\s+${varName}\\s*[,)\\[]`));
        if (paramMatch) {
            return paramMatch[1];
        }
        
        // Pattern: out Type varName or inout Type varName
        const outParamMatch = text.match(new RegExp(`(?:out|inout)\\s+(\\w+)\\s+${varName}\\s*[,)]`));
        if (outParamMatch) {
            return outParamMatch[1];
        }
        
        // Pattern: foreach (Type varName : collection)
        const foreachMatch = text.match(new RegExp(`foreach\\s*\\(\\s*(\\w+)\\s+${varName}\\s*:`));
        if (foreachMatch && !regexKeywords.has(foreachMatch[1])) {
            return foreachMatch[1];
        }
        
        return null;
    }

    /**
     * Resolve a variable's full TypeNode (including genericArgs).
     * Unlike resolveVariableType() which returns just the type name string,
     * this returns the complete TypeNode so we can access generic type arguments.
     * 
     * This is needed for direct generic declarations like:
     *   map<string, int> myMap;  →  TypeNode { identifier: "map", genericArgs: ["string", "int"] }
     * 
     * Search order: function params → function locals → class fields → global variables
     * @returns The full TypeNode or null if not found
     */
    private resolveVariableTypeNode(doc: TextDocument, pos: Position, varName: string): TypeNode | null {
        const ast = this.ensure(doc);
        
        // Handle 'this' keyword — resolve to containing class type
        if (varName === 'this') {
            const containingClass = this.findContainingClass(ast, pos);
            if (containingClass) {
                return { identifier: containingClass.name, arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } as TypeNode;
            }
            return null;
        }
        
        const containingFunc = this.findContainingFunction(ast, pos);
        if (containingFunc) {
            for (const param of containingFunc.parameters || []) {
                if (param.name === varName && param.type) return param.type;
            }
            for (const local of containingFunc.locals || []) {
                if (local.name === varName && local.type) return local.type;
            }
        }
        
        const containingClass = this.findContainingClass(ast, pos);
        if (containingClass) {
            // First search the local AST class members directly — this always works
            // even if classIndex is stale or hasn't been populated yet
            for (const member of containingClass.members || []) {
                if (member.kind === 'VarDecl' && member.name === varName && (member as VarDeclNode).type) {
                    return (member as VarDeclNode).type!;
                }
            }
            // Then walk the class hierarchy via classIndex for inherited members
            const classHierarchy = this.getClassHierarchyOrdered(containingClass.name, new Set());
            for (const classNode of classHierarchy) {
                // Skip self — already searched above via the local AST
                if (classNode.name === containingClass.name) continue;
                for (const member of classNode.members || []) {
                    if (member.kind === 'VarDecl' && member.name === varName && (member as VarDeclNode).type) {
                        return (member as VarDeclNode).type!;
                    }
                }
            }
        }
        
        for (const [uri, fileAst] of this.docCache) {
            for (const node of fileAst.body) {
                if (node.kind === 'VarDecl' && node.name === varName && (node as VarDeclNode).type) {
                    return (node as VarDeclNode).type!;
                }
            }
        }
        
        return null;
    }

    /**
     * Resolve the return type of a function by name
     * Searches top-level functions and class methods across all indexed files
     */
    private resolveFunctionReturnType(funcName: string): string | null {
        const result = this.resolveFunctionReturnTypeNode(funcName)?.identifier ?? null;
        // Implicit constructors: class/typedef exists but has no explicit constructor declaration
        if (!result && (this.classIndex.has(funcName) || this.typedefIndex.has(funcName))) {
            return funcName;
        }
        return result;
    }

    /**
     * Resolve the return type of a global/static function, returning full TypeNode info.
     * Uses pre-built indexes for fast lookup.
     */
    private resolveFunctionReturnTypeNode(funcName: string): TypeNode | null {
        
        // Check if this is a constructor call via the pre-built index (O(1))
        const ctorClass = this.constructorIndex.get(funcName);
        if (ctorClass) {
            // Constructors are declared void but return an instance of the class
            return { identifier: ctorClass, arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } as TypeNode;
        }
        
        // Check top-level functions via function index (O(1))
        const funcs = this.functionIndex.get(funcName);
        if (funcs && funcs.length > 0) {
            for (const func of funcs) {
                if (func.returnType?.identifier) {
                    return func.returnType;
                }
            }
        }
        
        // NOTE: We intentionally do NOT fall back to searching all class methods here.
        // An unqualified function call should only resolve to:
        //   1) A constructor (checked above)
        //   2) A top-level (global) function (checked above)
        //   3) A method in the containing class hierarchy (handled by resolveMethodReturnType)
        // Searching all class methods would return arbitrary results (e.g., GetInstance()
        // matching NotificationSystem instead of the caller's own class).
        
        return null;
    }

    /**
     * Resolve the return type of a method within a specific class hierarchy
     * @param className The class to search in (and its parent classes)
     * @param methodName The method name to find
     */
    private resolveMethodReturnType(className: string, methodName: string): string | null {
        const result = this.resolveMethodReturnTypeNode(className, methodName);
        return result?.identifier ?? null;
    }

    /**
     * Resolve the return type of a method call within a class, applying template substitution.
     * 
     * Walks the class hierarchy. At each base class, if that base was reached through
     * a typedef with generic args (e.g., typedef array<autoptr UCurrencyValue> UCurrencyBase),
     * builds a template map so that methods returning template params (like array.Get() → T)
     * are substituted with the concrete type (UCurrencyValue).
     * 
     * This is the same logic as resolveVariableChainType / resolveChainSteps, but for
     * unqualified method calls inside a class (i.e., calling inherited methods).
     */
    private resolveMethodCallWithTemplates(className: string, methodName: string): string | null {
        // Walk the class hierarchy, building up the template map at each step
        // (both typedef expansions AND extends clauses with generic arguments)
        const visited = new Set<string>();
        let templateMap = new Map<string, string>();
        
        const walk = (name: string): string | null => {
            if (visited.has(name)) return null;
            visited.add(name);
            
            // Resolve through typedef: e.g., UCurrencyBase → array<autoptr UCurrencyValue>
            const typedefNode = this.resolveTypedefNode(name);
            let resolvedName = name;
            if (typedefNode) {
                resolvedName = typedefNode.oldType.identifier;
                if (typedefNode.oldType.genericArgs && typedefNode.oldType.genericArgs.length > 0) {
                    // Build template map: e.g., T → UCurrencyValue for array<UCurrencyValue>
                    const newMap = this.buildTemplateMap(resolvedName, typedefNode.oldType.genericArgs);
                    // Merge with existing map (inner maps take precedence)
                    for (const [k, v] of newMap) {
                        templateMap.set(k, v);
                    }
                }
            }
            
            // Find all classes with this name
            const classNodes = this.findAllClassesByName(resolvedName);
            for (const classNode of classNodes) {
                // Check if this class directly defines the method
                for (const member of classNode.members || []) {
                    if (member.kind === 'FunctionDecl' && member.name === methodName) {
                        const func = member as FunctionDeclNode;
                        if (func.returnType?.identifier) {
                            let retType = func.returnType.identifier;
                            // Apply template substitution
                            if (templateMap.has(retType)) {
                                retType = templateMap.get(retType)!;
                            }
                            return retType;
                        }
                    }
                }
            }
            
            // Check base class, building template map from extends clause generic args
            const originalClass = classNodes.find(c => !c.modifiers?.includes('modded'));
            const baseNode = (originalClass || classNodes[0])?.base;
            if (baseNode?.identifier) {
                // If the extends clause has generic args (e.g., extends HFSMBase<WeaponStateBase, ...>),
                // build a template map for the base class's generic parameters
                if (baseNode.genericArgs && baseNode.genericArgs.length > 0) {
                    const newMap = this.buildTemplateMap(baseNode.identifier, baseNode.genericArgs);
                    for (const [k, v] of newMap) {
                        // Apply existing template substitutions to the concrete args too
                        // (handles chained generics)
                        templateMap.set(k, templateMap.get(v) || v);
                    }
                }
                return walk(baseNode.identifier);
            }
            
            return null;
        };
        
        return walk(className);
    }

    /**
     * Resolve the return type of a method/field within a class hierarchy, returning full type info.
     * Includes genericArgs for template types like map<string, int>.
     */
    private resolveMethodReturnTypeNode(className: string, methodName: string): TypeNode | null {
        // Resolve typedefs first (e.g., testMapType → map)
        const resolvedClass = this.resolveTypedef(className);
        const visited = new Set<string>();
        const classesToSearch = this.getClassHierarchyOrdered(resolvedClass, visited);
        
        // Search class members FIRST — a field or method on the target class takes
        // priority over a global constructor with the same name.  This prevents
        // e.g. `marker.Icon` (a string field named "Icon") from being resolved as
        // the constructor of a class called "Icon".
        for (const classNode of classesToSearch) {
            for (const member of classNode.members || []) {
                if (member.kind === 'FunctionDecl' && member.name === methodName) {
                    const func = member as FunctionDeclNode;
                    if (func.returnType?.identifier) {
                        return func.returnType;
                    }
                }
                // Also check fields (VarDecl members)
                if (member.kind === 'VarDecl' && member.name === methodName) {
                    const varNode = member as VarDeclNode;
                    if (varNode.type?.identifier) {
                        return varNode.type;
                    }
                }
            }
        }
        
        // Fallback: constructor call — if no member was found on the class, check
        // if the name matches a known constructor (e.g. chaining into a constructor
        // call like `obj.SomeType()` where SomeType is a class).
        const ctorClass = this.constructorIndex.get(methodName);
        if (ctorClass) {
            return { identifier: ctorClass, arrayDims: [], modifiers: [], kind: 'Type', uri: '', start: { line: 0, character: 0 }, end: { line: 0, character: 0 } } as TypeNode;
        }
        
        return null;
    }

    /**
     * Get the genericVars (template parameter names) for a class by name.
     * e.g. for "map" returns ["TKey", "TValue"]
     * Uses the pre-built class index for O(1) lookup.
     */
    private getClassGenericVars(className: string): string[] | undefined {
        const classes = this.classIndex.get(className);
        if (classes && classes.length > 0) {
            // Prefer non-modded class for the template definition
            const origClass = classes.find(c => !c.modifiers?.includes('modded')) || classes[0];
            return origClass.genericVars;
        }
        return undefined;
    }

    /**
     * Build a template substitution map from a class's genericVars and concrete genericArgs.
     * 
     * Maps the class's formal template parameter names to the concrete types provided
     * by a typedef or direct generic instantiation.
     * 
     * Example:
     *   class map<Class TKey, Class TValue> { ... }
     *   typedef map<string, int> TMyMap;
     *   → buildTemplateMap("map", [{identifier:"string"}, {identifier:"int"}])
     *   → Map { "TKey" → "string", "TValue" → "int" }
     * 
     * The className is first resolved through typedefs (in case the caller
     * passes a typedef alias instead of the actual class name).
     * 
     * @param className   The class name (will be resolved through typedefs)
     * @param genericArgs Concrete type arguments from the typedef/instantiation
     * @returns Map of template param name → concrete type name (empty if not generic)
     */
    private buildTemplateMap(className: string, genericArgs?: TypeNode[]): Map<string, string> {
        const templateMap = new Map<string, string>();
        if (!genericArgs || genericArgs.length === 0) return templateMap;
        
        // Resolve through typedefs first
        const resolvedClass = this.resolveTypedef(className);
        const genericVars = this.getClassGenericVars(resolvedClass);
        if (!genericVars) return templateMap;
        
        for (let i = 0; i < Math.min(genericVars.length, genericArgs.length); i++) {
            templateMap.set(genericVars[i], genericArgs[i].identifier);
        }
        return templateMap;
    }

    /**
     * Resolve a type name through typedefs to the underlying class name.
     * e.g., "testMapType" → "map" if typedef map<string,string> testMapType;
     * Returns the original typeName if it's not a typedef.
     */
    private resolveTypedef(typeName: string): string {
        const node = this.resolveTypedefNode(typeName);
        return node ? node.oldType.identifier : typeName;
    }

    /**
     * Given a type that is being indexed with [], return the element type.
     * e.g., vector[0] → float, string[0] → string
     * Uses the Get method's return type for classes (container[i] == container.Get(i)).
     * Returns null if the indexed type cannot be determined (to avoid false positives).
     */
    private resolveIndexedType(containerType: string): string | null {
        const lower = containerType.toLowerCase();
        if (lower === 'vector') return 'float';
        if (lower === 'string') return 'string';
        // Look up the Get method's return type on this class
        const getReturnType = this.resolveMethodReturnTypeNode(containerType, 'Get');
        if (getReturnType?.identifier) {
            const retType = getReturnType.identifier;
            // If Get returns a template param (e.g. T, TValue), we can't resolve without
            // concrete generic args, so return null to skip the check
            const genericVars = this.getClassGenericVars(containerType);
            if (genericVars?.includes(retType)) return null;
            return retType;
        }
        return null;
    }

    /**
     * Count the number of `[...]` indexing levels OUTSIDE of parenthesised
     * argument lists.  e.g.:
     *   ".GetOrientation()[0]"            → 1
     *   ".m_Patterns[id1][id2]"           → 2  (2D matrix)
     *   ".GetSurface(pos[0], pos[2])"     → 0  ([0]/[2] inside args)
     */
    private countIndexingLevels(text: string): number {
        let parenDepth = 0;
        let bracketDepth = 0;
        let count = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            if (ch === '(') parenDepth++;
            else if (ch === ')') { if (parenDepth > 0) parenDepth--; }
            else if (parenDepth === 0) {
                if (ch === '[') {
                    if (bracketDepth === 0) count++;
                    bracketDepth++;
                } else if (ch === ']') {
                    if (bracketDepth > 0) bracketDepth--;
                }
            }
        }
        return count;
    }

    /**
     * Check if text contains a top-level comparison or boolean operator.
     * "Top-level" means not inside parentheses or brackets.
     * Used to detect expressions like: item.GetType() == receiver_item.GetType()
     * where the overall result is bool, even though individual calls return string.
     */
    private hasTopLevelComparisonOperator(text: string): boolean {
        let depth = 0;
        for (let i = 0; i < text.length; i++) {
            const ch = text[i];
            // Skip over string literals so operators inside strings are ignored
            if (ch === '"' || ch === "'") {
                const q = ch;
                i++;
                while (i < text.length && text[i] !== q) {
                    if (text[i] === '\\') i++;
                    i++;
                }
                continue;
            }
            if (ch === '(' || ch === '[') { depth++; continue; }
            if (ch === ')' || ch === ']') { if (depth > 0) depth--; continue; }
            if (depth > 0) continue;
            // Check for two-character operators first
            const next = i + 1 < text.length ? text[i + 1] : '';
            if ((ch === '=' || ch === '!' || ch === '<' || ch === '>') && next === '=') return true;
            if (ch === '&' && next === '&') return true;
            if (ch === '|' && next === '|') return true;
            // Single < and > as comparison operators (not template angle brackets).
            // Exclude bit-shift operators << and >> (and compound <<= >>=).
            // Heuristic: treat as comparison when preceded by ), ], digit, or word char
            // AND when the < doesn't look like a generic type argument list.
            if ((ch === '<' || ch === '>') && i > 0) {
                // Skip <<, >>, <<=, >>= (bit shift operators, not comparisons)
                if (next === ch) { i++; continue; } // << or >> — skip both chars
                if (next === '=') continue; // <= or >= (already handled above as two-char ops)
                // Also skip if the PREVIOUS char is < or > (second char of << or >>)
                if (text[i - 1] === ch) continue;
                
                // For '<', check if this looks like a generic angle bracket <T>, <int, float>
                // by scanning ahead for a matching '>' with only type-like content inside.
                if (ch === '<') {
                    let angleDep = 1;
                    let looksGeneric = true;
                    let j = i + 1;
                    while (j < text.length && angleDep > 0) {
                        const c = text[j];
                        if (c === '<') angleDep++;
                        else if (c === '>') angleDep--;
                        // Generic args contain: word chars, commas, spaces, nested <>
                        else if (!/[\w\s,]/.test(c)) { looksGeneric = false; break; }
                        j++;
                    }
                    if (looksGeneric && angleDep === 0) {
                        i = j - 1; // Skip past the closing '>' so it doesn't trigger as comparison
                        continue;
                    }
                }
                
                let pi = i - 1;
                while (pi >= 0 && (text[pi] === ' ' || text[pi] === '\t')) pi--;
                if (pi >= 0) {
                    const prev = text[pi];
                    if (prev === ')' || prev === ']' || /[\w\d]/.test(prev)) {
                        return true;
                    }
                }
            }
        }
        return false;
    }

    /**
     * Find the TypedefNode for a given type name.
     * Returns null if the type is not a typedef.
     * Uses the pre-built typedef index for O(1) lookup.
     * 
     * IMPORTANT: If a class with the same name also exists, the class takes
     * precedence over the typedef. This handles DayZ's opaque handle pattern
     * where e.g. "typedef int[] Material;" coexists with "class Material { ... }".
     * The typedef is just the internal engine representation; the class is
     * the actual script-level type with methods.
     */
    private resolveTypedefNode(typeName: string): TypedefNode | null {
        const node = this.typedefIndex.get(typeName);
        if (!node) return null;
        
        // If a class with the same name exists, prefer the class over the typedef.
        // This handles opaque handle types like: typedef int[] Material; class Material { ... }
        if (this.classIndex.has(typeName)) {
            return null;
        }
        
        return node;
    }

    /**
     * Resolve the final return type of a method chain like "U().Msg().SetMeta(...)"
     * Parses the chain and follows each call to determine the final return type.
     * @param chainText The full chain text starting from the first function
     * @returns The return type of the final call in the chain, or null if unresolved
     */

    // ========================================================================
    // ROBUST EXPRESSION CHAIN PARSER — backward-scanning, paren-aware
    // ========================================================================
    // Replaces fragile regex patterns that couldn't handle nested parentheses.
    // Parses backwards from the end of `textBeforeToken` (which ends at a dot),
    // extracting chain segments like:
    //   "GetGame().GetObjectByNetworkId(low, high)."
    //   → [{ name: "GetGame", isCall: true }, { name: "GetObjectByNetworkId", isCall: true }]
    //
    //   "a.b.c().d.e().f."
    //   → [{ name: "a" }, { name: "b" }, { name: "c", isCall: true },
    //      { name: "d" }, { name: "e", isCall: true }, { name: "f" }]
    //
    // Handles arbitrarily deep chains (7+), nested parentheses in function
    // arguments, mixed static/instance/function-call segments, and `this`/`super`.
    // ========================================================================

    /**
     * Parse an expression chain backward from text ending with a dot.
     * Properly handles nested parentheses (e.g., `Cast(GetGame().Foo(a, b))`)
     * and mixed call/field chains of arbitrary depth.
     *
     * @returns Array of chain segments in forward order (root first), empty if no chain found.
     */
    private parseExpressionChainBackward(text: string): { name: string; isCall: boolean; isIndexed: boolean }[] {
        const segments: { name: string; isCall: boolean; isIndexed: boolean }[] = [];
        let i = text.length - 1;

        // Skip trailing whitespace
        while (i >= 0 && /\s/.test(text[i])) i--;

        // Must end with '.'
        if (i < 0 || text[i] !== '.') return [];
        i--; // skip the dot

        // Parse segments backward
        while (true) {
            // Skip whitespace
            while (i >= 0 && /\s/.test(text[i])) i--;
            if (i < 0) break;

            let isCall = false;
            let isIndexed = false;

            // Handle trailing ')' (function call) and/or ']' (array indexing)
            // in a loop, since they can appear in any order and combination:
            // e.g., GetItems()[0] scans backward as ']' then ')'.
            while (i >= 0 && (text[i] === ')' || text[i] === ']')) {
                if (text[i] === ')') {
                    isCall = true;
                    let depth = 1;
                    i--; // skip ')'
                    while (i >= 0 && depth > 0) {
                        if (text[i] === ')') depth++;
                        else if (text[i] === '(') depth--;
                        // Skip string literals backward: when we hit a closing quote,
                        // scan back to the matching open quote (handling escapes)
                        else if (text[i] === '"' || text[i] === "'") {
                            const q = text[i];
                            i--;
                            while (i >= 0 && text[i] !== q) i--;
                            // i now on the opening quote — the loop's i-- will move past it
                        }
                        i--;
                    }
                    // i is now one before the '(' — skip whitespace
                    while (i >= 0 && /\s/.test(text[i])) i--;
                } else if (text[i] === ']') {
                    isIndexed = true;
                    let depth = 1;
                    i--; // skip ']'
                    while (i >= 0 && depth > 0) {
                        if (text[i] === ']') depth++;
                        else if (text[i] === '[') depth--;
                        else if (text[i] === '"' || text[i] === "'") {
                            const q = text[i];
                            i--;
                            while (i >= 0 && text[i] !== q) i--;
                        }
                        i--;
                    }
                    while (i >= 0 && /\s/.test(text[i])) i--;
                }
            }

            // Read identifier backward
            if (i < 0 || !/\w/.test(text[i])) break;
            const end = i + 1;
            while (i >= 0 && /\w/.test(text[i])) i--;
            const name = text.substring(i + 1, end);

            // Skip keywords that aren't valid chain roots (return, if, etc.)
            // but allow 'this' and 'super'
            if (!name || (name !== 'this' && name !== 'super' && /^(return|if|else|while|for|foreach|switch|case|new|delete|typeof|class|modded|static|private|protected|ref|autoptr|auto|void|int|float|bool|string|const|override|break|continue|null|true|false)$/.test(name))) {
                break;
            }

            segments.unshift({ name, isCall, isIndexed });

            // Check for dot before this segment
            let j = i;
            while (j >= 0 && /\s/.test(text[j])) j--;
            if (j >= 0 && text[j] === '.') {
                i = j - 1; // skip the dot and continue
            } else {
                break; // no more chain
            }
        }

        // Validate: 'this' and 'super' are only valid as the first segment.
        // If they appear mid-chain (e.g., obj.this.Method), reject the chain.
        for (let s = 1; s < segments.length; s++) {
            if (segments[s].name === 'this' || segments[s].name === 'super') {
                return [];
            }
        }

        return segments;
    }

    /**
     * Check if a type name is a template parameter of the containing class.
     * If so, return the upper-bound type (constraint type or 'Class' as default).
     * In Enforce Script, generic params are declared as "Class T", so the
     * default upper bound for any template param is 'Class'.
     *
     * Also walks up the class hierarchy — if the containing class inherits
     * from a generic base, the base's template params are also checked.
     *
     * When a class extends a generic parent with concrete type arguments
     * (e.g., WeaponFSM extends HFSMBase<WeaponStateBase, ...>), template
     * parameters from the parent are resolved to the concrete arguments
     * instead of falling back to the generic upper bound 'Class'.
     *
     * @returns The resolved concrete type name, or 'Class' as fallback if
     *          no concrete substitution is found, or null if not a template param.
     */
    private resolveTemplateParam(typeName: string, ast: File, pos: Position): string | null {
        const cc = this.findContainingClass(ast, pos);
        if (!cc) return null;

        // Check the containing class's own template params
        if (cc.genericVars && cc.genericVars.includes(typeName)) {
            // The containing class itself declares this template param.
            // We can't resolve it further without knowing how this class is instantiated.
            return 'Class';
        }

        // Walk the inheritance chain from the containing class upward.
        // At each step, check if the parent class defines the template param.
        // If so, find the concrete type argument passed from the child's extends clause.
        const concreteType = this.resolveTemplateParamThroughHierarchy(cc.name, typeName);
        if (concreteType) {
            return concreteType;
        }

        return null;
    }

    /**
     * Walk the class hierarchy from `startClass` upward, resolving a template
     * parameter name to the concrete type argument provided via extends clauses.
     *
     * Example:
     *   class HFSMBase<Class FSMStateBase, Class FSMEventBase, ...> { FSMStateBase m_State; }
     *   class WeaponFSM extends HFSMBase<WeaponStateBase, WeaponEventBase, ...> { }
     *
     * resolveTemplateParamThroughHierarchy("WeaponFSM", "FSMStateBase")
     *   → finds HFSMBase has genericVars ["FSMStateBase", "FSMEventBase", ...]
     *   → WeaponFSM's base.genericArgs[0] = "WeaponStateBase"
     *   → returns "WeaponStateBase"
     */
    private resolveTemplateParamThroughHierarchy(startClass: string, templateParam: string): string | null {
        const visited = new Set<string>();
        
        const walk = (className: string): string | null => {
            if (visited.has(className)) return null;
            visited.add(className);
            
            const classNodes = this.findAllClassesByName(className);
            if (classNodes.length === 0) return null;
            
            // For each class node (original + modded), check if its base class
            // defines the template parameter we're looking for.
            for (const classNode of classNodes) {
                if (!classNode.base?.identifier) continue;
                
                const baseName = classNode.base.identifier;
                const baseGenericArgs = classNode.base.genericArgs;
                
                // Find the base class definition to get its genericVars
                const baseClasses = this.findAllClassesByName(baseName);
                const baseClass = baseClasses.find(c => !c.modifiers?.includes('modded')) || baseClasses[0];
                
                if (baseClass?.genericVars) {
                    const paramIndex = baseClass.genericVars.indexOf(templateParam);
                    if (paramIndex !== -1 && baseGenericArgs && paramIndex < baseGenericArgs.length) {
                        const concreteType = baseGenericArgs[paramIndex].identifier;
                        // The concrete type might itself be a template param of an
                        // intermediate class — but usually it's a real class name.
                        // Check if it resolves to a known class; if not, keep walking.
                        if (this.classIndex.has(concreteType) || this.typedefIndex.has(concreteType)) {
                            return concreteType;
                        }
                        // Could be a primitive
                        const primitives = new Set(['int', 'float', 'bool', 'string', 'void', 'vector']);
                        if (primitives.has(concreteType.toLowerCase())) {
                            return concreteType;
                        }
                        // It's an unknown type (possibly another template param) — still better than 'Class'
                        return concreteType;
                    }
                }
                
                // Template param not found on this base — recurse up
                const result = walk(baseName);
                if (result) return result;
            }
            
            return null;
        };
        
        return walk(startClass);
    }

    /**
     * Resolve the root segment of an expression chain to a type.
     * Handles variables, `this`, `super`, class names (static access),
     * function calls, and method calls within the containing class.
     *
     * @returns Resolved type and template map, or null if unresolvable.
     */
    private resolveChainRoot(
        root: { name: string; isCall: boolean },
        doc: TextDocument,
        pos: Position,
        ast: File
    ): { type: string; templateMap: Map<string, string> } | null {
        if (root.isCall) {
            // Function/method call root: e.g., GetGame() or GetInstance()
            let rootType = this.resolveFunctionReturnType(root.name);
            if (!rootType) {
                const cc = this.findContainingClass(ast, pos);
                if (cc) {
                    rootType = this.resolveMethodReturnType(cc.name, root.name);
                }
            }
            // Also check if it's an implicit constructor (class name used as call)
            if (!rootType) {
                if (this.classIndex.has(root.name)) {
                    rootType = root.name;
                } else {
                    const resolved = this.resolveTypedef(root.name);
                    if (resolved !== root.name) {
                        rootType = resolved;
                    }
                }
            }
            if (!rootType) return null;

            const resolved = this.resolveTypedef(rootType);
            // Try to get template map from function return type node
            const returnTypeNode = this.resolveFunctionReturnTypeNode(root.name);
            let templateMap: Map<string, string> = new Map();
            if (returnTypeNode?.genericArgs && returnTypeNode.genericArgs.length > 0) {
                templateMap = this.buildTemplateMap(resolved, returnTypeNode.genericArgs);
            } else {
                const typedefNode = this.resolveTypedefNode(rootType);
                if (typedefNode?.oldType.genericArgs && typedefNode.oldType.genericArgs.length > 0) {
                    templateMap = this.buildTemplateMap(typedefNode.oldType.identifier, typedefNode.oldType.genericArgs);
                }
            }
            return { type: resolved, templateMap };

        } else {
            // Variable/property/class/this/super root

            // Handle 'this'
            if (root.name === 'this') {
                const cc = this.findContainingClass(ast, pos);
                if (cc) return { type: cc.name, templateMap: new Map() };
                return null;
            }

            // Handle 'super'
            if (root.name === 'super') {
                const cc = this.findContainingClass(ast, pos);
                if (cc?.base?.identifier) return { type: cc.base.identifier, templateMap: new Map() };
                return null;
            }

            // Try as variable first (most common)
            const varType = this.resolveVariableType(doc, pos, root.name);
            if (varType) {
                let currentType = varType;
                let templateMap: Map<string, string>;
                const typedefNode = this.resolveTypedefNode(currentType);
                if (typedefNode) {
                    currentType = typedefNode.oldType.identifier;
                    templateMap = this.buildTemplateMap(currentType, typedefNode.oldType.genericArgs);
                } else {
                    currentType = this.resolveTypedef(currentType);
                    const varTypeNode = this.resolveVariableTypeNode(doc, pos, root.name);
                    if (varTypeNode?.genericArgs && varTypeNode.genericArgs.length > 0) {
                        templateMap = this.buildTemplateMap(currentType, varTypeNode.genericArgs);
                    } else {
                        templateMap = new Map();
                    }
                }

                // If the resolved type is a template parameter (e.g., T, TKey),
                // resolve it to its upper-bound type (Class by default in Enforce Script).
                // This allows method lookups on template-typed variables like m_Entity
                // to find methods on the base Class type instead of failing silently.
                if (!this.classIndex.has(currentType) && !this.typedefIndex.has(currentType)) {
                    const resolved = this.resolveTemplateParam(currentType, ast, pos);
                    if (resolved) {
                        currentType = resolved;
                        templateMap = new Map();
                    }
                }

                return { type: currentType, templateMap };
            }

            // Try as class name (static access: e.g., PlayerBase.Cast)
            // Also handle lowercase built-in types like 'vector' that support static methods
            const isStaticCandidate = /^[A-Z]/.test(root.name) || root.name === 'vector';
            if (isStaticCandidate) {
                if (this.classIndex.has(root.name)) {
                    return { type: root.name, templateMap: new Map() };
                }
                // Try typedef
                const resolved = this.resolveTypedef(root.name);
                if (resolved !== root.name) {
                    return { type: resolved, templateMap: new Map() };
                }
            }

            return null;
        }
    }

    /**
     * Full chain resolution: parse `textBeforeToken` backward, resolve each
     * segment, and return the final type + template map.
     * Works for any chain depth (1+) with mixed calls, fields, statics.
     *
     * @returns The final resolved type and template map, or null if chain
     *          parsing fails or any link can't be resolved.
     */
    resolveFullChain(
        textBeforeToken: string,
        doc: TextDocument,
        pos: Position,
        ast: File
    ): { type: string; templateMap: Map<string, string> } | null {
        const chain = this.parseExpressionChainBackward(textBeforeToken);
        if (chain.length === 0) return null;

        const root = chain[0];
        const rest = chain.slice(1);

        let rootResult = this.resolveChainRoot(root, doc, pos, ast);
        if (!rootResult) return null;

        // If the root was indexed (e.g., items[0].), dereference to element type
        if (root.isIndexed) {
            rootResult = this.resolveIndexedContainerType(rootResult);
        }

        if (rest.length === 0) {
            return rootResult;
        }

        // Pass rest segments with isIndexed info to resolveChainSteps
        const memberSegments = rest.map(s => ({ name: s.name, isIndexed: s.isIndexed }));
        const result = this.resolveChainStepsWithIndexing(memberSegments, rootResult.type, rootResult.templateMap);
        return result;
    }

    /**
     * Parse chained member accesses from text like ".Method(args).Prop.Other()"
     * into a list of member names: ["Method", "Prop", "Other"].
     * Handles both method calls (with parenthesized arguments), property accesses,
     * and array indexing (e.g., ".Items[0].Name" → ["Items", "Name"]).
     * Array indexing is skipped as it doesn't change the chain resolution
     * (the element type is handled separately).
     */
    private parseChainMembers(text: string): string[] {
        const calls: string[] = [];
        let remaining = text.trim();
        
        while (remaining.startsWith('.')) {
            remaining = remaining.substring(1).trim();
            
            const methodMatch = remaining.match(/^(\w+)\s*\(/);
            if (!methodMatch) {
                // Property access (no parens), e.g., .Icons
                const propMatch = remaining.match(/^(\w+)/);
                if (propMatch) {
                    calls.push(propMatch[1]);
                    remaining = remaining.substring(propMatch[0].length).trim();
                    // Skip any array indexing like [0], [i], [expr] after the property
                    while (remaining.startsWith('[')) {
                        let depth = 1, k = 1;
                        while (k < remaining.length && depth > 0) {
                            if (remaining[k] === '[') depth++;
                            else if (remaining[k] === ']') depth--;
                            k++;
                        }
                        remaining = remaining.substring(k).trim();
                    }
                    continue;
                }
                break;
            }
            
            calls.push(methodMatch[1]);
            
            // Skip past this call's arguments (balanced parens, string-literal aware)
            remaining = remaining.substring(methodMatch[0].length);
            let parenDepth = 1, i = 0;
            while (i < remaining.length && parenDepth > 0) {
                const ch = remaining[i];
                if (ch === '(') parenDepth++;
                else if (ch === ')') parenDepth--;
                else if (ch === '"' || ch === "'") {
                    const q = ch;
                    i++;
                    while (i < remaining.length && remaining[i] !== q) {
                        if (remaining[i] === '\\') i++;
                        i++;
                    }
                }
                i++;
            }
            remaining = remaining.substring(i).trim();
            // Skip any array indexing after the method call, e.g., .GetItems()[0].Name
            while (remaining.startsWith('[')) {
                let depth = 1, k = 1;
                while (k < remaining.length && depth > 0) {
                    if (remaining[k] === '[') depth++;
                    else if (remaining[k] === ']') depth--;
                    k++;
                }
                remaining = remaining.substring(k).trim();
            }
        }
        
        return calls;
    }

    /**
     * Resolve a sequence of member accesses on a type, tracking template parameter
     * substitution at each step.
     * 
     * At each step:
     *   1. Look up the member's return TypeNode in the class hierarchy
     *   2. Apply template substitution (e.g., TKey → string)
     *   3. If the result is a typedef, expand it and rebuild the template map
     *   4. If the result has its own generic args, propagate them
     * 
     * @param calls       Ordered member names to resolve (e.g., ["Get", "Length"])
     * @param currentType The starting type (already typedef-resolved)
     * @param templateMap The starting template substitution map
     * @returns The final resolved type and template map, or null if any step fails
     */
    private resolveChainSteps(
        calls: string[],
        currentType: string,
        templateMap: Map<string, string>
    ): { type: string; templateMap: Map<string, string> } | null {
        for (const memberName of calls) {
            const nextTypeNode = this.resolveMethodReturnTypeNode(currentType, memberName);
            if (!nextTypeNode?.identifier) return null;
            
            let resolvedType = nextTypeNode.identifier;
            
            // Apply template substitution (e.g., GetKey() returns TKey → "string")
            if (templateMap.has(resolvedType)) {
                resolvedType = templateMap.get(resolvedType)!;
            }
            
            // DayZ pattern: ClassName.Cast(x) returns ClassName, not Class.
            // Cast is defined on Class as `proto native Class Cast()`, but by convention
            // it returns the type it was called on (acts as a downcast). Keep the
            // current receiver type and templateMap unchanged.
            if (memberName === 'Cast' && resolvedType === 'Class') {
                continue;
            }
            
            // Resolve through typedefs and rebuild template map for the next step
            const stepTypedef = this.resolveTypedefNode(resolvedType);
            if (stepTypedef) {
                resolvedType = stepTypedef.oldType.identifier;
                if (stepTypedef.oldType.genericArgs && stepTypedef.oldType.genericArgs.length > 0) {
                    templateMap = this.buildTemplateMap(resolvedType, stepTypedef.oldType.genericArgs);
                } else {
                    templateMap = new Map();
                }
            } else if (nextTypeNode.genericArgs && nextTypeNode.genericArgs.length > 0) {
                // Substitute any generic args that reference template params
                const substitutedArgs = nextTypeNode.genericArgs.map(arg => {
                    const subId = templateMap.get(arg.identifier);
                    if (subId) return { ...arg, identifier: subId } as TypeNode;
                    return arg;
                });
                templateMap = this.buildTemplateMap(resolvedType, substitutedArgs);
            } else {
                templateMap = new Map();
            }
            
            currentType = resolvedType;
        }
        
        return { type: currentType, templateMap };
    }

    /**
     * Dereference an indexed container type using its Get method return type.
     * In Enforce Script, container[i] is syntactic sugar for container.Get(i).
     * Resolves the Get method's return type and applies template substitution.
     * Falls back to hardcoded rules for vector/string (primitives without class defs).
     */
    private resolveIndexedContainerType(
        result: { type: string; templateMap: Map<string, string> }
    ): { type: string; templateMap: Map<string, string> } {
        const lower = result.type.toLowerCase();
        
        // Primitive indexing fallbacks (no class definition to look up)
        if (lower === 'vector') return { type: 'float', templateMap: new Map() };
        if (lower === 'string') return { type: 'string', templateMap: new Map() };
        
        // Generic approach: look up the Get method's return type on this class
        // container[i] == container.Get(i), so resolve Get's return type
        const getReturnType = this.resolveMethodReturnTypeNode(result.type, 'Get');
        if (getReturnType?.identifier) {
            let resolvedType = getReturnType.identifier;
            // Apply template substitution (e.g., Get returns T → use templateMap to resolve T → string)
            if (result.templateMap.has(resolvedType)) {
                resolvedType = result.templateMap.get(resolvedType)!;
            }
            const elemTemplateMap = this.buildTemplateMap(resolvedType, undefined);
            return { type: resolvedType, templateMap: elemTemplateMap };
        }
        
        // Can't determine — return as-is
        return result;
    }

    /**
     * Like resolveChainSteps but handles isIndexed on each segment.
     * When a segment is indexed, the resolved type is dereferenced to its element type.
     */
    private resolveChainStepsWithIndexing(
        segments: { name: string; isIndexed: boolean }[],
        currentType: string,
        templateMap: Map<string, string>
    ): { type: string; templateMap: Map<string, string> } | null {
        for (const seg of segments) {
            const nextTypeNode = this.resolveMethodReturnTypeNode(currentType, seg.name);
            if (!nextTypeNode?.identifier) return null;
            
            let resolvedType = nextTypeNode.identifier;
            
            // Apply template substitution (e.g., GetKey() returns TKey → "string")
            if (templateMap.has(resolvedType)) {
                resolvedType = templateMap.get(resolvedType)!;
            }
            
            // DayZ pattern: ClassName.Cast(x) returns ClassName, not Class.
            if (seg.name === 'Cast' && resolvedType === 'Class') {
                // Keep currentType and templateMap — Cast acts as transparent pass-through
                // Still handle indexing below
                resolvedType = currentType;
            }
            
            // Resolve through typedefs and rebuild template map for the next step
            const stepTypedef = this.resolveTypedefNode(resolvedType);
            if (stepTypedef) {
                resolvedType = stepTypedef.oldType.identifier;
                if (stepTypedef.oldType.genericArgs && stepTypedef.oldType.genericArgs.length > 0) {
                    templateMap = this.buildTemplateMap(resolvedType, stepTypedef.oldType.genericArgs);
                } else {
                    templateMap = new Map();
                }
            } else if (nextTypeNode.genericArgs && nextTypeNode.genericArgs.length > 0) {
                const substitutedArgs = nextTypeNode.genericArgs.map(arg => {
                    const subId = templateMap.get(arg.identifier);
                    if (subId) return { ...arg, identifier: subId } as TypeNode;
                    return arg;
                });
                templateMap = this.buildTemplateMap(resolvedType, substitutedArgs);
            } else {
                templateMap = new Map();
            }
            
            currentType = resolvedType;

            // If this segment was indexed (e.g., .GetItems()[0]), dereference to element type
            if (seg.isIndexed) {
                const deref = this.resolveIndexedContainerType({ type: currentType, templateMap });
                currentType = deref.type;
                templateMap = deref.templateMap;
            }
        }
        
        return { type: currentType, templateMap };
    }

    /**
     * Resolve the final return type of a function chain like "U().Msg().SetMeta(...)".
     * Parses the chain, resolves the first function call, then delegates to
     * resolveChainSteps for subsequent member accesses.
     */
    private resolveChainReturnType(chainText: string, className?: string): string | null {
        // Parse the first call: funcName(args)
        const remaining = chainText.trim();
        const firstMatch = remaining.match(/^(\w+)\s*\(/);
        if (!firstMatch) return null;
        
        const firstFunc = firstMatch[1];
        
        // Skip past the first call's arguments (balanced parens, string-literal aware)
        let afterFirst = remaining.substring(firstMatch[0].length);
        let parenDepth = 1, i = 0;
        while (i < afterFirst.length && parenDepth > 0) {
            const ch = afterFirst[i];
            if (ch === '(') parenDepth++;
            else if (ch === ')') parenDepth--;
            else if (ch === '"' || ch === "'") {
                const q = ch;
                i++;
                while (i < afterFirst.length && afterFirst[i] !== q) {
                    if (afterFirst[i] === '\\') i++;
                    i++;
                }
            }
            i++;
        }
        afterFirst = afterFirst.substring(i).trim();
        
        // Parse remaining chain members: .Method().Prop.Other()
        const calls = this.parseChainMembers(afterFirst);
        
        // Resolve the first function's return type
        const firstTypeNode = this.resolveFunctionReturnTypeNode(firstFunc);
        let currentType: string | null = firstTypeNode?.identifier ?? null;
        let resolvedTypeNode = firstTypeNode;
        
        if (!currentType) {
            // Try resolving as a method of the containing class
            if (className) {
                currentType = this.resolveMethodReturnType(className, firstFunc);
            }
            if (!currentType) {
                // Check if it's an implicit constructor (class/typedef with no declaration)
                if (this.classIndex.has(firstFunc) || this.typedefIndex.has(firstFunc)) {
                    if (calls.length === 0) return firstFunc;
                    return this.resolveVariableChainType(firstFunc, '.' + calls.join('.'));
                }
                return null;
            }
        }
        
        let currentType2 = currentType;
        
        // Resolve typedef and build initial template map
        let templateMap: Map<string, string>;
        const typedefNode = this.resolveTypedefNode(currentType2);
        if (typedefNode) {
            currentType2 = typedefNode.oldType.identifier;
            templateMap = this.buildTemplateMap(currentType2, typedefNode.oldType.genericArgs);
        } else {
            templateMap = this.buildTemplateMap(currentType2, resolvedTypeNode?.genericArgs);
        }
        
        // If no chained calls, return the first function's resolved type
        if (calls.length === 0) {
            // Check for array indexing after the single call, e.g., GetOrientation()[0]
            const indexLevels0 = this.countIndexingLevels(afterFirst);
            if (indexLevels0 > 0) {
                let deref = { type: currentType2, templateMap };
                for (let lvl = 0; lvl < indexLevels0; lvl++) {
                    deref = this.resolveIndexedContainerType(deref);
                }
                return deref.type;
            }
            return currentType2;
        }
        
        // Delegate remaining chain steps
        const chainResult = this.resolveChainSteps(calls, currentType2, templateMap);
        if (!chainResult) return null;
        
        // If the chain contains array indexing outside of args, resolve to element type
        const indexLevels1 = this.countIndexingLevels(afterFirst);
        if (indexLevels1 > 0) {
            let deref = { ...chainResult };
            for (let lvl = 0; lvl < indexLevels1; lvl++) {
                deref = this.resolveIndexedContainerType(deref);
            }
            return deref.type;
        }
        
        return chainResult.type;
    }

    /**
     * Resolve the return type of a variable method/property chain like "testMap.Get(key)".
     * Resolves the variable's type (through typedefs), builds the template map,
     * then delegates to resolveChainSteps for the member accesses.
     * 
     * Used by type mismatch checking (Patterns 5 & 6) to detect errors like:
     *   int x = testMap.Get("key");  // map<string,string>.Get returns string, not int
     * 
     * @param varType   The declared type of the variable (may be a typedef alias)
     * @param chainText The chain text after the variable (e.g., ".Get(key)")
     * @returns The resolved concrete return type, or null if unresolvable
     */
    private resolveVariableChainType(varType: string, chainText: string): string | null {
        const calls = this.parseChainMembers(chainText);
        if (calls.length === 0) return null;
        
        // Resolve starting type through typedef and build template map
        let currentType = varType;
        let templateMap: Map<string, string>;
        const typedefNode = this.resolveTypedefNode(currentType);
        if (typedefNode) {
            currentType = typedefNode.oldType.identifier;
            templateMap = this.buildTemplateMap(currentType, typedefNode.oldType.genericArgs);
        } else {
            templateMap = new Map();
        }
        
        const chainResult = this.resolveChainSteps(calls, currentType, templateMap);
        if (!chainResult) return null;
        
        // If the chain contains array indexing like [expr] after the last
        // method call, resolve to the element type. Matches [0], [i], etc.
        // even when followed by arithmetic like * Math.RAD2DEG.
        // Uses countIndexingLevels to avoid false positives from []
        // inside function arguments like .GetSurface(pos[0], pos[2]).
        const indexLevels2 = this.countIndexingLevels(chainText);
        if (indexLevels2 > 0) {
            // For multi-level indexing (e.g., matrix[i][j]), we need the full
            // TypeNode of the last member so we can peel off generic args at each
            // level. The string-only templateMap loses nested genericArgs.
            const lastMember = calls[calls.length - 1];
            const lastStepResult = this.resolveChainSteps(calls.slice(0, -1), currentType, templateMap);
            const prevType = lastStepResult ? lastStepResult.type : currentType;
            const prevMap = lastStepResult ? lastStepResult.templateMap : templateMap;
            const lastTypeNode = this.resolveMethodReturnTypeNode(prevType, lastMember);
            
            if (lastTypeNode) {
                return this.peelIndexingLevels(lastTypeNode, prevMap, indexLevels2);
            }
            
            // Fallback: use the generic loop
            let deref = { ...chainResult };
            for (let lvl = 0; lvl < indexLevels2; lvl++) {
                deref = this.resolveIndexedContainerType(deref);
            }
            return deref.type;
        }
        
        return chainResult.type;
    }

    /**
     * Peel off N indexing levels from a TypeNode, preserving nested generic args.
     * For example, for `array<array<float>>` with 2 levels:
     *   Level 1: array<array<float>>[i] → array<float>
     *   Level 2: array<float>[j] → float
     */
    private peelIndexingLevels(
        typeNode: TypeNode,
        outerTemplateMap: Map<string, string>,
        levels: number
    ): string | null {
        let currentType = typeNode.identifier;
        let currentGenericArgs = typeNode.genericArgs;
        let templateMap = outerTemplateMap;
        
        // Apply outer template substitution first (e.g., field type T → array)
        if (templateMap.has(currentType)) {
            currentType = templateMap.get(currentType)!;
        }
        
        for (let lvl = 0; lvl < levels; lvl++) {
            const lower = currentType.toLowerCase();
            if (lower === 'vector') { currentType = 'float'; currentGenericArgs = undefined; continue; }
            if (lower === 'string') { currentType = 'string'; currentGenericArgs = undefined; continue; }
            
            // Build template map for this level from genericArgs
            const levelMap = this.buildTemplateMap(currentType, currentGenericArgs);
            
            // Look up Get method return type
            const getReturn = this.resolveMethodReturnTypeNode(currentType, 'Get');
            if (!getReturn?.identifier) return null;
            
            let elemType = getReturn.identifier;
            if (levelMap.has(elemType)) {
                elemType = levelMap.get(elemType)!;
            }
            
            // Find the matching generic arg to get its nested genericArgs
            let elemGenericArgs: TypeNode[] | undefined;
            if (currentGenericArgs) {
                // Find which generic arg corresponded to the element type.
                // For containers like array<T>, the element is the first generic arg.
                // For map<TKey, TValue>, Get returns TValue (the second generic arg).
                const genericVars = this.getClassGenericVars(currentType);
                if (genericVars && getReturn.identifier) {
                    const paramIdx = genericVars.indexOf(getReturn.identifier);
                    if (paramIdx >= 0 && paramIdx < currentGenericArgs.length) {
                        elemGenericArgs = currentGenericArgs[paramIdx].genericArgs;
                    }
                }
            }
            
            currentType = elemType;
            currentGenericArgs = elemGenericArgs;
        }
        
        return currentType;
    }

    /**
     * Find the function containing the given position
     */
    private findContainingFunction(ast: File, pos: Position): FunctionDeclNode | null {
        for (const node of ast.body) {
            if (node.kind === 'FunctionDecl') {
                const func = node as FunctionDeclNode;
                if (this.positionInRange(pos, func.start, func.end)) {
                    return func;
                }
            }
            
            if (node.kind === 'ClassDecl') {
                for (const member of (node as ClassDeclNode).members || []) {
                    if (member.kind === 'FunctionDecl') {
                        const func = member as FunctionDeclNode;
                        if (this.positionInRange(pos, func.start, func.end)) {
                            return func;
                        }
                    }
                }
            }
        }
        return null;
    }

    /**
     * Find the class containing the given position
     */
    private findContainingClass(ast: File, pos: Position): ClassDeclNode | null {
        for (const node of ast.body) {
            if (node.kind === 'ClassDecl') {
                const cls = node as ClassDeclNode;
                if (this.positionInRange(pos, cls.start, cls.end)) {
                    return cls;
                }
            }
        }
        return null;
    }

    private positionInRange(pos: Position, start: Position, end: Position): boolean {
        if (pos.line < start.line || pos.line > end.line) return false;
        if (pos.line === start.line && pos.character < start.character) return false;
        if (pos.line === end.line && pos.character > end.character) return false;
        return true;
    }

    /**
     * Get member completions for a class type (methods + fields).
     * Walks the FULL inheritance chain INCLUDING modded classes.
     * 
     * @param className   The resolved class name (e.g., "map", not the typedef alias)
     * @param prefix      Filter prefix for completion items (case-insensitive)
     * @param templateMap Optional map of generic param names → concrete types.
     *                    When provided, substitutes generic names in completion details.
     *                    e.g., { "TKey": "string", "TValue": "int" } would show
     *                    Get() as returning "int" instead of "TValue".
     */
    private getClassMemberCompletions(className: string, prefix: string, templateMap?: Map<string, string>): CompletionResult[] {
        const results: CompletionResult[] = [];
        const seen = new Set<string>(); // Deduplicate by name
        
        // Helper to substitute generic type names with concrete types from templateMap.
        // e.g., subst("TValue") → "string" when templateMap has { TValue: "string" }
        // Returns the original name unchanged if not in the map or map is empty.
        const subst = (typeName: string | undefined): string | undefined => {
            if (!typeName || !templateMap || templateMap.size === 0) return typeName;
            return templateMap.get(typeName) || typeName;
        };
        
        // Get the complete class hierarchy including modded classes
        const classHierarchy = this.getClassHierarchyOrdered(className, new Set());
        
        // Collect all class names in the hierarchy to filter out constructors/destructors
        const classNames = new Set(classHierarchy.map(c => c.name));
        
        for (const classNode of classHierarchy) {
            for (const member of classNode.members || []) {
                if (!member.name) continue;
                if (seen.has(member.name)) continue; // Skip duplicates
                if (prefix && !member.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
                
                // Skip static members for instance completions
                if (member.modifiers?.includes('static')) continue;
                
                // Skip constructors and destructors — not valid for instance dot-access
                if (classNames.has(member.name) || member.name.startsWith('~')) continue;
                
                seen.add(member.name);
                
                if (member.kind === 'FunctionDecl') {
                    const func = member as FunctionDeclNode;
                    const params = func.parameters?.map(p => 
                        `${subst(p.type?.identifier) || 'auto'} ${p.name}`
                    ).join(', ') || '';
                    
                    const resolvedReturnType = subst(func.returnType?.identifier) || 'void';
                    
                    // Show visibility modifier if present
                    const visibility = func.modifiers?.find(m => ['private', 'protected'].includes(m)) || '';
                    const visPrefix = visibility ? `${visibility} ` : '';
                    
                    results.push({
                        name: func.name,
                        kind: 'function',
                        detail: `${visPrefix}${resolvedReturnType}(${params}) - ${classNode.name}`,
                        insertText: `${func.name}()`,
                        returnType: resolvedReturnType
                    });
                } else if (member.kind === 'VarDecl') {
                    const field = member as VarDeclNode;
                    const resolvedFieldType = subst(field.type?.identifier) || 'auto';
                    const visibility = field.modifiers?.find(m => ['private', 'protected'].includes(m)) || '';
                    const visPrefix = visibility ? `${visibility} ` : '';
                    
                    results.push({
                        name: field.name,
                        kind: 'variable',
                        detail: `${visPrefix}${resolvedFieldType} - ${classNode.name}`
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * Get static member completions for a class (ClassName.StaticMethod())
     * Walks the full hierarchy: parent classes + modded classes
     */
    private getStaticMemberCompletions(classNode: ClassDeclNode, prefix: string): CompletionResult[] {
        const results: CompletionResult[] = [];
        const seen = new Set<string>();
        
        // Walk full hierarchy: parents + modded versions
        const classHierarchy = this.getClassHierarchyOrdered(classNode.name, new Set());
        
        for (const cls of classHierarchy) {
            for (const member of cls.members || []) {
                if (!member.name) continue;
                if (!member.modifiers?.includes('static')) continue;
                if (seen.has(member.name)) continue;
                if (prefix && !member.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
                
                seen.add(member.name);
                
                if (member.kind === 'FunctionDecl') {
                    const func = member as FunctionDeclNode;
                    const params = func.parameters?.map(p => 
                        `${p.type?.identifier || 'auto'} ${p.name}`
                    ).join(', ') || '';
                    
                    results.push({
                        name: `${func.name}(${params})`,
                        kind: 'function',
                        detail: `${func.returnType?.identifier || 'void'} (static)`,
                        insertText: `${func.name}()`
                    });
                } else if (member.kind === 'VarDecl') {
                    const field = member as VarDeclNode;
                    results.push({
                        name: field.name,
                        kind: 'variable',
                        detail: `${field.type?.identifier || 'auto'} (static)`
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * Find a class by name across all cached documents
     * Uses the pre-built class index for O(1) lookup.
     */
    private findClassByName(className: string): ClassDeclNode | null {
        const classes = this.classIndex.get(className);
        // Return the first non-modded class, or the first modded one if no original exists
        if (classes && classes.length > 0) {
            return classes.find(c => !c.modifiers?.includes('modded')) || classes[0];
        }
        return null;
    }

    /**
     * Find an enum by name across all indexed files
     * Uses the pre-built enum index for O(1) lookup.
     */
    private findEnumByName(enumName: string): EnumDeclNode | null {
        return this.enumIndex.get(enumName) || null;
    }

    /**
     * Find the module level (1–5) where a symbol is defined.
     * Returns 0 if the symbol is not found or has no module info.
     * Uses pre-built indexes for fast lookup.
     */
    private getModuleForSymbol(symbolName: string): number {
        // Check class index
        const classes = this.classIndex.get(symbolName);
        if (classes && classes.length > 0) {
            const sourceUri = (classes[0] as any)._sourceUri;
            if (sourceUri) {
                const ast = this.docCache.get(sourceUri);
                if (ast?.module) return ast.module;
            }
        }
        
        // Check enum index
        const enumNode = this.enumIndex.get(symbolName);
        if (enumNode) {
            const sourceUri = (enumNode as any)._sourceUri;
            if (sourceUri) {
                const ast = this.docCache.get(sourceUri);
                if (ast?.module) return ast.module;
            }
        }
        
        // Check function index
        const funcs = this.functionIndex.get(symbolName);
        if (funcs && funcs.length > 0) {
            const sourceUri = (funcs[0] as any)._sourceUri;
            if (sourceUri) {
                const ast = this.docCache.get(sourceUri);
                if (ast?.module) return ast.module;
            }
        }
        
        // Check typedef index
        const typedefNode = this.typedefIndex.get(symbolName);
        if (typedefNode) {
            const sourceUri = (typedefNode as any)._sourceUri;
            if (sourceUri) {
                const ast = this.docCache.get(sourceUri);
                if (ast?.module) return ast.module;
            }
        }
        
        return 0;
    }

    /**
     * Get completions for enum members (e.g., MuzzleState. → shows U, L, etc.)
     */
    private getEnumMemberCompletions(enumNode: EnumDeclNode, prefix: string): CompletionResult[] {
        const results: CompletionResult[] = [];
        
        for (const member of enumNode.members || []) {
            if (!member.name) continue;
            if (prefix && !member.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
            
            results.push({
                name: member.name,
                kind: 'enumMember',
                detail: `${enumNode.name}.${member.name}`
            });
        }
        
        return results;
    }

    /**
     * Get completion detail text for a node
     */
    private getCompletionDetail(node: SymbolNodeBase): string {
        switch (node.kind) {
            case 'ClassDecl': {
                const cls = node as ClassDeclNode;
                return cls.base ? `extends ${cls.base.identifier}` : 'class';
            }
            case 'FunctionDecl': {
                const func = node as FunctionDeclNode;
                return func.returnType?.identifier || 'void';
            }
            case 'VarDecl': {
                const v = node as VarDeclNode;
                return v.type?.identifier || 'auto';
            }
            case 'EnumDecl':
                return 'enum';
            default:
                return '';
        }
    }

    resolveDefinitions(doc: TextDocument, _pos: Position): SymbolNodeBase[] {
        const offset = doc.offsetAt(_pos);
        const text = doc.getText();

        const token = getTokenAtPosition(text, offset);
        if (!token) return [];
        
        // Allow identifiers AND type-keywords (string, int, float, bool, vector, typename)
        // These are keywords in the lexer but also real classes defined in enconvert.c / enstring.c
        const typeKeywords = new Set(['string', 'int', 'float', 'bool', 'vector', 'typename', 'void']);
        if (token.kind !== TokenKind.Identifier && 
            !(token.kind === TokenKind.Keyword && typeKeywords.has(token.value)) &&
            !(token.kind === TokenKind.Keyword && token.value === 'this')) {
            return [];
        }

        const name = token.value;
        
        // Handle 'this' keyword — navigate to the containing class definition
        if (name === 'this') {
            const ast = this.ensure(doc);
            const containingClass = this.findContainingClass(ast, _pos);
            if (containingClass) {
                // Return the class from classIndex for proper URI/position
                const indexed = this.classIndex.get(containingClass.name);
                if (indexed && indexed.length > 0) {
                    return [indexed[0] as SymbolNodeBase];
                }
                // Fallback: return the local AST class node
                return [containingClass as SymbolNodeBase];
            }
            return [];
        }

        // Check if this is a member access (e.g., player.GetInputType or GetGame().GetTime())
        // Look backwards from the token start to find a dot
        const textBeforeToken = text.substring(0, token.start);
        
        // ================================================================
        // UNIFIED CHAIN RESOLUTION — handles all dot-chain patterns:
        //   variable.member, variable.field.method, func().method,
        //   func().field.method, Class.StaticMethod, this.field.method,
        //   and arbitrarily deep chains with nested parentheses.
        // ================================================================
        const ast = this.ensure(doc);
        const chainResult = this.resolveFullChain(textBeforeToken, doc, _pos, ast);
        if (chainResult) {
            const classMatches = this.findMemberInClassHierarchy(chainResult.type, name);
            if (classMatches.length > 0) {
                return classMatches;
            }
            // If the chain resolved to a type but the member wasn't found,
            // check if it's an enum member access (e.g., EnumType.VALUE)
            const enumNode = this.enumIndex.get(chainResult.type);
            if (enumNode) {
                for (const member of enumNode.members) {
                    if (member.name === name) {
                        return [member as SymbolNodeBase];
                    }
                }
            }
        }
        
        // Check if we're inside a class - prioritize current class and inheritance
        const containingClass = this.findContainingClass(ast, _pos);
        
        if (containingClass) {
            // First, look in current class hierarchy via classIndex
            const hierarchyMatches = this.findMemberInClassHierarchy(containingClass.name, name);
            if (hierarchyMatches.length > 0) {
                return hierarchyMatches;
            }
            // Fallback: search local AST class members directly — works even if
            // classIndex is stale or not yet populated for this file
            for (const member of containingClass.members || []) {
                if (member.name === name) {
                    return [member as SymbolNodeBase];
                }
            }
        }

        // FALLBACK: Global search using pre-built indexes
        // - Enum members ONLY if accessed via EnumName.member
        // - Class members ONLY if inside that class (already checked above)
        const matches: SymbolNodeBase[] = [];

        // Check if this is an enum member access (e.g., MuzzleState.U)
        const enumMemberMatch = textBeforeToken.match(/(\w+)\s*\.\s*$/);
        const isEnumAccess = enumMemberMatch && enumMemberMatch[1][0] === enumMemberMatch[1][0].toUpperCase();

        // Check class index
        const classes = this.classIndex.get(name);
        if (classes) {
            for (const c of classes) matches.push(c as SymbolNodeBase);
        }
        
        // Check function index
        const funcs = this.functionIndex.get(name);
        if (funcs) {
            for (const f of funcs) matches.push(f as SymbolNodeBase);
        }
        
        // Check enum index
        const enumNode = this.enumIndex.get(name);
        if (enumNode) {
            matches.push(enumNode as SymbolNodeBase);
        }
        
        // Check typedef index
        const typedefNode = this.typedefIndex.get(name);
        if (typedefNode) {
            matches.push(typedefNode as SymbolNodeBase);
        }
        
        // Check global symbol index for variables
        const globalSymbol = this.globalSymbolIndex.get(name);
        if (globalSymbol && globalSymbol.kind === 'variable') {
            // Need to find the actual VarDeclNode - search docCache for this specific variable
            const ast = this.docCache.get(globalSymbol.uri);
            if (ast) {
                for (const node of ast.body) {
                    if (node.kind === 'VarDecl' && node.name === name) {
                        matches.push(node as SymbolNodeBase);
                        break;
                    }
                }
            }
        }

        // Enum member match - ONLY if accessed via EnumName.member
        if (isEnumAccess && enumMemberMatch) {
            const enumDecl = this.enumIndex.get(enumMemberMatch[1]);
            if (enumDecl) {
                for (const member of enumDecl.members) {
                    if (member.name === name) {
                        matches.push(member as SymbolNodeBase);
                    }
                }
            }
        }
        
        // Class members are NOT included in global search
        // They should only be found via:
        // 1. Member access (player.Method) - handled above
        // 2. Inside the class (this.Method or just Method) - handled above
        // 3. Inheritance chain - handled above

        return matches;
    }

    /**
     * Find a member (method or field) in a class and its full hierarchy
     * Includes: parent classes (extends) and modded classes
     */
    private findMemberInClassHierarchy(className: string, memberName: string): SymbolNodeBase[] {
        const matches: SymbolNodeBase[] = [];
        const visited = new Set<string>();
        
        // Collect all classes in the hierarchy (inheritance + modded)
        // Returns in order: base classes first, then derived, with modded grouped by class
        const classesToSearch = this.getClassHierarchyOrdered(className, visited);
        
        const seenPositions = new Set<string>();
        for (const classNode of classesToSearch) {
            for (const member of classNode.members || []) {
                if (member.name === memberName) {
                    // Deduplicate by file path + position to avoid showing
                    // the same definition twice when the same file is indexed
                    // under different URIs (e.g., workspace + include path).
                    const srcUri = (classNode as any)._sourceUri as string | undefined;
                    const key = `${srcUri ?? ''}:${member.nameStart.line}:${member.nameStart.character}`;
                    if (!seenPositions.has(key)) {
                        seenPositions.add(key);
                        // Attach container class info for rich hover display
                        (member as any)._containerClassName = classNode.name;
                        (member as any)._containerIsModded = classNode.modifiers?.includes('modded') ?? false;
                        (member as any)._sourceUri = srcUri;
                        matches.push(member as SymbolNodeBase);
                    }
                }
            }
        }
        
        // Second-pass dedup: collapse entries from different URIs whose file
        // paths resolve to the same relative path (handles the same mod
        // indexed from both the workspace and an include path).
        if (matches.length > 1) {
            const pathKey = (node: SymbolNodeBase): string => {
                const uri = (node as any)._sourceUri as string | undefined;
                if (!uri) return '';
                try {
                    // Extract path from URI, normalize slashes, take last 3 segments
                    const fsPath = url.fileURLToPath(uri).replace(/\\/g, '/').toLowerCase();
                    const parts = fsPath.split('/');
                    return parts.slice(-3).join('/') + ':' + node.nameStart.line;
                } catch {
                    return uri + ':' + node.nameStart.line;
                }
            };
            const seen = new Set<string>();
            const deduped: SymbolNodeBase[] = [];
            for (const m of matches) {
                const pk = pathKey(m);
                if (!seen.has(pk)) {
                    seen.add(pk);
                    deduped.push(m);
                }
            }
            return deduped;
        }
        
        return matches;
    }

    /**
     * Get all classes in a hierarchy in inheritance order:
     * 1. Root base class first (e.g., Managed)
     * 2. Then each level of inheritance down to the target class
     * 3. Modded classes are grouped with their base class
     * 
     * Example for PlayerBase extends ManBase extends Entity:
     *   Returns: [Entity, modded Entity, ManBase, modded ManBase, PlayerBase, modded PlayerBase]
     */
    private getClassHierarchyOrdered(className: string, visited: Set<string>): ClassDeclNode[] {
        if (visited.has(className)) return [];
        visited.add(className);
        
        // Find all classes with this name (original + modded versions)
        // Deduplicate by _sourceUri in case the same file was indexed under
        // different URI casings (Windows path case-insensitivity).
        // Also dedup by path suffix to handle the same file indexed from both
        // the workspace and an include path under different full URIs.
        const rawClassNodes = this.findAllClassesByName(className);
        const seenSourceUris = new Set<string>();
        const classNodes: ClassDeclNode[] = [];
        for (const node of rawClassNodes) {
            const srcUri = (node as any)._sourceUri as string | undefined;
            if (srcUri) {
                // Skip non-file entries (e.g. chat code blocks indexed by VS Code)
                if (!srcUri.startsWith('file:')) continue;
                if (seenSourceUris.has(srcUri)) continue;
                seenSourceUris.add(srcUri);
            }
            classNodes.push(node);
        }
        if (classNodes.length === 0) {
            // className might be a typedef (e.g., typedef ItemBase InventoryItemSuper)
            // Resolve through typedef and retry with the underlying type
            const resolved = this.resolveTypedef(className);
            if (resolved !== className) {
                return this.getClassHierarchyOrdered(resolved, visited);
            }
            return [];
        }
        
        // Separate original class from modded classes
        const originalClass = classNodes.find(c => !c.modifiers?.includes('modded'));
        const moddedClasses = classNodes.filter(c => c.modifiers?.includes('modded'));
        
        // Get the base class name (from original or first modded)
        const baseClassName = (originalClass || classNodes[0])?.base?.identifier;
        
        // Recursively get parent hierarchy FIRST (so base classes come first)
        // If no explicit base class, implicitly inherit from 'Class' (the root of all
        // Enforce Script classes), so built-in methods like Cast, CastTo, etc. are found.
        // Also: if explicit base can't be found (e.g. engine-internal class), still
        // fall through to 'Class' so built-in methods are always available.
        let parentHierarchy: ClassDeclNode[] = [];
        if (baseClassName) {
            parentHierarchy = this.getClassHierarchyOrdered(baseClassName, visited);
            if (parentHierarchy.length === 0 && className !== 'Class') {
                // Explicit base not found — still inherit from Class
                parentHierarchy = this.getClassHierarchyOrdered('Class', visited);
            }
        } else if (className !== 'Class') {
            parentHierarchy = this.getClassHierarchyOrdered('Class', visited);
        }
        
        // Build result: parents first, then this class (original + modded)
        const result: ClassDeclNode[] = [...parentHierarchy];
        
        // Add original class first, then modded classes
        if (originalClass) {
            result.push(originalClass);
        }
        result.push(...moddedClasses);
        
        return result;
    }

    /**
     * Get all classes in a hierarchy including:
     * - The class itself
     * - All parent classes (via extends)
     * - All modded versions of any class in the hierarchy
     * @deprecated Use getClassHierarchyOrdered for ordered results
     */
    private getClassHierarchy(className: string, visited: Set<string>): ClassDeclNode[] {
        const result: ClassDeclNode[] = [];
        
        if (visited.has(className)) return result;
        visited.add(className);
        
        // Find all classes with this name (includes modded classes)
        const classNodes = this.findAllClassesByName(className);
        
        for (const classNode of classNodes) {
            result.push(classNode);
            
            // Walk up inheritance chain
            if (classNode.base?.identifier) {
                const parentClasses = this.getClassHierarchy(classNode.base.identifier, visited);
                result.push(...parentClasses);
            }
        }
        
        return result;
    }

    /**
     * Find all classes with a given name (handles modded classes)
     * In Enforce Script, multiple 'modded class X' can exist for the same class
     * Uses the pre-built class index for O(1) lookup.
     */
    private findAllClassesByName(className: string): ClassDeclNode[] {
        return this.classIndex.get(className) || [];
    }

    getHover(doc: TextDocument, _pos: Position): string | null {
        // Build template context for member accesses so hover shows
        // concrete types (e.g., "string" instead of "TValue")
        const templateMap = this.buildHoverTemplateMap(doc, _pos);
        
        const symbols = this.resolveDefinitions(doc, _pos);
        if (symbols.length === 0) return null;

        // If there are multiple results for the same member name (overrides
        // across the class hierarchy), show them as a hierarchy chain with
        // class names and file paths for easy navigation.
        const hasMemberContext = symbols.some(s => (s as any)._containerClassName);
        if (hasMemberContext && symbols.length > 1) {
            return this.formatOverrideChain(symbols, templateMap);
        }

        // For class definitions, show the full inheritance chain
        if (symbols.length >= 1 && symbols[0].kind === 'ClassDecl') {
            const cls = symbols[0] as ClassDeclNode;
            const chain = this.getInheritanceChainNames(cls.name);
            const decl = formatDeclaration(cls, templateMap);
            if (chain.length > 1) {
                return decl + '\n\n**Inheritance:** ' + chain.join(' → ');
            }
            return decl;
        }

        return symbols
            .map((s) => formatDeclaration(s, templateMap))
            .join('\n\n');
    }

    /**
     * Format a list of overrides as a hierarchy chain for the hover tooltip.
     * Shows each definition with its containing class and file path.
     */
    private formatOverrideChain(symbols: SymbolNodeBase[], templateMap?: Map<string, string>): string {
        const lines: string[] = [];
        
        for (const sym of symbols) {
            const className = (sym as any)._containerClassName as string | undefined;
            const isModded = (sym as any)._containerIsModded as boolean | undefined;
            const sourceUri = (sym as any)._sourceUri as string | undefined;
            
            // Format the declaration
            const decl = formatDeclaration(sym, templateMap);
            
            // Build context line: class name + file path
            let context = '';
            if (className) {
                const prefix = isModded ? 'modded ' : '';
                context = `*${prefix}${className}*`;
            }
            if (sourceUri) {
                try {
                    const fsPath = url.fileURLToPath(sourceUri).replace(/\\/g, '/');
                    // Show the last meaningful path segments (e.g., Scripts/5_Mission/Mission.c)
                    const parts = fsPath.split('/');
                    const shortPath = parts.slice(-3).join('/');
                    context += context ? ` — \`${shortPath}:${sym.nameStart.line + 1}\`` : `\`${shortPath}:${sym.nameStart.line + 1}\``;
                } catch { /* ignore */ }
            }
            
            if (context) {
                lines.push(`${context}\n${decl}`);
            } else {
                lines.push(decl);
            }
        }
        
        return lines.join('\n\n---\n\n');
    }

    /**
     * Get the inheritance chain names for a class (bottom-up: target → ... → root).
     * e.g., PlayerBase → ManBase → EntityAI → Entity → Managed → Class
     */
    private getInheritanceChainNames(className: string): string[] {
        const chain: string[] = [];
        const visited = new Set<string>();
        let current = className;
        while (current && !visited.has(current)) {
            visited.add(current);
            chain.push(current);
            const classes = this.classIndex.get(current);
            if (!classes || classes.length === 0) break;
            const original = classes.find(c => !c.modifiers?.includes('modded')) || classes[0];
            const base = original.base?.identifier;
            if (!base) break;
            current = base;
        }
        return chain;
    }

    /**
     * Build a template substitution map for hover at the given position.
     * When hovering over a member of a generic/typedef'd variable (e.g., testMap.Get),
     * this builds a map like { TKey: "string", TValue: "int" } so the hover can
     * display concrete types instead of generic parameter names.
     */
    private buildHoverTemplateMap(doc: TextDocument, _pos: Position): Map<string, string> | undefined {
        const offset = doc.offsetAt(_pos);
        const text = doc.getText();
        const token = getTokenAtPosition(text, offset);
        if (!token) return undefined;
        
        const typeKeywords = new Set(['string', 'int', 'float', 'bool', 'vector', 'typename', 'void']);
        if (token.kind !== TokenKind.Identifier &&
            !(token.kind === TokenKind.Keyword && typeKeywords.has(token.value))) {
            return undefined;
        }
        
        const textBeforeToken = text.substring(0, token.start);
        
        // Use the unified chain resolver for all dot-chain patterns
        const ast = this.ensure(doc);
        const chainResult = this.resolveFullChain(textBeforeToken, doc, _pos, ast);
        if (chainResult && chainResult.templateMap.size > 0) {
            return chainResult.templateMap;
        }
        
        return undefined;
    }

    findReferences(doc: TextDocument, _pos: Position, _inc: boolean) {
        return [];
    }

    prepareRename(doc: TextDocument, _pos: Position): Range | null {
        return null;
    }

    renameSymbol(doc: TextDocument, _pos: Position, _newName: string) {
        return [] as { uri: string; range: Range }[];
    }

    // ========================================================================
    // WORKSPACE SYMBOL SEARCH - Three-Tier Priority System
    // ========================================================================
    // Problem: When searching for "U", we want "U()" to appear before "UFLog",
    // "Update", "UnitTest", etc. Simple .includes() returns them in arbitrary order.
    //
    // Solution: Three-tier priority:
    //   1. EXACT MATCHES - Symbol name exactly equals query (highest priority)
    //   2. PREFIX MATCHES - Symbol name starts with query
    //   3. CONTAINS MATCHES - Symbol name contains query anywhere (lowest priority)
    //
    // Results are returned in priority order: exact first, then prefix, then contains.
    // ========================================================================

    /**
     * Collect symbols with three-tier prioritization
     */
    private collectSymbolsPrioritized(
        uri: string,
        query: string,
        members: SymbolNodeBase[],
        exactMatches: SymbolInformation[],
        prefixMatches: SymbolInformation[],
        containsMatches: SymbolInformation[],
        containerName?: string,
        kinds?: SymbolKind[]
    ): void {
        const queryLower = query.toLowerCase();
        
        for (const node of members) {
            const nameLower = node.name.toLowerCase();
            const nodeKind = toSymbolKind(node.kind);
            
            // Check if this kind is allowed (if filter specified)
            const kindMatch = !kinds || kinds.length === 0 || kinds.includes(nodeKind);
            
            // Determine match type
            const isExact = nameLower === queryLower;
            const isPrefix = !isExact && nameLower.startsWith(queryLower);
            const isContains = !isExact && !isPrefix && nameLower.includes(queryLower);
            
            if (kindMatch && (isExact || isPrefix || isContains)) {
                const symbolInfo: SymbolInformation = {
                    name: node.name,
                    kind: nodeKind,
                    containerName: containerName,
                    location: { uri, range: { start: node.nameStart, end: node.nameEnd } }
                };
                
                if (isExact) {
                    exactMatches.push(symbolInfo);
                } else if (isPrefix) {
                    prefixMatches.push(symbolInfo);
                } else {
                    containsMatches.push(symbolInfo);
                }
            }

            // Recurse into class members
            if (node.kind === "ClassDecl") {
                this.collectSymbolsPrioritized(
                    uri, query, (node as ClassDeclNode).members,
                    exactMatches, prefixMatches, containsMatches,
                    node.name, kinds
                );
            }

            // Handle enum members - IMPORTANT: respect kinds filter!
            // Bug fix: Previously enum members were always returned even when
            // searching for functions. Now we check the kinds filter.
            if (node.kind === "EnumDecl") {
                const enumMemberKindMatch = !kinds || kinds.length === 0 || kinds.includes(SymbolKind.EnumMember);
                
                if (enumMemberKindMatch) {
                    for (const enumerator of (node as EnumDeclNode).members) {
                        const enumNameLower = enumerator.name.toLowerCase();
                        const enumExact = enumNameLower === queryLower;
                        const enumPrefix = !enumExact && enumNameLower.startsWith(queryLower);
                        const enumContains = !enumExact && !enumPrefix && enumNameLower.includes(queryLower);
                        
                        if (enumExact || enumPrefix || enumContains) {
                            const enumSymbol: SymbolInformation = {
                                name: enumerator.name,
                                kind: SymbolKind.EnumMember,
                                containerName: node.name,
                                location: { uri, range: { start: enumerator.nameStart, end: enumerator.nameEnd } }
                            };
                            
                            if (enumExact) {
                                exactMatches.push(enumSymbol);
                            } else if (enumPrefix) {
                                prefixMatches.push(enumSymbol);
                            } else {
                                containsMatches.push(enumSymbol);
                            }
                        }
                    }
                }
            }
        }
    }

    /**
     * Get workspace symbols with optional kind filtering
     * Uses three-tier priority: exact > prefix > contains
     */
    getWorkspaceSymbols(query: string, kinds?: SymbolKind[]): SymbolInformation[] {
        const exactMatches: SymbolInformation[] = [];
        const prefixMatches: SymbolInformation[] = [];
        const containsMatches: SymbolInformation[] = [];
        
        for (const [uri, ast] of this.docCache) {
            this.collectSymbolsPrioritized(
                uri, query, ast.body,
                exactMatches, prefixMatches, containsMatches,
                undefined, kinds
            );
        }
        
        // Return in priority order: exact first, then prefix, then contains
        return [...exactMatches, ...prefixMatches, ...containsMatches];
    }

    // Legacy method for backwards compatibility
    getInnerWorkspaceSymbols(uri: string, query: string, members: SymbolNodeBase[], containerName?: string): SymbolInformation[] {
        const res: SymbolInformation[] = [];
        for (const node of members) {
            if (node.name.includes(query)) {
                res.push({
                    name: node.name,
                    kind: toSymbolKind(node.kind),
                    containerName: containerName,
                    location: { uri, range: { start: node.nameStart, end: node.nameEnd } }
                });
            }

            if (node.kind === "ClassDecl") {
                res.push(...this.getInnerWorkspaceSymbols(uri, query, (node as ClassDeclNode).members, node.name));
            }

            if (node.kind === "EnumDecl") {
                for (const enumerator of (node as EnumDeclNode).members) {
                    if (enumerator.name.includes(query)) {
                        res.push({
                            name: enumerator.name,
                            kind: SymbolKind.EnumMember,
                            containerName: node.name,
                            location: { uri, range: { start: enumerator.nameStart, end: enumerator.nameEnd } }
                        })
                    }
                }
            }
        }
        return res
    }

    // Minimum number of indexed files before running type checks
    // This prevents false positives during initial indexing
    private static readonly MIN_INDEX_SIZE_FOR_TYPE_CHECKS = 100;

    // ========================================================================
    // DIAGNOSTIC CONTEXT — shared pre-computed data for all diagnostic passes
    // ========================================================================
    // Built once per runDiagnostics() invocation instead of duplicated in
    // each checker. Contains:
    //   - text: ifdef-stripped source text (preserves line numbers)
    //   - lines: text.split('\n') — used by line-based scanners
    //   - lineOffsets: cumulative character offsets per line for O(1) lookup
    //   - ast: parsed AST for this document
    //   - doc: the TextDocument (needed for positionAt)
    //   - scopedVars: unified scoped variable map built entirely from the
    //                 parser's AST (locals are now detected by the parser,
    //                 not regex). Used by type mismatch and call arg checkers
    //                 with different lookup semantics.
    // ========================================================================

    /**
     * Pre-computed line offset table for O(1) line-from-position lookup.
     * lineOffsets[i] = character index where line i starts.
     * To find which line a character position is on, binary-search this array.
     */
    private static buildLineOffsets(text: string): number[] {
        const offsets: number[] = [0]; // Line 0 starts at offset 0
        for (let i = 0; i < text.length; i++) {
            if (text[i] === '\n') {
                offsets.push(i + 1);
            }
        }
        return offsets;
    }

    /**
     * O(1) line number from character position via binary search on pre-built offsets.
     * Equivalent to the old getLineFromPos but without O(n) scan per call.
     */
    private static getLineFromOffset(lineOffsets: number[], pos: number): number {
        // Binary search: find the last lineOffsets[i] <= pos
        let lo = 0, hi = lineOffsets.length - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (lineOffsets[mid] <= pos) {
                lo = mid;
            } else {
                hi = mid - 1;
            }
        }
        return lo;
    }

    /**
     * Check if a character position falls inside a comment or string literal.
     * Uses the same algorithm as the previously duplicated closures in
     * checkTypeMismatches and checkFunctionCallArgs.
     *
     * @param text The full (ifdef-stripped) source text
     * @param position Character offset to test
     */
    private static isInsideCommentOrStringAt(text: string, position: number): boolean {
        // Check single-line comments
        let lineStart = text.lastIndexOf('\n', position) + 1;
        let lineEnd = text.indexOf('\n', position);
        if (lineEnd === -1) lineEnd = text.length;
        const line = text.substring(lineStart, lineEnd);
        const posInLine = position - lineStart;

        // Check if there's a // before this position on the same line
        const commentIdx = line.indexOf('//');
        if (commentIdx >= 0 && commentIdx < posInLine) {
            return true;
        }

        // Check block comments - scan backwards for /* that isn't closed
        let i = position - 1;
        while (i >= 0) {
            if (i > 0 && text[i - 1] === '*' && text[i] === '/') {
                // Found end of block comment, we're outside
                break;
            }
            if (i > 0 && text[i - 1] === '/' && text[i] === '*') {
                // Found start of block comment, we're inside
                return true;
            }
            i--;
        }

        // Check strings - count unescaped quotes before position on same line
        let inString = false;
        let stringChar = '';
        for (let j = 0; j < posInLine; j++) {
            const ch = line[j];
            if (!inString && (ch === '"' || ch === "'")) {
                inString = true;
                stringChar = ch;
            } else if (inString && ch === stringChar) {
                let backslashCount = 0;
                let bi = j - 1;
                while (bi >= 0 && line[bi] === '\\') { backslashCount++; bi--; }
                if (backslashCount % 2 === 0) {
                    inString = false;
                }
            }
        }
        return inString;
    }

    /**
     * Build the unified scoped variable map from AST declarations.
     * Contains ALL variables: globals, class fields, inherited fields, func params,
     * and func locals (detected by the parser — including foreach variables and
     * auto-typed variables).
     *
     * The parser's token-based local detection (prevPrev/prev/t pattern matching)
     * handles all cases previously covered by the regex scanners, and its results
     * are cached per file version, so this work is only done once.
     */
    private buildScopedVarMap(
        ast: File
    ): Map<string, { type: string; startLine: number; endLine: number; isClassField: boolean }[]> {
        type ScopedVarEntry = { type: string; startLine: number; endLine: number; isClassField: boolean };
        const scopedVars = new Map<string, ScopedVarEntry[]>();

        const add = (name: string, type: string, startLine: number, endLine: number, isClassField: boolean) => {
            if (!scopedVars.has(name)) {
                scopedVars.set(name, []);
            }
            scopedVars.get(name)!.push({ type, startLine, endLine, isClassField });
        };

        // ── Phase A: AST-based collection ──────────────────────────────────
        for (const node of ast.body) {
            // Top-level var declarations (globals)
            if (node.kind === 'VarDecl' && node.name && (node as VarDeclNode).type?.identifier) {
                const startLine = node.start?.line ?? 0;
                add(node.name, (node as VarDeclNode).type.identifier, startLine, Number.MAX_SAFE_INTEGER, false);
            }

            if (node.kind === 'FunctionDecl') {
                const funcStart = node.start?.line ?? 0;
                const funcEnd = node.end?.line ?? Number.MAX_SAFE_INTEGER;
                for (const param of (node as FunctionDeclNode).parameters || []) {
                    if (param.name && param.type?.identifier) {
                        add(param.name, param.type.identifier, funcStart, funcEnd, false);
                    }
                }
                // Collect locals from AST (parser-detected locals)
                for (const local of (node as FunctionDeclNode).locals || []) {
                    if (local.name && local.type?.identifier) {
                        const localStart = local.start?.line ?? funcStart;
                        const localEnd = local.scopeEnd?.line ?? funcEnd;
                        add(local.name, local.type.identifier, localStart, localEnd, false);
                    }
                }
            }

            if (node.kind === 'ClassDecl') {
                const cls = node as ClassDeclNode;
                const clsStart = cls.start?.line ?? 0;
                const clsEnd = cls.end?.line ?? Number.MAX_SAFE_INTEGER;

                for (const member of cls.members || []) {
                    // Class fields — marked as class fields for priority lookup
                    if (member.kind === 'VarDecl' && member.name && (member as VarDeclNode).type?.identifier) {
                        add(member.name, (member as VarDeclNode).type.identifier, clsStart, clsEnd, true);
                    }
                    // Methods — collect params, locals, and 'this' reference
                    if (member.kind === 'FunctionDecl') {
                        const func = member as FunctionDeclNode;
                        const fStart = func.start?.line ?? clsStart;
                        const fEnd = func.end?.line ?? clsEnd;
                        // Add 'this' as the containing class type for each method scope
                        add('this', cls.name, fStart, fEnd, false);
                        for (const p of func.parameters || []) {
                            if (p.name && p.type?.identifier) {
                                add(p.name, p.type.identifier, fStart, fEnd, false);
                            }
                        }
                        for (const l of func.locals || []) {
                            if (l.name && l.type?.identifier) {
                                const localStart = l.start?.line ?? fStart;
                                const localEnd = l.scopeEnd?.line ?? fEnd;
                                add(l.name, l.type.identifier, localStart, localEnd, false);
                            }
                        }
                    }
                }

                // Inherited fields from parent classes — marked as class fields.
                // This was only done in checkTypeMismatches; checkFunctionCallArgs
                // compensated via resolveVariableType fallback. Including them in the
                // shared map is safe because they have large ranges (class scope) and
                // checkFunctionCallArgs' smallest-range heuristic will prefer local
                // declarations over them anyway, matching prior behavior.
                // Look up the BASE hierarchy (not cls.name) to avoid including
                // the class itself — reference comparison can fail across re-parses.
                let parentClasses: ClassDeclNode[] = [];
                if (cls.base?.identifier) {
                    parentClasses = this.getClassHierarchyOrdered(cls.base.identifier, new Set());
                } else if (cls.name !== 'Class') {
                    parentClasses = this.getClassHierarchyOrdered('Class', new Set());
                }
                for (const parentClass of parentClasses) {
                    for (const member of parentClass.members || []) {
                        if (member.kind === 'VarDecl' && member.name) {
                            const varMember = member as VarDeclNode;
                            if (varMember.type?.identifier) {
                                add(member.name, varMember.type.identifier, clsStart, clsEnd, true);
                            }
                        }
                    }
                }
            }
        }

        // NOTE: The parser now handles ALL local variable detection, including:
        //   - Standard declarations: Type varName ; / = / ,
        //   - foreach variables: foreach (Type varName : collection)
        //   - auto-typed variables: auto varName = expr;
        //   - Generic-typed variables: array<int> varName;
        // The regex-based Phase B scanner was removed as the parser's
        // locals detection (via prevPrev/prev/current token tracking) now
        // covers every case the regex did, and its results are cached.

        return scopedVars;
    }

    runDiagnostics(doc: TextDocument): Diagnostic[] {
        const ast = this.ensure(doc);
        const diags: Diagnostic[] = [];
        
        // Include parser-generated diagnostics (e.g., ternary operator errors)
        if (ast.diagnostics && ast.diagnostics.length > 0) {
            diags.push(...ast.diagnostics);
        }

        // ── Multi-line string literal detection ───────────────────────────
        // Enforce Script does not support multi-line strings.
        // Scan the raw text for string literals that span multiple lines.
        // Done here (not in the parser) so it works even when parsing fails.
        this.checkMultiLineStrings(doc, diags);
        
        // ── Build shared diagnostic context once ───────────────────────────
        // These pre-computed values are passed to each checker so the
        // expensive work (ifdef stripping, line splitting, line offset table,
        // scoped variable map) is done only once per diagnostic run.
        // Skipped regions are cached on the AST so only the cheap blanking
        // step runs here; the directive-parsing logic ran once at parse time.
        const text = Analyzer.applySkippedRegions(doc.getText(), ast.skippedRegions);
        const lines = text.split('\n');
        const lineOffsets = Analyzer.buildLineOffsets(text);
        
        // Only run type/symbol checks if we have enough indexed files
        // This prevents false positives during initial workspace indexing
        if (this.docCache.size >= Analyzer.MIN_INDEX_SIZE_FOR_TYPE_CHECKS) {
            // Check for unknown types and symbols
            this.checkUnknownSymbols(ast, diags);
            
            // Build scoped variable map once (used by both type mismatch and
            // call arg checkers). Placed here because it requires the index
            // to be populated (getClassHierarchyOrdered for inherited fields).
            const scopedVars = this.buildScopedVarMap(ast);
            
            // Check for type mismatches in assignments
            this.checkTypeMismatches(doc, diags, text, lines, lineOffsets, ast, scopedVars);
            
            // Check function call arguments (param count and types)
            this.checkFunctionCallArgs(doc, diags, text, lines, lineOffsets, ast, scopedVars);
            
            // Check return statements: missing returns in non-void functions
            // and return type mismatches (including downcast warnings)
            this.checkReturnStatements(doc, diags, text, lineOffsets, ast, scopedVars);
            
            // Check that modded classes are in the same script module (or higher)
            // as the original class they are modding
            this.checkModdedClassModules(ast, diags);
        }
        
        // Check for multi-line statements (not supported in Enforce Script)
        // This doesn't require indexing - it's purely syntactic
        this.checkMultiLineStatements(doc, diags, text, lines);

        
        // Check for duplicate variable declarations in same scope
        // Now AST-based: uses parser's locals with scopeEnd ranges instead
        // of re-parsing text line-by-line. Also checks missing 'override' keyword.
        this.checkDuplicateVariables(ast, diags);
        
        return diags;
    }

    // ====================================================================
    // RETURN STATEMENT VALIDATION
    // ====================================================================
    // Checks:
    //   1. Non-void functions with bodies must have at least one return statement
    //   2. Return expressions must be type-compatible with the declared return type
    //   3. Downcast warnings for return expressions (e.g., returning a parent type
    //      where a child type is expected)
    //   4. Void functions should not return a value
    // ====================================================================

    /**
     * Check return statements in all functions (top-level and class methods).
     * 
     * Uses the parser's ReturnStatementInfo to:
     *   - Detect missing return statements in non-void functions
     *   - Validate return expression types against declared return types
     *   - Issue downcast warnings for implicit narrowing conversions
     */
    private checkReturnStatements(
        doc: TextDocument,
        diags: Diagnostic[],
        text: string,
        lineOffsets: number[],
        ast: File,
        scopedVars: Map<string, { type: string; startLine: number; endLine: number; isClassField: boolean }[]>
    ): void {
        // Helper to resolve the type of a variable at a specific line
        const getVarTypeAtLine = (name: string, line: number): string | undefined => {
            const vars = scopedVars.get(name);
            if (!vars) return undefined;
            let bestMatch: { type: string; startLine: number; endLine: number; isClassField: boolean } | undefined;
            for (const v of vars) {
                if (line < v.startLine || line > v.endLine) continue;
                if (v.isClassField) {
                    if (!bestMatch || (bestMatch.isClassField &&
                        (v.endLine - v.startLine) < (bestMatch.endLine - bestMatch.startLine))) {
                        bestMatch = v;
                    }
                } else {
                    if (!bestMatch || bestMatch.isClassField ||
                        (v.endLine - v.startLine) < (bestMatch.endLine - bestMatch.startLine)) {
                        bestMatch = v;
                    }
                }
            }
            return bestMatch?.type;
        };

        // Skip constructors, destructors, proto/native functions
        const shouldCheckFunction = (func: FunctionDeclNode, className?: string): boolean => {
            // Must have a body
            if (!func.hasBody) return false;
            // Skip proto/native (no body to check)
            if (func.modifiers.includes('proto') || func.modifiers.includes('native')) return false;
            // Skip constructors (name matches class name)
            if (className && func.name === className) return false;
            // Skip destructors (name starts with ~)
            if (func.name.startsWith('~')) return false;
            return true;
        };

        // Check a single function's return statements
        const checkFunction = (func: FunctionDeclNode, className?: string): void => {
            if (!shouldCheckFunction(func, className)) return;

            let returnType = func.returnType?.identifier ?? 'void';
            // Reconstruct full generic type string (e.g., "array<CF_XML_Tag>")
            // so that type compatibility checks work correctly for generic returns
            if (func.returnType?.genericArgs && func.returnType.genericArgs.length > 0) {
                returnType = `${returnType}<${func.returnType.genericArgs.map(a => a.identifier).join(', ')}>`;
            }
            const isVoid = returnType === 'void';
            const returns = func.returnStatements || [];

            // 1. Non-void functions must have at least one return statement
            if (!isVoid && returns.length === 0) {
                diags.push({
                    message: `Function '${func.name}' has return type '${returnType}' but has no return statement.`,
                    range: { start: func.nameStart, end: func.nameEnd },
                    severity: DiagnosticSeverity.Warning
                });
                return; // No returns to type-check
            }

            // 2. Validate each return statement
            for (const ret of returns) {
                if (isVoid) {
                    // Void function returning a value
                    if (!ret.isEmpty) {
                        diags.push({
                            message: `Function '${func.name}' has return type 'void' but returns a value.`,
                            range: { start: ret.start, end: ret.end },
                            severity: DiagnosticSeverity.Error
                        });
                    }
                    continue;
                }

                // Non-void function with bare 'return;'
                if (ret.isEmpty) {
                    diags.push({
                        message: `Function '${func.name}' has return type '${returnType}' but returns nothing. Expected a value of type '${returnType}'.`,
                        range: { start: ret.start, end: ret.end },
                        severity: DiagnosticSeverity.Error
                    });
                    continue;
                }

                // Try to resolve the type of the return expression
                const exprText = text.substring(ret.exprStart, ret.exprEnd).trim();
                if (!exprText) continue;

                const resolvedType = this.resolveReturnExpressionType(
                    exprText, doc, ast, ret.start.line, lineOffsets, getVarTypeAtLine, className
                );

                if (!resolvedType) continue; // Can't resolve — skip

                // 3. Check type compatibility (errors and downcast warnings)
                const compat = this.checkTypeCompatibility(returnType, resolvedType);

                if (!compat.compatible) {
                    diags.push({
                        message: compat.message || `Return type mismatch in '${func.name}': cannot return '${resolvedType}' as '${returnType}'.`,
                        range: { start: ret.start, end: ret.end },
                        severity: DiagnosticSeverity.Error
                    });
                } else if (compat.isDowncast) {
                    diags.push({
                        message: compat.message || `Unsafe downcast in return of '${func.name}': returning '${resolvedType}' as '${returnType}'. Use '${returnType}.Cast(value)' or 'Class.CastTo(target, value)' instead.`,
                        range: { start: ret.start, end: ret.end },
                        severity: DiagnosticSeverity.Warning
                    });
                }
            }
        };

        // Process all top-level functions
        for (const node of ast.body) {
            if (node.kind === 'FunctionDecl') {
                checkFunction(node as FunctionDeclNode);
            }
            // Process class methods
            if (node.kind === 'ClassDecl') {
                const cls = node as ClassDeclNode;
                for (const member of cls.members || []) {
                    if (member.kind === 'FunctionDecl') {
                        checkFunction(member as FunctionDeclNode, cls.name);
                    }
                }
            }
        }
    }

    /**
     * Resolve the type of a return expression.
     *
     * Handles common patterns:
     *   - Literals: null, true, false, integers, floats, strings
     *   - Variable references: return varName;
     *   - Function calls: return FuncCall();
     *   - Method chains: return obj.Method().Prop;
     *   - Constructor calls: return new ClassName();
     *   - Cast expressions: return ClassName.Cast(expr);
     *   - Enum values: return EnumName.VALUE;
     *
     * @returns The resolved type name, or null if unresolvable
     */
    private resolveReturnExpressionType(
        expr: string,
        doc: TextDocument,
        ast: File,
        line: number,
        lineOffsets: number[],
        getVarTypeAtLine: (name: string, line: number) => string | undefined,
        className?: string
    ): string | null {
        // Strip outer parentheses: return (expr) → expr
        let trimmed = expr.trim();
        while (trimmed.startsWith('(') && trimmed.endsWith(')')) {
            // Make sure parens are balanced (not just matching start/end)
            let depth = 0;
            let balanced = true;
            for (let i = 0; i < trimmed.length - 1; i++) {
                if (trimmed[i] === '(') depth++;
                else if (trimmed[i] === ')') depth--;
                if (depth === 0) { balanced = false; break; }
            }
            if (!balanced) break;
            trimmed = trimmed.substring(1, trimmed.length - 1).trim();
        }

        // Skip expressions with top-level binary operators (&&, ||, +, -, *, /, %, ==, !=, <, >, etc.)
        // These produce results that are hard to type-check without full expression typing
        if (this.hasTopLevelBinaryOperator(trimmed)) {
            // But if the expression contains comparison/logical operators, the result is bool
            if (this.hasTopLevelComparisonOperator(trimmed)) {
                return 'bool';
            }
            return null; // Too complex to resolve
        }

        // --- Literal patterns ---
        if (trimmed === 'null' || trimmed === 'NULL') return 'null';
        if (trimmed === 'true' || trimmed === 'false') return 'bool';
        if (/^-?\d+$/.test(trimmed)) return 'int';
        if (/^-?\d+\.\d*f?$/.test(trimmed) || /^-?\.\d+f?$/.test(trimmed)) return 'float';
        if (/^".*"$/.test(trimmed)) return 'string';
        // Vector literal: "x y z" is handled by string → vector compat in checkTypeCompatibility

        // --- 'new ClassName(...)' ---
        const newMatch = trimmed.match(/^new\s+(\w+)\s*\(/);
        if (newMatch) return newMatch[1];

        // --- Array literal: {val1, val2, ...} ---
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) return 'array';

        // --- Cast: ClassName.Cast(expr) possibly chained ---
        const castMatch = trimmed.match(/^(\w+)\s*\.\s*Cast\s*\(/);
        if (castMatch) {
            const castType = castMatch[1];
            // Check for chaining after Cast(...)
            const afterCastStart = trimmed.substring(castMatch[0].length);
            let parenDepth = 1, ci = 0;
            while (ci < afterCastStart.length && parenDepth > 0) {
                if (afterCastStart[ci] === '(') parenDepth++;
                else if (afterCastStart[ci] === ')') parenDepth--;
                ci++;
            }
            const afterClose = afterCastStart.substring(ci).trim();
            if (afterClose.startsWith('.')) {
                // Chain continues after Cast — resolve from castType
                const resolved = this.resolveVariableChainType(castType, afterClose);
                if (resolved) return resolved;
            }
            return castType;
        }

        // --- Class.CastTo pattern: Class.CastTo(target, source) returns bool ---
        if (/^Class\s*\.\s*CastTo\s*\(/.test(trimmed)) return 'bool';

        // --- Enum value: EnumName.VALUE ---
        const enumDotMatch = trimmed.match(/^(\w+)\s*\.\s*(\w+)$/);
        if (enumDotMatch) {
            const potentialEnum = enumDotMatch[1];
            if (this.enumIndex.has(potentialEnum)) {
                return potentialEnum;
            }
            // Could also be a static field access — fall through
        }

        // --- Function call (possibly chained): FuncName(...) or FuncName(...).Method(...)  ---
        const funcCallMatch = trimmed.match(/^(\w+)\s*\(/);
        if (funcCallMatch) {
            const funcName = funcCallMatch[1];
            // Check for chaining (. after the closing paren)
            const afterFuncName = trimmed.substring(funcCallMatch[0].length);
            let parenDepth = 1, ci = 0;
            while (ci < afterFuncName.length && parenDepth > 0) {
                if (afterFuncName[ci] === '(') parenDepth++;
                else if (afterFuncName[ci] === ')') parenDepth--;
                ci++;
            }
            const afterCall = afterFuncName.substring(ci).trim();

            if (afterCall.startsWith('.')) {
                // Method chain — delegate to resolveChainReturnType
                return this.resolveChainReturnType(trimmed, className);
            }
            // Single function call — resolve as method of containing class first
            if (className) {
                const methodType = this.resolveMethodReturnType(className, funcName);
                if (methodType) return methodType;
            }
            return this.resolveFunctionReturnType(funcName);
        }

        // --- Variable.method() or variable.property chain ---
        const varChainMatch = trimmed.match(/^(\w+)\s*\.\s*(.+)$/);
        if (varChainMatch) {
            const rootName = varChainMatch[1];
            const chainText = '.' + varChainMatch[2];
            // Resolve the variable's type
            let rootType = getVarTypeAtLine(rootName, line);
            if (!rootType && rootName === 'this' && className) {
                rootType = className;
            }
            if (rootType) {
                const resolved = this.resolveVariableChainType(rootType, chainText);
                if (resolved) return resolved;
            }
        }

        // --- Simple variable reference ---
        const simpleVarMatch = trimmed.match(/^(\w+)$/);
        if (simpleVarMatch) {
            const varName = simpleVarMatch[1];
            // 'this' resolves to the containing class type
            if (varName === 'this' && className) return className;
            // Check local/param/field/global variable
            const varType = getVarTypeAtLine(varName, line);
            if (varType) return varType;
            // Check if it's an enum value or class name used as type
            if (this.enumIndex.has(varName)) return varName;
            if (this.classIndex.has(varName)) return varName;
            // Could be a global function name used as a value (unlikely but possible)
            return null;
        }

        return null; // Unresolvable expression
    }

    /**
     * Check if an expression has a top-level binary operator (outside of balanced parens/brackets).
     * Used to skip complex expressions in return type resolution.
     */
    private hasTopLevelBinaryOperator(expr: string): boolean {
        let depth = 0;
        for (let i = 0; i < expr.length; i++) {
            const ch = expr[i];
            if (ch === '(' || ch === '[') depth++;
            else if (ch === ')' || ch === ']') depth--;
            if (depth === 0) {
                // Check for binary operators (but not unary minus or method chains)
                const rest = expr.substring(i);
                if (/^[\+\-\*\/%](?!=)/.test(rest) && i > 0 && /\w/.test(expr[i - 1])) return true;
                if (/^&&|^\|\|/.test(rest)) return true;
                if (/^==|^!=|^<=|^>=/.test(rest)) return true;
                // Be careful with < and > — they could be generics
                if ((ch === '<' || ch === '>') && i > 0 && /\w/.test(expr[i - 1])) {
                    // If followed by another < or >, or if followed by a type name and comma, it's generic
                    // Simple heuristic: skip
                }
            }
        }
        return false;
    }

    /**
     * Check for duplicate variable declarations within the same scope (AST-based).
     *
     * Walks the parsed AST instead of re-scanning the text line-by-line.
     * Each local in a function body carries a `scopeEnd` set by the parser,
     * so we can determine whether two locals' scopes overlap.
     *
     * Also checks:
     *   – class fields vs inherited fields
     *   – function locals/params vs class fields, inherited fields, globals
     *   – missing `override` keyword on methods that override a parent method
     *
     * In Enforce Script:
     *   - Variables in outer scopes are visible in inner scopes (no shadowing)
     *   - Loop control variables live in the PARENT scope, not the loop block
     *     (the parser naturally captures this because the declaration token
     *      appears before the opening '{' of the loop body)
     *   - Two variables with the same name in sibling, non-overlapping scopes
     *     do NOT conflict (handled via scopeEnd range checking)
     */
    private checkDuplicateVariables(ast: File, diags: Diagnostic[]): void {

        // ── Position helpers ───────────────────────────────────────────────
        const posBefore = (a: Position, b: Position): boolean =>
            a.line < b.line || (a.line === b.line && a.character < b.character);

        // Do two locals' visibility ranges overlap?
        // Each local is visible from its declaration (`start`) to its `scopeEnd`.
        const localScopesOverlap = (a: VarDeclNode, b: VarDeclNode): boolean => {
            if (!a.scopeEnd || !b.scopeEnd) return true; // no scopeEnd → function-wide
            // a visible at b's start: a.start <= b.start < a.scopeEnd
            const aVisAtB = !posBefore(b.start, a.start) && posBefore(b.start, a.scopeEnd);
            // b visible at a's start: b.start <= a.start < b.scopeEnd
            const bVisAtA = !posBefore(a.start, b.start) && posBefore(a.start, b.scopeEnd);
            return aVisAtB || bVisAtA;
        };

        // Report a duplicate-variable diagnostic
        const reportDup = (name: string, decl: SymbolNodeBase, existingLine: number) => {
            diags.push({
                message: `Variable '${name}' is already declared at line ${existingLine + 1}. Enforce Script does not allow duplicate variable names in the same scope.`,
                range: { start: decl.nameStart, end: decl.nameEnd },
                severity: DiagnosticSeverity.Error
            });
        };

        // ── 1. Collect global variables ────────────────────────────────────
        const globalNames = new Map<string, SymbolNodeBase>();
        for (const node of ast.body) {
            if (node.kind === 'VarDecl' && node.name) {
                const existing = globalNames.get(node.name);
                if (existing) {
                    reportDup(node.name, node, existing.start.line);
                } else {
                    globalNames.set(node.name, node);
                }
            }
        }

        // ── 2. Process classes ─────────────────────────────────────────────
        for (const node of ast.body) {
            if (node.kind === 'ClassDecl') {
                this.checkDuplicatesInClass(node as ClassDeclNode, globalNames, diags, reportDup);
            }
        }

        // ── 3. Process free functions (not inside a class) ─────────────────
        for (const node of ast.body) {
            if (node.kind === 'FunctionDecl') {
                const func = node as FunctionDeclNode;
                const isProtoOrNative = func.modifiers.includes('proto') || func.modifiers.includes('native');
                if (!isProtoOrNative) {
                    this.checkDuplicatesInFunction(
                        func, new Map(), new Map(), globalNames, diags,
                        localScopesOverlap, reportDup
                    );
                }
            }
        }
    }

    /**
     * Check duplicates within a single class: fields vs inherited, missing override,
     * and delegate to checkDuplicatesInFunction for each method.
     */
    private checkDuplicatesInClass(
        cls: ClassDeclNode,
        globalNames: Map<string, SymbolNodeBase>,
        diags: Diagnostic[],
        reportDup: (name: string, decl: SymbolNodeBase, existingLine: number) => void
    ): void {

        // Position helper (kept local so each call is self-contained)
        const posBefore = (a: Position, b: Position): boolean =>
            a.line < b.line || (a.line === b.line && a.character < b.character);
        const localScopesOverlap = (a: VarDeclNode, b: VarDeclNode): boolean => {
            if (!a.scopeEnd || !b.scopeEnd) return true;
            const aVisAtB = !posBefore(b.start, a.start) && posBefore(b.start, a.scopeEnd);
            const bVisAtA = !posBefore(a.start, b.start) && posBefore(a.start, b.scopeEnd);
            return aVisAtB || bVisAtA;
        };

        // ── Collect class fields ───────────────────────────────────────────
        const classFields = new Map<string, SymbolNodeBase>();
        for (const member of cls.members || []) {
            if (member.kind === 'VarDecl' && member.name) {
                classFields.set(member.name, member);
            }
        }

        // ── Collect inherited fields & parent method signatures ────────────
        const inheritedFields = new Map<string, SymbolNodeBase>();
        const parentMethods = new Map<string, FunctionDeclNode[]>();

        const isModded = cls.modifiers?.includes('modded');

        // For modded classes: look up the original class (non-modded) + its base
        // hierarchy as the "true parents."  Other modded versions of the same
        // class are "sibling mods" — they can introduce methods, but their
        // indexing order is non-deterministic so we can't treat them as parents.
        //
        // - "missing override" → only fires if method is in true parents
        // - "override without parent" → suppressed only if a sibling INTRODUCES
        //   the method (defines it without override); if all siblings also use
        //   override, nobody introduced it so the warning fires.
        // - "duplicate across mods" → fires when siblings both define the same
        //   method without override (one will shadow the other)
        // - signature mismatch → checked against true parents
        const hierarchyToSearch: ClassDeclNode[] = [];
        // Map<methodName, { anyIntroduced: true if a sibling defines it WITHOUT override }>
        const moddedSiblingMethods = new Map<string, { anyIntroduced: boolean }>();

        if (isModded) {
            const allVersions = this.findAllClassesByName(cls.name);
            const originalClass = allVersions.find(c => !c.modifiers?.includes('modded'));

            // True parents: the original (non-modded) class + its base hierarchy.
            // We look up the BASE of the original to avoid including the original's
            // own modded siblings.  Then add the original itself.
            if (originalClass) {
                hierarchyToSearch.push(originalClass);
                if (originalClass.base?.identifier) {
                    const baseHierarchy = this.getClassHierarchyOrdered(originalClass.base.identifier, new Set());
                    hierarchyToSearch.push(...baseHierarchy);
                } else if (originalClass.name !== 'Class') {
                    const classHierarchy = this.getClassHierarchyOrdered('Class', new Set());
                    hierarchyToSearch.push(...classHierarchy);
                }
            } else {
                // No original found (all modded) — try to get base from first modded
                const anyBase = allVersions[0]?.base?.identifier;
                if (anyBase) {
                    const baseHierarchy = this.getClassHierarchyOrdered(anyBase, new Set());
                    hierarchyToSearch.push(...baseHierarchy);
                } else if (cls.name !== 'Class') {
                    const classHierarchy = this.getClassHierarchyOrdered('Class', new Set());
                    hierarchyToSearch.push(...classHierarchy);
                }
            }

            // Sibling mods: collect method names from other modded versions,
            // tracking whether any sibling INTRODUCES the method (defines it
            // without 'override').  This lets us distinguish:
            //   - Sibling introduces → our 'override' is valid, suppress warning
            //   - All siblings also 'override' → nobody introduced it, warn
            const currentSourceUri = (cls as any)._sourceUri as string | undefined;
            // Also extract file-path suffix for cross-URI dedup (same file
            // indexed from both workspace and include path under different URIs)
            const uriToNormalizedPath = (uri: string | undefined): string => {
                if (!uri) return '';
                try {
                    return url.fileURLToPath(uri).replace(/\\/g, '/').toLowerCase();
                } catch {
                    return uri;
                }
            };
            const currentNormPath = uriToNormalizedPath(currentSourceUri);
            for (const ver of allVersions) {
                if (ver === cls || ver === originalClass) continue;
                // Skip duplicate entries for the same physical file (can happen if
                // the file was indexed under a different URI casing, or if the same
                // mod is indexed from both the workspace and an include path)
                const verSourceUri = (ver as any)._sourceUri as string | undefined;
                if (currentSourceUri && verSourceUri && currentSourceUri === verSourceUri) continue;
                // Fallback: compare full normalized paths to catch cross-URI
                // duplicates where the same file was indexed from different roots
                const verNormPath = uriToNormalizedPath(verSourceUri);
                if (currentNormPath && verNormPath && currentNormPath === verNormPath) continue;
                // Skip non-file entries (e.g. vscode-chat-code-block:// from Copilot Chat)
                if (verSourceUri && !verSourceUri.startsWith('file:')) continue;
                for (const member of ver.members || []) {
                    if (member.kind === 'FunctionDecl' && member.name) {
                        const func = member as FunctionDeclNode;
                        const existing = moddedSiblingMethods.get(member.name);
                        const isIntroduction = !func.isOverride;
                        if (existing) {
                            if (isIntroduction) existing.anyIntroduced = true;
                        } else {
                            moddedSiblingMethods.set(member.name, { anyIntroduced: isIntroduction });
                        }
                    }
                }
            }
        } else {
            // Non-modded class: get parent hierarchy + implicit Class root
            if (cls.base?.identifier) {
                const hierarchy = this.getClassHierarchyOrdered(cls.base.identifier, new Set());
                hierarchyToSearch.push(...hierarchy);
            } else if (cls.name !== 'Class') {
                // No explicit base — implicitly inherits from Class
                const hierarchy = this.getClassHierarchyOrdered('Class', new Set());
                hierarchyToSearch.push(...hierarchy);
            }
        }

        for (const parentClass of hierarchyToSearch) {
            for (const member of parentClass.members || []) {
                if (member.kind === 'VarDecl' && member.name) {
                    if (!inheritedFields.has(member.name)) {
                        inheritedFields.set(member.name, member);
                    }
                }
                if (member.kind === 'FunctionDecl' && member.name) {
                    if (!parentMethods.has(member.name)) {
                        parentMethods.set(member.name, []);
                    }
                    parentMethods.get(member.name)!.push(member as FunctionDeclNode);
                }
            }
        }

        // For "missing override" checks, methods introduced by MODDED parent
        // classes should not force children to add 'override'. Only methods
        // from original (non-modded) parent definitions count.
        const originalParentMethods = new Map<string, FunctionDeclNode[]>();
        for (const parentClass of hierarchyToSearch) {
            if (parentClass.modifiers?.includes('modded')) continue;
            for (const member of parentClass.members || []) {
                if (member.kind === 'FunctionDecl' && member.name) {
                    if (!originalParentMethods.has(member.name)) {
                        originalParentMethods.set(member.name, []);
                    }
                    originalParentMethods.get(member.name)!.push(member as FunctionDeclNode);
                }
            }
        }

        // ── Check class fields against inherited fields & globals ──────────
        for (const [fieldName, fieldNode] of classFields) {
            const inh = inheritedFields.get(fieldName);
            if (inh) {
                reportDup(fieldName, fieldNode, inh.start.line);
                continue;
            }
            const glob = globalNames.get(fieldName);
            if (glob) {
                reportDup(fieldName, fieldNode, glob.start.line);
            }
        }

        // ── Check each method ──────────────────────────────────────────────
        for (const member of cls.members || []) {
            if (member.kind !== 'FunctionDecl') continue;
            const func = member as FunctionDeclNode;

            // Override / inheritance checks (skip constructors and destructors)
            if (func.name && func.name !== cls.name && !func.name.startsWith('~')) {
                const parentOverloads = parentMethods.get(func.name);
                // For "missing override": only original (non-modded) parent methods
                // count. A modded parent adding a method shouldn't force children
                // to add 'override' — the child may be the original introducer.
                const originalOverloads = originalParentMethods.get(func.name);

                if (parentOverloads) {
                    // Method exists in a parent — check override usage
                    if (!func.isOverride) {
                        // Only warn "missing override" if the method exists in an
                        // ORIGINAL (non-modded) parent class definition.
                        if (originalOverloads) {
                            const childParamCount = func.parameters?.length ?? 0;
                            if (originalOverloads.some(p => (p.parameters?.length ?? 0) === childParamCount)) {
                                diags.push({
                                    message: `Method '${func.name}' overrides a method from a parent class but is missing the 'override' keyword.`,
                                    range: { start: func.nameStart, end: func.nameEnd },
                                    severity: DiagnosticSeverity.Warning
                                });
                            }
                        }
                    } else {
                        // Has 'override' — validate signature matches a parent overload
                        const mismatch = this.checkOverrideSignatureMismatch(func, parentOverloads);
                        if (mismatch) {
                            diags.push({
                                message: mismatch,
                                range: { start: func.nameStart, end: func.nameEnd },
                                severity: DiagnosticSeverity.Warning
                            });
                        }
                    }
                } else if (this.docCache.size >= Analyzer.MIN_INDEX_SIZE_FOR_TYPE_CHECKS) {
                    // Method NOT in any parent — check for modded-class edge cases
                    const siblingInfo = moddedSiblingMethods.get(func.name);

                    if (func.isOverride) {
                        // 'override' on a method no parent has — only valid if a
                        // sibling mod introduces it (defines without override).
                        if (!siblingInfo?.anyIntroduced) {
                            diags.push({
                                message: `Method '${func.name}' is marked 'override' but no matching method was found in any parent class.`,
                                range: { start: func.nameStart, end: func.nameEnd },
                                severity: DiagnosticSeverity.Warning
                            });
                        }
                    } else if (isModded && siblingInfo?.anyIntroduced) {
                        // Two mods both introduce the same method without override —
                        // one will shadow the other depending on load order.
                        // Find the conflicting file for the message
                        let conflictFile = '';
                        const siblingVersions = this.findAllClassesByName(cls.name);
                        for (const ver of siblingVersions) {
                            if (ver === cls) continue;
                            if (!ver.modifiers?.includes('modded')) continue;
                            const verUri = (ver as any)._sourceUri as string | undefined;
                            if (verUri) {
                                for (const m of ver.members || []) {
                                    if (m.kind === 'FunctionDecl' && m.name === func.name) {
                                        try { conflictFile = ` (see ${url.fileURLToPath(verUri)})`; } catch { conflictFile = ''; }
                                        break;
                                    }
                                }
                                if (conflictFile) break;
                            }
                        }
                        diags.push({
                            message: `Method '${func.name}' is also defined in another modded version of '${cls.name}' without 'override'. One definition will shadow the other depending on mod load order.${conflictFile}`,
                            range: { start: func.nameStart, end: func.nameEnd },
                            severity: DiagnosticSeverity.Warning
                        });
                    }
                }
            }

            // Duplicate locals check (skip proto/native)
            const isProtoOrNative = func.modifiers.includes('proto') || func.modifiers.includes('native');
            if (!isProtoOrNative) {
                // Build combined ancestor map: globals < inherited < class fields
                // (insertion order means closer scopes overwrite farther ones,
                //  but for duplicate checking we iterate all of them, so the order
                //  only controls which "existing line" is reported first — we
                //  scan outermost first, matching the old text-based behaviour.)
                this.checkDuplicatesInFunction(
                    func, classFields, inheritedFields, globalNames, diags,
                    localScopesOverlap, reportDup
                );
            }
        }
    }

    /**
     * Check whether an override method's signature exactly matches at least one
     * parent overload.  Returns a human-readable mismatch message, or null if
     * a matching overload was found.
     *
     * Checks: return type, parameter count, and for each parameter: type,
     * name, modifiers (out/inout/notnull), and default presence.
     */
    private checkOverrideSignatureMismatch(
        child: FunctionDeclNode,
        parentOverloads: FunctionDeclNode[]
    ): string | null {
        // Helper: get the relevant modifiers for a parameter (out, inout, notnull)
        const paramMods = (p: VarDeclNode): string[] =>
            (p.modifiers || []).filter(m => m === 'out' || m === 'inout' || m === 'notnull');

        // Helper: compare two TypeNode identifiers (case-sensitive)
        const typeEq = (a: TypeNode | undefined, b: TypeNode | undefined): boolean => {
            if (!a && !b) return true;
            if (!a || !b) return false;
            return a.identifier === b.identifier;
        };

        // Try every parent overload — if ANY matches exactly, the override is valid
        let closestMismatch: string | null = null;

        for (const parent of parentOverloads) {
            const childParams = child.parameters || [];
            const parentParams = parent.parameters || [];

            // --- Return type ---
            if (!typeEq(child.returnType, parent.returnType)) {
                const childRet = child.returnType?.identifier ?? 'void';
                const parentRet = parent.returnType?.identifier ?? 'void';
                closestMismatch = `Override '${child.name}' return type '${childRet}' does not match parent return type '${parentRet}'.`;
                continue;
            }

            // --- Parameter count ---
            if (childParams.length !== parentParams.length) {
                closestMismatch = `Override '${child.name}' has ${childParams.length} parameter(s) but parent has ${parentParams.length}.`;
                continue;
            }

            // --- Per-parameter comparison ---
            let paramMismatch: string | null = null;
            for (let i = 0; i < childParams.length; i++) {
                const cp = childParams[i];
                const pp = parentParams[i];

                // Type check
                if (!typeEq(cp.type, pp.type)) {
                    paramMismatch = `Override '${child.name}' parameter ${i + 1} type '${cp.type?.identifier ?? '?'}' does not match parent type '${pp.type?.identifier ?? '?'}'.`;
                    break;
                }

                // Name check
                if (cp.name !== pp.name) {
                    paramMismatch = `Override '${child.name}' parameter ${i + 1} name '${cp.name}' does not match parent name '${pp.name}'.`;
                    break;
                }

                // Modifier check (out, inout, notnull)
                const cMods = paramMods(cp).sort();
                const pMods = paramMods(pp).sort();
                if (cMods.length !== pMods.length || cMods.some((m, j) => m !== pMods[j])) {
                    paramMismatch = `Override '${child.name}' parameter ${i + 1} '${cp.name}' modifiers [${cMods.join(', ')}] do not match parent modifiers [${pMods.join(', ')}].`;
                    break;
                }

                // Default presence check
                if (!!cp.hasDefault !== !!pp.hasDefault) {
                    const childHas = cp.hasDefault ? 'has' : 'missing';
                    const parentHas = pp.hasDefault ? 'has' : 'missing';
                    paramMismatch = `Override '${child.name}' parameter ${i + 1} '${cp.name}' default value mismatch: override ${childHas} default, parent ${parentHas} default.`;
                    break;
                }
            }

            if (paramMismatch) {
                closestMismatch = paramMismatch;
                continue;
            }

            // All checks passed — this overload matches exactly
            return null;
        }

        // No overload matched; return the mismatch from the closest one
        return closestMismatch;
    }

    /**
     * Check for duplicate locals/params within a single function, also
     * checking against class fields, inherited fields, and globals.
     */
    private checkDuplicatesInFunction(
        func: FunctionDeclNode,
        classFields: Map<string, SymbolNodeBase>,
        inheritedFields: Map<string, SymbolNodeBase>,
        globalNames: Map<string, SymbolNodeBase>,
        diags: Diagnostic[],
        localScopesOverlap: (a: VarDeclNode, b: VarDeclNode) => boolean,
        reportDup: (name: string, decl: SymbolNodeBase, existingLine: number) => void
    ): void {

        // Scan order: globals → inherited → class fields (outermost first)
        // This matches the old text-based checker's scope-stack[0..n] scan order.
        const findAncestorConflict = (name: string): SymbolNodeBase | undefined => {
            return globalNames.get(name)
                ?? inheritedFields.get(name)
                ?? classFields.get(name);
        };

        // ── Check parameters ─────────────────────────────────────────
        // Build a set of already-seen param names for intra-param dups.
        const paramNames = new Map<string, SymbolNodeBase>();
        for (const p of func.parameters || []) {
            if (!p.name) continue;
            // Check against ancestors
            const ancestor = findAncestorConflict(p.name);
            if (ancestor) {
                reportDup(p.name, p, ancestor.start.line);
                continue; // don't add to paramNames if it's already a dup
            }
            // Check against prior params in same function
            const priorParam = paramNames.get(p.name);
            if (priorParam) {
                reportDup(p.name, p, priorParam.start.line);
            } else {
                paramNames.set(p.name, p);
            }
        }

        // ── Check locals ─────────────────────────────────────────────
        const locals = func.locals || [];
        for (let i = 0; i < locals.length; i++) {
            const local = locals[i];
            if (!local.name) continue;

            // Check against ancestors (globals/inherited/class fields)
            const ancestor = findAncestorConflict(local.name);
            if (ancestor) {
                reportDup(local.name, local, ancestor.start.line);
                continue;
            }

            // Check against parameters
            const param = paramNames.get(local.name);
            if (param) {
                reportDup(local.name, local, param.start.line);
                continue;
            }

            // Check against earlier locals with overlapping scopes
            for (let j = 0; j < i; j++) {
                const other = locals[j];
                if (other.name !== local.name) continue;
                if (localScopesOverlap(other, local)) {
                    reportDup(local.name, local, other.start.line);
                    break; // only report first conflict
                }
            }
        }
    }

    /**
     * Type compatibility result
     */
    private checkTypeCompatibility(declaredType: string, assignedType: string): {
        compatible: boolean;
        isDowncast: boolean;
        isUpcast: boolean;
        message?: string;
    } {
        // Same type is always compatible
        if (declaredType === assignedType) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // Normalize types (remove ref, autoptr, etc.)
        const normalizeType = (t: string): string => {
            return t.replace(/^(ref|autoptr)\s+/, '').trim();
        };
        
        const declNorm = normalizeType(declaredType);
        const assignNorm = normalizeType(assignedType);
        
        if (declNorm === assignNorm) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // Case-insensitive comparison for primitive names (e.g. String vs string)
        const declLower = declNorm.toLowerCase();
        const assignLower = assignNorm.toLowerCase();
        
        if (declLower === assignLower) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // void is not compatible with anything
        if (declNorm === 'void' || assignNorm === 'void') {
            return { 
                compatible: false, 
                isDowncast: false, 
                isUpcast: false,
                message: `Cannot assign 'void' to a variable`
            };
        }
        
        // auto/typename/Class/Managed are wildcards - always compatible
        // Managed is the root base class for all managed (ref-counted) classes
        // in Enforce Script, so any class is assignable to Managed.
        if (declNorm === 'auto' || assignNorm === 'auto' ||
            declNorm === 'typename' || assignNorm === 'typename' ||
            declNorm === 'Class' || assignNorm === 'Class' ||
            declNorm === 'Managed' || assignNorm === 'Managed') {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // Resolve typedefs before checking compatibility so that typedef'd
        // names are compared against their underlying types.
        const declResolved = this.resolveTypedef(declNorm);
        const assignResolved = this.resolveTypedef(assignNorm);
        
        // If typedef resolution changed anything, re-check with resolved names
        if (declResolved !== declNorm || assignResolved !== assignNorm) {
            // After resolution, the types might now match directly
            if (declResolved === assignResolved) {
                return { compatible: true, isDowncast: false, isUpcast: false };
            }
            if (declResolved.toLowerCase() === assignResolved.toLowerCase()) {
                return { compatible: true, isDowncast: false, isUpcast: false };
            }
        }
        
        // Skip if either type is an unresolvable template parameter (TKey, TValue, T, etc.)
        // These can't be checked without full template substitution, so assume compatible.
        // Check: if the type doesn't exist as a known class, enum, or typedef in the index,
        // it's likely a template parameter or something we can't verify.
        const hardcodedPrimitives = new Set(['int', 'float', 'bool', 'string', 'void', 'vector']);
        const isKnownType = (name: string, nameLower: string): boolean => {
            if (hardcodedPrimitives.has(nameLower)) return true;
            if (this.findAllClassesByName(name).length > 0) return true;
            if (this.enumIndex.has(name)) return true;
            if (this.typedefIndex.has(name)) return true;
            // Also check the resolved form (typedef resolution may have changed the name)
            const resolved = this.resolveTypedef(name);
            if (resolved !== name) {
                if (this.findAllClassesByName(resolved).length > 0) return true;
                if (this.enumIndex.has(resolved)) return true;
            }
            return false;
        };
        const declIsKnown = isKnownType(declNorm, declLower);
        const assignIsKnown = isKnownType(assignNorm, assignLower);
        if (!declIsKnown || !assignIsKnown) {
            return { compatible: true, isDowncast: false, isUpcast: false }; // Unresolvable type
        }
        
        // --- ENUM TYPE COMPATIBILITY ---
        // In Enforce Script, enums are essentially named integers and are very
        // loosely typed. They can be freely assigned to/from int, float, bool,
        // other enum types, and even used interchangeably in many contexts.
        // Treat any type involving an enum as compatible to avoid false positives.
        const declIsEnum = this.enumIndex.has(declNorm) || this.enumIndex.has(declResolved);
        const assignIsEnum = this.enumIndex.has(assignNorm) || this.enumIndex.has(assignResolved);
        
        if (declIsEnum || assignIsEnum) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // array types - need to check element type compatibility
        if (declNorm.startsWith('array<') || assignNorm.startsWith('array<')) {
            const bothArrays = declNorm.startsWith('array') && assignNorm.startsWith('array');
            return { compatible: bothArrays, isDowncast: false, isUpcast: false };
        }
        
        // --- TRY INDEXED CLASS HIERARCHY FIRST ---
        // If types are indexed as classes (including primitives like string, int from enconvert.c),
        // use the hierarchy to determine compatibility before falling back to hardcoded rules.
        
        // Check class hierarchy for UPCAST (use resolved names so typedef'd types work)
        const assignedHierarchy = this.getClassHierarchyOrdered(assignResolved, new Set());
        for (const classNode of assignedHierarchy) {
            if (classNode.name === declResolved || classNode.name === declNorm) {
                return { compatible: true, isDowncast: false, isUpcast: true };
            }
        }
        
        // Check class hierarchy for DOWNCAST
        const declaredHierarchy = this.getClassHierarchyOrdered(declResolved, new Set());
        for (const classNode of declaredHierarchy) {
            if (classNode.name === assignResolved || classNode.name === assignNorm) {
                return { 
                    compatible: true,
                    isDowncast: true, 
                    isUpcast: false,
                    message: `Unsafe downcast from '${assignNorm}' to '${declNorm}'. Use '${declNorm}.Cast(value)' or 'Class.CastTo(target, value)' instead.`
                };
            }
        }
        
        // --- FALLBACK: hardcoded primitive compatibility ---
        // Only used if types aren't found in the indexed class hierarchy
        
        // Numeric types are compatible with each other (implicit conversion)
        const numericTypesFallback = new Set(['int', 'float', 'bool']);
        if (numericTypesFallback.has(declLower) && numericTypesFallback.has(assignLower)) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        const declIsPrimitive = hardcodedPrimitives.has(declLower);
        const assignIsPrimitive = hardcodedPrimitives.has(assignLower);
        
        // string is compatible with string, and string can be implicitly converted to vector
        // in Enforce Script (e.g., "0 0 0" is a valid vector literal)
        if (declLower === 'string' || assignLower === 'string') {
            if (declLower === 'vector' && assignLower === 'string') {
                return { compatible: true, isDowncast: false, isUpcast: false };
            }
            if (declLower !== assignLower) {
                return { 
                    compatible: false, 
                    isDowncast: false, 
                    isUpcast: false,
                    message: `Cannot convert '${assignNorm}' to '${declNorm}'`
                };
            }
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // Primitive vs class (or vice versa) is never compatible
        if (declIsPrimitive !== assignIsPrimitive) {
            return { 
                compatible: false, 
                isDowncast: false, 
                isUpcast: false,
                message: `Cannot assign '${assignNorm}' to '${declNorm}'`
            };
        }
        
        // If both are primitives but different (and not numeric), they're not compatible
        if (declIsPrimitive && assignIsPrimitive && declNorm !== assignNorm) {
            return { 
                compatible: false, 
                isDowncast: false, 
                isUpcast: false,
                message: `Cannot assign '${assignNorm}' to '${declNorm}'`
            };
        }
        
        // No compatibility found - types are unrelated
        return { 
            compatible: false, 
            isDowncast: false, 
            isUpcast: false,
            message: `Cannot assign '${assignNorm}' to '${declNorm}' - types are not related`
        };
    }

    /**
     * Check for type mismatches in variable assignments
     * Checks both:
     * - Declaration with init: Type varName = FunctionCall();
     * - Re-assignment: varName = otherVar;
     */
    private checkTypeMismatches(
        doc: TextDocument,
        diags: Diagnostic[],
        text: string,
        lines: string[],
        lineOffsets: number[],
        ast: File,
        scopedVars: Map<string, { type: string; startLine: number; endLine: number; isClassField: boolean }[]>
    ): void {
        // Helper to get the type of a variable at a specific line
        // Uses isClassField priority: local vars preferred over class fields,
        // then smaller ranges preferred within the same category.
        const getVarTypeAtLine = (name: string, line: number): string | undefined => {
            const vars = scopedVars.get(name);
            if (!vars) return undefined;
            
            // Find the most specific scope that contains this line
            // Priority: 1) local vars in range, 2) class fields in range
            let bestMatch: { type: string; startLine: number; endLine: number; isClassField: boolean } | undefined;
            
            for (const v of vars) {
                // ALL variables (including class fields) must have the line within their scope range
                if (line < v.startLine || line > v.endLine) {
                    continue;
                }
                
                if (v.isClassField) {
                    // Class field in range - prefer smaller (more specific) scope
                    if (!bestMatch || (bestMatch.isClassField && 
                        (v.endLine - v.startLine) < (bestMatch.endLine - bestMatch.startLine))) {
                        bestMatch = v;
                    }
                } else {
                    // Local variable in range - prefer over class fields
                    // and prefer smaller (more specific) ranges
                    if (!bestMatch || bestMatch.isClassField || 
                        (v.endLine - v.startLine) < (bestMatch.endLine - bestMatch.startLine)) {
                        bestMatch = v;
                    }
                }
            }
            
            return bestMatch?.type;
        };
        
        // For variable type scanning, we can still use stripped text since we just need types
        const textForScanning = text
            .replace(/\/\/.*$/gm, '')  // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove multi-line comments
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // Replace "..." with ""
            .replace(/'(?:[^'\\]|\\.)*'/g, "''");  // Replace '...' with ''
        
        // Pattern 1: Type varName = FunctionCall();
        // e.g., int i = GetGame();
        // Use [ \t]+ between type and varName to prevent matching across line breaks
        const funcAssignPattern = /\b(\w+)[ \t]+(\w+)\s*=\s*(\w+)\s*\(/g;
        
        let match;
        while ((match = funcAssignPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) {
                continue;
            }
            
            // Skip if the match spans multiple lines (regex \s* can cross newlines)
            if (match[0].includes('\n')) {
                continue;
            }
            
            const declaredType = match[1];
            const varName = match[2];
            const funcName = match[3];
            
            // Skip if declared type is a keyword that's not a type
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'typedef'].includes(declaredType)) {
                continue;
            }
            
            // Check if this is a method chain like GetGame().GetTime()
            // Look at what comes after this match
            const afterMatch = text.substring(match.index + match[0].length);
            // Find the closing paren and see if there's a dot after
            let parenDepth = 1;
            let chainDetected = false;
            for (let i = 0; i < afterMatch.length && parenDepth > 0; i++) {
                if (afterMatch[i] === '(') parenDepth++;
                else if (afterMatch[i] === ')') parenDepth--;
                if (parenDepth === 0) {
                    // Check if there's a dot after the closing paren
                    const remainder = afterMatch.substring(i + 1).trim();
                    if (remainder.startsWith('.')) {
                        chainDetected = true;
                    }
                    break;
                }
            }
            
            // Resolve return type - either single function or full chain
            let returnType: string | null;
            let highlightLength = match[0].length;  // Default to just the match
            
            if (chainDetected) {
                // Find end of the chain by tracking parens and dot-access patterns.
                // Stop at operators (+, -, *, etc.) or semicolons outside the chain.
                const stmtEnd = afterMatch.indexOf(';');
                let chainEnd = stmtEnd >= 0 ? stmtEnd : afterMatch.length;
                
                // For type resolution, pass everything up to ';' - resolveChainReturnType
                // handles trailing non-chain text gracefully
                const fullChainText = funcName + '(' + afterMatch.substring(0, chainEnd);
                const lineNumForChain = Analyzer.getLineFromOffset(lineOffsets, match.index);
                const chainClass = this.findContainingClass(ast, { line: lineNumForChain, character: 0 });
                returnType = this.resolveChainReturnType(fullChainText, chainClass?.name);
                
                // For highlight, find where the chain actually ends (last ')' or property name)
                // by scanning: balanced parens, then optional .identifier or .identifier(...)
                let hlEnd = 0;
                let depth = 1;
                // First: find closing paren of first call
                for (let ci = 0; ci < afterMatch.length && depth > 0; ci++) {
                    if (afterMatch[ci] === '(') depth++;
                    else if (afterMatch[ci] === ')') depth--;
                    if (depth === 0) { hlEnd = ci + 1; break; }
                }
                // Then: continue following .identifier and .identifier(...)
                let pos = hlEnd;
                while (pos < afterMatch.length) {
                    // Skip whitespace
                    let ws = pos;
                    while (ws < afterMatch.length && (afterMatch[ws] === ' ' || afterMatch[ws] === '\t')) ws++;
                    if (ws >= afterMatch.length || afterMatch[ws] !== '.') break;
                    ws++; // skip dot
                    while (ws < afterMatch.length && (afterMatch[ws] === ' ' || afterMatch[ws] === '\t')) ws++;
                    // Match identifier
                    const idStart = ws;
                    while (ws < afterMatch.length && /\w/.test(afterMatch[ws])) ws++;
                    if (ws === idStart) break; // no identifier after dot
                    pos = ws;
                    hlEnd = pos;
                    // Check for (...)
                    let ps = pos;
                    while (ps < afterMatch.length && (afterMatch[ps] === ' ' || afterMatch[ps] === '\t')) ps++;
                    if (ps < afterMatch.length && afterMatch[ps] === '(') {
                        depth = 1; ps++;
                        while (ps < afterMatch.length && depth > 0) {
                            if (afterMatch[ps] === '(') depth++;
                            else if (afterMatch[ps] === ')') depth--;
                            ps++;
                        }
                        pos = ps;
                        hlEnd = pos;
                    }
                }
                highlightLength = match[0].length + hlEnd;
            } else {
                // Get the return type of the single function
                // Need to find where single function call ends
                let singleEnd = 0;
                let depth = 1;
                for (let i = 0; i < afterMatch.length && depth > 0; i++) {
                    if (afterMatch[i] === '(') depth++;
                    else if (afterMatch[i] === ')') depth--;
                    if (depth === 0) {
                        singleEnd = i + 1;
                        break;
                    }
                }
                // Try to resolve as a method of the containing class first (for unqualified calls like Find())
                // This handles cases where the method is inherited or defined in the current class
                const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
                const containingClass = this.findContainingClass(ast, { line: lineNum, character: 0 });
                if (containingClass) {
                    returnType = this.resolveMethodReturnType(containingClass.name, funcName);
                } else {
                    returnType = null;
                }
                // Fall back to global function lookup if not found in class hierarchy
                if (!returnType) {
                    returnType = this.resolveFunctionReturnType(funcName);
                }
                // Check for array indexing after the function call, e.g. GetOrientation()[0]
                // If present, adjust the return type to the element type
                const afterCall = afterMatch.substring(singleEnd).trim();
                if (afterCall.startsWith('[') && returnType) {
                    returnType = this.resolveIndexedType(returnType);
                }
                highlightLength = match[0].length + singleEnd;
            }
            
            if (returnType) {
                // Skip if the full RHS contains a comparison/boolean operator and declared type is bool
                // e.g., bool equal_typed = item.GetType() == receiver_item.GetType();
                if (declaredType === 'bool') {
                    const stmtEnd1 = afterMatch.indexOf(';');
                    const fullRhs = funcName + '(' + afterMatch.substring(0, stmtEnd1 >= 0 ? stmtEnd1 : afterMatch.length);
                    if (this.hasTopLevelComparisonOperator(fullRhs)) {
                        continue;
                    }
                }
                this.addTypeMismatchDiagnostic(doc, diags, match.index, highlightLength, declaredType, returnType);
            }
        }
        
        // Pattern 2: Type varName = otherVar;
        // e.g., int i = p; where p is PlayerBase
        // Use [ \t]+ between type and varName to prevent matching across line breaks
        const varDeclAssignPattern = /\b(\w+)[ \t]+(\w+)\s*=\s*(\w+)\s*;/g;
        
        while ((match = varDeclAssignPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) {
                continue;
            }
            
            const declaredType = match[1];
            const varName = match[2];
            const sourceVar = match[3];
            
            // Skip if the core assignment part spans multiple lines
            // Build the core: "Type varName = source;" - check this for newlines
            const coreP2 = declaredType + ' ' + varName + match[0].substring(match[0].indexOf(varName) + varName.length);
            if (coreP2.includes('\n')) {
                continue;
            }
            
            
            // Skip if declared type is a keyword
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'else', 'typedef'].includes(declaredType)) {
                continue;
            }
            
            // Skip if source looks like a literal (number, true, false, null)
            if (/^\d+$/.test(sourceVar) || ['true', 'false', 'null', 'NULL'].includes(sourceVar)) {
                continue;
            }
            
            // Look up the type of the source variable at this line
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            const sourceType = getVarTypeAtLine(sourceVar, lineNum);
            
            if (sourceType) {
                this.addTypeMismatchDiagnostic(doc, diags, match.index, match[0].length, declaredType, sourceType);
            }
        }
        
        // Pattern 3: varName = otherVar; (re-assignment, not declaration)
        // Must ensure there's no type before the targetVar
        const reassignPattern = /(?:^|[;{})\n])(\s*)(\w+)\s*=\s*(\w+)\s*;/g;
        
        while ((match = reassignPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) {
                continue;
            }
            
            const leadingWhitespace = match[1];
            const targetVar = match[2];
            const sourceVar = match[3];
            
            // Skip if the core assignment part spans multiple lines
            // Core is "targetVar = sourceVar;" - exclude leading delimiter + whitespace
            const coreP3 = match[0].substring(1 + leadingWhitespace.length);
            if (coreP3.includes('\n')) {
                continue;
            }
            
            // Skip keywords
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'else'].includes(targetVar)) {
                continue;
            }
            
            // Skip literals
            if (/^\d+$/.test(sourceVar) || ['true', 'false', 'null', 'NULL'].includes(sourceVar)) {
                continue;
            }
            
            // Look up types for both variables at this line
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            const targetType = getVarTypeAtLine(targetVar, lineNum);
            const sourceType = getVarTypeAtLine(sourceVar, lineNum);
            
            // Only check if we have confident types for both
            // Skip if either type looks like a generic parameter (single letter) or class name
            if (targetType && sourceType) {
                // Skip generic type parameters and potential misparses
                if (/^[A-Z]$/.test(targetType) || /^[A-Z]$/.test(sourceType)) {
                    continue;
                }
                // Skip if types are identical (even if both are wrong, at least they match)
                if (targetType === sourceType) {
                    continue;
                }
                // Calculate actual start position (skip the leading delimiter and whitespace)
                const actualStart = match.index + 1 + leadingWhitespace.length;
                const actualLength = match[0].length - 1 - leadingWhitespace.length;
                this.addTypeMismatchDiagnostic(doc, diags, actualStart, actualLength, targetType, sourceType);
            }
        }
        
        // Pattern 4: varName = FunctionCall(); (re-assignment with function call)
        // e.g., i = GetGame(); where i is declared as int earlier
        const reassignFuncPattern = /(?:^|[;{})\n])(\s*)(\w+)\s*=\s*(\w+)\s*\(/g;
        
        while ((match = reassignFuncPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) {
                continue;
            }
            
            const leadingWhitespace = match[1];
            const targetVar = match[2];
            const funcName = match[3];
            
            // Skip if the core assignment part spans multiple lines
            // Core is "targetVar = funcName(" - exclude leading delimiter + whitespace
            const coreP4 = match[0].substring(1 + leadingWhitespace.length);
            if (coreP4.includes('\n')) {
                continue;
            }
            
            // Skip keywords
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'else'].includes(targetVar)) {
                continue;
            }
            
            // Check if this is a method chain like U().Msg().SetMeta()
            const afterMatch = text.substring(match.index + match[0].length);
            let parenDepth = 1;
            let chainDetected = false;
            for (let i = 0; i < afterMatch.length && parenDepth > 0; i++) {
                if (afterMatch[i] === '(') parenDepth++;
                else if (afterMatch[i] === ')') parenDepth--;
                if (parenDepth === 0) {
                    const remainder = afterMatch.substring(i + 1).trim();
                    if (remainder.startsWith('.')) {
                        chainDetected = true;
                    }
                    break;
                }
            }
            
            // Look up type of target variable at this line and resolve return type (single or chain)
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            const targetType = getVarTypeAtLine(targetVar, lineNum);
            let returnType: string | null;
            let chainEnd = 0;
            
            if (chainDetected) {
                // Find the end of the full statement (semicolon)
                const stmtEnd = afterMatch.indexOf(';');
                chainEnd = stmtEnd >= 0 ? stmtEnd : afterMatch.length;
                
                const fullChainText = funcName + '(' + afterMatch.substring(0, chainEnd);
                const chainClass2 = this.findContainingClass(ast, { line: lineNum, character: 0 });
                returnType = this.resolveChainReturnType(fullChainText, chainClass2?.name);
                
                // For highlight, find where the chain actually ends (last ')' or property name)
                let hlEnd = 0;
                let depth2 = 1;
                for (let ci = 0; ci < afterMatch.length && depth2 > 0; ci++) {
                    if (afterMatch[ci] === '(') depth2++;
                    else if (afterMatch[ci] === ')') depth2--;
                    if (depth2 === 0) { hlEnd = ci + 1; break; }
                }
                let pos = hlEnd;
                while (pos < afterMatch.length) {
                    let ws = pos;
                    while (ws < afterMatch.length && (afterMatch[ws] === ' ' || afterMatch[ws] === '\t')) ws++;
                    if (ws >= afterMatch.length || afterMatch[ws] !== '.') break;
                    ws++;
                    while (ws < afterMatch.length && (afterMatch[ws] === ' ' || afterMatch[ws] === '\t')) ws++;
                    const idStart = ws;
                    while (ws < afterMatch.length && /\w/.test(afterMatch[ws])) ws++;
                    if (ws === idStart) break;
                    pos = ws; hlEnd = pos;
                    let ps = pos;
                    while (ps < afterMatch.length && (afterMatch[ps] === ' ' || afterMatch[ps] === '\t')) ps++;
                    if (ps < afterMatch.length && afterMatch[ps] === '(') {
                        depth2 = 1; ps++;
                        while (ps < afterMatch.length && depth2 > 0) {
                            if (afterMatch[ps] === '(') depth2++;
                            else if (afterMatch[ps] === ')') depth2--;
                            ps++;
                        }
                        pos = ps; hlEnd = pos;
                    }
                }
                chainEnd = hlEnd;
            } else {
                // Find where single function call ends
                let depth = 1;
                for (let i = 0; i < afterMatch.length && depth > 0; i++) {
                    if (afterMatch[i] === '(') depth++;
                    else if (afterMatch[i] === ')') depth--;
                    if (depth === 0) {
                        chainEnd = i + 1;
                        break;
                    }
                }
                // Try to resolve as a method of the containing class first (for unqualified calls like Find())
                const containingClass = this.findContainingClass(ast, { line: lineNum, character: 0 });
                if (containingClass) {
                    returnType = this.resolveMethodReturnType(containingClass.name, funcName);
                } else {
                    returnType = null;
                }
                // Fall back to global function lookup if not found in class hierarchy
                if (!returnType) {
                    returnType = this.resolveFunctionReturnType(funcName);
                }
                // Check for array indexing after the function call, e.g. GetOrientation()[0]
                // If present, adjust the return type to the element type
                const afterCall = afterMatch.substring(chainEnd).trim();
                if (afterCall.startsWith('[') && returnType) {
                    returnType = this.resolveIndexedType(returnType);
                }
            }
            
            if (targetType && returnType) {
                // Skip if either type is a generic parameter (single uppercase letter like T, K, V)
                if (/^[A-Z]$/.test(targetType) || /^[A-Z]$/.test(returnType)) {
                    continue;
                }
                // Skip if types are identical
                if (targetType === returnType) {
                    continue;
                }
                // Skip if the full RHS contains a comparison/boolean operator and target type is bool
                if (targetType === 'bool') {
                    const stmtEnd4 = afterMatch.indexOf(';');
                    const fullRhs4 = funcName + '(' + afterMatch.substring(0, stmtEnd4 >= 0 ? stmtEnd4 : afterMatch.length);
                    if (this.hasTopLevelComparisonOperator(fullRhs4)) {
                        continue;
                    }
                }
                // Calculate actual start position (skip the leading delimiter and whitespace)
                const actualStart = match.index + 1 + leadingWhitespace.length;
                const actualLength = match[0].length - 1 - leadingWhitespace.length + chainEnd;
                this.addTypeMismatchDiagnostic(doc, diags, actualStart, actualLength, targetType, returnType);
            }
        }
        
        // ================================================================
        // Pattern 5: Type varName = someVar.Method();
        // ================================================================
        // Detects type mismatches in declarations where the RHS is a variable
        // method chain. Example:
        //   typedef map<string, string> TMap;
        //   TMap m;
        //   int x = m.Get("key");  // ERROR: Get returns string, not int
        //
        // Uses resolveVariableChainType to resolve the chain through typedefs
        // and template substitution.
        // ================================================================
        const varChainDeclPattern = /\b(\w+)[ \t]+(\w+)\s*=\s*(\w+)\s*\./g;
        
        while ((match = varChainDeclPattern.exec(text)) !== null) {
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) continue;
            if (match[0].includes('\n')) continue;
            
            const declaredType = match[1];
            const varName = match[2];
            const sourceVar = match[3];
            
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'typedef'].includes(declaredType)) continue;
            
            // Get the type of the source variable
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            const sourceVarType = getVarTypeAtLine(sourceVar, lineNum);
            if (!sourceVarType) continue;
            
            // Get the chain text from the dot onwards
            const afterDot = text.substring(match.index + match[0].length);
            const stmtEnd = afterDot.indexOf(';');
            const chainText = '.' + afterDot.substring(0, stmtEnd >= 0 ? stmtEnd : afterDot.length);
            
            // Resolve the chain
            const returnType = this.resolveVariableChainType(sourceVarType, chainText);
            if (!returnType) continue;
            
            // Calculate highlight: from match start to end of chain (before semicolon)
            const highlightLength = match[0].length + (stmtEnd >= 0 ? stmtEnd : afterDot.length);
            
            // Skip if the full RHS contains a comparison/boolean operator —
            // the actual expression type is bool, not the chain's return type.
            // When declaredType is bool, the comparison is expected and valid.
            // When declaredType is not bool, the mismatch is bool vs declaredType,
            // but we skip anyway because the resolved returnType (from the chain before
            // the operator) would produce a misleading diagnostic message.
            if (this.hasTopLevelComparisonOperator(chainText)) {
                continue;
            }
            // Skip unresolved template parameters (e.g., T, TKey, TValue) —
            // these occur when generic args couldn't be resolved through typedefs.
            if (/^[A-Z]$/.test(declaredType) || /^[A-Z]$/.test(returnType)) continue;
            this.addTypeMismatchDiagnostic(doc, diags, match.index, highlightLength, declaredType, returnType);
        }
        
        // ================================================================
        // Pattern 6: varName = someVar.Method(); (reassignment)
        // ================================================================
        // Same as Pattern 5 but for reassignments where the variable was
        // already declared. Looks up the target variable's type from the scope.
        // Example:
        //   string s;
        //   s = testMap.Get("key");  // OK: string = string
        //   int n;
        //   n = testMap.Get("key");  // ERROR: int ≠ string
        //
        // The regex starts with a statement boundary (;, {, }, ), newline)
        // to avoid matching inside expressions.
        // ================================================================
        const varChainReassignPattern = /(?:^|[;{})\n])(\s*)(\w+)\s*=\s*(\w+)\s*\./g;
        
        while ((match = varChainReassignPattern.exec(text)) !== null) {
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) continue;
            
            const leadingWs = match[1];
            const targetVar = match[2];
            const sourceVar = match[3];
            
            const coreP6 = match[0].substring(1 + leadingWs.length);
            if (coreP6.includes('\n')) continue;
            
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'else'].includes(targetVar)) continue;
            
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            const targetType = getVarTypeAtLine(targetVar, lineNum);
            const sourceVarType = getVarTypeAtLine(sourceVar, lineNum);
            if (!targetType || !sourceVarType) continue;
            
            // Get chain text
            const afterDot = text.substring(match.index + match[0].length);
            const stmtEnd = afterDot.indexOf(';');
            const chainText = '.' + afterDot.substring(0, stmtEnd >= 0 ? stmtEnd : afterDot.length);
            
            const returnType = this.resolveVariableChainType(sourceVarType, chainText);
            if (!returnType) continue;
            
            if (/^[A-Z]$/.test(targetType) || /^[A-Z]$/.test(returnType)) continue;
            if (targetType === returnType) continue;
            
            // Skip if the full RHS contains a comparison/boolean operator —
            // the actual expression type is bool, not the chain's return type.
            if (this.hasTopLevelComparisonOperator(chainText)) {
                continue;
            }
            
            const actualStart = match.index + 1 + leadingWs.length;
            const actualLength = match[0].length - 1 - leadingWs.length + (stmtEnd >= 0 ? stmtEnd : afterDot.length);
            this.addTypeMismatchDiagnostic(doc, diags, actualStart, actualLength, targetType, returnType);
        }
    }

    // ========================================================================
    // FUNCTION CALL ARGUMENT VALIDATION
    // ========================================================================
    // Validates function/method call arguments:
    //   1. Argument count — too few (missing required params) or too many
    //   2. Argument types — each argument's type vs the parameter's declared type
    //
    // Handles:
    //   - Overloaded functions (multiple declarations with same name)
    //   - Default parameter values (params with defaults are optional)
    //   - Constructor calls (new ClassName(...))
    //   - Method calls (obj.Method(...))
    //   - Global function calls (FuncName(...))
    //   - out/inout parameter modifiers
    //
    // A call is valid if ANY overload accepts it. Errors are only reported
    // when NO overload matches.
    // ========================================================================

    /**
     * Find all overloads of a function/method by name.
     * For methods, searches the class hierarchy. For globals, searches all files.
     * Returns all FunctionDeclNode[] with that name.
     */
    private findFunctionOverloads(funcName: string, className?: string): FunctionDeclNode[] {
        const overloads: FunctionDeclNode[] = [];
        
        if (className) {
            // Method: search class hierarchy
            const resolved = this.resolveTypedef(className);
            const hierarchy = this.getClassHierarchyOrdered(resolved, new Set());
            for (const classNode of hierarchy) {
                for (const member of classNode.members || []) {
                    if (member.kind === 'FunctionDecl' && member.name === funcName) {
                        overloads.push(member as FunctionDeclNode);
                    }
                }
            }
        } else {
            // Global function: use function index for fast lookup
            const funcs = this.functionIndex.get(funcName);
            if (funcs) {
                overloads.push(...funcs);
            }
            
            // Also check class methods (for unqualified calls from within a class)
            // This still needs to iterate class index since we don't index methods separately
            for (const [className, classes] of this.classIndex) {
                for (const classNode of classes) {
                    for (const member of classNode.members || []) {
                        if (member.kind === 'FunctionDecl' && member.name === funcName) {
                            overloads.push(member as FunctionDeclNode);
                        }
                    }
                }
            }
        }
        
        return overloads;
    }

    /**
     * Parse the argument list text of a function call into individual argument strings.
     * Handles nested parentheses, brackets, strings, and template args.
     * e.g., 'a, Func(b, c), "hello, world"' → ["a", "Func(b, c)", '"hello, world"']
     */
    private parseCallArguments(argsText: string): string[] {
        const args: string[] = [];
        let depth = 0;       // () depth
        let bracketDepth = 0; // <> and [] depth
        let braceDepth = 0;  // {} depth (array literals like {1,2,3})
        let inString = false;
        let stringChar = '';
        let current = '';
        
        for (let i = 0; i < argsText.length; i++) {
            const ch = argsText[i];
            
            // Handle strings
            if (!inString && (ch === '"' || ch === "'")) {
                inString = true;
                stringChar = ch;
                current += ch;
                continue;
            }
            if (inString) {
                current += ch;
                if (ch === stringChar) {
                    // Count consecutive backslashes before this quote
                    let backslashCount = 0;
                    let bi = i - 1;
                    while (bi >= 0 && argsText[bi] === '\\') { backslashCount++; bi--; }
                    // Even number of backslashes (including 0) means quote is NOT escaped
                    if (backslashCount % 2 === 0) {
                        inString = false;
                    }
                }
                continue;
            }
            
            // Track nesting
            if (ch === '(' || ch === '[') { depth++; current += ch; continue; }
            if (ch === ')' || ch === ']') { depth--; current += ch; continue; }
            // Distinguish generic angle brackets <> from bit shift <<, >>
            if (ch === '<') {
                const nextCh = i + 1 < argsText.length ? argsText[i + 1] : '';
                if (nextCh !== '<') { // Not bit shift <<
                    bracketDepth++;
                }
                current += ch;
                continue;
            }
            if (ch === '>') {
                const nextCh = i + 1 < argsText.length ? argsText[i + 1] : '';
                if (nextCh !== '>') { // Not bit shift >>
                    if (bracketDepth > 0) bracketDepth--;
                }
                current += ch;
                continue;
            }
            if (ch === '{') { braceDepth++; current += ch; continue; }
            if (ch === '}') { braceDepth--; current += ch; continue; }
            
            // Split on comma only at top level (no nesting of any kind)
            if (ch === ',' && depth === 0 && bracketDepth === 0 && braceDepth === 0) {
                args.push(current.trim());
                current = '';
                continue;
            }
            
            current += ch;
        }
        
        const last = current.trim();
        if (last) args.push(last);
        
        return args;
    }

    /**
     * Infer the type of a call argument expression.
     * Returns the type name or null if unresolvable.
     */
    private inferArgType(
        argText: string,
        getVarType: (name: string) => string | undefined,
        containingClassName?: string
    ): string | null {
        const arg = argText.trim();
        if (!arg) return null;
        
        // If the argument contains a top-level comparison/boolean operator,
        // the expression evaluates to bool regardless of operand types.
        // e.g., pm.CreateParticleByPath(path, pp) == null  →  bool
        if (this.hasTopLevelComparisonOperator(arg)) return 'bool';
        
        // String literal
        if (arg.startsWith('"') || arg.startsWith("'")) return 'string';
        
        // Numeric literal  
        if (/^-?\d+$/.test(arg)) return 'int';
        if (/^-?\d+\.\d*$/.test(arg) || /^-?\.\d+$/.test(arg)) return 'float';
        
        // Boolean literal
        if (arg === 'true' || arg === 'false') return 'bool';
        
        // null
        if (arg === 'null' || arg === 'NULL') return null; // null is compatible with any ref type
        
        // new ClassName(...) or new ClassName<T>(...)
        const newMatch = arg.match(/^new\s+(\w+)/);
        if (newMatch) return newMatch[1];
        
        // Templated constructor: new ClassName<Type>(...)  — handles cases where
        // hasTopLevelComparisonOperator didn't catch it (e.g., complex expressions)
        const newTemplateMatch = arg.match(/^new\s+(\w+)\s*</);
        if (newTemplateMatch) return newTemplateMatch[1];
        
        // Cast: ClassName.Cast(expr) or ClassName.Cast(expr).Chain(...)
        const castMatch = arg.match(/^(\w+)\.Cast\s*\(/);
        if (castMatch) {
            const castType = castMatch[1];
            // Skip past the balanced parens of Cast(...)
            const openIdx = arg.indexOf('(', castMatch[0].length - 1);
            let depth = 1;
            let i = openIdx + 1;
            while (i < arg.length && depth > 0) {
                const ch = arg[i];
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                else if (ch === '"' || ch === "'") {
                    const q = ch;
                    i++;
                    while (i < arg.length && arg[i] !== q) {
                        if (arg[i] === '\\') i++;
                        i++;
                    }
                }
                i++;
            }
            // Check if there's a chain after Cast(...): e.g., .GetCurrentSkinIdx()
            const afterCast = arg.substring(i).trim();
            if (afterCast.startsWith('.')) {
                return this.resolveVariableChainType(castType, afterCast);
            }
            return castType;
        }
        
        // Simple variable reference
        if (/^\w+$/.test(arg)) {
            const varType = getVarType(arg);
            if (varType) return varType;
            // Could be an enum value or class name - can't determine type
            return null;
        }
        
        // Variable with array indexing: varName[expr]
        // We can't easily determine the element type, so return null to avoid false positives.
        const arrayAccessMatch = arg.match(/^(\w+)\s*\[/);
        if (arrayAccessMatch && !arg.match(/^(\w+)\s*\(/)) {
            return null;
        }
        
        // Function call: FuncName(...) or FuncName(...).Chain(...)
        const funcCallMatch = arg.match(/^(\w+)\s*\(/);
        if (funcCallMatch) {
            const calledFunc = funcCallMatch[1];
            
            // Try resolving as a method of the containing class first (with template substitution).
            // This handles cases like Get(i) inside a class that extends array<T> via typedef.
            let rootType: string | null = null;
            if (containingClassName) {
                rootType = this.resolveMethodCallWithTemplates(containingClassName, calledFunc);
            }
            // Fall back to global function resolution
            if (!rootType) {
                rootType = this.resolveFunctionReturnType(calledFunc);
            }
            if (rootType) {
                // Check if there's a chain after the closing paren: FuncName(...).Something
                const openIdx = arg.indexOf('(');
                let depth = 1;
                let i = openIdx + 1;
                while (i < arg.length && depth > 0) {
                    const ch = arg[i];
                    if (ch === '(') depth++;
                    else if (ch === ')') depth--;
                    else if (ch === '"' || ch === "'") {
                        const q = ch;
                        i++;
                        while (i < arg.length && arg[i] !== q) {
                            if (arg[i] === '\\') i++;
                            i++;
                        }
                    }
                    i++;
                }
                // i now points just past the closing paren
                const afterCall = arg.substring(i).trim();
                if (afterCall.startsWith('.')) {
                    // There's a chain after the function call — resolve it
                    return this.resolveVariableChainType(rootType, afterCall);
                }
                // Check for array indexing after the function call: FuncName(...)[expr]
                if (afterCall.startsWith('[')) {
                    return this.resolveIndexedType(rootType);
                }
            }
            return rootType;
        }
        
        // Method chain: var.Method(...) or ClassName.StaticMethod(...)
        const chainMatch = arg.match(/^(\w+)\s*\./);
        if (chainMatch) {
            const rootName = chainMatch[1];
            let varType = getVarType(rootName);
            
            // If no variable found, check if it's a class name (static access)
            if (!varType && /^[A-Z]/.test(rootName) && this.classIndex.has(rootName)) {
                varType = rootName;
            }
            
            if (varType) {
                const chainText = arg.substring(chainMatch[0].length - 1); // keep the dot
                // If the chain ends with a method call, use resolveVariableChainType
                if (chainText.includes('(')) {
                    return this.resolveVariableChainType(varType, chainText);
                }
                // Property access: resolve the field type
                const members = this.parseChainMembers(chainText);
                if (members.length > 0) {
                    const resolved = this.resolveChainSteps(members, this.resolveTypedef(varType), new Map());
                    if (resolved?.type) {
                        // If the arg ends with array indexing [expr], the result is the element type.
                        // Since we can't always determine the element type, return null to avoid
                        // false type mismatch errors for container types.
                        if (/\[.*\]\s*$/.test(arg)) {
                            return null;
                        }
                        return resolved.type;
                    }
                }
            }
        }
        
        // Can't determine type
        return null;
    }

    /**
     * Check a single function call's arguments against all overloads.
     * Returns null if any overload matches, or an error message if none do.
     */
    private validateCallAgainstOverloads(
        overloads: FunctionDeclNode[],
        argTypes: (string | null)[],
        argCount: number,
        funcName: string
    ): { message: string; severity: 'error' | 'warning' } | null {
        if (overloads.length === 0) return null; // No declarations found, skip
        
        // Try each overload - if ANY matches, the call is valid
        let bestError: string | null = null;
        let closestOverload: FunctionDeclNode | null = null;
        let smallestParamDiff = Infinity;
        
        for (const overload of overloads) {
            const params = overload.parameters || [];
            const requiredCount = params.filter(p => !p.hasDefault).length;
            const totalCount = params.length;
            
            // Check argument count
            if (argCount < requiredCount) {
                const diff = requiredCount - argCount;
                if (diff < smallestParamDiff) {
                    smallestParamDiff = diff;
                    closestOverload = overload;
                    const missing = params.slice(argCount).filter(p => !p.hasDefault)
                        .map(p => `${p.type?.identifier || '?'} ${p.name}`).join(', ');
                    bestError = `Missing required argument(s): ${missing}`;
                }
                continue; // Try other overloads
            }
            
            if (argCount > totalCount) {
                const diff = argCount - totalCount;
                if (diff < smallestParamDiff) {
                    smallestParamDiff = diff;
                    closestOverload = overload;
                    bestError = `Too many arguments: expected ${totalCount === requiredCount ? totalCount : `${requiredCount}-${totalCount}`}, got ${argCount}`;
                }
                continue; // Try other overloads
            }
            
            // Argument count is valid, check types
            let typeMismatch = false;
            let mismatchMsg = '';
            
            for (let i = 0; i < argCount; i++) {
                const argType = argTypes[i];
                if (!argType) continue; // Couldn't resolve arg type, skip this param
                
                // Skip void arg types — typically a function reference (method without parens)
                // rather than a meaningful value, so type checking would be misleading
                if (argType === 'void') continue;
                
                const param = params[i];
                if (!param?.type?.identifier) continue;
                
                const paramType = param.type.identifier;
                
                // Skip auto/typename/Class/void/func params - they accept anything
                // In Enforce Script, void parameters are generic "any type" placeholders,
                // and func/function params accept function references which look like identifiers.
                // Also skip container types (array, set, map) since we don't compare generics yet.
                if (paramType === 'auto' || paramType === 'typename' || paramType === 'Class' || paramType === 'Managed' || paramType === 'void' || paramType === 'func' || paramType === 'function' || paramType === 'array' || paramType === 'set' || paramType === 'map') continue;
                
                // Skip out/inout params - their types flow differently
                if (param.modifiers?.includes('out') || param.modifiers?.includes('inout')) continue;
                
                const compat = this.checkTypeCompatibility(paramType, argType);
                if (!compat.compatible) {
                    typeMismatch = true;
                    mismatchMsg = `Argument ${i + 1}: cannot pass '${argType}' as '${paramType} ${param.name}'`;
                    break;
                }
            }
            
            if (!typeMismatch) {
                // This overload matches — call is valid
                return null;
            }
            
            // This overload didn't match on types
            if (smallestParamDiff > 0 || !bestError) {
                smallestParamDiff = 0;
                closestOverload = overload;
                bestError = mismatchMsg;
            }
        }
        
        if (!bestError) return null;
        
        // Build the signature of the closest matching overload for context
        if (closestOverload) {
            const sig = closestOverload.parameters
                .map(p => `${p.type?.identifier || '?'} ${p.name}${p.hasDefault ? '?' : ''}`)
                .join(', ');
            const prefix = overloads.length > 1 
                ? `No matching overload for '${funcName}': ` 
                : `'${funcName}(${sig})': `;
            return { message: prefix + bestError, severity: 'error' };
        }
        
        return { message: bestError, severity: 'error' };
    }

    /**
     * Validate function/method call arguments in the document.
     * Checks argument count and types against all overloads.
     */
    private checkFunctionCallArgs(
        doc: TextDocument,
        diags: Diagnostic[],
        text: string,
        lines: string[],
        lineOffsets: number[],
        ast: File,
        scopedVars: Map<string, { type: string; startLine: number; endLine: number; isClassField: boolean }[]>
    ): void {
        // Variable type lookup — uses simple smallest-range heuristic (no isClassField
        // distinction), with resolveVariableType fallback for cross-file resolution.
        const getVarTypeAtLine = (name: string, line: number): string | undefined => {
            const entries = scopedVars.get(name);
            if (entries) {
                let best: { type: string; startLine: number; endLine: number } | undefined;
                for (const e of entries) {
                    if (line >= e.startLine && line <= e.endLine) {
                        if (!best || (e.endLine - e.startLine) < (best.endLine - best.startLine)) {
                            best = e;
                        }
                    }
                }
                if (best) return best.type;
            }
            // Fall back to full cross-file resolution (globals, class hierarchy, etc.)
            const pos: Position = { line, character: 0 };
            return this.resolveVariableType(doc, pos, name) ?? undefined;
        };
        
        // Keywords and built-ins that look like function calls but aren't
        const skipNames = new Set([
            'if', 'while', 'for', 'foreach', 'switch', 'case', 'return', 'new', 'delete',
            'super', 'this', 'class', 'enum', 'typedef', 'Print', 'PrintFormat',
            'cast', 'sizeof', 'typeof', 'typename', 'thread', 'ref',
            'array', 'set', 'map', 'autoptr'
        ]);
        
        // Find function calls: FuncName(args) or obj.Method(args)
        // We scan for pattern: identifier ( ... )
        // Use regex to find call sites, then extract balanced args
        const callPattern = /\b(\w+)\s*\(/g;
        let match: RegExpExecArray | null;
        
        while ((match = callPattern.exec(text)) !== null) {
            if (Analyzer.isInsideCommentOrStringAt(text, match.index)) continue;
            
            const funcName = match[1];
            if (skipNames.has(funcName)) continue;
            
            // Skip destructor calls: ~ClassName() — destructors take no args
            if (match.index > 0 && text[match.index - 1] === '~') continue;
            
            // Skip annotations inside square brackets: [NonSerialized()], [Attribute()]
            // Walk backwards from match to find if we're inside [...]
            let bracketCheck = match.index - 1;
            while (bracketCheck >= 0 && text[bracketCheck] === ' ') bracketCheck--;
            if (bracketCheck >= 0 && text[bracketCheck] === '[') continue;
            // Also handle: [Attr(param)] where there's content before
            let inBracket = false;
            for (let bi = match.index - 1; bi >= 0; bi--) {
                if (text[bi] === '\n' || text[bi] === ';' || text[bi] === '}' || text[bi] === '{') break;
                if (text[bi] === ']') break; // not inside brackets
                if (text[bi] === '[') { inBracket = true; break; }
            }
            if (inBracket) continue;
            
            // Skip constructor calls: new ClassName(...)
            const beforeNew = text.substring(Math.max(0, match.index - 10), match.index).trimEnd();
            if (beforeNew.endsWith('new')) continue;
            
            // Skip declarations: "void FuncName(" or "int FuncName(" etc.
            // If preceded by a type + space, it's likely a declaration not a call
            const beforeCall = text.substring(Math.max(0, match.index - 80), match.index);
            // Check if this is a function declaration (type immediately before name)
            // Also handles generic types like array<Man> or map<string, int>
            const declCheck = beforeCall.match(/(?:void|int|float|bool|string|auto|vector|override\s+\w+|static\s+\w+|\w+(?:<[^>]*>)?)\s+$/);
            if (declCheck) {
                // Could be a declaration. Check more carefully — if the next non-whitespace
                // before the type name is '{', ';', or start-of-line, it's a declaration
                const fullMatch = declCheck[0]; // includes trailing whitespace
                // Skip if it looks like a declaration context (not preceded by = or , or ( )
                const preDeclText = text.substring(Math.max(0, match.index - 80), match.index - fullMatch.length).trimEnd();
                const lastChar = preDeclText[preDeclText.length - 1];
                if (!lastChar || lastChar === '{' || lastChar === '}' || lastChar === ';' || lastChar === ')' || lastChar === '\n') {
                    continue; // It's a declaration, skip
                }
            }
            
            // Extract the balanced argument text
            const argsStart = match.index + match[0].length;
            let depth = 1;
            let pos = argsStart;
            while (pos < text.length && depth > 0) {
                const ch = text[pos];
                if (ch === '(') depth++;
                else if (ch === ')') depth--;
                // Skip strings inside args
                else if (ch === '"' || ch === "'") {
                    const quote = ch;
                    pos++;
                    while (pos < text.length && text[pos] !== quote) {
                        if (text[pos] === '\\') pos++; // skip escaped char
                        pos++;
                    }
                }
                pos++;
            }
            if (depth !== 0) continue; // Unbalanced parens
            
            // Strip /* ... */ block comments from args text — DayZ convention uses
            // these to comment out parameters that still exist in the engine.
            // e.g., Func(item/*, widget*/, x) → Func(item            , x)
            // Replace with spaces to preserve character positions for line counting.
            const rawArgsText = text.substring(argsStart, pos - 1).trim();
            const argsText = rawArgsText.replace(/\/\*[\s\S]*?\*\//g, m => ' '.repeat(m.length)).trim();
            const argStrings = argsText ? this.parseCallArguments(argsText) : [];
            const argCount = argStrings.length;
            
            // Determine if this is a method call or global call
            const textBeforeFunc = text.substring(Math.max(0, match.index - 200), match.index);
            const lineNum = Analyzer.getLineFromOffset(lineOffsets, match.index);
            
            let overloads: FunctionDeclNode[] = [];
            let chainAttempted = false;
            let chainResolvedType: string | undefined; // Set when chain resolution identifies a known receiver type
            let dotIsPartOfChain = false;
            let containingClassName: string | undefined;
            
            // Try to find the containing class for this call site (needed for template resolution)
            {
                const cc = this.findContainingClass(ast, doc.positionAt(match.index));
                if (cc) containingClassName = cc.name;
            }
            
            // Check for method call: something.FuncName(
            const dotMatch = textBeforeFunc.match(/(\w+)\s*\.\s*$/);
            if (dotMatch) {
                const objName = dotMatch[1];
                
                // Skip super calls entirely — super always calls a valid parent/original
                // method. The LSP may not have complete hierarchy knowledge, and in
                // modded classes super refers to the previous mod layer, not the parent class.
                if (objName === 'super') continue;
                
                // Check if objName is a class name FIRST (for static access like ClassName.StaticMethod)
                // This must come before getVarTypeAtLine because regex fallbacks can
                // produce false positives (e.g., matching "new InventoryLocation;" as type "new")
                // BUT: only treat it as static access if objName is NOT part of a larger
                // chain (i.e., not preceded by a dot or closing paren). For chains like
                // GetBasicMapConfig().Icons.Find(), "Icons" is a member access, not a
                // static class reference, even if a class named "Icons" exists.
                const beforeObjName = textBeforeFunc.substring(0, dotMatch.index).trimEnd();
                const isPartOfChain = beforeObjName.length > 0 && (beforeObjName[beforeObjName.length - 1] === '.' || beforeObjName[beforeObjName.length - 1] === ')');
                dotIsPartOfChain = isPartOfChain;
                // Check for static access: ClassName.Method or lowercase built-ins like vector.Distance
                const isStaticAccess = objName[0] === objName[0].toUpperCase() || objName === 'vector';
                if (!isPartOfChain && isStaticAccess && this.classIndex.has(objName)) {
                    overloads = this.findFunctionOverloads(funcName, objName);
                }
                
                if (overloads.length === 0) {
                let objType = getVarTypeAtLine(objName, lineNum);
                if (objType) {
                    objType = this.resolveTypedef(objType);
                    overloads = this.findFunctionOverloads(funcName, objType);
                }
                
                // If simple variable lookup didn't find overloads (or objType was falsy),
                // try chain resolution. This handles multi-step chains like
                // data.m_Modifiers.Count() where dotMatch captures "m_Modifiers" but
                // it's actually a member of "data", not a standalone variable.
                // Without this fallback, a wrong type from regex fallback (e.g., an
                // unrelated "int m_Modifiers;" in another class) would short-circuit
                // the chain resolution and produce false "Unknown method" errors.
                if (overloads.length === 0) {
                    chainAttempted = true;
                    const fullTextBefore = textBeforeFunc.replace(/\s+$/, '');
                    // Use the unified backward chain parser + resolver instead of
                    // hand-rolled backward walking. resolveFullChain handles nested
                    // parens, function calls, variables, static access, and deep chains.
                    if (fullTextBefore.endsWith('.')) {
                        const chainResult = this.resolveFullChain(fullTextBefore, doc, { line: lineNum, character: 0 }, ast);
                        if (chainResult) {
                            chainResolvedType = chainResult.type;
                            overloads = this.findFunctionOverloads(funcName, chainResult.type);
                        }
                    }
                    // Fall back to static class call if chain didn't resolve
                    // Only for true static access, not when objName is part of a chain
                    if (overloads.length === 0 && !isPartOfChain && isStaticAccess) {
                        overloads = this.findFunctionOverloads(funcName, objName);
                    }
                }
                } // end of overloads.length === 0 check
            } else {
                // Check for chain call: e.g., U().globals().FuncName( or var.method().FuncName(
                // The simple dotMatch fails when a ')' precedes the dot (chain with call results)
                const trimBefore = textBeforeFunc.replace(/\s+$/, '');
                if (trimBefore.endsWith('.')) {
                    chainAttempted = true;
                    // Use the unified backward chain parser + resolver instead of
                    // hand-rolled backward walking. resolveFullChain handles nested
                    // parens, function calls, variables, static access, and deep chains.
                    const chainResult = this.resolveFullChain(trimBefore, doc, { line: lineNum, character: 0 }, ast);
                    if (chainResult) {
                        chainResolvedType = chainResult.type;
                        overloads = this.findFunctionOverloads(funcName, chainResult.type);
                    }
                }

                // Fall back to global or unqualified call only if no chain was detected.
                // If a chain was attempted but couldn't resolve, skip — don't match the wrong function.
                if (!chainAttempted && overloads.length === 0) {
                    if (containingClassName) {
                        overloads = this.findFunctionOverloads(funcName, containingClassName);
                    }
                    if (overloads.length === 0) {
                        overloads = this.findFunctionOverloads(funcName);
                    }
                }
            }
            
            if (overloads.length === 0) {
                // Skip if the function name is a known class or typedef — it's a constructor call
                // e.g., TStringArray() where TStringArray is typedef array<string>
                if (this.classIndex.has(funcName) || this.typedefIndex.has(funcName)) {
                    continue;
                }
                
                // Skip warning for chain calls where we couldn't resolve the target type —
                // we don't know what class the method belongs to.
                // BUT: if chain resolution DID resolve to a known type (chainResolvedType is set),
                // then we know the method doesn't exist on that type and should warn.
                const dotObj = dotMatch ? dotMatch[1] : undefined;
                const dotObjType = dotObj ? getVarTypeAtLine(dotObj, lineNum) : undefined;
                const dotObjIsKnownClass = !!dotObj && dotObj[0] === dotObj[0].toUpperCase() && this.classIndex.has(dotObj);
                const chainResolvedToKnownType = !!chainResolvedType && this.classIndex.has(chainResolvedType);

                // Check if the receiver type is actually resolvable (a known class or primitive).
                // Suppress warnings only for truly unresolvable types: auto and typename.
                // Template params (T, TKey, etc.) are now resolved to their upper bound
                // by resolveChainRoot/resolveTemplateParam, so check the containing class's
                // genericVars to recognize them as resolvable.
                const hardcodedPrimitives = new Set(['int', 'float', 'bool', 'string', 'void', 'vector', 'class']);
                const isResolvableType = (t: string | undefined): boolean => {
                    if (!t) return false;
                    if (t === 'auto' || t === 'typename') return false;
                    const resolved = this.resolveTypedef(t);
                    if (hardcodedPrimitives.has(resolved.toLowerCase()) || this.classIndex.has(resolved)) return true;
                    // Template params are resolvable — resolveChainRoot resolves them to their upper bound
                    if (containingClassName) {
                        const ccClasses = this.classIndex.get(containingClassName);
                        if (ccClasses) {
                            for (const cc of ccClasses) {
                                if (cc.genericVars?.includes(resolved)) return true;
                            }
                        }
                    }
                    return false;
                };

                // If dotObjType resolved to an unresolvable type, skip the warning
                const dotObjTypeIsResolvable = isResolvableType(dotObjType);
                const chainTypeIsResolvable = isResolvableType(chainResolvedType ?? undefined);

                const isUnresolvedChain =
                    (!dotMatch && chainAttempted && !chainResolvedToKnownType) ||
                    (!!dotMatch && (dotIsPartOfChain || (!dotObjType && !dotObjIsKnownClass)) && !chainResolvedToKnownType);

                // Global/unknown receiver calls need a large index to avoid noise.
                // But when receiver type is known (obj.Method or resolved chain), we can
                // warn confidently even with a smaller index.
                // A type must actually be resolvable to be "confident" — auto, T, typename are not.
                const hasConfidentReceiverType = (!!dotMatch && ((dotObjTypeIsResolvable) || dotObjIsKnownClass)) || chainTypeIsResolvable;
                const canWarn = this.docCache.size >= 500 || hasConfidentReceiverType;

                // Explicitly skip when the resolved type is auto or typename —
                // these are inherently unresolvable and should never produce warnings.
                const effectiveType = chainResolvedType || dotObjType;
                if (effectiveType === 'auto' || effectiveType === 'typename') continue;

                // Skip when the receiver type's hierarchy is incomplete (has an unresolved
                // base class not in the index). The method may exist in unindexed parents.
                // This commonly happens with modded classes that extend vanilla types whose
                // full hierarchy isn't in the workspace.
                if (effectiveType && canWarn && !isUnresolvedChain) {
                    const hierarchy = this.getClassHierarchyOrdered(effectiveType, new Set());
                    const hasIncompleteHierarchy = hierarchy.some(cls => {
                        if (!cls.base?.identifier) return false;
                        if (cls.base.identifier === 'Class') return false;
                        return !this.classIndex.has(cls.base.identifier);
                    });
                    if (hasIncompleteHierarchy) continue;
                }

                if (canWarn && !isUnresolvedChain) {
                    const startPos = doc.positionAt(match.index);
                    const endPos = doc.positionAt(match.index + funcName.length);
                    // Prefer chain-resolved type for the message when available,
                    // since it may be more accurate (e.g., template param T → Class)
                    const displayType = chainResolvedType || (dotMatch ? (dotObjType || dotObj) : undefined);
                    diags.push({
                        message: displayType
                            ? `Unknown method '${funcName}' on type '${displayType}'`
                            : `Unknown function '${funcName}'`,
                        range: { start: startPos, end: endPos },
                        severity: DiagnosticSeverity.Warning
                    });
                }
                continue;
            }
            
            // Infer argument types
            const argTypes: (string | null)[] = argStrings.map(arg =>
                this.inferArgType(arg, (name) => getVarTypeAtLine(name, lineNum), containingClassName)
            );
            
            // Validate against overloads
            const result = this.validateCallAgainstOverloads(overloads, argTypes, argCount, funcName);
            if (result) {
                const startPos = doc.positionAt(match.index);
                const endPos = doc.positionAt(pos - 1); // end of closing paren
                diags.push({
                    message: result.message,
                    range: { start: startPos, end: endPos },
                    severity: result.severity === 'error' ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning
                });
            }
        }
    }

    /**
     * Helper to add a type mismatch diagnostic if needed
     */
    private addTypeMismatchDiagnostic(
        doc: TextDocument, 
        diags: Diagnostic[], 
        matchIndex: number, 
        matchLength: number, 
        targetType: string, 
        sourceType: string
    ): void {
        const result = this.checkTypeCompatibility(targetType, sourceType);
        
        const startPos = doc.positionAt(matchIndex);
        const endPos = doc.positionAt(matchIndex + matchLength);
        
        if (!result.compatible) {
            // Type error - incompatible types
            diags.push({
                message: result.message || `Type mismatch: cannot assign '${sourceType}' to '${targetType}'`,
                range: { start: startPos, end: endPos },
                severity: DiagnosticSeverity.Error
            });
        } else if (result.isDowncast) {
            // Warning - unsafe downcast
            diags.push({
                message: result.message || `Unsafe downcast from '${sourceType}' to '${targetType}'. Use '${targetType}.Cast(value)' or 'Class.CastTo(target, value)' instead.`,
                range: { start: startPos, end: endPos },
                severity: DiagnosticSeverity.Warning
            });
        }
        // Upcast is fine - no warning needed
    }

    /**
     * Check for multi-line string literals (not supported in Enforce Script).
     * Scans the raw text for quoted strings that span across newlines.
     * This runs independently of the parser so it works even when parsing fails.
     */
    private checkMultiLineStrings(doc: TextDocument, diags: Diagnostic[]): void {
        const text = doc.getText();
        let i = 0;
        while (i < text.length) {
            const ch = text[i];

            // Skip single-line comments
            if (ch === '/' && text[i + 1] === '/') {
                while (i < text.length && text[i] !== '\n') i++;
                continue;
            }
            // Skip block comments
            if (ch === '/' && text[i + 1] === '*') {
                i += 2;
                while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                i += 2;
                continue;
            }

            // String literal
            if (ch === '"') {
                const start = i;
                i++; // skip opening quote
                let hasNewline = false;
                while (i < text.length && text[i] !== '"') {
                    if (text[i] === '\\' && i + 1 < text.length) {
                        i += 2; // skip escape sequence
                    } else {
                        if (text[i] === '\n') hasNewline = true;
                        i++;
                    }
                }
                i++; // skip closing quote (or end of file)

                if (hasNewline) {
                    diags.push({
                        range: {
                            start: doc.positionAt(start),
                            end: doc.positionAt(i)
                        },
                        message: 'Multi-line string literals are not supported in Enforce Script. Use string concatenation with + instead.',
                        severity: DiagnosticSeverity.Error,
                        source: 'enforce-script'
                    });
                }
                continue;
            }

            i++;
        }
    }

    /**
     * Check for multi-line statements which are NOT supported in Enforce Script.
     * Each statement must be on a single line.
     * 
     * Detects patterns like:
     *   Print("text" +
     *       "more text");  // ERROR!
     */
    private checkMultiLineStatements(doc: TextDocument, diags: Diagnostic[], text: string, lines: string[]): void {
        
        // Track if we're inside a block comment
        let inBlockComment = false;
        
        // Track brace depth - anything inside {} is fine (enums, class bodies, arrays)
        // Only unclosed () across lines is the actual multi-line statement problem
        let braceDepth = 0;
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            // Skip empty lines and single-line comments
            if (!line || line.startsWith('//')) continue;
            
            // Skip lines that are just comment content (start with *)
            if (line.startsWith('*')) continue;
            
            // Track block comments /* ... */
            if (line.includes('/*')) {
                inBlockComment = true;
            }
            if (line.includes('*/')) {
                inBlockComment = false;
                continue;
            }
            if (inBlockComment) {
                continue;
            }
            
            // Track brace depth
            const openBraces = (line.match(/\{/g) || []).length;
            const closeBraces = (line.match(/\}/g) || []).length;
            braceDepth += openBraces - closeBraces;
            
            // Strip inline comments before checking operators/terminators
            // "x = 1.0; // 100%" → "x = 1.0;" (otherwise % looks like a binary op)
            // Neutralize string contents (replace chars with spaces) so "//" inside strings
            // isn't treated as a comment. Must preserve length so indices stay aligned.
            // e.g., GetGame().OpenURL("https://example.com");  — the :// is NOT a comment
            const neutralized = line.replace(/"(?:[^"\\]|\\.)*"/g, m => '"' + ' '.repeat(m.length - 2) + '"')
                                    .replace(/'(?:[^'\\]|\\.)*'/g, m => "'" + ' '.repeat(m.length - 2) + "'");
            const commentIdx = neutralized.indexOf('//');
            const codePart = (commentIdx >= 0 ? line.substring(0, commentIdx) : line).trimEnd();
            
            // Skip lines that are only a comment (nothing left after stripping)
            if (!codePart) continue;
            
            // Only check for unclosed parentheses - this is the real multi-line issue
            // e.g., Print("text" +
            //         "more");   <-- not allowed in Enforce Script
            const openParens = (codePart.match(/\(/g) || []).length;
            const closeParens = (codePart.match(/\)/g) || []).length;
            const unclosedParens = openParens > closeParens;
            
            // Skip lines ending with { or ; or } or , - those are complete
            // Comma handles enum values, array initializers, etc.
            const endsWithTerminator = /[{};,]\s*$/.test(codePart);
            
            // Skip declaration starts (class, if, for, etc.)
            const isDeclarationStart = /^(class|modded|enum|struct|typedef|if|else|for|while|switch|foreach)\b/.test(codePart);
            
            // Skip preprocessor lines
            if (codePart.startsWith('#')) continue;
            
            // Detect expression continuation via operators:
            //   string x = "a" + b +     ← line ends with binary operator
            //       "c";
            const endsWithBinaryOp = /(?:\+(?!\+)|-(?!-)|[*\/%&|^~]|&&|\|\|)\s*$/.test(codePart);
            
            // Detect continuation on next line starting with operator:
            //   string x = "a" + b       ← line does NOT end with ; or operator
            //       + "c";               ← next line STARTS with +
            let nextLineContinuation = false;
            if (!unclosedParens && !endsWithBinaryOp && !endsWithTerminator && !isDeclarationStart) {
                let nextIdx = i + 1;
                while (nextIdx < lines.length && !lines[nextIdx].trim()) nextIdx++;
                if (nextIdx < lines.length) {
                    const nextTrimmed = lines[nextIdx].trim();
                    // Next line starts with a binary operator (but not ++ or --)
                    nextLineContinuation = /^(?:\+(?!\+)|-(?!-)|[*\/%]|&&|\|\||\.(?!\.))/.test(nextTrimmed);
                }
            }
            
            if ((unclosedParens || endsWithBinaryOp || nextLineContinuation) && !endsWithTerminator && !isDeclarationStart && i + 1 < lines.length) {
                // Check if next non-empty line continues this statement
                let nextLineIdx = i + 1;
                while (nextLineIdx < lines.length && !lines[nextLineIdx].trim()) {
                    nextLineIdx++;
                }
                
                if (nextLineIdx < lines.length) {
                    const nextLine = lines[nextLineIdx].trim();
                    if (nextLine && !nextLine.startsWith('{') && !nextLine.startsWith('//')) {
                        diags.push({
                            message: 'Multi-line statements are not supported in Enforce Script. Each statement must be on a single line.',
                            range: {
                                start: { line: i, character: 0 },
                                end: { line: i, character: lines[i].length }
                            },
                            severity: DiagnosticSeverity.Error
                        });
                    }
                }
            }
        }
    }

    // ====================================================================
    // MODDED CLASS MODULE VALIDATION
    // ====================================================================

    /**
     * Check that modded classes are placed in the correct script module.
     * 
     * A `modded class` must be in the SAME script module as the original class.
     * For example:
     *   - modded class PlayerBase (4_World) must be in 4_World
     *   - modded class MissionServer (5_Mission) must be in 5_Mission
     * 
     * Placing it in a different module (higher or lower) will cause issues.
     */
    private checkModdedClassModules(ast: File, diags: Diagnostic[]): void {
        for (const node of ast.body) {
            if (node.kind !== 'ClassDecl') continue;
            const cls = node as ClassDeclNode;
            if (!cls.modifiers?.includes('modded')) continue;

            // Get the module level of this modded class from its URI
            const moddedLevel = getModuleLevel(cls.uri);
            if (moddedLevel === 0) continue; // Can't determine module — skip

            // Find the original (non-modded) class in the index
            const allVersions = this.classIndex.get(cls.name);
            if (!allVersions || allVersions.length === 0) continue;

            const original = allVersions.find(c => !c.modifiers?.includes('modded'));
            if (!original) continue; // No original found — all modded, can't check

            const originalLevel = getModuleLevel((original as any)._sourceUri ?? original.uri);
            if (originalLevel === 0) continue; // Can't determine original's module

            if (moddedLevel !== originalLevel) {
                const moddedModuleName = MODULE_NAMES[moddedLevel] || `module ${moddedLevel}`;
                const originalModuleName = MODULE_NAMES[originalLevel] || `module ${originalLevel}`;
                diags.push({
                    message: `Modded class '${cls.name}' is in ${moddedModuleName} but the original class is in ${originalModuleName}. A modded class must be in the same module as the original.`,
                    range: { start: cls.nameStart, end: cls.nameEnd },
                    severity: DiagnosticSeverity.Error
                });
            }
        }
    }

    /**
     * Check for unknown/undefined symbols in the AST
     * Generates warnings for:
     * - Unknown type names in variable declarations
     * - Unknown base classes
     * - Unknown function return types
     */
    private checkUnknownSymbols(ast: File, diags: Diagnostic[]): void {
        // Only truly primitive/language types that aren't defined in any file
        // Everything else should come from indexed files in P:\scripts
        const primitives = new Set([
            'void', 'int', 'float', 'bool', 'string', 'vector', 'typename',
            'Class', 'auto', 'array', 'set', 'map', 'ref', 'autoptr', 
            'proto', 'private', 'protected', 'static', 'const', 'owned',
            'out', 'inout', 'notnull', 'modded', 'sealed', 'event', 'native',
            // Common generic type parameter names - these are placeholders, not real types
            'T', 'T1', 'T2', 'T3', 'TKey', 'TValue', 'TItem', 'TElement'
        ]);
        
        // Collect generic type parameters from the current file's class declarations
        // so that template classes like Container<Class T> work correctly
        const genericParams = new Set<string>();
        for (const node of ast.body) {
            if (node.kind === 'ClassDecl') {
                const classNode = node as ClassDeclNode;
                for (const gv of classNode.genericVars || []) {
                    genericParams.add(gv);
                }
            }
        }
        
        // Require a significant index before flagging unknown types
        // This helps avoid false positives during initial indexing
        // and for types wrapped in #ifdef that we can't see
        const MIN_FILES_FOR_UNKNOWN_TYPE_CHECK = 500;
        if (this.docCache.size < MIN_FILES_FOR_UNKNOWN_TYPE_CHECK) {
            return; // Not enough files indexed to be confident
        }
        
        // Determine the module level of the current file (0 = unknown)
        const currentModule = ast.module || 0;
        
        // Check if a type exists
        const typeExists = (typeName: string): boolean => {
            if (!typeName) return true;
            if (primitives.has(typeName)) return true;
            if (genericParams.has(typeName)) return true;  // Generic type parameter
            
            // Single uppercase letters are likely generic type parameters
            if (/^[A-Z]$/.test(typeName)) return true;
            
            // Check for class, enum, or typedef with this name
            // Use the class finder methods for consistency with hover/go-to-definition
            if (this.findClassByName(typeName)) return true;
            if (this.findEnumByName(typeName)) return true;
            
            // Also check typedefs and any top-level symbol with matching name
            for (const [uri, fileAst] of this.docCache) {
                for (const node of fileAst.body) {
                    if (node.name === typeName) {
                        return true;
                    }
                }
            }
            
            // Also check current file's AST (in case it wasn't cached yet)
            for (const node of ast.body) {
                if (node.name === typeName) {
                    return true;
                }
            }
            
            return false;
        };
        
        // Check a type node for unknown types and cross-module access
        const checkType = (type: TypeNode | undefined): void => {
            if (!type) return;
            
            if (!typeExists(type.identifier)) {
                diags.push({
                    message: `Unknown type '${type.identifier}'`,
                    range: { start: type.start, end: type.end },
                    severity: DiagnosticSeverity.Warning
                });
            } else if (currentModule > 0) {
                // Type exists — check cross-module accessibility
                const typeModule = this.getModuleForSymbol(type.identifier);
                if (typeModule > 0 && typeModule > currentModule) {
                    diags.push({
                        message: `Type '${type.identifier}' is defined in ${MODULE_NAMES[typeModule] || 'module ' + typeModule} and cannot be used from ${MODULE_NAMES[currentModule] || 'module ' + currentModule}. Higher-numbered modules are not visible to lower-numbered modules.`,
                        range: { start: type.start, end: type.end },
                        severity: DiagnosticSeverity.Warning
                    });
                }
            }
            
            // Check generic arguments too
            for (const arg of type.genericArgs || []) {
                checkType(arg);
            }
        };
        
        // Walk the AST
        for (const node of ast.body) {
            // Check class declarations
            if (node.kind === 'ClassDecl') {
                const classNode = node as ClassDeclNode;
                
                // Check base class exists and is accessible from this module
                if (classNode.base && !typeExists(classNode.base.identifier)) {
                    diags.push({
                        message: `Unknown base class '${classNode.base.identifier}'`,
                        range: { start: classNode.base.start, end: classNode.base.end },
                        severity: DiagnosticSeverity.Warning
                    });
                } else if (classNode.base && currentModule > 0) {
                    const baseModule = this.getModuleForSymbol(classNode.base.identifier);
                    if (baseModule > 0 && baseModule > currentModule) {
                        diags.push({
                            message: `Base class '${classNode.base.identifier}' is defined in ${MODULE_NAMES[baseModule] || 'module ' + baseModule} and cannot be extended from ${MODULE_NAMES[currentModule] || 'module ' + currentModule}. Higher-numbered modules are not visible to lower-numbered modules.`,
                            range: { start: classNode.base.start, end: classNode.base.end },
                            severity: DiagnosticSeverity.Warning
                        });
                    }
                }
                
                // Check class members
                for (const member of classNode.members || []) {
                    if (member.kind === 'VarDecl') {
                        checkType((member as VarDeclNode).type);
                    } else if (member.kind === 'FunctionDecl') {
                        const func = member as FunctionDeclNode;
                        checkType(func.returnType);
                        for (const param of func.parameters || []) {
                            checkType(param.type);
                        }
                        for (const local of func.locals || []) {
                            checkType(local.type);
                        }
                    }
                }
            }
            
            // Check top-level variable declarations
            if (node.kind === 'VarDecl') {
                checkType((node as VarDeclNode).type);
            }
            
            // Check top-level function declarations
            if (node.kind === 'FunctionDecl') {
                const func = node as FunctionDeclNode;
                checkType(func.returnType);
                for (const param of func.parameters || []) {
                    checkType(param.type);
                }
                for (const local of func.locals || []) {
                    checkType(local.type);
                }
            }
        }
    }

    private toSymbolKindName(kind: string): SymbolEntry['kind'] {
        switch (kind) {
            case 'ClassDecl': return 'class';
            case 'FunctionDecl': return 'function';
            case 'VarDecl': return 'variable';
            case 'Typedef': return 'typedef';
            case 'EnumDecl': return 'enum';
            case 'EnumMemberDecl': return 'field';
            default: return 'variable';
        }
    }

    private dumpType(type: TypeNode): any {
        return {
            identifier: type.identifier,
            modifiers: type.modifiers,
            arrayDims: type.arrayDims,
            genericArgs: type.genericArgs?.map(this.dumpType) ?? []
        };
    }


    private dumpNode(node: SymbolNodeBase): any | null {
        if (!node.name) return null;

        const base = {
            type: this.toSymbolKindName(node.kind),
            name: node.name,
            modifiers: node.modifiers,
            location: {
                range: { start: node.start, end: node.end },
                nameRange: { start: node.nameStart, end: node.nameEnd }
            }
        };

        switch (node.kind) {
            case 'ClassDecl': {
                const c = node as ClassDeclNode;
                return {
                    ...base,
                    base: c.base ? this.dumpType(c.base) : undefined,
                    members: c.members.map(m => this.dumpNode(m)).filter(Boolean)
                };
            }

            case 'EnumDecl': {
                const e = node as EnumDeclNode;
                return {
                    ...base,
                    baseType: e.base,
                    members: e.members.map(this.dumpNode.bind(this))
                };
            }

            case 'FunctionDecl': {
                const f = node as FunctionDeclNode;
                return {
                    ...base,
                    returnType: this.dumpType(f.returnType),
                    parameters: f.parameters.map(p => ({
                        name: p.name,
                        type: this.dumpType(p.type)
                    })),
                    locals: f.locals.map(l => ({
                        name: l.name,
                        type: this.dumpType(l.type)
                    }))
                };
            }

            case 'Typedef': {
                const t = node as TypedefNode;
                return {
                    ...base,
                    type: this.dumpType(t.oldType)
                };
            }

            case 'VarDecl': {
                const v = node as VarDeclNode;
                return {
                    ...base,
                    type: this.dumpType(v.type)
                };
            }

            case 'EnumMemberDecl': {
                return base;
            }

            default:
                return base;
        }
    }


    dumpDiagnostics(): Record<string, any[]> {
        const output: Record<string, any[]> = {};

        for (const [uri, file] of this.docCache) {
            const items: any[] = [];

            for (const node of file.body) {
                items.push(node);
            }

            output[uri] = items;
        }

        return output;
    }

}
