import { createApp, prepareLocalBoot } from './app.js';
import { brokerConfigSummary } from './broker/index.js';
import { initPush } from './push.js';
import { startDailyScheduler } from './scheduler.js';

const app = createApp({ serveStatic: true });
const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '0.0.0.0';

app.listen(PORT, HOST, () => {
  const setup = brokerConfigSummary();
  void (async () => {
    await prepareLocalBoot();
    try {
      initPush();
    } catch (err) {
      console.error('[boot] push init', err);
    }
    console.log(`Traders AI listening on http://${HOST}:${PORT}`);
    console.log(
      setup.configured
        ? `Broker: Toss Securities @ ${setup.baseUrl}`
        : 'Broker: not configured (local paper). Set TOSS_CLIENT_ID/TOSS_CLIENT_SECRET in .env',
    );
    startDailyScheduler();
  })();
});
