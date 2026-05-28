/**
 * `test` shell command. Discovers `*.test.{js,ts}` files via a glob
 * (default `**\/*.test.{js,ts}`), TS-transpiles each through the
 * `getTypeScript()` singleton shared with `tsc`, then runs every
 * file in its own isolated realm via `executeJsCode` — same path
 * as `node`, so SIGKILL and per-file isolation come for free.
 *
 * The runner is `tst` (https://github.com/dy/tst — 0 deps, ESM
 * native). The browser-side realm can't `import('tst')` directly
 * (the AsyncFunction body is parsed as a script, not a module),
 * so the small `tst.js` + `assert.js` sources are bundled via
 * `?raw`, transpiled to CJS once per process, and stitched into
 * each test file's runner script as IIFEs. User imports of `tst`
 * are rewired to that inline module via a per-file `__tstReq`
 * shim — that also keeps the realm's `require()` pre-fetch from
 * firing an esm.sh round-trip for the tst specifier.
 *
 * Reporters map to tst's built-in formats: `tap` (default) →
 * tst `tap`, `--reporter=spec` → tst `pretty`.
 */

import { defineCommand } from 'just-bash';
import type { Command, CommandContext } from 'just-bash';
import { getTypeScript, type TypeScriptModule } from './shared.js';
import { executeJsCode } from '../jsh-executor.js';
import tstSource from 'tst/tst.js?raw';
import assertSource from 'tst/assert.js?raw';

const HELP_TEXT = `test - run *.test.{js,ts} files with the bundled tst runner

Usage:
  test [options] [glob...]

Options:
  --reporter=<name>     tap (default) | spec
  -h, --help            Show this help

Notes:
  - Default glob: **/*.test.{js,ts}, walked from the current cwd.
  - .ts files are transpiled via the bundled typescript package.
  - Each file runs in its own realm (same engine as 'node').
`;

const DEFAULT_GLOBS = ['**/*.test.{js,ts}'];

export interface ParsedTestArgs {
  globs: string[];
  reporter: 'tap' | 'spec';
  showHelp: boolean;
}

export function parseTestArgs(args: string[]): ParsedTestArgs {
  const globs: string[] = [];
  let reporter: 'tap' | 'spec' = 'tap';
  let showHelp = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '-h' || arg === '--help') {
      showHelp = true;
      continue;
    }
    if (arg === '--reporter') {
      const v = args[i + 1];
      if (v !== 'tap' && v !== 'spec') {
        throw new Error('test: --reporter must be tap or spec');
      }
      reporter = v;
      i += 1;
      continue;
    }
    if (arg.startsWith('--reporter=')) {
      const v = arg.slice('--reporter='.length);
      if (v !== 'tap' && v !== 'spec') {
        throw new Error('test: --reporter must be tap or spec');
      }
      reporter = v;
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`test: unknown option: ${arg}`);
    }
    globs.push(arg);
  }
  return {
    globs: globs.length > 0 ? globs : [...DEFAULT_GLOBS],
    reporter,
    showHelp,
  };
}

/** Expand `{a,b,c}` brace groups left-to-right; one level deep is enough for our defaults. */
export function expandBraces(pattern: string): string[] {
  const idx = pattern.indexOf('{');
  if (idx === -1) return [pattern];
  const end = pattern.indexOf('}', idx);
  if (end === -1) return [pattern];
  const head = pattern.slice(0, idx);
  const tail = pattern.slice(end + 1);
  const parts = pattern.slice(idx + 1, end).split(',');
  const out: string[] = [];
  for (const p of parts) {
    for (const sub of expandBraces(`${head}${p}${tail}`)) out.push(sub);
  }
  return out;
}

/** Minimal glob → RegExp: `**` matches across path segments, `*` within one. */
export function globToRegExp(pattern: string): RegExp {
  let re = '';
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '*' && pattern[i + 1] === '*') {
      re += '(?:.*/)?';
      i += 2;
      if (pattern[i] === '/') i += 1;
    } else if (ch === '*') {
      re += '[^/]*';
      i += 1;
    } else if (ch === '?') {
      re += '[^/]';
      i += 1;
    } else if ('.+^$()[]|\\'.includes(ch)) {
      re += `\\${ch}`;
      i += 1;
    } else {
      re += ch;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/**
 * Recursively collect files under `cwd` matching any of the given
 * (brace-expanded) glob patterns. Skips `node_modules` and dot-dirs
 * — vitest's default scan does the same, and the test command's
 * realm path can't usefully introspect those anyway.
 */
export async function resolveTestFiles(
  fs: CommandContext['fs'],
  cwd: string,
  globs: string[]
): Promise<string[]> {
  const patterns = globs.flatMap(expandBraces).map(globToRegExp);
  const matches = new Set<string>();
  const prefix = cwd === '/' ? '' : cwd;
  async function walk(dir: string): Promise<void> {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === 'node_modules' || name.startsWith('.')) continue;
      const path = dir === '/' ? `/${name}` : `${dir}/${name}`;
      let isDir = false;
      try {
        const st = await fs.stat(path);
        isDir = st.isDirectory;
      } catch {
        continue;
      }
      if (isDir) {
        await walk(path);
        continue;
      }
      const rel = path.startsWith(`${prefix}/`) ? path.slice(prefix.length + 1) : path;
      if (patterns.some((re) => re.test(rel))) matches.add(path);
    }
  }
  await walk(cwd);
  return [...matches].sort();
}

// ---------------------------------------------------------------------------
// tst harness preparation
// ---------------------------------------------------------------------------

let preparedHarness: string | null = null;

/**
 * Transpile the bundled `tst.js` + `assert.js` to CJS once and stitch
 * them into a self-contained source fragment that exposes
 * `__tst_module_exports` / `__tst_assert_exports` / `__tst` as locals.
 *
 * Several string-level fixups are needed AFTER `transpileModule`:
 *   - `require('./assert.js')` is rewired to the inlined assert
 *     exports object so the IIFE doesn't need a real `require()`.
 *   - `import.meta` is replaced with a stub literal. It only appears
 *     in `runForked` (worker_threads / Web Worker bootstrap) which
 *     the realm can't run anyway, but the bare `import.meta` token
 *     is a SyntaxError inside an AsyncFunction body.
 *   - `await import('worker_threads' | 'fs' | 'path')` in that same
 *     fork helper is stubbed to an immediate rejection so it never
 *     hits the realm's dynamic-import path.
 */
async function prepareTstHarness(ts: TypeScriptModule): Promise<string> {
  if (preparedHarness) return preparedHarness;
  const opts = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    esModuleInterop: true,
    isolatedModules: false,
  } as import('typescript').CompilerOptions;
  const assertCjs = ts.transpileModule(assertSource, {
    compilerOptions: opts,
    fileName: 'assert.js',
  }).outputText;
  const tstCjsRaw = ts.transpileModule(tstSource, {
    compilerOptions: opts,
    fileName: 'tst.js',
  }).outputText;
  const tstCjs = tstCjsRaw
    .replace(/require\(["']\.\/assert\.js["']\)/g, '__tst_assert_exports')
    .replace(/\bimport\.meta\b/g, '({url:""})')
    .replace(
      /await\s+import\(['"](?:worker_threads|fs|path)['"]\)/g,
      'await Promise.reject(new Error("test: fork mode is not supported in the realm"))'
    );
  // tst branches on `isNode = typeof process !== 'undefined' && process.versions?.node`
  // to pick between Node-style console output (TAP / pretty) and the
  // browser's `console.group` path. The realm's `processShim` omits
  // `versions`, so tst would otherwise fall into the browser path and
  // call `console.group` — which the realm doesn't shim. Force the Node
  // branch by injecting `process.versions.node` before loading tst.
  preparedHarness = `
if (typeof process !== 'undefined' && !process.versions) {
  try { process.versions = { node: '20.0.0' }; } catch (_) { /* readonly process.versions is fine */ }
}
const __tst_assert_exports = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  ${assertCjs}
  return module.exports;
})();
const __tst_module_exports = (function () {
  const module = { exports: {} };
  const exports = module.exports;
  ${tstCjs}
  return module.exports;
})();
const __tst = __tst_module_exports.default || __tst_module_exports;
__tst.manual = true;
`.trim();
  return preparedHarness;
}

/**
 * Rewrite literal `require("tst")` / `require('tst/assert')` calls
 * produced by the TS CJS emit so the realm's `extractRequireSpecifiers`
 * regex skips them — otherwise the pre-fetch path would try to load
 * `tst` from esm.sh (slow in production, network-dependent in tests).
 */
function rewireUserRequires(source: string): string {
  return source
    .replace(/require\(["']tst["']\)/g, '__tstReq("tst")')
    .replace(/require\(["']tst\/tst\.js["']\)/g, '__tstReq("tst")')
    .replace(/require\(["']tst\/assert(?:\.js)?["']\)/g, '__tstReq("tst/assert")');
}

function buildRunnerScript(harness: string, userCjs: string, reporter: 'tap' | 'spec'): string {
  const format = reporter === 'spec' ? 'pretty' : 'tap';
  const rewired = rewireUserRequires(userCjs);
  return `"use strict";
${harness}
const __tstReq = (id) => {
  if (id === "tst") return __tst_module_exports;
  if (id === "tst/assert") return __tst_assert_exports;
  throw new Error("test: cannot require " + id);
};
await (async function (require) {
${rewired}
})(__tstReq);
const __state = await __tst.run({ format: ${JSON.stringify(format)} });
if (__state.failed && __state.failed.length > 0) process.exit(1);
`;
}

/** Test-only: drop the cached harness so each unit-test run re-builds it. */
export function _resetTstHarnessForTests(): void {
  preparedHarness = null;
}

export function createTestCommand(): Command {
  return defineCommand('test', async (args, ctx) => {
    let parsed: ParsedTestArgs;
    try {
      parsed = parseTestArgs(args);
    } catch (err) {
      return {
        stdout: '',
        stderr: `${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 2,
      };
    }
    if (parsed.showHelp) return { stdout: HELP_TEXT, stderr: '', exitCode: 0 };

    const files = await resolveTestFiles(ctx.fs, ctx.cwd, parsed.globs);
    if (files.length === 0) {
      return {
        stdout: '',
        stderr: `test: no test files matched ${parsed.globs.join(' ')}\n`,
        exitCode: 1,
      };
    }

    let ts: TypeScriptModule;
    try {
      ts = await getTypeScript();
    } catch (err) {
      return {
        stdout: '',
        stderr: `test: failed to load typescript: ${err instanceof Error ? err.message : String(err)}\n`,
        exitCode: 1,
      };
    }
    const harness = await prepareTstHarness(ts);
    const userOpts = {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      allowJs: true,
      isolatedModules: false,
    } as import('typescript').CompilerOptions;

    let stdout = '';
    let stderr = '';
    let anyFailed = false;

    for (const file of files) {
      let source: string;
      try {
        source = await ctx.fs.readFile(file);
      } catch (err) {
        stderr += `test: ${file}: ${err instanceof Error ? err.message : String(err)}\n`;
        anyFailed = true;
        continue;
      }
      let userCjs: string;
      try {
        userCjs = ts.transpileModule(source, {
          compilerOptions: userOpts,
          fileName: file,
        }).outputText;
      } catch (err) {
        stderr += `test: ${file}: transpile error: ${err instanceof Error ? err.message : String(err)}\n`;
        anyFailed = true;
        continue;
      }
      const runner = buildRunnerScript(harness, userCjs, parsed.reporter);
      const result = await executeJsCode(runner, ['node', file], ctx, undefined, {
        filename: file,
      });
      if (files.length > 1) stdout += `# ${file}\n`;
      stdout += result.stdout;
      stderr += result.stderr;
      if (result.exitCode !== 0) anyFailed = true;
    }

    return { stdout, stderr, exitCode: anyFailed ? 1 : 0 };
  });
}
