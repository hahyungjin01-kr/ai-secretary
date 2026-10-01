import dotenv from 'dotenv';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_PROFILES, isTraderMode } from './modes.js';
import { loadState, saveState, portfolioValue, type AppState } from './store.js';
import { runDailyAnalysis } from './daily.js';
import { actOnAlert, ExecuteError, syncFromBroker } from './execute.js';
import { collectResearch } from './research.js';
import { brokerConfigSummary, fetchBrokerStatus } from './broker/index.js';
import { APPROVE_PHRASE, accessTokenConfigured, checkAccessToken } from './security.js';
import {
  evaluateRisk,
  persistRiskFlags,
  unlockLiveTrading,
  lockLiveTrading,
} from './risk.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

/** 변경 API 보호 (TRADERS_AI_TOKEN 설정 시) */
function requireAccessToken(req: Request, res: Response, next: NextFunction) {
  const check = checkAccessToken(req.header('x-traders-token'));
  if (!check.ok) {
    res.status(401).json({ error: check.error });
    return;
  }
  next();
}

async function publicState(state: AppState, marks: Record<string, number> = {}) {
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
    pendingAlerts: state.alerts.filter((a) => a.status === 'pending' || a.status === 'executing'),
    accessTokenRequired: accessTokenConfigured(),
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
    broker,
    brokerSetup: brokerConfigSummary(),
    disclaimer:
      '수익을 보장하지 않습니다. 페이퍼 검증·일손실 킬스위치·최종 확인 후에만 주문이 나갑니다. 손익은 사용자 책임입니다.',
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

app.get('/api/health', async (_req, res) => {
  const state = loadState();
  const broker = await fetchBrokerStatus(state.liveTradingArmed);
  res.json({
    ok: true,
    service: 'traders-ai',
    model: 'moe-moa-devil-toss',
    broker: {
      configured: broker.configured,
      connected: broker.connected,
      venue: broker.venue,
      provider: broker.provider,
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

app.post('/api/broker/sync', requireAccessToken, async (_req, res) => {
  try {
    const state = await syncFromBroker(loadState());
    const marks = await markPrices(state);
    res.json(await publicState(state, marks));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '동기화 실패' });
  }
});

app.post('/api/broker/live', requireAccessToken, async (req, res) => {
  try {
    const state = loadState();
    const arm = Boolean(req.body?.arm);
    const confirm = String(req.body?.confirm ?? '')
      .trim()
      .toUpperCase();
    const summary = brokerConfigSummary();

    if (arm) {
      if (!summary.configured) {
        res.status(400).json({ error: '토스증권 API 키가 설정되지 않았습니다.' });
        return;
      }
      if (confirm !== 'LIVE') {
        res.status(400).json({
          error: '실주문 활성화에는 confirm 값으로 LIVE 를 보내야 합니다.',
        });
        return;
      }
      state.liveTradingArmed = true;
      state.liveArmedAt = new Date().toISOString();
      state.preferBroker = true;
    } else {
      state.liveTradingArmed = false;
      state.liveArmedAt = null;
    }

    saveState(state);
    const marks = await markPrices(state);
    res.json(await publicState(state, marks));
  } catch (err) {
    res.status(500).json({ error: err instanceof Error ? err.message : '설정 실패' });
  }
});

app.patch('/api/settings', requireAccessToken, async (req, res) => {
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

app.post('/api/daily/run', requireAccessToken, async (req, res) => {
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
app.post('/api/risk/unlock-live', requireAccessToken, async (req, res) => {
  try {
    let state = loadState();
    state = unlockLiveTrading(state, String(req.body?.confirm ?? ''));
    const marks = await markPrices(state);
    res.json(await publicState(state, marks));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '해금 실패' });
  }
});

app.post('/api/risk/lock-live', requireAccessToken, async (_req, res) => {
  try {
    const state = lockLiveTrading(loadState());
    const marks = await markPrices(state);
    res.json(await publicState(state, marks));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '잠금 실패' });
  }
});

app.post('/api/alerts/confirm-all', requireAccessToken, async (req, res) => {
  try {
    const confirm = String(req.body?.confirm ?? APPROVE_PHRASE);
    const state0 = loadState();
    const pending = state0.alerts.filter((a) => a.status === 'pending');
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

    const failed: { id: string; symbol: string; error: string }[] = [];
    let confirmedCount = 0;
    let lastState = state0;

    for (const alert of pending) {
      try {
        const result = await actOnAlert(alert.id, 0, 'execute', confirm);
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
          ? `${confirmedCount}건 최종 확인·주문 완료`
          : `${confirmedCount}건 성공, ${failed.length}건 실패(재분석/장외 등)`,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '최종 확인 실패';
    console.error('[/api/alerts/confirm-all]', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/alerts/:id/act', requireAccessToken, async (req, res) => {
  try {
    const action = req.body?.action === 'skip' ? 'skip' : 'execute';
    const amount =
      req.body?.amount === undefined || req.body?.amount === null || req.body?.amount === ''
        ? 0
        : Number(req.body.amount);
    const confirm = String(req.body?.confirm ?? '');
    const result = await actOnAlert(req.params.id, amount, action, confirm);
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

const distDir = path.resolve(__dirname, '../dist');
app.use(express.static(distDir));
app.get(/^(?!\/api).*/, (_req, res) => {
  res.sendFile(path.join(distDir, 'index.html'), (err) => {
    if (err) res.status(404).json({ error: 'UI build missing. Run npm run build.' });
  });
});

app.listen(PORT, HOST, () => {
  const setup = brokerConfigSummary();
  // 건별 승인 모델: 부팅 시 영구 LIVE 무장 해제
  try {
    const st = loadState();
    if (st.liveTradingArmed) {
      st.liveTradingArmed = false;
      st.liveArmedAt = null;
      saveState(st);
    }
  } catch (err) {
    console.error('[boot] clear live arm', err);
  }
  console.log(`Traders AI listening on http://${HOST}:${PORT}`);
  console.log(
    setup.configured
      ? `Broker: Toss Securities @ ${setup.baseUrl}`
      : 'Broker: not configured (local paper). Set TOSS_CLIENT_ID/TOSS_CLIENT_SECRET in .env',
  );
  console.log(
    accessTokenConfigured()
      ? 'API guard: TRADERS_AI_TOKEN required on mutating routes'
      : 'API guard: TRADERS_AI_TOKEN not set (open mutating routes — set token for public URL)',
  );
});
