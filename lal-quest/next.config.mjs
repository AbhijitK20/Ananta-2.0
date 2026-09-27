/** @type {import('next').Config} */
const config = {
  reactStrictMode: true,

  /**
   * Pinned to THIS app.
   *
   * The repo root is a workspace that has held several npm projects over its
   * life, and this app sits next to another Next project that has its own
   * lockfile. Left alone, Next walks up looking for a lockfile, finds a
   * neighbour's, and builds against the wrong root — which is how a build works
   * on one machine and fails on a deploy. Naming the root explicitly makes file
   * tracing independent of where the checkout happens to sit.
   *
   * `import.meta.dirname` rather than __dirname: this is an ESM module.
   */
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
