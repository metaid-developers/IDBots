// Per-session DSH skill env: BASH_ENV loader + 0600 env files so KEY/TOKEN
// names (ARK_API_KEY, IDBOTS_RPC_TOKEN, mnemonic) survive the DSH subprocess
// scrub and stay isolated across concurrent cowork sessions.
// Requires: npm run compile:electron

import assert from 'node:assert/strict'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))

function loadModule() {
  return require('../dist-electron/main/libs/dshSkillSessionEnv.js')
}

test('toGitBashPath converts Windows drive paths for Git bash', () => {
  const { toGitBashPath } = loadModule()
  assert.equal(
    toGitBashPath('C:\\Users\\John Doe\\AppData\\Roaming\\IDBots', 'win32'),
    '/c/Users/John Doe/AppData/Roaming/IDBots',
  )
  assert.equal(toGitBashPath('/tmp/foo', 'darwin'), '/tmp/foo')
})

test('formatPosixEnvFile converts TMPDIR on Windows', () => {
  const { formatPosixEnvFile } = loadModule()
  const body = formatPosixEnvFile({
    TMPDIR: 'C:\\Users\\John Doe\\.cowork-temp',
    ARK_API_KEY: 'sk-secret',
  }, 'win32')
  assert.match(body, /TMPDIR='\/c\/Users\/John Doe\/\.cowork-temp'/)
  assert.match(body, /ARK_API_KEY='sk-secret'/)
})

test('formatPosixEnvFile quotes KEY names and apostrophes and strips forbidden mnemonic keys', () => {
  const { formatPosixEnvFile, posixSingleQuote } = loadModule()
  assert.equal(posixSingleQuote("it's"), `'it'\\''s'`)
  const body = formatPosixEnvFile({
    ARK_API_KEY: 'sk-secret',
    IDBOTS_TWIN_NAME: "alpha beta's gamma",
    IDBOTS_METABOT_MNEMONIC: 'should never be written to env file',
    'not a key': 'nope',
  })
  assert.match(body, /^ARK_API_KEY='sk-secret'$/m)
  assert.match(body, /IDBOTS_TWIN_NAME='alpha beta'\\''s gamma'/)
  assert.doesNotMatch(body, /IDBOTS_METABOT_MNEMONIC/)
  assert.doesNotMatch(body, /not a key/)
})

test('writeDshSkillSessionEnvFile is keyed by DSH session id and mode 0600', () => {
  const {
    writeDshSkillSessionEnvFile,
    dshSkillEnvFilePath,
    isSafeDshSessionId,
  } = loadModule()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-env-'))
  try {
    assert.equal(isSafeDshSessionId('cw-abc'), true)
    assert.equal(isSafeDshSessionId('../etc/passwd'), false)
    const dest = writeDshSkillSessionEnvFile(userData, 'cw-sess-1', {
      ARK_API_KEY: 'sk-a',
      IDBOTS_METABOT_ID: '7',
    })
    assert.equal(dest, dshSkillEnvFilePath(userData, 'cw-sess-1'))
    const st = fs.statSync(dest)
    if (process.platform !== 'win32') {
      assert.equal(st.mode & 0o777, 0o600)
    }
    assert.equal(writeDshSkillSessionEnvFile(userData, '../x', { A: '1' }), null)
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('BASH_ENV loader injects KEY-named vars after a simulated DSH scrub', () => {
  const {
    ensureDshSkillEnvChannel,
    writeDshSkillSessionEnvFile,
    DSH_SKILL_ENV_DIR_ENV,
    DSH_SKILL_ENV_LOADER_ENV,
  } = loadModule()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-bash-'))
  const script = path.join(userData, 'echo-keys.sh')
  try {
    const channel = ensureDshSkillEnvChannel(userData)
    writeDshSkillSessionEnvFile(userData, 'cw-bot-a', {
      ARK_API_KEY: 'sk-bot-a',
      IDBOTS_METABOT_ID: '11',
      IDBOTS_RPC_TOKEN: 'tok-a',
    })
    writeDshSkillSessionEnvFile(userData, 'cw-bot-b', {
      ARK_API_KEY: 'sk-bot-b',
      IDBOTS_METABOT_ID: '22',
    })
    fs.writeFileSync(
      script,
      '#!/usr/bin/env bash\nprintf \'%s|%s|%s\\n\' "${ARK_API_KEY-}" "${IDBOTS_METABOT_ID-}" "${IDBOTS_RPC_TOKEN-}"\n',
      'utf8',
    )

    const run = (dshSessionId) => execFileSync('bash', [script], {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        [DSH_SKILL_ENV_DIR_ENV]: channel[DSH_SKILL_ENV_DIR_ENV],
        [DSH_SKILL_ENV_LOADER_ENV]: channel[DSH_SKILL_ENV_LOADER_ENV],
        DSH_SESSION_ID: dshSessionId,
      },
    }).trim()

    assert.equal(run('cw-bot-a'), 'sk-bot-a|11|tok-a')
    assert.equal(run('cw-bot-b'), 'sk-bot-b|22|')
    assert.equal(run('cw-missing'), '||')
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('copyDshSkillSessionEnvFile clones parent env onto a subagent session id', () => {
  const {
    writeDshSkillSessionEnvFile,
    copyDshSkillSessionEnvFile,
    dshSkillEnvFilePath,
  } = loadModule()
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-skill-copy-'))
  try {
    writeDshSkillSessionEnvFile(userData, 'cw-parent', { ARK_API_KEY: 'sk-p' })
    copyDshSkillSessionEnvFile(userData, 'cw-parent', 'cw-parent:agent-1')
    const copied = fs.readFileSync(dshSkillEnvFilePath(userData, 'cw-parent:agent-1'), 'utf8')
    assert.match(copied, /ARK_API_KEY='sk-p'/)
  } finally {
    fs.rmSync(userData, { recursive: true, force: true })
  }
})

test('buildDshChildEnv forwards BASH_ENV from skillHostEnv', () => {
  const originalLoad = Module._load
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') {
      return {
        app: {
          isPackaged: false,
          getAppPath: () => process.cwd(),
          getPath: (name) => path.join(here, '..', '.cowork-temp', `dsh-skillenv-${name}`),
        },
      }
    }
    return originalLoad.apply(this, arguments)
  }
  try {
    const { buildDshChildEnv } = require('../dist-electron/main/libs/coworkDshTurn.js')
    const env = buildDshChildEnv({
      routeApiKeys: [],
      rpcToken: 't',
      rpcAuthFile: '/tmp/auth',
      skillHostEnv: {
        BASH_ENV: '/tmp/loader.sh',
        IDBOTS_SKILL_ENV_DIR: '/tmp/dsh-skill-env',
        IDBOTS_RPC_URL: 'http://127.0.0.1:31200',
      },
    })
    assert.equal(env.BASH_ENV, '/tmp/loader.sh')
    assert.equal(env.IDBOTS_SKILL_ENV_DIR, '/tmp/dsh-skill-env')
    assert.equal(env.IDBOTS_RPC_URL, 'http://127.0.0.1:31200')
  } finally {
    Module._load = originalLoad
  }
})
