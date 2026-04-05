import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(SCRIPT_PATH), '..');
const DEFAULT_OUTPUT_ROOT = path.join(DEFAULT_REPO_ROOT, 'metabot/skillpacks');
const SHARED_CLI_PATH = 'metabot';
const SHARED_COMPATIBILITY_MANIFEST = 'metabot/release/compatibility.json';
const INCLUDED_SKILLS = [
  'metabot-chat-privatechat',
  'metabot-post-skillservice',
  'metabot-omni-reader',
  'metabot-bootstrap',
  'metabot-network-directory',
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

## Shared Runtime Contract

- CLI path: \`${SHARED_CLI_PATH}\`
- Compatibility manifest: \`${SHARED_COMPATIBILITY_MANIFEST}\`
- Package version: \`${packageVersion}\`
- Host pack id: \`${hostKey}\`
`;
}

function buildInstallScript(host) {
  return `#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
DEST_ROOT="\${METABOT_SKILL_DEST:-${host.defaultSkillRoot}}"

mkdir -p "$DEST_ROOT"

for skill_dir in "$SCRIPT_DIR"/skills/*; do
  [ -d "$skill_dir" ] || continue
  skill_name="$(basename "$skill_dir")"
  target_dir="$DEST_ROOT/$skill_name"
  rm -rf "$target_dir"
  mkdir -p "$target_dir"
  cp -R "$skill_dir"/. "$target_dir"/
done

echo "Installed MetaBot skills to $DEST_ROOT"
echo "CLI path: ${SHARED_CLI_PATH}"
echo "Compatibility manifest: ${SHARED_COMPATIBILITY_MANIFEST}"
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
