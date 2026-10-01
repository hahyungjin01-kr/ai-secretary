import { useCallback, useEffect, useState } from 'react';
import {
  actOnAlert,
  fetchDashboard,
  getAccessToken,
  runDaily,
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

function ApprovalCard({
  alert,
  busyId,
  onApprove,
  onDeny,
}: {
  alert: DailyAlert;
  busyId: string | null;
  onApprove: (alert: DailyAlert, confirm: string) => void;
  onDeny: (alert: DailyAlert) => void;
}) {
  const [confirm, setConfirm] = useState('');
  const busy = busyId === alert.id || alert.status === 'executing';
  const isBuy = alert.side === 'buy';
  const canApprove = confirm.trim() === '허락' && alert.status === 'pending';

  return (
    <article className={`alert-card ${alert.side}`}>
      <header>
        <div>
          <p className="alert-kicker">
            {alert.status === 'executing'
              ? '주문 처리 중'
              : isBuy
                ? '매수 허락 요청'
                : '매도 허락 요청'}
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
          {(alert.devilChallenges?.length ?? 0) > 0 && (
            <ul className="devil-list">
              {alert.devilChallenges!.slice(0, 3).map((c) => (
                <li key={c.id}>
                  <span className={`sev ${c.severity}`}>{c.severity}</span> {c.counter}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {alert.status === 'pending' && (
        <label className="confirm-box">
          실주문하려면 아래에 <strong>허락</strong> 입력
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="허락"
            autoComplete="off"
            disabled={busy}
          />
        </label>
      )}

      <footer>
        <button
          type="button"
          className="primary"
          disabled={busy || !canApprove}
          onClick={() => onApprove(alert, confirm.trim())}
        >
          {busy
            ? '처리 중…'
            : isBuy
              ? '사전검증 후 매수'
              : '사전검증 후 매도'}
        </button>
        <button
          type="button"
          className="ghost"
          disabled={busy || alert.status !== 'pending'}
          onClick={() => onDeny(alert)}
        >
          거절
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

  const pending = dash?.pendingAlerts ?? [];

  async function onMode(mode: TraderMode) {
    setError(null);
    try {
      setDash(await updateSettings({ mode }));
      setNotice(`${MODE_LABEL[mode]}로 바꿨습니다.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : '모드 변경 실패');
    }
  }

  async function onScan() {
    setScanning(true);
    setError(null);
    setNotice(null);
    try {
      try {
        await syncBroker();
      } catch {
        // 키 없으면 로컬로 진행
      }
      const data = await runDaily(true);
      setDash(data);
      if (data.skippedReason) setNotice(data.skippedReason);
      else {
        const n = data.createdCount ?? 0;
        setNotice(
          n > 0
            ? `AI가 ${n}건을 골랐습니다. 아래에서 허락해 주세요.`
            : '오늘은 살 만한 종목이 없습니다.',
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '분석 실패');
    } finally {
      setScanning(false);
    }
  }

  async function onApprove(alert: DailyAlert, confirm: string) {
    setBusyId(alert.id);
    setError(null);
    try {
      const data = await actOnAlert(alert.id, undefined, 'execute', confirm);
      setDash(data);
      setNotice(data.alert?.executionNote ?? '체결 완료');
    } catch (e) {
      setError(e instanceof Error ? e.message : '체결 실패');
      try {
        setDash(await fetchDashboard());
      } catch {
        // ignore
      }
    } finally {
      setBusyId(null);
    }
  }

  async function onDeny(alert: DailyAlert) {
    setBusyId(alert.id);
    setError(null);
    try {
      setDash(await actOnAlert(alert.id, undefined, 'skip'));
      setNotice('거절했습니다.');
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
          <p className="brand-sub">계좌 돈으로 알아서 · 매수 전에만 허락</p>
        </div>
        <p className={`badge ${connected ? 'ok' : ''}`}>
          {connected ? '토스 계좌 연결' : dash.broker.configured ? '토스 연결 실패' : '모의투자'}
        </p>
      </header>

      <main className="shell">
        <section className="hero simple-hero">
          <div className="hero-copy">
            <h1>알아서 투자합니다</h1>
            <p>
              MoE→MoA→악마의 변호인으로 고른 뒤, 주문 직전 사전거래 MoA(장운영·가격괴리·자금·재검증)를
              한 번 더 통과해야 합니다. 「허락」을 입력한 건만 주문됩니다.
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

          <div className="hero-actions">
            <button type="button" className="primary big" disabled={scanning} onClick={onScan}>
              {scanning ? 'AI가 고르는 중…' : 'AI에게 맡기기'}
            </button>
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

        <section className="panel">
          <h2>허락이 필요한 주문</h2>
          {pending.length === 0 ? (
            <p className="empty">대기 중인 주문이 없습니다. 「AI에게 맡기기」를 누르세요.</p>
          ) : (
            <div className="alert-list">
              {pending.map((a) => (
                <ApprovalCard
                  key={a.id}
                  alert={a}
                  busyId={busyId}
                  onApprove={onApprove}
                  onDeny={onDeny}
                />
              ))}
            </div>
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
