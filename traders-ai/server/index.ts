import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_PROFILES, isTraderMode } from './modes.js';
import { loadState, saveState, portfolioValue, type AppState } from './store.js';
import { runDailyAnalysis } from './daily.js';
import { actOnAlert, ExecuteError, syncFromBroker } from './execute.js';
import { collectResearch } from './research.js';
import { brokerConfigSummary, fetchBrokerStatus } from './broker/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

app.use(cors());
app.use(express.json({ limit: '1mb' }));

async function publicState(state: AppState, marks: Record<string, number> = {}) {
  const broker = await fetchBrokerStatus(state.liveTradingArmed);
  const equity = portfolioValue(state, marks);
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
  const paperTrading = !(usingBroker && state.liveTradingArmed);

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
    pendingAlerts: state.alerts.filter((a) => a.status === 'pending'),
    trades: state.trades,
    lastDailyRunAt: state.lastDailyRunAt,
    lastDailyRunDate: state.lastDailyRunDate,
    preferBroker: state.preferBroker,
    liveTradingArmed: state.liveTradingArmed,
    liveArmedAt: state.liveArmedAt,
    paperTrading,
    broker,
    brokerSetup: brokerConfigSummary(),
    disclaimer: usingBroker
      ? state.liveTradingArmed
        ? '토스증권 실주문이 활성화되어 있습니다. 실제 손실이 발생할 수 있습니다.'
        : '토스증권 계좌는 연결됐지만 실주문은 잠겨 있습니다. LIVE 확인 후에만 토스로 주문됩니다.'
      : '로컬 모의투자 엔진입니다. .env에 토스 Open API 키를 넣으면 계좌 연동이 가능합니다.',
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
    model: 'mode-daily-toss-execution',
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

app.post('/api/broker/sync', async (_req, res) => {
  try {
    const state = await syncFromBroker(loadState());
    const marks = await markPrices(state);
    res.json(await publicState(state, marks));
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : '동기화 실패' });
  }
});

app.post('/api/broker/live', async (req, res) => {
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

app.patch('/api/settings', async (req, res) => {
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

app.post('/api/daily/run', async (req, res) => {
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
      skippedReason: result.skippedReason,
      created: result.created,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : '일일 분석 실패';
    console.error('[/api/daily/run]', message);
    res.status(500).json({ error: message });
  }
});

app.post('/api/alerts/:id/act', async (req, res) => {
  try {
    const action = req.body?.action === 'skip' ? 'skip' : 'execute';
    const amount = Number(req.body?.amount ?? 0);
    const result = await actOnAlert(req.params.id, amount, action);
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
  console.log(`Traders AI listening on http://${HOST}:${PORT}`);
  console.log(
    setup.configured
      ? `Broker: Toss Securities @ ${setup.baseUrl}`
      : 'Broker: not configured (local paper). Set TOSS_CLIENT_ID/TOSS_CLIENT_SECRET in .env',
  );
});
