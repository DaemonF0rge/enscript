/**
 * Persistent AST Cache
 * ====================
 * 
 * Caches parsed ASTs to disk to dramatically speed up subsequent VS Code launches.
 * 
 * Strategy:
 * - Store AST + file modification time (mtime) in a JSON cache file
 * - On startup, check if file's mtime matches cached mtime
 * - If match: load AST from cache (fast)
 * - If mismatch or not in cache: parse file (slow) and update cache
 * 
 * Cache location: {workspaceRoot}/.vscode/.enscript-cache.json
 * 
 * Cache format:
 * {
 *   "version": 1,
 *   "entries": {
 *     "file:///path/to/file.c": {
 *       "mtime": 1234567890,
 *       "ast": { ... }
 *     }
 *   }
 * }
 */

import * as fs from 'fs';
import * as path from 'path';
import * as url from 'url';
import { File } from '../ast/parser';

const CACHE_VERSION = 1;
const CACHE_FILENAME = '.enscript-cache.json';

interface CacheEntry {
    mtime: number;
    ast: File;
}

interface CacheData {
    version: number;
    entries: Record<string, CacheEntry>;
}

export class ASTCache {
    private cacheDir: string;
    private cachePath: string;
    private cache: CacheData;
    private dirty = false;
    private enabled = true;

    constructor(workspaceRoot: string) {
        this.cacheDir = path.join(workspaceRoot, '.vscode');
        this.cachePath = path.join(this.cacheDir, CACHE_FILENAME);
        this.cache = { version: CACHE_VERSION, entries: {} };
        console.log(`AST cache path: ${this.cachePath}`);
        this.load();
    }

    /**
     * Disable cache (e.g., for testing or if issues arise)
     */
    disable(): void {
        this.enabled = false;
    }

    /**
     * Check if we have a valid cached AST for a file
     * @param filePath Absolute file path
     * @returns Cached AST if valid, null if needs re-parsing
     */
    get(filePath: string): File | null {
        if (!this.enabled) return null;
        
        try {
            const uri = this.pathToUri(filePath);
            const entry = this.cache.entries[uri];
            
            if (!entry) return null;
            
            // Check if file has been modified since caching
            const stats = fs.statSync(filePath);
            const currentMtime = stats.mtimeMs;
            
            if (entry.mtime === currentMtime) {
                return entry.ast;
            }
            
            // File modified, cache invalid
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Store a parsed AST in the cache
     * @param filePath Absolute file path
     * @param ast Parsed AST
     */
    set(filePath: string, ast: File): void {
        if (!this.enabled) return;
        
        try {
            const uri = this.pathToUri(filePath);
            const stats = fs.statSync(filePath);
            
            this.cache.entries[uri] = {
                mtime: stats.mtimeMs,
                ast: ast
            };
            this.dirty = true;
        } catch {
            // Ignore errors - cache is optional
        }
    }

    /**
     * Persist cache to disk
     * Call this after initial indexing or periodically
     */
    save(): void {
        if (!this.enabled || !this.dirty) return;
        
        try {
            // Ensure .vscode directory exists
            if (!fs.existsSync(this.cacheDir)) {
                fs.mkdirSync(this.cacheDir, { recursive: true });
            }
            
            // Write cache atomically (write to temp, then rename)
            const tempPath = this.cachePath + '.tmp';
            const data = JSON.stringify(this.cache);
            fs.writeFileSync(tempPath, data, 'utf8');
            fs.renameSync(tempPath, this.cachePath);
            
            this.dirty = false;
            console.log(`AST cache saved: ${Object.keys(this.cache.entries).length} entries`);
        } catch (err) {
            console.warn(`Failed to save AST cache: ${err}`);
        }
    }

    /**
     * Load cache from disk
     */
    private load(): void {
        try {
            if (!fs.existsSync(this.cachePath)) {
                return;
            }
            
            const data = fs.readFileSync(this.cachePath, 'utf8');
            const parsed = JSON.parse(data) as CacheData;
            
            // Version check - invalidate if cache format changed
            if (parsed.version !== CACHE_VERSION) {
                console.log(`AST cache version mismatch (${parsed.version} vs ${CACHE_VERSION}), clearing cache`);
                return;
            }
            
            this.cache = parsed;
            console.log(`AST cache loaded: ${Object.keys(this.cache.entries).length} entries`);
        } catch (err) {
            console.warn(`Failed to load AST cache: ${err}`);
            // Start fresh
            this.cache = { version: CACHE_VERSION, entries: {} };
        }
    }

    /**
     * Clear the cache completely
     */
    clear(): void {
        this.cache = { version: CACHE_VERSION, entries: {} };
        this.dirty = true;
        try {
            if (fs.existsSync(this.cachePath)) {
                fs.unlinkSync(this.cachePath);
            }
        } catch {
            // Ignore
        }
    }

    /**
     * Remove a specific file from cache (e.g., when deleted)
     */
    invalidate(filePath: string): void {
        const uri = this.pathToUri(filePath);
        if (this.cache.entries[uri]) {
            delete this.cache.entries[uri];
            this.dirty = true;
        }
    }

    /**
     * Get cache statistics
     */
    getStats(): { entries: number; cacheHits: number; cacheMisses: number } {
        return {
            entries: Object.keys(this.cache.entries).length,
            cacheHits: this.cacheHits,
            cacheMisses: this.cacheMisses
        };
    }

    private cacheHits = 0;
    private cacheMisses = 0;

    /**
     * Track cache hit for statistics
     */
    recordHit(): void {
        this.cacheHits++;
    }

    /**
     * Track cache miss for statistics
     */
    recordMiss(): void {
        this.cacheMisses++;
    }

    private pathToUri(filePath: string): string {
        // Use Node's url module for consistent URI generation
        // This matches what's used in index.ts: url.pathToFileURL(filePath).toString()
        return url.pathToFileURL(filePath).toString();
    }
}
