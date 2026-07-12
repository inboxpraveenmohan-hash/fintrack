/* FinTrack — optional Google Drive cloud sync.
   Entirely separate from app.js: talks to it only through window.fintrack (see the bridge
   at the end of app.js). If this script fails to load, or the app is opened via file://,
   the app behaves exactly as the fully offline, localStorage-only app it always was.

   Setup: see CLOUD_SYNC_SETUP.md for how to get a Client ID and paste it below. */

(function () {
  "use strict";

  const CLIENT_ID = "476365461245-hivtv2tqqm9nl9tdv12jqclvb115jirb.apps.googleusercontent.com";
  const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
  const DRIVE_FILENAME = "fintrack_portfolio.json";
  const DEBOUNCE_MS = 1800;
  const WAS_SIGNED_IN_KEY = "fintrack_drive_was_signed_in";
  const FILE_ID_KEY = "fintrack_drive_file_id";
  const ACCESS_TOKEN_KEY = "fintrack_drive_access_token";
  const TOKEN_EXPIRES_KEY = "fintrack_drive_token_expires_at";

  // localStorage throws for opaque origins (e.g. file://) in some browsers — same guard
  // pattern as app.js's persist()/load(), so a blocked localStorage never breaks this module.
  function safeGet(key) { try { return localStorage.getItem(key); } catch (e) { return null; } }
  function safeSet(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }
  function safeRemove(key) { try { localStorage.removeItem(key); } catch (e) { /* ignore */ } }

  let tokenClient = null;
  // Cache the access token itself (not just "was signed in") across reloads. Google's token
  // client only supports the dialog UX for requestAccessToken() — there is no silent variant —
  // so the only way to avoid an account-chooser popup on every reload is to not ask for a new
  // token at all when the previous one (~1hr lifetime) is still valid.
  let accessToken = safeGet(ACCESS_TOKEN_KEY);
  let tokenExpiresAt = Number(safeGet(TOKEN_EXPIRES_KEY)) || 0;
  let fileId = safeGet(FILE_ID_KEY);
  let debounceTimer = null;
  let pendingPush = false;
  let lastKnownRemoteModifiedTime = null;
  let lastSyncedRev = null;
  let signedIn = false;

  function isFileProtocol() { return location.protocol === "file:"; }
  function gisReady() { return typeof google !== "undefined" && google.accounts && google.accounts.oauth2; }

  function waitForGis(timeoutMs) {
    return new Promise((resolve) => {
      const start = Date.now();
      (function poll() {
        if (gisReady() || Date.now() - start > timeoutMs) { resolve(); return; }
        setTimeout(poll, 100);
      })();
    });
  }

  function initTokenClient() {
    if (tokenClient || !gisReady()) return;
    tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: CLIENT_ID,
      scope: DRIVE_SCOPE,
      // Note: Google's token client only supports the dialog UX for requestAccessToken() —
      // there is no fully silent grant, with or without this flag (that's what the access-token
      // cache above is for). This just opts into the FedCM-based dialog instead of the legacy
      // 3rd-party-cookie one, which Chrome/Edge/Safari now block or partition by default.
      use_fedcm_for_prompt: true,
      callback: () => {}, // overridden per-call in requestToken()
      error_callback: () => {} // overridden per-call in requestToken()
    });
  }

  function requestToken(promptMode) {
    return new Promise((resolve, reject) => {
      if (!tokenClient) { reject(new Error("Google sign-in not available")); return; }
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; reject(new Error("Google sign-in timed out")); }
      }, 12000);
      tokenClient.callback = (resp) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (!resp || resp.error) { reject(new Error((resp && resp.error) || "sign-in failed")); return; }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (Number(resp.expires_in) || 0) * 1000;
        safeSet(ACCESS_TOKEN_KEY, accessToken);
        safeSet(TOKEN_EXPIRES_KEY, String(tokenExpiresAt));
        resolve(accessToken);
      };
      // FedCM reports failures (no session, dialog dismissed, opted out, etc.) here
      // instead of through callback() — without this, those cases fell through to the
      // 12s timeout instead of failing fast.
      tokenClient.error_callback = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new Error((err && err.type) || "sign-in unavailable"));
      };
      tokenClient.requestAccessToken({ prompt: promptMode });
    });
  }

  async function ensureToken() {
    if (accessToken && Date.now() < tokenExpiresAt - 60000) return accessToken;
    return requestToken("");
  }

  async function driveFetch(url, options) {
    const token = await ensureToken();
    const headers = Object.assign({}, options && options.headers, { Authorization: "Bearer " + token });
    return fetch(url, Object.assign({}, options, { headers }));
  }

  // ---------- Drive REST calls (plain fetch, no gapi client needed) ----------
  async function searchFile() {
    const q = encodeURIComponent("name='" + DRIVE_FILENAME + "' and trashed=false");
    const resp = await driveFetch("https://www.googleapis.com/drive/v3/files?q=" + q + "&spaces=drive&fields=files(id,modifiedTime)");
    if (!resp.ok) throw new Error("Drive search failed: " + resp.status);
    const data = await resp.json();
    return (data.files && data.files[0]) || null;
  }

  async function createFile(state) {
    const boundary = "fintrack_" + Math.random().toString(36).slice(2);
    const metadata = { name: DRIVE_FILENAME, mimeType: "application/json" };
    const body =
      "--" + boundary + "\r\n" +
      "Content-Type: application/json; charset=UTF-8\r\n\r\n" +
      JSON.stringify(metadata) + "\r\n" +
      "--" + boundary + "\r\n" +
      "Content-Type: application/json\r\n\r\n" +
      JSON.stringify(state) + "\r\n" +
      "--" + boundary + "--";
    const resp = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,modifiedTime",
      { method: "POST", headers: { "Content-Type": "multipart/related; boundary=" + boundary }, body }
    );
    if (!resp.ok) throw new Error("Drive create failed: " + resp.status);
    return resp.json();
  }

  async function updateFile(id, state) {
    const resp = await driveFetch(
      "https://www.googleapis.com/upload/drive/v3/files/" + id + "?uploadType=media&fields=id,modifiedTime",
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(state) }
    );
    if (resp.status === 404) {
      fileId = null;
      safeRemove(FILE_ID_KEY);
      throw new Error("Drive file no longer exists");
    }
    if (!resp.ok) throw new Error("Drive update failed: " + resp.status);
    return resp.json();
  }

  async function getFileMetadata(id) {
    const resp = await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?fields=modifiedTime");
    if (!resp.ok) throw new Error("Drive metadata fetch failed: " + resp.status);
    return resp.json();
  }

  async function getFileContent(id) {
    const resp = await driveFetch("https://www.googleapis.com/drive/v3/files/" + id + "?alt=media");
    if (!resp.ok) throw new Error("Drive content fetch failed: " + resp.status);
    const text = await resp.text();
    try { return JSON.parse(text); } catch (e) { return null; }
  }

  async function pushNow() {
    const state = window.fintrack.getState();
    if (!fileId) {
      const created = await createFile(state);
      fileId = created.id;
      safeSet(FILE_ID_KEY, fileId);
      lastKnownRemoteModifiedTime = created.modifiedTime;
    } else {
      const updated = await updateFile(fileId, state);
      lastKnownRemoteModifiedTime = updated.modifiedTime;
    }
    lastSyncedRev = state._rev;
  }

  function adoptRemote(remoteState) {
    window.fintrack.setState(remoteState);
    window.fintrack.setExpanded(new Set());
    window.fintrack.renderAll();
    const updatedInput = document.getElementById("updatedInput");
    if (updatedInput) updatedInput.value = remoteState.updated || "";
    lastSyncedRev = remoteState._rev;
    window.fintrack.persist();
  }

  // ---------- debounced auto-save ----------
  function setStatus(text, cls) {
    const badge = document.getElementById("syncStatusBadge");
    if (!badge) return;
    badge.textContent = text || "";
    badge.className = "badge" + (cls ? " " + cls : "");
  }

  async function flush() {
    pendingPush = false;
    const state = window.fintrack.getState();
    try {
      await pushNow();
      setStatus("Synced", "ok");
    } catch (err) {
      // updateFile() clears fileId when Drive reports the file is gone; retry once as a create.
      if (!fileId) {
        try {
          await pushNow();
          setStatus("Synced", "ok");
          return;
        } catch (err2) { /* fall through */ }
      }
      setStatus("Offline — will sync when reconnected", "warn");
      pendingPush = true;
    }
  }

  function scheduleSync() {
    if (!signedIn) return;
    pendingPush = true;
    setStatus("Saving…", "");
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(flush, DEBOUNCE_MS);
  }

  function notifyChange() {
    if (signedIn) scheduleSync();
  }

  // ---------- conflict check on returning to the tab ----------
  async function checkForRemoteChanges() {
    if (!signedIn || !fileId) return;
    try {
      const meta = await getFileMetadata(fileId);
      if (meta.modifiedTime === lastKnownRemoteModifiedTime) return; // nothing changed remotely
      lastKnownRemoteModifiedTime = meta.modifiedTime;
      const remoteState = await getFileContent(fileId);
      const localState = window.fintrack.getState();
      if (!remoteState || remoteState._rev === localState._rev) return; // same content (or our own write)
      const useRemote = await window.fintrack.confirmDialog(
        "Portfolio changed elsewhere",
        "Your Google Drive copy changed since this tab last synced (likely edited on another device). Keep the changes on this device, or use the Google Drive version?",
        "Use Google Drive version", "Keep changes on this device", false
      );
      if (useRemote) {
        adoptRemote(remoteState);
        setStatus("Synced", "ok");
      } else {
        await pushNow();
        setStatus("Synced", "ok");
      }
    } catch (err) {
      // network hiccup — leave things as they are, next debounce/online event will retry
    }
  }

  // ---------- sign-in / sign-out ----------
  async function reconcileOnSignIn() {
    setStatus("Syncing…", "");
    try {
      const found = await searchFile();
      const localState = window.fintrack.getState();

      if (!found) {
        await pushNow();
        setStatus("Synced", "ok");
        return;
      }

      fileId = found.id;
      safeSet(FILE_ID_KEY, fileId);
      lastKnownRemoteModifiedTime = found.modifiedTime;
      const remoteState = await getFileContent(fileId);

      if (!remoteState || typeof remoteState !== "object") {
        await pushNow();
        setStatus("Synced", "ok");
        return;
      }

      const sameContent = remoteState._rev && localState._rev && remoteState._rev === localState._rev;
      const localIsPristine = !localState._rev;

      if (sameContent) {
        lastSyncedRev = localState._rev;
      } else if (localIsPristine) {
        adoptRemote(remoteState);
      } else {
        const useRemote = await window.fintrack.confirmDialog(
          "Existing data found on Google Drive",
          "You have portfolio data both on this device and in your connected Google Drive. Which would you like to keep?",
          "Use Google Drive", "Use this device", false
        );
        if (useRemote) adoptRemote(remoteState);
        else await pushNow();
      }
      setStatus("Synced", "ok");
    } catch (err) {
      setStatus("Offline — will sync when reconnected", "warn");
    }
  }

  function updateAccountUI() {
    const area = document.getElementById("accountArea");
    if (!area) return;
    if (isFileProtocol()) {
      area.innerHTML = '<button class="btn" id="btnGoogleSignIn" disabled title="Cloud sync needs the app hosted online — it can\'t sign in to Google from a local file">🔐 Sign in with Google</button>';
      return;
    }
    if (!signedIn) {
      area.innerHTML = '<button class="btn" id="btnGoogleSignIn">🔐 Sign in with Google</button>';
      document.getElementById("btnGoogleSignIn").addEventListener("click", () => signIn("consent"));
      return;
    }
    area.innerHTML =
      '<span class="badge" id="syncStatusBadge">Synced</span>' +
      '<button class="btn" id="btnGoogleSignOut" title="Sign out — your data stays on this device">Sign out</button>';
    document.getElementById("btnGoogleSignOut").addEventListener("click", signOut);
  }

  async function signIn(promptMode) {
    if (isFileProtocol()) {
      if (promptMode !== "") window.fintrack.toast("Cloud sync isn't available when opening this file directly — host it online to use it.");
      return;
    }
    if (!gisReady()) {
      if (promptMode !== "") window.fintrack.toast("Couldn't reach Google — check your connection and try again.");
      return;
    }
    initTokenClient();
    try {
      await requestToken(promptMode == null ? "consent" : promptMode);
    } catch (err) {
      if (promptMode !== "") window.fintrack.toast("Google sign-in failed or was cancelled.");
      return;
    }
    signedIn = true;
    safeSet(WAS_SIGNED_IN_KEY, "1");
    updateAccountUI();
    await reconcileOnSignIn();
  }

  function signOut() {
    if (accessToken && gisReady()) {
      google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    signedIn = false;
    clearTimeout(debounceTimer);
    safeRemove(WAS_SIGNED_IN_KEY);
    safeRemove(ACCESS_TOKEN_KEY);
    safeRemove(TOKEN_EXPIRES_KEY);
    updateAccountUI();
    window.fintrack.toast("Signed out of Google. Your data stays on this device from now on.");
  }

  async function init() {
    updateAccountUI();
    if (isFileProtocol()) return;

    const wasSignedIn = safeGet(WAS_SIGNED_IN_KEY) === "1";
    const hasValidCachedToken = accessToken && Date.now() < tokenExpiresAt - 60000;

    if (wasSignedIn && hasValidCachedToken) {
      // Reuse the token from a previous reload — no dialog, no waiting on Google's script.
      // It's only ever ~1hr old at most, so this keeps sync silent across reloads that
      // happen within that window; a fresh dialog is only unavoidable once it truly expires.
      signedIn = true;
      updateAccountUI();
      reconcileOnSignIn(); // don't block startup on this
    }

    await waitForGis(5000);
    if (!gisReady()) return; // offline or blocked — stay local-only, sign-in button will retry on click
    initTokenClient();

    if (wasSignedIn && !hasValidCachedToken) {
      await signIn(""); // token actually expired — Google's token client only offers the dialog UX, so this shows the account chooser once
    }

    window.addEventListener("online", () => { if (pendingPush && signedIn) flush(); });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden") {
        if (pendingPush) { clearTimeout(debounceTimer); flush(); }
      } else if (document.visibilityState === "visible" && signedIn) {
        checkForRemoteChanges();
      }
    });
  }

  window.driveSync = { init, signIn, signOut, notifyChange };
  document.addEventListener("DOMContentLoaded", init);
})();
