'use client';

import React, { useEffect, useState } from 'react';
import {
  clearDebugLogs,
  getDebugLogs,
  subscribeDebugLogs,
  type DebugLogEntry,
} from '#cloud-client';

const DEFAULT_PAYLOAD_LIMIT = 600;
const PAYLOAD_REVEAL_STEP = 8000;

export interface DebuggerConsoleProps {
  /** Optional externally-managed logs; when omitted, subscribes directly to HttpClient logs. */
  logs?: readonly DebugLogEntry[];
  /** Optional clear callback; defaults to HttpClient.clearDebugLogs(). */
  onClearLogs?: () => void;
  /** Whether the console drawer starts expanded (defaults to false). */
  defaultOpen?: boolean;
}

interface TruncatedPayloadDetailProps {
  label: string;
  labelColor: string;
  payload: string;
  totalChars?: number;
  revealedLimit: number;
  onRevealLimitChange: (nextLimit: number) => void;
}

function TruncatedPayloadDetail({
  label,
  labelColor,
  payload,
  totalChars,
  revealedLimit,
  onRevealLimitChange,
}: TruncatedPayloadDetailProps) {
  const total = totalChars ?? payload.length;
  const isTruncated = payload.length > revealedLimit;

  return (
    <div className="debug-log-detail-block">
      <strong style={{ color: labelColor }}>{label}:</strong>{' '}
      {isTruncated ? payload.slice(0, revealedLimit) : payload}
      {isTruncated && (
        <button
          type="button"
          className="debug-reveal-btn"
          onClick={(e) => {
            e.stopPropagation();
            onRevealLimitChange(Math.min(payload.length, revealedLimit + PAYLOAD_REVEAL_STEP));
          }}
          title="Click to reveal more characters"
        >
          … ({total.toLocaleString()} chars — click for more)
        </button>
      )}
      {isTruncated && payload.length - revealedLimit > PAYLOAD_REVEAL_STEP && (
        <button
          type="button"
          className="debug-reveal-btn-muted"
          onClick={(e) => {
            e.stopPropagation();
            onRevealLimitChange(payload.length);
          }}
        >
          Show all
        </button>
      )}
      {revealedLimit > DEFAULT_PAYLOAD_LIMIT && (
        <button
          type="button"
          className="debug-reveal-btn-muted"
          onClick={(e) => {
            e.stopPropagation();
            onRevealLimitChange(DEFAULT_PAYLOAD_LIMIT);
          }}
        >
          Collapse
        </button>
      )}
    </div>
  );
}

/** Collapsible live HTTP & MQTT RPC debugger log drawer. */
export function DebuggerConsole({
  logs,
  onClearLogs,
  defaultOpen = false,
}: DebuggerConsoleProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [subscribedLogs, setSubscribedLogs] = useState<readonly DebugLogEntry[]>(() =>
    logs === undefined ? getDebugLogs() : []
  );
  const [debugFilterTarget, setDebugFilterTarget] = useState<'ALL' | 'TB' | 'FTP'>('ALL');
  const [expandedLogIds, setExpandedLogIds] = useState<Set<number>>(new Set());
  const [revealedCharsByKey, setRevealedCharsByKey] = useState<Record<string, number>>({});

  useEffect(() => {
    if (logs !== undefined) return;
    return subscribeDebugLogs(setSubscribedLogs);
  }, [logs]);

  const activeLogs = logs ?? subscribedLogs;
  const filteredLogs = activeLogs.filter(
    (entry) => debugFilterTarget === 'ALL' || entry.target === debugFilterTarget
  );

  const handleClear = () => {
    if (onClearLogs) {
      onClearLogs();
    } else {
      clearDebugLogs();
    }
    setExpandedLogIds(new Set());
    setRevealedCharsByKey({});
  };

  return (
    <section className="panel" aria-label="Debugger Log Console">
      <div
        className={`panel-header debug-console-header ${
          isOpen ? 'debug-console-header-open' : ''
        }`}
      >
        <div className="debug-console-title-group">
          <button
            type="button"
            className="btn btn-secondary btn-sm"
            aria-expanded={isOpen}
            onClick={() => setIsOpen((prev) => !prev)}
          >
            {isOpen ? '▾' : '▸'} Developer Logs ({activeLogs.length})
          </button>
          {isOpen && (
            <span className="panel-desc debug-console-subtitle">
              Live HTTP &amp; MQTT RPC requests to ThingsBoard (<code>/api</code>) and FtpProxy (
              <code>/api/v2</code>)
            </span>
          )}
        </div>

        {isOpen && (
          <div className="debug-console-actions">
            {(['ALL', 'TB', 'FTP'] as const).map((target) => (
              <button
                key={target}
                type="button"
                className={`btn btn-sm ${
                  debugFilterTarget === target ? 'btn-primary' : 'btn-secondary'
                }`}
                onClick={() => setDebugFilterTarget(target)}
              >
                {target === 'ALL' ? 'All' : target === 'TB' ? 'TB / MQTT RPC' : 'FtpProxy'}
              </button>
            ))}
            <button type="button" className="btn btn-secondary btn-sm" onClick={handleClear}>
              Clear
            </button>
          </div>
        )}
      </div>

      {isOpen && (
        <div className="debug-console-body">
          {filteredLogs.length === 0 ? (
            <div className="debug-console-empty">
              No requests logged yet. Select a machine, fetch a price list, or deploy prices to
              inspect live traffic.
            </div>
          ) : (
            filteredLogs.map((entry) => {
              const isExpanded = expandedLogIds.has(entry.id);
              const isOk =
                typeof entry.status === 'number' && entry.status >= 200 && entry.status < 300;
              const reqKey = `${entry.id}:req`;
              const resKey = `${entry.id}:res`;

              return (
                <div key={entry.id} className="debug-log-row">
                  <div
                    className="debug-log-summary-line"
                    onClick={() =>
                      setExpandedLogIds((prev) => {
                        const next = new Set(prev);
                        if (next.has(entry.id)) {
                          next.delete(entry.id);
                        } else {
                          next.add(entry.id);
                        }
                        return next;
                      })
                    }
                  >
                    <span className="debug-log-timestamp">[{entry.timestamp}]</span>
                    <span
                      className={`debug-log-target ${
                        entry.target === 'TB' ? 'debug-log-target-tb' : 'debug-log-target-ftp'
                      }`}
                    >
                      {entry.target}
                    </span>
                    <span className="debug-log-method">{entry.method}</span>
                    <span className={isOk ? 'debug-log-status-ok' : 'debug-log-status-err'}>
                      {entry.status}
                    </span>
                    <span className="debug-log-summary-text">{entry.summary}</span>
                    <span className="debug-log-duration">{entry.durationMs}ms</span>
                  </div>

                  {isExpanded && (
                    <div className="debug-log-details">
                      <div>
                        <strong style={{ color: '#93c5fd' }}>Endpoint:</strong> {entry.method}{' '}
                        {entry.path}
                      </div>

                      {entry.requestDetail && (
                        <TruncatedPayloadDetail
                          label="Request"
                          labelColor="#fcd34d"
                          payload={entry.requestDetail}
                          totalChars={entry.requestTotalChars}
                          revealedLimit={revealedCharsByKey[reqKey] ?? DEFAULT_PAYLOAD_LIMIT}
                          onRevealLimitChange={(nextLimit) =>
                            setRevealedCharsByKey((prev) => ({ ...prev, [reqKey]: nextLimit }))
                          }
                        />
                      )}

                      {entry.responseDetail && (
                        <TruncatedPayloadDetail
                          label="Response"
                          labelColor="#6ee7b7"
                          payload={entry.responseDetail}
                          totalChars={entry.responseTotalChars}
                          revealedLimit={revealedCharsByKey[resKey] ?? DEFAULT_PAYLOAD_LIMIT}
                          onRevealLimitChange={(nextLimit) =>
                            setRevealedCharsByKey((prev) => ({ ...prev, [resKey]: nextLimit }))
                          }
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </section>
  );
}
