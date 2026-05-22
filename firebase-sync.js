// ================================================
// SecureVault 3D — Firebase Google Sync
// ================================================

const FIREBASE_CONFIG_KEY = 'sv3d_firebase_config';

// ---- Firebase State ----
let firebaseReady = false;
let auth = null;
let db = null;
let googleProvider = null;

// ---- Sync State ----
let currentUser = null;
let syncEnabled = false;
let isSyncing = false;

// ---- Firebase Config Management ----
function getStoredFirebaseConfig() {
  try {
    const raw = localStorage.getItem(FIREBASE_CONFIG_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveFirebaseConfig(config) {
  localStorage.setItem(FIREBASE_CONFIG_KEY, JSON.stringify(config));
}

function clearFirebaseConfig() {
  localStorage.removeItem(FIREBASE_CONFIG_KEY);
  // Clean up Firebase state
  if (auth) {
    auth.signOut().catch(() => {});
  }
  stopRealtimeSync();
  currentUser = null;
  syncEnabled = false;
  firebaseReady = false;
  auth = null;
  db = null;
  googleProvider = null;
  updateSyncUI(false);
  updateSyncStatus('disconnected', 'Not configured');
  // Delete the Firebase app if it exists
  if (firebase.apps && firebase.apps.length > 0) {
    firebase.apps.forEach(app => app.delete().catch(() => {}));
  }
}

function initFirebaseFromStorage() {
  const config = getStoredFirebaseConfig();
  if (!config || !config.apiKey || !config.projectId) {
    firebaseReady = false;
    updateSyncStatus('disconnected', 'Not configured');
    return false;
  }
  try {
    // Don't re-initialize if already running
    if (firebase.apps && firebase.apps.length > 0) {
      // Already initialized — just re-use
      auth = firebase.auth();
      db = firebase.firestore();
      googleProvider = new firebase.auth.GoogleAuthProvider();
      firebaseReady = true;
      _attachAuthListener();
      return true;
    }
    firebase.initializeApp(config);
    auth = firebase.auth();
    db = firebase.firestore();
    googleProvider = new firebase.auth.GoogleAuthProvider();
    firebaseReady = true;
    _attachAuthListener();
    return true;
  } catch (err) {
    console.error('Firebase init failed:', err);
    firebaseReady = false;
    updateSyncStatus('error', 'Config error');
    return false;
  }
}

async function testFirebaseConnection() {
  if (!firebaseReady || !auth) {
    return { success: false, message: 'Firebase not initialized' };
  }
  try {
    // Try to reach Firestore by checking a non-existent doc (fast, low-cost)
    await db.collection('__test__').doc('__ping__').get();
    return { success: true, message: 'Connected successfully!' };
  } catch (err) {
    // Permission denied is actually a GOOD sign — it means Firestore is reachable
    if (err.code === 'permission-denied') {
      return { success: true, message: 'Connected! (Auth required for data access)' };
    }
    return { success: false, message: err.message || 'Connection failed' };
  }
}

// ---- Auth State Listener ----
function _attachAuthListener() {
  if (!auth) return;
  auth.onAuthStateChanged(user => {
    if (user) {
      currentUser = user;
      syncEnabled = true;
      updateSyncUI(true);
      updateSyncStatus('connected', 'Signed in as ' + user.displayName);
    } else {
      currentUser = null;
      syncEnabled = false;
      updateSyncUI(false);
      updateSyncStatus('disconnected', 'Not signed in');
    }
  });
  // Handle redirect result (fallback from popup)
  auth.getRedirectResult().then(result => {
    if (result && result.user) {
      currentUser = result.user;
      syncEnabled = true;
      updateSyncUI(true);
      updateSyncStatus('connected', 'Signed in as ' + currentUser.displayName);
      pullFromCloud();
    }
  }).catch(err => {
    if (err.code && err.code !== 'auth/no-auth-event') {
      console.error('Redirect sign-in error:', err);
      updateSyncStatus('error', 'Sign-in failed: ' + (err.code || err.message));
    }
  });
}

// ---- Auth Functions ----
let signingIn = false; // Prevents visibilitychange auto-lock during popup auth

async function googleSignIn() {
  if (!firebaseReady || !auth) {
    if (typeof showToast === 'function') showToast('Set up Firebase first in Settings', 'error');
    return false;
  }
  try {
    signingIn = true;
    updateSyncStatus('connecting', 'Signing in...');
    const result = await auth.signInWithPopup(googleProvider);
    currentUser = result.user;
    syncEnabled = true;
    updateSyncUI(true);
    updateSyncStatus('connected', 'Signed in as ' + currentUser.displayName);
    // Pull cloud data after sign in
    await pullFromCloud();
    signingIn = false;
    return true;
  } catch (err) {
    signingIn = false;
    console.error('Sign-in error:', err.code, err.message);

    // If popup was blocked or failed, try redirect flow
    if (err.code === 'auth/popup-blocked' || err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
      try {
        updateSyncStatus('connecting', 'Popup blocked — trying redirect...');
        await auth.signInWithRedirect(googleProvider);
        return true; // Page will reload after redirect
      } catch (redirectErr) {
        console.error('Redirect sign-in error:', redirectErr);
      }
    }

    // Show specific error for unauthorized domain
    if (err.code === 'auth/unauthorized-domain') {
      const domain = window.location.hostname;
      updateSyncStatus('error', 'Domain "' + domain + '" not authorized. Add it in Firebase Console → Auth → Settings → Authorized domains.');
      if (typeof showToast === 'function') showToast('Add ' + domain + ' to Firebase authorized domains', 'error');
    } else {
      updateSyncStatus('error', 'Sign-in failed: ' + (err.code || err.message));
      if (typeof showToast === 'function') showToast('Sign-in failed: ' + (err.code || err.message), 'error');
    }
    return false;
  }
}

async function googleSignOut() {
  if (!auth) return;
  try {
    await auth.signOut();
    currentUser = null;
    syncEnabled = false;
    updateSyncUI(false);
    updateSyncStatus('disconnected', 'Signed out');
  } catch (err) {
    console.error('Sign-out error:', err);
  }
}

// ---- Firestore Sync ----
function getUserDocRef() {
  if (!currentUser || !db) return null;
  return db.collection('securevault_users').doc(currentUser.uid);
}

async function pushToCloud() {
  if (!syncEnabled || !currentUser || isSyncing || !firebaseReady) return;
  isSyncing = true;
  updateSyncStatus('syncing', 'Uploading...');
  try {
    const docRef = getUserDocRef();
    const encryptedVault = localStorage.getItem('sv3d_vault') || '';
    const categories = localStorage.getItem('sv3d_cats') || '[]';
    const masterHash = localStorage.getItem('sv3d_master') || '';

    await docRef.set({
      vault: encryptedVault,
      categories: categories,
      masterHash: masterHash,
      lastSync: firebase.firestore.FieldValue.serverTimestamp(),
      email: currentUser.email,
      displayName: currentUser.displayName
    }, { merge: true });

    const now = new Date().toLocaleTimeString();
    updateSyncStatus('connected', 'Synced at ' + now);
  } catch (err) {
    console.error('Push error:', err);
    updateSyncStatus('error', 'Upload failed');
  }
  isSyncing = false;
}

async function pullFromCloud() {
  if (!syncEnabled || !currentUser || isSyncing || !firebaseReady) return;
  isSyncing = true;
  updateSyncStatus('syncing', 'Downloading...');
  try {
    const docRef = getUserDocRef();
    const doc = await docRef.get();

    if (doc.exists) {
      const data = doc.data();
      // Only overwrite if cloud has data
      if (data.vault) localStorage.setItem('sv3d_vault', data.vault);
      if (data.categories) localStorage.setItem('sv3d_cats', data.categories);
      if (data.masterHash) localStorage.setItem('sv3d_master', data.masterHash);

      const now = new Date().toLocaleTimeString();
      updateSyncStatus('connected', 'Synced at ' + now);

      // Trigger app reload of data
      if (typeof window._onCloudPull === 'function') window._onCloudPull();
    } else {
      // No cloud data yet, push local data up
      updateSyncStatus('connected', 'No cloud data — will sync on next save');
    }
  } catch (err) {
    console.error('Pull error:', err);
    updateSyncStatus('error', 'Download failed');
  }
  isSyncing = false;
}

// ---- Real-time listener ----
let unsubscribe = null;

function startRealtimeSync() {
  if (!currentUser || !db) return;
  const docRef = getUserDocRef();
  unsubscribe = docRef.onSnapshot(doc => {
    if (!doc.exists || isSyncing) return;
    const data = doc.data();
    const localVault = localStorage.getItem('sv3d_vault') || '';
    // Only update if cloud data is different
    if (data.vault && data.vault !== localVault) {
      if (data.vault) localStorage.setItem('sv3d_vault', data.vault);
      if (data.categories) localStorage.setItem('sv3d_cats', data.categories);
      if (data.masterHash) localStorage.setItem('sv3d_master', data.masterHash);
      const now = new Date().toLocaleTimeString();
      updateSyncStatus('connected', 'Updated at ' + now);
      if (typeof window._onCloudPull === 'function') window._onCloudPull();
    }
  }, err => {
    console.error('Realtime sync error:', err);
  });
}

function stopRealtimeSync() {
  if (unsubscribe) { unsubscribe(); unsubscribe = null; }
}

// ---- UI Updates ----
function updateSyncUI(signedIn) {
  const btnSign = document.getElementById('btnGoogleSign');
  const btnOut = document.getElementById('btnGoogleSignOut');
  const avatar = document.getElementById('syncAvatar');
  const nameEl = document.getElementById('syncUserName');

  if (signedIn && currentUser) {
    if (btnSign) btnSign.style.display = 'none';
    if (btnOut) btnOut.style.display = 'inline-flex';
    if (avatar) {
      avatar.style.display = 'block';
      avatar.src = currentUser.photoURL || '';
    }
    if (nameEl) nameEl.textContent = currentUser.displayName || currentUser.email;
    startRealtimeSync();
  } else {
    if (btnSign) btnSign.style.display = firebaseReady ? 'inline-flex' : 'none';
    if (btnOut) btnOut.style.display = 'none';
    if (avatar) avatar.style.display = 'none';
    if (nameEl) nameEl.textContent = '';
    stopRealtimeSync();
  }
}

function updateSyncStatus(state, message) {
  const dot = document.getElementById('syncDot');
  const text = document.getElementById('syncText');
  if (dot) {
    dot.className = 'sync-dot';
    if (state === 'connected') dot.classList.add('sync-connected');
    else if (state === 'syncing') dot.classList.add('sync-syncing');
    else if (state === 'error') dot.classList.add('sync-error');
    else if (state === 'connecting') dot.classList.add('sync-syncing');
    else dot.classList.add('sync-disconnected');
  }
  if (text) text.textContent = message || '';
}
