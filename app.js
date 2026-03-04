// TODO SETUP Google Sheets API Configuration

const API_KEY = 'AIzaSyDMLfR5FEwm8F4l2AZFB0xgHoM1PlTwEpM';        // Run from and data stored in andyhine@gmail.com Google Sheets and Cloud Console Google Sheets API access

const CLIENT_ID = '198184405189-k0fgpof1g7u9tlkd332gdi7f9v627mgc.apps.googleusercontent.com';


/*******************************************************************/

const DISCOVERY_DOCS = ['https://sheets.googleapis.com/$discovery/rest?version=v4'];
const SCOPES = 'https://www.googleapis.com/auth/spreadsheets';

// Global State
let gapiInited = false;
let gisInited = false;
let tokenClient;
let spreadsheetId = localStorage.getItem('spreadsheetId') || null;
let currentActivity = null;
let timerInterval = null;
let timerStartTime = null;
let elapsedSeconds = 0;
let isAuthenticated = false; // Track if user is authenticated and ready
let errorShown = false; // Track if error modal already shown
let runningTimers = JSON.parse(localStorage.getItem('runningTimers')) || {}; // { activityId: { startTime, elapsed, activityName } }

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
        await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: DISCOVERY_DOCS,
        });
        gapiInited = true;
        maybeEnableButtons();
    } catch (error) {
        console.error('Error initializing GAPI client:', error);
        let errorMsg = error.message || error.result?.error?.message || 'Unknown error';
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
    if (!checkConfiguration()) {
        return;
    }
    
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: '', // defined later
            error_callback: (error) => {
                console.error('OAuth initialization error:', error);
                const errorMsg = error.message || error.type || JSON.stringify(error) || '';
                const errorLower = errorMsg.toLowerCase();
                
                // Check for redirect_uri_mismatch or origin errors (400 errors)
                if (errorLower.includes('redirect_uri') || errorLower.includes('redirect uri') || 
                    errorLower.includes('400') || errorLower.includes('origin') || 
                    errorLower.includes("doesn't comply")) {
                    showError('OAuth Error: JavaScript origin not authorized for this domain. Your OAuth Client ID needs to be updated.', 'origin');
                } else if (errorLower.includes('popup') || errorLower.includes('blocked')) {
                    showError('Browser blocked the sign-in popup window. Please allow popups for this site.', 'popup');
                } else {
                    showError('OAuth error: ' + errorMsg);
                }
            }
        });
        gisInited = true;
        maybeEnableButtons();
    } catch (error) {
        console.error('Error loading GIS:', error);
        showError('Failed to initialize Google Sign-In. Error: ' + (error.message || 'Client ID may be invalid'));
    }
}

function maybeEnableButtons() {
    if (gapiInited && gisInited) {
        initializeApp();
    }
}

// Initialize App
async function initializeApp() {
    try {
        // Try to restore token from localStorage
        const savedToken = localStorage.getItem('gapiToken');
        if (savedToken) {
            try {
                const token = JSON.parse(savedToken);
                gapi.client.setToken(token);
                console.log('Restored token from localStorage');
            } catch (e) {
                console.warn('Failed to restore token:', e);
                localStorage.removeItem('gapiToken');
            }
        }
        
        // Check if we have a valid access token
        if (gapi.client.getToken() === null) {
            // Prompt the user to select a Google account and ask for consent
            tokenClient.callback = async (resp) => {
                if (resp.error !== undefined) {
                    console.error('OAuth error:', resp);
                    const errorDesc = resp.error_description || resp.error || '';
                    const errorLower = errorDesc.toLowerCase();
                    
                    // Check for specific error types - OAuth errors take priority
                    if (errorLower.includes('redirect_uri') || errorLower.includes('redirect uri') || 
                        errorLower.includes('origin') || errorLower.includes('invalid') || 
                        errorLower.includes('400') || errorLower.includes("doesn't comply")) {
                        showError('OAuth Error: JavaScript origin not authorized for this domain. The OAuth Client ID needs to include this domain in "Authorized JavaScript origins".', 'origin');
                    } else if (errorLower.includes('403') || errorLower.includes('access_denied') || errorLower.includes('access blocked') || errorLower.includes('verification process') || errorLower.includes('not completed') || errorLower.includes('test user')) {
                        showError('Access blocked: Your email needs to be added as a test user. Click below for instructions.', 'testuser');
                    } else if (errorLower.includes('popup')) {
                        showError('Popup was blocked or closed.', 'popup');
                    } else {
                        showError('Authentication failed: ' + errorDesc + '. Make sure you\'ve added your email as a test user in the OAuth consent screen.');
                    }
                    return;
                }
                try {
                    // Save token to localStorage
                    const token = gapi.client.getToken();
                    if (token) {
                        localStorage.setItem('gapiToken', JSON.stringify(token));
                        console.log('Saved token to localStorage');
                    }
                    
                    await setupSpreadsheet();
                    updateSpreadsheetLink();
                    await loadActivities();
                    isAuthenticated = true;
                    enableAppButtons();
                } catch (error) {
                    console.error('Error after authentication:', error);
                    showError('Error setting up spreadsheet: ' + (error.message || 'Unknown error'));
                }
            };
            
            try {
                // Request access token with popup (empty prompt = only show if needed)
                tokenClient.requestAccessToken({ prompt: '' });
                
                // Check after a delay if auth didn't complete and no error was shown
                setTimeout(() => {
                    if (!isAuthenticated && !errorShown) {
                        // Only show popup-blocked if no other error has been displayed
                        console.log('Authentication timed out, checking for popup block');
                        showError('Sign-in did not complete. If you saw an error in the popup, check the instructions below.', 'origin');
                    }
                }, 5000);
            } catch (error) {
                console.error('Error requesting access token:', error);
                const errorMsg = error.message || error.toString();
                const errorLower = errorMsg.toLowerCase();
                
                if (errorLower.includes('popup') || errorLower.includes('blocked')) {
                    showError('Browser blocked the sign-in popup. Please allow popups for this site and try again.', 'popup');
                } else if (errorLower.includes('redirect_uri') || errorLower.includes('origin')) {
                    showError('OAuth configuration error. The JavaScript origin is not authorized.', 'origin');
                } else {
                    showError('Failed to request access token. Check that your OAuth Client ID is correct and the authorized origin includes this domain.');
                }
            }
        } else {
            await setupSpreadsheet();
            updateSpreadsheetLink();
            await loadActivities();
            isAuthenticated = true;
            enableAppButtons();
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
            localStorage.setItem('spreadsheetId', spreadsheetId);
            
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
            
            if (activitySessions.length > 0) {
                // Calculate average score (duration * rating for each session, then average)
                // Use minimum of 60 minutes for score calculation (marginal value theorem)
                const scores = activitySessions.map(s => {
                    const duration = parseFloat(s[3]);
                    const scoreMinutes = Math.max(duration, 60); // Round up to 60 if less than 1 hour
                    return scoreMinutes * parseFloat(s[4]);
                });
                avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
                
                // Get last session score
                const lastSession = activitySessions[activitySessions.length - 1];
                const lastDuration = parseFloat(lastSession[3]);
                const lastScoreMinutes = Math.max(lastDuration, 60);
                lastScore = lastScoreMinutes * parseFloat(lastSession[4]);
            }
            
            return {
                id: activityId,
                name: activityName,
                avgRewardPerHour: parseFloat(avgScore.toFixed(2)),
                lastRewardPerHour: parseFloat(lastScore.toFixed(2)),
                sessionCount: activitySessions.length
            };
        });
        
        // Render activities
        activitiesList.innerHTML = activityMetrics.map(activity => {
            const hasRunningTimer = runningTimers[activity.id];
            // Don't show below average warning if timer is running
            const isBelowAverage = !hasRunningTimer && activity.sessionCount > 0 && activity.lastRewardPerHour < activity.avgRewardPerHour;
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
                            <div class="metric-label">Avg Score</div>
                            <div class="metric-value">${activity.sessionCount > 0 ? activity.avgRewardPerHour.toFixed(2) : '--'}</div>
                        </div>
                        <div class="metric">
                            <div class="metric-label">Last Score</div>
                            <div class="metric-value ${isBelowAverage ? 'below-average' : ''}">${activity.sessionCount > 0 ? activity.lastRewardPerHour.toFixed(2) : '--'}</div>
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
        
        // Calculate metrics
        let avgScore = 0;
        let lastScore = 0;
        let hasRoundedUpSessions = false;
        
        if (activitySessions.length > 0) {
            // Calculate average score (duration * rating for each session, then average)
            // Use minimum of 60 minutes for score calculation (marginal value theorem)
            const scores = activitySessions.map(s => {
                const duration = parseFloat(s[3]);
                const rating = parseFloat(s[4]);
                const scoreMinutes = Math.max(duration, 60); // Round up to 60 if less than 1 hour
                if (duration < 60) hasRoundedUpSessions = true;
                const score = scoreMinutes * rating;
                return score;
            });
            avgScore = scores.reduce((sum, score) => sum + score, 0) / scores.length;
            
            // Get last session score
            const lastSession = activitySessions[activitySessions.length - 1];
            const lastDuration = parseFloat(lastSession[3]);
            const lastScoreMinutes = Math.max(lastDuration, 60);
            const lastWasRoundedUp = lastDuration < 60;
            lastScore = lastScoreMinutes * parseFloat(lastSession[4]);
        }
        
        // Update UI
        document.getElementById('avgRewardTime').textContent = activitySessions.length > 0 ? avgScore.toFixed(2) : '--';
        document.getElementById('lastRewardTime').textContent = activitySessions.length > 0 ? lastScore.toFixed(2) : '--';
        
        // Show score notes if sessions were rounded up
        const avgScoreNote = document.getElementById('avgScoreNote');
        const lastScoreNote = document.getElementById('lastScoreNote');
        
        if (hasRoundedUpSessions && activitySessions.length > 0) {
            avgScoreNote.textContent = '(Some sessions < 1hr counted as 1hr)';
            avgScoreNote.classList.remove('hidden');
        } else {
            avgScoreNote.classList.add('hidden');
        }
        
        if (activitySessions.length > 0) {
            const lastSession = activitySessions[activitySessions.length - 1];
            const lastDuration = parseFloat(lastSession[3]);
            if (lastDuration < 60) {
                lastScoreNote.textContent = '(Session < 1hr counted as 1hr)';
                lastScoreNote.classList.remove('hidden');
            } else {
                lastScoreNote.classList.add('hidden');
            }
        }
        
        // Show warning if needed (but not if timer is running)
        const warningBox = document.getElementById('warningBox');
        const isTimerRunning = runningTimers[activityId];
        if (!isTimerRunning && activitySessions.length > 0 && lastScore < avgScore) {
            warningBox.classList.remove('hidden');
        } else {
            warningBox.classList.add('hidden');
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
            sessionsList.innerHTML = activitySessions.slice(-10).reverse().map((session, index) => {
                const duration = parseFloat(session[3]);
                const rating = parseFloat(session[4]);
                // Use minimum of 60 minutes for score calculation (marginal value theorem)
                const scoreMinutes = Math.max(duration, 60);
                const score = scoreMinutes * rating;
                const wasRoundedUp = duration < 60;
                const hours = Math.floor(duration / 60);
                const minutes = Math.round(duration % 60);
                const durationText = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
                const date = new Date(session[2]);
                // Format date as YYYY-MM-DD HH:MM
                const year = date.getFullYear();
                const month = String(date.getMonth() + 1).padStart(2, '0');
                const day = String(date.getDate()).padStart(2, '0');
                const hours24 = String(date.getHours()).padStart(2, '0');
                const mins = String(date.getMinutes()).padStart(2, '0');
                const dateText = `${year}-${month}-${day} ${hours24}:${mins}`;
                
                // Highlight most recent session if below average (but not if timer is running)
                const isMostRecent = index === 0;
                const isTimerRunning = runningTimers[activityId];
                const isBelowAvg = !isTimerRunning && isMostRecent && lastScore < avgScore && activitySessions.length > 1;
                
                return `
                    <div class="session-item ${isBelowAvg ? 'below-average-session' : ''}">
                        ${isBelowAvg ? '<div class="session-warning">⚠️ Below Average</div>' : ''}
                        <div class="session-info">
                            <div class="session-time">${durationText}</div>
                            <div class="session-date">${dateText}</div>
                        </div>
                        <div class="session-stats">
                            <div class="session-reward">${rating}/10</div>
                            <div class="session-score">
                                Score: ${score.toFixed(1)}
                                ${wasRoundedUp ? '<br><span style="font-size: 0.7rem; opacity: 0.7; font-style: italic;"><1hr counted as 1hr</span>' : ''}
                            </div>
                        </div>
                    </div>
                `;
            }).join('');
        }
        
    } catch (error) {
        console.error('Error loading activity detail:', error);
    }
}

// Timer Functions
let timerState = {
    running: false,
    startTime: null,
    elapsed: 0
};

function startTimer() {
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
    
    document.getElementById('startTimerBtn').classList.add('hidden');
    document.getElementById('stopTimerBtn').classList.remove('hidden');
    
    timerInterval = setInterval(updateTimerDisplay, 100);
}

function stopTimer() {
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
    
    // Monitor for popup blocking (catch GSI_LOGGER messages)
    // Note: OAuth origin errors often trigger this warning even though popup opened
    // Give very low priority - only show if no other error shown
    const originalConsoleWarn = console.warn;
    console.warn = function(...args) {
        const message = args.join(' ');
        if (message.includes('GSI_LOGGER') && message.includes('Failed to open popup')) {
            // Wait to see if an OAuth error or timeout comes through first
            setTimeout(() => {
                if (!errorShown && !isAuthenticated) {
                    // Default to origin error since popup "failed" often means OAuth rejected the origin
                    console.log('GSI popup failed - likely origin not authorized');
                    showError('Sign-in popup failed. If you saw an error message about "redirect_uri_mismatch" or "invalid request", the JavaScript origin needs to be added.', 'origin');
                }
            }, 2000);
        }
        originalConsoleWarn.apply(console, args);
    };
    
    // Error Modal Buttons
    document.getElementById('retryConnectionBtn').addEventListener('click', () => {
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
    
    // Check if Google APIs loaded after a timeout
    setTimeout(() => {
        if (typeof gapi === 'undefined') {
            showError('Google API library failed to load. Check your internet connection and make sure you\'re serving the app over HTTP/HTTPS (not opening file:// directly).');
        } else if (typeof google === 'undefined' || typeof google.accounts === 'undefined') {
            showError('Google Identity Services failed to load. Check your internet connection.');
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
function startTimerFromCard(activityId, activityName) {
    // Save to running timers
    runningTimers[activityId] = {
        startTime: Date.now(),
        activityName: activityName
    };
    localStorage.setItem('runningTimers', JSON.stringify(runningTimers));
    
    // Refresh activities list to show timer
    loadActivities();
}

// Stop timer from activity card on main screen
function stopTimerFromCard(activityId, activityName) {
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

// Make functions available globally
window.showPage = showPage;
window.openActivity = openActivity;
window.deleteActivity = deleteActivity;
window.startTimerFromCard = startTimerFromCard;
window.stopTimerFromCard = stopTimerFromCard;
window.gapiLoaded = gapiLoaded;
window.gisLoaded = gisLoaded;
