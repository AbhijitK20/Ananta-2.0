/**
 * Copy Cesium's runtime assets into public/cesium.
 *
 * Cesium loads four directories at runtime by URL -- Workers (the geometry/
 * raster pipeline), Assets (textures, the sky, the wind), ThirdParty (zip.js,
 * Draco) and Widgets (the CSS the Viewer injects). None of it is bundled: the
 * npm package ships them as files and the library is told where to find them
 * via window.CESIUM_BASE_URL. So something has to put them somewhere the
 * browser can actually fetch, and on a static host that means public/.
 *
 * Idempotent on purpose. This runs from predev and prebuild, and re-copying
 * ~8MB on every dev start is a waste of everyone's time, so it compares the
 * installed Cesium version against a stamp file and exits early on a match.
 * Delete public/cesium or the stamp to force a refresh.
 */
import { cp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";

const DIRS = ["Assets", "Workers", "ThirdParty", "Widgets"];
const SRC = path.join("node_modules", "cesium", "Build", "Cesium");
const DEST = path.join("public", "cesium");
const STAMP = path.join(DEST, ".version");

const { version } = JSON.parse(
  await readFile(path.join("node_modules", "cesium", "package.json"), "utf8"),
);

if (existsSync(STAMP) && (await readFile(STAMP, "utf8")).trim() === version) {
  console.log(`cesium assets: v${version} already in public/cesium, skipping`);
  process.exit(0);
}

if (!existsSync(SRC)) {
  console.error(
    `Cannot find ${SRC}. Cesium is not installed -- run \`npm install cesium\`.`,
  );
  process.exit(1);
}

await rm(DEST, { recursive: true, force: true });
await mkdir(DEST, { recursive: true });


for (const dir of DIRS) {
  const from = path.join(SRC, dir);
  if (!existsSync(from)) {
    console.error(`  missing ${dir}/ in the cesium build -- aborting`);
    process.exit(1);
  }
  await cp(from, path.join(DEST, dir), { recursive: true });
}

/* The library itself is bundled here, by esbuild, into a static ESM file.
 *
 * It cannot simply be imported. Cesium's ESM entry is a 72KB re-export shim
 * over @cesium/engine and @cesium/widgets, and letting webpack bundle it
 * produces a chunk no browser will parse in production: the minifier rewrites
 * one string into a template literal and drops an escaped backslash, turning
 * "\\5" into \5. Cesium embeds WebAssembly for its Draco decoders and the
 * offending bytes are in there; the shipped build parses fine on its own, so
 * it is the minifier at fault, not Cesium.
 *
 * Bundling it here means webpack never sees it. esbuild is correct on this
 * construct, and the result is native-import()ed by WorldGlobe at runtime:
 * ~1.3MB gzipped, fetched once, cached after.
 */
const { build } = await import("esbuild");
await build({
  entryPoints: [path.join("node_modules", "cesium", "Source", "Cesium.js")],
  bundle: true,
  format: "esm",
  minify: true,
  target: ["es2022"],
  outfile: path.join(DEST, "cesium.mjs"),
  legalComments: "none",
  logLevel: "warning",
});

await writeFile(STAMP, version);
console.log(`cesium assets: copied v${version} (${DIRS.join(", ")}) + bundled cesium.mjs into public/cesium`);
