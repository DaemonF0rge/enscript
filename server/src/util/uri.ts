import { URI } from 'vscode-uri';

export function normalizeUri(uri: string): string {
    const normalized = URI.parse(uri).toString();
    // On Windows, file paths are case-insensitive.  Lowercase the entire URI
    // for file:// URIs with a drive letter (e.g. file:///c%3A/...) so the same
    // physical file always maps to the same cache key regardless of path casing
    // differences between the workspace scanner and the editor's document URIs.
    if (/^file:\/\/\/[a-z]%3A/i.test(normalized)) {
        return normalized.toLowerCase();
    }
    return normalized;
}