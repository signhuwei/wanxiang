import { createPublicKey, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const serverSecrets = '/run/onex-server-secrets';
const objectSecrets = '/run/onex-object-secrets';
const releaseTrust = '/run/onex-release-trust';
const releaseIdentity = '/run/onex-release-identity';

function signingPublicKey(value: string) {
  const pem = value.trim();
  if (!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----$/.test(pem)) {
    throw new Error('Expected a PEM Server release signing public key');
  }
  const key = createPublicKey(pem);
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Use an Ed25519 Server release signing public key');
  return key.export({ type: 'spki', format: 'pem' }).toString();
}

function ensureFile(path: string, create: (candidate: string) => void) {
  if (!existsSync(path)) {
    const staging = mkdtempSync(join(dirname(path), '.onex-init-'));
    try {
      const candidate = join(staging, 'key');
      create(candidate);
      chmodSync(candidate, 0o600);
      // Publish the completed file without replacing a key another initializer has already installed.
      try { linkSync(candidate, path); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  if (!lstatSync(path).isFile()) throw new Error(`Expected a regular key file at ${path}`);
  chmodSync(path, 0o600);
}

function ensureSecret(path: string, encoding: 'base64' | 'hex') {
  ensureFile(path, candidate => writeFileSync(candidate, randomBytes(32).toString(encoding) + '\n', { mode: 0o600 }));
  const value = readFileSync(path, 'utf8').replace(/\n+$/, '');
  if (!value || /[\0\r\n]/.test(value)) throw new Error(`Expected a single-line secret at ${path}`);
  return value;
}

const signingKey = signingPublicKey(await Bun.stdin.text());
for (const directory of [serverSecrets, objectSecrets, releaseTrust, releaseIdentity]) {
  if (!lstatSync(directory).isDirectory()) throw new Error(`Expected a key directory at ${directory}`);
  chmodSync(directory, 0o700);
}

const trustPath = join(releaseTrust, 'server-release.pub');
ensureFile(trustPath, candidate => writeFileSync(candidate, signingKey, { mode: 0o600 }));
if (signingPublicKey(readFileSync(trustPath, 'utf8')) !== signingKey) {
  throw new Error('This deployment already trusts a different Server release signing key');
}

const master = ensureSecret(join(serverSecrets, 'master.key'), 'base64');
const masterBytes = Buffer.from(master, 'base64');
if (masterBytes.length !== 32 || masterBytes.toString('base64') !== master) {
  throw new Error('master.key must contain 32 bytes in standard base64');
}
const auth = ensureSecret(join(serverSecrets, 'auth.key'), 'hex');
if (auth.length < 32) throw new Error('auth.key must contain at least 32 characters');
ensureSecret(join(objectSecrets, 'rustfs.key'), 'hex');

const identityPath = join(releaseIdentity, 'age.key');
ensureFile(identityPath, candidate => {
  const result = Bun.spawnSync(['age-keygen', '-o', candidate], { stdout: 'ignore', stderr: 'ignore' });
  if (!result.success) throw new Error('Could not generate the Server release encryption identity');
});
const result = Bun.spawnSync(['age-keygen', '-y', identityPath], { stdout: 'pipe', stderr: 'ignore' });
const recipient = result.stdout.toString().trim();
if (!result.success || !/^age1[0-9a-z]{58}$/.test(recipient)) {
  throw new Error('Could not read the Server release encryption recipient');
}
console.log(recipient);
