import { createRequire } from "node:module";
import path from "node:path";
import { build, type Plugin } from "esbuild";

/**
 * Loads a React component module the way the server sees it, for tests that assert on server-rendered markup.
 *
 * The repo's vitest config compiles `.ts` only — tsconfig keeps `jsx: "preserve"` for Next — so a test cannot
 * import a `.tsx` component directly. Instead esbuild bundles the project-side files behind one entry (JSX
 * compiled, `@/` resolved), leaves every package external, and the bundle is evaluated as CommonJS against the
 * real node_modules. Modules named in `stubs` are swapped for the given objects: server actions, which only
 * matter from event handlers, and `next/navigation`, whose hooks need the app router.
 *
 * Stub keys are bare specifiers (`next/navigation`) or project paths relative to the repo root, without an
 * extension (`src/app/(app)/settings/account-actions`).
 */

const root = path.resolve(import.meta.dirname, "../..");
const nodeRequire = createRequire(path.join(root, "package.json"));

/** Marks a path this plugin already resolved, so handing it back to esbuild's resolver does not loop. */
const RESOLVED = { resolved: true };

function stripExtension(file: string): string {
  return file.replace(/\.(tsx?|jsx?|mjs|cjs)$/, "");
}

export async function loadForSsr<T = Record<string, unknown>>(entry: string, stubs: Record<string, unknown> = {}): Promise<T> {
  const projectStubs = new Map<string, string>();
  for (const key of Object.keys(stubs)) {
    if (key.startsWith("src/")) projectStubs.set(path.join(root, key), key);
  }
  const stubFor = (absolute: string): string | undefined => projectStubs.get(stripExtension(absolute));

  const projectFiles: Plugin = {
    name: "project-files",
    setup(b) {
      // `@/x` → `src/x`, then let esbuild pick the extension.
      b.onResolve({ filter: /^@\// }, (args) => {
        if (args.pluginData === RESOLVED) return null;
        const target = path.join(root, "src", args.path.slice(2));
        const stub = stubFor(target);
        if (stub) return { path: stub, external: true };
        return b.resolve(target, { resolveDir: args.resolveDir, kind: args.kind, pluginData: RESOLVED });
      });
      b.onResolve({ filter: /^\.\.?\// }, (args) => {
        const stub = stubFor(path.resolve(args.resolveDir, args.path));
        return stub ? { path: stub, external: true } : null;
      });
    },
  };

  const result = await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    packages: "external",
    jsx: "automatic",
    tsconfigRaw: { compilerOptions: { jsx: "react-jsx" } },
    plugins: [projectFiles],
    logLevel: "silent",
  });
  const code = result.outputFiles[0]?.text;
  if (!code) throw new Error(`esbuild produced no output for ${entry}`);

  const requireWithStubs = (id: string) => (Object.hasOwn(stubs, id) ? stubs[id] : nodeRequire(id));
  const cjsModule = { exports: {} as T };
  new Function("require", "module", "exports", code)(requireWithStubs, cjsModule, cjsModule.exports);
  return cjsModule.exports;
}
