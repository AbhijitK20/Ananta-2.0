/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  /** Pin the workspace root to THIS app.
   *
   *  This app used to live at `research/lal-clone/` inside a larger repository
   *  that had its own npm project and its own lockfile one level up. Left alone,
   *  Next walked up, found the parent's lockfile, and warned:
   *
   *    We detected multiple lockfiles and selected the directory of
   *    <the parent project>/package-lock.json as the root directory.
   *
   *  That inference made the build depend on where the checkout happened to sit
   *  — the difference between a build that works on this machine and one that
   *  works on a deploy. It is now the only project in the repository, so the
   *  hazard is gone, but the setting is kept: it costs nothing, it is correct
   *  wherever the tree is cloned, and removing it would re-open the failure the
   *  first time anyone nests this app again.
   *
   *  `import.meta.dirname` rather than __dirname: this is an ESM module.
   */
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
