import { useCallback, useEffect, useState } from 'react';
import {
  actOnAlert,
  confirmAllPending,
  enablePhoneNotify,
  fetchDashboard,
  fetchEgressIps,
  getPushStatus,
  sendTestNotify,
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
  const busy =
    busyId === alert.id ||
    alert.status === 'executing' ||
    alert.status === 'queued' ||
    confirmingAll;
  const isBuy = alert.side === 'buy';

  return (
    <article className={`alert-card ${alert.side}`}>
      <header>
        <div>
          <p className="alert-kicker">
            {alert.status === 'executing'
              ? '주문 처리 중'
              : alert.status === 'queued'
                ? '다음 장 예약됨'
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

      {alert.status === 'queued' && (
        <p className="hint">
          {alert.executionNote ?? '최종확인됨 · 다음 정규장에 자동 주문'}
        </p>
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
  const [notifyBusy, setNotifyBusy] = useState(false);
  const [pushOn, setPushOn] = useState(false);
  const [highlightConfirm, setHighlightConfirm] = useState(false);
  const [egressIps, setEgressIps] = useState<string[]>([]);
  const [egressHint, setEgressHint] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const data = await fetchDashboard();
    setDash(data);
  }, []);

  useEffect(() => {
    refresh()
      .catch((e) => setError(e instanceof Error ? e.message : '로드 실패'))
      .finally(() => setLoading(false));
  }, [refresh]);

  useEffect(() => {
    getPushStatus()
      .then((s) => setPushOn(s.subscribed && s.permission === 'granted'))
      .catch(() => undefined);
  }, []);

  // 알림창 「최종 확인」 후 SW가 앱에 결과 전달
  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.data?.type !== 'traders-ai:confirmed') return;
      setNotice(typeof ev.data.notice === 'string' ? ev.data.notice : '최종 확인 완료');
      refresh().catch(() => undefined);
    }
    navigator.serviceWorker?.addEventListener('message', onMessage);
    return () => navigator.serviceWorker?.removeEventListener('message', onMessage);
  }, [refresh]);

  // 스케줄 결과 반영용 주기 갱신
  useEffect(() => {
    const id = window.setInterval(() => {
      refresh().catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  // 알림 탭 → /#confirm : 최종 확인 버튼으로 스크롤
  useEffect(() => {
    if (loading || !dash) return;
    if (window.location.hash !== '#confirm') return;
    setHighlightConfirm(true);
    const t = window.setTimeout(() => {
      document.getElementById('confirm-panel')?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    }, 120);
    return () => window.clearTimeout(t);
  }, [loading, dash]);

  const pending = (dash?.pendingAlerts ?? []).filter((a) => a.status === 'pending');
  const queued = (dash?.pendingAlerts ?? []).filter((a) => a.status === 'queued');
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
            ? `${data.confirmedCount ?? 0}건 성공/예약, ${failN}건 실패`
            : `${data.confirmedCount ?? 0}건 최종 확인 (장외면 다음 장 예약)`),
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
      const msg = e instanceof Error ? e.message : '동기화 실패';
      setError(msg);
      if (/IP|허용/i.test(msg)) {
        try {
          const eg = await fetchEgressIps();
          setEgressIps(eg.ips);
          setEgressHint(eg.hint);
        } catch {
          // ignore
        }
      }
    } finally {
      setBrokerBusy(false);
    }
  }

  async function onShowEgressIps() {
    setBrokerBusy(true);
    setError(null);
    try {
      const eg = await fetchEgressIps();
      setEgressIps(eg.ips);
      setEgressHint(eg.hint);
      setNotice(eg.hint);
    } catch (e) {
      setError(e instanceof Error ? e.message : '출구 IP 조회 실패');
    } finally {
      setBrokerBusy(false);
    }
  }

  async function onEnableNotify() {
    setNotifyBusy(true);
    setError(null);
    try {
      await enablePhoneNotify();
      setPushOn(true);
      setDash(await fetchDashboard());
      setNotice('휴대폰 알림이 켜졌습니다. 테스트 알림으로 확인해 보세요.');
    } catch (e) {
      setError(e instanceof Error ? e.message : '알림 설정 실패');
    } finally {
      setNotifyBusy(false);
    }
  }

  async function onTestNotify() {
    setNotifyBusy(true);
    setError(null);
    try {
      const r = await sendTestNotify();
      setNotice(
        r.sent > 0
          ? `테스트 알림 ${r.sent}건 전송. 휴대폰 알림함을 확인하세요.`
          : '등록된 구독이 없습니다. 먼저 「휴대폰 알림 켜기」를 누르세요.',
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : '테스트 알림 실패');
    } finally {
      setNotifyBusy(false);
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
            <button
              type="button"
              className="ghost"
              disabled={notifyBusy}
              onClick={onEnableNotify}
            >
              {notifyBusy ? '설정 중…' : pushOn ? '알림 다시 등록' : '휴대폰 알림 켜기'}
            </button>
            {pushOn && (
              <button type="button" className="ghost" disabled={notifyBusy} onClick={onTestNotify}>
                테스트 알림
              </button>
            )}
          </div>
          <p className="hint">
            {dash.notify?.nextHint ?? '평일 18:00 KST에 휴대폰 알림'}
            {pushOn
              ? ' · 알림의 「최종 확인」으로 바로 주문'
              : ' · 한 번만 「휴대폰 알림 켜기」'}
            {(dash.notify?.subscriptionCount ?? 0) > 0
              ? ` · 서버 구독 ${dash.notify?.subscriptionCount}개`
              : ''}
          </p>

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

        {(!dash.broker.configured || !connected || egressIps.length > 0) && (
          <section className="panel">
            <h2>토스 계좌 · 허용 IP</h2>
            {!dash.broker.configured ? (
              <ol className="setup-steps">
                <li>
                  토스증권 → Open API에서 <code>client_id</code> / <code>client_secret</code> 발급
                </li>
                <li>허용 IP 등록 (아래 출구 IP 전부)</li>
                <li>
                  <code>traders-ai/.env</code>에 키 저장 후 서버 재시작
                </li>
              </ol>
            ) : (
              <p className="hint">
                {dash.broker.error
                  ? `연결 오류: ${dash.broker.error}`
                  : '서버 출구 IP가 여러 개라, 토스 허용 IP에 전부 등록해야 주문이 됩니다.'}
              </p>
            )}
            <div className="hero-actions">
              <button type="button" className="ghost" disabled={brokerBusy} onClick={onShowEgressIps}>
                {brokerBusy ? '조회 중…' : '등록할 출구 IP 보기'}
              </button>
            </div>
            {egressIps.length > 0 && (
              <p className="hint">
                <strong>허용 IP에 등록:</strong> <code>{egressIps.join(', ')}</code>
                {egressHint ? ` — ${egressHint}` : ''}
              </p>
            )}
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

        <section
          id="confirm-panel"
          className={`panel ${highlightConfirm ? 'confirm-focus' : ''}`}
        >
          <div className="controls-head">
            <div>
              <h2>오늘의 제안</h2>
              <p>
                {pending.length === 0 && queued.length === 0
                  ? '대기 없음'
                  : [
                      pending.length ? `확인 대기 ${pending.length}건` : null,
                      queued.length ? `장 예약 ${queued.length}건` : null,
                      pending.length
                        ? `합계 약 ${money(pendingTotal, dash.currency)}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
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
                  ? '처리 중…'
                  : pending.length === 0
                    ? queued.length > 0
                      ? '예약 완료'
                      : '최종 확인'
                    : `최종 확인 (${pending.length}건)`}
              </button>
            </div>
          </div>

          {pending.length === 0 && queued.length === 0 ? (
            <p className="empty">
              대기 중인 주문이 없습니다. 평일 {dash.schedule?.timeKst ?? '17:30'} KST에 자동으로
              분석됩니다.
            </p>
          ) : (
            <>
              <p className="hint">
                장외(15:30 이후·주말)에 확인하면 <strong>다음 장 09:05</strong>에 자동 주문됩니다.
                매도 제안이 있으면 당일은 매도만, 매수는 현금 한도 안입니다.
              </p>
              <div className="alert-list">
                {[...queued, ...pending].map((a) => (
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
