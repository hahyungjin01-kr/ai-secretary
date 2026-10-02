import dotenv from 'dotenv';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_PROFILES, isTraderMode } from './modes.js';
import fs from 'node:fs';
import {
  loadState,
  saveState,
  portfolioValue,
  recoverStaleExecuting,
  ensureStoreReady,
  waitForStorePersist,
  type AppState,
} from './store.js';
import { reconcilePendingAlerts, runDailyAnalysis } from './daily.js';
import { actOnAlert, ExecuteError, syncFromBroker } from './execute.js';
import { sampleEgressIps } from './egress.js';
import { collectResearch } from './research.js';
import { brokerConfigSummary, fetchBrokerStatus } from './broker/index.js';
import { APPROVE_PHRASE, checkApproveConfirm } from './security.js';
import {
  evaluateRisk,
  persistRiskFlags,
  unlockLiveTrading,
  lockLiveTrading,
} from './risk.js';
import { getScheduleInfo } from './scheduler.js';
import {
  ensurePushReady,
  getNotifyInfo,
  getVapidPublicKey,
  removeSubscription,
  sendDailyConfirmReminder,
  sendPushToAll,
  upsertSubscription,
  waitForPushPersist,
  type PushSubscriptionJSON,
} from './push.js';
import { getApiSecret, injectSecretIntoHtml, requireApiSecret } from './auth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

export interface CreateAppOptions {
  /** Local/Docker: serve Vite dist. Firebase Hosting serves static → false. */
  serveStatic?: boolean;
}

async function publicState(state: AppState, marks: Record<string, number> = {}) {
  recoverStaleExecuting(state);
  reconcilePendingAlerts(state);
  const broker = await fetchBrokerStatus(false);
  const equity = portfolioValue(state, marks);
  const risk = evaluateRisk(state, marks);
  persistRiskFlags(state, risk);
  saveState(state);

  const positionMarks = state.positions.map((p) => {
    const mark = marks[p.symbol] ?? p.avgPrice;
    return {
      ...p,
      mark,
      marketValue: Math.round(p.shares * mark * 100) / 100,
      pnl: Math.round((mark - p.avgPrice) * p.shares * 100) / 100,
      pnlPct:
        p.avgPrice > 0
          ? Math.round(((mark - p.avgPrice) / p.avgPrice) * 10000) / 100
          : 0,
    };
  });

  const usingBroker = broker.configured && broker.connected && state.preferBroker;
  const paperTrading = risk.paperOnly || !usingBroker;

  return {
    mode: state.mode,
    modeProfile: MODE_PROFILES[state.mode],
    modes: Object.values(MODE_PROFILES),
    watchlist: state.watchlist,
    cash: state.cash,
    startingCash: state.startingCash,
    currency: state.currency,
    equity,
    pnl: Math.round((equity - state.startingCash) * 100) / 100,
    pnlPct:
      state.startingCash > 0
        ? Math.round(((equity - state.startingCash) / state.startingCash) * 10000) / 100
        : 0,
    positions: positionMarks,
    alerts: state.alerts,
    pendingAlerts: state.alerts.filter(
      (a) => a.status === 'pending' || a.status === 'queued' || a.status === 'executing',
    ),
    approvePhrase: APPROVE_PHRASE,
    trades: state.trades,
    lastDailyRunAt: state.lastDailyRunAt,
    lastDailyRunDate: state.lastDailyRunDate,
    lastUniverseSummary: state.lastUniverseSummary,
    lastUniverseSymbols: state.lastUniverseSymbols,
    lastUniverseAt: state.lastUniverseAt,
    preferBroker: state.preferBroker,
    liveTradingArmed: state.liveTradingArmed,
    liveArmedAt: state.liveArmedAt,
    paperTrading,
    risk,
    schedule: getScheduleInfo(),
    notify: getNotifyInfo(),
    broker,
    brokerSetup: brokerConfigSummary(),
    disclaimer:
      '수익을 보장하지 않습니다. 평일 정해진 시각에 AI가 제안을 만들고, 최종 확인 후에만 주문이 나갑니다.',
  };
}

async function markPrices(state: AppState): Promise<Record<string, number>> {
  const marks: Record<string, number> = {};
  await Promise.all(
    state.positions.map(async (p) => {
      try {
        const r = await collectResearch(p.symbol);
        marks[p.symbol] = r.price;
      } catch {
        marks[p.symbol] = p.avgPrice;
      }
    }),
  );
  return marks;
}

function attachPersistFlush(res: express.Response) {
  const origEnd = res.end.bind(res);
  let flushed = false;
  const flushThenEnd = (...args: Parameters<express.Response['end']>) => {
    if (flushed) {
      return origEnd(...args);
    }
    flushed = true;
    void (async () => {
      try {
        await waitForStorePersist();
        await waitForPushPersist();
      } catch (err) {
        console.error('[persist] flush before response end', err);
      }
      origEnd(...args);
    })();
    return res;
  };
  res.end = flushThenEnd as typeof res.end;
}

export function createApp(options: CreateAppOptions = {}): express.Express {
  const serveStatic = options.serveStatic !== false;
  const app = express();
  const requireSecret = requireApiSecret();

  app.use(cors());
  app.use(express.json({ limit: '1mb' }));

  app.use(async (req, res, next) => {
    try {
      await ensureStoreReady();
      await ensurePushReady();
      attachPersistFlush(res);
      next();
    } catch (err) {
      next(err);
    }
  });

  /** 클라이언트가 API 시크릿을 받음 (개인 터널용 — URL 비밀 유지 전제) */
  app.get('/api/bootstrap', (_req, res) => {
    try {
      res.json({
        apiSecret: getApiSecret(),
        approvePhrase: APPROVE_PHRASE,
        secretHeader: 'X-Traders-Secret',
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'bootstrap 실패',
      });
    }
  });

  app.get('/api/health', async (_req, res) => {
    // Keep this lightweight — Docker/ngrok healthchecks must not wait on Toss.
    const setup = brokerConfigSummary();
    res.json({
      ok: true,
      service: 'traders-ai',
      model: 'moe-moa-devil-toss',
      backend: process.env.STATE_BACKEND || 'auto',
      broker: {
        configured: setup.configured,
        connected: null,
        venue: setup.configured ? 'toss' : null,
        provider: setup.configured ? 'toss' : null,
      },
    });
  });

  app.get('/api/dashboard', async (_req, res) => {
    try {
      let state = loadState();
      if (state.preferBroker) {
        try {
          state = await syncFromBroker(state);
        } catch {
          // keep local snapshot if broker sync fails; status will show error
        }
      }
      const marks = await markPrices(state);
      res.json(await publicState(state, marks));
    } catch (err) {
      const message = err instanceof Error ? err.message : '대시보드 오류';
      res.status(500).json({ error: message });
    }
  });

  app.get('/api/broker/egress', async (_req, res) => {
    try {
      const ips = await sampleEgressIps(10);
      res.json({
        ips,
        hint:
          ips.length > 0
            ? `토스증권 Open API → 허용 IP에 아래 주소를 모두 등록하세요: ${ips.join(', ')}`
            : '출구 IP를 확인하지 못했습니다. 잠시 후 다시 시도하세요.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'egress probe failed' });
    }
  });

  app.get('/api/broker/status', async (_req, res) => {
    try {
      const state = loadState();
      const broker = await fetchBrokerStatus(state.liveTradingArmed);
      res.json({
        ...broker,
        preferBroker: state.preferBroker,
        liveTradingArmed: state.liveTradingArmed,
        liveArmedAt: state.liveArmedAt,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'broker status error' });
    }
  });

  app.post('/api/broker/sync', requireSecret, async (_req, res) => {
    try {
      const state = await syncFromBroker(loadState());
      const marks = await markPrices(state);
      res.json(await publicState(state, marks));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '동기화 실패' });
    }
  });

  app.post('/api/broker/live', requireSecret, async (req, res) => {
    try {
      const state = loadState();
      // 영구 LIVE 무장 폐기: 실주문은 최종확인(confirm) 건별로만 나감
      state.liveTradingArmed = false;
      state.liveArmedAt = null;
      if (req.body?.preferBroker !== undefined) {
        state.preferBroker = Boolean(req.body.preferBroker);
      }
      saveState(state);
      const marks = await markPrices(state);
      res.json({
        ...(await publicState(state, marks)),
        notice:
          '영구 LIVE 무장은 사용하지 않습니다. 최종 확인 시에만 건별 실주문이 나갑니다.',
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '설정 실패' });
    }
  });

  app.patch('/api/settings', requireSecret, async (req, res) => {
    try {
      const state = loadState();
      if (req.body?.mode !== undefined) {
        if (!isTraderMode(req.body.mode)) {
          res.status(400).json({ error: 'mode는 safe | balance | profit 이어야 합니다.' });
          return;
        }
        state.mode = req.body.mode;
      }
      if (req.body?.watchlist !== undefined) {
        if (!Array.isArray(req.body.watchlist) || req.body.watchlist.length === 0) {
          res.status(400).json({ error: 'watchlist는 1개 이상 필요합니다.' });
          return;
        }
        state.watchlist = req.body.watchlist
          .map((s: unknown) => String(s).trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 12);
      }
      if (req.body?.preferBroker !== undefined) {
        state.preferBroker = Boolean(req.body.preferBroker);
      }
      if (req.body?.cash !== undefined) {
        const cash = Number(req.body.cash);
        if (!Number.isFinite(cash) || cash < 0) {
          res.status(400).json({ error: 'cash는 0 이상이어야 합니다.' });
          return;
        }
        if (state.preferBroker && brokerConfigSummary().configured) {
          res.status(400).json({
            error: '토스 연동 중에는 현금을 수동 수정할 수 없습니다. 잔고 동기화를 사용하세요.',
          });
          return;
        }
        state.cash = cash;
        if (req.body?.resetStarting) {
          state.startingCash = cash;
          state.positions = [];
          state.trades = [];
        }
      }
      saveState(state);
      const marks = await markPrices(state);
      res.json(await publicState(state, marks));
    } catch (err) {
      const message = err instanceof Error ? err.message : '설정 저장 실패';
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/daily/run', requireSecret, async (req, res) => {
    try {
      const force = Boolean(req.body?.force);
      try {
        await syncFromBroker(loadState());
      } catch {
        // analysis can still run on local snapshot
      }
      const result = await runDailyAnalysis(force);
      const marks = await markPrices(result.state);
      res.json({
        ...(await publicState(result.state, marks)),
        createdCount: result.created.length,
        scanned: result.scanned,
        universeSummary: result.universeSummary,
        skippedReason: result.skippedReason,
        created: result.created,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '일일 분석 실패';
      console.error('[/api/daily/run]', message);
      res.status(500).json({ error: message });
    }
  });

  /** 대기 중인 제안을 최종 확인 한 번에 순차 실행 */
  app.post('/api/risk/unlock-live', requireSecret, async (req, res) => {
    try {
      let state = loadState();
      state = unlockLiveTrading(state, String(req.body?.confirm ?? ''));
      const marks = await markPrices(state);
      res.json(await publicState(state, marks));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '해금 실패' });
    }
  });

  app.post('/api/risk/lock-live', requireSecret, async (_req, res) => {
    try {
      const state = lockLiveTrading(loadState());
      const marks = await markPrices(state);
      res.json(await publicState(state, marks));
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '잠금 실패' });
    }
  });

  app.post('/api/alerts/confirm-all', requireSecret, async (req, res) => {
    try {
      const conf = checkApproveConfirm(req.body?.confirm);
      if (!conf.ok) {
        res.status(400).json({ error: conf.error });
        return;
      }
      const confirm = String(req.body.confirm);
      const state0 = loadState();
      reconcilePendingAlerts(state0);
      saveState(state0);
      const pending = state0.alerts
        .filter((a) => a.status === 'pending')
        // 매도 먼저 → 현금 확보 후 매수 (같은 확인에서도 오버매수 방지)
        .sort((a, b) => {
          if (a.side !== b.side) return a.side === 'sell' ? -1 : 1;
          return 0;
        });
      if (pending.length === 0) {
        const marks = await markPrices(state0);
        res.json({
          ...(await publicState(state0, marks)),
          confirmedCount: 0,
          failed: [],
          skippedReason: '대기 중인 주문이 없습니다.',
        });
        return;
      }

      // 종목마다 sync 하면 IP 거부로 연쇄 실패 → 한 번만 동기화
      let lastState = state0;
      try {
        lastState = await syncFromBroker(state0);
      } catch (err) {
        const marks = await markPrices(state0);
        res.status(400).json({
          ...(await publicState(state0, marks)),
          confirmedCount: 0,
          failed: pending.map((a) => ({
            id: a.id,
            symbol: a.symbol,
            error: err instanceof Error ? err.message : '브로커 동기화 실패',
          })),
          error: err instanceof Error ? err.message : '브로커 동기화 실패',
        });
        return;
      }

      const failed: { id: string; symbol: string; error: string }[] = [];
      let confirmedCount = 0;

      for (const alert of pending) {
        try {
          const result = await actOnAlert(alert.id, 0, 'execute', confirm, { skipSync: true });
          lastState = result.state;
          confirmedCount += 1;
        } catch (err) {
          failed.push({
            id: alert.id,
            symbol: alert.symbol,
            error: err instanceof Error ? err.message : '실패',
          });
          lastState = loadState();
        }
      }

      const marks = await markPrices(lastState);
      res.json({
        ...(await publicState(lastState, marks)),
        confirmedCount,
        failed,
        notice:
          failed.length === 0
            ? `${confirmedCount}건 처리 (장외면 다음 장 예약, 장중이면 즉시 주문)`
            : `${confirmedCount}건 성공/예약, ${failed.length}건 실패`,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : '최종 확인 실패';
      console.error('[/api/alerts/confirm-all]', message);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/alerts/:id/act', requireSecret, async (req, res) => {
    try {
      const action = req.body?.action === 'skip' ? 'skip' : 'execute';
      const amount =
        req.body?.amount === undefined || req.body?.amount === null || req.body?.amount === ''
          ? 0
          : Number(req.body.amount);
      const confirm = String(req.body?.confirm ?? '');
      if (action === 'execute') {
        const conf = checkApproveConfirm(confirm);
        if (!conf.ok) {
          res.status(400).json({ error: conf.error });
          return;
        }
      }
      const result = await actOnAlert(String(req.params.id), amount, action, confirm);
      const marks = await markPrices(result.state);
      res.json({
        ...(await publicState(result.state, marks)),
        alert: result.alert,
        trade: result.trade,
      });
    } catch (err) {
      if (err instanceof ExecuteError) {
        res.status(400).json({ error: err.message });
        return;
      }
      const message = err instanceof Error ? err.message : '체결 실패';
      console.error('[/api/alerts/:id/act]', message);
      res.status(500).json({ error: message });
    }
  });

  app.post('/api/review', async (_req, res) => {
    res.status(410).json({
      error:
        '이 API는 폐기되었습니다. /api/daily/run 과 /api/alerts/:id/act 를 사용하세요.',
    });
  });

  app.get('/api/push/vapid-public-key', (_req, res) => {
    try {
      res.json({ publicKey: getVapidPublicKey(), notify: getNotifyInfo() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'VAPID 오류' });
    }
  });

  app.post('/api/push/subscribe', requireSecret, (req, res) => {
    try {
      const sub = req.body?.subscription as PushSubscriptionJSON | undefined;
      if (!sub) {
        res.status(400).json({ error: 'subscription 이 필요합니다.' });
        return;
      }
      const count = upsertSubscription(sub);
      res.json({ ok: true, subscriptionCount: count, notify: getNotifyInfo() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '구독 실패' });
    }
  });

  app.delete('/api/push/subscribe', requireSecret, (req, res) => {
    try {
      const endpoint = String(req.body?.endpoint ?? '');
      if (!endpoint) {
        res.status(400).json({ error: 'endpoint 가 필요합니다.' });
        return;
      }
      const count = removeSubscription(endpoint);
      res.json({ ok: true, subscriptionCount: count, notify: getNotifyInfo() });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : '구독 해제 실패' });
    }
  });

  app.post('/api/push/test', requireSecret, async (_req, res) => {
    try {
      const pending = loadState().alerts.filter((a) => a.status === 'pending').length;
      const result = await sendPushToAll({
        title: 'TRADERS AI · 테스트',
        body:
          pending > 0
            ? `대기 ${pending}건. 알림의 「최종 확인」을 눌러 바로 주문할 수 있습니다.`
            : '알림의 「최종 확인」 버튼이 보이는지 확인하세요. (현재 대기 없음)',
        url: '/#confirm',
        tag: 'traders-ai-test',
        showConfirmAction: true,
        pending,
      });
      res.json({ ok: true, ...result, notify: getNotifyInfo() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '테스트 알림 실패' });
    }
  });

  app.post('/api/push/remind-now', requireSecret, async (_req, res) => {
    try {
      const result = await sendDailyConfirmReminder();
      res.json({ ok: true, ...result, notify: getNotifyInfo() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '알림 실패' });
    }
  });

  if (serveStatic) {
    const distDir = path.resolve(__dirname, '../dist');
    app.use(express.static(distDir, { index: false }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      try {
        const html = injectSecretIntoHtml(fs.readFileSync(indexPath, 'utf8'));
        res.type('html').send(html);
      } catch {
        res.status(404).json({ error: 'UI build missing. Run npm run build.' });
      }
    });
  }

  return app;
}

/** Local / Docker / Functions boot side-effects. */
export async function prepareLocalBoot(): Promise<void> {
  try {
    getApiSecret();
  } catch (err) {
    console.error('[boot] api secret', err);
  }
  try {
    await ensureStoreReady();
    const st = loadState();
    if (st.liveTradingArmed) {
      st.liveTradingArmed = false;
      st.liveArmedAt = null;
    }
    recoverStaleExecuting(st, 0);
    saveState(st);
    await waitForStorePersist();
  } catch (err) {
    console.error('[boot] clear live arm', err);
  }
}
