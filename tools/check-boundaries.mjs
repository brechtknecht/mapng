#!/usr/bin/env node
// Zero-dependency package boundary checker for the @mapng/* workspace.
// Enforces the dependency direction: a package may only import packages in its
// allowed set. Run: node tools/check-boundaries.mjs  (exit 1 on violation).
//
// Layering:  geo < fetching < bake < { route, batch }
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

const ALLOWED = {
    geo: new Set([]),
    fetching: new Set(['geo']),
    terrain: new Set(['geo', 'fetching']),
    bake: new Set(['geo', 'fetching', 'terrain']),
    export: new Set(['geo', 'fetching', 'terrain', 'bake']),
    route: new Set(['geo', 'fetching', 'terrain', 'bake', 'export']),
    batch: new Set(['geo', 'fetching', 'terrain', 'bake', 'export']),
    pipelines: new Set(['geo', 'fetching', 'terrain', 'bake', 'export', 'route', 'batch']),
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

// --- Intra-package layer rule (docs/refactor/06) --------------------------
// Files may declare `@layer core|io|flow`. A `core` file (pure: no DOM, no
// network, no renderer) must not import a sibling tagged `io` or `flow`. Files
// without a tag are legacy/unchecked, so this stays green until tags are added.
const LAYER_RE = /@layer\s+(core|io|flow)\b/;
const layerOf = new Map(); // absFile -> 'core'|'io'|'flow'
for (const pkg of Object.keys(ALLOWED)) {
    const srcDir = join(ROOT, pkg, 'src');
    let files;
    try { files = walk(srcDir); } catch { continue; }
    for (const file of files) {
        const m = readFileSync(file, 'utf8').match(LAYER_RE);
        if (m) layerOf.set(file, m[1]);
    }
}
const REL_IMPORT_RE = /from\s+['"](\.[^'"]+)['"]/g;
for (const [file, layer] of layerOf) {
    if (layer !== 'core') continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(REL_IMPORT_RE)) {
        const target = resolve(dirname(file), m[1]);
        const dep = layerOf.get(target);
        if (dep === 'io' || dep === 'flow') {
            console.error(`✗ core file imports @layer ${dep}: ${file.replace(ROOT, 'packages')} → ${m[1]}`);
            violations++;
        }
    }
}

if (violations) {
    console.error(`\n${violations} boundary violation(s).`);
    process.exit(1);
}
console.log('✓ package boundaries OK (geo < fetching < terrain < bake < export < {route, batch} < pipelines; core ↛ io/flow)');
