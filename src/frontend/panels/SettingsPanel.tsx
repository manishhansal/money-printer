import React, { useState, useEffect } from 'react';
import { useApi, apiPost } from '../hooks/useApi';

interface SettingsData {
  paperStartingCapital: string;
  liveStartingCapital: string;
  defaultRiskPercentage: string;
  maxDailyLossPercentage: string;
  paperRiskPerTrade: string;
  paperDailyLossLimitRupees: string;
}

export function SettingsPanel(): React.ReactElement {
  const { data, refetch } = useApi<SettingsData>('/settings', 60_000);

  const [paperCapital, setPaperCapital] = useState('');
  const [riskPct, setRiskPct] = useState('');
  const [dailyLossPct, setDailyLossPct] = useState('');
  const [status, setStatus] = useState<{ msg: string; color: string } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (data) {
      setPaperCapital(parseFloat(data.paperStartingCapital).toFixed(0));
      setRiskPct(parseFloat(data.defaultRiskPercentage).toFixed(2));
      setDailyLossPct(parseFloat(data.maxDailyLossPercentage).toFixed(2));
    }
  }, [data]);

  const capital = parseFloat(paperCapital) || 0;
  const riskRupees = capital > 0 ? ((capital * parseFloat(riskPct)) / 100).toFixed(0) : '—';
  const dailyLimit = capital > 0 ? ((capital * parseFloat(dailyLossPct)) / 100).toFixed(0) : '—';

  async function save(): Promise<void> {
    setSaving(true);
    setStatus(null);
    try {
      await apiPost('/settings', {
        paperStartingCapital: parseFloat(paperCapital).toFixed(2),
        defaultRiskPercentage: parseFloat(riskPct).toFixed(4),
        maxDailyLossPercentage: parseFloat(dailyLossPct).toFixed(4),
      });
      setStatus({ msg: '✓ Settings saved', color: '#22c55e' });
      refetch();
    } catch (e) {
      setStatus({ msg: `✗ Save failed: ${(e as Error).message}`, color: '#ef4444' });
    } finally {
      setSaving(false);
    }
  }

  const label: React.CSSProperties = {
    fontSize: 10,
    color: '#4b6080',
    letterSpacing: 1,
    textTransform: 'uppercase' as const,
    fontFamily: 'monospace',
    marginBottom: 4,
    display: 'block',
  };
  const input: React.CSSProperties = {
    width: '100%',
    padding: '7px 10px',
    background: '#0d1117',
    border: '1px solid #1a2235',
    borderRadius: 3,
    color: '#dde4f0',
    fontFamily: 'monospace',
    fontSize: 12,
    outline: 'none',
    boxSizing: 'border-box' as const,
  };

  return (
    <div style={{ maxWidth: 480 }}>
      <div style={{ marginBottom: 16 }}>
        <label style={label}>Paper Starting Capital (₹)</label>
        <input
          style={input}
          type="number"
          value={paperCapital}
          onChange={(e) => setPaperCapital(e.target.value)}
          min={10000}
          step={10000}
        />
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 16 }}>
        <div>
          <label style={label}>Risk per Trade (%)</label>
          <input
            style={input}
            type="number"
            value={riskPct}
            onChange={(e) => setRiskPct(e.target.value)}
            min={0.1}
            max={5}
            step={0.1}
          />
        </div>
        <div>
          <label style={label}>Max Daily Loss (%)</label>
          <input
            style={input}
            type="number"
            value={dailyLossPct}
            onChange={(e) => setDailyLossPct(e.target.value)}
            min={0.5}
            max={10}
            step={0.5}
          />
        </div>
      </div>

      {/* Derived hints */}
      <div
        style={{
          background: '#0d1117',
          border: '1px solid #1a2235',
          borderRadius: 3,
          padding: '8px 12px',
          marginBottom: 16,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 8,
        }}
      >
        {[
          { l: 'Risk per trade', v: `₹${riskRupees}` },
          { l: 'Daily loss limit', v: `₹${dailyLimit}` },
        ].map(({ l, v }) => (
          <div key={l}>
            <div
              style={{
                fontSize: 9,
                color: '#4b6080',
                textTransform: 'uppercase' as const,
                letterSpacing: 1,
                fontFamily: 'monospace',
              }}
            >
              {l}
            </div>
            <div
              style={{ fontSize: 15, fontWeight: 700, color: '#dde4f0', fontFamily: 'monospace' }}
            >
              {v}
            </div>
          </div>
        ))}
      </div>

      <button
        onClick={() => void save()}
        disabled={saving}
        style={{
          padding: '8px 20px',
          borderRadius: 3,
          border: '1px solid #00d4aa44',
          background: '#00d4aa18',
          color: '#00d4aa',
          fontFamily: 'monospace',
          fontSize: 11,
          fontWeight: 700,
          cursor: saving ? 'not-allowed' : 'pointer',
          opacity: saving ? 0.6 : 1,
          letterSpacing: 1,
          textTransform: 'uppercase' as const,
        }}
      >
        {saving ? 'Saving…' : 'Save Settings'}
      </button>

      {status && (
        <div style={{ marginTop: 10, fontSize: 11, color: status.color, fontFamily: 'monospace' }}>
          {status.msg}
        </div>
      )}
    </div>
  );
}
