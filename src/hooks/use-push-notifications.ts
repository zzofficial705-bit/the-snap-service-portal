'use client';

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from './use-auth';
import { DeviceSubscription, DeviceType } from '@/lib/types';
import { requestFCMToken, onForegroundMessage } from '@/lib/firebase';

import { VAPID_PUBLIC_KEY } from '@/lib/vapid-keys';

function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = window.atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

function detectDevice(): { deviceType: DeviceType; deviceName: string } {
  if (typeof window === 'undefined') {
    return { deviceType: 'browser', deviceName: 'Web Browser' };
  }

  const ua = navigator.userAgent || '';
  const isStandalone = (window.navigator as any).standalone || window.matchMedia('(display-mode: standalone)').matches;

  let deviceType: DeviceType = 'browser';
  let deviceName = 'Web Browser';

  if (/iPhone|iPad|iPod/i.test(ua)) {
    deviceType = isStandalone ? 'ios_pwa' : 'browser';
    deviceName = isStandalone ? 'iPhone (Snap Service App)' : 'Safari on iPhone';
  } else if (/Android/i.test(ua)) {
    deviceType = 'android';
    deviceName = isStandalone ? 'Android (Snap Service App)' : 'Chrome on Android';
  } else if (/Macintosh|Mac OS X/i.test(ua)) {
    deviceType = 'mac';
    deviceName = ua.includes('Chrome') ? 'Mac (Chrome)' : ua.includes('Safari') ? 'Mac (Safari)' : 'Mac Computer';
  } else if (/Windows/i.test(ua)) {
    deviceType = 'windows';
    deviceName = 'Windows PC';
  }

  return { deviceType, deviceName };
}

export function usePushNotifications() {
  const { currentUser } = useAuth();
  const [isSupported, setIsSupported] = useState(false);
  const [permission, setPermission] = useState<NotificationPermission>('default');
  const [isSubscribed, setIsSubscribed] = useState(false);
  const [fcmToken, setFcmToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [registeredDevices, setRegisteredDevices] = useState<DeviceSubscription[]>([]);

  // Check support & initial permission
  useEffect(() => {
    if (typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
      setIsSupported(true);
      setPermission(Notification.permission);

      // Register Service Worker in background
      navigator.serviceWorker
        .register('/firebase-messaging-sw.js')
        .then((reg) => {
          return reg.pushManager.getSubscription();
        })
        .then((sub) => {
          setIsSubscribed(!!sub);
        })
        .catch((err) => {
          console.warn('Service Worker registration warning:', err);
        });

      // Listen for foreground Firebase Cloud Messaging push events
      const unsubscribeFg = onForegroundMessage((payload) => {
        console.log('Received foreground push notification:', payload);
        const title = payload.notification?.title || payload.data?.title || 'Snap Service Reminder';
        const body = payload.notification?.body || payload.data?.body || 'Task update available.';
        if (Notification.permission === 'granted') {
          new Notification(title, {
            body,
            icon: '/snap-service-logo.png',
          });
        }
      });

      return () => {
        if (unsubscribeFg) unsubscribeFg();
      };
    }
  }, []);

  // Fetch registered devices for current user
  const fetchDevices = useCallback(async () => {
    if (!currentUser?.id) return;
    try {
      const res = await fetch(`/api/notifications/subscribe?userId=${encodeURIComponent(currentUser.id)}`);
      if (res.ok) {
        const data = await res.json();
        if (data && Array.isArray(data.subscriptions)) {
          setRegisteredDevices(data.subscriptions);
        }
      }
    } catch (e) {
      console.error('Error fetching registered devices:', e);
    }
  }, [currentUser?.id]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  // Request permission & subscribe current device
  const subscribe = async (): Promise<{ success: boolean; error?: string }> => {
    if (!isSupported) {
      return { success: false, error: 'Push notifications are not supported on this browser/device.' };
    }

    setLoading(true);

    try {
      // 1. Request permission
      const perm = await Notification.requestPermission();
      setPermission(perm);

      if (perm !== 'granted') {
        setLoading(false);
        return { success: false, error: 'Notification permission was denied.' };
      }

      // 2. Ready Service Worker (using firebase-messaging-sw.js)
      const registration = await navigator.serviceWorker.register('/firebase-messaging-sw.js');
      await navigator.serviceWorker.ready;

      // 3. Obtain Matched VAPID Public Key
      let vapidPublicKey = VAPID_PUBLIC_KEY;
      if (!vapidPublicKey) {
        const configRes = await fetch('/api/notifications/subscribe');
        const configData = await configRes.json();
        vapidPublicKey = configData.publicKey;
      }

      if (!vapidPublicKey) {
        throw new Error('VAPID public key not found');
      }

      // 4. Subscribe with PushManager (renewing if existing subscription was on old key)
      const convertedKey = urlBase64ToUint8Array(vapidPublicKey);
      let subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        try {
          await subscription.unsubscribe();
        } catch {}
      }

      subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: convertedKey,
      });

      // 5. Try requesting FCM Device Token
      let token: string | null = null;
      try {
        token = await requestFCMToken(vapidPublicKey, registration);
        if (token) {
          setFcmToken(token);
        }
      } catch (fcmErr) {
        console.warn('FCM token retrieval warning (will use standard Web Push):', fcmErr);
      }

      // 6. Detect Device details
      const { deviceType, deviceName } = detectDevice();

      // 7. Send subscription to server
      const saveRes = await fetch('/api/notifications/subscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser?.id || 'user-super-admin',
          userName: currentUser?.name || 'Studio Admin',
          userEmail: currentUser?.email,
          deviceType,
          deviceName,
          userAgent: navigator.userAgent,
          subscription: subscription.toJSON(),
          fcmToken: token || undefined,
        }),
      });

      if (!saveRes.ok) {
        throw new Error('Failed to register subscription on server');
      }

      setIsSubscribed(true);
      await fetchDevices();
      setLoading(false);
      return { success: true };
    } catch (error: any) {
      console.error('Error subscribing to push notifications:', error);
      setLoading(false);
      return { success: false, error: error.message || 'Subscription failed' };
    }
  };

  // Unsubscribe current device
  const unsubscribe = async (): Promise<boolean> => {
    if (!isSupported) return false;
    setLoading(true);

    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();

      if (subscription) {
        await subscription.unsubscribe();
        await fetch(`/api/notifications/subscribe?endpoint=${encodeURIComponent(subscription.endpoint)}`, {
          method: 'DELETE',
        });
      }

      setIsSubscribed(false);
      await fetchDevices();
      setLoading(false);
      return true;
    } catch (e) {
      console.error('Error unsubscribing:', e);
      setLoading(false);
      return false;
    }
  };

  // Send a test notification
  const sendTestNotification = async (): Promise<{ success: boolean; message?: string }> => {
    try {
      const res = await fetch('/api/notifications/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: currentUser?.id || 'user-super-admin',
          userName: currentUser?.name || 'Studio Admin',
        }),
      });
      const data = await res.json();
      return { success: res.ok, message: data.message || 'Test sent' };
    } catch (e: any) {
      return { success: false, message: e.message || 'Failed to send test push' };
    }
  };

  // Visibility-aware & cross-tab throttled reminder trigger (1 check per 3 minutes across all open tabs)
  const triggerReminderCheck = async () => {
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
      return;
    }
    const LAST_CHECK_KEY = 'snap_last_reminder_check_ts';
    const THROTTLE_MS = 180000; // 3 minutes
    const now = Date.now();
    try {
      const lastCheck = parseInt(localStorage.getItem(LAST_CHECK_KEY) || '0', 10);
      if (now - lastCheck < THROTTLE_MS) {
        return;
      }
      localStorage.setItem(LAST_CHECK_KEY, now.toString());
      await fetch('/api/tasks/reminders/process?secret=07c2bd3724930049d755d62352ce8dcaf046f5e355d3d910131b1f764fadb2ea&skipDigest=1');
    } catch {}
  };

  useEffect(() => {
    triggerReminderCheck();
    const interval = setInterval(triggerReminderCheck, 180000);
    return () => clearInterval(interval);
  }, []);

  return {
    isSupported,
    permission,
    isSubscribed,
    loading,
    registeredDevices,
    subscribe,
    unsubscribe,
    sendTestNotification,
    triggerReminderCheck,
    refreshDevices: fetchDevices,
  };
}
