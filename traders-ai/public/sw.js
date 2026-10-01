/* Traders AI — Web Push SW v3 (API secret + notify action confirm) */
const CONFIRM_PHRASE = '최종확인';
const SECRET_STORE = 'traders-ai-secret';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'traders-ai:set-secret' && typeof data.secret === 'string') {
    event.waitUntil(
      caches.open(SECRET_STORE).then((cache) =>
        cache.put(
          '/__api_secret__',
          new Response(data.secret, { headers: { 'Content-Type': 'text/plain' } }),
        ),
      ),
    );
  }
});

async function getStoredSecret() {
  try {
    const cache = await caches.open(SECRET_STORE);
    const res = await cache.match('/__api_secret__');
    if (!res) return '';
    return (await res.text()).trim();
  } catch {
    return '';
  }
}

self.addEventListener('push', (event) => {
  let data = {
    title: 'TRADERS AI',
    body: '확인할 제안이 있습니다.',
    url: '/#confirm',
    tag: 'traders-ai-confirm',
    showConfirmAction: true,
    pending: 0,
  };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    try {
      const text = event.data?.text();
      if (text) data.body = text;
    } catch {
      // keep defaults
    }
  }

  const actions = [];
  if (data.showConfirmAction !== false) {
    actions.push({ action: 'confirm', title: '최종 확인' });
    actions.push({ action: 'open', title: '자세히' });
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'TRADERS AI', {
      body: data.body || '',
      tag: data.tag || 'traders-ai-confirm',
      renotify: true,
      requireInteraction: Boolean(data.showConfirmAction !== false),
      data: {
        url: data.url || '/#confirm',
        showConfirmAction: data.showConfirmAction !== false,
        pending: data.pending || 0,
      },
      icon: '/favicon.svg',
      badge: '/favicon.svg',
      actions,
    }),
  );
});

async function openApp(target) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of all) {
    if ('focus' in client) {
      await client.focus();
      if ('navigate' in client) {
        try {
          await client.navigate(target);
        } catch {
          // ignore
        }
      }
      return;
    }
  }
  if (self.clients.openWindow) {
    await self.clients.openWindow(target);
  }
}

async function confirmAllFromNotification() {
  const secret = await getStoredSecret();
  if (!secret) {
    throw new Error('API 시크릿이 없습니다. 앱을 한 번 열고 「휴대폰 알림 켜기」를 다시 하세요.');
  }

  const res = await fetch('/api/alerts/confirm-all', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
      'X-Traders-Secret': secret,
    },
    body: JSON.stringify({ confirm: CONFIRM_PHRASE }),
  });

  let data = {};
  try {
    data = await res.json();
  } catch {
    data = {};
  }

  if (!res.ok) {
    throw new Error(data.error || `확인 실패 (${res.status})`);
  }

  const confirmed = data.confirmedCount ?? 0;
  const failed = Array.isArray(data.failed) ? data.failed.length : 0;
  const queued = Array.isArray(data.pendingAlerts)
    ? data.pendingAlerts.filter((a) => a.status === 'queued').length
    : 0;
  const notice =
    data.notice ||
    (failed
      ? `${confirmed}건 성공/예약, ${failed}건 실패`
      : queued > 0
        ? `${queued}건 다음 장 예약 확정`
        : confirmed
          ? `${confirmed}건 최종 확인·주문 완료`
          : data.skippedReason || '대기 주문 없음');

  await self.registration.showNotification('TRADERS AI · 완료', {
    body: notice,
    tag: 'traders-ai-confirm-result',
    renotify: true,
    data: { url: '/#confirm' },
    icon: '/favicon.svg',
    badge: '/favicon.svg',
  });

  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const client of clients) {
    try {
      client.postMessage({ type: 'traders-ai:confirmed', notice });
    } catch {
      // ignore
    }
  }

  return notice;
}

self.addEventListener('notificationclick', (event) => {
  const action = event.action || 'open';
  const target = event.notification.data?.url || '/#confirm';
  event.notification.close();

  if (action === 'confirm') {
    event.waitUntil(
      (async () => {
        try {
          await confirmAllFromNotification();
        } catch (err) {
          const msg = err instanceof Error ? err.message : '최종 확인 실패';
          await self.registration.showNotification('TRADERS AI · 실패', {
            body: msg,
            tag: 'traders-ai-confirm-result',
            renotify: true,
            data: { url: '/#confirm' },
            icon: '/favicon.svg',
            badge: '/favicon.svg',
            actions: [{ action: 'open', title: '앱 열기' }],
          });
        }
      })(),
    );
    return;
  }

  event.waitUntil(openApp(target));
});
