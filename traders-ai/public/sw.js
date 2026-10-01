/* Traders AI — Web Push service worker (v2: notify action confirm) */
const CONFIRM_PHRASE = '최종확인';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

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
  const res = await fetch('/api/alerts/confirm-all', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ngrok-skip-browser-warning': 'true',
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
  const notice =
    data.notice ||
    (failed
      ? `${confirmed}건 성공, ${failed}건 실패`
      : confirmed
        ? `${confirmed}건 최종 확인·주문 완료`
        : data.skippedReason || '대기 주문 없음');

  await self.registration.showNotification('TRADERS AI · 완료', {
    body: notice,
    tag: 'traders-ai-confirm-result',
    renotify: true,
    data: { url: '/' },
    icon: '/favicon.svg',
    badge: '/favicon.svg',
  });

  // 열려 있는 앱이 있으면 대시보드 갱신 유도
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

  // 기본 탭 / 「자세히」 → 앱 열기
  event.waitUntil(openApp(target));
});
