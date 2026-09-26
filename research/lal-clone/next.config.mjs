/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,

  /** Pin the workspace root to THIS app.
   *
   *  This project lives inside the TravelBuddy repository, which is a separate
   *  npm project with its own lockfile. Left alone, Next infers the workspace
   *  root by walking up, finds the parent's lockfile, and warns:
   *
   *    We detected multiple lockfiles and selected the directory of
   *    /home/abhijitk20/Travel_buddy/package-lock.json as the root directory.
   *
   *  That inference is what made the app build against the parent's setup --
   *  see postcss.config.mjs, which exists only to stop the parent's Tailwind
   *  PostCSS config from being picked up. Setting the root explicitly means
   *  file tracing and the inferred root stop depending on where the checkout
   *  happens to sit, which is the difference between a build that works on this
   *  machine and one that works on a deploy.
   *
   *  `import.meta.dirname` rather than __dirname: this is an ESM module.
   */
  outputFileTracingRoot: import.meta.dirname,
};

export default config;
