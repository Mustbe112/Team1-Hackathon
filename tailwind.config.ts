/**
 * Tailwind CSS v4 is CSS-first; this legacy-style config is loaded explicitly
 * from `app/globals.css` via the `@config` directive so content paths and
 * theme extensions stay in one place.
 */
const config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}", "./lib/**/*.{ts,tsx}"],
};

export default config;
