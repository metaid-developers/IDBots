import type { MetabotUiPageName } from '../../daemon/routes/types';

export interface LocalUiPanelDefinition {
  title: string;
  body: string;
  items?: string[];
  actionLabel?: string;
  actionHref?: string;
}

export interface LocalUiPageDefinition {
  page: MetabotUiPageName;
  title: string;
  eyebrow: string;
  heading: string;
  description: string;
  panels: LocalUiPanelDefinition[];
  script: string;
}
