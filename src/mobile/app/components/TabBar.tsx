import { ChatBubbleLeftRightIcon, ClipboardDocumentListIcon, UserIcon } from '@heroicons/react/24/outline';
import { t } from '../../i18n';

export type MobileTab = 'chat' | 'tasks' | 'me';

const TABS: Array<{ id: MobileTab; labelKey: string; icon: typeof ChatBubbleLeftRightIcon }> = [
  { id: 'chat', labelKey: 'mobile.tabs.chat', icon: ChatBubbleLeftRightIcon },
  { id: 'tasks', labelKey: 'mobile.tabs.tasks', icon: ClipboardDocumentListIcon },
  { id: 'me', labelKey: 'mobile.tabs.me', icon: UserIcon },
];

/** Bottom tab bar with safe-area padding and 44 px touch targets (REQ-E-11). */
export function TabBar(props: { active: MobileTab; onSelect: (tab: MobileTab) => void }): JSX.Element {
  return (
    <nav
      className="twin-tabbar"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-label={t('mobile.app.tabBarLabel')}
    >
      {TABS.map((tab) => {
        const Icon = tab.icon;
        const selected = tab.id === props.active;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => props.onSelect(tab.id)}
            aria-current={selected ? 'page' : undefined}
            className="twin-tab"
          >
            <Icon className="twin-tab-icon" aria-hidden />
            <span>{t(tab.labelKey)}</span>
          </button>
        );
      })}
    </nav>
  );
}
