import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import path from 'node:path';

import alias from '@rollup/plugin-alias';
import commonjs from '@rollup/plugin-commonjs';
import json from '@rollup/plugin-json';
import nodeResolve from '@rollup/plugin-node-resolve';
import replace from '@rollup/plugin-replace';
import terser from '@rollup/plugin-terser';
import typescript from '@rollup/plugin-typescript';
import copy from 'rollup-plugin-copy';

const require = createRequire(import.meta.url);
const pkg = require('./package.json');

// tfjs-tflite ships a broken `module` entry. Same workaround the uww.js
// demo uses: alias to the FESM bundle that actually runs.
const tfliteFesm = fileURLToPath(
  new URL(
    './node_modules/@tensorflow/tfjs-tflite/dist/tf-tflite.fesm.js',
    import.meta.url,
  ),
);

const tfliteVersion = require('@tensorflow/tfjs-tflite/package.json').version;

const tfliteWasmDir = path.dirname(
  require.resolve('@tensorflow/tfjs-tflite/package.json'),
);

const isProd = !process.env.ROLLUP_WATCH;

// The tfjs-tflite FESM unconditionally fires
//   EmscriptenModuleLoader.getInstance("","tflite_web_api",...).load(!0)
// at module-import time with a hard-coded empty wasm path. That probe
// resolves against the current page URL — which on a Lovelace dashboard
// is an HTML SPA route, so the browser yells "Refused to execute script
// from … because its MIME type ('text/html') is not executable".
//
// We rewrite the literal so the path is read from a global we seed via
// the banner below using `import.meta.url`.
const TFLITE_PROBE_NEEDLE = 'getInstance("","tflite_web_api"';
const TFLITE_PROBE_REPLACEMENT =
  'getInstance((globalThis.__uwwTfliteWasmBase||""),"tflite_web_api"';

export default {
  input: 'src/index.ts',
  output: {
    file: 'dist/ha-uww-assist-card.js',
    format: 'es',
    sourcemap: true,
    inlineDynamicImports: true,
    // Runs once at module load, before tfjs-tflite's import-time probe.
    banner:
      'globalThis.__uwwTfliteWasmBase=globalThis.__uwwTfliteWasmBase||' +
      'new URL("./wasm/",import.meta.url).toString();',
  },
  plugins: [
    replace({
      preventAssignment: true,
      delimiters: ['', ''],
      values: {
        __HA_UWW_VERSION__: JSON.stringify(pkg.version),
        __TFJS_TFLITE_VERSION__: JSON.stringify(tfliteVersion),
        [TFLITE_PROBE_NEEDLE]: TFLITE_PROBE_REPLACEMENT,
      },
    }),
    alias({
      entries: [
        { find: '@tensorflow/tfjs-tflite', replacement: tfliteFesm },
      ],
    }),
    nodeResolve({ browser: true, preferBuiltins: false }),
    commonjs(),
    json(),
    typescript({ tsconfig: './tsconfig.json' }),
    copy({
      targets: [
        { src: path.join(tfliteWasmDir, 'wasm/*'), dest: 'dist/wasm' },
      ],
      hook: 'writeBundle',
    }),
    isProd && terser({ format: { comments: false } }),
  ].filter(Boolean),
  // Surface only the noisy warnings we actually care about.
  onwarn(warning, warn) {
    if (warning.code === 'CIRCULAR_DEPENDENCY') return;
    if (warning.code === 'THIS_IS_UNDEFINED') return;
    warn(warning);
  },
};

