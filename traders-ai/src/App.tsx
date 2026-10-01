import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  actOnAlert,
  fetchDashboard,
  runDaily,
  updateSettings,
  type DailyAlert,
  type Dashboard,
  type TraderMode,
} from './types';
import './App.css';

function money(n: number, currency = 'USD') {
  try {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency}`;
  }
}

function ModeCard({
  id,
  label,
  description,
  active,
  onSelect,
}: {
  id: TraderMode;
  label: string;
  description: string;
  active: boolean;
  onSelect: (id: TraderMode) => void;
}) {
  return (
    <button
      type="button"
      className={`mode-card mode-${id} ${active ? 'active' : ''}`}
      onClick={() => onSelect(id)}
      aria-pressed={active}
    >
      <strong>{label}</strong>
      <span>{description}</span>
    </button>
  );
}

function AlertCard({
  alert,
  busyId,
  onExecute,
  onSkip,
}: {
  alert: DailyAlert;
  busyId: string | null;
  onExecute: (alert: DailyAlert, amount: number) => void;
  onSkip: (alert: DailyAlert) => void;
}) {
  const [amount, setAmount] = useState(String(Math.round(alert.suggestedAmount)));
  const busy = busyId === alert.id;
  const isBuy = alert.side === 'buy';

  return (
    <article className={`alert-card ${alert.side}`}>
      <header>
        <div>
          <p className="alert-kicker">{isBuy ? '오늘 매수 알림' : '오늘 매도 알림'}</p>
          <h3>
            {alert.name} <span>{alert.symbol}</span>
          </h3>
        </div>
        <div className="score">
          <em>{alert.score}</em>
          <span>신호강도</span>
        </div>
      </header>

      <p className="thesis">{alert.thesis}</p>

      <dl className="metrics">
        <div>
          <dt>현재가</dt>
          <dd>{money(alert.researchSummary.price, alert.currency)}</dd>
        </div>
        <div>
          <dt>{isBuy ? '목표' : '목표 이탈'}</dt>
          <dd>{money(alert.target, alert.currency)}</dd>
        </div>
        <div>
          <dt>손절/무효</dt>
          <dd>{money(alert.stop, alert.currency)}</dd>
        </div>
        <div>
          <dt>RSI</dt>
          <dd>{alert.researchSummary.rsi14 ?? '—'}</dd>
        </div>
      </dl>

      {alert.researchSummary.newsTitles.length > 0 && (
        <ul className="news">
          {alert.researchSummary.newsTitles.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      )}

      <div className="amount-box">
        <label htmlFor={`amt-${alert.id}`}>
          {isBuy ? '얼마를 투자할까요?' : '얼마를 매도할까요?'}
        </label>
        <div className="amount-row">
          <input
            id={`amt-${alert.id}`}
            type="number"
            min={0}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            disabled={busy}
          />
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => setAmount(String(Math.round(alert.suggestedAmount)))}
          >
            추천 {money(alert.suggestedAmount, alert.currency)}
          </button>
          <button
            type="button"
            className="ghost"
            disabled={busy}
            onClick={() => setAmount(String(Math.round(alert.maxAmount)))}
          >
            최대 {money(alert.maxAmount, alert.currency)}
          </button>
        </div>
        <p className="hint">
          금액만 입력하면 AI가 모드 한도 안에서 수량·체결을 결정합니다. (모의투자)
        </p>
      </div>

      <footer>
        <button
          type="button"
          className="primary"
          disabled={busy}
          onClick={() => onExecute(alert, Number(amount))}
        >
          {busy ? '처리 중…' : isBuy ? '이 금액으로 매수 실행' : '이 금액으로 매도 실행'}
        </button>
        <button type="button" className="ghost" disabled={busy} onClick={() => onSkip(alert)}>
          오늘은 건너뛰기
        </button>
      </footer>
    </article>
  );
}

export default function App() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watchlistText, setWatchlistText] = useState('');
  const [notice, setNotice] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetchDashboard();
    setDash(data);
    setWatchlistText(data.watchlist.join(', '));
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : '로드 실패'))
      .finally(() => setLoading(false));
  }, [refresh]);

  const pending = dash?.pendingAlerts ?? [];

  const modeLabel = useMemo(() => dash?.modeProfile.label ?? '', [dash]);

  async function onMode(mode: TraderMode) {
    setError(null);
    try {
      const data = await updateSettings({ mode });
      setDash(data);
      setNotice(`${data.modeProfile.label} 모드로 전환했습니다. 다음 일일 분석부터 적용됩니다.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '모드 변경 실패');
    }
  }

  async function onSaveWatchlist() {
    setError(null);
    try {
      const list = watchlistText
        .split(/[,\s]+/)
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean);
      const data = await updateSettings({ watchlist: list });
      setDash(data);
      setNotice('관심종목을 저장했습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '관심종목 저장 실패');
    }
  }

  async function onScan(force = false) {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const data = await runDaily(force);
      setDash(data);
      setWatchlistText(data.watchlist.join(', '));
      if (data.skippedReason) setNotice(data.skippedReason);
      else
        setNotice(
          `자동 분석 완료: ${data.scanned}종목 스캔, 신규 알림 ${data.createdCount ?? 0}건`,
        );
    } catch (e) {
      setError(e instanceof Error ? e.message : '일일 분석 실패');
    } finally {
      setScanning(false);
    }
  }

  async function onExecute(alert: DailyAlert, amount: number) {
    setBusyId(alert.id);
    setError(null);
    try {
      const data = await actOnAlert(alert.id, amount, 'execute');
      setDash(data);
      setNotice(data.alert?.executionNote ?? '체결 완료');
    } catch (e) {
      setError(e instanceof Error ? e.message : '체결 실패');
    } finally {
      setBusyId(null);
    }
  }

  async function onSkip(alert: DailyAlert) {
    setBusyId(alert.id);
    setError(null);
    try {
      const data = await actOnAlert(alert.id, 0, 'skip');
      setDash(data);
      setNotice('알림을 건너뛰었습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '처리 실패');
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="page boot">
        <p>TRADERS AI 로딩 중…</p>
      </div>
    );
  }

  if (!dash) {
    return (
      <div className="page boot">
        <p>{error ?? '대시보드를 불러오지 못했습니다.'}</p>
        <button type="button" className="primary" onClick={() => location.reload()}>
          다시 시도
        </button>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">TRADERS AI</p>
          <p className="brand-sub">매일 분석 · 알림 · 금액만 입력하면 실행</p>
        </div>
        <p className="badge">모의투자 · {modeLabel}</p>
      </header>

      <main className="shell">
        <section className="hero">
          <div className="hero-copy">
            <h1>모드를 고르고, 매일 오는 알림에 금액만 답하세요</h1>
            <p>
              시세·차트·뉴스는 앱이 스스로 조사합니다. 사용자는 안전형 / 밸런스형 / 수익형을
              선택하고, 매수·매도 알림에 금액을 입력하면 AI가 수량과 체결을 결정합니다.
            </p>
          </div>

          <div className="mode-grid" role="group" aria-label="투자 모드">
            {dash.modes.map((m) => (
              <ModeCard
                key={m.id}
                id={m.id}
                label={m.label}
                description={m.description}
                active={dash.mode === m.id}
                onSelect={onMode}
              />
            ))}
          </div>
        </section>

        <section className="stats">
          <div>
            <span>총자산</span>
            <strong>{money(dash.equity, dash.currency)}</strong>
          </div>
          <div>
            <span>현금</span>
            <strong>{money(dash.cash, dash.currency)}</strong>
          </div>
          <div>
            <span>손익</span>
            <strong className={dash.pnl >= 0 ? 'up' : 'down'}>
              {money(dash.pnl, dash.currency)} ({dash.pnlPct}%)
            </strong>
          </div>
          <div>
            <span>대기 알림</span>
            <strong>{pending.length}</strong>
          </div>
        </section>

        <section className="panel controls">
          <div className="controls-head">
            <div>
              <h2>일일 자동 분석</h2>
              <p>
                마지막 실행:{' '}
                {dash.lastDailyRunAt
                  ? new Date(dash.lastDailyRunAt).toLocaleString('ko-KR')
                  : '아직 없음'}
              </p>
            </div>
            <div className="controls-actions">
              <button
                type="button"
                className="primary"
                disabled={scanning}
                onClick={() => onScan(false)}
              >
                {scanning ? '분석 중…' : '오늘 분석 실행'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={scanning}
                onClick={() => onScan(true)}
              >
                강제 재분석
              </button>
            </div>
          </div>

          <label className="watch-label" htmlFor="watchlist">
            관심종목 (쉼표 구분)
          </label>
          <div className="watch-row">
            <input
              id="watchlist"
              value={watchlistText}
              onChange={(e) => setWatchlistText(e.target.value)}
              placeholder="AAPL, MSFT, NVDA"
            />
            <button type="button" className="ghost" onClick={onSaveWatchlist}>
              저장
            </button>
          </div>

          <dl className="mode-limits">
            <div>
              <dt>1회 손실한도</dt>
              <dd>{dash.modeProfile.riskPercent}%</dd>
            </div>
            <div>
              <dt>종목 최대비중</dt>
              <dd>{dash.modeProfile.maxPositionPct}%</dd>
            </div>
            <div>
              <dt>현금 최소</dt>
              <dd>{dash.modeProfile.minCashPct}%</dd>
            </div>
            <div>
              <dt>매수 알림 상한</dt>
              <dd>{dash.modeProfile.maxDailyBuyAlerts}건/일</dd>
            </div>
          </dl>
        </section>

        {(error || notice) && (
          <div className={`toast ${error ? 'error' : 'ok'}`} role="status">
            {error ?? notice}
          </div>
        )}

        <section className="panel">
          <h2>오늘의 알림</h2>
          {pending.length === 0 ? (
            <p className="empty">
              {dash.lastDailyRunDate
                ? '오늘 분석 기준, 모드 조건을 통과한 매수/매도 알림이 없습니다. 모드를 바꾸거나 강제 재분석을 해보세요.'
                : '아직 일일 분석이 없습니다. 「오늘 분석 실행」으로 관심종목을 스캔하세요.'}
            </p>
          ) : (
            <div className="alert-list">
              {pending.map((a) => (
                <AlertCard
                  key={a.id}
                  alert={a}
                  busyId={busyId}
                  onExecute={onExecute}
                  onSkip={onSkip}
                />
              ))}
            </div>
          )}
        </section>

        <section className="split">
          <div className="panel">
            <h2>보유 포지션</h2>
            {dash.positions.length === 0 ? (
              <p className="empty">보유 종목 없음</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>수량</th>
                    <th>평단</th>
                    <th>평가</th>
                    <th>손익</th>
                  </tr>
                </thead>
                <tbody>
                  {dash.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td>
                        {p.symbol}
                        <small>{p.name}</small>
                      </td>
                      <td>{p.shares}</td>
                      <td>{money(p.avgPrice, p.currency)}</td>
                      <td>{money(p.marketValue, p.currency)}</td>
                      <td className={p.pnl >= 0 ? 'up' : 'down'}>
                        {money(p.pnl, p.currency)} ({p.pnlPct}%)
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>최근 체결</h2>
            {dash.trades.length === 0 ? (
              <p className="empty">체결 이력 없음</p>
            ) : (
              <ul className="trades">
                {dash.trades.slice(0, 8).map((t) => (
                  <li key={t.id}>
                    <div>
                      <strong>
                        {t.side === 'buy' ? '매수' : '매도'} {t.symbol}
                      </strong>
                      <span>
                        {t.shares}주 · {money(t.amount, dash.currency)}
                      </span>
                    </div>
                    <small>{new Date(t.at).toLocaleString('ko-KR')}</small>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>

        <p className="disclaimer">{dash.disclaimer}</p>
      </main>
    </div>
  );
}
