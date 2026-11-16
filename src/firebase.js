/**
 * Firebase bootstrap for CloakDocs.
 *
 * Initializes, in this order:
 *   1. Firebase App           (config comes ONLY from import.meta.env.VITE_*)
 *   2. Firebase App Check     (debug token via VITE_APPCHECK_DEBUG_TOKEN, else reCAPTCHA)
 *   3. Firebase Authentication (anonymous sign-in, zero login friction)
 *   4. Cloud Firestore        (offline-persistent cache for the audit history)
 *   5. Firebase Remote Config (hybrid routing thresholds with local defaults)
 *   6. Firebase AI Logic      (getAI + GoogleAIBackend, used by hybridService.js)
 *
 * No secret is hardcoded anywhere. If the env vars are missing the module does
 * not throw: `isFirebaseConfigured` is false and the UI explains what to do,
 * while the on-device rules-based redactor still works.
 */
import { initializeApp } from 'firebase/app';
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
  ReCaptchaEnterpriseProvider
} from 'firebase/app-check';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  getFirestore,
  initializeFirestore,
  persistentLocalCache,
  persistentMultipleTabManager
} from 'firebase/firestore';
import { getRemoteConfig, fetchAndActivate, getValue } from 'firebase/remote-config';
import { getAI, GoogleAIBackend } from 'firebase/ai';

const env = import.meta.env;

const firebaseConfig = {
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: env.VITE_FIREBASE_APP_ID
};

const REQUIRED_KEYS = ['apiKey', 'authDomain', 'projectId', 'appId'];

export const missingConfigKeys = REQUIRED_KEYS.filter((key) => !firebaseConfig[key]).map(
  (key) => `VITE_FIREBASE_${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`
);

export const isFirebaseConfigured = missingConfigKeys.length === 0;

/** Remote Config defaults. These are also the values used when offline. */
export const DEFAULT_HYBRID_CONFIG = Object.freeze({
  /** Max characters of sanitized text that Auto Hybrid Route will try to run on-device. */
  max_local_char_limit: 6000,
  /** Kill-switch for every action that sends sanitized text to the cloud. */
  enable_cloud_deep_audit: true,
  /** Cloud model used by Firebase AI Logic (the SDK's own hybrid default). */
  cloud_model: 'gemini-3.5-flash-lite'
});

let app = null;
let appCheck = null;
let auth = null;
let db = null;
let remoteConfig = null;
let ai = null;
let initError = null;
let appCheckMode = 'disabled';

if (isFirebaseConfigured) {
  try {
    app = initializeApp(firebaseConfig);

    // ── App Check ──────────────────────────────────────────────────────────
    // The debug flag MUST be set before initializeAppCheck() runs so judges can
    // test immediately with a registered debug token.
    const debugToken = (env.VITE_APPCHECK_DEBUG_TOKEN || '').trim();
    const siteKey = (env.VITE_RECAPTCHA_SITE_KEY || '').trim();

    if (debugToken) {
      // "true" asks the SDK to generate a token and print it to the console.
      self.FIREBASE_APPCHECK_DEBUG_TOKEN = debugToken === 'true' ? true : debugToken;
      appCheckMode = 'debug';
    } else if (siteKey) {
      appCheckMode = env.VITE_RECAPTCHA_PROVIDER === 'enterprise' ? 'recaptcha-enterprise' : 'recaptcha-v3';
    }

    if (appCheckMode !== 'disabled') {
      const provider =
        appCheckMode === 'recaptcha-enterprise'
          ? new ReCaptchaEnterpriseProvider(siteKey)
          : new ReCaptchaV3Provider(siteKey || 'debug-mode-placeholder-site-key');
      appCheck = initializeAppCheck(app, {
        provider,
        isTokenAutoRefreshEnabled: true
      });
    } else {
      console.warn(
        '[CloakDocs] App Check is not configured. Set VITE_APPCHECK_DEBUG_TOKEN (dev/judging) or ' +
          'VITE_RECAPTCHA_SITE_KEY (production). Firebase AI Logic requires App Check enforcement.'
      );
    }

    // ── Auth ───────────────────────────────────────────────────────────────
    auth = getAuth(app);

    // ── Firestore (persistent cache so history still renders offline) ───────
    try {
      db = initializeFirestore(app, {
        localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
      });
    } catch (cacheError) {
      console.warn('[CloakDocs] Persistent Firestore cache unavailable, using memory cache.', cacheError);
      db = getFirestore(app);
    }

    // ── Remote Config ──────────────────────────────────────────────────────
    remoteConfig = getRemoteConfig(app);
    remoteConfig.settings.minimumFetchIntervalMillis = env.DEV ? 60 * 1000 : 60 * 60 * 1000;
    remoteConfig.settings.fetchTimeoutMillis = 8000;
    remoteConfig.defaultConfig = { ...DEFAULT_HYBRID_CONFIG };

    // ── Firebase AI Logic (Gemini Developer API backend) ───────────────────
    ai = getAI(app, { backend: new GoogleAIBackend() });
  } catch (error) {
    initError = error;
    console.error('[CloakDocs] Firebase initialization failed:', error);
  }
}

export { app, appCheck, auth, db, remoteConfig, ai, initError, appCheckMode };

/**
 * Resolve once an anonymous user exists. Auth persists the anonymous user in
 * IndexedDB, so after the first online visit this also works fully offline.
 * Returns the user, or null when sign-in is currently impossible (offline first run).
 */
export async function ensureAnonymousAuth() {
  if (!auth) return null;
  try {
    await auth.authStateReady();
    if (auth.currentUser) return auth.currentUser;
    const credential = await signInAnonymously(auth);
    return credential.user;
  } catch (error) {
    console.warn('[CloakDocs] Anonymous sign-in failed:', error?.code || error);
    return null;
  }
}

/**
 * Fetch + activate Remote Config and return the hybrid routing policy.
 * Always resolves with usable values (local defaults on failure / offline).
 */
export async function loadHybridConfig() {
  const cloudModelOverride = (env.VITE_CLOUD_MODEL || '').trim();

  if (!remoteConfig) {
    return {
      config: { ...DEFAULT_HYBRID_CONFIG, ...(cloudModelOverride && { cloud_model: cloudModelOverride }) },
      source: 'default'
    };
  }

  try {
    await fetchAndActivate(remoteConfig);
  } catch (error) {
    console.warn('[CloakDocs] Remote Config fetch failed, using cached/default values.', error?.code || error);
  }
  return readHybridConfig(cloudModelOverride);
}

/** Read the currently activated Remote Config values (no network). */
export function readHybridConfig(cloudModelOverride = (env.VITE_CLOUD_MODEL || '').trim()) {
  if (!remoteConfig) {
    return { config: { ...DEFAULT_HYBRID_CONFIG }, source: 'default' };
  }

  const limitValue = getValue(remoteConfig, 'max_local_char_limit');
  const auditValue = getValue(remoteConfig, 'enable_cloud_deep_audit');
  const modelValue = getValue(remoteConfig, 'cloud_model');

  const parsedLimit = Number(limitValue.asNumber());
  const maxLocalCharLimit =
    Number.isFinite(parsedLimit) && parsedLimit >= 500
      ? Math.floor(parsedLimit)
      : DEFAULT_HYBRID_CONFIG.max_local_char_limit;

  const remoteModel = (modelValue.asString() || '').trim();

  return {
    config: {
      max_local_char_limit: maxLocalCharLimit,
      enable_cloud_deep_audit: auditValue.asBoolean(),
      cloud_model: cloudModelOverride || remoteModel || DEFAULT_HYBRID_CONFIG.cloud_model
    },
    source: limitValue.getSource()
  };
}
