import { createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, rename, utimes, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Disk cache for Google 3D Tiles content (GLBs), used by the bake worker —
// what makes bake-session rebuilds (dev-server restart), quality re-bakes
// and force re-bakes replay from LOCAL DISK instead of re-downloading
// thousands of tiles.
//
// ⚠️ KEYING: Google's GLB urls are NOT stable — the `/files/<blob>.glb` path
// is an opaque per-session token; the same tile gets a fresh URL every
// session (verified empirically: two sessions over the same AOI shared 0 of
// ~9.5k paths). The cache therefore keys on the tile's GEOMETRIC identity
// instead: dataset id + bounding-box (ECEF, cm-rounded) + geometricError,
// which the tileset reproduces bit-identically across sessions. The mapping
// URI-path → geometric key is recorded in requestTileContents (the only
// place the tile object and its content URI meet) and consumed by the
// fetchData wrapper. If Google ships new imagery under a new dataset id the
// keys roll over naturally; same-dataset content updates age out via LRU.
//
// ⚠️ This stores Google-derived content on disk. Personal/dev use only —
// same fork-only scope as the IndexedDB bake cache (see docs).
//
// Layout: node_modules/.cache/mapng-google-tiles/<sha256[:32]>.glb, LRU by
// file mtime (touched on hit), pruned to MAPNG_TILE_CACHE_MB (default 8 GB)
// at worker startup.

const CACHE_DIR = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../node_modules/.cache/mapng-google-tiles',
);

const maxCacheBytes = () => {
  const env = Number(process.env.MAPNG_TILE_CACHE_MB);
  return (Number.isFinite(env) && env > 0 ? env : 8192) * 1024 * 1024;
};

export class TileDiskCache {
  constructor() {
    mkdirSync(CACHE_DIR, { recursive: true });
    this.hits = 0;
    this.misses = 0;
    this.unkeyed = 0;
    this.hitBytes = 0;
    /** URI pathname → cache file, registered per requested tile. */
    this.pathToFile = new Map();
  }

  /** Stable cross-session cache file for a tile, or null. */
  fileForTile(tile, pathname) {
    const box = tile.boundingVolume?.box;
    if (!Array.isArray(box) || box.length !== 12) return null;
    const dataset = pathname.match(/\/datasets\/([^/]+)\//)?.[1] ?? '';
    const identity =
      `${dataset}|${box.map((v) => v.toFixed(2)).join(',')}|${(tile.geometricError ?? 0).toFixed(3)}`;
    const hash = createHash('sha256').update(identity).digest('hex').slice(0, 32);
    return path.join(CACHE_DIR, `${hash}.glb`);
  }

  /**
   * Hook the renderer: requestTileContents is where the tile object and its
   * (absolute, session-tokened) content URI meet — record the pathname →
   * geometric-key mapping for the fetchData wrapper to consume.
   */
  attach(tiles) {
    const orig = tiles.requestTileContents.bind(tiles);
    tiles.requestTileContents = (tile) => {
      try {
        const pathname = new URL(tile.content.uri, 'https://tile.googleapis.com').pathname;
        if (pathname.endsWith('.glb')) {
          const file = this.fileForTile(tile, pathname);
          if (file) this.pathToFile.set(pathname, file);
        }
      } catch { /* unkeyable — fetch passes through */ }
      return orig(tile);
    };
  }

  /**
   * Wrap a tiles plugin's fetchData (the GoogleCloudAuthPlugin — first in
   * the chain, sees every download incl. tile content) with the cache.
   */
  wrapPlugin(plugin) {
    const orig = plugin.fetchData.bind(plugin);
    plugin.fetchData = async (uri, options) => {
      let pathname = null;
      try { pathname = new URL(String(uri)).pathname; } catch { /* noop */ }
      if (!pathname?.endsWith('.glb')) return orig(uri, options);

      const file = this.pathToFile.get(pathname);
      this.pathToFile.delete(pathname);
      if (!file) {
        this.unkeyed++;
        return orig(uri, options);
      }

      const cached = await this.get(file);
      if (cached) {
        this.hits++;
        this.hitBytes += cached.byteLength;
        return new Response(cached, { status: 200 });
      }

      const res = await orig(uri, options);
      if (!res.ok) return res;
      // The body is consumable once — buffer it, persist in the background,
      // hand the library a replacement Response.
      const buf = Buffer.from(await res.arrayBuffer());
      this.misses++;
      this.put(file, buf).catch(() => {});
      return new Response(buf, { status: 200, headers: res.headers });
    };
  }

  async get(file) {
    try {
      const buf = await readFile(file);
      // Touch for LRU recency; fire-and-forget.
      const now = new Date();
      utimes(file, now, now).catch(() => {});
      return buf;
    } catch {
      return null;
    }
  }

  async put(file, buf) {
    if (buf.byteLength === 0) return;
    // Atomic-ish: write a tmp file, rename into place. A concurrent worker
    // writing the same content-keyed file is harmless — ignore races.
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await writeFile(tmp, buf);
      await rename(tmp, file);
    } catch {
      await unlink(tmp).catch(() => {});
    }
  }

  /** Delete oldest entries beyond the byte cap. Returns cache stats. */
  async prune() {
    let entries = [];
    try {
      const names = await readdir(CACHE_DIR);
      entries = (await Promise.all(names.map(async (name) => {
        const file = path.join(CACHE_DIR, name);
        try {
          const s = await stat(file);
          return s.isFile() ? { file, size: s.size, mtimeMs: s.mtimeMs, tmp: name.endsWith('.tmp') } : null;
        } catch { return null; }
      }))).filter(Boolean);
    } catch {
      return { files: 0, bytes: 0, pruned: 0 };
    }

    // Leftover tmp files from crashed workers age out after a day.
    const dayAgo = Date.now() - 24 * 3600 * 1000;
    for (const e of entries.filter((e) => e.tmp && e.mtimeMs < dayAgo)) {
      await unlink(e.file).catch(() => {});
    }
    entries = entries.filter((e) => !e.tmp);

    entries.sort((a, b) => b.mtimeMs - a.mtimeMs); // newest first
    const cap = maxCacheBytes();
    let bytes = 0;
    let pruned = 0;
    for (const e of entries) {
      bytes += e.size;
      if (bytes > cap) {
        await unlink(e.file).catch(() => {});
        bytes -= e.size;
        pruned++;
      }
    }
    return { files: entries.length - pruned, bytes, pruned };
  }

  stats() {
    return {
      hits: this.hits,
      misses: this.misses,
      unkeyed: this.unkeyed,
      hitMB: Math.round(this.hitBytes / 1024 ** 2),
    };
  }
}
