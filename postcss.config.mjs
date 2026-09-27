/** PostCSS. Deliberately empty, and deliberately here.
 *
 *  This app has no Tailwind and no PostCSS steps. The file exists anyway
 *  because of a specific failure: with no config of its own, Next walks up
 *  the directory tree, finds a *different* project's postcss.config.mjs, and
 *  tries to load it — which named @tailwindcss/postcss.
 *
 *  That worked on the machine where the two projects sat side by side, because
 *  the parent's node_modules was one level up and the plugin resolved. It fails
 *  the moment the app is installed on its own, which is what a deploy does:
 *
 *      Error: Cannot find module '@tailwindcss/postcss'
 *
 *  The symptom pointed at CSS and at Tailwind; the cause was a config file
 *  belonging to another project a few directories away. That project has since
 *  been removed, so the hazard no longer exists — but an empty plugin map still
 *  pins this app's build to its own dependencies, and it is the same promise the
 *  rest of the design system makes: no Tailwind, values from getComputedStyle,
 *  nothing inherited. Keeping the file means nesting this app inside anything
 *  again cannot reintroduce the bug.
 */
const config = {
  plugins: {},
};

export default config;
