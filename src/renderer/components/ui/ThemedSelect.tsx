import React, { useState, useRef, useEffect } from 'react';
import { ChevronDownIcon, CheckIcon } from '@heroicons/react/24/outline';

interface ThemedSelectProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  className?: string;
  label?: string;
}

const ThemedSelect: React.FC<ThemedSelectProps> = ({
  id,
  value,
  onChange,
  options,
  className = '',
  label,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  // OWNER 02:35: popover was absolute inside scroll containers — clipped for
  // lower rows and stylistically off. Fixed to the viewport with coords from
  // the trigger rect, in the unified dropdown grammar (rounded-xl card,
  // compact options, accent check mark).
  const [popPos, setPopPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Find the selected option label
  const selectedOption = options.find(option => option.value === value);

  // Handle click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // Handle option selection
  const handleOptionClick = (optionValue: string) => {
    onChange(optionValue);
    setIsOpen(false);
  };

  return (
    <div className="relative" ref={dropdownRef}>
      <div className="flex items-center space-x-3">
        {label && (
          <label htmlFor={id} className="text-sm font-medium dark:text-claude-darkText text-claude-text whitespace-nowrap">
            {label}
          </label>
        )}
        <div className="flex-1">
          <button
            id={id}
            type="button"
            onClick={() => {
              const rect = dropdownRef.current?.getBoundingClientRect();
              if (rect) setPopPos({ top: rect.bottom + 4, left: rect.left, width: rect.width });
              setIsOpen(!isOpen);
            }}
            className={`flex items-center justify-between w-full gap-1.5 rounded-[var(--shape-radius-sm)] border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text px-2 py-1.5 text-xs transition-colors hover:border-claude-accent/60 ${className}`}
            aria-haspopup="listbox"
            aria-expanded={isOpen}
          >
            <span>{selectedOption?.label || value}</span>
            <ChevronDownIcon className="w-4 h-4 ml-2" />
          </button>

          {isOpen && popPos && (
            <div
              className="fixed z-40 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-2xl p-1 popover-enter"
              style={{ top: popPos.top, left: popPos.left, width: Math.max(popPos.width, 140) }}
            >
              <ul className="overflow-auto text-xs max-h-60 focus:outline-none" role="listbox" aria-labelledby={id}>
                {options.map((option) => {
                  const selected = option.value === value;
                  return (
                    <li
                      key={option.value}
                      className={`flex cursor-pointer select-none items-center justify-between gap-2 rounded-[var(--shape-radius-sm)] px-2 py-1.5 transition-colors ${
                        selected
                          ? 'bg-claude-accent/10 dark:text-claude-darkText text-claude-text'
                          : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                      }`}
                      role="option"
                      aria-selected={selected}
                      onClick={() => handleOptionClick(option.value)}
                    >
                      <span className={`truncate ${selected ? 'font-medium' : ''}`}>{option.label}</span>
                      {selected && <CheckIcon className="h-3.5 w-3.5 text-claude-accent flex-shrink-0" />}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default ThemedSelect; 