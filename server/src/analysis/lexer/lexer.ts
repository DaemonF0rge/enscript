/**
 * Lexer Module - Enforce Script Language Server
 * ==============================================
 * 
 * Tokenizes Enforce Script source code into a stream of tokens for the parser.
 * 
 * TOKEN FLOW:
 *   Source Code → [lexer.ts] → Token[] → [parser.ts] → AST
 * 
 * ENFORCE SCRIPT SPECIFICS:
 *   - C-like syntax but NOT C++ (no templates, different semantics)
 *   - Uses 'modded class' for runtime class modification (unique to DayZ)
 *   - Uses 'ref', 'autoptr' for reference counting
 *   - Uses 'proto', 'native' for engine bindings
 * 
 * KNOWN ISSUES & FIXES:
 * 
 * 1. MULTI-CHARACTER OPERATORS (FIXED)
 *    Problem: The original lexer didn't handle multi-char operators like
 *    '==', '!=', '<=', '>=', '&&', '||', '++', '--', '+=', etc.
 *    These would be tokenized as two separate single-char operators.
 *    
 *    Solution: Check for two-character operator sequences BEFORE
 *    single punctuation/operator handling.
 * 
 * 2. LESS-THAN vs GENERIC BRACKET AMBIGUITY
 *    Problem: '<' can be either:
 *      - A comparison operator: if (x < 10)
 *      - A generic type bracket: array<string>
 *    
 *    Solution: The PARSER (not lexer) handles this contextually.
 *    The lexer emits '<' as punctuation; the parser decides based on
 *    whether it follows a type identifier.
 * 
 * 3. RIGHT-SHIFT vs NESTED GENERIC CLOSING
 *    Problem: '>>' can be either:
 *      - Right shift operator: x >> 2
 *      - Two generic closing brackets: map<string, array<int>>
 *    
 *    Solution: The PARSER handles this by splitting '>>' when inside
 *    generic type parsing context. See parser.ts parseType().
 * 
 * @module enscript/server/src/analysis/lexer/lexer
 */

import { Token, TokenKind } from './token';
import { keywords, punct, multiCharOps } from './rules';

export function lex(text: string, defines?: Set<string>): Token[] {
    const toks: Token[] = [];
    let i = 0;

    const push = (kind: TokenKind, value: string, start: number) => {
        toks.push({ kind, value, start, end: i });
    };

    while (i < text.length) {
        const ch = text[i];
        const start = i;

        // whitespace
        if (/\s/.test(ch)) {
            i++;
            continue;
        }

        // single line comment
        if (ch === '/' && i + 1 < text.length && text[i + 1] === '/') {
            i += 2; // skip “//”
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
            push(TokenKind.Comment, text.slice(start, i), start);
            continue;
        }

        // multi line comment
        if (ch === '/' && i + 1 < text.length && text[i + 1] === '*') {
            i += 2; // skip /*
            while (
                i + 1 < text.length &&
                !(text[i] === '*' && text[i + 1] === '/')
            ) {
                i++;
            }
            i += 2; // skip closing */
            push(TokenKind.Comment, text.slice(start, i), start);
            continue;
        }

        // pre-processor (#define, #ifdef, #else, #endif, etc.)
        // Strategy for #ifdef/#else/#endif:
        //   - By default: skip the #ifdef/#ifndef branch, process the #else branch
        //   - If the symbol is in the `defines` set: process the #ifdef branch, skip #else
        //   - For #ifndef: inverted logic (process if NOT defined)
        //   - User can configure which defines are active via settings
        //   - Handles nested #ifdef by tracking depth
        if (ch === '#') {
            const lineStart = i;
            while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
            const directive = text.slice(lineStart, i).trim();
            
            // Check if this is #ifdef or #ifndef
            const ifdefMatch = directive.match(/^#\s*(ifdef|ifndef)\s+(\w+)/);
            if (ifdefMatch) {
                const isIfdef = ifdefMatch[1] === 'ifdef';
                const symbol = ifdefMatch[2];
                const isDefined = defines?.has(symbol) ?? false;
                // Process first branch if: (#ifdef and defined) or (#ifndef and NOT defined)
                const processFirstBranch = isIfdef ? isDefined : !isDefined;
                
                if (processFirstBranch) {
                    // Process the #ifdef/#ifndef branch — just emit directive, continue lexing
                    push(TokenKind.Preproc, directive, lineStart);
                    // We'll handle #else (skip) and #endif (emit) when we encounter them
                    continue;
                } else {
                    // Skip the #ifdef/#ifndef branch until #else or #endif
                    let depth = 1;
                    
                    while (depth > 0 && i < text.length) {
                        while (i < text.length && text[i] !== '#') {
                            if (text[i] === '"') {
                                i++;
                                while (i < text.length && text[i] !== '"') {
                                    if (text[i] === '\\' && i + 1 < text.length) i++;
                                    i++;
                                }
                                if (i < text.length) i++;
                            } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
                                while (i < text.length && text[i] !== '\n') i++;
                            } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
                                i += 2;
                                while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                                i += 2;
                            } else {
                                i++;
                            }
                        }
                        
                        if (i >= text.length) break;
                        
                        const dStart = i;
                        while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
                        const d = text.slice(dStart, i).trim();
                        
                        if (d.match(/^#\s*(ifdef|ifndef)\b/)) {
                            depth++;
                        } else if (d.match(/^#\s*endif\b/)) {
                            depth--;
                        } else if (d.match(/^#\s*else\b/) && depth === 1) {
                            // Found #else at our level - stop skipping, process #else branch
                            depth = 0;
                        }
                    }
                    
                    push(TokenKind.Preproc, text.slice(lineStart, i), lineStart);
                    continue;
                }
            }
            
            // #else — we only reach here if we're PROCESSING the first branch
            // (otherwise the skip loop above would have consumed #else)
            // Now skip from #else until #endif
            if (directive.match(/^#\s*else\b/)) {
                const elseStart = lineStart;
                let depth = 1;
                
                while (depth > 0 && i < text.length) {
                    while (i < text.length && text[i] !== '#') {
                        if (text[i] === '"') {
                            i++;
                            while (i < text.length && text[i] !== '"') {
                                if (text[i] === '\\' && i + 1 < text.length) i++;
                                i++;
                            }
                            if (i < text.length) i++;
                        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '/') {
                            while (i < text.length && text[i] !== '\n') i++;
                        } else if (text[i] === '/' && i + 1 < text.length && text[i + 1] === '*') {
                            i += 2;
                            while (i + 1 < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
                            i += 2;
                        } else {
                            i++;
                        }
                    }
                    
                    if (i >= text.length) break;
                    
                    const dStart = i;
                    while (i < text.length && text[i] !== '\n' && text[i] !== '\r') i++;
                    const d = text.slice(dStart, i).trim();
                    
                    if (d.match(/^#\s*(ifdef|ifndef)\b/)) {
                        depth++;
                    } else if (d.match(/^#\s*endif\b/)) {
                        depth--;
                    }
                }
                
                push(TokenKind.Preproc, text.slice(elseStart, i), elseStart);
                continue;
            }
            
            // #endif — just emit as preproc token
            if (directive.match(/^#\s*endif\b/)) {
                push(TokenKind.Preproc, directive, lineStart);
                continue;
            }
            
            // For other preprocessor directives, just skip the line
            push(TokenKind.Preproc, directive, lineStart);
            continue;
        }

        // string literal "..."
        if (ch === '"') {
            i++;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && i + 1 < text.length) i += 2;
                else i++;
            }
            i++; // consume closing "
            push(TokenKind.String, text.slice(start, i), start);
            continue;
        }

        // ====================================================================
        // CHARACTER LITERAL '...' (PORTED FROM JS)
        // ====================================================================
        // Enforce Script supports single-quoted character literals like 'A', '\n'
        // These are tokenized as strings for simplicity.
        // ====================================================================
        if (ch === "'") {
            i++;
            while (i < text.length && text[i] !== "'") {
                if (text[i] === '\\' && i + 1 < text.length) {
                    i += 2; // Skip escaped character
                } else {
                    i++;
                }
            }
            i++; // Consume closing '
            push(TokenKind.String, text.slice(start, i), start);
            continue;
        }

        // ====================================================================
        // NUMBER LITERAL (PORTED FROM JS - More robust handling)
        // ====================================================================
        // Supports:
        //   - Decimal integers: 42, 123
        //   - Hex integers: 0x1A, 0xFF
        //   - Floats: 3.14, .5
        //   - Scientific notation: 1e10, 2.5E-3
        //   - Float suffix: 1.0f, 2.5F
        // ====================================================================
        if (/\d/.test(ch) || (ch === '.' && i + 1 < text.length && /\d/.test(text[i + 1]))) {
            // Handle hex: 0x... or 0X...
            if (ch === '0' && i + 1 < text.length && (text[i + 1] === 'x' || text[i + 1] === 'X')) {
                i += 2; // Skip '0x'
                while (i < text.length && /[0-9a-fA-F]/.test(text[i])) {
                    i++;
                }
            } else {
                // Decimal or float
                while (i < text.length && /[0-9.]/.test(text[i])) {
                    i++;
                }
                // Handle exponent: e+10, E-5
                if (i < text.length && (text[i] === 'e' || text[i] === 'E')) {
                    i++;
                    if (i < text.length && (text[i] === '+' || text[i] === '-')) {
                        i++;
                    }
                    while (i < text.length && /\d/.test(text[i])) {
                        i++;
                    }
                }
                // Handle float suffix: f or F
                if (i < text.length && (text[i] === 'f' || text[i] === 'F')) {
                    i++;
                }
            }
            push(TokenKind.Number, text.slice(start, i), start);
            continue;
        }

        // identifier / keyword
        if (/[_A-Za-z]/.test(ch)) {
            while (i < text.length && /[_0-9A-Za-z]/.test(text[i])) i++;
            const value = text.slice(start, i);
            const kind = keywords.has(value)
                ? TokenKind.Keyword
                : TokenKind.Identifier;
            push(kind, value, start);
            continue;
        }

        // ====================================================================
        // MULTI-CHARACTER OPERATORS (CRITICAL FIX!)
        // ====================================================================
        // Problem: Without this check, '==' becomes two '=' tokens, '&&' becomes
        // two '&' tokens, etc. This breaks all comparison and logical operators.
        //
        // Solution: Check for two-character operator sequences BEFORE checking
        // single punctuation. The order matters!
        //
        // Examples:
        //   if (x == 10)    → should tokenize '==' not '=' '='
        //   if (a && b)     → should tokenize '&&' not '&' '&'
        //   x += 5;         → should tokenize '+=' not '+' '='
        //   map<int, set<int>>  → '>>' handled specially by parser
        // ====================================================================
        if (i + 1 < text.length) {
            const twoChar = ch + text[i + 1];
            if (multiCharOps.has(twoChar)) {
                i += 2;
                push(TokenKind.Operator, twoChar, start);
                continue;
            }
        }

        // Single-character punctuation (must come AFTER multi-char check!)
        if (punct.includes(ch)) {
            i++;
            push(TokenKind.Punctuation, ch, start);
            continue;
        }

        // ====================================================================
        // SINGLE-CHARACTER OPERATORS (PORTED FROM JS)
        // ====================================================================
        // These are mathematical and logical operators that weren't covered
        // by multi-char ops or punctuation. Mark them explicitly as operators.
        // ====================================================================
        if ('+-*/%&|!^~<>='.includes(ch)) {
            i++;
            push(TokenKind.Operator, ch, start);
            continue;
        }

        // unknown char → treat as operator
        i++;
        push(TokenKind.Operator, ch, start);
    }

    push(TokenKind.EOF, '', i);
    return toks;
}
