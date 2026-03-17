// TODO SETUP Google Sheets API Configuration

const API_KEY = 'AIzaSyDMLfR5FEwm8F4l2AZFB0xgHoM1PlTwEpM';        // Run from and data stored in a...h...@gmail.com Google Sheets and Cloud Console Google Sheets API access

const CLIENT_ID = '198184405189-k0fgpof1g7u9tlkd332gdi7f9v627mgc.apps.googleusercontent.com';

// Optional: Set your spreadsheet ID here to share the same data across different domains (localhost + GitHub Pages)
// Leave empty to create a new spreadsheet or use domain-specific storage
// Example: const SPREADSHEET_ID = '1abc...xyz';
const SPREADSHEET_ID = '1UYVZMilFCtTNoFimamdNYkGXRcw-N72GiQyckBEGv_c';  

/*******************************************************************/

// Only show the "consider quitting" warning when the declining recent
// portion covers at least this percentage of total time.
const DEFAULT_WARNING_THRESHOLD_PERCENT = 20;
let WARNING_THRESHOLD_PERCENT = DEFAULT_WARNING_THRESHOLD_PERCENT;

const DISCOVERY_DOCS = ['https://sheets.googleapis.com/$discovery/rest?version=v4'];
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';
const OAUTH_STATE_KEY = 'oauthState';

function isNativeAndroid() {
    try {
        const platform = window.Capacitor?.getPlatform?.();
        if (platform === 'android') return true;

        // Fallback detection for Capacitor WebView where getPlatform may not be ready yet.
        const originLooksNative = window.location.origin === 'https://localhost';
        const ua = navigator.userAgent || '';
        const uaLooksAndroid = /Android/i.test(ua);
        return originLooksNative && (uaLooksAndroid || !!window.Capacitor);
    } catch (e) {
        return false;
    }
}

function parseOAuthTokenFromUrl(rawUrl) {
    if (!rawUrl) return null;
    try {
        const parsed = new URL(rawUrl);
        if (!parsed.hash || parsed.hash.length < 2) return null;
        const params = new URLSearchParams(parsed.hash.slice(1));
        const accessToken = params.get('access_token');
        if (!accessToken) return null;

        const expiresInSec = parseInt(params.get('expires_in') || '3600', 10);
        return {
            access_token: accessToken,
            token_type: params.get('token_type') || 'Bearer',
            expires_in: Number.isFinite(expiresInSec) ? expiresInSec : 3600,
            expires_at: Date.now() + ((Number.isFinite(expiresInSec) ? expiresInSec : 3600) * 1000)
        };
    } catch (e) {
        return null;
    }
}

// Global State
let gapiInited = false;
let gisInited = false;
let spreadsheetId = SPREADSHEET_ID || localStorage.getItem('spreadsheetId') || null;
let currentActivity = null;
let timerInterval = null;
let timerStartTime = null;
let elapsedSeconds = 0;
let isAuthenticated = false; // Track if user is authenticated and ready
let errorShown = false; // Track if error modal already shown
let authInProgress = false;
let oauthErrorSeen = false;
let pendingRatingActivityId = null;
let settingsPanelOpen = false;
let runningTimers = JSON.parse(localStorage.getItem('runningTimers')) || {}; // { activityId: { startTime, elapsed, activityName } }
let pausedTimers = {}; // in-memory only; cleared on reload if no save
let homeTimersSyncInFlight = false;
let saveRatingInFlight = false;
let readQuotaBackoffUntil = 0;
let readQuotaWarningShown = false;
let lastHomeActivitiesRefreshAt = 0;

const HOME_TIMER_SYNC_INTERVAL_MS = 15000;
const HOME_ACTIVITIES_REFRESH_MS = 60000;
const QUOTA_BACKOFF_MS = 65000;

// ─── Capacitor native bridge (graceful no-op in browser) ─────────────────────
const TimerPlugin = (() => {
    try { return window.Capacitor?.Plugins?.TimerPlugin || null; } catch (e) { return null; }
})();

async function notifyNativeTimerStart(activityId, activityName, startTime) {
    if (!TimerPlugin) return;
    try { await TimerPlugin.startService({ activityId, activityName, startTime }); }
    catch (e) { console.warn('TimerPlugin.startService:', e); }
}

async function notifyNativeTimerStop(activityId = null) {
    if (!TimerPlugin) return;
    try {
        if (activityId) {
            await TimerPlugin.stopService({ activityId });
        } else {
            await TimerPlugin.stopService();
        }
    }
    catch (e) { console.warn('TimerPlugin.stopService:', e); }
}

function formatElapsedHms(totalSeconds) {
    const seconds = Math.max(0, Math.floor(totalSeconds || 0));
    const days = Math.floor(seconds / 86400);
    const dayRemainder = seconds % 86400;
    const hours = Math.floor(dayRemainder / 3600);
    const minutes = Math.floor((dayRemainder % 3600) / 60);
    const secs = dayRemainder % 60;
    const hms = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return days > 0 ? `${days}d ${hms}` : hms;
}

function formatDurationMinutesDhm(totalMinutes) {
    const safe = Math.max(0, Math.floor(totalMinutes || 0));
    const days = Math.floor(safe / (24 * 60));
    const rem = safe % (24 * 60);
    const hours = Math.floor(rem / 60);
    const minutes = rem % 60;
    return `${days}d ${hours}h ${minutes}m`;
}

function parseNonNegativeInt(value) {
    const parsed = parseInt(value, 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 0;
}

function setManualDurationFromSeconds(totalSeconds) {
    const totalMinutes = Math.max(0, Math.floor((totalSeconds || 0) / 60));
    const days = Math.floor(totalMinutes / (24 * 60));
    const remainderMinutes = totalMinutes % (24 * 60);
    const hours = Math.floor(remainderMinutes / 60);
    const minutes = remainderMinutes % 60;

    const daysEl = document.getElementById('manualDays');
    const hoursEl = document.getElementById('manualHours');
    const minutesEl = document.getElementById('manualMinutes');
    if (daysEl) daysEl.value = days;
    if (hoursEl) hoursEl.value = hours;
    if (minutesEl) minutesEl.value = minutes;

    updateSaveRatingButtonState();
}

function getManualDurationMinutes() {
    const days = parseNonNegativeInt(document.getElementById('manualDays')?.value);
    const hours = parseNonNegativeInt(document.getElementById('manualHours')?.value);
    const minutes = parseNonNegativeInt(document.getElementById('manualMinutes')?.value);
    return (days * 24 * 60) + (hours * 60) + minutes;
}

function updateSaveRatingButtonState() {
    const saveBtn = document.querySelector('#manualEntryForm button[type="submit"]');
    if (!saveBtn) return;
    const totalMinutes = getManualDurationMinutes();
    saveBtn.disabled = saveRatingInFlight || totalMinutes === 0;
}

function enforceCompactDurationInputs() {
    const row = document.querySelector('#manualEntryForm .duration-row');
    if (!row) return;

    row.style.display = 'flex';
    row.style.flexWrap = 'nowrap';
    row.style.justifyContent = 'center';
    row.style.alignItems = 'flex-end';
    row.style.gap = '0.25rem';

    const isSmall = window.innerWidth <= 400;
    const width = isSmall ? '3rem' : '3rem';

    row.querySelectorAll('.form-group').forEach((group) => {
        group.style.flex = '0 0 auto';
        group.style.width = width;
        group.style.minWidth = width;
        group.style.maxWidth = width;
        group.style.marginBottom = '0.4rem';
    });

    row.querySelectorAll('label').forEach((label) => {
        label.style.fontSize = '0.875rem';
        label.style.marginBottom = '0.2rem';
        label.style.textAlign = 'center';
    });

    ['manualDays', 'manualHours', 'manualMinutes'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.width = width;
        el.style.minWidth = width;
        el.style.maxWidth = width;
        el.style.padding = '0.15rem 0.2rem';
        el.style.height = '1.85rem';
        el.style.fontSize = '1rem';
        el.style.textAlign = 'center';
        el.style.boxSizing = 'border-box';
    });
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getApiErrorStatus(error) {
    return Number(error?.status || error?.result?.error?.code || 0);
}

function isRetryableApiError(error) {
    const status = getApiErrorStatus(error);
    return [429, 500, 502, 503, 504].includes(status);
}

function isReadQuotaExceededError(error) {
    const status = getApiErrorStatus(error);
    const message = (error?.result?.error?.message || error?.message || '').toLowerCase();
    if (status === 429) return true;
    return message.includes('quota exceeded') || message.includes('read requests per minute per user');
}

function getRunningTimersFingerprint() {
    return Object.entries(runningTimers || {})
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([id, t]) => `${id}:${Number(t?.startTime || 0)}`)
        .join('|');
}

function handleReadQuotaExceeded(context, error) {
    readQuotaBackoffUntil = Date.now() + QUOTA_BACKOFF_MS;
    if (!readQuotaWarningShown) {
        readQuotaWarningShown = true;
        showError('Google Sheets read-rate limit reached. Auto-retrying in about a minute.');
    }
    console.warn(`${context}: read quota exceeded`, error);
}

async function runWithApiRetries(task, label, maxRetries = 3, baseDelayMs = 400) {
    let attempt = 0;
    while (true) {
        try {
            return await task();
        } catch (error) {
            if (!isRetryableApiError(error) || attempt >= maxRetries) {
                throw error;
            }
            const delayMs = baseDelayMs * Math.pow(2, attempt);
            console.warn(`${label} failed with retryable status ${getApiErrorStatus(error)}. Retrying in ${delayMs}ms...`);
            await sleep(delayMs);
            attempt += 1;
        }
    }
}

async function syncRunningTimersToNativeNotifications(forceReconcile = false) {
    if (!TimerPlugin) return;

    if (forceReconcile) {
        // Clear all native timer notifications/service state first, then rebuild
        // from the current runningTimers snapshot to avoid stale notifications.
        await notifyNativeTimerStop();
    }

    const entries = Object.entries(runningTimers || {});
    for (const [activityId, timer] of entries) {
        const startTime = Number(timer?.startTime);
        const activityName = getKnownActivityName(activityId, timer?.activityName || 'Activity');
        if (!activityId || !Number.isFinite(startTime) || startTime <= 0) continue;
        await notifyNativeTimerStart(activityId, activityName, startTime);
    }
}

async function syncActivitiesToNative(activities) {
    if (!TimerPlugin) return;
    try { await TimerPlugin.syncActivities({ activities }); }
    catch (e) { console.warn('TimerPlugin.syncActivities:', e); }
}

async function syncNativeAuthContext() {
    if (!TimerPlugin) return;
    const accessToken = gapi?.client?.getToken?.()?.access_token;
    if (!spreadsheetId || !accessToken) return;
    try {
        await TimerPlugin.syncAuthContext({ spreadsheetId, accessToken });
    } catch (e) {
        console.warn('TimerPlugin.syncAuthContext:', e);
    }
}

async function clearNativeAuthContext() {
    if (!TimerPlugin) return;
    try {
        await TimerPlugin.clearAuthContext();
    } catch (e) {
        console.warn('TimerPlugin.clearAuthContext:', e);
    }
}

async function checkNativeLaunchIntent() {
    if (!TimerPlugin) return;
    try {
        const result = await TimerPlugin.getIntentAction();
        if (result.action === 'STOP_AND_RATE') {
            if (result.activityId && result.activityName) {
                openActivity(result.activityId, result.activityName);
            }
        } else if (result.action === 'OPEN_ACTIVITY') {
            if (result.activityId && result.activityName) {
                openActivity(result.activityId, result.activityName);
            }
        }
    } catch (e) { console.warn('TimerPlugin.getIntentAction:', e); }
}

// Re-check intent when app comes back to foreground (notification tap while app open)
if (window.Capacitor?.Plugins?.App) {
    window.Capacitor.Plugins.App.addListener('appStateChange', async ({ isActive }) => {
        if (isActive && isAuthenticated) {
            checkNativeLaunchIntent();
            await loadTimersFromSheet();
            await syncRunningTimersToNativeNotifications(true);
            const homePage = document.getElementById('homePage');
            if (homePage && homePage.classList.contains('active')) {
                loadActivities();
            }
        }
    });

    // Handle OAuth callback URLs when Android browser redirects back into the app.
    window.Capacitor.Plugins.App.addListener('appUrlOpen', ({ url }) => {
        const token = parseOAuthTokenFromUrl(url);
        if (!token) return;

        localStorage.setItem('gapiToken', JSON.stringify(token));
        // Re-run app bootstrap with the new token.
        window.location.reload();
    });
}

// ─── Quick-Rate modal state ───────────────────────────────────────────────────
let _quickRateActivity    = null;
let _quickRateDurationMins = 0;
let _allActivitiesCache   = [];

// Error Handling
function showError(message, errorType = 'general') {
    const errorModal = document.getElementById('errorModal');
    const errorMessage = document.getElementById('errorMessage');
    errorMessage.textContent = message;
    
    // Show specific instructions based on error type
    const popupInstructions = document.getElementById('popupInstructions');
    const originInstructions = document.getElementById('originInstructions');
    const refererInstructions = document.getElementById('refererInstructions');
    const testUserInstructions = document.getElementById('testUserInstructions');
    
    // Hide all special instruction sections first
    if (popupInstructions) popupInstructions.classList.add('hidden');
    if (originInstructions) originInstructions.classList.add('hidden');
    if (refererInstructions) refererInstructions.classList.add('hidden');
    if (testUserInstructions) testUserInstructions.classList.add('hidden');
    
    // Show appropriate instructions
    if (errorType === 'popup' && popupInstructions) {
        popupInstructions.classList.remove('hidden');
    } else if (errorType === 'origin' && originInstructions) {
        originInstructions.classList.remove('hidden');
    } else if (errorType === 'referer' && refererInstructions) {
        refererInstructions.classList.remove('hidden');
    } else if (errorType === 'testuser' && testUserInstructions) {
        testUserInstructions.classList.remove('hidden');
    }
    
    errorModal.classList.remove('hidden');
    errorShown = true;
    
    // Hide loading indicator
    const loadingIndicator = document.getElementById('loadingIndicator');
    if (loadingIndicator) {
    }
}

function hideError() {
    const errorModal = document.getElementById('errorModal');
    errorModal.classList.add('hidden');
    errorShown = false;
}

function checkConfiguration() {
    if (API_KEY === 'YOUR_API_KEY_HERE' || CLIENT_ID === 'YOUR_CLIENT_ID_HERE') {
        showError('API credentials not configured. Please update API_KEY and CLIENT_ID in app.js');
        return false;
    }
    return true;
}

// Handle expired or invalid token
function handleTokenExpiration() {
    console.log('Token expired or invalid, clearing and requesting new token');
    localStorage.removeItem('gapiToken');
    gapi.client.setToken(null);
    clearNativeAuthContext();
    isAuthenticated = false;
    // Reload page to re-authenticate
    window.location.reload();
}

// Initialize Google API
function gapiLoaded() {
    if (!checkConfiguration()) {
        return;
    }
    
    try {
        gapi.load('client', initializeGapiClient);
    } catch (error) {
        console.error('Error loading GAPI:', error);
        showError('Failed to load Google API. Check your internet connection and make sure you\'re serving the app over HTTP/HTTPS.');
    }
}

async function initializeGapiClient() {
    try {
        // Do NOT include apiKey here. The discovery-doc URL is public; adding the API key
        // causes Google to enforce HTTP-referrer restrictions on the CORS preflight, which
        // blocks requests from https://localhost (the Capacitor WebView origin). Omitting
        // the key lets the fetch succeed from any origin. All actual Sheets API calls
        // are authenticated via the OAuth Bearer token set by gapi.client.setToken(), so
        // the API key is not needed for them either.
        await gapi.client.init({
            discoveryDocs: DISCOVERY_DOCS,
        });
        gapiInited = true;
        maybeEnableButtons();
    } catch (error) {
        console.error('Error initializing GAPI client:', error);
        let errorMsg;
        try {
            // Capture everything – a network/CORS failure produces an empty object {}
            // while an API-level error has result.error.message.
            errorMsg = error.message
                || error.result?.error?.message
                || error.details
                || (Object.keys(error).length ? JSON.stringify(error).substring(0, 300) : null)
                || 'Unknown error (likely a CORS / network failure fetching the Google Sheets discovery document)';
        } catch (e) { errorMsg = 'Unknown error'; }
        const errorCode = error.result?.error?.code || error.code;
        
        // Check for referer blocked error (403 from API Key restriction)
        if (errorCode === 403 && (errorMsg.includes('referer') || errorMsg.includes('Requests from referer'))) {
            showError('API Key restriction: Requests from this domain are blocked. Your API Key needs to allow this domain.', 'referer');
        } else if (errorMsg.includes('has not been used') || errorMsg.includes('not enabled')) {
            errorMsg = 'Google Sheets API is not enabled in your project. Go to Google Cloud Console > APIs & Services > Library, search for "Google Sheets API" (not BigQuery or other APIs), and click Enable.';
            showError('Failed to initialize Google Sheets API. Error: ' + errorMsg);
        } else {
            showError('Failed to initialize Google Sheets API. Error: ' + errorMsg);
        }
    }
}

function gisLoaded() {
    // Redirect-only auth does not require GIS popup client.
    gisInited = true;
    maybeEnableButtons();
}

function maybeEnableButtons() {
    if (gapiInited) {
        initializeApp();
    }
}

function getRetryButton() {
    return document.getElementById('retryConnectionBtn');
}

function setRetryButtonForSignIn() {
    const retryBtn = getRetryButton();
    if (!retryBtn) return;
    retryBtn.textContent = 'Connect Google';
}

function setRetryButtonForRetry() {
    const retryBtn = getRetryButton();
    if (!retryBtn) return;
    retryBtn.textContent = 'Retry Connection';
}

function clearUrlHash() {
    if (!window.location.hash) return;
    const cleanUrl = window.location.pathname + window.location.search;
    window.history.replaceState({}, document.title, cleanUrl);
}

function getRedirectUri() {
    if (isNativeAndroid()) {
        return 'https://localhost';
    }

    // Use the exact current page URL (without query/hash) so Google receives
    // the same redirect URI users can register in Cloud Console.
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';

    // Google redirect URI checks are strict; localhost root often gets registered
    // without a trailing slash in Cloud Console.
    const isLocalhostRoot =
        url.hostname === 'localhost' &&
        (url.pathname === '/' || url.pathname === '');
    if (isLocalhostRoot) {
        return `${url.protocol}//${url.host}`;
    }

    return url.toString();
}

function getOAuthTokenFromHash() {
    if (!window.location.hash || window.location.hash.length < 2) return null;
    const params = new URLSearchParams(window.location.hash.slice(1));

    if (params.get('error')) {
        oauthErrorSeen = true;
        const error = params.get('error') || '';
        const errorDescription = params.get('error_description') || error;
        clearUrlHash();

        if (error.includes('access_denied')) {
            showError('Sign-in was canceled. Tap "Connect Google" to try again.', 'popup');
        } else if (error.includes('redirect_uri')) {
            showError('OAuth redirect URI is not authorized. Add this exact URI to Authorized redirect URIs: ' + getRedirectUri(), 'origin');
        } else {
            showError('Google sign-in failed: ' + errorDescription);
        }
        return null;
    }

    const accessToken = params.get('access_token');
    if (!accessToken) return null;

    const returnedState = params.get('state') || '';
    const expectedState = localStorage.getItem(OAUTH_STATE_KEY) || '';
    localStorage.removeItem(OAUTH_STATE_KEY);

    if (expectedState && returnedState !== expectedState) {
        clearUrlHash();
        showError('OAuth state validation failed. Tap "Connect Google" and try again.');
        return null;
    }

    const expiresInSec = parseInt(params.get('expires_in') || '3600', 10);
    const token = {
        access_token: accessToken,
        token_type: params.get('token_type') || 'Bearer',
        expires_in: Number.isFinite(expiresInSec) ? expiresInSec : 3600,
        expires_at: Date.now() + ((Number.isFinite(expiresInSec) ? expiresInSec : 3600) * 1000)
    };

        oauthErrorSeen = false;

    clearUrlHash();
    return token;
}

function startAndroidRedirectAuth() {
    const state = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    localStorage.setItem(OAUTH_STATE_KEY, state);

    const redirectUri = getRedirectUri();
    const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    authUrl.searchParams.set('client_id', CLIENT_ID);
    authUrl.searchParams.set('redirect_uri', redirectUri);
    authUrl.searchParams.set('response_type', 'token');
    authUrl.searchParams.set('scope', SCOPES);
    authUrl.searchParams.set('include_granted_scopes', 'true');
    authUrl.searchParams.set('prompt', 'consent select_account');
    authUrl.searchParams.set('state', state);

    window.location.assign(authUrl.toString());
}

function requestGoogleAuthFromUserGesture() {
    if (!gapiInited) {
        showError('Google services are still initializing. Please try again in a moment.');
        return;
    }
    startAndroidRedirectAuth();
}

// Initialize App
async function initializeApp() {
    try {
        const tokenFromHash = getOAuthTokenFromHash();

        if (tokenFromHash) {
            gapi.client.setToken(tokenFromHash);
            localStorage.setItem('gapiToken', JSON.stringify(tokenFromHash));
        }

        // Re-create persistent native notifications for any locally running timers
        // as soon as the app starts.
        await syncRunningTimersToNativeNotifications();

        // Try to restore token from localStorage
        const savedToken = localStorage.getItem('gapiToken');
        let tokenValid = false;
        
        if (savedToken) {
            try {
                const token = JSON.parse(savedToken);
                
                // Check if token has expired (tokens include expires_in timestamp)
                if (token.expires_at) {
                    const now = Date.now();
                    if (now < token.expires_at) {
                        gapi.client.setToken(token);
                        tokenValid = true;
                        console.log('Restored valid token from localStorage');
                    } else {
                        console.log('Token expired, will request new one');
                        localStorage.removeItem('gapiToken');
                    }
                } else {
                    // Old token format without expiration, try to use it
                    gapi.client.setToken(token);
                    tokenValid = true;
                    console.log('Restored token from localStorage (no expiration info)');
                }
            } catch (e) {
                console.warn('Failed to restore token:', e);
                localStorage.removeItem('gapiToken');
            }
        }
        
        // Check if we have a valid access token
        if (!tokenValid || gapi.client.getToken() === null) {
            await clearNativeAuthContext();
            setRetryButtonForSignIn();
            if (!oauthErrorSeen) {
                // Redirect-based auth can be auto-started when not signed in.
                requestGoogleAuthFromUserGesture();
                return;
            }
            showError('Tap "Connect Google" below to sign in. This uses full-page redirect (no popup).');
        } else {
            await setupSpreadsheet();
            await loadWarningThresholdSetting();
            renderWarningThresholdSettings();
            await syncNativeAuthContext();
            updateSpreadsheetLink();
            await loadTimersFromSheet();
            await syncRunningTimersToNativeNotifications();
            await loadActivities();
            isAuthenticated = true;
            renderWarningThresholdSettings();
            enableAppButtons();
            checkNativeLaunchIntent();
            setRetryButtonForRetry();
        }
    } catch (error) {
        console.error('Error initializing app:', error);
        showError('Failed to initialize app: ' + (error.message || 'Unknown error'));
    }
}

// Enable app buttons after authentication
function enableAppButtons() {
    const addActivityBtn = document.getElementById('addActivityBtn');
    if (addActivityBtn) {
        addActivityBtn.disabled = false;
        addActivityBtn.textContent = '+ Add New Activity';
    }
}

// Disable app buttons during initialization
function disableAppButtons() {
    const addActivityBtn = document.getElementById('addActivityBtn');
    if (addActivityBtn) {
        addActivityBtn.disabled = true;
        addActivityBtn.textContent = 'Initializing...';
    }
}

// Spreadsheet Management
async function setupSpreadsheet() {
    if (!spreadsheetId) {
        // Create a new spreadsheet
        try {
            const response = await gapi.client.sheets.spreadsheets.create({
                properties: {
                    title: 'when_to_quit_chernovs_marginal_value_theorem'
                },
                sheets: [
                    {
                        properties: {
                            title: 'Activities'
                        }
                    },
                    {
                        properties: {
                            title: 'Sessions'
                        }
                    }
                ]
            });
            spreadsheetId = response.result.spreadsheetId;
            
            // Only save to localStorage if not using a hardcoded SPREADSHEET_ID
            if (!SPREADSHEET_ID) {
                localStorage.setItem('spreadsheetId', spreadsheetId);
            }
            
            // Initialize headers
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: 'Activities!A1:B1',
                valueInputOption: 'RAW',
                resource: {
                    values: [['Activity ID', 'Activity Name']]
                }
            });
            
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: 'Sessions!A1:E1',
                valueInputOption: 'RAW',
                resource: {
                    values: [['Session ID', 'Activity ID', 'Date', 'Duration (minutes)', 'Reward Rating']]
                }
            });
            
            console.log('Created new spreadsheet:', spreadsheetId);
        } catch (error) {
            console.error('Error creating spreadsheet:', error);
            
            // Check if token expired
            const status = error.status || error.result?.error?.code;
            if (status === 401 || status === 403) {
                handleTokenExpiration();
                throw error;
            }
            
            let errorMsg = error.result?.error?.message || error.message || 'Check API permissions';
            if (errorMsg.includes('has not been used') || errorMsg.includes('not enabled')) {
                errorMsg = 'Google Sheets API is NOT enabled. Enable it in Google Cloud Console > APIs & Services > Library. Search for "Google Sheets API" specifically.';
            }
            showError('Failed to create spreadsheet: ' + errorMsg);
            throw error;
        }
    }
    // Ensure Timers sheet exists (for both new and existing spreadsheets)
    await ensureTimersSheet();
    // Ensure Settings sheet exists (for both new and existing spreadsheets)
    await ensureSettingsSheet();
}

// Create the Timers sheet if it doesn't already exist
async function ensureTimersSheet() {
    try {
        await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A1:B1',
        });
    } catch (e) {
        // Sheet doesn't exist — create it
        try {
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                resource: { requests: [{ addSheet: { properties: { title: 'Timers' } } }] }
            });
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: 'Timers!A1:B1',
                valueInputOption: 'RAW',
                resource: { values: [['Activity ID', 'Start Time']] }
            });
        } catch (err) {
            console.warn('Could not create Timers sheet:', err);
        }
    }
}

// Create the Settings sheet if it doesn't already exist
async function ensureSettingsSheet() {
    try {
        await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Settings!A1:B1',
        });
    } catch (e) {
        try {
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                resource: { requests: [{ addSheet: { properties: { title: 'Settings' } } }] }
            });
            await gapi.client.sheets.spreadsheets.values.update({
                spreadsheetId: spreadsheetId,
                range: 'Settings!A1:B1',
                valueInputOption: 'RAW',
                resource: { values: [['Setting', 'Value']] }
            });
        } catch (err) {
            console.warn('Could not create Settings sheet:', err);
        }
    }
}

async function loadWarningThresholdSetting() {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Settings!A2:B',
        });

        const rows = resp.result.values || [];
        const row = rows.find((r) => r[0] === 'WARNING_THRESHOLD_PERCENT');

        if (!row) {
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'Settings!A:B',
                valueInputOption: 'RAW',
                resource: { values: [['WARNING_THRESHOLD_PERCENT', DEFAULT_WARNING_THRESHOLD_PERCENT]] }
            });
            WARNING_THRESHOLD_PERCENT = DEFAULT_WARNING_THRESHOLD_PERCENT;
            return;
        }

        const parsed = Number(row[1]);
        WARNING_THRESHOLD_PERCENT = (Number.isFinite(parsed) && parsed >= 0)
            ? parsed
            : DEFAULT_WARNING_THRESHOLD_PERCENT;
    } catch (e) {
        console.warn('Could not load WARNING_THRESHOLD_PERCENT setting:', e);
        WARNING_THRESHOLD_PERCENT = DEFAULT_WARNING_THRESHOLD_PERCENT;
    } finally {
        renderWarningThresholdSettings();
    }
}

function renderWarningThresholdSettings() {
    const modal = document.getElementById('settingsModal');
    const input = document.getElementById('warningThresholdInput');
    const status = document.getElementById('warningThresholdStatus');
    const saveBtn = document.getElementById('saveWarningThresholdBtn');
    const toggleBtn = document.getElementById('settingsToggleBtn');
    const value = Math.max(0, Math.floor(WARNING_THRESHOLD_PERCENT || 0));
    const canShow = isAuthenticated && settingsPanelOpen;

    if (modal) {
        modal.classList.toggle('hidden', !canShow);
        modal.setAttribute('aria-hidden', canShow ? 'false' : 'true');
    }

    if (input) {
        input.value = String(value);
        input.disabled = !isAuthenticated;
    }
    if (status) {
        status.textContent = `Current: ${value}%`;
    }
    if (saveBtn) {
        saveBtn.disabled = !isAuthenticated;
    }
    if (toggleBtn) {
        toggleBtn.setAttribute('aria-expanded', canShow ? 'true' : 'false');
    }
}

function toggleWarningThresholdPanel() {
    if (!isAuthenticated) return;
    settingsPanelOpen = !settingsPanelOpen;
    renderWarningThresholdSettings();
    pinSettingsControlsTopRight();
}

function closeWarningThresholdPanel() {
    if (!settingsPanelOpen) return;
    settingsPanelOpen = false;
    renderWarningThresholdSettings();
}

function pinSettingsControlsTopRight() {
    const safeRight = 'max(0px, env(safe-area-inset-right))';

    const headerRow = document.querySelector('.home-header-row');
    if (headerRow) {
        headerRow.style.setProperty('position', 'relative', 'important');
        headerRow.style.setProperty('padding-right', `calc(3.35rem + ${safeRight})`, 'important');
    }

    const cog = document.getElementById('settingsToggleBtn');
    if (cog) {
        cog.style.setProperty('position', 'absolute', 'important');
        cog.style.setProperty('top', '0', 'important');
        cog.style.setProperty('right', safeRight, 'important');
        cog.style.setProperty('left', 'auto', 'important');
        cog.style.setProperty('margin', '0', 'important');
        cog.style.setProperty('width', '1.9em', 'important');
        cog.style.setProperty('height', '1.9em', 'important');
        cog.style.setProperty('font-size', '1.45rem', 'important');
        cog.style.setProperty('z-index', '10', 'important');
    }

    const modalHeader = document.querySelector('.settings-modal-header');
    if (modalHeader) {
        modalHeader.style.setProperty('position', 'relative', 'important');
        modalHeader.style.setProperty('padding-right', `calc(3rem + ${safeRight})`, 'important');
        modalHeader.style.setProperty('min-height', '2.9rem', 'important');
    }

    const closeBtn = document.getElementById('settingsCloseBtn');
    if (closeBtn) {
        closeBtn.style.setProperty('position', 'absolute', 'important');
        closeBtn.style.setProperty('top', '0', 'important');
        closeBtn.style.setProperty('right', safeRight, 'important');
        closeBtn.style.setProperty('left', 'auto', 'important');
        closeBtn.style.setProperty('margin', '0', 'important');
        closeBtn.style.setProperty('width', '2.6rem', 'important');
        closeBtn.style.setProperty('height', '2.6rem', 'important');
        closeBtn.style.setProperty('font-size', '1.25rem', 'important');
        closeBtn.style.setProperty('z-index', '10', 'important');
    }
}

function getKnownActivityName(activityId, fallback = 'Activity') {
    if (!activityId) return fallback;
    const match = (_allActivitiesCache || []).find((a) => a.id === activityId);
    return match?.name || fallback;
}

async function saveWarningThresholdSetting(newPercent) {
    const safePercent = Math.max(0, Math.floor(newPercent));
    const resp = await gapi.client.sheets.spreadsheets.values.get({
        spreadsheetId: spreadsheetId,
        range: 'Settings!A2:B',
    });

    const rows = resp.result.values || [];
    const existingIndex = rows.findIndex((row) => row[0] === 'WARNING_THRESHOLD_PERCENT');

    if (existingIndex >= 0) {
        const rowNumber = existingIndex + 2;
        await gapi.client.sheets.spreadsheets.values.update({
            spreadsheetId: spreadsheetId,
            range: `Settings!B${rowNumber}`,
            valueInputOption: 'RAW',
            resource: { values: [[safePercent]] }
        });
    } else {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: 'Settings!A:B',
            valueInputOption: 'RAW',
            resource: { values: [['WARNING_THRESHOLD_PERCENT', safePercent]] }
        });
    }
}

async function saveWarningThresholdSettingFromUi() {
    if (!isAuthenticated || !spreadsheetId) {
        showError('Please connect Google first before saving settings.');
        return;
    }

    const input = document.getElementById('warningThresholdInput');
    const saveBtn = document.getElementById('saveWarningThresholdBtn');
    if (!input || !saveBtn) return;

    const parsed = Number(input.value);
    if (!Number.isFinite(parsed) || parsed < 0 || parsed > 50) {
        showError('Warning threshold must be a number between 0 and 50.');
        return;
    }

    const previousLabel = saveBtn.textContent;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';

    try {
        const safePercent = Math.max(0, Math.floor(parsed));
        await saveWarningThresholdSetting(safePercent);
        WARNING_THRESHOLD_PERCENT = safePercent;
        renderWarningThresholdSettings();

        if (document.getElementById('homePage')?.classList.contains('active')) {
            await loadActivities();
        }

        if (currentActivity && document.getElementById('activityDetailPage')?.classList.contains('active')) {
            await loadActivityDetail(currentActivity.id);
        }
    } catch (error) {
        console.error('Could not save WARNING_THRESHOLD_PERCENT:', error);
        showError('Failed to save warning threshold setting. Please try again.');
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = previousLabel;
    }
}

// Write a running timer to the Timers sheet
async function saveTimerToSheet(activityId, activityName, startTime) {
    try {
        // Ensure only one active timer row per activity.
        await removeTimerFromSheet(activityId);
        // Timers store only activity ID + start time; names come from Activities.
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A:B',
            valueInputOption: 'RAW',
            resource: { values: [[activityId, new Date(startTime).toISOString()]] }
        });
    } catch (e) {
        console.warn('Could not save timer to sheet:', e);
    }
}

// Delete a running timer row from the Timers sheet
async function removeTimerFromSheet(activityId) {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A:C',
        });
        const rows = resp.result.values || [];
        // rows[0] is header; collect ALL matching row indices to avoid stale duplicates.
        const matchingRowIndexes = [];
        rows.forEach((r, i) => {
            if (i > 0 && r[0] === activityId) {
                matchingRowIndexes.push(i);
            }
        });
        if (matchingRowIndexes.length === 0) return;

        const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const timersSheet = meta.result.sheets.find(s => s.properties.title === 'Timers');
        if (!timersSheet) return;

        // Delete from bottom to top so indices stay valid.
        matchingRowIndexes.sort((a, b) => b - a);
        const requests = matchingRowIndexes.map((rowIdx) => ({
            deleteDimension: {
                range: {
                    sheetId: timersSheet.properties.sheetId,
                    dimension: 'ROWS',
                    startIndex: rowIdx,
                    endIndex: rowIdx + 1
                }
            }
        }));

        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheetId,
            resource: { requests }
        });
    } catch (e) {
        console.warn('Could not remove timer from sheet:', e);
    }
}

// Load running timers from the Timers sheet (cross-device sync)
async function loadTimersFromSheet() {
    try {
        if (Date.now() < readQuotaBackoffUntil) return;
        const resp = await runWithApiRetries(async () => gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A2:C',
        }), 'loadTimersFromSheet', 1, 500);
        const rows = resp.result.values || [];
        // Rebuild runningTimers from sheet data
        Object.keys(runningTimers).forEach(k => delete runningTimers[k]);

        const latestByActivity = {};
        rows.forEach(row => {
            if (row[0]) {
                const activityId = row[0];
                // Backward-compatible parse:
                // New rows: [activityId, startTime]
                // Legacy rows: [activityId, activityName, startTime]
                const maybeName = row[2] ? (row[1] || '') : '';
                const startRaw = row[2] ? row[2] : row[1];
                const parsed = new Date(startRaw).getTime();
                const startTime = Number.isFinite(parsed) ? parsed : 0;
                const activityName = getKnownActivityName(activityId, maybeName || 'Activity');

                const existing = latestByActivity[activityId];
                if (!existing || startTime > existing.startTime) {
                    latestByActivity[activityId] = { startTime, activityName };
                }
            }
        });

        Object.entries(latestByActivity).forEach(([activityId, timer]) => {
            if (!Number.isFinite(timer.startTime) || timer.startTime <= 0) return;
            runningTimers[activityId] = {
                startTime: timer.startTime,
                activityName: timer.activityName
            };
        });

        localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
        readQuotaWarningShown = false;
    } catch (e) {
        if (isReadQuotaExceededError(e)) {
            handleReadQuotaExceeded('loadTimersFromSheet', e);
            return;
        }
        console.warn('Could not load timers from sheet:', e);
    }
}

async function refreshHomeTimersFromSheet() {
    if (!isAuthenticated || !spreadsheetId || homeTimersSyncInFlight) return;
    if (Date.now() < readQuotaBackoffUntil) return;
    const homePage = document.getElementById('homePage');
    if (!homePage || !homePage.classList.contains('active')) return;

    homeTimersSyncInFlight = true;
    try {
        const beforeFingerprint = getRunningTimersFingerprint();
        await loadTimersFromSheet();
        await syncRunningTimersToNativeNotifications(true);
        const afterFingerprint = getRunningTimersFingerprint();
        const now = Date.now();
        const shouldRefreshActivities =
            beforeFingerprint !== afterFingerprint ||
            (now - lastHomeActivitiesRefreshAt) >= HOME_ACTIVITIES_REFRESH_MS;

        if (shouldRefreshActivities) {
            await loadActivities();
            lastHomeActivitiesRefreshAt = now;
        }
    } finally {
        homeTimersSyncInFlight = false;
    }
}

// Find the maximum most-recent time percentage where recent avg < initial avg.
// Scans session boundaries and returns the split with the largest "recent" portion
// that still has a lower average than the initial portion.
// Returns { initialAvg, recentAvg, initialMins, recentMins, initialPercent, recentPercent }
// or null if no decline is found.
function findOptimalSplit(sessions) {
    if (sessions.length < 2) return null;

    const totalMinutes = sessions.reduce((sum, s) => sum + parseFloat(s[3]), 0);
    if (totalMinutes === 0) return null;

    const totalScore = sessions.reduce((sum, s) => sum + parseFloat(s[3]) * parseFloat(s[4]), 0);

    let bestResult = null;

    // Accumulate the "initial" bucket left-to-right, checking each boundary.
    // sessions 0..splitAfter = initial, sessions splitAfter+1..end = recent.
    let initialMins = 0, initialScore = 0;
    for (let splitAfter = 0; splitAfter < sessions.length - 1; splitAfter++) {
        const d = parseFloat(sessions[splitAfter][3]);
        const r = parseFloat(sessions[splitAfter][4]);
        initialMins += d;
        initialScore += d * r;

        const recentMins = totalMinutes - initialMins;
        const recentScore = totalScore - initialScore;

        if (initialMins > 0 && recentMins > 0) {
            const initialAvg = initialScore / initialMins;
            const recentAvg = recentScore / recentMins;

            if (recentAvg < initialAvg) {
                const recentPercent = (recentMins / totalMinutes) * 100;
                if (recentPercent <= 50 && (!bestResult || recentPercent > bestResult.recentPercent)) {
                    bestResult = {
                        initialAvg,
                        recentAvg,
                        initialMins,
                        recentMins,
                        recentPercent,
                        initialPercent: 100 - recentPercent
                    };
                }
            }
        }
    }

    return bestResult;
}

// Load Activities
async function loadActivities() {
    const loadingIndicator = document.getElementById('loadingIndicator');
    const activitiesList = document.getElementById('activitiesList');
    
    try {
        if (Date.now() < readQuotaBackoffUntil) {
            return;
        }
        loadingIndicator.classList.remove('hidden');
        
        // Fetch activities
        const activitiesResponse = await runWithApiRetries(async () => gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Activities!A2:B',
        }), 'loadActivities.activities', 1, 500);
        
        // Fetch sessions
        const sessionsResponse = await runWithApiRetries(async () => gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Sessions!A2:E',
        }), 'loadActivities.sessions', 1, 500);
        
        const activities = activitiesResponse.result.values || [];
        const sessions = sessionsResponse.result.values || [];
        
        loadingIndicator.classList.add('hidden');
        readQuotaWarningShown = false;
        
        if (activities.length === 0) {
            activitiesList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-icon">📊</div>
                    <div class="empty-state-text">No activities yet.<br>Click "Add New Activity" to get started!</div>
                </div>
            `;
            return;
        }
        
        // Calculate metrics for each activity
        const activityMetrics = activities.map(activity => {
            const activityId = activity[0];
            const activityName = activity[1];
            const activitySessions = sessions.filter(s => s[1] === activityId);
            
            let avgScore = 0;
            let lastScore = 0;
            let splitResult = null;

            if (activitySessions.length > 0) {
                splitResult = findOptimalSplit(activitySessions);
                if (splitResult) {
                    avgScore = splitResult.initialAvg;
                    lastScore = splitResult.recentAvg;
                } else {
                    // No decline — compute overall average
                    const totalMins = activitySessions.reduce((sum, s) => sum + parseFloat(s[3]), 0);
                    const totalSc = activitySessions.reduce((sum, s) => sum + parseFloat(s[3]) * parseFloat(s[4]), 0);
                    avgScore = totalMins > 0 ? totalSc / totalMins : 0;
                }
            }

            return {
                id: activityId,
                name: activityName,
                avgRewardPerHour: parseFloat(avgScore.toFixed(2)),
                lastRewardPerHour: parseFloat(lastScore.toFixed(2)),
                sessionCount: activitySessions.length,
                totalMinutes: activitySessions.reduce((sum, s) => sum + parseFloat(s[3] || 0), 0),
                splitResult
            };
        });
        
        // Cache for quick-rate modal and native sync
        _allActivitiesCache = activityMetrics.map(a => ({ id: a.id, name: a.name }));
        syncActivitiesToNative(_allActivitiesCache);

        // Sort: running timers first, then alphabetically by name
        activityMetrics.sort((a, b) => {
            const aRunning = !!runningTimers[a.id];
            const bRunning = !!runningTimers[b.id];
            const aPaused = !!pausedTimers[a.id];
            const bPaused = !!pausedTimers[b.id];
            if (aRunning !== bRunning) return aRunning ? -1 : 1;
            if (aPaused !== bPaused) return aPaused ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        // Render activities
        activitiesList.innerHTML = activityMetrics.map(activity => {
            const hasRunningTimer = runningTimers[activity.id];
            const hasPausedTimer = pausedTimers[activity.id];
            // Only flag below-average if a declining split covers >= WARNING_THRESHOLD_PERCENT of total time
            const isBelowAverage = !hasRunningTimer && activity.sessionCount > 0 && activity.splitResult !== null
                && activity.splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT;
            // Red number matches detail screen: no timer restriction
            const isRecentRed = activity.sessionCount > 0 && activity.splitResult !== null
                && activity.splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT;
            const initialLabel = activity.splitResult
                ? `Initial ${Math.round(activity.splitResult.initialPercent)}% Average Rating`
                : 'Average Rating';
            const recentLabel = activity.splitResult
                ? `Most Recent ${Math.round(activity.splitResult.recentPercent)}% Average Rating`
                : 'Most Recent Rating';
            let timerDisplay = '';
            
            if (hasPausedTimer && hasRunningTimer) {
                timerDisplay = `<span class="timer-badge">⏸ ${formatElapsedHms(hasPausedTimer.elapsedSeconds)} (stopped)</span>`;
            } else if (hasRunningTimer) {
                const elapsed = Math.floor((Date.now() - hasRunningTimer.startTime) / 1000);
                timerDisplay = `<span class="timer-badge">⏱ ${formatElapsedHms(elapsed)}</span>`;
            } else if (hasPausedTimer) {
                timerDisplay = `<span class="timer-badge">⏸ ${formatElapsedHms(hasPausedTimer.elapsedSeconds)} (stopped)</span>`;
            }
            
            // Timer control button
            const escapedName = activity.name.replace(/'/g, "\\'");
            const timerButton = (hasPausedTimer && hasRunningTimer)
                ? `<button class="timer-control-btn start" onclick="event.stopPropagation(); startTimerFromCard('${activity.id}', '${escapedName}')">▶ Resume</button>`
                : hasRunningTimer
                ? `<button class="timer-control-btn stop" onclick="event.stopPropagation(); stopTimerFromCard('${activity.id}', '${escapedName}')">⏹ Stop</button>`
                : hasPausedTimer
                    ? `<button class="timer-control-btn start" onclick="event.stopPropagation(); startTimerFromCard('${activity.id}', '${escapedName}')">▶ Resume</button>`
                    : `<button class="timer-control-btn start" onclick="event.stopPropagation(); startTimerFromCard('${activity.id}', '${escapedName}')">▶ Start</button>`;
            
            return `
                <div class="activity-card ${hasRunningTimer ? 'timer-running' : ''} ${isBelowAverage ? 'below-average-card' : ''}" data-activity-id="${activity.id}" onclick="openActivity('${activity.id}', '${activity.name.replace(/'/g, "\\'")}')">
                    <div class="activity-header">
                        <h3>${activity.name}${timerDisplay}</h3>
                        ${timerButton}
                    </div>
                    <div class="activity-metrics">
                        <div class="metric">
                            <div class="metric-label">${initialLabel}</div>
                            <div class="metric-value">${activity.sessionCount > 0 ? activity.avgRewardPerHour.toFixed(2) : '--'}</div>
                        </div>
                        <div class="metric">
                            <div class="metric-label">${recentLabel}</div>
                            <div class="metric-value ${isRecentRed ? 'below-average' : ''}">${activity.splitResult ? activity.lastRewardPerHour.toFixed(2) : (activity.sessionCount > 0 ? '✓' : '--')}</div>
                        </div>
                        <div class="metric">
                            <div class="metric-label">Total Time</div>
                            <div class="metric-value metric-value-time">${formatDurationMinutesDhm(activity.totalMinutes)}</div>
                        </div>
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Error loading activities:', error);
        loadingIndicator.classList.add('hidden');

        if (isReadQuotaExceededError(error)) {
            handleReadQuotaExceeded('loadActivities', error);
            return;
        }
        
        // Check if token expired
        const status = error.status || error.result?.error?.code;
        if (status === 401 || status === 403) {
            handleTokenExpiration();
            return;
        }
        
        let errorMsg = error.result?.error?.message || error.message || 'Unknown error';
        if (errorMsg.includes('has not been used') || errorMsg.includes('not enabled')) {
            errorMsg = 'Google Sheets API is not enabled in your Google Cloud project. You need to enable "Google Sheets API" specifically (not just BigQuery or other APIs).';
        }
        showError('Failed to load activities from Google Sheets: ' + errorMsg);
        activitiesList.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon">❌</div>
                <div class="empty-state-text">Error aies.<br>Check the error message above.</div>
            </div>
        `;
    }
}

// Add Activity
async function addActivity(activityName) {
    // Check if API is ready
    if (!isAuthenticated || !gapi.client.sheets) {
        showError('Google Sheets API is not ready. Please wait for initialization to complete or refresh the page.');
        return false;
    }
    
    if (!spreadsheetId) {
        showError('Spreadsheet not initialized. Please refresh the page and try again.');
        return false;
    }
    
    try {
        // Generate activity ID
        const activityId = 'ACT_' + Date.now();
        
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: 'Activities!A:B',
            valueInputOption: 'RAW',
            resource: {
                values: [[activityId, activityName]]
            }
        });
        
        return activityId;
    } catch (error) {
        console.error('Error adding activity:', error);
        
        // Check if token expired
        const status = error.status || error.result?.error?.code;
        if (status === 401 || status === 403) {
            handleTokenExpiration();
            return false;
        }
        
        showError('Failed to add activity: ' + (error.result?.error?.message || error.message || 'Unknown error'));
        return false;
    }
}

// Open Activity Detail
async function openActivity(activityId, activityName) {
    currentActivity = { id: activityId, name: activityName };
    
    document.getElementById('activityTitle').textContent = activityName;
    showPage('activityDetailPage');
    window.scrollTo(0, 0);
    
    // Clear any existing timer interval first
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // If stopped-for-rating, keep background timer running but pause on-screen counter.
    if (pausedTimers[activityId] && runningTimers[activityId]) {
        timerState.running = false;
        timerState.startTime = runningTimers[activityId].startTime;
        timerState.elapsed = Math.max(0, Math.floor(pausedTimers[activityId].elapsedSeconds || 0));
        document.getElementById('timerDisplay').textContent = formatElapsedHms(timerState.elapsed);
        document.getElementById('startTimerBtn').textContent = '▶ Resume';
        document.getElementById('startTimerBtn').classList.remove('hidden');
        document.getElementById('stopTimerBtn').classList.add('hidden');
    } else if (runningTimers[activityId]) {
        timerState.running = true;
        timerState.startTime = runningTimers[activityId].startTime;
        timerState.elapsed = Math.floor((Date.now() - timerState.startTime) / 1000);
        
        document.getElementById('startTimerBtn').classList.add('hidden');
        document.getElementById('stopTimerBtn').classList.remove('hidden');
        document.getElementById('startTimerBtn').textContent = 'Start Timer';
        
        timerInterval = setInterval(updateTimerDisplay, 100);
    } else if (pausedTimers[activityId]) {
        timerState.running = false;
        timerState.startTime = null;
        timerState.elapsed = Math.max(0, Math.floor(pausedTimers[activityId].elapsedSeconds || 0));
        document.getElementById('timerDisplay').textContent = formatElapsedHms(timerState.elapsed);
        setManualDurationFromSeconds(timerState.elapsed);
        document.getElementById('startTimerBtn').textContent = '▶ Resume';
        document.getElementById('startTimerBtn').classList.remove('hidden');
        document.getElementById('stopTimerBtn').classList.add('hidden');
    } else {
        // Reset timer if no running timer for this activity
        timerState.running = false;
        timerState.startTime = null;
        timerState.elapsed = 0;
        document.getElementById('timerDisplay').textContent = '00:00:00';
        document.getElementById('startTimerBtn').textContent = 'Start Timer';
        document.getElementById('startTimerBtn').classList.remove('hidden');
        document.getElementById('stopTimerBtn').classList.add('hidden');
    }
    
    // Load activity data
    await loadActivityDetail(activityId);
}

async function loadActivityDetail(activityId) {
    try {
        // Fetch sessions for this activity
        const sessionsResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Sessions!A2:E',
        });
        
        const allSessions = sessionsResponse.result.values || [];
        const activitySessions = allSessions.filter(s => s[1] === activityId);
        
        // Calculate metrics using optimal split
        let avgScore = 0;
        let lastScore = 0;
        let splitResult = null;

        if (activitySessions.length > 0) {
            splitResult = findOptimalSplit(activitySessions);
            if (splitResult) {
                avgScore = splitResult.initialAvg;
                lastScore = splitResult.recentAvg;
            } else {
                // No decline — compute overall average
                const totalMins = activitySessions.reduce((sum, s) => sum + parseFloat(s[3]), 0);
                const totalSc = activitySessions.reduce((sum, s) => sum + parseFloat(s[3]) * parseFloat(s[4]), 0);
                avgScore = totalMins > 0 ? totalSc / totalMins : 0;
            }
        }

        // Format minutes helper
        const formatMinutes = (mins) => formatDurationMinutesDhm(mins);

            // Update stat labels dynamically
        const avgScoreLabel = document.getElementById('avgScoreLabel');
        const lastScoreLabel = document.getElementById('lastScoreLabel');
        if (splitResult) {
            const ip = Math.round(splitResult.initialPercent);
            const rp = Math.round(splitResult.recentPercent);
            if (avgScoreLabel) avgScoreLabel.textContent = `Initial ${ip}% Average Rating`;
            if (lastScoreLabel) lastScoreLabel.textContent = `Most Recent ${rp}% Average Rating`;
        } else {
            if (avgScoreLabel) avgScoreLabel.textContent = 'Average Rating';
            if (lastScoreLabel) lastScoreLabel.textContent = 'Trend';
        }

        // Update UI values
        document.getElementById('avgRewardTime').textContent = activitySessions.length > 0 ? avgScore.toFixed(2) : '--';
        const lastRewardTimeEl = document.getElementById('lastRewardTime');
        lastRewardTimeEl.textContent = activitySessions.length > 0 && splitResult ? lastScore.toFixed(2) : (activitySessions.length > 0 ? '✓' : '--');
        const showWarning = splitResult && splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT;
        lastRewardTimeEl.style.color = showWarning ? 'var(--danger-color, #e53e3e)' : '';

        // Show score notes
        const avgScoreNote = document.getElementById('avgScoreNote');
        const lastScoreNote = document.getElementById('lastScoreNote');

        if (activitySessions.length > 0 && splitResult) {
            avgScoreNote.textContent = `Average rating over initial ${Math.round(splitResult.initialPercent)}% (${formatMinutes(splitResult.initialMins)}) of time`;
            avgScoreNote.classList.remove('hidden');
            lastScoreNote.textContent = `Average rating over most recent ${Math.round(splitResult.recentPercent)}% (${formatMinutes(splitResult.recentMins)}) of time`;
            lastScoreNote.classList.remove('hidden');
        } else if (activitySessions.length > 0) {
            const totalMins = activitySessions.reduce((sum, s) => sum + parseFloat(s[3]), 0);
            avgScoreNote.textContent = `Average rating over all time (${formatMinutes(totalMins)})`;
            avgScoreNote.classList.remove('hidden');
            lastScoreNote.textContent = 'No recent decline in rating detected';
            lastScoreNote.classList.remove('hidden');
        } else {
            avgScoreNote.classList.add('hidden');
            lastScoreNote.classList.add('hidden');
        }

        // Show warning if needed (but not if timer is running)
        const warningBox = document.getElementById('warningBox');
        const warningText = document.getElementById('warningText');
        const isTimerRunning = runningTimers[activityId];
        if (!isTimerRunning && splitResult && splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT) {
            const ip = Math.round(splitResult.initialPercent);
            const rp = Math.round(splitResult.recentPercent);
            if (warningText) {
                const pctBelow = Math.round((avgScore - lastScore) / avgScore * 100);
                warningText.innerHTML = `<strong>Warning!</strong><br>Your most recent ${rp}% of time (${formatMinutes(splitResult.recentMins)}) average rating ${lastScore.toFixed(2)} is ${pctBelow}% below your initial ${ip}% time (${formatMinutes(splitResult.initialMins)}) average rating ${avgScore.toFixed(2)}.<br/><br/>Consider quitting.`;
            }
            if (warningBox) warningBox.classList.remove('hidden');
        } else {
            if (warningBox) warningBox.classList.add('hidden');
        }
        
        // Load sessions list
        const sessionsList = document.getElementById('sessionsList');
        if (activitySessions.length === 0) {
            sessionsList.innerHTML = `
                <div class="empty-state">
                    <div class="empty-state-text">No sessions recorded yet.</div>
                </div>
            `;
        } else {
            const rows = activitySessions.slice(-10).reverse();
            sessionsList.innerHTML = rows.map((session) => {
                const duration = parseFloat(session[3]);
                const rating = parseFloat(session[4]);
                const score = duration * rating;
                const durationText = formatDurationMinutesDhm(duration);
                const dateRaw = session[2] ? new Date(session[2]) : null;
                const dateText = dateRaw && !isNaN(dateRaw)
                    ? `${dateRaw.getFullYear()}-${String(dateRaw.getMonth()+1).padStart(2,'0')}-${String(dateRaw.getDate()).padStart(2,'0')} ${String(dateRaw.getHours()).padStart(2,'0')}:${String(dateRaw.getMinutes()).padStart(2,'0')}`
                    : (session[2] || '');
                
                return `
                    <div class="session-item">
                        <div class="session-info">
                            <div class="session-time">${durationText}</div>
                            <div class="session-date">${dateText}</div>
                        </div>
                        <div class="session-stats">
                            <div class="session-reward">${rating}/10</div>
                            <div class="session-score">
                                Score: ${score.toFixed(1)}
                                <br><span style="font-size: 0.7rem; opacity: 0.7; font-style: italic;">(${duration} min × ${rating}/10)</span>
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
        
    } catch (error) {
        console.error('Error loading activity detail:', error);
        const sessionsList = document.getElementById('sessionsList');
        if (sessionsList) {
            sessionsList.innerHTML = `<div class="empty-state"><div class="empty-state-text">Error loading sessions: ${error.message}</div></div>`;
        }
    }
}

// Timer Functions
let timerState = {
    running: false,
    startTime: null,
    elapsed: 0
};

async function startTimer() {
    if (!currentActivity) {
        showError('No activity selected');
        return;
    }
    
    // Clear any existing interval first
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }

    // Explicit resume path: unfreeze UI while keeping existing background timer.
    if (currentActivity && pausedTimers[currentActivity.id] && runningTimers[currentActivity.id]) {
        delete pausedTimers[currentActivity.id];
        if (pendingRatingActivityId === currentActivity.id) {
            pendingRatingActivityId = null;
        }
        timerState.running = true;
        timerState.startTime = runningTimers[currentActivity.id].startTime;
        timerState.elapsed = Math.floor((Date.now() - timerState.startTime) / 1000);
        document.getElementById('startTimerBtn').textContent = 'Start Timer';
        document.getElementById('startTimerBtn').classList.add('hidden');
        document.getElementById('stopTimerBtn').classList.remove('hidden');
        timerInterval = setInterval(updateTimerDisplay, 100);
        loadActivities();
        return;
    }
    
    const paused = currentActivity ? pausedTimers[currentActivity.id] : null;
    const resumeElapsed = paused ? Math.max(0, Math.floor(paused.elapsedSeconds || 0)) : timerState.elapsed;
    timerState.running = true;
    timerState.startTime = Date.now() - (resumeElapsed * 1000);

    if (currentActivity && pausedTimers[currentActivity.id]) {
        delete pausedTimers[currentActivity.id];
    }
    if (currentActivity && pendingRatingActivityId === currentActivity.id) {
        pendingRatingActivityId = null;
    }
    
    // Save to running timers
    runningTimers[currentActivity.id] = {
        startTime: timerState.startTime,
        activityName: currentActivity.name
    };
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    await saveTimerToSheet(currentActivity.id, currentActivity.name, timerState.startTime);
    await notifyNativeTimerStart(currentActivity.id, currentActivity.name, timerState.startTime);

    document.getElementById('startTimerBtn').classList.add('hidden');
    document.getElementById('stopTimerBtn').classList.remove('hidden');
    
    timerInterval = setInterval(updateTimerDisplay, 100);
}

async function stopTimer() {
    timerState.running = false;
    
    // Clear the interval and set to null
    if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
    }
    
    const totalSeconds = Math.floor((Date.now() - timerState.startTime) / 1000);
    setManualDurationFromSeconds(totalSeconds);

    if (currentActivity) {
        pausedTimers[currentActivity.id] = {
            elapsedSeconds: totalSeconds,
            activityName: currentActivity.name
        };
    }
    
    // Keep timer running in background. Only pause on-screen counting.
    timerState.elapsed = totalSeconds;
    document.getElementById('timerDisplay').textContent = formatElapsedHms(totalSeconds);
    document.getElementById('startTimerBtn').classList.remove('hidden');
    document.getElementById('startTimerBtn').textContent = '▶ Resume';
    document.getElementById('stopTimerBtn').classList.add('hidden');
    
    // Scroll to manual entry
    document.getElementById('manualEntryForm').scrollIntoView({ behavior: 'smooth', block: 'center' });

    // User must save a rating before leaving activity detail.
    if (currentActivity) {
        pendingRatingActivityId = currentActivity.id;
    }

    loadActivities();
}

function updateTimerDisplay() {
    const totalSeconds = Math.floor((Date.now() - timerState.startTime) / 1000);
    timerState.elapsed = totalSeconds;
    
    const display = formatElapsedHms(totalSeconds);
    document.getElementById('timerDisplay').textContent = display;
    
    // Update manual entry fields in real-time
    setManualDurationFromSeconds(totalSeconds);
}

// Save Session
async function saveSession(durationMinutes, rewardRating) {
    try {
        const sessionId = 'SES_' + Date.now();
        const timestamp = new Date().toISOString();

        await runWithApiRetries(async () => {
            await gapi.client.sheets.spreadsheets.values.append({
                spreadsheetId: spreadsheetId,
                range: 'Sessions!A:E',
                valueInputOption: 'RAW',
                resource: {
                    values: [[sessionId, currentActivity.id, timestamp, durationMinutes, rewardRating]]
                }
            });
        }, 'saveSession');
        
        return true;
    } catch (error) {
        console.error('Error saving session:', error);
        
        // Check if token expired
        const statusCode = getApiErrorStatus(error);
        if (statusCode === 401 || statusCode === 403) {
            handleTokenExpiration();
            return false;
        }
        
        const status = statusCode;
        const detail = error.result?.error?.message || error.message || 'Unknown error';
        if ([502, 503, 504].includes(status)) {
            showError(`Failed to save session after retrying (${status}). Please tap Save Rating again. Details: ${detail}`);
        } else {
            showError('Failed to save session: ' + detail);
        }
        return false;
    }
}

// Page Navigation
function showPage(pageId) {
    const activePage = document.querySelector('.page.active');
    const leavingActivityDetail = activePage && activePage.id === 'activityDetailPage' && pageId !== 'activityDetailPage';
    if (leavingActivityDetail && pendingRatingActivityId && currentActivity && pendingRatingActivityId === currentActivity.id) {
        alert('Please click Resume or save your rating before leaving this screen.');
        return;
    }

    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
    
    // Reload activities when returning to home page
    if (pageId === 'homePage' && isAuthenticated) {
        refreshHomeTimersFromSheet();
    }
}

// Event Listeners
document.addEventListener('DOMContentLoaded', () => {
    // Disable buttons until initialized
    disableAppButtons();
    
    // Set current origin for error messages
    const currentOriginEl = document.getElementById('currentOrigin');
    const setupOriginEl = document.getElementById('setupOrigin');
    const currentRefererEl = document.getElementById('currentReferer');
    const setupRefererEl = document.getElementById('setupReferer');
    const currentOrigin = window.location.origin;
    
    if (currentOriginEl) {
        currentOriginEl.textContent = currentOrigin;
    }
    if (setupOriginEl) {
        setupOriginEl.textContent = currentOrigin;
    }
    if (currentRefererEl) {
        currentRefererEl.textContent = currentOrigin + '/*';
    }
    if (setupRefererEl) {
        setupRefererEl.textContent = currentOrigin + '/*';
    }
    
    // Set placeholder for test user email
    const testUserEmailEl = document.getElementById('testUserEmail');
    if (testUserEmailEl) {
        testUserEmailEl.textContent = 'the email you\'re trying to sign in with';
    }
    
    // Redirect-only OAuth path: no popup monitoring required.
    
    // Error Modal Buttons
    document.getElementById('retryConnectionBtn').addEventListener('click', () => {
        if (!isAuthenticated && gapiInited) {
            requestGoogleAuthFromUserGesture();
            return;
        }
        hideError();
        location.reload();
    });

    const warningThresholdInput = document.getElementById('warningThresholdInput');
    const warningThresholdSaveBtn = document.getElementById('saveWarningThresholdBtn');
    const settingsToggleBtn = document.getElementById('settingsToggleBtn');
    const settingsCloseBtn = document.getElementById('settingsCloseBtn');
    const settingsModal = document.getElementById('settingsModal');
    if (warningThresholdSaveBtn) {
        warningThresholdSaveBtn.addEventListener('click', saveWarningThresholdSettingFromUi);
    }
    if (settingsToggleBtn) {
        settingsToggleBtn.addEventListener('click', () => {
            toggleWarningThresholdPanel();
            setTimeout(pinSettingsControlsTopRight, 0);
        });
    }
    if (settingsCloseBtn) {
        settingsCloseBtn.addEventListener('click', closeWarningThresholdPanel);
    }
    if (settingsModal) {
        settingsModal.addEventListener('click', (e) => {
            if (e.target === settingsModal) {
                closeWarningThresholdPanel();
            }
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeWarningThresholdPanel();
        }
    });
    if (warningThresholdInput) {
        warningThresholdInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                saveWarningThresholdSettingFromUi();
            }
        });
    }
    renderWarningThresholdSettings();
    pinSettingsControlsTopRight();
    setTimeout(pinSettingsControlsTopRight, 0);
    setTimeout(pinSettingsControlsTopRight, 250);
    window.addEventListener('resize', pinSettingsControlsTopRight);
    
    // Add Activity Inline
    document.getElementById('addActivityBtn').addEventListener('click', () => {
        document.getElementById('addActivityBtn').classList.add('hidden');
        document.getElementById('addActivityInline').classList.remove('hidden');
        document.getElementById('activityNameInline').focus();
    });
    
    document.getElementById('cancelActivityBtn').addEventListener('click', () => {
        document.getElementById('addActivityBtn').classList.remove('hidden');
        document.getElementById('addActivityInline').classList.add('hidden');
        document.getElementById('activityNameInline').value = '';
    });
    
    const saveActivityInline = async () => {
        // Check if authenticated
        if (!isAuthenticated) {
            showError('Please wait for authentication to complete.');
            return;
        }
        
        const activityName = document.getElementById('activityNameInline').value.trim();
        
        if (activityName) {
            const addedActivityId = await addActivity(activityName);
            if (addedActivityId) {
                document.getElementById('activityNameInline').value = '';
                document.getElementById('addActivityBtn').classList.remove('hidden');
                document.getElementById('addActivityInline').classList.add('hidden');
                await loadActivities();
                scrollActivityCardToCenter(addedActivityId);
            }
        }
    };
    
    document.getElementById('saveActivityBtn').addEventListener('click', saveActivityInline);
    
    document.getElementById('activityNameInline').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            saveActivityInline();
        }
    });
    
    document.getElementById('activityNameInline').addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            document.getElementById('cancelActivityBtn').click();
        }
    });
    
    // Timer Controls
    document.getElementById('startTimerBtn').addEventListener('click', startTimer);
    document.getElementById('stopTimerBtn').addEventListener('click', stopTimer);
    
    // Rating Slider
    document.getElementById('rewardRating').addEventListener('input', (e) => {
        document.getElementById('ratingDisplay').textContent = e.target.value;
    });
    
    // Manual Entry Form
    document.getElementById('manualEntryForm').addEventListener('submit', async (e) => {
        e.preventDefault();

        if (saveRatingInFlight) return;
        saveRatingInFlight = true;

        const saveBtn = document.querySelector('#manualEntryForm button[type="submit"]');
        const previousLabel = saveBtn ? saveBtn.textContent : '';
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.textContent = 'Saving...';
        }

        try {
            const days = parseNonNegativeInt(document.getElementById('manualDays').value);
            const hours = parseNonNegativeInt(document.getElementById('manualHours').value);
            const minutes = parseInt(document.getElementById('manualMinutes').value) || 0;
            const reward = parseInt(document.getElementById('rewardRating').value);

            const totalMinutes = (days * 24 * 60) + (hours * 60) + parseNonNegativeInt(minutes);

            if (totalMinutes === 0) {
                alert('Please enter a duration greater than 0.');
                return;
            }

            const success = await saveSession(totalMinutes, reward);
            if (success) {
                if (currentActivity) {
                    delete pausedTimers[currentActivity.id];
                    if (pendingRatingActivityId === currentActivity.id) {
                        pendingRatingActivityId = null;
                    }
                }

                // Stop the timer only after session save succeeds.
                if (currentActivity && runningTimers[currentActivity.id]) {
                    delete runningTimers[currentActivity.id];
                    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
                    await removeTimerFromSheet(currentActivity.id);
                    await notifyNativeTimerStop(currentActivity.id);
                }

                // Ensure detail page controls reflect stopped state.
                document.getElementById('stopTimerBtn').classList.add('hidden');
                document.getElementById('startTimerBtn').classList.remove('hidden');
                if (timerInterval) {
                    clearInterval(timerInterval);
                    timerInterval = null;
                }
                timerState.running = false;
                timerState.startTime = null;
                timerState.elapsed = 0;
                document.getElementById('timerDisplay').textContent = '00:00:00';
                document.getElementById('startTimerBtn').textContent = 'Start Timer';

                // Reset form
                document.getElementById('manualDays').value = 0;
                document.getElementById('manualHours').value = 0;
                document.getElementById('manualMinutes').value = 0;
                document.getElementById('rewardRating').value = 5;
                document.getElementById('ratingDisplay').textContent = 5;
                updateSaveRatingButtonState();

                // Reload activity detail
                await loadActivityDetail(currentActivity.id);

            } else {
                alert('Error saving session. Please try again.');
            }
        } finally {
            saveRatingInFlight = false;
            if (saveBtn) {
                saveBtn.textContent = previousLabel;
            }
            updateSaveRatingButtonState();
        }
    });

    ['manualDays', 'manualHours', 'manualMinutes'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.addEventListener('input', updateSaveRatingButtonState);
        el.addEventListener('change', updateSaveRatingButtonState);
    });
    enforceCompactDurationInputs();
    window.addEventListener('resize', enforceCompactDurationInputs);
    updateSaveRatingButtonState();
    
    // Check if Google API loaded after a timeout
    setTimeout(() => {
        if (typeof gapi === 'undefined') {
            showError('Google API library failed to load. Check your internet connection and make sure you\'re serving the app over HTTP/HTTPS (not opening file:// directly).');
        }
    }, 10000); // Wait 10 seconds for scripts to load
    
    // Refresh timer displays on home page every second
    setInterval(() => {
        if (document.getElementById('homePage').classList.contains('active')) {
            updateRunningTimerDisplays();
        }
    }, 1000);

    // Pull running timer state from sheet periodically for cross-device live sync.
    setInterval(() => {
        refreshHomeTimersFromSheet();
    }, HOME_TIMER_SYNC_INTERVAL_MS);
});

// Update running timer displays on main screen
function updateRunningTimerDisplays() {
    Object.keys(runningTimers).forEach(activityId => {
        const timerBadge = document.querySelector(`[onclick*="${activityId}"] .timer-badge`);
        if (timerBadge) {
            if (pausedTimers[activityId]) {
                const frozen = Math.max(0, Math.floor(pausedTimers[activityId].elapsedSeconds || 0));
                timerBadge.textContent = `⏸ ${formatElapsedHms(frozen)} (stopped)`;
            } else {
                const elapsed = Math.floor((Date.now() - runningTimers[activityId].startTime) / 1000);
                timerBadge.textContent = `⏱ ${formatElapsedHms(elapsed)}`;
            }
        }
    });
}

function scrollActivityCardToCenter(activityId) {
    const cards = document.querySelectorAll('.activity-card');
    const targetCard = Array.from(cards).find(card => card.dataset.activityId === activityId);
    if (!targetCard) return;
    targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function renderCardRunningState(activityId, activityName, startTime) {
    const cards = document.querySelectorAll('.activity-card');
    const card = Array.from(cards).find(c => c.dataset.activityId === activityId);
    if (!card) return;

    card.classList.add('timer-running');

    const badge = card.querySelector('.timer-badge');
    const elapsed = Math.floor((Date.now() - startTime) / 1000);
    const badgeHtml = `⏱ ${formatElapsedHms(elapsed)}`;
    if (badge) {
        badge.textContent = badgeHtml;
    } else {
        const title = card.querySelector('h3');
        if (title) {
            title.insertAdjacentHTML('beforeend', ` <span class="timer-badge">${badgeHtml}</span>`);
        }
    }

    const escapedName = activityName.replace(/'/g, "\\'");
    const controlBtn = card.querySelector('.timer-control-btn');
    if (controlBtn) {
        controlBtn.className = 'timer-control-btn stop';
        controlBtn.setAttribute('onclick', `event.stopPropagation(); stopTimerFromCard('${activityId}', '${escapedName}')`);
        controlBtn.textContent = '⏹ Stop';
    }
}

// Start timer from activity card on main screen
async function startTimerFromCard(activityId, activityName) {
    if (pausedTimers[activityId] && runningTimers[activityId]) {
        delete pausedTimers[activityId];
        if (pendingRatingActivityId === activityId) {
            pendingRatingActivityId = null;
        }
        renderCardRunningState(activityId, activityName, runningTimers[activityId].startTime);
        scrollActivityCardToCenter(activityId);
        loadActivities().then(() => scrollActivityCardToCenter(activityId)).catch(() => {});
        return;
    }

    const paused = pausedTimers[activityId];
    const resumeElapsed = paused ? Math.max(0, Math.floor(paused.elapsedSeconds || 0)) : 0;
    const startTime = Date.now() - (resumeElapsed * 1000);

    if (pausedTimers[activityId]) {
        delete pausedTimers[activityId];
    }
    if (pendingRatingActivityId === activityId) {
        pendingRatingActivityId = null;
    }

    runningTimers[activityId] = {
        startTime: startTime,
        activityName: activityName
    };
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    renderCardRunningState(activityId, activityName, startTime);
    scrollActivityCardToCenter(activityId);

    // Persist and sync without blocking immediate UI response.
    saveTimerToSheet(activityId, activityName, startTime).catch(() => {});
    notifyNativeTimerStart(activityId, activityName, startTime).catch(() => {});

    // Refresh activities list to show timer
    loadActivities().then(() => scrollActivityCardToCenter(activityId)).catch(() => {});
}

// Stop timer from activity card on main screen
async function stopTimerFromCard(activityId, activityName) {
    // Calculate elapsed time before removing from running timers
    const timerData = runningTimers[activityId];
    if (!timerData) {
        return; // Timer not running
    }
    
    const totalSeconds = Math.floor((Date.now() - timerData.startTime) / 1000);

    // Keep timer running in background. Only pause UI until save or resume.
    pausedTimers[activityId] = {
        elapsedSeconds: totalSeconds,
        activityName
    };
    pendingRatingActivityId = activityId;
    
    // Refresh activities list
    loadActivities();

    // Open activity detail so user can resume or save rating.
    openActivity(activityId, activityName);

    // Pre-fill rating form duration from paused elapsed time.
    setTimeout(() => {
        setManualDurationFromSeconds(totalSeconds);
        document.getElementById('manualEntryForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 100);
}

// Delete Activity
async function deleteActivity() {
    if (!currentActivity) {
        showError('No activity selected.');
        return;
    }
    
    const confirmDelete = confirm(`Are you sure you want to delete "${currentActivity.name}"?\n\nThis will remove the activity and all its sessions. This action cannot be undone.`);
    
    if (!confirmDelete) {
        return;
    }
    
    try {
        // First, get spreadsheet metadata to find sheet IDs
        const spreadsheetMeta = await gapi.client.sheets.spreadsheets.get({
            spreadsheetId: spreadsheetId
        });
        
        const sheets = spreadsheetMeta.result.sheets;
        const activitiesSheet = sheets.find(s => s.properties.title === 'Activities');
        const sessionsSheet = sheets.find(s => s.properties.title === 'Sessions');
        
        if (!activitiesSheet || !sessionsSheet) {
            showError('Could not find required sheets.');
            return;
        }
        
        const activitiesSheetId = activitiesSheet.properties.sheetId;
        const sessionsSheetId = sessionsSheet.properties.sheetId;
        
        // Fetch all activities and sessions
        const activitiesResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Activities!A2:B',
        });
        
        const sessionsResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Sessions!A2:E',
        });
        
        const activities = activitiesResponse.result.values || [];
        const sessions = sessionsResponse.result.values || [];
        
        // Find the row index of the activity to delete (add 2 for header and 0-indexing)
        const activityRowIndex = activities.findIndex(a => a[0] === currentActivity.id);
        
        if (activityRowIndex === -1) {
            showError('Activity not found.');
            return;
        }
        
        // Delete the activity row
        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheetId,
            resource: {
                requests: [{
                    deleteDimension: {
                        range: {
                            sheetId: activitiesSheetId,
                            dimension: 'ROWS',
                            startIndex: activityRowIndex + 1, // +1 for header
                            endIndex: activityRowIndex + 2
                        }
                    }
                }]
            }
        });
        
        // Delete all sessions for this activity
        const sessionRowsToDelete = [];
        sessions.forEach((session, index) => {
            if (session[1] === currentActivity.id) {
                sessionRowsToDelete.push(index + 1); // +1 for header row
            }
        });
        
        // Delete session rows in reverse order to maintain correct indices
        if (sessionRowsToDelete.length > 0) {
            const deleteRequests = sessionRowsToDelete.reverse().map(rowIndex => ({
                deleteDimension: {
                    range: {
                        sheetId: sessionsSheetId,
                        dimension: 'ROWS',
                        startIndex: rowIndex,
                        endIndex: rowIndex + 1
                    }
                }
            }));
            
            await gapi.client.sheets.spreadsheets.batchUpdate({
                spreadsheetId: spreadsheetId,
                resource: {
                    requests: deleteRequests
                }
            });
        }
        
        alert(`Successfully deleted "${currentActivity.name}" and ${sessionRowsToDelete.length} session(s).`);
        showPage('homePage');
        
    } catch (error) {
        console.error('Error deleting activity:', error);
        
        // Check if token expired
        const status = error.status || error.result?.error?.code;
        if (status === 401 || status === 403) {
            handleTokenExpiration();
            return;
        }
        
        showError('Failed to delete activity: ' + (error.result?.error?.message || error.message || 'Unknown error'));
    }
}

// Update spreadsheet link
function updateSpreadsheetLink() {
    if (spreadsheetId) {
        const footer = document.getElementById('appFooter');
        const link = document.getElementById('spreadsheetLink');
        
        if (footer && link) {
            link.href = `https://docs.google.com/spreadsheets/d/${spreadsheetId}`;
            footer.classList.remove('hidden');
        }
    }
}

// ─── Quick-Rate modal (opened when app launched from "Stop & Rate" notification) ─
function showQuickRateModal(activityId, activityName, startTimeMs) {
    _quickRateActivity = { id: activityId, name: activityName };
    const elapsedMs = Date.now() - startTimeMs;
    _quickRateDurationMins = Math.max(1, Math.round(elapsedMs / 60000));
    const durationText = formatDurationMinutesDhm(_quickRateDurationMins);

    document.getElementById('quickRateActivityName').textContent = activityName;
    document.getElementById('quickRateDuration').textContent = `Duration: ${durationText}`;
    const slider = document.getElementById('quickRateSlider');
    slider.value = 5;
    document.getElementById('quickRateValue').textContent = '5';

    // Populate next-activity list (exclude the one being stopped)
    const listEl = document.getElementById('quickRateActivityList');
    listEl.innerHTML = _allActivitiesCache
        .filter(a => a.id !== activityId)
        .map(a => `<button class="btn btn-secondary" style="width:100%" onclick="quickRateStartNext('${a.id}','${a.name.replace(/'/g, "\\'")}')">${a.name}</button>`)
        .join('');

    document.getElementById('quickRateModal').classList.remove('hidden');
    window.scrollTo(0, 0);
}

async function _quickRateSave() {
    const rating = parseInt(document.getElementById('quickRateSlider').value);
    document.getElementById('quickRateModal').classList.add('hidden');
    const prev = currentActivity;
    currentActivity = _quickRateActivity;
    await saveSession(_quickRateDurationMins, rating);
    currentActivity = prev;
}

async function quickRateSaveOnly() {
    await _quickRateSave();
    showPage('homePage');
}

async function quickRateStartNext(nextId, nextName) {
    await _quickRateSave();
    const startTime = Date.now();
    runningTimers[nextId] = { startTime, activityName: nextName };
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    await saveTimerToSheet(nextId, nextName, startTime);
    await notifyNativeTimerStart(nextId, nextName, startTime);
    loadActivities();
    showPage('homePage');
}

// Make functions available globally
window.showPage = showPage;
window.openActivity = openActivity;
window.deleteActivity = deleteActivity;
window.startTimerFromCard = startTimerFromCard;
window.stopTimerFromCard = stopTimerFromCard;
window.gapiLoaded = gapiLoaded;
window.gisLoaded = gisLoaded;
window.quickRateSaveOnly = quickRateSaveOnly;
window.quickRateStartNext = quickRateStartNext;
