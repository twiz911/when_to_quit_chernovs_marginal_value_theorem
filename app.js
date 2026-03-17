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
const WARNING_THRESHOLD_PERCENT = 20;

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
let runningTimers = JSON.parse(localStorage.getItem('runningTimers')) || {}; // { activityId: { startTime, elapsed, activityName } }

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

async function syncRunningTimersToNativeNotifications() {
    if (!TimerPlugin) return;

    const entries = Object.entries(runningTimers || {});
    for (const [activityId, timer] of entries) {
        const startTime = Number(timer?.startTime);
        const activityName = timer?.activityName || 'Activity';
        if (!activityId || !Number.isFinite(startTime) || startTime <= 0) continue;
        await notifyNativeTimerStart(activityId, activityName, startTime);
    }
}

async function syncActivitiesToNative(activities) {
    if (!TimerPlugin) return;
    try { await TimerPlugin.syncActivities({ activities }); }
    catch (e) { console.warn('TimerPlugin.syncActivities:', e); }
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
    window.Capacitor.Plugins.App.addListener('appStateChange', ({ isActive }) => {
        if (isActive && isAuthenticated) {
            checkNativeLaunchIntent();
            syncRunningTimersToNativeNotifications();
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
            setRetryButtonForSignIn();
            if (!oauthErrorSeen) {
                // Redirect-based auth can be auto-started when not signed in.
                requestGoogleAuthFromUserGesture();
                return;
            }
            showError('Tap "Connect Google" below to sign in. This uses full-page redirect (no popup).');
        } else {
            await setupSpreadsheet();
            updateSpreadsheetLink();
            await loadTimersFromSheet();
            await syncRunningTimersToNativeNotifications();
            await loadActivities();
            isAuthenticated = true;
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
}

// Create the Timers sheet if it doesn't already exist
async function ensureTimersSheet() {
    try {
        await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A1:C1',
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
                range: 'Timers!A1:C1',
                valueInputOption: 'RAW',
                resource: { values: [['Activity ID', 'Activity Name', 'Start Time']] }
            });
        } catch (err) {
            console.warn('Could not create Timers sheet:', err);
        }
    }
}

// Write a running timer to the Timers sheet
async function saveTimerToSheet(activityId, activityName, startTime) {
    try {
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A:C',
            valueInputOption: 'RAW',
            resource: { values: [[activityId, activityName, new Date(startTime).toISOString()]] }
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
        // rows[0] is header; find data row index (1-based in sheet)
        const rowIdx = rows.findIndex((r, i) => i > 0 && r[0] === activityId);
        if (rowIdx === -1) return;
        const meta = await gapi.client.sheets.spreadsheets.get({ spreadsheetId: spreadsheetId });
        const timersSheet = meta.result.sheets.find(s => s.properties.title === 'Timers');
        if (!timersSheet) return;
        await gapi.client.sheets.spreadsheets.batchUpdate({
            spreadsheetId: spreadsheetId,
            resource: {
                requests: [{ deleteDimension: { range: {
                    sheetId: timersSheet.properties.sheetId,
                    dimension: 'ROWS',
                    startIndex: rowIdx,
                    endIndex: rowIdx + 1
                } } }]
            }
        });
    } catch (e) {
        console.warn('Could not remove timer from sheet:', e);
    }
}

// Load running timers from the Timers sheet (cross-device sync)
async function loadTimersFromSheet() {
    try {
        const resp = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Timers!A2:C',
        });
        const rows = resp.result.values || [];
        // Rebuild runningTimers from sheet data
        Object.keys(runningTimers).forEach(k => delete runningTimers[k]);
        rows.forEach(row => {
            if (row[0]) {
                runningTimers[row[0]] = {
                    startTime: new Date(row[2]).getTime(),
                    activityName: row[1] || ''
                };
            }
        });
        localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    } catch (e) {
        console.warn('Could not load timers from sheet:', e);
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
        loadingIndicator.classList.remove('hidden');
        
        // Fetch activities
        const activitiesResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Activities!A2:B',
        });
        
        // Fetch sessions
        const sessionsResponse = await gapi.client.sheets.spreadsheets.values.get({
            spreadsheetId: spreadsheetId,
            range: 'Sessions!A2:E',
        });
        
        const activities = activitiesResponse.result.values || [];
        const sessions = sessionsResponse.result.values || [];
        
        loadingIndicator.classList.add('hidden');
        
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
            if (aRunning !== bRunning) return aRunning ? -1 : 1;
            return a.name.localeCompare(b.name);
        });

        // Render activities
        activitiesList.innerHTML = activityMetrics.map(activity => {
            const hasRunningTimer = runningTimers[activity.id];
            // Only flag below-average if a declining split covers >= WARNING_THRESHOLD_PERCENT of total time
            const isBelowAverage = !hasRunningTimer && activity.sessionCount > 0 && activity.splitResult !== null
                && activity.splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT;
            // Red number matches detail screen: no timer restriction
            const isRecentRed = activity.sessionCount > 0 && activity.splitResult !== null
                && activity.splitResult.recentPercent >= WARNING_THRESHOLD_PERCENT;
            const initialLabel = activity.splitResult
                ? `Initial ${Math.round(activity.splitResult.initialPercent)}% Average`
                : 'Average';
            const recentLabel = activity.splitResult
                ? `Most Recent ${Math.round(activity.splitResult.recentPercent)}% Average`
                : 'Most Recent';
            let timerDisplay = '';
            
            if (hasRunningTimer) {
                const elapsed = Math.floor((Date.now() - hasRunningTimer.startTime) / 1000);
                const hours = Math.floor(elapsed / 3600);
                const minutes = Math.floor((elapsed % 3600) / 60);
                const seconds = elapsed % 60;
                timerDisplay = `<span class="timer-badge">⏱ ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}</span>`;
            }
            
            // Timer control button
            const timerButton = hasRunningTimer 
                ? `<button class="timer-control-btn stop" onclick="event.stopPropagation(); stopTimerFromCard('${activity.id}', '${activity.name.replace(/'/g, "\\'")}')\">⏹ Stop</button>`
                : `<button class="timer-control-btn start" onclick="event.stopPropagation(); startTimerFromCard('${activity.id}', '${activity.name.replace(/'/g, "\\'")}')\">▶ Start</button>`;
            
            return `
                <div class="activity-card ${hasRunningTimer ? 'timer-running' : ''} ${isBelowAverage ? 'below-average-card' : ''}" onclick="openActivity('${activity.id}', '${activity.name.replace(/'/g, "\\'")}')">
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
                    </div>
                </div>
            `;
        }).join('');
        
    } catch (error) {
        console.error('Error loading activities:', error);
        loadingIndicator.classList.add('hidden');
        
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
                <div class="empty-state-text">Error loading activities.<br>Check the error message above.</div>
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
        
        return true;
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
    
    // Check if this activity has a running timer
    if (runningTimers[activityId]) {
        timerState.running = true;
        timerState.startTime = runningTimers[activityId].startTime;
        timerState.elapsed = Math.floor((Date.now() - timerState.startTime) / 1000);
        
        document.getElementById('startTimerBtn').classList.add('hidden');
        document.getElementById('stopTimerBtn').classList.remove('hidden');
        
        timerInterval = setInterval(updateTimerDisplay, 100);
    } else {
        // Reset timer if no running timer for this activity
        timerState.running = false;
        timerState.elapsed = 0;
        document.getElementById('timerDisplay').textContent = '00:00:00';
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
        const formatMinutes = (mins) => {
            const hours = Math.floor(mins / 60);
            const minutes = Math.round(mins % 60);
            return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
        };

        // Update stat labels dynamically
        const avgScoreLabel = document.getElementById('avgScoreLabel');
        const lastScoreLabel = document.getElementById('lastScoreLabel');
        if (splitResult) {
            const ip = Math.round(splitResult.initialPercent);
            const rp = Math.round(splitResult.recentPercent);
            if (avgScoreLabel) avgScoreLabel.textContent = `Initial ${ip}% Average`;
            if (lastScoreLabel) lastScoreLabel.textContent = `Most Recent ${rp}% Average`;
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
                warningText.innerHTML = `<strong>Warning!</strong><br>Your most recent ${rp}% of time (${formatMinutes(splitResult.recentMins)}) average rating ${lastScore.toFixed(2)} is ${pctBelow}% below your initial ${ip}% time (${formatMinutes(splitResult.initialMins)}) average rating ${avgScore.toFixed(2)}.<br>Consider switching activities.`;
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
                const hours = Math.floor(duration / 60);
                const minutes = Math.round(duration % 60);
                const durationText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
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
    
    timerState.running = true;
    timerState.startTime = Date.now() - (timerState.elapsed * 1000);
    
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
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    // Pre-fill manual entry with timer values (already filled by updateTimerDisplay)
    document.getElementById('manualHours').value = hours;
    document.getElementById('manualMinutes').value = minutes;
    
    // Remove from running timers
    if (currentActivity) {
        delete runningTimers[currentActivity.id];
        localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
        await removeTimerFromSheet(currentActivity.id);
        await notifyNativeTimerStop(currentActivity.id);
    }

    // Reset timer display and state
    timerState.elapsed = 0;
    document.getElementById('timerDisplay').textContent = '00:00:00';
    document.getElementById('startTimerBtn').classList.remove('hidden');
    document.getElementById('stopTimerBtn').classList.add('hidden');
    
    // Scroll to manual entry
    document.getElementById('manualEntryForm').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function updateTimerDisplay() {
    const totalSeconds = Math.floor((Date.now() - timerState.startTime) / 1000);
    timerState.elapsed = totalSeconds;
    
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    
    const display = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    document.getElementById('timerDisplay').textContent = display;
    
    // Update manual entry fields in real-time
    document.getElementById('manualHours').value = hours;
    const totalMinutes = Math.floor(totalSeconds / 60);
    const remainder = totalMinutes % 60;
    document.getElementById('manualMinutes').value = remainder;
}

// Save Session
async function saveSession(durationMinutes, rewardRating) {
    try {
        const sessionId = 'SES_' + Date.now();
        const timestamp = new Date().toISOString();
        
        await gapi.client.sheets.spreadsheets.values.append({
            spreadsheetId: spreadsheetId,
            range: 'Sessions!A:E',
            valueInputOption: 'RAW',
            resource: {
                values: [[sessionId, currentActivity.id, timestamp, durationMinutes, rewardRating]]
            }
        });
        
        return true;
    } catch (error) {
        console.error('Error saving session:', error);
        
        // Check if token expired
        const status = error.status || error.result?.error?.code;
        if (status === 401 || status === 403) {
            handleTokenExpiration();
            return false;
        }
        
        showError('Failed to save session: ' + (error.result?.error?.message || error.message || 'Unknown error'));
        return false;
    }
}

// Page Navigation
function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
    
    // Reload activities when returning to home page
    if (pageId === 'homePage' && isAuthenticated) {
        loadActivities();
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
            const success = await addActivity(activityName);
            if (success) {
                document.getElementById('activityNameInline').value = '';
                document.getElementById('addActivityBtn').classList.remove('hidden');
                document.getElementById('addActivityInline').classList.add('hidden');
                loadActivities();
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
        
        const hours = parseInt(document.getElementById('manualHours').value) || 0;
        const minutes = parseInt(document.getElementById('manualMinutes').value) || 0;
        const reward = parseInt(document.getElementById('rewardRating').value);
        
        const totalMinutes = hours * 60 + minutes;
        
        if (totalMinutes === 0) {
            alert('Please enter a duration greater than 0.');
            return;
        }
        
        // Stop the timer if running for this activity
        if (currentActivity && runningTimers[currentActivity.id]) {
            delete runningTimers[currentActivity.id];
            localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
            
            // Hide stop button and show start button
            document.getElementById('stopTimerBtn').classList.add('hidden');
            document.getElementById('startTimerBtn').classList.remove('hidden');
            
            // Stop the timer interval if it's running
            if (timerState.running) {
                timerState.running = false;
                clearInterval(timerInterval);
            }
        }
        
        const success = await saveSession(totalMinutes, reward);
        if (success) {
            // Reset form
            document.getElementById('manualHours').value = 0;
            document.getElementById('manualMinutes').value = 0;
            document.getElementById('rewardRating').value = 5;
            document.getElementById('ratingDisplay').textContent = 5;
            
            // Reload activity detail
            await loadActivityDetail(currentActivity.id);
            
        } else {
            alert('Error saving session. Please try again.');
        }
    });
    
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
});

// Update running timer displays on main screen
function updateRunningTimerDisplays() {
    Object.keys(runningTimers).forEach(activityId => {
        const timerBadge = document.querySelector(`[onclick*="${activityId}"] .timer-badge`);
        if (timerBadge) {
            const elapsed = Math.floor((Date.now() - runningTimers[activityId].startTime) / 1000);
            const hours = Math.floor(elapsed / 3600);
            const minutes = Math.floor((elapsed % 3600) / 60);
            const seconds = elapsed % 60;
            timerBadge.textContent = `⏱ ${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
        }
    });
}

// Start timer from activity card on main screen
async function startTimerFromCard(activityId, activityName) {
    const startTime = Date.now();
    runningTimers[activityId] = {
        startTime: startTime,
        activityName: activityName
    };
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    await saveTimerToSheet(activityId, activityName, startTime);
    await notifyNativeTimerStart(activityId, activityName, startTime);

    // Refresh activities list to show timer
    loadActivities();
}

// Stop timer from activity card on main screen
async function stopTimerFromCard(activityId, activityName) {
    // Calculate elapsed time before removing from running timers
    const timerData = runningTimers[activityId];
    if (!timerData) {
        return; // Timer not running
    }
    
    const totalSeconds = Math.floor((Date.now() - timerData.startTime) / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    
    // Remove from running timers
    delete runningTimers[activityId];
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    await removeTimerFromSheet(activityId);
    await notifyNativeTimerStop(activityId);

    // Refresh activities list
    loadActivities();
    
    // Open activity to save the session
    openActivity(activityId, activityName);
    
    // Pre-fill the manual entry form with elapsed time
    // Wait a bit for the page to load
    setTimeout(() => {
        document.getElementById('manualHours').value = hours;
        document.getElementById('manualMinutes').value = minutes;
        // Scroll to manual entry
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
    const totalSecs = Math.floor(elapsedMs / 1000);
    const h = Math.floor(totalSecs / 3600);
    const m = Math.floor((totalSecs % 3600) / 60);
    const durationText = h > 0 ? `${h}h ${m}m` : `${m}m`;

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
