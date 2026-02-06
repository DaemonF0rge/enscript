/**********************************************************************
 *  Mini-parser for Enforce/EnScript (DayZ / Arma Reforger flavour)
 *  ================================================================
 *  
 *  Walks tokens once, builds a lightweight AST capturing:
 *      • classes  (base, modifiers, fields, methods)
 *      • enums    + enumerators
 *      • typedefs
 *      • free functions / globals
 *      • local variables inside method bodies
 *  
 *  RECENT FIXES & IMPROVEMENTS:
 *  
 *  1. NESTED GENERIC >> TOKEN SPLITTING (parseType)
 *     Problem: In nested generics like map<string, array<int>>, the closing
 *     '>>' was treated as a single token (right-shift operator).
 *     
 *     Solution: When parsing generic args and we encounter '>>', we:
 *       - Consume the '>>' token
 *       - Return from inner generic parsing
 *       - Leave a synthetic '>' for the outer generic to consume
 *     
 *     This is a classic parsing challenge also faced by C++ compilers!
 *  
 *  2. OPERATOR OVERLOAD PARSING (expectIdentifier)
 *     Problem: Enforce Script allows operator overloads like:
 *       bool operator==(MyClass other)
 *       bool operator<(MyClass other)
 *     These were rejected as invalid function names.
 *     
 *     Solution: Extended expectIdentifier() to recognize 'operator' followed
 *     by an operator token as a valid composite identifier.
 *  
 *  3. DESTRUCTOR PARSING (expectIdentifier)
 *     Problem: Destructor names like ~Foo were not parsed correctly.
 *     
 *     Solution: Handle '~' followed by identifier as a single name token.
 *  
 *  4. TEMPLATE CLASS DECLARATIONS (parseDecl)
 *     Problem: Generic class declarations like:
 *       class Container<Class T> { ... }
 *     Were not parsing the generic parameter list correctly.
 *     
 *     Solution: Added proper parsing of <Class T1, Class T2> syntax.
 *  
 *********************************************************************/

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    Position,
    Connection,
    Diagnostic,
    DiagnosticSeverity
} from 'vscode-languageserver';
import { SymbolKind } from 'vscode-languageserver-types';
import { Token, TokenKind } from '../lexer/token';
import { lex } from '../lexer/lexer';
import * as url from 'node:url';

export class ParseError extends Error {
    constructor(
        public readonly uri: string,
        public readonly line: number,
        public readonly column: number,
        message: string
    ) {
        const fsPath = url.fileURLToPath(uri);
        super(`${message} (${fsPath}:${line}:${column})`);
        this.name = 'ParseError';
    }
}

// config tables
const modifiers = new Set(['override', 'proto', 'native', 'modded', 'owned', 'ref', 'reference', 'public', 'private', 'protected', 'static', 'const', 'out', 'inout', 'notnull', 'external', 'volatile', 'local', 'autoptr', 'event', 'sealed', 'abstract', 'final']);

const isModifier = (t: Token) =>
    t.kind === TokenKind.Keyword && modifiers.has(t.value);

export type NodeKind =
    | 'Type'
    | 'ClassDecl'
    | 'EnumDecl'
    | 'EnumMemberDecl'
    | 'Typedef'
    | 'FunctionDecl'
    | 'VarDecl';

export function toSymbolKind(kind: NodeKind): SymbolKind {
    switch (kind) {
        case 'ClassDecl':
            return SymbolKind.Class;
        case 'EnumDecl':
            return SymbolKind.Enum;
        case 'FunctionDecl':
            return SymbolKind.Function;
        case 'VarDecl':
            return SymbolKind.Variable;
        case 'Type':
        case 'Typedef':
            return SymbolKind.TypeParameter;
        default:
            return SymbolKind.Object; // Fallback
    }
}

export interface NodeBase {
    kind: NodeKind;
    uri: string;
    start: Position;
    end: Position;
}

export interface TypeNode extends NodeBase {
    identifier: string;
    genericArgs?: TypeNode[]; // undefined - not generic, 0 no types
    arrayDims: (number | string | undefined)[]; // T - arrayDims=[], T[3] - arrayDims=[3], T[3][2] - arrayDims=[3, 2], T[] = arrayDims[undefined], T[4][] - arrayDims[4, undefined]
    modifiers: string[];
}

export interface SymbolNodeBase extends NodeBase {
    name: string;
    nameStart: Position;
    nameEnd: Position;
    annotations: string[][];
    modifiers: string[];
}

export interface ClassDeclNode extends SymbolNodeBase {
    kind: 'ClassDecl';
    genericVars?: string[];
    base?: TypeNode;
    members: SymbolNodeBase[];
}

export interface EnumMemberDeclNode extends SymbolNodeBase {
    kind: 'EnumMemberDecl';
}

export interface EnumDeclNode extends SymbolNodeBase {
    kind: 'EnumDecl';
    base?: string;
    members: EnumMemberDeclNode[];
}

export interface TypedefNode extends SymbolNodeBase {
    kind: 'Typedef';
    oldType: TypeNode;
}

export interface VarDeclNode extends SymbolNodeBase {
    kind: 'VarDecl';
    type: TypeNode;
}

export interface FunctionDeclNode extends SymbolNodeBase {
    kind: 'FunctionDecl';
    parameters: VarDeclNode[];
    returnType: TypeNode;
    locals: VarDeclNode[];
}

export interface File {
    body: SymbolNodeBase[]
    version: number
    diagnostics: Diagnostic[]  // Parser-generated diagnostics (e.g., ternary operator warnings)
}

// parse entry point
export function parse(
    doc: TextDocument,
    conn?: Connection            // optional – pass from index.ts to auto-log
): File {
    const toks = lex(doc.getText());
    const text = doc.getText();
    let pos = 0;
    
    // ====================================================================
    // DIAGNOSTICS COLLECTION (PORTED FROM JS)
    // ====================================================================
    // Collect parser-generated diagnostics like ternary operator warnings.
    // These are returned in the File result for the LSP to report.
    // ====================================================================
    const diagnostics: Diagnostic[] = [];
    
    /**
     * Add a diagnostic error or warning
     */
    function addDiagnostic(token: Token, message: string, severity: DiagnosticSeverity = DiagnosticSeverity.Error): void {
        diagnostics.push({
            range: {
                start: doc.positionAt(token.start),
                end: doc.positionAt(token.end)
            },
            message,
            severity,
            source: 'enforce-script'
        });
    }

    // Flag for handling nested generic '>>' tokens
    // When the inner parseType consumes '>>', it sets this flag to tell
    // the outer parseType that its closing '>' was already consumed.
    let pendingGenericClose = false;

    /* skip comments / #ifdef lines */
    const skipTrivia = () => {
        while (
            pos < toks.length &&
            (toks[pos].kind === TokenKind.Comment ||
                toks[pos].kind === TokenKind.Preproc)
        ) {
            pos++;
        }
    };

    function peek(): Token {
        skipTrivia();
        return toks[pos];
    }

    function next(): Token {
        skipTrivia();
        return toks[pos++];
    }

    function eof(): boolean {
        skipTrivia();
        return peek().kind === TokenKind.EOF;
    }

    const throwErr = (t: Token, want = 'token'): never => {
        const p = doc.positionAt(t.start);
        throw new ParseError(
            doc.uri,
            p.line + 1,
            p.character + 1,
            `expected ${want}, got '${t.value}' (${TokenKind[t.kind]})`
        );
    };

    /* helper: check if a keyword is a primitive type */
    const isPrimitiveType = (value: string): boolean => {
        return ['void', 'int', 'float', 'bool', 'string', 'vector', 'typename'].includes(value);
    };

    /* read & return one identifier or keyword token */
    const readTypeLike = (): Token => {
        const t = peek();
        if (t.kind === TokenKind.Identifier)
            return next();
        // Allow primitive type keywords (int, float, bool, string, void, vector, typename)
        if (t.kind === TokenKind.Keyword && isPrimitiveType(t.value))
            return next();
        return throwErr(t, 'type identifier');
    };

    /* scan parameter list quickly, ignore default values */
    const fastParamScan = (doc: TextDocument): VarDeclNode[] => {
        const list: VarDeclNode[] = [];
        expect('(');
        while (!eof() && peek().value !== ')') {
            const varDecl = expectVarDecl(doc, true);
            // ignore default values
            while (!eof() && peek().value !== ')' && peek().value !== ',')
                next();

            if (peek().value === ',') next();

            list.push(varDecl);
        }

        expect(')');

        return list;
    };

    const expect = (val: string) => {
        if (peek().value !== val) throwErr(peek(), `'${val}'`);
        return next();
    };

    // ast root
    const file: File = {
        body: [],
        version: doc.version,
        diagnostics: diagnostics  // Include parser diagnostics
    };

    // main loop
    while (!eof()) {
        if (eof()) break;

        // skip semicolons
        if (peek().value === ';') {
            next();
            continue;
        }

        const nodes = parseDecl(doc, 0); // depth = 0
        file.body.push(...nodes);
    }

    return file;

    // declaration parser (recursive)
    function parseDecl(doc: TextDocument, depth: number, inline: boolean = false): SymbolNodeBase[] {

        // annotations and modifiers are allowed on functions, variables, class members
        const annotations: string[][] = [];
        while (peek().value === '[') {
            const ano = expectAnnotation();
            annotations.push(ano);
        }

        const mods: string[] = [];
        while (isModifier(peek())) {
            mods.push(next().value);
        }

        // Handle EOF after modifiers (e.g., empty file or file ending with modifiers only)
        if (eof()) {
            return [];
        }

        // Handle standalone annotations with no declaration: [Obsolete("...")]; 
        if (annotations.length > 0 && peek().value === ';') {
            next(); // consume the semicolon
            return [];
        }

        const t = peek();

        // class
        if (t.value === 'class') {
            next();
            const nameTok = expectIdentifier();
            let genericVars: string[] | undefined;
            // generic: Param<Class T1, Class T2>
            if (peek().value === '<') {
                next();
                genericVars = [];

                while (peek().value !== '>' && !eof()) {
                    expect('Class');
                    genericVars.push(expectIdentifier().value);
                    if (peek().value === ',') next();
                }

                expect('>');
            }
            let base: TypeNode | undefined;
            if (peek().value === ':' || peek().value === 'extends') {
                next();
                base = parseType(doc);
            }
            expect('{');
            const members: SymbolNodeBase[] = [];
            while (peek().value !== '}' && !eof()) {
                // skip semicolons
                if (peek().value === ';') {
                    next();
                    continue;
                }
                const m = parseDecl(doc, depth + 1);
                members.push(...m);
            }
            expect('}');

            return [{
                kind: 'ClassDecl',
                uri: doc.uri,
                name: nameTok.value,
                nameStart: doc.positionAt(nameTok.start),
                nameEnd: doc.positionAt(nameTok.end),
                base: base,
                annotations: annotations,
                modifiers: mods,
                members: members,
                start: doc.positionAt(t.start),
                end: doc.positionAt(peek().end)
            } as ClassDeclNode];
        }

        // enum
        if (t.value === 'enum') {
            next();
            const nameTok = expectIdentifier();
            let base: string | undefined;
            if (peek().value === ':' || peek().value === 'extends') {
                next();
                base = expectIdentifier().value;
            }
            expect('{');
            const enumerators: EnumMemberDeclNode[] = [];
            while (peek().value !== '}' && !eof()) {
                if (peek().kind === TokenKind.Identifier) {
                    const enumMemberNameTok = next();
                    enumerators.push({
                        kind: 'EnumMemberDecl',
                        uri: doc.uri,
                        name: enumMemberNameTok.value,
                        nameStart: doc.positionAt(enumMemberNameTok.start),
                        nameEnd: doc.positionAt(enumMemberNameTok.end),
                        start: doc.positionAt(enumMemberNameTok.start),
                        end: doc.positionAt(enumMemberNameTok.end),
                    } as EnumMemberDeclNode);
                }
                else next();
            }
            expect('}');

            return [{
                kind: 'EnumDecl',
                uri: doc.uri,
                name: nameTok.value,
                nameStart: doc.positionAt(nameTok.start),
                nameEnd: doc.positionAt(nameTok.end),
                base: base,
                members: enumerators,
                annotations: annotations,
                modifiers: mods,
                start: doc.positionAt(t.start),
                end: doc.positionAt(peek().end)
            } as EnumDeclNode];
        }

        // typedef
        if (t.value === 'typedef') {
            next();
            const oldType = parseType(doc);
            const nameTok = expectIdentifier();

            return [{
                kind: 'Typedef',
                uri: doc.uri,
                oldType: oldType,
                name: nameTok.value,
                annotations: annotations,
                modifiers: mods,
                nameStart: doc.positionAt(nameTok.start),
                nameEnd: doc.positionAt(nameTok.end),
                start: doc.positionAt(t.start),
                end: doc.positionAt(peek().end)
            } as TypedefNode];
        }

        // Handle statement keywords that can appear at top level in invalid code
        // These are not valid top-level declarations, skip to semicolon/brace and recover
        const statementKeywords = ['for', 'while', 'if', 'else', 'switch', 'return', 'break', 'continue', 'do', 'foreach'];
        if (t.kind === TokenKind.Keyword && statementKeywords.includes(t.value)) {
            // Skip past this statement - find matching braces and semicolons
            let braceDepth = 0;
            let parenDepth = 0;
            while (!eof()) {
                const tok = next();
                if (tok.value === '(') parenDepth++;
                else if (tok.value === ')') parenDepth--;
                else if (tok.value === '{') braceDepth++;
                else if (tok.value === '}') {
                    braceDepth--;
                    if (braceDepth === 0 && parenDepth === 0) break;
                }
                else if (tok.value === ';' && braceDepth === 0 && parenDepth === 0) break;
            }
            return [];
        }

        // function OR variable
        const baseTypeNode = parseType(doc);
        
        // Handle incomplete/invalid code gracefully at top level:
        // - "g_Game." - dot without identifier (incomplete member access)
        // - "GetGame().Something();" - top-level statement (function call expression)
        // - "SomeType = value" - assignment without variable name
        // - EOF after type
        // These are not valid declarations, skip to semicolon and recover
        if (eof() || peek().value === '.' || (depth === 0 && peek().value === '(') || peek().value === '=') {
            // Skip until we find a semicolon or EOF to recover
            while (!eof() && peek().value !== ';') {
                next();
            }
            if (peek().value === ';') next();
            return [];
        }
        
        let nameTok = expectIdentifier();

        if (peek().value === '(') {
            const params = fastParamScan(doc);

            // ====================================================================
            // FUNCTION BODY PARSING WITH TERNARY DETECTION (PORTED FROM JS)
            // ====================================================================
            // Enforce Script does NOT support the ternary operator (? :).
            // We detect this pattern and generate a diagnostic warning.
            //
            // Example invalid code:
            //   int x = (condition) ? 1 : 0;  // ERROR: Not supported!
            //
            // Valid alternative:
            //   int x;
            //   if (condition) x = 1; else x = 0;
            // ====================================================================
            if (peek().value === '{') {
                next();
                let depth = 1;
                while (depth > 0 && !eof()) {
                    const t = next();
                    if (t.value === '{') depth++;
                    else if (t.value === '}') depth--;
                    // Detect ternary operator (condition ? true : false)
                    // This is invalid in Enforce Script
                    else if (t.value === '?' && depth > 0) {
                        // Check if this looks like a ternary (not just a nullable type)
                        // Ternary is typically: expr ? expr : expr
                        // Look for the colon that follows
                        let scanPos = pos;
                        let scanDepth = 0;
                        let foundColon = false;
                        while (scanPos < toks.length && scanDepth >= 0) {
                            const scanTok = toks[scanPos];
                            if (scanTok.value === '(' || scanTok.value === '[' || scanTok.value === '{') scanDepth++;
                            else if (scanTok.value === ')' || scanTok.value === ']' || scanTok.value === '}') scanDepth--;
                            else if (scanTok.value === ';') break;
                            else if (scanTok.value === ':' && scanDepth === 0) {
                                foundColon = true;
                                break;
                            }
                            scanPos++;
                        }
                        if (foundColon) {
                            addDiagnostic(t, 'Ternary operator (? :) is not supported in Enforce Script. Use if/else statement instead.', DiagnosticSeverity.Error);
                        }
                    }
                }
            }

            return [{
                kind: 'FunctionDecl',
                uri: doc.uri,
                name: nameTok.value,
                nameStart: doc.positionAt(nameTok.start),
                nameEnd: doc.positionAt(nameTok.end),
                returnType: baseTypeNode,
                parameters: params,
                locals: [], //locals,
                annotations: annotations,
                modifiers: mods,
                start: baseTypeNode.start,
                end: doc.positionAt(peek().end)
            } as FunctionDeclNode];
        }

        // variable

        const vars: VarDeclNode[] = [];
        while (!eof()) {
            const typeNode = structuredClone(baseTypeNode);

            // Support trailing `T name[]`
            if (peek().value === '[') {

                // Prevent additional [] after identifier if already declared in type
                if (typeNode.arrayDims.length !== 0) {
                    throwErr(peek(), "not another [");
                }

                parseArrayDims(doc, typeNode);
            }

            // value initialization (skip for now)
            if (peek().value === '=') {
                next();
                
                // Handle EOF after = (incomplete code)
                if (eof()) {
                    break;
                }

                while ((inline && peek().value !== ',' && peek().value !== ')') ||
                    (!inline && peek().value !== ';' && peek().value !== ',')) {
                    
                    // Handle EOF in the middle of initialization
                    if (eof()) {
                        break;
                    }
                    
                    const curTok = next();
                    
                    // Detect ternary operator in variable initializers
                    // Example: int x = condition ? 1 : 0;  // ERROR!
                    if (curTok.value === '?') {
                        // Look for the colon that follows to confirm it's a ternary
                        let scanPos = pos;
                        let scanDepth = 0;
                        let foundColon = false;
                        while (scanPos < toks.length && scanDepth >= 0) {
                            const scanTok = toks[scanPos];
                            if (scanTok.value === '(' || scanTok.value === '[' || scanTok.value === '{') scanDepth++;
                            else if (scanTok.value === ')' || scanTok.value === ']' || scanTok.value === '}') scanDepth--;
                            else if (scanTok.value === ';' || scanTok.value === ',') break;
                            else if (scanTok.value === ':' && scanDepth === 0) {
                                foundColon = true;
                                break;
                            }
                            scanPos++;
                        }
                        if (foundColon) {
                            addDiagnostic(curTok, 'Ternary operator (? :) is not supported in Enforce Script. Use if/else statement instead.', DiagnosticSeverity.Error);
                        }
                    }
                    
                    if (curTok.value === '(' || curTok.value === '[' || curTok.value === '{' || curTok.value === '<') {
                        // skip initializer expression (balanced brackets)
                        // Must handle '>>' as two consecutive '>' closes for nested generics
                        // e.g.: new array<ref array<PIXEL>>();
                        let depth = 1;
                        while (!eof() && depth > 0) {
                            const val = peek().value;
                            if (val === '(' || val === '[' || val === '{' || val === '<') depth++;
                            else if (val === ')' || val === ']' || val === '}' || val === '>') depth--;
                            else if (val === '>>') depth -= 2;
                            else if (val === '<<') depth += 2;
                            // Safety: don't eat past statement boundary
                            if (val === ';' && depth > 0) break;
                            next();
                        }
                    }
                    else if (curTok.value === '-' && peek().kind === TokenKind.Number) {
                        next();
                    }
                    else if (curTok.value !== '?' && curTok.value !== ':' && curTok.kind !== TokenKind.Keyword && curTok.kind !== TokenKind.Identifier && curTok.kind !== TokenKind.Number &&
                        curTok.kind !== TokenKind.String && curTok.value !== '.' && curTok.value !== '+' && curTok.value !== '-' && curTok.value !== '*' && curTok.value !== '/' && curTok.value !== '|' && curTok.value !== '&' && curTok.value !== '%' && curTok.value !== '~' && curTok.value !== '!' && curTok.value !== '^' && curTok.value !== '<<' && curTok.value !== '>>' && curTok.value !== '==' && curTok.value !== '!=' && curTok.value !== '<=' && curTok.value !== '>=' && curTok.value !== '<' && curTok.value !== '>') {
                        throwErr(curTok, "initialization expression");
                    }
                }
            }

            vars.push({
                kind: 'VarDecl',
                uri: doc.uri,
                name: nameTok.value,
                nameStart: doc.positionAt(nameTok.start),
                nameEnd: doc.positionAt(nameTok.end),
                type: baseTypeNode,
                annotations: annotations,
                modifiers: mods,
                start: baseTypeNode.start,
                end: doc.positionAt(peek().end)
            } as VarDeclNode);

            if (!inline && peek().value === ',') {
                next();
                nameTok = expectIdentifier();
                continue;
            }

            break;
        }

        return vars;
    }

    function parseType(doc: TextDocument): TypeNode {

        const mods: string[] = [];

        while (isModifier(peek())) {
            mods.push(next().value);
        }

        const startTok = readTypeLike();
        const identifier = startTok.value;

        const node: TypeNode = {
            kind: 'Type',
            uri: doc.uri,
            start: doc.positionAt(startTok.start),
            end: doc.positionAt(startTok.end),
            identifier: identifier,
            arrayDims: [],
            modifiers: mods,
        };

        // ====================================================================
        // GENERIC/TEMPLATE TYPE PARSING
        // ====================================================================
        // Handles Enforce Script generics like:
        //   - array<string>
        //   - ref map<string, int>
        //   - map<string, ref set<int>>  (nested generics)
        //
        // CRITICAL FIX: Nested Generic >> Token Handling
        // -----------------------------------------------
        // Problem: The lexer may treat >> as a single token (right shift).
        // But in nested generics like map<int, set<int>>, the >> is actually
        // two separate > closing brackets.
        //
        // Solution: When we see '>>' while parsing generics:
        //   1. We're inside nested generic, >> means we close THIS level
        //   2. The outer parseType() call will handle the remaining '>'
        //   3. We DON'T consume the full '>>' - just return and let parent handle it
        //
        // Example parse of: map<string, array<int>>
        //   1. parseType sees 'map', then '<'
        //   2. Recursively parse 'string' (simple type)
        //   3. See ',', continue
        //   4. Recursively parse 'array<int>'
        //      4a. parseType sees 'array', then '<'
        //      4b. Recursively parse 'int' (simple type)
        //      4c. See '>>' - this closes array<int>, return
        //   5. Parent sees '>' (second half of >>), closes map<...>
        //
        // This is a classic parsing challenge also faced by C++ compilers!
        // ====================================================================
        if (peek().value === '<') {
            next();
            node.genericArgs = [];

            // Parse generic arguments, watching for both '>' and '>>'
            // Also check pendingGenericClose - if a nested parseType consumed '>>' 
            // that included our closing '>', we need to stop parsing args
            while (!pendingGenericClose && peek().value !== '>' && peek().value !== '>>' && !eof()) {
                node.genericArgs.push(parseType(doc));
                // After parsing a type arg, check if it consumed our closing bracket
                if (pendingGenericClose) break;
                if (peek().value === ',') next();
            }

            // Handle the closing bracket(s)
            if (pendingGenericClose) {
                // Our nested child already consumed our '>' as part of '>>'
                // Just clear the flag and continue
                pendingGenericClose = false;
                node.end = node.genericArgs[node.genericArgs.length - 1]?.end ?? node.end;
            } else if (peek().value === '>>') {
                // NESTED GENERIC CASE: '>>' at end of generic args
                // This means we have nested generics like map<int, array<string>>
                // The '>>' closes BOTH levels. We consume it but need to signal
                // to our caller that their '>' was already consumed.
                // We do this by leaving a special marker - we set a flag.
                const tok = next(); // consume '>>'
                node.end = doc.positionAt(tok.end);
                // Set flag so outer parseType knows its '>' was consumed
                pendingGenericClose = true;
            } else if (peek().value === '>') {
                const endTok = expect('>');
                node.end = doc.positionAt(endTok.end);
            } else {
                throwErr(peek(), '> or >>');
            }
        }

        parseArrayDims(doc, node);

        return node;
    }

    function parseTypeAndName(doc: TextDocument): { type: TypeNode; name: Token; } {
        const typeNode = parseType(doc);

        const nameTok = expectIdentifier();

        // Support trailing `T name[]`
        if (peek().value === '[') {

            // Prevent additional [] after identifier if already declared in type
            if (typeNode.arrayDims.length !== 0) {
                throwErr(peek(), "not another [");
            }

            parseArrayDims(doc, typeNode);
        }

        return {
            type: typeNode,
            name: nameTok
        };
    }

    function parseArrayDims(doc: TextDocument, typeNode: TypeNode) {
        // array: T[3], T[]
        while (peek().value === '[') {
            next(); // [
            let size: number | string | undefined = undefined;

            if (peek().kind === TokenKind.Number) {
                size = parseInt(next().value);
            }
            else if (peek().kind === TokenKind.Identifier) {
                size = next().value;
            }

            const endTok = expect(']');
            typeNode.arrayDims.push(size);
            typeNode.end = doc.positionAt(endTok.end);
        }
    }

    function expectVarDecl(doc: TextDocument, inline: boolean): VarDeclNode {
        const decl = parseDecl(doc, 0, inline);
        if (!decl) throwErr(peek(), "no declaration");
        if (decl.length !== 1) throwErr(peek(), `internal parser error (decl.length:${decl.length} != 1)`);
        if (decl[0].kind !== "VarDecl") throwErr(peek(), `not a variable declaration ${decl[0].kind}`);
        return decl[0] as VarDeclNode;
    }

    // ========================================================================
    // IDENTIFIER PARSING (with special cases)
    // ========================================================================
    // Handles several Enforce Script-specific identifier patterns:
    //
    // 1. DESTRUCTOR NAMES: ~ClassName
    //    Enforce Script uses C++-style destructors. We combine '~' + name
    //    into a single identifier token.
    //
    // 2. OPERATOR OVERLOADS: operator==, operator<, etc.
    //    Enforce Script allows operator overloading. The function name is
    //    'operator' followed by the operator symbol(s).
    //
    //    Examples:
    //      bool operator==(MyClass other)  → name = "operator=="
    //      bool operator<(MyClass other)   → name = "operator<"
    //      int operator[](int index)       → name = "operator[]"
    //
    // These are combined into synthetic identifier tokens so the parser
    // treats them as normal function names.
    // ========================================================================
    function expectIdentifier(): Token {
        const t = next();

        // DESTRUCTOR: ~Foo
        // Handle '~' followed by identifier as a single destructor name
        // Note: '~' is tokenized as Punctuation (not Operator)
        if (t.kind === TokenKind.Punctuation && t.value === '~' && peek().kind === TokenKind.Identifier) {
            const id = next();
            return {
                kind: TokenKind.Identifier,
                value: '~' + id.value,
                start: t.start,
                end: id.end
            };
        }

        // OPERATOR OVERLOAD: operator==, operator<, operator[], etc.
        // Handle 'operator' keyword followed by operator symbol(s)
        // NOTE: 'operator' is also used as a regular variable/parameter name
        // in DayZ scripts (e.g., `int operator`), so we must only match
        // actual operator symbols, not delimiters like ) , ; { }
        if (t.kind === TokenKind.Identifier && t.value === 'operator') {
            const opTok = peek();
            const validOpOverloads = new Set([
                '==', '!=', '<=', '>=', '<<', '>>',
                '<', '>', '+', '-', '*', '/', '%',
                '&', '|', '^', '~', '!', '[',
            ]);
            if (validOpOverloads.has(opTok.value)) {
                const op = next();
                let opName = op.value;
                
                // Handle operator[] - need to consume both '[' and ']'
                if (op.value === '[' && peek().value === ']') {
                    next(); // consume ']'
                    opName = '[]';
                }
                
                return {
                    kind: TokenKind.Identifier,
                    value: 'operator' + opName,
                    start: t.start,
                    end: op.end
                };
            }
        }

        if (t.kind !== TokenKind.Identifier) {
            // Allow type-keywords as identifiers (e.g., class string, class int)
            // These are valid class/variable names in Enforce Script (defined in enconvert.c, enstring.c)
            if (t.kind === TokenKind.Keyword && isPrimitiveType(t.value)) {
                return { ...t, kind: TokenKind.Identifier };
            }
            throwErr(t, 'identifier');
        }
        return t;
    }

    function expectAnnotation(): string[] {
        const startTok = expect('[');

        const args: string[] = [expectIdentifier().value];

        if (peek().value === '(') {
            expect('(');
            while (peek().value !== ')') {
                if (peek().kind === TokenKind.String || peek().kind === TokenKind.Number) {
                    args.push(next().value);
                } else {
                    next(); // skip unexpected stuff
                }

                if (peek().value === ',') next();
            }
            expect(')');
        }

        const endTok = expect(']');

        return args;
    }
}
