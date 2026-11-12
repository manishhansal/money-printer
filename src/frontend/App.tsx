/**
 * App.tsx — MoneyPrinter Quantitative Trading Terminal
 *
 * Full 13-panel navigation:
 *  1. Overview          6. Live Trading     11. Risk Center
 *  2. Market Scanner    7. Positions        12. System Health
 *  3. Options Intel     8. Orders           13. Settings
 *  4. Active Signals    9. Trade Journal
 *  5. Paper Trading    10. Strategy Analytics
 */

import React, { useState, useCallback } from 'react';
import { TopBar } from './components/TopBar';
import { EngineCard, EngineStats } from './components/EngineCard';
import { PositionsTable, PositionRow } from './components/PositionsTable';
import { SignalList, SignalItem } from './components/SignalList';
import { LiveControls } from './components/LiveControls';
import { SquareOffTimer } from './components/SquareOffTimer';
import { RiskCenter } from './components/RiskCenter';
import { SystemHealth } from './components/SystemHealth';
import { MarketScanner } from './panels/MarketScanner';
import { OptionsIntelligencePanel } from './panels/OptionsIntelligencePanel';
import { OrdersPanel } from './panels/OrdersPanel';
import { TradeJournalPanel } from './panels/TradeJournalPanel';
import { StrategyAnalytics } from './panels/StrategyAnalytics';
import { SettingsPanel } from './panels/SettingsPanel';
import { MarketIntelligence } from './panels/MarketIntelligence';
import { useWebSocket, WsMessage, WsStatus } from './hooks/useWebSocket';
import { useApi } from './hooks/useApi';

// ─── Types ────────────────────────────────────────────────────────────────────

interface PortfolioSummary {
  paper?: EngineStats;
  live?: EngineStats;
}

interface SignalRanked {
  signals?: SignalItem[];
}

type NavItem = {
  id: string;
  label: string;
  icon: string;
};

// ─── Navigation ───────────────────────────────────────────────────────────────

const NAV_ITEMS: NavItem[] = [
  { id: 'overview', label: 'Overview', icon: '⚡' },
  { id: 'scanner', label: 'Market Scanner', icon: '📡' },
  { id: 'options', label: 'Options Intel', icon: '⚗️' },
  { id: 'signals', label: 'Active Signals', icon: '🎯' },
  { id: 'paper', label: 'Paper Trading', icon: '📄' },
  { id: 'live', label: 'Live Trading', icon: '🔴' },
  { id: 'positions', label: 'Positions', icon: '📊' },
  { id: 'orders', label: 'Orders', icon: '📋' },
  { id: 'journal', label: 'Trade Journal', icon: '📒' },
  { id: 'analytics', label: 'Strategy Analytics', icon: '📈' },
  { id: 'risk', label: 'Risk Center', icon: '⚠️' },
  { id: 'health', label: 'System Health', icon: '💡' },
  { id: 'settings', label: 'Settings', icon: '⚙️' },
];

// ─── Panel helper ─────────────────────────────────────────────────────────────

function Panel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.ReactElement {
  return (
    <div
      style={{
        background: '#131720',
        border: '1px solid #1a2235',
        borderRadius: 4,
        marginBottom: 10,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '7px 14px',
          background: '#0d1117',
          borderBottom: '1px solid #1a2235',
          fontSize: 9,
          fontWeight: 700,
          letterSpacing: 2,
          color: '#4b6080',
          textTransform: 'uppercase' as const,
          fontFamily: 'monospace',
        }}
      >
        {title}
      </div>
      <div style={{ padding: '12px 14px' }}>{children}</div>
    </div>
  );
}

// ─── App ──────────────────────────────────────────────────────────────────────

export function App(): React.ReactElement {
  const [activePanel, setActivePanel] = useState('overview');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sessionPhase, setSessionPhase] = useState<string>('—');
  const [alerts, setAlerts] = useState<
    Array<{ id: string; priority: string; title: string; message: string }>
  >([]);
  const [livePositions, setLivePositions] = useState<PositionRow[]>([]);
  const [wsStatus, setWsStatus] = useState<WsStatus>('CONNECTING');

  const handleWs = useCallback((msg: WsMessage) => {
    if (msg.event === 'session_phase') {
      const data = msg.data as Record<string, unknown>;
      if (typeof data?.['phase'] === 'string') setSessionPhase(data['phase'] as string);
    }
    if (msg.event === 'notification') {
      const n = msg.data as { id: string; priority: string; title: string; message: string };
      setAlerts((prev) => [n, ...prev].slice(0, 30));
    }
    if (msg.event === 'position_update') {
      const p = msg.data as PositionRow;
      setLivePositions((prev) => {
        const idx = prev.findIndex((x) => x.id === p.id);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = p;
          return next;
        }
        return [...prev, p];
      });
    }
  }, []);

  const ws = useWebSocket(handleWs);
  // Update wsStatus based on ws connection
  React.useEffect(() => {
    setWsStatus(ws);
  }, [ws]);

  const { data: summary } = useApi<PortfolioSummary>('/portfolio/summary', 5_000);
  const { data: signalsData } = useApi<SignalRanked>('/signals/ranked', 10_000);
  const { data: paperPositions } = useApi<PositionRow[]>('/paper-trading/positions', 5_000);

  const SIDEBAR_W = sidebarOpen ? 180 : 44;

  return (
    <div
      style={{
        background: '#0b0d12',
        color: '#dde4f0',
        minHeight: '100vh',
        fontFamily: "'SF Mono','Fira Code','Consolas',monospace",
        fontSize: 12,
      }}
    >
      <TopBar wsStatus={wsStatus} sessionPhase={sessionPhase} />

      <div style={{ display: 'flex', height: 'calc(100vh - 40px)' }}>
        {/* ── Sidebar navigation ── */}
        <div
          style={{
            width: SIDEBAR_W,
            flexShrink: 0,
            background: '#0d1117',
            borderRight: '1px solid #1a2235',
            display: 'flex',
            flexDirection: 'column',
            transition: 'width 0.15s ease',
            overflow: 'hidden',
          }}
        >
          {/* Toggle button */}
          <button
            onClick={() => setSidebarOpen(!sidebarOpen)}
            style={{
              padding: '10px',
              border: 'none',
              background: 'transparent',
              color: '#4b6080',
              cursor: 'pointer',
              textAlign: 'left',
              fontSize: 14,
              borderBottom: '1px solid #1a2235',
              flexShrink: 0,
            }}
            title={sidebarOpen ? 'Collapse sidebar' : 'Expand sidebar'}
          >
            {sidebarOpen ? '◀' : '▶'}
          </button>

          {/* Nav items */}
          <div style={{ flex: 1, overflowY: 'auto', overflowX: 'hidden' }}>
            {NAV_ITEMS.map((item) => {
              const active = activePanel === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActivePanel(item.id)}
                  title={item.label}
                  style={{
                    width: '100%',
                    padding: sidebarOpen ? '8px 14px' : '10px',
                    border: 'none',
                    background: active ? '#1a2235' : 'transparent',
                    color: active ? '#dde4f0' : '#4b6080',
                    textAlign: 'left',
                    cursor: 'pointer',
                    borderLeft: active ? '2px solid #00d4aa' : '2px solid transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontSize: sidebarOpen ? 11 : 14,
                    fontFamily: 'monospace',
                    transition: 'background 0.1s',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                  }}
                >
                  <span style={{ flexShrink: 0, fontSize: 13 }}>{item.icon}</span>
                  {sidebarOpen && <span>{item.label}</span>}
                </button>
              );
            })}
          </div>
        </div>

        {/* ── Main content ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px' }}>
          {/* OVERVIEW */}
          {activePanel === 'overview' && (
            <div>
              {/* Market intelligence */}
              <Panel title="📊 Market Intelligence">
                <MarketIntelligence />
              </Panel>

              {/* Engine P&L cards */}
              <div style={{ display: 'flex', gap: 10, marginBottom: 10, flexWrap: 'wrap' }}>
                <EngineCard
                  label="📄 PAPER ENGINE"
                  color="#00d4aa"
                  stats={summary?.paper ?? null}
                />
                <EngineCard label="🔴 LIVE ENGINE" color="#3b82f6" stats={summary?.live ?? null} />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 10 }}>
                <div>
                  <Panel title={`📄 Paper Positions (${(paperPositions ?? []).length})`}>
                    <PositionsTable positions={paperPositions ?? []} engine="PAPER" />
                  </Panel>
                  <Panel
                    title={`🔴 Live Positions (${livePositions.filter((p) => p.engine === 'LIVE').length})`}
                  >
                    <PositionsTable positions={livePositions} engine="LIVE" />
                  </Panel>
                  {alerts.length > 0 && (
                    <Panel title={`🔔 Alerts (${alerts.length})`}>
                      {alerts.slice(0, 5).map((a) => (
                        <div
                          key={a.id}
                          style={{
                            padding: '5px 8px',
                            marginBottom: 4,
                            borderRadius: 3,
                            borderLeft: `3px solid ${a.priority === 'MAX' || a.priority === 'CRITICAL' ? '#ef4444' : a.priority === 'WARNING' ? '#f59e0b' : '#3b82f6'}`,
                            background: '#0d1117',
                            fontSize: 10,
                          }}
                        >
                          <div style={{ fontWeight: 700, marginBottom: 2 }}>{a.title}</div>
                          <div style={{ color: '#4b6080' }}>{a.message.slice(0, 100)}</div>
                        </div>
                      ))}
                    </Panel>
                  )}
                </div>
                <div>
                  <Panel title="🔴 Live Controls">
                    <LiveControls />
                  </Panel>
                  <Panel title="⏱ Square-Off Schedule">
                    <SquareOffTimer />
                  </Panel>
                  <Panel title="⚠ Risk Center">
                    <RiskCenter />
                  </Panel>
                  <Panel title="💡 System Health">
                    <SystemHealth />
                  </Panel>
                </div>
              </div>
            </div>
          )}

          {/* MARKET SCANNER */}
          {activePanel === 'scanner' && (
            <Panel title="📡 Market Scanner — Ranked Opportunities">
              <MarketScanner />
            </Panel>
          )}

          {/* OPTIONS INTELLIGENCE */}
          {activePanel === 'options' && (
            <Panel title="⚗️ Options Intelligence — Live Chain">
              <OptionsIntelligencePanel />
            </Panel>
          )}

          {/* ACTIVE SIGNALS */}
          {activePanel === 'signals' && (
            <Panel title={`🎯 Active Signals (${signalsData?.signals?.length ?? 0})`}>
              <SignalList signals={signalsData?.signals ?? []} />
            </Panel>
          )}

          {/* PAPER TRADING */}
          {activePanel === 'paper' && (
            <div>
              <Panel title="📄 Paper Engine — Open Positions">
                <PositionsTable positions={paperPositions ?? []} engine="PAPER" />
              </Panel>
              <Panel title="📊 Paper Performance">
                <StrategyAnalytics />
              </Panel>
            </div>
          )}

          {/* LIVE TRADING */}
          {activePanel === 'live' && (
            <div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 320px', gap: 10 }}>
                <Panel title="🔴 Live Positions">
                  <PositionsTable positions={livePositions} engine="LIVE" />
                </Panel>
                <div>
                  <Panel title="🔴 Engine Controls">
                    <LiveControls />
                  </Panel>
                  <Panel title="⏱ Square-Off Schedule">
                    <SquareOffTimer />
                  </Panel>
                </div>
              </div>
            </div>
          )}

          {/* POSITIONS */}
          {activePanel === 'positions' && (
            <div>
              <Panel title="📄 Paper Positions">
                <PositionsTable positions={paperPositions ?? []} engine="PAPER" />
              </Panel>
              <Panel title="🔴 Live Positions">
                <PositionsTable positions={livePositions} engine="LIVE" />
              </Panel>
            </div>
          )}

          {/* ORDERS */}
          {activePanel === 'orders' && (
            <Panel title="📋 Today's Orders">
              <OrdersPanel />
            </Panel>
          )}

          {/* TRADE JOURNAL */}
          {activePanel === 'journal' && (
            <Panel title="📒 Trade Journal — Today's Closed Trades">
              <TradeJournalPanel />
            </Panel>
          )}

          {/* STRATEGY ANALYTICS */}
          {activePanel === 'analytics' && (
            <Panel title="📈 Strategy Analytics">
              <StrategyAnalytics />
            </Panel>
          )}

          {/* RISK CENTER */}
          {activePanel === 'risk' && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <Panel title="⚠ Risk Center — Live & Paper">
                <RiskCenter />
              </Panel>
              <Panel title="⏱ Square-Off Schedule">
                <SquareOffTimer />
              </Panel>
            </div>
          )}

          {/* SYSTEM HEALTH */}
          {activePanel === 'health' && (
            <Panel title="💡 System Health">
              <SystemHealth />
            </Panel>
          )}

          {/* SETTINGS */}
          {activePanel === 'settings' && (
            <Panel title="⚙️ Settings">
              <SettingsPanel />
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}
