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
import { parse, ParseError, ClassDeclNode, File, SymbolNodeBase, FunctionDeclNode, VarDeclNode, TypedefNode, toSymbolKind, EnumDeclNode, EnumMemberDeclNode, TypeNode } from '../ast/parser';
import { prettyPrint } from '../ast/printer';
import { lex } from '../lexer/lexer';
import { Token, TokenKind } from '../lexer/token';
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
 * Returns the token at a specific offset (e.g. mouse hover or cursor position).
 * Lexes only a small window around the position for performance.
 */
export function getTokenAtPosition(text: string, offset: number): Token | null {
    const windowSize = 64;
    const start = Math.max(0, offset - windowSize);
    const end = Math.min(text.length, offset + windowSize);
    const slice = text.slice(start, end);

    const tokens = lex(slice);

    for (const t of tokens) {
        const absStart = start + t.start;
        const absEnd = start + t.end;

        if (offset >= absStart && offset <= absEnd) {
            return {
                ...t,
                start: absStart,
                end: absEnd
            };
        }
    }

    return null;
}

function formatDeclaration(node: SymbolNodeBase): string {
    let fmt: string | null = null;
    switch (node.kind) {
        case 'FunctionDecl': {
            const _node = node as FunctionDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}${_node.returnType.identifier} ${_node.name}(${_node.parameters?.map(p => (p.modifiers.length ? p.modifiers.join(' ') + ' ': '') + p.type.identifier + ' ' + p.name).join(', ') ?? ''})`;
            break;
        }

        case 'VarDecl': {
            const _node = node as VarDeclNode;
            fmt = `${(_node.modifiers.length ? _node.modifiers.join(' ') + ' ': '')}${_node.type.identifier} ${_node.name}`;
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

    private ensure(doc: TextDocument): File {
        // 1 · cache hit
        const currVersion = doc.version;
        const cachedFile = this.docCache.get(normalizeUri(doc.uri));

        if (cachedFile && cachedFile.version === currVersion) {
            return cachedFile;
        }

        try {
            // 2 · happy path ─ parse & cache
            const ast = parse(doc);           // pass full TextDocument
            ast.module = getModuleLevel(doc.uri);
            this.docCache.set(normalizeUri(doc.uri), ast);
            return ast;
        } catch (err) {
            // 3 · graceful error handling
            if (err instanceof ParseError) {
                this.parseErrorCount++;
                // VS Code recognises “path:line:col” as a jump-to link
                const fsPath = url.fileURLToPath(err.uri);          // file:/// → p:\foo\bar.c
                console.error(`${fsPath}:${err.line}:${err.column}  ${err.message}`);

                // // also publish a real diagnostic so the Problems panel shows it
                // const diagnostic: Diagnostic = {
                //     message: err.message,
                //     range: {
                //         start: { line: err.line - 1, character: err.column - 1 },
                //         end:   { line: err.line - 1, character: err.column     }
                //     },
                //     severity: DiagnosticSeverity.Error,
                //     source:   'parser'
                // };
                // connection.sendDiagnostics({ uri: err.uri, diagnostics: [diagnostic] });
                // Stack trace removed to reduce noise during indexing
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
        
        // Match both variable.method and function().method patterns
        // Pattern 1: variable. or variable.prefix
        // Pattern 2: function(). or function().prefix  
        // Pattern 3: function(args). or function(args).prefix
        const dotMatch = textBeforeCursor.match(/(\w+)(\([^)]*\))?\s*\.\s*(\w*)$/);
        
        if (dotMatch) {
            // MEMBER COMPLETION MODE
            const name = dotMatch[1];
            const hasParens = !!dotMatch[2]; // true if it's a function call like GetGame()
            const prefix = dotMatch[3] || '';
            
            
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
            
            // If it's a function call like GetGame(). → look up the function's return type
            if (hasParens) {
                const returnType = this.resolveFunctionReturnType(name);
                if (returnType) {
                    return this.getClassMemberCompletions(returnType, prefix);
                }
            }
            
            // Try to resolve the variable's type
            const varType = this.resolveVariableType(doc, pos, name);
            
            if (varType) {
                // Get methods/fields for this type (including inherited)
                const members = this.getClassMemberCompletions(varType, prefix);
                return members;
            } else {
            }
            
            // If name looks like a class name (starts with uppercase), 
            // it might be a static method call: ClassName.StaticMethod()
            // OR an enum access: EnumName.EnumValue
            if (name[0] === name[0].toUpperCase()) {
                // First check if it's an enum
                const enumNode = this.findEnumByName(name);
                if (enumNode) {
                    return this.getEnumMemberCompletions(enumNode, prefix);
                }
                
                // Otherwise check for class static members
                const classNode = this.findClassByName(name);
                if (classNode) {
                    return this.getStaticMemberCompletions(classNode, prefix);
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
        
        // Add all top-level symbols from ALL indexed documents
        for (const [uri, fileAst] of this.docCache) {
            for (const node of fileAst.body) {
                if (!node.name) continue;
                if (seen.has(node.name)) continue;
                if (prefix && !node.name.toLowerCase().startsWith(prefix)) continue;
                
                seen.add(node.name);
                
                if (node.kind === 'ClassDecl') {
                    results.push({
                        name: node.name,
                        kind: 'class',
                        detail: (node as ClassDeclNode).base?.identifier 
                            ? `extends ${(node as ClassDeclNode).base?.identifier}` 
                            : 'class'
                    });
                } else if (node.kind === 'FunctionDecl') {
                    const func = node as FunctionDeclNode;
                    results.push({
                        name: func.name,
                        kind: 'function',
                        detail: func.returnType?.identifier || 'void',
                        insertText: `${func.name}()`,
                        returnType: func.returnType?.identifier
                    });
                } else if (node.kind === 'VarDecl') {
                    const v = node as VarDeclNode;
                    results.push({
                        name: v.name,
                        kind: 'variable',
                        detail: v.type?.identifier || 'auto'
                    });
                } else if (node.kind === 'EnumDecl') {
                    results.push({
                        name: node.name,
                        kind: 'enum',
                        detail: 'enum'
                    });
                } else if (node.kind === 'Typedef') {
                    results.push({
                        name: node.name,
                        kind: 'typedef',
                        detail: `typedef ${(node as TypedefNode).oldType?.identifier}`
                    });
                }
            }
        }
        
        return results;
    }

    /**
     * Resolve the type of a variable at a given position
     * Checks: function parameters, local variables, class fields
     */
    /**
     * Known DayZ global variables that have a more specific type than declared.
     * Example: g_Game is declared as "Game" but is actually "CGame"
     */
    private static readonly KNOWN_VARIABLE_TYPES: Record<string, string> = {
        'g_Game': 'CGame',
    };

    private resolveVariableType(doc: TextDocument, pos: Position, varName: string): string | null {
        
        // Check for known variable type overrides first
        const knownType = Analyzer.KNOWN_VARIABLE_TYPES[varName];
        if (knownType) {
            return knownType;
        }
        
        const ast = this.ensure(doc);
        
        // Find which function we're inside
        const containingFunc = this.findContainingFunction(ast, pos);
        
        if (containingFunc) {
            // Check function parameters first
            // Example: void SomeFunc(PlayerBase p) { p. } → type is "PlayerBase"
            for (const param of containingFunc.parameters || []) {
                if (param.name === varName) {
                    return param.type?.identifier || null;
                }
            }
            
            // Check local variables
            for (const local of containingFunc.locals || []) {
                if (local.name === varName) {
                    return local.type?.identifier || null;
                }
            }
        }
        
        // Check if we're inside a class - look for fields + inherited fields
        const containingClass = this.findContainingClass(ast, pos);
        if (containingClass) {
            // Check current class and all parent classes (including modded)
            const classHierarchy = this.getClassHierarchyOrdered(containingClass.name, new Set());
            for (const classNode of classHierarchy) {
                for (const member of classNode.members || []) {
                    if (member.kind === 'VarDecl' && member.name === varName) {
                        return (member as VarDeclNode).type?.identifier || null;
                    }
                }
            }
        }
        
        // Check global variables in ALL indexed files
        for (const [uri, fileAst] of this.docCache) {
            for (const node of fileAst.body) {
                if (node.kind === 'VarDecl' && node.name === varName) {
                    return (node as VarDeclNode).type?.identifier || null;
                }
            }
        }
        
        // Try scanning the current document for variable declarations
        const text = doc.getText();
        
        // Pattern: Type varName; or Type varName =
        const varDeclMatch = text.match(new RegExp(`(\\w+)\\s+${varName}\\s*[;=]`));
        if (varDeclMatch) {
            return varDeclMatch[1];
        }
        
        // Pattern: (Type varName) or (Type varName,) - function parameters
        const paramMatch = text.match(new RegExp(`[,(]\\s*(\\w+)\\s+${varName}\\s*[,)]`));
        if (paramMatch) {
            return paramMatch[1];
        }
        
        // Pattern: out Type varName or inout Type varName
        const outParamMatch = text.match(new RegExp(`(?:out|inout)\\s+(\\w+)\\s+${varName}\\s*[,)]`));
        if (outParamMatch) {
            return outParamMatch[1];
        }
        
        return null;
    }

    /**
     * Known DayZ singleton functions that return a more specific type than declared.
     * These functions are declared to return base class but actually return derived class.
     * Example: GetGame() is declared as returning "Game" but actually returns "CGame"
     */
    private static readonly KNOWN_RETURN_TYPES: Record<string, string> = {
        'GetGame': 'CGame',
        'GetDayZGame': 'DayZGame',
        'g_Game': 'CGame',
    };

    /**
     * Resolve the return type of a function by name
     * Searches top-level functions and class methods across all indexed files
     */
    private resolveFunctionReturnType(funcName: string): string | null {
        
        // Check for known overrides first (e.g., GetGame() returns CGame, not Game)
        const knownType = Analyzer.KNOWN_RETURN_TYPES[funcName];
        if (knownType) {
            return knownType;
        }
        
        // Search all indexed documents for a function with this name
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                // Top-level function
                if (node.kind === 'FunctionDecl' && node.name === funcName) {
                    const func = node as FunctionDeclNode;
                    const returnType = func.returnType?.identifier;
                    if (returnType) {
                        return returnType;  // Return 'void' too - we want to detect void assignments
                    }
                }
                
                // Class method (for static calls or when we don't know the class)
                if (node.kind === 'ClassDecl') {
                    for (const member of (node as ClassDeclNode).members || []) {
                        if (member.kind === 'FunctionDecl' && member.name === funcName) {
                            const func = member as FunctionDeclNode;
                            const returnType = func.returnType?.identifier;
                            if (returnType) {
                                return returnType;  // Return 'void' too
                            }
                        }
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Resolve the return type of a method within a specific class hierarchy
     * @param className The class to search in (and its parent classes)
     * @param methodName The method name to find
     */
    private resolveMethodReturnType(className: string, methodName: string): string | null {
        const visited = new Set<string>();
        const classesToSearch = this.getClassHierarchyOrdered(className, visited);
        
        for (const classNode of classesToSearch) {
            for (const member of classNode.members || []) {
                if (member.kind === 'FunctionDecl' && member.name === methodName) {
                    const func = member as FunctionDeclNode;
                    const returnType = func.returnType?.identifier;
                    if (returnType) {
                        return returnType;  // Return 'void' too - we want to detect void assignments
                    }
                }
            }
        }
        
        return null;
    }

    /**
     * Resolve the final return type of a method chain like "U().Msg().SetMeta(...)"
     * Parses the chain and follows each call to determine the final return type.
     * @param chainText The full chain text starting from the first function
     * @returns The return type of the final call in the chain, or null if unresolved
     */
    private resolveChainReturnType(chainText: string): string | null {
        // Parse the chain: extract each function/method call in sequence
        // Examples:
        //   "U().Msg().SetMeta(foo, bar)" -> ["U", "Msg", "SetMeta"]
        //   "GetGame().GetTime()" -> ["GetGame", "GetTime"]
        
        const calls: string[] = [];
        let remaining = chainText.trim();
        
        // First call: funcName(...)
        const firstMatch = remaining.match(/^(\w+)\s*\(/);
        if (!firstMatch) {
            return null;
        }
        calls.push(firstMatch[1]);
        
        // Skip past the first call's arguments
        remaining = remaining.substring(firstMatch[0].length);
        let parenDepth = 1;
        let i = 0;
        
        while (i < remaining.length && parenDepth > 0) {
            if (remaining[i] === '(') parenDepth++;
            else if (remaining[i] === ')') parenDepth--;
            i++;
        }
        
        remaining = remaining.substring(i).trim();
        
        // Continue parsing chained calls: .methodName(...)
        while (remaining.startsWith('.')) {
            remaining = remaining.substring(1).trim();
            
            const methodMatch = remaining.match(/^(\w+)\s*\(/);
            if (!methodMatch) {
                // Might be a property access, not a method call
                const propMatch = remaining.match(/^(\w+)/);
                if (propMatch) {
                    calls.push(propMatch[1]);
                }
                break;
            }
            
            calls.push(methodMatch[1]);
            
            // Skip past this call's arguments
            remaining = remaining.substring(methodMatch[0].length);
            parenDepth = 1;
            i = 0;
            
            while (i < remaining.length && parenDepth > 0) {
                if (remaining[i] === '(') parenDepth++;
                else if (remaining[i] === ')') parenDepth--;
                i++;
            }
            
            remaining = remaining.substring(i).trim();
        }
        
        if (calls.length === 0) {
            return null;
        }
        
        
        // Resolve the chain step by step
        // First call is a function (global or static)
        let currentType = this.resolveFunctionReturnType(calls[0]);
        if (!currentType) {
            return null;
        }
        
        
        // Each subsequent call is a method on the current type
        for (let j = 1; j < calls.length; j++) {
            const methodName = calls[j];
            const nextType = this.resolveMethodReturnType(currentType, methodName);
            
            if (!nextType) {
                return null;
            }
            
            currentType = nextType;
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
     * Get member completions for a class type (methods + fields)
     * Walks the FULL inheritance chain INCLUDING modded classes
     */
    private getClassMemberCompletions(className: string, prefix: string): CompletionResult[] {
        const results: CompletionResult[] = [];
        const seen = new Set<string>(); // Deduplicate by name
        
        
        // Get the complete class hierarchy including modded classes
        const classHierarchy = this.getClassHierarchyOrdered(className, new Set());
        
        
        for (const classNode of classHierarchy) {
            for (const member of classNode.members || []) {
                if (!member.name) continue;
                if (seen.has(member.name)) continue; // Skip duplicates
                if (prefix && !member.name.toLowerCase().startsWith(prefix.toLowerCase())) continue;
                
                // Skip static members for instance completions
                if (member.modifiers?.includes('static')) continue;
                
                seen.add(member.name);
                
                if (member.kind === 'FunctionDecl') {
                    const func = member as FunctionDeclNode;
                    const params = func.parameters?.map(p => 
                        `${p.type?.identifier || 'auto'} ${p.name}`
                    ).join(', ') || '';
                    
                    // Show visibility modifier if present
                    const visibility = func.modifiers?.find(m => ['private', 'protected'].includes(m)) || '';
                    const visPrefix = visibility ? `${visibility} ` : '';
                    
                    results.push({
                        name: func.name,
                        kind: 'function',
                        detail: `${visPrefix}${func.returnType?.identifier || 'void'} - ${classNode.name}`,
                        insertText: `${func.name}()`,
                        returnType: func.returnType?.identifier
                    });
                } else if (member.kind === 'VarDecl') {
                    const field = member as VarDeclNode;
                    const visibility = field.modifiers?.find(m => ['private', 'protected'].includes(m)) || '';
                    const visPrefix = visibility ? `${visibility} ` : '';
                    
                    results.push({
                        name: field.name,
                        kind: 'variable',
                        detail: `${visPrefix}${field.type?.identifier || 'auto'} - ${classNode.name}`
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
     */
    private findClassByName(className: string): ClassDeclNode | null {
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                if (node.kind === 'ClassDecl' && node.name === className) {
                    return node as ClassDeclNode;
                }
            }
        }
        return null;
    }

    /**
     * Find an enum by name across all indexed files
     */
    private findEnumByName(enumName: string): EnumDeclNode | null {
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                if (node.kind === 'EnumDecl' && node.name === enumName) {
                    return node as EnumDeclNode;
                }
            }
        }
        return null;
    }

    /**
     * Find the module level (1–5) where a symbol is defined.
     * Returns 0 if the symbol is not found or has no module info.
     */
    private getModuleForSymbol(symbolName: string): number {
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                if (node.name === symbolName) {
                    return ast.module || 0;
                }
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
            !(token.kind === TokenKind.Keyword && typeKeywords.has(token.value))) {
            return [];
        }

        const name = token.value;

        // Check if this is a member access (e.g., player.GetInputType or GetGame().GetTime())
        // Look backwards from the token start to find a dot
        const textBeforeToken = text.substring(0, token.start);
        
        // Pattern 1: variable.method (e.g., player.GetInputType)
        const memberMatch = textBeforeToken.match(/(\w+)\s*\.\s*$/);
        
        // Pattern 2: functionCall().method (e.g., GetGame().GetTime())
        const chainedCallMatch = textBeforeToken.match(/(\w+)\s*\([^)]*\)\s*\.\s*$/);
        
        if (memberMatch) {
            // MEMBER ACCESS: Resolve the variable type and search only that class hierarchy
            const varName = memberMatch[1];
            const varType = this.resolveVariableType(doc, _pos, varName);
            
            if (varType) {
                const classMatches = this.findMemberInClassHierarchy(varType, name);
                if (classMatches.length > 0) {
                    return classMatches;
                }
            }
            
            // If varName looks like a class (uppercase), try static member lookup
            if (varName[0] === varName[0].toUpperCase()) {
                const classMatches = this.findMemberInClassHierarchy(varName, name);
                if (classMatches.length > 0) {
                    return classMatches;
                }
            }
        }
        
        if (chainedCallMatch) {
            // CHAINED CALL: Resolve the return type of the function call
            const funcName = chainedCallMatch[1];
            const returnType = this.resolveFunctionReturnType(funcName);
            
            if (returnType) {
                const classMatches = this.findMemberInClassHierarchy(returnType, name);
                if (classMatches.length > 0) {
                    return classMatches;
                }
            }
        }
        
        // Check if we're inside a class - prioritize current class and inheritance
        const ast = this.ensure(doc);
        const containingClass = this.findContainingClass(ast, _pos);
        
        if (containingClass) {
            // First, look in current class hierarchy
            const hierarchyMatches = this.findMemberInClassHierarchy(containingClass.name, name);
            if (hierarchyMatches.length > 0) {
                return hierarchyMatches;
            }
        }

        // FALLBACK: Global search - but with proper scoping rules
        // - Enum members ONLY if accessed via EnumName.member
        // - Class members ONLY if inside that class (already checked above)
        const matches: SymbolNodeBase[] = [];

        // Check if this is an enum member access (e.g., MuzzleState.U)
        const enumMemberMatch = textBeforeToken.match(/(\w+)\s*\.\s*$/);
        const isEnumAccess = enumMemberMatch && enumMemberMatch[1][0] === enumMemberMatch[1][0].toUpperCase();

        // iterate all loaded documents
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                // top-level match (classes, functions, global variables, enums, typedefs)
                if (node.name === name) {
                    matches.push(node as SymbolNodeBase);
                }

                // Enum member match - ONLY if accessed via EnumName.member
                if (isEnumAccess && enumMemberMatch && node.kind === 'EnumDecl' && node.name === enumMemberMatch[1]) {
                    for (const member of (node as EnumDeclNode).members) {
                        if (member.name === name) {
                            matches.push(member as SymbolNodeBase);
                        }
                    }
                }
                
                // Class members are NOT included in global search
                // They should only be found via:
                // 1. Member access (player.Method) - handled above
                // 2. Inside the class (this.Method or just Method) - handled above
                // 3. Inheritance chain - handled above
            }
        }

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
        
        for (const classNode of classesToSearch) {
            for (const member of classNode.members || []) {
                if (member.name === memberName) {
                    matches.push(member as SymbolNodeBase);
                }
            }
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
        const classNodes = this.findAllClassesByName(className);
        if (classNodes.length === 0) return [];
        
        // Separate original class from modded classes
        const originalClass = classNodes.find(c => !c.modifiers?.includes('modded'));
        const moddedClasses = classNodes.filter(c => c.modifiers?.includes('modded'));
        
        // Get the base class name (from original or first modded)
        const baseClassName = (originalClass || classNodes[0])?.base?.identifier;
        
        // Recursively get parent hierarchy FIRST (so base classes come first)
        const parentHierarchy: ClassDeclNode[] = baseClassName 
            ? this.getClassHierarchyOrdered(baseClassName, visited)
            : [];
        
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
     */
    private findAllClassesByName(className: string): ClassDeclNode[] {
        const matches: ClassDeclNode[] = [];
        
        for (const [uri, ast] of this.docCache) {
            for (const node of ast.body) {
                if (node.kind === 'ClassDecl' && node.name === className) {
                    const classNode = node as ClassDeclNode;
                    matches.push(classNode);
                }
            }
        }
        
        if (matches.length === 0) {
        }
        
        return matches;
    }

    getHover(doc: TextDocument, _pos: Position): string | null {
        const symbols = this.resolveDefinitions(doc, _pos);
        if (symbols.length === 0) return null;

        return symbols
            .map((s) => formatDeclaration(s))
            .join('\n\n');
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

    runDiagnostics(doc: TextDocument): Diagnostic[] {
        const ast = this.ensure(doc);
        const diags: Diagnostic[] = [];
        
        // Include parser-generated diagnostics (e.g., ternary operator errors)
        if (ast.diagnostics && ast.diagnostics.length > 0) {
            diags.push(...ast.diagnostics);
        }
        
        // Only run type/symbol checks if we have enough indexed files
        // This prevents false positives during initial workspace indexing
        if (this.docCache.size >= Analyzer.MIN_INDEX_SIZE_FOR_TYPE_CHECKS) {
            // Check for unknown types and symbols
            this.checkUnknownSymbols(ast, diags);
            
            // Check for type mismatches in assignments
            this.checkTypeMismatches(doc, diags);
        }
        
        // Check for multi-line statements (not supported in Enforce Script)
        // This doesn't require indexing - it's purely syntactic
        this.checkMultiLineStatements(doc, diags);
        
        // Check for duplicate variable declarations in same scope
        // Enforce Script doesn't allow duplicate variable names even in sibling for loops
        this.checkDuplicateVariables(doc, diags);
        
        return diags;
    }

    /**
     * Check for duplicate variable declarations within the same scope.
     * In Enforce Script, you cannot have two for loops with the same loop variable
     * at the same scope level, even though they're "separate" blocks.
     * 
     * Example that causes error:
     *   for (int j = 0; j < 10; j++) { }
     *   for (int j = 0; j < 10; j++) { }  // ERROR: 'j' already declared
     */
    private checkDuplicateVariables(doc: TextDocument, diags: Diagnostic[]): void {
        const text = doc.getText();
        
        // Track variables by scope - use a stack of scopes
        // Each scope has a map of variable names to their declaration info
        type VarInfo = { line: number; character: number };
        let scopeStack: Map<string, VarInfo>[] = [new Map()]; // Start with global/class scope
        
        // Pattern to find variable declarations
        // Matches: Type varName in various contexts (including for loop init)
        const varDeclPattern = /\b(int|float|bool|string|auto|vector|Man|PlayerBase|\w+)\s+(\w+)\s*(?:=|;|,|\)|<)/g;
        
        // Pattern to detect function declarations
        // Must have: optional modifiers, return type (including generics), function name, parentheses for params
        // Excludes: array access like m_Foo[0] and assignments
        const funcDeclPattern = /^\s*(?:static\s+|private\s+|protected\s+|override\s+|proto\s+|native\s+)*(?:void|int|float|bool|string|auto|ref\s+\w+|[\w<>,\s]+)\s+(\w+)\s*\([^)]*\)\s*\{?\s*$/;
        
        // Pattern to detect for/foreach/while loops (their vars go to parent scope in Enforce)
        const loopPattern = /\b(for|foreach|while)\s*\(/;
        
        // Pattern to detect class declarations
        const classDeclPattern = /\b(?:modded\s+)?class\s+(\w+)/;
        
        // Track when we enter/exit functions
        let inFunction = false;
        let functionBraceDepth = 0;
        let braceDepth = 0;
        
        // Track class fields - these need to be visible inside methods
        let classFieldScope: Map<string, VarInfo> = new Map();
        let inClass = false;
        let classBraceDepth = 0;
        
        // Track block comments
        let inBlockComment = false;
        
        // Process line by line to track scope
        const lines = text.split('\n');
        
        for (let lineNum = 0; lineNum < lines.length; lineNum++) {
            const line = lines[lineNum];
            const trimmedLine = line.trim();
            
            // Handle block comments /* ... */
            if (inBlockComment) {
                if (line.includes('*/')) {
                    inBlockComment = false;
                }
                continue; // Skip lines inside block comments
            }
            
            // Check for block comment start
            if (trimmedLine.startsWith('/*') || trimmedLine.startsWith('/**')) {
                if (line.includes('*/')) {
                    // Single-line block comment like /* foo */ - skip entire line
                    continue;
                } else {
                    // Multi-line block comment starts here
                    inBlockComment = true;
                    continue;
                }
            }
            
            // Skip lines that are just block comment content
            if (trimmedLine.startsWith('*') && !trimmedLine.startsWith('*/')) {
                continue;
            }
            
            // Skip lines containing doc comment markers (they may contain signature examples)
            if (trimmedLine.includes('@param') || trimmedLine.includes('@note') || 
                trimmedLine.includes('@return') || trimmedLine.includes('@usage') ||
                trimmedLine.includes('@example') || trimmedLine.includes('@code')) {
                continue;
            }
            
            // Strip trailing comments for pattern matching
            // Use indexOf for reliability
            const commentIdx = line.indexOf('//');
            let lineNoComment = (commentIdx >= 0 ? line.substring(0, commentIdx) : line);
            
            // Also strip inline block comments like: code /* comment */ more code
            lineNoComment = lineNoComment.replace(/\/\*.*?\*\//g, '');
            
            // Strip string literals to avoid detecting patterns inside strings
            // e.g., "string cbFunction" in debug messages
            lineNoComment = lineNoComment.replace(/"(?:[^"\\]|\\.)*"/g, '""');  // Replace "..." with ""
            lineNoComment = lineNoComment.replace(/'(?:[^'\\]|\\.)*'/g, "''");  // Replace '...' with ''
            
            const lineNoCommentTrimmed = lineNoComment.trim();
            
            // Check if this line starts a class
            if (classDeclPattern.test(lineNoComment)) {
                // Starting a new class - reset all class-related state
                inClass = true;
                classBraceDepth = braceDepth;
                classFieldScope = new Map(); // Fresh class field scope
                // Reset scope stack to just global scope
                scopeStack = [new Map()];
                inFunction = false;
            }
            
            // Check if this line has a for/foreach/while loop
            // In Enforce Script, loop variables are scoped to the PARENT scope, not the loop block
            const isLoopLine = loopPattern.test(lineNoComment);
            
            // Check if this line starts a new function
            // Must NOT be a loop line — for(int i ...) looks like a func decl to the regex
            const isFuncDecl = !isLoopLine && funcDeclPattern.test(lineNoComment);
            if (isFuncDecl) {
                // New function - reset to: global scope + class fields (copy) + new function scope
                // We must copy classFieldScope to avoid it being modified by function-local variables
                scopeStack = [scopeStack[0], new Map(classFieldScope), new Map()];
                inFunction = true;
                functionBraceDepth = braceDepth;
            }
            
            // FIRST: Find variable declarations on this line BEFORE processing braces
            // This ensures for loop variables (int j in "for (int j = 0...") 
            // are added to the current scope before we push a new scope for {
            // Use lineNoComment to avoid matching variables in comments
            let match;
            varDeclPattern.lastIndex = 0;
            
            // Use lineNoComment but keep original line for position calculation
            const lineForVars = lineNoComment;
            while ((match = varDeclPattern.exec(lineForVars)) !== null) {
                const typeName = match[1];
                const varName = match[2];
                
                // Skip if it looks like a function call or keyword
                if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'else', 'foreach', 'void', 'override', 'static', 'private', 'protected', 'const', 'ref', 'autoptr', 'proto', 'native', 'modded', 'sealed', 'event'].includes(typeName)) {
                    continue;
                }
                
                // Skip common false positives
                if (['this', 'super', 'null', 'true', 'false'].includes(varName)) {
                    continue;
                }
                
                // Check all scopes in the stack for existing declaration
                let foundDuplicate = false;
                for (let si = 0; si < scopeStack.length; si++) {
                    const scope = scopeStack[si];
                    const existing = scope.get(varName);
                    if (existing) {
                        const startPos = { line: lineNum, character: match.index + match[1].length + 1 };
                        const endPos = { line: lineNum, character: match.index + match[1].length + 1 + varName.length };
                        
                        diags.push({
                            message: `Variable '${varName}' is already declared at line ${existing.line + 1}. Enforce Script does not allow duplicate variable names in the same scope.`,
                            range: { start: startPos, end: endPos },
                            severity: DiagnosticSeverity.Error
                        });
                        foundDuplicate = true;
                        break;
                    }
                }
                
                // Record this declaration in the appropriate scope
                if (!foundDuplicate && scopeStack.length > 0) {
                    // If we're at class level (in a class but not in a function), record as class field
                    if (inClass && !inFunction && braceDepth === classBraceDepth + 1) {
                        classFieldScope.set(varName, {
                            line: lineNum,
                            character: match.index
                        });
                    }
                    // Always add to current scope stack
                    scopeStack[scopeStack.length - 1].set(varName, {
                        line: lineNum,
                        character: match.index
                    });
                }
            }
            
            // THEN: Process braces AFTER variable declarations
            // This ensures for loop vars are in parent scope
            for (let charIdx = 0; charIdx < line.length; charIdx++) {
                const char = line[charIdx];
                if (char === '{') {
                    braceDepth++;
                    // Push new scope
                    scopeStack.push(new Map());
                } else if (char === '}') {
                    braceDepth--;
                    // Pop scope
                    if (scopeStack.length > 1) {
                        scopeStack.pop();
                    }
                    // Check if we exited a function
                    if (inFunction && braceDepth <= functionBraceDepth) {
                        inFunction = false;
                    }
                    // Check if we exited a class
                    if (inClass && braceDepth <= classBraceDepth) {
                        inClass = false;
                        classFieldScope = new Map();
                    }
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
        
        // auto/typename/Class are wildcards - always compatible
        if (declNorm === 'auto' || assignNorm === 'auto' ||
            declNorm === 'typename' || assignNorm === 'typename' ||
            declNorm === 'Class' || assignNorm === 'Class') {
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
        
        // Check class hierarchy for UPCAST
        const assignedHierarchy = this.getClassHierarchyOrdered(assignNorm, new Set());
        for (const classNode of assignedHierarchy) {
            if (classNode.name === declNorm) {
                return { compatible: true, isDowncast: false, isUpcast: true };
            }
        }
        
        // Check class hierarchy for DOWNCAST
        const declaredHierarchy = this.getClassHierarchyOrdered(declNorm, new Set());
        for (const classNode of declaredHierarchy) {
            if (classNode.name === assignNorm) {
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
        const numericTypes = new Set(['int', 'float', 'bool']);
        if (numericTypes.has(declLower) && numericTypes.has(assignLower)) {
            return { compatible: true, isDowncast: false, isUpcast: false };
        }
        
        // Hardcoded primitives - used as fallback when not indexed
        const hardcodedPrimitives = new Set(['int', 'float', 'bool', 'string', 'void', 'vector']);
        const declIsPrimitive = hardcodedPrimitives.has(declLower);
        const assignIsPrimitive = hardcodedPrimitives.has(assignLower);
        
        // string is only compatible with string
        if (declLower === 'string' || assignLower === 'string') {
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
        
        // If we can't determine the types (not in cache), assume compatible
        const declExists = this.findAllClassesByName(declNorm).length > 0;
        const assignExists = this.findAllClassesByName(assignNorm).length > 0;
        
        if (!declExists || !assignExists) {
            return { compatible: true, isDowncast: false, isUpcast: false }; // Unknown types
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
    private checkTypeMismatches(doc: TextDocument, diags: Diagnostic[]): void {
        const text = doc.getText();
        const ast = this.ensure(doc);
        
        // Scoped variable tracking - each variable knows its valid line range
        interface ScopedVar {
            type: string;
            startLine: number;
            endLine: number;  // -1 means class field (valid everywhere in class)
            isClassField: boolean;
        }
        
        // Map of variable name -> array of scoped declarations
        const scopedVars = new Map<string, ScopedVar[]>();
        
        // Helper to add a scoped variable
        const addScopedVar = (name: string, type: string, startLine: number, endLine: number, isClassField: boolean) => {
            if (!scopedVars.has(name)) {
                scopedVars.set(name, []);
            }
            scopedVars.get(name)!.push({ type, startLine, endLine, isClassField });
        };
        
        // Helper to get the type of a variable at a specific line
        const getVarTypeAtLine = (name: string, line: number): string | undefined => {
            const vars = scopedVars.get(name);
            if (!vars) return undefined;
            
            // Find the most specific scope that contains this line
            // Priority: 1) local vars in range, 2) class fields in range
            let bestMatch: ScopedVar | undefined;
            
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
        
        // Collect types from all declarations in this file with proper scoping
        const collectVarTypes = (nodes: any[], classStartLine?: number, classEndLine?: number) => {
            for (const node of nodes) {
                // Top-level var declarations (globals)
                if (node.kind === 'VarDecl' && node.name && node.type?.identifier) {
                    const startLine = node.start?.line ?? 0;
                    addScopedVar(node.name, node.type.identifier, startLine, Number.MAX_SAFE_INTEGER, false);
                }
                
                if (node.kind === 'FunctionDecl') {
                    const funcStart = node.start?.line ?? 0;
                    const funcEnd = node.end?.line ?? Number.MAX_SAFE_INTEGER;
                    
                    // Collect parameters - scoped to this function
                    for (const param of node.parameters || []) {
                        if (param.name && param.type?.identifier) {
                            addScopedVar(param.name, param.type.identifier, funcStart, funcEnd, false);
                        }
                    }
                    // Collect locals - scoped to this function
                    for (const local of node.locals || []) {
                        if (local.name && local.type?.identifier) {
                            const localStart = local.start?.line ?? funcStart;
                            addScopedVar(local.name, local.type.identifier, localStart, funcEnd, false);
                        }
                    }
                }
                
                if (node.kind === 'ClassDecl') {
                    const clsStart = node.start?.line ?? 0;
                    const clsEnd = node.end?.line ?? Number.MAX_SAFE_INTEGER;
                    
                    // Collect class fields - they're accessible anywhere in the class
                    for (const member of node.members || []) {
                        if (member.kind === 'VarDecl' && member.name && member.type?.identifier) {
                            addScopedVar(member.name, member.type.identifier, clsStart, clsEnd, true);
                        }
                        // Also process methods within the class
                        if (member.kind === 'FunctionDecl') {
                            const funcStart = member.start?.line ?? clsStart;
                            const funcEnd = member.end?.line ?? clsEnd;
                            
                            for (const param of member.parameters || []) {
                                if (param.name && param.type?.identifier) {
                                    addScopedVar(param.name, param.type.identifier, funcStart, funcEnd, false);
                                }
                            }
                            for (const local of member.locals || []) {
                                if (local.name && local.type?.identifier) {
                                    const localStart = local.start?.line ?? funcStart;
                                    addScopedVar(local.name, local.type.identifier, localStart, funcEnd, false);
                                }
                            }
                        }
                    }
                    
                    // Also collect inherited fields from parent classes
                    // This ensures fields from base classes are accessible in derived classes
                    if (node.base?.identifier) {
                        const parentClasses = this.getClassHierarchyOrdered(node.base.identifier, new Set());
                        for (const parentClass of parentClasses) {
                            for (const member of parentClass.members || []) {
                                if (member.kind === 'VarDecl' && member.name) {
                                    const varMember = member as VarDeclNode;
                                    if (varMember.type?.identifier) {
                                        // Add inherited fields with the child class's scope
                                        addScopedVar(member.name, varMember.type.identifier, clsStart, clsEnd, true);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        };
        
        collectVarTypes(ast.body);
        
        // The parser doesn't parse function bodies (locals is always []),
        // so we need to scan for local variable declarations using regex.
        // We scan the text line-by-line, tracking which function scope we're in.
        {
            const lines = text.split('\n');
            let inBlockComment = false;
            
            // For each function in the AST, scan its body for local declarations
            for (const node of ast.body) {
                if (node.kind === 'ClassDecl') {
                    const classNode = node as ClassDeclNode;
                    for (const member of classNode.members || []) {
                        if (member.kind === 'FunctionDecl') {
                            const func = member as FunctionDeclNode;
                            const funcStart = func.start?.line ?? 0;
                            const funcEnd = func.end?.line ?? 0;
                            if (funcEnd <= funcStart) continue;
                            
                            // Scan lines within this function for variable declarations
                            for (let lineIdx = funcStart; lineIdx <= funcEnd && lineIdx < lines.length; lineIdx++) {
                                let line = lines[lineIdx];
                                
                                // Handle block comments
                                if (inBlockComment) {
                                    if (line.includes('*/')) inBlockComment = false;
                                    continue;
                                }
                                if (line.trimStart().startsWith('/*')) {
                                    if (!line.includes('*/')) inBlockComment = true;
                                    continue;
                                }
                                
                                // Strip comments and strings
                                const commentIdx = line.indexOf('//');
                                if (commentIdx >= 0) line = line.substring(0, commentIdx);
                                line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
                                line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''");
                                line = line.trim();
                                
                                // Skip empty, control flow, return, etc.
                                if (!line) continue;
                                
                                // Match: Type varName; or Type varName = ...;
                                // Must start with a type (capitalized or known primitive)
                                // Exclude: keywords, function calls, return statements
                                const localDeclPattern = /\b([A-Z]\w+|int|float|bool|string|auto|vector|ref|autoptr)\s+(\w+)\s*(?:[=;,])/g;
                                let m;
                                while ((m = localDeclPattern.exec(line)) !== null) {
                                    const typeName = m[1];
                                    const varName = m[2];
                                    
                                    // Skip if type is a keyword/modifier
                                    if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum',
                                         'else', 'case', 'override', 'static', 'private', 'protected', 'ref', 'autoptr',
                                         'const', 'proto', 'native', 'Print', 'foreach'].includes(typeName)) {
                                        continue;
                                    }
                                    // Skip if varName is a keyword
                                    if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'true', 'false', 'null'].includes(varName)) {
                                        continue;
                                    }
                                    
                                    addScopedVar(varName, typeName, lineIdx, funcEnd, false);
                                }
                            }
                        }
                    }
                }
                // Also scan top-level functions
                if (node.kind === 'FunctionDecl') {
                    const func = node as FunctionDeclNode;
                    const funcStart = func.start?.line ?? 0;
                    const funcEnd = func.end?.line ?? 0;
                    if (funcEnd <= funcStart) continue;
                    
                    for (let lineIdx = funcStart; lineIdx <= funcEnd && lineIdx < lines.length; lineIdx++) {
                        let line = lines[lineIdx];
                        
                        if (inBlockComment) {
                            if (line.includes('*/')) inBlockComment = false;
                            continue;
                        }
                        if (line.trimStart().startsWith('/*')) {
                            if (!line.includes('*/')) inBlockComment = true;
                            continue;
                        }
                        
                        const commentIdx = line.indexOf('//');
                        if (commentIdx >= 0) line = line.substring(0, commentIdx);
                        line = line.replace(/"(?:[^"\\]|\\.)*"/g, '""');
                        line = line.replace(/'(?:[^'\\]|\\.)*'/g, "''");
                        line = line.trim();
                        
                        if (!line) continue;
                        
                        const localDeclPattern = /\b([A-Z]\w+|int|float|bool|string|auto|vector|ref|autoptr)\s+(\w+)\s*(?:[=;,])/g;
                        let m;
                        while ((m = localDeclPattern.exec(line)) !== null) {
                            const typeName = m[1];
                            const varName = m[2];
                            
                            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum',
                                 'else', 'case', 'override', 'static', 'private', 'protected', 'ref', 'autoptr',
                                 'const', 'proto', 'native', 'Print', 'foreach'].includes(typeName)) {
                                continue;
                            }
                            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'true', 'false', 'null'].includes(varName)) {
                                continue;
                            }
                            
                            addScopedVar(varName, typeName, lineIdx, funcEnd, false);
                        }
                    }
                }
            }
        }
        
        // Helper to check if a position is inside a comment or string
        const isInsideCommentOrString = (position: number): boolean => {
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
                if (i > 0 && text[i-1] === '*' && text[i] === '/') {
                    // Found end of block comment, we're outside
                    break;
                }
                if (i > 0 && text[i-1] === '/' && text[i] === '*') {
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
                } else if (inString && ch === stringChar && (j === 0 || line[j-1] !== '\\')) {
                    inString = false;
                }
            }
            return inString;
        };
        
        // For variable type scanning, we can still use stripped text since we just need types
        const textForScanning = text
            .replace(/\/\/.*$/gm, '')  // Remove single-line comments
            .replace(/\/\*[\s\S]*?\*\//g, '')  // Remove multi-line comments
            .replace(/"(?:[^"\\]|\\.)*"/g, '""')  // Replace "..." with ""
            .replace(/'(?:[^'\\]|\\.)*'/g, "''");  // Replace '...' with ''
        
        // Helper to get line number from character position
        const getLineFromPos = (pos: number): number => {
            let line = 0;
            for (let i = 0; i < pos && i < text.length; i++) {
                if (text[i] === '\n') line++;
            }
            return line;
        };
        
        // Pattern 1: Type varName = FunctionCall();
        // e.g., int i = GetGame();
        // Use [ \t]+ between type and varName to prevent matching across line breaks
        const funcAssignPattern = /\b(\w+)[ \t]+(\w+)\s*=\s*(\w+)\s*\(/g;
        
        let match;
        while ((match = funcAssignPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (isInsideCommentOrString(match.index)) {
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
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum'].includes(declaredType)) {
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
                // Find the end of the full statement (semicolon or closing paren+semicolon)
                // Much simpler: just find where the statement ends
                const stmtEnd = afterMatch.indexOf(';');
                let chainEnd = stmtEnd >= 0 ? stmtEnd : afterMatch.length;
                
                // For highlighting, we want to include up to but not including the semicolon
                // But we need to find where the actual chain ends (last closing paren before semicolon)
                let lastParen = chainEnd;
                for (let i = chainEnd - 1; i >= 0; i--) {
                    if (afterMatch[i] === ')') {
                        lastParen = i + 1;
                        break;
                    }
                }
                chainEnd = lastParen;
                
                const fullChainText = funcName + '(' + afterMatch.substring(0, chainEnd);
                returnType = this.resolveChainReturnType(fullChainText);
                highlightLength = match[0].length + chainEnd;
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
                returnType = this.resolveFunctionReturnType(funcName);
                highlightLength = match[0].length + singleEnd;
            }
            
            if (returnType) {
                this.addTypeMismatchDiagnostic(doc, diags, match.index, highlightLength, declaredType, returnType);
            }
        }
        
        // Pattern 2: Type varName = otherVar;
        // e.g., int i = p; where p is PlayerBase
        // Use [ \t]+ between type and varName to prevent matching across line breaks
        const varDeclAssignPattern = /\b(\w+)[ \t]+(\w+)\s*=\s*(\w+)\s*;/g;
        
        while ((match = varDeclAssignPattern.exec(text)) !== null) {
            // Skip if inside comment or string
            if (isInsideCommentOrString(match.index)) {
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
            if (['if', 'while', 'for', 'switch', 'return', 'new', 'delete', 'class', 'enum', 'else'].includes(declaredType)) {
                continue;
            }
            
            // Skip if source looks like a literal (number, true, false, null)
            if (/^\d+$/.test(sourceVar) || ['true', 'false', 'null', 'NULL'].includes(sourceVar)) {
                continue;
            }
            
            // Look up the type of the source variable at this line
            const lineNum = getLineFromPos(match.index);
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
            if (isInsideCommentOrString(match.index)) {
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
            const lineNum = getLineFromPos(match.index);
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
            if (isInsideCommentOrString(match.index)) {
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
            const lineNum = getLineFromPos(match.index);
            const targetType = getVarTypeAtLine(targetVar, lineNum);
            let returnType: string | null;
            let chainEnd = 0;
            
            if (chainDetected) {
                // Find the end of the full statement (semicolon)
                const stmtEnd = afterMatch.indexOf(';');
                chainEnd = stmtEnd >= 0 ? stmtEnd : afterMatch.length;
                
                // Find where the actual chain ends (last closing paren before semicolon)
                for (let i = chainEnd - 1; i >= 0; i--) {
                    if (afterMatch[i] === ')') {
                        chainEnd = i + 1;
                        break;
                    }
                }
                
                const fullChainText = funcName + '(' + afterMatch.substring(0, chainEnd);
                returnType = this.resolveChainReturnType(fullChainText);
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
                returnType = this.resolveFunctionReturnType(funcName);
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
                // Calculate actual start position (skip the leading delimiter and whitespace)
                const actualStart = match.index + 1 + leadingWhitespace.length;
                const actualLength = match[0].length - 1 - leadingWhitespace.length + chainEnd;
                this.addTypeMismatchDiagnostic(doc, diags, actualStart, actualLength, targetType, returnType);
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
     * Check for multi-line statements which are NOT supported in Enforce Script.
     * Each statement must be on a single line.
     * 
     * Detects patterns like:
     *   Print("text" +
     *       "more text");  // ERROR!
     */
    private checkMultiLineStatements(doc: TextDocument, diags: Diagnostic[]): void {
        const text = doc.getText();
        const lines = text.split('\n');
        
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
            
            // Only check for unclosed parentheses - this is the real multi-line issue
            // e.g., Print("text" +
            //         "more");   <-- not allowed in Enforce Script
            const openParens = (line.match(/\(/g) || []).length;
            const closeParens = (line.match(/\)/g) || []).length;
            const unclosedParens = openParens > closeParens;
            
            // Skip lines ending with { or ; or } - those are complete
            const endsWithTerminator = /[{};]\s*$/.test(line);
            
            // Skip declaration starts (class, if, for, etc.)
            const isDeclarationStart = /^(class|modded|enum|struct|typedef|if|else|for|while|switch|foreach)\b/.test(line);
            
            if (unclosedParens && !endsWithTerminator && !isDeclarationStart && i + 1 < lines.length) {
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
