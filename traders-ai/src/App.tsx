import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  actOnAlert,
  fetchDashboard,
  runDaily,
  setLiveTrading,
  syncBroker,
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
          <p className="alert-kicker">
            AI 선정 · {isBuy ? '매수' : '매도'}
            {alert.selectionSource ? ` · ${alert.selectionSource}` : ''}
          </p>
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
      {alert.howToInvest && (
        <p className="playbook">
          <strong>투자 방식</strong> {alert.howToInvest}
          {alert.horizon ? ` (기간: ${alert.horizon})` : ''}
        </p>
      )}

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
          <dt>전략</dt>
          <dd>{alert.strategy ?? '—'}</dd>
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
          {isBuy ? 'AI 추천 금액으로 투자할까요?' : 'AI 추천 금액으로 매도할까요?'}
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
          종목·전략은 AI가 골랐습니다. 금액만 확인/수정하면 모드 한도 안에서 체결합니다.
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
  const [notice, setNotice] = useState<string | null>(null);
  const [liveConfirm, setLiveConfirm] = useState('');
  const [brokerBusy, setBrokerBusy] = useState(false);

  const refresh = useCallback(async () => {
    const data = await fetchDashboard();
    setDash(data);
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
      setNotice(`${data.modeProfile.label} 모드로 전환했습니다. 다음 AI 선정부터 적용됩니다.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '모드 변경 실패');
    }
  }

  async function onScan(force = false) {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      const data = await runDaily(force);
      setDash(data);
      if (data.skippedReason) setNotice(data.skippedReason);
      else
        setNotice(
          `${data.universeSummary ?? 'AI 선정 완료'} · 스캔 ${data.scanned} · 알림 ${data.createdCount ?? 0}건`,
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

  async function onSyncBroker() {
    setBrokerBusy(true);
    setError(null);
    try {
      const data = await syncBroker();
      setDash(data);
      setNotice(data.broker.message);
    } catch (e) {
      setError(e instanceof Error ? e.message : '브로커 동기화 실패');
    } finally {
      setBrokerBusy(false);
    }
  }

  async function onArmLive(arm: boolean) {
    setBrokerBusy(true);
    setError(null);
    try {
      const data = await setLiveTrading(arm, arm ? liveConfirm : '');
      setDash(data);
      setLiveConfirm('');
      setNotice(arm ? '실주문이 활성화되었습니다. 실제 돈이 움직입니다.' : '실주문을 잠갔습니다.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '실주문 설정 실패');
    } finally {
      setBrokerBusy(false);
    }
  }

  function venueBadge(dash: Dashboard) {
    if (!dash.broker.configured) return `로컬 모의 · ${modeLabel}`;
    if (!dash.broker.connected) return `토스 연결 실패 · ${modeLabel}`;
    return dash.liveTradingArmed
      ? `토스 LIVE · ${modeLabel}`
      : `토스 연결(잠금) · ${modeLabel}`;
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
        <p className={`badge ${dash.liveTradingArmed ? 'live' : ''}`}>{venueBadge(dash)}</p>
      </header>

      <main className="shell">
        <section className="hero">
          <div className="hero-copy">
            <h1>모드만 고르면, 종목과 투자 방식은 AI가 매일 고릅니다</h1>
            <p>
              관심종목을 넣을 필요 없습니다. AI가 모드에 맞게 종목을 고르고, 어떻게 들어갈지
              정리해 알림을 보냅니다. 사용자는 금액만 확인하면 됩니다.
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

        <section className="panel broker">
          <div className="controls-head">
            <div>
              <h2>계좌 연동 (토스증권)</h2>
              <p>{dash.broker.message}</p>
              {dash.broker.error && <p className="broker-error">{dash.broker.error}</p>}
            </div>
            <div className="controls-actions">
              <button
                type="button"
                className="ghost"
                disabled={brokerBusy || !dash.broker.configured}
                onClick={onSyncBroker}
              >
                {brokerBusy ? '동기화 중…' : '잔고 동기화'}
              </button>
            </div>
          </div>

          {!dash.broker.configured ? (
            <ol className="setup-steps">
              <li>
                토스증권 WTS/앱 → 설정 →{' '}
                <a href="https://developers.tossinvest.com/docs" target="_blank" rel="noreferrer">
                  Open API
                </a>
                에서 <code>client_id</code>, <code>client_secret</code> 발급
              </li>
              <li>같은 메뉴에서 <strong>허용 IP</strong>에 이 PC/서버 IP 등록</li>
              <li>
                <code>/workspace/traders-ai/.env</code>에{' '}
                <code>TOSS_CLIENT_ID</code>, <code>TOSS_CLIENT_SECRET</code> 입력
              </li>
              <li>서버 재시작 후 잔고 동기화 → 필요할 때만 아래에서 LIVE 활성화</li>
            </ol>
          ) : (
            <dl className="mode-limits">
              <div>
                <dt>연결</dt>
                <dd>{dash.broker.connected ? 'OK' : '실패'}</dd>
              </div>
              <div>
                <dt>증권사</dt>
                <dd>토스증권</dd>
              </div>
              <div>
                <dt>매수가능</dt>
                <dd>
                  {dash.broker.account
                    ? money(dash.broker.account.buyingPower, dash.broker.account.currency)
                    : '—'}
                </dd>
              </div>
              <div>
                <dt>실주문</dt>
                <dd>{dash.liveTradingArmed ? '해제됨' : '잠김'}</dd>
              </div>
            </dl>
          )}

          {dash.broker.configured && (
            <div className="live-arm">
              {dash.liveTradingArmed ? (
                <button
                  type="button"
                  className="ghost danger"
                  disabled={brokerBusy}
                  onClick={() => onArmLive(false)}
                >
                  실주문 잠그기
                </button>
              ) : (
                <>
                  <label htmlFor="live-confirm">
                    토스 실주문 켜려면 아래칸에 <strong>LIVE</strong> 입력
                  </label>
                  <div className="watch-row">
                    <input
                      id="live-confirm"
                      value={liveConfirm}
                      onChange={(e) => setLiveConfirm(e.target.value)}
                      placeholder="LIVE"
                      autoComplete="off"
                    />
                    <button
                      type="button"
                      className="primary danger"
                      disabled={brokerBusy || liveConfirm.trim().toUpperCase() !== 'LIVE'}
                      onClick={() => onArmLive(true)}
                    >
                      실주문 활성화
                    </button>
                  </div>
                  <p className="hint">
                    토스증권 실계좌로 주문이 나갑니다. 잠금 상태에선 로컬 모의만 합니다.
                  </p>
                </>
              )}
            </div>
          )}
        </section>

        <section className="panel controls">
          <div className="controls-head">
            <div>
              <h2>AI 일일 종목 선정</h2>
              <p>
                {dash.lastUniverseSummary ?? '아직 선정 없음'}
                {dash.lastDailyRunAt
                  ? ` · ${new Date(dash.lastDailyRunAt).toLocaleString('ko-KR')}`
                  : ''}
              </p>
            </div>
            <div className="controls-actions">
              <button
                type="button"
                className="primary"
                disabled={scanning}
                onClick={() => onScan(false)}
              >
                {scanning ? 'AI 선정 중…' : '오늘 AI 선정 실행'}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={scanning}
                onClick={() => onScan(true)}
              >
                강제 재선정
              </button>
            </div>
          </div>

          {(dash.lastUniverseSymbols?.length ?? 0) > 0 && (
            <p className="universe-symbols">
              스캔 유니버스: {(dash.lastUniverseSymbols ?? []).slice(0, 16).join(', ')}
              {(dash.lastUniverseSymbols?.length ?? 0) > 16 ? ' …' : ''}
            </p>
          )}

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
          <h2>AI 오늘의 투자 제안</h2>
          {pending.length === 0 ? (
            <p className="empty">
              {dash.lastDailyRunDate
                ? '오늘 AI 선정 기준, 실행할 매수/매도 제안이 없습니다. 모드를 바꾸거나 강제 재선정을 해보세요.'
                : '아직 AI 선정이 없습니다. 「오늘 AI 선정 실행」을 누르세요.'}
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
                        {t.venue ? ` · ${t.venue}` : ''}
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
