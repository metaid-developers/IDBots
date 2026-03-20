import React, { useEffect, useState } from 'react';

interface P2PConfig {
  p2p_sync_mode: 'self' | 'selective' | 'full';
  p2p_selective_addresses?: string[];
  p2p_selective_paths?: string[];
  p2p_block_addresses?: string[];
  p2p_block_paths?: string[];
  p2p_max_content_size_kb?: number;
  p2p_bootstrap_nodes: string[];
  p2p_enable_relay: boolean;
  p2p_storage_limit_gb: number;
}

const lines = (text: string) => text.split('\n').map(s => s.trim()).filter(Boolean);

const SYNC_MODE_OPTIONS: { value: P2PConfig['p2p_sync_mode']; label: string; description: string }[] = [
  {
    value: 'self',
    label: 'Self',
    description: 'Only sync PINs from your own MetaID addresses',
  },
  {
    value: 'selective',
    label: 'Selective',
    description: 'Sync PINs matching configured addresses/paths',
  },
  {
    value: 'full',
    label: 'Full',
    description: 'Sync all PINs from the network',
  },
];

const inputClass =
  'w-full rounded-md border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 px-3 py-2 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500';

const labelClass = 'text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2';

export const P2PConfigPanel: React.FC = () => {
  const [config, setConfig] = useState<Partial<P2PConfig>>({});
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<'ok' | 'error' | null>(null);

  useEffect(() => {
    window.electron.p2p.getConfig().then(c => setConfig(c as P2PConfig));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveResult(null);
    try {
      await window.electron.p2p.setConfig(config);
      setSaveResult('ok');
    } catch {
      setSaveResult('error');
    } finally {
      setSaving(false);
      setTimeout(() => setSaveResult(null), 3000);
    }
  };

  const syncMode = config.p2p_sync_mode ?? 'self';
  const isSelective = syncMode === 'selective';

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">

      {/* Sync Mode */}
      <div>
        <div className={labelClass}>Sync Mode</div>
        <div className="space-y-2">
          {SYNC_MODE_OPTIONS.map(opt => (
            <label key={opt.value} className="flex items-start gap-3 cursor-pointer">
              <input
                type="radio"
                name="p2p_sync_mode"
                value={opt.value}
                checked={syncMode === opt.value}
                onChange={() => setConfig(prev => ({ ...prev, p2p_sync_mode: opt.value }))}
                className="mt-0.5 accent-blue-500"
              />
              <div>
                <span className="text-sm text-gray-900 dark:text-gray-100 font-medium">{opt.label}</span>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{opt.description}</p>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Selective addresses — shown only when mode = selective */}
      {isSelective && (
        <div>
          <div className={labelClass}>Selective addresses</div>
          <textarea
            rows={4}
            placeholder="One address per line"
            value={(config.p2p_selective_addresses || []).join('\n')}
            onChange={e =>
              setConfig(prev => ({ ...prev, p2p_selective_addresses: lines(e.target.value) }))
            }
            className={inputClass}
          />
        </div>
      )}

      {/* Selective paths — shown only when mode = selective */}
      {isSelective && (
        <div>
          <div className={labelClass}>Selective paths</div>
          <textarea
            rows={4}
            placeholder="One path per line, e.g. /info/name"
            value={(config.p2p_selective_paths || []).join('\n')}
            onChange={e =>
              setConfig(prev => ({ ...prev, p2p_selective_paths: lines(e.target.value) }))
            }
            className={inputClass}
          />
        </div>
      )}

      {/* Block addresses */}
      <div>
        <div className={labelClass}>Block addresses</div>
        <textarea
          rows={4}
          placeholder="One address per line"
          value={(config.p2p_block_addresses || []).join('\n')}
          onChange={e =>
            setConfig(prev => ({ ...prev, p2p_block_addresses: lines(e.target.value) }))
          }
          className={inputClass}
        />
      </div>

      {/* Block paths */}
      <div>
        <div className={labelClass}>Block paths</div>
        <textarea
          rows={4}
          placeholder="One path per line"
          value={(config.p2p_block_paths || []).join('\n')}
          onChange={e =>
            setConfig(prev => ({ ...prev, p2p_block_paths: lines(e.target.value) }))
          }
          className={inputClass}
        />
      </div>

      {/* Max content size */}
      <div>
        <div className={labelClass}>Max content size (KB)</div>
        <input
          type="number"
          min={0}
          value={config.p2p_max_content_size_kb ?? 512}
          onChange={e =>
            setConfig(prev => ({ ...prev, p2p_max_content_size_kb: Number(e.target.value) }))
          }
          className={inputClass}
        />
      </div>

      {/* Bootstrap nodes */}
      <div>
        <div className={labelClass}>Bootstrap nodes</div>
        <textarea
          rows={4}
          placeholder="One multiaddr per line"
          value={(config.p2p_bootstrap_nodes || []).join('\n')}
          onChange={e =>
            setConfig(prev => ({ ...prev, p2p_bootstrap_nodes: lines(e.target.value) }))
          }
          className={inputClass}
        />
      </div>

      {/* Enable relay */}
      <div>
        <label className="flex items-center gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={config.p2p_enable_relay ?? true}
            onChange={e =>
              setConfig(prev => ({ ...prev, p2p_enable_relay: e.target.checked }))
            }
            className="accent-blue-500 w-4 h-4"
          />
          <span className="text-sm font-semibold text-gray-700 dark:text-gray-300">Enable circuit relay</span>
        </label>
      </div>

      {/* Storage limit */}
      <div>
        <div className={labelClass}>Storage limit (GB)</div>
        <input
          type="number"
          min={1}
          value={config.p2p_storage_limit_gb ?? 10}
          onChange={e =>
            setConfig(prev => ({ ...prev, p2p_storage_limit_gb: Number(e.target.value) }))
          }
          className={inputClass}
        />
      </div>

      {/* Save button */}
      <div className="flex items-center gap-3">
        <button
          onClick={handleSave}
          disabled={saving}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saveResult === 'ok' && (
          <span className="text-sm text-green-600 dark:text-green-400">Saved</span>
        )}
        {saveResult === 'error' && (
          <span className="text-sm text-red-600 dark:text-red-400">Save failed</span>
        )}
      </div>

    </div>
  );
};

export default P2PConfigPanel;
