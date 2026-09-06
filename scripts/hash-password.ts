/**
 * Generate the scrypt hash for ADMIN_PASSWORD_HASH.
 *
 *   npm run admin:password
 *   npm run admin:password -- "a long passphrase"
 *
 * With no argument the password is read from stdin without echoing, so it never
 * lands in shell history. The hash is safe to store in an environment variable;
 * the password itself is never written anywhere by this script.
 */
import { createInterface } from 'node:readline';

import { hashPassword } from '../src/lib/auth/password.ts';

async function promptSecret(question: string): Promise<string> {
  process.stdout.write(question);

  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

  // Suppress echo by swallowing the output writes readline makes for input.
  const output = rl as unknown as { output?: NodeJS.WriteStream; _writeToOutput?: unknown };
  output._writeToOutput = () => {};

  return new Promise((resolve) => {
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const fromArgv = process.argv[2];
  const password = fromArgv ?? (await promptSecret('New admin password (min 12 characters): '));

  if (password.trim().length < 12) {
    console.error('\nPassword must be at least 12 characters. Nothing was written.');
    process.exit(1);
  }

  const hash = await hashPassword(password);

  console.log('\nAdd this to your .env (or your host\'s environment settings):\n');
  console.log(`ADMIN_PASSWORD_HASH="${hash}"`);
  console.log('\nThe next sign-in will use it. Changing it signs out every existing session.\n');
}

void main();
