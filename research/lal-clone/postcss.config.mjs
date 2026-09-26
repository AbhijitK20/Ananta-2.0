/** PostCSS. Deliberately empty, and deliberately here.
 *
 *  This app has no Tailwind and no PostCSS steps. The file exists anyway
 *  because of a specific failure: with no config of its own, Next walks up
 *  the directory tree, finds the PARENT TravelBuddy project's
 *  postcss.config.mjs, and tries to load it -- which names @tailwindcss/postcss.
 *
 *  That works on this machine, where the parent's node_modules is one level up
 *  and the plugin resolves. It fails the moment the app is installed on its
 *  own, which is what a deploy does:
 *
 *      Error: Cannot find module '@tailwindcss/postcss'
 *
 *  The symptom pointed at CSS and at Tailwind; the cause was a config file
 *  belonging to a different project four directories away. An empty plugin map
 *  pins this app's build to its own dependencies, which is the same promise
 *  the rest of the design system makes -- no Tailwind, values from
 *  getComputedStyle, nothing inherited.
 */
const config = {
  plugins: {},
};

export default config;
