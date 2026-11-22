// Test-only resolver for the @deepseek-ai packages the plugin imports.
//
// In DSH those resolve from the running installation; a bare `node --test` has
// no node_modules here, so this hook points them at the live install.
// Affects the test process only.
import { register } from 'node:module';

const INSTALL = process.env.DSH_INSTALL_DIR
  || '/Applications/DSH NEXT.app/Contents/Resources/app.asar';

/** Real entry points, read from each package's exports["."]. */
const ENTRY = {
  schemastery: '/lib/index.mjs',
  'dsh-tools': '/lib/index.js',
  'dsh-llm': '/lib/index.js',
};

register(`data:text/javascript,${encodeURIComponent(`
const INSTALL = ${JSON.stringify(INSTALL)};
const ENTRY = ${JSON.stringify(ENTRY)};
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('@deepseek-ai/')) {
    const name = specifier.slice('@deepseek-ai/'.length);
    if (ENTRY[name]) {
      return {
        url: 'file://' + INSTALL + '/node_modules/@deepseek-ai/' + name + ENTRY[name],
        shortCircuit: true,
        format: 'module',
      };
    }
  }
  return next(specifier, context);
}
`)}`);
