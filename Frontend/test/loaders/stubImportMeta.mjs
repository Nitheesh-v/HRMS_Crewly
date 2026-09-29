// Test-only loader: plain Node has no `import.meta.env` (that is a Vite
// feature), so importing the real store - and therefore services/api.js -
// fails with a TypeError before any assertion runs.
//
// This rewrites `import.meta.env` to a plain object for the duration of a
// test run. It is registered ONLY through `npm run test:frontend` and never
// affects the dev server or the production build.
export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);

  if (!url.endsWith('.js') && !url.endsWith('.jsx')) return result;
  if (!result.source) return result;

  const source =
    typeof result.source === 'string'
      ? result.source
      : Buffer.from(result.source).toString('utf8');

  if (!source.includes('import.meta.env')) return result;

  return {
    ...result,
    source: source.replaceAll('import.meta.env', 'globalThis.__TEST_ENV__'),
  };
}
