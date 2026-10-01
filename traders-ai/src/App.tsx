import { useCallback, useEffect, useState } from 'react';
import {
  actOnAlert,
  confirmAllPending,
  fetchDashboard,
  getAccessToken,
  setAccessToken,
  syncBroker,
  updateSettings,
  type DailyAlert,
  type Dashboard,
  type TraderMode,
} from './types';
import './App.css';

function money(n: number, currency = 'KRW') {
  try {
    return new Intl.NumberFormat('ko-KR', {
      style: 'currency',
      currency,
      maximumFractionDigits: 0,
    }).format(n);
  } catch {
    return `${n.toLocaleString()} ${currency}`;
  }
}

function ProposalCard({
  alert,
  busyId,
  confirmingAll,
  onDeny,
}: {
  alert: DailyAlert;
  busyId: string | null;
  confirmingAll: boolean;
  onDeny: (alert: DailyAlert) => void;
}) {
  const busy = busyId === alert.id || alert.status === 'executing' || confirmingAll;
  const isBuy = alert.side === 'buy';

  return (
    <article className={`alert-card ${alert.side}`}>
      <header>
        <div>
          <p className="alert-kicker">
            {alert.status === 'executing'
              ? '주문 처리 중'
              : isBuy
                ? '매수 제안'
                : '매도 제안'}
          </p>
          <h3>
            {alert.name} <span>{alert.symbol}</span>
          </h3>
        </div>
        <div className="score">
          <em>{money(alert.suggestedAmount, alert.currency)}</em>
          <span>AI 제안 금액</span>
        </div>
      </header>

      <p className="thesis">{alert.thesis}</p>
      {alert.howToInvest && <p className="playbook">{alert.howToInvest}</p>}

      <dl className="metrics">
        <div>
          <dt>현재가</dt>
          <dd>{money(alert.researchSummary.price, alert.currency)}</dd>
        </div>
        <div>
          <dt>목표</dt>
          <dd>{money(alert.target, alert.currency)}</dd>
        </div>
        <div>
          <dt>손절</dt>
          <dd>{money(alert.stop, alert.currency)}</dd>
        </div>
        <div>
          <dt>신뢰도</dt>
          <dd>{alert.confidence != null ? `${Math.round(alert.confidence * 100)}%` : '—'}</dd>
        </div>
      </dl>

      {(alert.moaSummary || alert.expertSummary || alert.devilSummary) && (
        <div className="pipeline">
          {alert.moaSummary && (
            <p>
              <strong>MoA</strong> {alert.moaSummary}
            </p>
          )}
          {alert.expertSummary && (
            <p>
              <strong>MoE</strong> {alert.expertSummary}
            </p>
          )}
          {alert.devilSummary && (
            <p>
              <strong>악마의 변호인</strong> {alert.devilSummary}
            </p>
          )}
        </div>
      )}

      <footer>
        <button
          type="button"
          className="ghost"
          disabled={busy || alert.status !== 'pending'}
          onClick={() => onDeny(alert)}
        >
          이 종목만 빼기
        </button>
      </footer>
    </article>
  );
}

export default function App() {
  const [dash, setDash] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmingAll, setConfirmingAll] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [brokerBusy, setBrokerBusy] = useState(false);
  const [tokenInput, setTokenInput] = useState(() => getAccessToken());

  const refresh = useCallback(async () => {
    const data = await fetchDashboard();
    setDash(data);
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : '로드 실패'))
      .finally(() => setLoading(false));
  }, [refresh]);

  // 스케줄 결과 반영용 주기 갱신
  useEffect(() => {
    const id = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const pending = (dash?.pendingAlerts ?? []).filter((a) => a.status === 'pending');
  const pendingTotal = pending.reduce((s, a) => s + (a.suggestedAmount || 0), 0);

  async function onMode(mode: TraderMode) {
    setError(null);
    try {
      setDash(await updateSettings({ mode }));
      setNotice(`${MODE_LABEL[mode]}로 바꿨습니다.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '모드 변경 실패');
    }
  }

  async function onConfirmAll() {
    if (pending.length === 0) return;
    setConfirmingAll(true);
    setError(null);
    setNotice(null);
    try {
      const data = await confirmAllPending();
      setDash(data);
      const failN = data.failed?.length ?? 0;
      setNotice(
        data.notice ??
          (failN
            ? `${data.confirmedCount ?? 0}건 성공, ${failN}건 실패`
            : `${data.confirmedCount ?? 0}건 최종 확인 완료`),
      );
      if (failN > 0 && data.failed?.[0]) {
        setError(data.failed.map((f) => `${f.symbol}: ${f.error}`).slice(0, 2).join(' · '));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '최종 확인 실패');
      try {
        setDash(await fetchDashboard());
      } catch {
        // ignore
      }
    } finally {
      setConfirmingAll(false);
    }
  }

  async function onDeny(alert: DailyAlert) {
    setBusyId(alert.id);
    setError(null);
    try {
      setDash(await actOnAlert(alert.id, undefined, 'skip'));
      setNotice(`${alert.name}을(를) 목록에서 뺐습니다.`);
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
      setError(e instanceof Error ? e.message : '동기화 실패');
    } finally {
      setBrokerBusy(false);
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

  const connected = dash.broker.configured && dash.broker.connected;

  return (
    <div className="page">
      <div className="atmosphere" aria-hidden />

      <header className="topbar">
        <div className="brand-block">
          <p className="brand">TRADERS AI</p>
          <p className="brand-sub">계좌 돈으로 알아서 · 최종 확인 한 번</p>
        </div>
        <p
          className={`badge ${
            dash.risk?.killSwitchActive ? 'live' : connected ? 'ok' : ''
          }`}
        >
          {dash.risk?.killSwitchActive
            ? '일손실 잠금'
            : connected
              ? '실주문 가능'
              : dash.broker.configured
                ? '토스 연결 실패'
                : '모의투자'}
        </p>
      </header>

      <main className="shell">
        <section className="hero simple-hero">
          <div className="hero-copy">
            <h1>알아서 투자합니다</h1>
            <p>
              평일 정해진 시각에 AI가 제안을 만들고, <strong>최종 확인</strong> 한 번으로
              실행합니다. 수익은 보장되지 않습니다.
            </p>
          </div>

          <div className="hero-cash">
            <div>
              <span>계좌 현금</span>
              <strong>{money(dash.cash, dash.currency)}</strong>
            </div>
            <div>
              <span>총자산</span>
              <strong>{money(dash.equity, dash.currency)}</strong>
            </div>
          </div>

          {dash.schedule && (
            <p className="hint schedule-hint">
              {dash.schedule.nextHint}
              {dash.schedule.lastResult ? ` · 최근: ${dash.schedule.lastResult}` : ''}
              {dash.lastDailyRunAt
                ? ` · 분석 ${new Date(dash.lastDailyRunAt).toLocaleString('ko-KR')}`
                : ''}
            </p>
          )}

          <div className="hero-actions">
            <button
              type="button"
              className="ghost"
              disabled={brokerBusy || !dash.broker.configured}
              onClick={onSyncBroker}
            >
              {brokerBusy ? '동기화…' : '잔고 새로고침'}
            </button>
          </div>

          <label className="mode-inline">
            성향
            <select
              value={dash.mode}
              onChange={(e) => onMode(e.target.value as TraderMode)}
              aria-label="투자 성향"
            >
              {dash.modes.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>
        </section>

        {dash.accessTokenRequired && (
          <section className="panel">
            <h2>접속 토큰</h2>
            <p className="hint">공개 URL 보호용. .env의 TRADERS_AI_TOKEN 과 같아야 합니다.</p>
            <div className="hero-actions">
              <input
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                placeholder="TRADERS_AI_TOKEN"
                autoComplete="off"
              />
              <button
                type="button"
                className="ghost"
                onClick={() => {
                  setAccessToken(tokenInput.trim());
                  setNotice('토큰을 저장했습니다.');
                }}
              >
                토큰 저장
              </button>
            </div>
          </section>
        )}

        {!dash.broker.configured && (
          <section className="panel">
            <h2>토스 계좌 연결 (1회)</h2>
            <ol className="setup-steps">
              <li>
                토스증권 → Open API에서 <code>client_id</code> / <code>client_secret</code> 발급
              </li>
              <li>허용 IP 등록</li>
              <li>
                <code>traders-ai/.env</code>에 키 저장 후 서버 재시작
              </li>
            </ol>
          </section>
        )}

        {(error || notice) && (
          <div className={`toast ${error ? 'error' : 'ok'}`} role="status">
            {error ?? notice}
          </div>
        )}

        {dash.risk && (
          <section className="panel">
            <h2>리스크·검증</h2>
            <p className="hint">{dash.risk.message}</p>
            <dl className="metrics risk-metrics">
              <div>
                <dt>오늘 손익</dt>
                <dd className={dash.risk.dayPnl >= 0 ? 'up' : 'down'}>
                  {money(dash.risk.dayPnl, dash.currency)} ({dash.risk.dayPnlPct}%)
                </dd>
              </div>
              <div>
                <dt>일손실 한도</dt>
                <dd>-{dash.risk.dailyLossLimitPct}%</dd>
              </div>
              <div>
                <dt>연속 손실</dt>
                <dd>
                  {dash.risk.consecutiveLosses}/{dash.risk.maxConsecutiveLosses}
                </dd>
              </div>
            </dl>
            {dash.risk.lockReason && <p className="hint">잠금: {dash.risk.lockReason}</p>}
          </section>
        )}

        <section className="panel">
          <div className="controls-head">
            <div>
              <h2>오늘의 제안</h2>
              <p>
                {pending.length === 0
                  ? '대기 없음'
                  : `${pending.length}건 · 합계 약 ${money(pendingTotal, dash.currency)}`}
              </p>
            </div>
            <div className="controls-actions">
              <button
                type="button"
                className="primary big"
                disabled={confirmingAll || pending.length === 0}
                onClick={onConfirmAll}
              >
                {confirmingAll
                  ? '주문 처리 중…'
                  : pending.length === 0
                    ? '최종 확인'
                    : `최종 확인 (${pending.length}건)`}
              </button>
            </div>
          </div>

          {pending.length === 0 ? (
            <p className="empty">
              대기 중인 주문이 없습니다. 평일 {dash.schedule?.timeKst ?? '08:55'} KST에 자동으로
              분석됩니다.
            </p>
          ) : (
            <>
              <p className="hint">
                빼고 싶은 종목만 「이 종목만 빼기」한 뒤, 위 <strong>최종 확인</strong>을 한 번
                누르면 됩니다.
              </p>
              <div className="alert-list">
                {pending.map((a) => (
                  <ProposalCard
                    key={a.id}
                    alert={a}
                    busyId={busyId}
                    confirmingAll={confirmingAll}
                    onDeny={onDeny}
                  />
                ))}
              </div>
            </>
          )}
        </section>

        <section className="split">
          <div className="panel">
            <h2>보유</h2>
            {dash.positions.length === 0 ? (
              <p className="empty">없음</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>종목</th>
                    <th>수량</th>
                    <th>평가</th>
                  </tr>
                </thead>
                <tbody>
                  {dash.positions.map((p) => (
                    <tr key={p.symbol}>
                      <td>
                        {p.name}
                        <small>{p.symbol}</small>
                      </td>
                      <td>{p.shares}</td>
                      <td>{money(p.marketValue, p.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <div className="panel">
            <h2>최근 체결</h2>
            {dash.trades.length === 0 ? (
              <p className="empty">없음</p>
            ) : (
              <ul className="trades">
                {dash.trades.slice(0, 6).map((t) => (
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

const MODE_LABEL: Record<TraderMode, string> = {
  safe: '안전형',
  balance: '밸런스형',
  profit: '수익형',
};
