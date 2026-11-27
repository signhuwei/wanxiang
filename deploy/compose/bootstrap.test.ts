import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const recipient = 'age1' + 'a'.repeat(58);
const promoted = 'sha256:' + 'b'.repeat(64);
const bootstrapImage = 'onex-server-docker:' + 'c'.repeat(40);

function runBootstrap(initializerOutput: string, options?: { missingImage?: boolean; interrupted?: boolean }) {
  const directory = mkdtempSync(join(tmpdir(), 'onex-bootstrap-test-'));
  try {
    const bin = join(directory, 'bin');
    const log = join(directory, 'up');
    mkdirSync(bin);
    copyFileSync(join(import.meta.dir, 'bootstrap.sh'), join(directory, 'bootstrap.sh'));
    writeFileSync(join(directory, 'compose.yaml'), 'services: {}\n');
    writeFileSync(join(directory, 'deployment.env'), `ONEX_SERVER_IMAGE=${bootstrapImage}\n`);
    writeFileSync(join(directory, 'images.tar.gz'), 'fixture');
    writeFileSync(join(directory, 'images.sha256'), createHash('sha256').update('fixture').digest('hex'));
    writeFileSync(join(directory, 'release.pub'), '-----BEGIN PUBLIC KEY-----\nfixture\n-----END PUBLIC KEY-----\n');
    writeFileSync(join(bin, 'docker'), `#!/bin/bash
case "$1 $2" in
  'image load') exit 0 ;;
  'image inspect')
    [[ $MOCK_MISSING_IMAGE == 0 && $5 == "$MOCK_PROMOTED" ]] || exit 1
    printf '%s\\n' "$MOCK_PROMOTED"
    ;;
  *)
    [[ $1 == compose ]] || exit 1
    case " $* " in
      *' config-init '*)
        cat >/dev/null
        if [[ $MOCK_INTERRUPTED == 1 ]]; then
          echo 'A Server rollout requires recovery.' >&2
          exit 1
        fi
        printf '%s\\n' "$MOCK_INITIALIZED"
        ;;
      *' up '*)
        if [[ -n $ONEX_SERVER_IMAGE ]]; then
          printf '%s\\n' "$ONEX_SERVER_IMAGE" > "$MOCK_LOG"
        else
          sed -n 's/^ONEX_SERVER_IMAGE=//p' deployment.env > "$MOCK_LOG"
        fi
        ;;
      *) exit 1 ;;
    esac
    ;;
esac
`, { mode: 0o700 });
    const { ONEX_SERVER_IMAGE: _image, ...env } = process.env;
    const result = Bun.spawnSync(['bash', 'bootstrap.sh', 'release.pub'], {
      cwd: directory, env: { ...env, PATH: `${bin}:${env.PATH}`, MOCK_INITIALIZED: initializerOutput,
        MOCK_MISSING_IMAGE: options?.missingImage ? '1' : '0', MOCK_INTERRUPTED: options?.interrupted ? '1' : '0',
        MOCK_PROMOTED: promoted, MOCK_LOG: log },
      stdout: 'pipe', stderr: 'pipe',
    });
    return {
      status: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString(),
      startedImage: existsSync(log) ? readFileSync(log, 'utf8').trim() : null,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test('bootstrap starts the bundled image for a new deployment and the persisted image after promotion', () => {
  expect(runBootstrap(recipient)).toMatchObject({ status: 0, stdout: `${recipient}\n`, startedImage: bootstrapImage });
  expect(runBootstrap(`${recipient}\n${promoted}`)).toMatchObject({ status: 0, stdout: `${recipient}\n`, startedImage: promoted });
});

test('bootstrap stops before Compose up if the promoted image is missing or the initializer output is invalid', () => {
  const missing = runBootstrap(`${recipient}\n${promoted}`, { missingImage: true });
  expect(missing).toMatchObject({ status: 1, stdout: '', startedImage: null });
  expect(missing.stderr).toContain('Promoted Server image is missing');
  const invalid = runBootstrap(`${recipient}\n${promoted}\nunexpected`);
  expect(invalid).toMatchObject({ status: 1, stdout: '', startedImage: null });
  expect(invalid.stderr).toContain('invalid active Server image ID');
});

test('bootstrap leaves an interrupted rollout for the recovery worker', () => {
  const interrupted = runBootstrap('', { interrupted: true });
  expect(interrupted).toMatchObject({ status: 1, stdout: '', startedImage: null });
  expect(interrupted.stderr).toContain('rollout requires recovery');
});
