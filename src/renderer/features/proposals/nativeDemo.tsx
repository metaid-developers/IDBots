import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import '../../index.css';
import Sidebar from '../../components/Sidebar';
import CoworkSessionDetail from '../../components/cowork/CoworkSessionDetail';
import { MessageExtensionContext } from '../../components/cowork/MessageExtensionContext';
import { store } from '../../store';
import { setCurrentSession } from '../../store/slices/coworkSlice';
import { setAvailableModels, setSelectedModel } from '../../store/slices/modelSlice';
import { i18nService } from '../../services/i18n';
import { configService } from '../../services/config';
import { DEEPSEEK_DEFAULT_MODEL_ID } from '../../config';
import { BotActionCard } from './BotActionCard';
import { acceptConfirmation, exampleBotAction, validateConfirmation, validateReceipt, type BotActionConfirmation, type BotActionReceipt } from './botActionModel';

const confirmationKey = 'idbots:bot-action-preview:confirmation:v1';
const receiptKey = 'idbots:bot-action-preview:receipt:v1';
function loadConfirmation(): BotActionConfirmation | null {
  try { const saved = JSON.parse(localStorage.getItem(confirmationKey) || 'null');
    return saved && validateConfirmation(exampleBotAction, saved) ? saved : null;
  } catch { return null; }
}
function loadReceipt(): BotActionReceipt | null {
  try { const saved = JSON.parse(localStorage.getItem(receiptKey) || 'null');
    return saved && validateReceipt(exampleBotAction, saved) ? saved : null;
  } catch { return null; }
}
const now = Date.now();
store.dispatch(setCurrentSession({ id: 'proposal-preview', title: 'MetaApp homepage · action preview',
  claudeSessionId: null, status: 'completed', pinned: false, cwd: '', systemPrompt: '',
  executionMode: 'local', activeSkillIds: [], createdAt: now, updatedAt: now,
  model: DEEPSEEK_DEFAULT_MODEL_ID, modelProvider: 'deepseek', messages: [
    { id: 'preview-user', type: 'user', content: 'Use the gallery direction we just picked to generate a bot homepage I can review.', timestamp: now },
    { id: 'preview-action', type: 'assistant', content: 'The design direction is set. Before generating, confirm which bot executes, what gets written, and where to view the result.', timestamp: now + 1 },
  ] }));
const model = { id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek (demo)', provider: 'DeepSeek', providerKey: 'deepseek' };
store.dispatch(setAvailableModels([model]));
store.dispatch(setSelectedModel(model));
i18nService.setLanguage('en', { persist: false });

function Demo() {
  const [confirmation, setConfirmation] = useState(loadConfirmation);
  const [receipt, setReceipt] = useState(loadReceipt);
  const [generation, setGeneration] = useState(0);
  const actionEpoch = useRef(0);
  const [notice, setNotice] = useState('Isolated interactive demo · real IDBots components · no model, wallet, or network calls');
  const unavailable = () => setNotice('Only the bot action loop is wired in this demo; other buttons are not connected.');
  const reset = () => {
    actionEpoch.current += 1;
    localStorage.removeItem(confirmationKey); localStorage.removeItem(receiptKey);
    setConfirmation(null); setReceipt(null); setGeneration(n => n + 1);
  };
  return <Provider store={store}>
    <div className="h-screen flex flex-col bg-claude-bg text-claude-text">
      <div className="px-4 py-2 text-xs border-b border-claude-border bg-claude-surface flex justify-between gap-4" role="status">
        <span>{notice}</span><button onClick={reset}>Reset demo</button>
      </div>
      <div className="flex flex-1 min-h-0">
        <Sidebar mode="home" homeSection="records" isCollapsed={false} onShowSettings={unavailable}
          onShowSkills={unavailable} onShowCowork={unavailable} onShowScheduledTasks={unavailable}
          onShowGroupTasks={unavailable} onSelectHomeSection={unavailable}
          onSelectHome={unavailable} />
        <MessageExtensionContext.Provider value={message => message.id === 'preview-action' ?
          <div className="mt-4"><BotActionCard key={generation} request={exampleBotAction}
            initialConfirmation={confirmation} initialReceipt={receipt}
            onConfirm={async next => {
              const accepted = acceptConfirmation(exampleBotAction, loadConfirmation(), next);
              localStorage.setItem(confirmationKey, JSON.stringify(accepted)); setConfirmation(accepted);
              return null;
            }}
            onApprovalResolved={async () => {
              const epoch = actionEpoch.current;
              await new Promise(resolve => window.setTimeout(resolve, 650));
              if (actionEpoch.current !== epoch) throw new Error('The action was reset');
              const result: BotActionReceipt = { requestId: exampleBotAction.id, version: exampleBotAction.version,
                status: 'succeeded', summary: 'MetaApp preview generated and ready for review',
                outputUri: 'preview-metaapp://fixture/homepage-gallery', completedAt: new Date().toISOString() };
              localStorage.setItem(receiptKey, JSON.stringify(result)); setReceipt(result); return result;
            }}
            onOpenOutput={uri => setNotice(`BotBrowser preview handoff: ${uri} · no real navigation in this demo`)} />
            {receipt && <details className="mt-3 text-xs"><summary>View structured execution receipt (local mock data)</summary>
              <pre className="whitespace-pre-wrap mt-2">{JSON.stringify(receipt, null, 2)}</pre></details>}
          </div> : null}>
          <div className="flex-1 min-w-0 flex flex-col"><CoworkSessionDetail onContinue={() => { unavailable(); return false; }}
            onStop={unavailable}
            onNewChat={unavailable} onNavigateHome={unavailable} /></div>
        </MessageExtensionContext.Provider>
      </div>
    </div>
  </Provider>;
}
void configService.updateConfig({ providers: { ...configService.getConfig().providers!, deepseek: {
  enabled: true, apiKey: 'preview-not-a-real-key', baseUrl: 'https://preview.invalid', apiFormat: 'openai',
  models: [{ id: DEEPSEEK_DEFAULT_MODEL_ID, name: 'DeepSeek (demo)' }],
} } }).then(() => createRoot(document.getElementById('root')!).render(<Demo />));
