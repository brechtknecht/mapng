#!/usr/bin/env node
// Zero-dependency package boundary checker for the @mapng/* workspace.
// Enforces the dependency direction: a package may only import packages in its
// allowed set. Run: node tools/check-boundaries.mjs  (exit 1 on violation).
//
// Layering:  geo < fetching < bake < { route, batch }
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ALLOWED = {
    geo: new Set([]),
    fetching: new Set(['geo']),
    bake: new Set(['geo', 'fetching']),
    route: new Set(['geo', 'fetching', 'bake']),
    batch: new Set(['geo', 'fetching', 'bake']),
};

const ROOT = new URL('../packages', import.meta.url).pathname;
const IMPORT_RE = /from\s+['"]@mapng\/([a-z]+)(?:\/[^'"]*)?['"]/g;

const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (/\.(js|mjs)$/.test(name)) out.push(p);
    }
    return out;
};

let violations = 0;
for (const pkg of Object.keys(ALLOWED)) {
    const srcDir = join(ROOT, pkg, 'src');
    let files;
    try { files = walk(srcDir); } catch { continue; }
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const m of text.matchAll(IMPORT_RE)) {
            const dep = m[1];
            if (dep === pkg) continue;
            if (!ALLOWED[pkg].has(dep)) {
                console.error(`✗ ${pkg} imports @mapng/${dep}  (${file.replace(ROOT, 'packages')})`);
                violations++;
            }
        }
        if (/from\s+['"]vue['"]|from\s+['"]\.\.?\/.*\.vue['"]/.test(text)) {
            console.error(`✗ ${pkg} imports Vue/.vue  (${file.replace(ROOT, 'packages')})`);
            violations++;
        }
    }
}

if (violations) {
    console.error(`\n${violations} boundary violation(s).`);
    process.exit(1);
}
console.log('✓ package boundaries OK (geo < fetching < bake < {route, batch})');
