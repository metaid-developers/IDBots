import React from 'react';
import { ArrowLeftIcon, ChevronRightIcon, PlusCircleIcon } from '@heroicons/react/24/outline';
import { PROVIDER_TEMPLATES, type ProviderTemplate } from '../../services/providerTemplates';
import { resolveProviderTemplateLogo } from './providerTemplateLogos';
import { CustomProviderIcon } from '../icons/providers';
import { i18nService } from '../../services/i18n';

interface ProviderTemplatePickerProps {
  language: 'zh' | 'en';
  dark: boolean;
  onCreateFromTemplate: (template: ProviderTemplate) => void;
  onCreateCustom: () => void;
  onBack: () => void;
}

/**
 * "Add Provider" template picker, modeled after ZCode's settings
 * (Settings > Model Settings > Add Provider): the right detail area is
 * replaced by a flat list of third-party provider templates with a
 * "Create custom provider" card at the top. Picking a card creates the
 * provider entry immediately and hands control back to the edit form.
 */
const ProviderTemplatePicker: React.FC<ProviderTemplatePickerProps> = ({
  language,
  dark,
  onCreateFromTemplate,
  onCreateCustom,
  onBack,
}) => {
  const templateName = (template: ProviderTemplate): string => (
    language === 'zh' ? template.nameZh : template.nameEn
  );

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
        <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('addProvider')}
        </h3>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center px-2 py-1 text-xs font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
        >
          <ArrowLeftIcon className="h-3.5 w-3.5 mr-1" />
          {i18nService.t('templatePickerBack')}
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto pt-3 pr-1">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <button
            type="button"
            onClick={onCreateCustom}
            className="flex items-center p-2 rounded-xl text-left transition-colors dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-dashed dark:border-claude-darkBorder border-claude-border"
          >
            <span className="mr-2 flex h-7 w-7 items-center justify-center text-claude-accent">
              <PlusCircleIcon className="h-5 w-5" />
            </span>
            <span className="flex-1 text-sm font-medium leading-snug dark:text-claude-darkText text-claude-text">
              {i18nService.t('createCustomProvider')}
            </span>
          </button>

          {PROVIDER_TEMPLATES.map((template) => {
            const logo = resolveProviderTemplateLogo(template.logo, dark);
            return (
              <button
                key={template.templateId}
                type="button"
                onClick={() => onCreateFromTemplate(template)}
                className="flex items-center p-2 rounded-xl text-left transition-colors dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent"
              >
                <span className="mr-2 flex h-7 w-7 items-center justify-center shrink-0">
                  {logo ? (
                    <img src={logo} alt="" aria-hidden className="h-6 w-6 object-contain" />
                  ) : (
                    <span className="dark:text-claude-darkText text-claude-text">
                      <CustomProviderIcon />
                    </span>
                  )}
                </span>
                <span className="flex-1 text-sm font-medium leading-snug dark:text-claude-darkText text-claude-text">
                  {templateName(template)}
                </span>
                <ChevronRightIcon className="h-4 w-4 ml-1 shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default ProviderTemplatePicker;
