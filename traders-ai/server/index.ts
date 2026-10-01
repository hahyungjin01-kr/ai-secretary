import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MODE_PROFILES, isTraderMode } from './modes.js';
import { loadState, saveState, portfolioValue, type AppState } from './store.js';
import { runDailyAnalysis } from './daily.js';
import { actOnAlert, ExecuteError } from './execute.js';
import { collectResearch } from './research.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = Number(process.env.PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

function publicState(state: AppState, marks: Record<string, number> = {}) {
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
    paperTrading: true,
    disclaimer:
      '모의투자(페이퍼) 엔진입니다. 실계좌 자동주문은 연결되어 있지 않습니다. 투자 손실 가능, 수익 보장 없음.',
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

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'traders-ai',
    model: 'mode-daily-paper-execution',
    paperTrading: true,
  });
});

app.get('/api/dashboard', async (_req, res) => {
  try {
    const state = loadState();
    const marks = await markPrices(state);
    res.json(publicState(state, marks));
  } catch (err) {
    const message = err instanceof Error ? err.message : '대시보드 오류';
    res.status(500).json({ error: message });
  }
});

app.patch('/api/settings', (req, res) => {
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
    if (req.body?.cash !== undefined) {
      const cash = Number(req.body.cash);
      if (!Number.isFinite(cash) || cash < 0) {
        res.status(400).json({ error: 'cash는 0 이상이어야 합니다.' });
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
    res.json(publicState(state));
  } catch (err) {
    const message = err instanceof Error ? err.message : '설정 저장 실패';
    res.status(500).json({ error: message });
  }
});

app.post('/api/daily/run', async (req, res) => {
  try {
    const force = Boolean(req.body?.force);
    const result = await runDailyAnalysis(force);
    const marks = await markPrices(result.state);
    res.json({
      ...publicState(result.state, marks),
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
      ...publicState(result.state, marks),
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

// legacy review endpoint kept for compatibility
app.post('/api/review', async (req, res) => {
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

app.listen(PORT, () => {
  console.log(`Traders AI listening on http://localhost:${PORT}`);
});
