import { readdirSync } from 'node:fs';
import { join } from 'node:path';

// Ensure the Node.js test runner works cross-platform. Windows fails to treat
// `node --test dist/test` as a directory, so expose an index module that loads
// every compiled test file when executed on win32. Other platforms rely on the
// default directory discovery to avoid double-loading the same tests.
const testsDirectory = __dirname;

if (process.platform === 'win32') {
  for (const entry of readdirSync(testsDirectory)) {
    if (entry.endsWith('.test.js')) {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      require(join(testsDirectory, entry));
    }
  }
}
