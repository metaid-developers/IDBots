import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const appPath = new URL('../src/renderer/App.tsx', import.meta.url);
const sidebarPath = new URL('../src/renderer/components/Sidebar.tsx', import.meta.url);
const switchPath = new URL('../src/renderer/features/botBrowser/BotBrowserModeSwitch.tsx', import.meta.url);
const railPath = new URL('../src/renderer/components/layout/WorkspaceRail.tsx', import.meta.url);
const surfacePath = new URL('../src/renderer/features/botBrowser/BotBrowserSurface.tsx', import.meta.url);
const bridgePath = new URL('../src/renderer/features/botBrowser/browserIframeBridge.ts', import.meta.url);
const shellPath = new URL('../src/renderer/features/botBrowser/useBotBrowserShell.ts', import.meta.url);

function readSource(url) {
  return existsSync(url) ? readFileSync(url, 'utf8') : '';
}

const appSource = readSource(appPath);
const sidebarSource = readSource(sidebarPath);
const switchSource = readSource(switchPath);
const railSource = readSource(railPath);
const surfaceSource = readSource(surfacePath);
const bridgeSource = readSource(bridgePath);
const shellSource = readSource(shellPath);

test('the mid column header owns the mode switch; the rail mounts none', () => {
  assert.ok(existsSync(switchPath), 'BotBrowserModeSwitch.tsx should exist');
  assert.ok(existsSync(shellPath), 'useBotBrowserShell.ts should exist');
  assert.ok(existsSync(railPath), 'WorkspaceRail.tsx should exist');
  // Owner ruling 2026-11-08 14:15: the switch left the top of the icon rail so
  // it can carry the current surface's NAME (a 64 px rail cannot). App still
  // owns the shell; the switch is mounted one level down, in the middle
  // column's header.
  assert.match(sidebarSource, /import BotBrowserModeSwitch from '\.\.\/features\/botBrowser\/BotBrowserModeSwitch';/);
  assert.match(sidebarSource, /<BotBrowserModeSwitch/);
  assert.doesNotMatch(railSource, /BotBrowserModeSwitch/);
  // The surface (and the ~550 kB ABC browser vendor chunk behind it) is code
  // split off the startup bundle; App binds it lazily under the same name.
  assert.match(
    appSource,
    /const BotBrowserSurface = React\.lazy\(\(\) =>\s*import\('\.\/features\/botBrowser\/BotBrowserSurface'\)\.then\(\(module\) => \(\{ default: module\.BotBrowserSurface \}\)\)\);/,
  );
  assert.doesNotMatch(
    appSource,
    /^import \{ BotBrowserSurface \} from '\.\/features\/botBrowser\/BotBrowserSurface';/m,
    'the surface must not be statically imported by App',
  );
  assert.doesNotMatch(appSource, /<BotBrowserModeSwitch/);
  assert.match(appSource, /<WorkspaceRail/);
  assert.match(appSource, /<BotBrowserSurface/);
});

test('App gates Home and Browser surfaces with botBrowserShell.surfaceMode', () => {
  assert.match(appSource, /const botBrowserShell = useBotBrowserShell\(/);
  assert.match(appSource, /botBrowserShell\.surfaceMode === 'home'/);
  assert.match(appSource, /botBrowserShell\.hasMountedBrowser \?/);
  // Upstream split "surface mode" from "is a browser page on screen": the
  // surface stays mounted but is hidden while the Bot Internet catalog shows.
  assert.match(appSource, /const showInternetCatalog = botBrowserShell\.surfaceMode === 'browser' && !botBrowserShell\.isBrowserPaneVisible;/);
  assert.match(appSource, /visible=\{botBrowserShell\.isBrowserPaneVisible\}/);
});

test('Browser tab commands reach the ABC runtime through the shell -> surface -> iframe bridge', () => {
  // Upstream moved the visible tab strip into the ABC browser runtime itself
  // (the React sidebar no longer renders a "New Tab" button), so this guard
  // covers the bridge that the shell's openNewTab()/controlTabs() still use.
  assert.doesNotMatch(sidebarSource, />New Tab<\/span>/);
  assert.match(shellSource, /controlTabs\(\{ action: 'open-tab' \}\)/);
  assert.match(surfaceSource, /type: 'tab-command'/);
  assert.match(bridgeSource, /if \(data\.type === 'tab-command'\)/);
  assert.match(bridgeSource, /if \(action === 'open-tab'\) \{/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.openTab/);
});

test('shell lands on Bot Internet by default (persisted last choice) with guarded deep links', () => {
  assert.match(shellSource, /window\.electron\.metabot\.list\(\)/);
  assert.match(shellSource, /if \(!result\?\.success\) \{/);
  assert.match(shellSource, /showToast\(messageFromError\(result\?\.error, 'Failed to load local Bots\.'\)\);/);
  assert.match(shellSource, /if \(Array\.isArray\(result\.list\) && result\.list\.length > 0\) \{/);
  assert.match(shellSource, /const identity = await window\.electron\.userIdentity\.get\(\);/);
  assert.match(shellSource, /if \(identity\?\.success && identity\.identity\?\.globalmetaid\) \{/);
  assert.match(shellSource, /showToast\('No local Actor\. Set up your identity or create a Bot first\.'\);/);
  assert.match(shellSource, /catch \(error\) \{/);
  assert.match(shellSource, /showToast\(messageFromError\(error, 'Failed to load local Bots\.'\)\);/);
  // Default landing surface is Bot Internet (the twin's daily surface); the
  // last explicit choice persists across restarts via localStorage.
  assert.match(shellSource, /const \[surfaceMode, setSurfaceModeState\] = useState<BotBrowserSurfaceMode>\(readStoredSurfaceMode\);/);
  assert.match(shellSource, /stored === 'home' \|\| stored === 'browser' \? stored : 'browser'/);
  assert.match(shellSource, /SURFACE_MODE_STORAGE_KEY = 'idbots\.botBrowser\.surfaceMode';/);
  assert.match(shellSource, /writeStoredSurfaceMode\(mode\);/);
  assert.match(shellSource, /const \[hasMountedBrowser, setHasMountedBrowser\] = useState\(true\);/);
});

test('App forwards host tab commands through the renderer and iframe response bridge', () => {
  assert.match(appSource, /window\.electron\.botBrowser\.onTabCommand/);
  assert.match(appSource, /botBrowserShell\.controlTabs\(command\)/);
  assert.match(appSource, /window\.electron\.botBrowser\.respondToTabCommand/);
  assert.match(surfaceSource, /type: 'tab-command-response'/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.getActiveTab\(\)/);
  assert.match(bridgeSource, /globalThis\.AgentBrowserTabs\.getTabs\(\)/);
});

test('App routes Browser conversation opens through the Cowork adapter', () => {
  assert.match(appSource, /openBotBrowserConversationInCowork/);
  assert.match(appSource, /handleBrowserOpenConversation = useCallback\(async \(request/);
  assert.match(appSource, /switchToHome:\s*botBrowserShell\.switchToHome/);
  assert.match(appSource, /showCowork:\s*handleShowCowork/);
  assert.doesNotMatch(appSource, /Conversation opening is not wired yet/);
});

test('App listens for host bot-browser open requests and forwards them to the shell', () => {
  assert.match(shellSource, /const openUri = useCallback\(async \(input: BotBrowserOpenUriInput\)/);
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, actorId, newTab \}\)/);
  assert.match(appSource, /window\.electron\.botBrowser\.onOpenUri\(/);
  assert.match(appSource, /botBrowserShell\.openUri\(input\)/);
});

test('user-initiated URI opens land in a new browser tab, not over the active one', () => {
  // Every in-renderer dispatcher on the DOM channel is a user click
  // (MarkdownContent links, group-task deliverables, cowork panel), so App
  // defaults the channel to newTab and only an explicit false navigates in place.
  // Upstream also forwards the dispatcher's actorId so an embedded MetaApp
  // hands the tab the same acting identity as the bubble that launched it.
  assert.match(appSource, /const actorId = typeof detail\?\.actorId === 'string' && detail\.actorId\.trim\(\) \? detail\.actorId\.trim\(\) : undefined;/);
  assert.match(appSource, /botBrowserShell\.openUri\(\{ uri: uri\.trim\(\), actorId, newTab: detail\?\.newTab !== false \}\)/);
  // Shell-level UI gestures (avatar bot pages, MetaApp launches) opt in too,
  // while the host IPC path (agent tools / RPC) forwards the input untouched.
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, actorId, newTab: true \}\)/);
  assert.match(shellSource, /openUriWhenBrowserReady\(\{ uri, newTab: true \}\)/);
  assert.doesNotMatch(shellSource, /openUriWhenBrowserReady\(\{ uri \}\)/);
  assert.match(shellSource, /const newTab = input\?\.newTab === true;/);
});

test('the surface menu puts Bot Internet before Bot Home', () => {
  // The labels moved from literals into i18n when the two-segment control
  // became the Codex-style dropdown: the order guard now reads the model.
  const modelSource = readSource(new URL('../src/renderer/components/sidebar/sidebarNavigation.js', import.meta.url));
  assert.match(modelSource, /t\('botInternet'\)/);
  assert.match(modelSource, /t\('botHome'\)/);
  assert.ok(
    modelSource.indexOf("t('botInternet')") < modelSource.indexOf("t('botHome')"),
    'Bot Internet is the first entry of the surface menu',
  );
  // Both labels are translated in zh + en (one occurrence per locale block).
  const i18nSource = readSource(new URL('../src/renderer/services/i18n.ts', import.meta.url));
  assert.equal((i18nSource.match(/^\s+botInternet:/gm) ?? []).length, 2);
  assert.equal((i18nSource.match(/^\s+botHome:/gm) ?? []).length, 2);
});
