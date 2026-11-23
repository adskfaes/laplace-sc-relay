import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';

const configPath = new URL('../laplace-sc-replay/local-instance.json', import.meta.url);
const secret = /^[a-f0-9]{64}$/u;

export async function readConfig() {
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  if (!secret.test(config?.requestKey) || !secret.test(config?.storageKey)) {
    throw new Error('Invalid local installation configuration');
  }
  return config;
}

if (process.argv[2] === '--initialize') {
  const config = { requestKey: randomBytes(32).toString('hex'), storageKey: randomBytes(32).toString('hex') };
  try {
    await writeFile(configPath, JSON.stringify(config), { flag: 'wx' });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  await readConfig();
}
