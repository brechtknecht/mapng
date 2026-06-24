#!/usr/bin/env node
// Zero-dependency file-size lint for the @mapng/* workspace (refactor doc 06).
// Fails when a packages/*/src file exceeds MAX_LOC, unless it is allow-listed in
// tools/lint-size-allow.json. The allowlist is a RATCHET: it starts with every
// current offender; each god-file decomposition deletes its entry, and the lint
// then guards that the file never grows back. Run: node tools/check-filesize.mjs
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MAX_LOC = 500;
const ROOT = new URL('../packages', import.meta.url).pathname;
const ALLOW = JSON.parse(
    readFileSync(new URL('./lint-size-allow.json', import.meta.url), 'utf8'),
);

const walk = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) out.push(...walk(p));
        else if (/\.(js|mjs)$/.test(name)) out.push(p);
    }
    return out;
};

let over = 0;
let staleAllow = 0;
const seen = new Set();
for (const pkg of readdirSync(ROOT)) {
    const srcDir = join(ROOT, pkg, 'src');
    let files;
    try { files = walk(srcDir); } catch { continue; }
    for (const file of files) {
        const rel = file.replace(ROOT + '/', 'packages/');
        const loc = readFileSync(file, 'utf8').split('\n').length;
        if (loc <= MAX_LOC) continue;
        seen.add(rel);
        if (ALLOW[rel]) continue;
        console.error(`✗ ${rel}: ${loc} LOC > ${MAX_LOC} (not allow-listed)`);
        over++;
    }
}

// Catch allowlist entries that are now under the cap or gone — keep the ratchet honest.
for (const rel of Object.keys(ALLOW)) {
    if (rel.startsWith('_')) continue; // meta keys (_doc)
    if (!seen.has(rel)) {
        console.error(`✗ stale allowlist entry: ${rel} is no longer >${MAX_LOC} LOC — remove it from lint-size-allow.json`);
        staleAllow++;
    }
}

if (over || staleAllow) {
    console.error(`\n${over} oversized file(s), ${staleAllow} stale allowlist entr(y/ies). Cap is ${MAX_LOC} LOC.`);
    process.exit(1);
}
const remaining = Object.keys(ALLOW).filter((k) => k !== '_doc').length;
console.log(`✓ file sizes OK (cap ${MAX_LOC} LOC; ${remaining} file(s) still allow-listed — ratchet down via docs/refactor/06)`);
