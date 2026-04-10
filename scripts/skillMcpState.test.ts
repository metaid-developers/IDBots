import test from 'node:test';
import assert from 'node:assert/strict';
import {
  initialSkillMcpState,
  skillMcpReducer,
} from '../src/renderer/components/skills/skillMcpState';

test('SkillMcp state starts at skills/local', () => {
  assert.deepEqual(initialSkillMcpState, {
    mode: 'skills',
    skillsTab: 'local',
    mcpTab: 'installed',
  });
});

test('SkillMcp state remembers the last skills tab across mode switches', () => {
  const stateAfterOfficial = skillMcpReducer(initialSkillMcpState, {
    type: 'set-skills-tab',
    tab: 'official',
  });
  const stateAfterMcp = skillMcpReducer(stateAfterOfficial, {
    type: 'set-mode',
    mode: 'mcp',
  });
  const stateAfterBackToSkills = skillMcpReducer(stateAfterMcp, {
    type: 'set-mode',
    mode: 'skills',
  });

  assert.equal(stateAfterBackToSkills.mode, 'skills');
  assert.equal(stateAfterBackToSkills.skillsTab, 'official');
});

test('SkillMcp state remembers the last MCP tab across mode switches', () => {
  const stateAfterMcpCustom = skillMcpReducer(initialSkillMcpState, {
    type: 'set-mcp-tab',
    tab: 'custom',
  });
  const stateAfterSkills = skillMcpReducer(stateAfterMcpCustom, {
    type: 'set-mode',
    mode: 'skills',
  });
  const stateAfterBackToMcp = skillMcpReducer(stateAfterSkills, {
    type: 'set-mode',
    mode: 'mcp',
  });

  assert.equal(stateAfterBackToMcp.mode, 'mcp');
  assert.equal(stateAfterBackToMcp.mcpTab, 'custom');
});
