import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { templateCompilerOptions } from '@tresjs/core';
import { execSync } from 'child_process';
import blenderDaePlugin from './scripts/viteBlenderDaePlugin.mjs';
import googleBakePlugin from './scripts/viteGoogleBakePlugin.mjs';
import zipExportPlugin from './scripts/viteZipExportPlugin.mjs';

const commitHash = (() => {
  try {
    return execSync('git rev-parse --short HEAD').toString().trim();
  } catch {
    return process.env.CF_PAGES_COMMIT_SHA?.slice(0, 7) || 'dev';
  }
})();

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    vue({
      ...templateCompilerOptions
    }),
    // POST /api/convert-dae: GLB → BeamNG .dae via headless Blender, so the
    // BeamNG export can bundle the final google_tiles.dae automatically.
    blenderDaePlugin(),
    // /api/google-bake/*: Google 3D Tiles bake sidecar — runs heavy bakes in
    // a Node child process with a multi-GB heap instead of the 4 GB-capped
    // browser tab. The browser falls back to the in-tab bake when absent.
    googleBakePlugin(),
    // /api/zip-export/*: BeamNG ZIP-export sidecar — streams each archive entry
    // to Node and DEFLATEs it natively to a temp file, so large maps no longer
    // hang the renderer at compression. Falls back to in-browser JSZip when
    // absent (prod builds).
    zipExportPlugin()
  ],
  optimizeDeps: {
    exclude: ['geotiff'],
    include: ['laz-perf/lib/worker'],
  },
  css: {
    devSourcemap: false
  },
  build: {
    sourcemap: false,
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        manualChunks: {
          'three': ['three'],
          'leaflet': ['leaflet'],
          'geotiff': ['geotiff'],
          'proj4': ['proj4']
        }
      }
    }
  },
  define: {
    'process.env': {},
    '__BUILD_HASH__': JSON.stringify(commitHash),
    '__BUILD_TIME__': JSON.stringify(new Date().toISOString()),
  },
  server: {
    proxy: {
      '/api/gpxz': {
        target: 'https://api.gpxz.io',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/gpxz/, ''),
      },
      '/api/nominatim-osm': {
        target: 'https://nominatim.openstreetmap.org',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim-osm/, ''),
      },
      '/api/nominatim-geocode': {
        target: 'https://nominatim.geocoding.ai',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api\/nominatim-geocode/, ''),
      },
      '/api/kron86/': {
        target: 'https://mapy.geoportal.gov.pl',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/api\/kron86/, ''),
      },
      '/api/kron86-opendata': {
        target: 'https://opendata.geoportal.gov.pl',
        changeOrigin: true,
        followRedirects: true,
        rewrite: (path) => path.replace(/^\/api\/kron86-opendata/, ''),
      },
    },
  },
});