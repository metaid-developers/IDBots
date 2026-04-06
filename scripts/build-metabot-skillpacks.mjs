import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_OUTPUT_ROOT = path.join(DEFAULT_REPO_ROOT, 'metabot/skillpacks');
const SHARED_CLI_PATH = 'metabot';
const SHARED_COMPATIBILITY_MANIFEST = 'metabot/release/compatibility.json';
const BUNDLED_COMPATIBILITY_MANIFEST = 'runtime/compatibility.json';
const INCLUDED_SKILLS = [
  'metabot-chat-privatechat',
  'metabot-post-skillservice',
  'metabot-omni-reader',
  'metabot-bootstrap',
  'metabot-network-directory',
  'metabot-network-sources',
  'metabot-call-remote-service',
  'metabot-trace-inspector',
];

const HOSTS = {
  codex: {
    displayName: 'Codex',
    defaultSkillRoot: '${CODEX_HOME:-$HOME/.codex}/skills',
  },
  'claude-code': {
    displayName: 'Claude Code',
    defaultSkillRoot: '${CLAUDE_HOME:-$HOME/.claude}/skills',
  },
  openclaw: {
    displayName: 'OpenClaw',
    defaultSkillRoot: '${OPENCLAW_HOME:-$HOME/.openclaw}/skills',
  },
};

function replaceAll(source, replacements) {
  return Object.entries(replacements).reduce((text, [token, value]) => (
    text.split(token).join(value)
  ), source);
}

function renderHostMetadata(hostKey, host) {
  return [
    `Generated for ${host.displayName}.`,
    '',
    `- Default skill root: \`${host.defaultSkillRoot}\``,
    `- Host pack id: \`${hostKey}\``,
    `- CLI path: \`${SHARED_CLI_PATH}\``,
  ].join('\n');
}

function buildReadme({ hostKey, host, packageVersion }) {
  const skillList = INCLUDED_SKILLS.map((skill) => `- \`${skill}\``).join('\n');
  return `# MetaBot Skill Pack for ${host.displayName}

Thin host adapter for the MetaBot open-source research pack. These skills keep business logic in the shared \`${SHARED_CLI_PATH}\` CLI and MetaWeb runtime instead of the host adapter.

## Included Skills

${skillList}

## Install

\`\`\`bash
./install.sh
\`\`\`

Override the destination with \`METABOT_SKILL_DEST\` if this host uses a custom skill root.
Override the CLI shim directory with \`METABOT_BIN_DIR\` if \`$HOME/.metabot/bin\` is not on PATH.
If you are installing from a source checkout, set \`METABOT_SOURCE_ROOT\` to the metabot package root or the repo root.

## Shared Runtime Contract

- CLI path: \`${SHARED_CLI_PATH}\`
- Compatibility manifest: \`${SHARED_COMPATIBILITY_MANIFEST}\`
- Bundled compatibility copy: \`${BUNDLED_COMPATIBILITY_MANIFEST}\`
- Package version: \`${packageVersion}\`
- Host pack id: \`${hostKey}\`
`;
}

function buildInstallScript(host) {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="\${METABOT_SKILL_DEST:-${host.defaultSkillRoot}}"
BIN_DIR="\${METABOT_BIN_DIR:-$HOME/.metabot/bin}"
SOURCE_ROOT="\${METABOT_SOURCE_ROOT:-}"
CLI_ENTRY="\${METABOT_CLI_ENTRY:-}"

mkdir -p "$DEST_ROOT"
mkdir -p "$BIN_DIR"

resolve_cli_entry() {
  if [ -n "$CLI_ENTRY" ] && [ -f "$CLI_ENTRY" ]; then
    return 0
  fi

  if [ -n "$SOURCE_ROOT" ]; then
    if [ -f "$SOURCE_ROOT/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
      return 0
    fi

    if [ -f "$SOURCE_ROOT/metabot/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/metabot/dist/cli/main.js"
      return 0
    fi
  fi

  if [ -f "$SCRIPT_DIR/runtime/metabot/dist/cli/main.js" ]; then
    CLI_ENTRY="$SCRIPT_DIR/runtime/metabot/dist/cli/main.js"
    return 0
  fi

  if [ -z "$SOURCE_ROOT" ] && [ -f "$SCRIPT_DIR/../../package.json" ]; then
    SOURCE_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
    if [ -f "$SOURCE_ROOT/dist/cli/main.js" ]; then
      CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
      return 0
    fi
  fi

  return 1
}

build_cli_from_source() {
  if [ -z "$SOURCE_ROOT" ]; then
    return 1
  fi

  if [ -f "$SOURCE_ROOT/package.json" ] && [ -f "$SOURCE_ROOT/tsconfig.json" ]; then
    command -v npm >/dev/null 2>&1 || {
      echo "npm is required to build the MetaBot CLI from source." >&2
      exit 1
    }
    npm --prefix "$SOURCE_ROOT" run build >/dev/null
    [ -f "$SOURCE_ROOT/dist/cli/main.js" ] || return 1
    CLI_ENTRY="$SOURCE_ROOT/dist/cli/main.js"
    return 0
  fi

  if [ -f "$SOURCE_ROOT/metabot/package.json" ] && [ -f "$SOURCE_ROOT/metabot/tsconfig.json" ]; then
    command -v npm >/dev/null 2>&1 || {
      echo "npm is required to build the MetaBot CLI from source." >&2
      exit 1
    }
    npm --prefix "$SOURCE_ROOT/metabot" run build >/dev/null
    [ -f "$SOURCE_ROOT/metabot/dist/cli/main.js" ] || return 1
    CLI_ENTRY="$SOURCE_ROOT/metabot/dist/cli/main.js"
    return 0
  fi

  return 1
}

command -v node >/dev/null 2>&1 || {
  echo "node is required to run the MetaBot CLI." >&2
  exit 1
}

if ! resolve_cli_entry; then
  build_cli_from_source || true
  resolve_cli_entry || {
    echo "MetaBot CLI entry not found. Set METABOT_SOURCE_ROOT or METABOT_CLI_ENTRY before running install.sh." >&2
    exit 1
  }
fi

for skill_dir in "$SCRIPT_DIR"/skills/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  target_dir="$DEST_ROOT/$skill_name"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$skill_dir"/. "$target_dir"/
done

printf '%s\n' \
  '#!/usr/bin/env bash' \
  'set -euo pipefail' \
  "exec node \"$CLI_ENTRY\" \"\\\$@\"" \
  > "$BIN_DIR/metabot"

chmod +x "$BIN_DIR/metabot"

echo "Installed MetaBot skills to $DEST_ROOT"
echo "Installed MetaBot CLI shim to $BIN_DIR/metabot"
echo "CLI path: ${SHARED_CLI_PATH}"
echo "Compatibility manifest: ${SHARED_COMPATIBILITY_MANIFEST}"
echo "Bundled compatibility copy: $SCRIPT_DIR/${BUNDLED_COMPATIBILITY_MANIFEST}"
`;
}

async function readTemplate(repoRoot, relativePath) {
  return fs.readFile(path.join(repoRoot, relativePath), 'utf8');
}

async function writeFile(filePath, content, executable = false) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
  if (executable) {
    await fs.chmod(filePath, 0o755);
  }
}

async function renderSkill({ repoRoot, skillName, hostKey, host, templates }) {
  const sourcePath = path.join(repoRoot, 'SKILLs', skillName, 'SKILL.md');
  const source = await fs.readFile(sourcePath, 'utf8');
  const renderedTemplates = {
    confirmationContract: replaceAll(templates.confirmationContract, {
      '{{METABOT_CLI}}': SHARED_CLI_PATH,
    }),
    systemRouting: replaceAll(templates.systemRouting, {
      '{{METABOT_CLI}}': SHARED_CLI_PATH,
    }),
  };
  return replaceAll(source, {
    '{{METABOT_CLI}}': SHARED_CLI_PATH,
    '{{COMPATIBILITY_MANIFEST}}': SHARED_COMPATIBILITY_MANIFEST,
    '{{HOST_SKILLPACK_METADATA}}': renderHostMetadata(hostKey, host),
    '{{SYSTEM_ROUTING}}': renderedTemplates.systemRouting,
    '{{CONFIRMATION_CONTRACT}}': renderedTemplates.confirmationContract,
  });
}

export async function buildMetabotSkillpacks(options = {}) {
  const repoRoot = options.repoRoot ? path.resolve(options.repoRoot) : DEFAULT_REPO_ROOT;
  const outputRoot = options.outputRoot ? path.resolve(options.outputRoot) : DEFAULT_OUTPUT_ROOT;
  const packageJson = JSON.parse(await fs.readFile(path.join(repoRoot, 'metabot/package.json'), 'utf8'));
  const compatibilityManifest = await readTemplate(repoRoot, SHARED_COMPATIBILITY_MANIFEST);
  const templates = {
    confirmationContract: await readTemplate(repoRoot, 'metabot/skillpacks/common/templates/confirmation-contract.md'),
    systemRouting: await readTemplate(repoRoot, 'metabot/skillpacks/common/templates/system-routing.md'),
  };

  const hostKeys = Object.keys(HOSTS);

  for (const hostKey of hostKeys) {
    const host = HOSTS[hostKey];
    const hostRoot = path.join(outputRoot, hostKey);
    await fs.rm(hostRoot, { recursive: true, force: true });
    await fs.mkdir(path.join(hostRoot, 'skills'), { recursive: true });

    await writeFile(path.join(hostRoot, 'README.md'), buildReadme({
      hostKey,
      host,
      packageVersion: packageJson.version,
    }));
    await writeFile(path.join(hostRoot, 'install.sh'), buildInstallScript(host), true);
    await writeFile(path.join(hostRoot, BUNDLED_COMPATIBILITY_MANIFEST), compatibilityManifest);

    for (const skillName of INCLUDED_SKILLS) {
      const rendered = await renderSkill({ repoRoot, skillName, hostKey, host, templates });
      await writeFile(path.join(hostRoot, 'skills', skillName, 'SKILL.md'), rendered);
    }
  }

  return {
    outputRoot,
    hosts: hostKeys,
    cliPath: SHARED_CLI_PATH,
    compatibilityManifest: SHARED_COMPATIBILITY_MANIFEST,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const result = await buildMetabotSkillpacks();
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function pathToFileURL(filePath) {
  return new URL(`file://${path.resolve(filePath)}`);
}
