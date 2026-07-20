(() => {
  'use strict';

  const real = {
    session: null,
    profile: null,
    viewedProfile: null,
    profileResults: [],
    followedProfiles: [],
    connections: [],
    featured: [],
    browse: { twitch: { categories: [], live: [], clips: [] }, youtube: { categories: [], live: [], clips: [] }, kick: { categories: [], live: [], clips: [] }, rumble: { categories: [], live: [], clips: [] } },
    loginTicket: '',
    totpChallenge: '',
    stateTimer: null,
    settingsTimer: null,
    watchPending: 0,
    followingIds: new Set(),
    bootstrapped: false
  };

  function escapeHTML(value) {
    return String(value ?? '').replace(/[&<>'"]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character]);
  }

  function compact(value) {
    return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(Number(value) || 0);
  }

  function profileInitials(value) {
    return String(value || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 2).toUpperCase() || 'MS';
  }

  function avatarMarkup(item, className, forceInitials = false) {
    const name = item?.name || item?.displayName || item?.username || 'Multistreams';
    const useInitials = forceInitials || item?.platform === 'kick' || !item?.avatar;
    if (useInitials) return `<span class="${escapeHTML(className)} generated-profile-avatar" role="img" aria-label="${escapeHTML(name)}">${escapeHTML(profileInitials(name))}</span>`;
    return `<img class="${escapeHTML(className)}" src="${escapeHTML(item.avatar)}" alt="${escapeHTML(name)}" loading="lazy">`;
  }

  function hasViewerCount(item) {
    return Boolean(item?.live && item?.viewerCountAvailable !== false && item?.viewers !== null && item?.viewers !== undefined && item?.viewers !== '' && Number.isFinite(Number(item.viewers)));
  }

  window.renderPlatformAvatar = avatarMarkup;
  window.hasPlatformViewerCount = hasViewerCount;

  function elapsed(startedAt) {
    if (!startedAt) return 'Live';
    const seconds = Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return `${hours}:${String(minutes).padStart(2, '0')}`;
  }

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body && !headers.has('content-type')) headers.set('content-type', 'application/json');
    const response = await fetch(path, { credentials: 'include', ...options, headers });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) {
      const error = new Error(payload.error?.message || `Request failed (${response.status})`);
      error.status = response.status;
      error.code = payload.error?.code || 'request_failed';
      error.details = payload.error?.details;
      throw error;
    }
    return payload;
  }

  function notifyError(error, fallback = 'The request could not be completed.') {
    console.error(error);
    if (typeof showNotification === 'function') showNotification(error?.message || fallback, 'error', { force: true, position: 'bottom-right' });
  }

  function toLegacyProfile(profile, own = false) {
    if (!profile) return null;
    return {
      id: own ? 'me' : (profile.username || profile.id),
      backendId: profile.id,
      isOwn: own,
      username: profile.username || 'User',
      avatar: profile.avatarUrl || '../logos and assets/defualt_profile_pfp.png',
      banner: profile.bannerUrl || '../logos and assets/defualt_profile_banner.png',
      watchSeconds: Number(profile.watchSeconds) || 0,
      watchHours: (Number(profile.watchSeconds) || 0) / 3600,
      bio: profile.bio || '',
      socialLinks: profile.socials || {},
      layouts: (profile.layouts || []).map(layout => ({ ...layout, link: layout.link || buildLayoutLink(layout.channels || [], layout.layout) })),
      following: Boolean(profile.following),
      privacy: {
        visibility: profile.profileVisibility === 'hidden' ? 'hidden' : 'public',
        hideWatchBadges: Boolean(profile.hideWatchBadges),
        hideSocials: Boolean(profile.hideSocials),
        hideSharedLayouts: Boolean(profile.hideSharedLayouts),
        blockedUsers: profile.access?.reason === 'blocked' ? [String(settings?.username || '').toLowerCase()] : []
      },
      backendAccess: profile.access || { allowed: true, own, reason: '' }
    };
  }

  function buildLayoutLink(layoutChannels, layout) {
    const streams = (layoutChannels || []).map(channel => `${channel.platform}:${channel.name}`).join(',');
    return `${location.origin}/multistreams?streams=${encodeURIComponent(streams)}&layout=${encodeURIComponent(layout || 'grid')}`;
  }

  function applySession(payload) {
    real.session = payload;
    const user = payload?.user;
    const signedIn = Boolean(payload?.authenticated && user);
    accountState = {
      ...accountState,
      hasAccount: signedIn,
      signedIn,
      method: user?.authMethod || 'email',
      email: user?.email || '',
      username: user?.username || '',
      passwordHash: signedIn && user?.authMethod !== 'google' ? 'backend-managed' : '',
      passwordSalt: '',
      twoFactorEnabled: Boolean(user?.twoFactorEnabled),
      twoFactorSecret: '',
      googleConnected: user?.authMethod === 'google',
      googleEmail: user?.authMethod === 'google' ? user.email : '',
      devices: [],
      everSignedOut: !signedIn
    };
    if (signedIn) {
      settings.username = user.username;
      settings.profilePicture = user.avatarUrl;
      settings.bannerPicture = user.bannerUrl;
      settings.bio = user.bio || '';
      settings.profileVisibility = user.profileVisibility || 'public';
      settings.hideWatchBadges = Boolean(user.hideWatchBadges);
      settings.hideProfileSocials = Boolean(user.hideSocials);
      settings.hideSharedLayouts = Boolean(user.hideSharedLayouts);
      profileWatchSeconds = Number(user.watchSeconds) || 0;
    }
    updateAccountPrimaryAction?.();
    updateProfileUI?.();
    updateSecuritySettingsUI?.();
  }

  async function refreshSession() {
    const payload = await api('/api/auth/session');
    applySession(payload);
    real.connections = payload.connections || [];
    return payload;
  }

  async function loadRemoteProfile() {
    if (!accountState.signedIn) return;
    const payload = await api('/api/profile/me');
    real.profile = toLegacyProfile(payload.profile, true);
    real.viewedProfile = real.profile;
    settings.socialLinks = payload.profile.socials || {};
    profileSharedLayouts = real.profile.layouts || [];
    profileWatchSeconds = real.profile.watchSeconds;
    renderMyProfile?.();
  }

  async function loadRemoteSettings() {
    if (!accountState.signedIn) return;
    const payload = await api('/api/settings');
    settings = { ...settings, ...(payload.settings || {}), username: real.session.user.username };
    updateSettingsUI?.();
    applyAllSettings?.();
  }

  async function loadRemoteState() {
    if (!accountState.signedIn) return;
    const [statePayload, layoutPayload] = await Promise.all([api('/api/state'), api('/api/layouts')]);
    channels = (statePayload.state?.channels || []).map((channel, index) => ({ ...channel, id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2)}` }));
    currentLayout = statePayload.state?.layout || 'grid';
    savedLayouts = layoutPayload.layouts || [];
    renderStreams?.();
    renderChatOptions?.();
    updateChatVisibility?.();
    renderSavedLayouts?.();
  }

  async function loadConnectionsAndFollowing() {
    if (!accountState.signedIn) {
      mockFollowedData = [];
      const list = document.getElementById('followed-list');
      if (list) list.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:11px;line-height:1.45;">Sign in and connect Twitch or YouTube to see followed channels that are live.</div>';
      const liveCount = document.querySelector('.live-count');
      if (liveCount) liveCount.textContent = '0 Live';
      return;
    }
    const [connectionPayload, followingPayload] = await Promise.all([api('/api/platform/connections'), api('/api/following/live')]);
    real.connections = connectionPayload.connections || [];
    const followedStreams = followingPayload.streams || [];
    const nextFollowingIds = new Set(followedStreams.map(stream => `${stream.platform}:${stream.username || stream.name}`));
    if (real.followingIds.size && settings.liveNotificationsEnabled !== false) {
      followedStreams.filter(stream => !real.followingIds.has(`${stream.platform}:${stream.username || stream.name}`)).forEach(stream => {
        showLiveNotificationPopup?.({ username: stream.name || stream.username, title: stream.title || `${stream.name || stream.username} is now live`, avatar: stream.avatar || '', platform: stream.platform, category: stream.category || 'Live', viewers: compact(stream.viewers) });
      });
    }
    real.followingIds = nextFollowingIds;
    mockFollowedData = followedStreams.map(stream => ({
      name: stream.name || stream.username,
      platform: stream.platform,
      viewers: compact(stream.viewers),
      category: stream.category || 'Live',
      avatar: stream.avatar || `https://ui-avatars.com/api/?name=${encodeURIComponent(stream.name || stream.username)}&background=17202b&color=eff6ff`,
      realData: stream
    }));
    const liveCount = document.querySelector('.live-count');
    if (liveCount) liveCount.textContent = `${Number(followingPayload.liveCount) || 0} Live`;
    renderFollowedList?.();
    if (!followedStreams.length) {
      const list = document.getElementById('followed-list');
      if (list) list.innerHTML = `<div style="padding:12px;color:var(--text-muted);font-size:11px;line-height:1.45;">${real.connections.length ? 'None of your supported followed channels are live right now.' : 'Connect Twitch or YouTube to see followed channels that are live.'}</div>`;
    }
    updateConnectAccountStatuses?.();
    mockLiveStreamers = followedStreams.map(stream => ({ username: stream.name || stream.username, title: stream.title || '', avatar: stream.avatar || '', platform: stream.platform, category: stream.category || 'Live', viewers: compact(stream.viewers), timestamp: new Date().toISOString() }));
    calculateNotificationCounts?.();
  }

  function renderFeatured() {
    const sidebar = document.getElementById('featured-list');
    if (sidebar) {
      sidebar.innerHTML = real.featured.slice(0, 4).map(user => `
        <div class="followed-channel" data-featured-platform="${escapeHTML(user.platform)}" data-featured-name="${escapeHTML(user.username)}">
          ${avatarMarkup(user, 'followed-avatar')}
          <div class="followed-info"><div class="followed-name">${escapeHTML(user.name)}</div><div class="followed-category">${escapeHTML(user.live ? user.category : 'Offline')}</div></div>
          <div class="followed-viewers"><div class="dot" style="background:${getPlatformColor(user.platform)}"></div>${user.live ? compact(user.viewers) : 'Offline'}</div>
        </div>`).join('');
      sidebar.querySelectorAll('[data-featured-name]').forEach(card => card.addEventListener('click', () => addStream(card.dataset.featuredName, card.dataset.featuredPlatform)));
    }
    renderRealSuggested();
  }

  function renderRealSuggested() {
    const container = document.getElementById('empty-suggested');
    if (!container || !real.featured.length) return;
    const cards = Array.from({ length: Math.min(4, real.featured.length) }, (_, offset) => real.featured[(featuredRotationIndex + offset) % real.featured.length]);
    container.innerHTML = cards.map(user => `
      <div class="suggested-card featured-rotating-card">
        ${avatarMarkup(user, 'suggested-avatar')}<div class="suggested-name-row"><div class="name">${escapeHTML(user.name)}</div><span class="suggested-platform-icon" title="${escapeHTML(user.platform)}" aria-label="${escapeHTML(user.platform)}">${getPlatformIcon(user.platform)}</span></div>
        <div class="cat">${escapeHTML(user.live ? user.category : `${user.platform} channel`)}</div>
        <div class="viewers"><i class="fa-solid ${user.live ? 'fa-eye' : 'fa-circle'}" aria-hidden="true"></i>${user.live ? `${compact(user.viewers)} watching` : 'Offline'}</div>
        <button type="button" data-watch-name="${escapeHTML(user.username)}" data-watch-platform="${escapeHTML(user.platform)}">Watch Now</button>
      </div>`).join('');
    container.querySelectorAll('[data-watch-name]').forEach(button => button.addEventListener('click', () => addStream(button.dataset.watchName, button.dataset.watchPlatform)));
  }

  window.renderSuggested = renderRealSuggested;
  window.renderFeaturedList = renderFeatured;

  async function loadFeatured() {
    const payload = await api('/api/featured?limit=20');
    real.featured = payload.items || [];
    renderFeatured();
  }

  async function loadRewardData() {
    if (!accountState.signedIn) return;
    const [statusPayload, collectionPayload] = await Promise.all([api('/api/rewards/status'), api('/api/collectibles')]);
    const unlocked = (collectionPayload.cards || []).filter(card => card.unlocked);
    dailyRewardState = createEmptyDailyRewardState({}, unlocked.map(card => card.id));
    dailyRewardState.watchedSeconds = Number(statusPayload.status?.watchSeconds) || 0;
    DAILY_REWARD_CONFIG.developerMode = Boolean(statusPayload.status?.developerMode);
    dailyRewardState.claimed = Boolean(statusPayload.status?.nextClaimAt && new Date(statusPayload.status.nextClaimAt).getTime() > Date.now());
    dailyRewardState.claimedAt = statusPayload.status?.lastClaimedAt || null;
    updateDailyRewardUI?.();
    renderCollectiblesGrid?.();
  }

  async function bootstrap() {
    try {
      localStorage.removeItem(ACCOUNT_STORAGE_KEY);
      localStorage.removeItem('saved_layouts');
      localStorage.removeItem('profile_shared_layouts');
      localStorage.removeItem(PROFILE_FOLLOWED_USERS_KEY);
      localStorage.removeItem(DAILY_REWARD_STORAGE_KEY);
      localStorage.removeItem('multistream_state');
      localStorage.removeItem('multistream_settings');
      localStorage.removeItem('profile_watch_seconds');
      localStorage.removeItem('mockLiveStreamers');
      stopLiveNotificationSimulator?.();
      mockLiveStreamers = [];
      const session = await refreshSession();
      const jobs = [loadFeatured()];
      if (session.authenticated) jobs.push(loadRemoteProfile(), loadRemoteSettings(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData());
      else {
        channels = [];
        savedLayouts = [];
        profileWatchSeconds = 0;
        renderStreams?.();
        renderChatOptions?.();
        updateChatVisibility?.();
        jobs.push(loadConnectionsAndFollowing());
      }
      await Promise.allSettled(jobs);
      real.bootstrapped = true;
      const params = new URLSearchParams(location.search);
      if (params.get('status') === 'connected') showNotification(`${params.get('oauth') || 'Platform'} connected successfully`, 'saved', { position: 'bottom-right' });
      if (params.get('auth') === 'success') showNotification('Signed in successfully', 'saved', { position: 'bottom-right' });
      if (params.has('oauth') || params.has('auth') || params.has('status')) {
        params.delete('oauth'); params.delete('auth'); params.delete('status');
        history.replaceState({}, '', `${location.pathname}${params.toString() ? `?${params}` : ''}${location.hash}`);
      }
    } catch (error) {
      notifyError(error, 'The production backend could not be reached.');
    }
  }

  // Real account authentication.
  window.loadAccountState = () => {};
  window.saveAccountState = () => {};
  window.submitAccountSignup = async event => {
    event?.preventDefault();
    const errorElement = document.getElementById('account-signup-error');
    if (errorElement) errorElement.textContent = '';
    try {
      await api('/api/auth/signup', { method: 'POST', body: JSON.stringify({
        email: document.getElementById('account-signup-email')?.value || '',
        username: document.getElementById('account-signup-username')?.value || '',
        password: document.getElementById('account-signup-password')?.value || ''
      }) });
      closeAccountSignupModal(null, true);
      await refreshSession();
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData()]);
      showNotification('Your account is ready', 'saved', { position: 'bottom-right' });
    } catch (error) { if (errorElement) errorElement.textContent = error.message; }
  };

  window.submitAccountLogin = async event => {
    event?.preventDefault();
    const errorElement = document.getElementById('account-login-error');
    if (errorElement) errorElement.textContent = '';
    try {
      const payload = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({
        email: document.getElementById('account-login-email')?.value || '', password: document.getElementById('account-login-password')?.value || ''
      }) });
      if (payload.requiresTwoFactor) {
        real.loginTicket = payload.ticket;
        document.querySelector('#account-two-factor-modal .two-factor-otp-card')?.setAttribute('hidden', '');
        document.getElementById('account-two-factor-copy').textContent = 'Enter the current six-digit code from Google Authenticator or your compatible authenticator app.';
        closeAccountLoginModal(null, true);
        openAccountTwoFactorModal();
        return;
      }
      closeAccountLoginModal(null, true);
      await refreshSession();
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData()]);
      showNotification('Signed in successfully', 'saved', { position: 'bottom-right' });
    } catch (error) { if (errorElement) errorElement.textContent = error.message; }
  };

  window.verifyAccountTwoFactor = async event => {
    event?.preventDefault();
    const errorElement = document.getElementById('account-two-factor-error');
    try {
      await api('/api/auth/login/totp', { method: 'POST', body: JSON.stringify({ ticket: real.loginTicket, code: document.getElementById('account-two-factor-code')?.value || '' }) });
      real.loginTicket = '';
      closeAccountTwoFactorModal(null, true);
      await refreshSession();
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData()]);
      showNotification('Two-factor sign-in verified', 'saved', { position: 'bottom-right' });
    } catch (error) { if (errorElement) errorElement.textContent = error.message; }
  };

  window.startGoogleAccountFlow = () => { location.href = '/api/oauth/google/start?purpose=login&returnTo=/multistreams'; };

  window.toggleTwoFactorAuthentication = async enabled => {
    const toggle = document.getElementById('setting-two-factor');
    try {
      if (enabled) {
        const payload = await api('/api/security/totp/setup', { method: 'POST', body: '{}' });
        real.totpChallenge = payload.challengeId;
        const card = document.querySelector('#account-two-factor-setup-modal .two-factor-otp-card');
        if (card) card.innerHTML = `<span>Authenticator setup key</span><strong id="two-factor-setup-live-code" style="font-size:12px;letter-spacing:.08em;word-break:break-all;">${escapeHTML(payload.secret)}</strong>`;
        const intro = document.querySelector('#account-two-factor-setup-modal .account-auth-intro');
        if (intro) intro.textContent = 'In Google Authenticator, tap +, choose Enter a setup key, use Multistreams.tv as the account name, then enter this key and confirm the generated six-digit code.';
        openTwoFactorSetupModal();
      } else {
        const password = prompt('Enter your current password to disable two-factor authentication:') || '';
        await api('/api/security/totp', { method: 'DELETE', body: JSON.stringify({ password }) });
        accountState.twoFactorEnabled = false;
        updateSecuritySettingsUI();
        showNotification('Two-factor authentication disabled', 'settings', { position: 'bottom-right' });
      }
    } catch (error) { if (toggle) toggle.checked = !enabled; notifyError(error); }
  };

  window.confirmTwoFactorSetup = async event => {
    event?.preventDefault();
    const errorElement = document.getElementById('two-factor-setup-error');
    try {
      await api('/api/security/totp/verify', { method: 'POST', body: JSON.stringify({ challengeId: real.totpChallenge, code: document.getElementById('two-factor-setup-code')?.value || '' }) });
      accountState.twoFactorEnabled = true;
      real.totpChallenge = '';
      closeTwoFactorSetupModal(null, true);
      updateSecuritySettingsUI();
      showNotification('Two-factor authentication enabled', 'settings', { position: 'bottom-right' });
    } catch (error) { if (errorElement) errorElement.textContent = error.message; }
  };

  window.updateAccountSecurityDetails = async () => {
    if (!accountState.signedIn) return;
    const email = document.getElementById('security-email')?.value || accountState.email;
    const password = document.getElementById('security-password')?.value || '';
    if (email === accountState.email && !password) return;
    await api('/api/auth/account', { method: 'PATCH', body: JSON.stringify({ email, ...(password ? { password } : {}) }) });
    if (password) document.getElementById('security-password').value = '';
    await refreshSession();
  };

  async function optimizeProfileImage(file, type) {
    if (!file || file.type === 'image/gif' || file.size <= 700 * 1024) return file;
    try {
      const bitmap = await createImageBitmap(file);
      const bounds = type === 'banner' ? { width: 1600, height: 600 } : { width: 640, height: 640 };
      const scale = Math.min(1, bounds.width / bitmap.width, bounds.height / bitmap.height);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
      bitmap.close?.();
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', 0.84));
      if (!blob) return file;
      return new File([blob], `${type}.webp`, { type: 'image/webp', lastModified: Date.now() });
    } catch {
      return file;
    }
  }

  async function uploadProfileImage(event, type) {
    const selectedFile = event?.target?.files?.[0];
    if (!selectedFile) return;
    const form = new FormData();
    const file = await optimizeProfileImage(selectedFile, type);
    form.append('file', file);
    try {
      const response = await fetch(`/api/uploads/profile?type=${encodeURIComponent(type)}`, { method: 'POST', credentials: 'include', body: form });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error?.message || 'Image upload failed.');
      if (type === 'banner') settings.bannerPicture = payload.url; else settings.profilePicture = payload.url;
      await Promise.all([refreshSession(), loadRemoteProfile()]);
      updateProfileUI(); updateSettingsUI(); renderMyProfile();
      showNotification(`${type === 'banner' ? 'Banner' : 'Profile picture'} updated`, 'settings', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
    finally { if (event?.target) event.target.value = ''; }
  }
  window.handleProfilePicUpload = event => uploadProfileImage(event, 'avatar');
  window.handleProfileBannerUpload = event => uploadProfileImage(event, 'banner');

  const originalConfirmAccountAction = window.confirmAccountAction;
  window.confirmAccountAction = async () => {
    try {
      if (pendingAccountAction === 'signout') {
        await api('/api/auth/logout', { method: 'POST', body: '{}' });
        closeAccountActionModal(null, true);
        applySession({ authenticated: false, user: null });
        channels = []; savedLayouts = []; real.profile = null; real.viewedProfile = null;
        renderStreams(); renderChatOptions(); updateChatVisibility();
        showNotification('Signed out', 'info', { position: 'bottom-right' });
        return;
      }
      if (pendingAccountAction === 'delete') {
        const confirmation = prompt(`Type ${accountState.username} to permanently delete this account:`) || '';
        await api('/api/auth/account', { method: 'DELETE', body: JSON.stringify({ confirmation }) });
        closeAccountActionModal(null, true);
        applySession({ authenticated: false, user: null });
        channels = []; savedLayouts = [];
        renderStreams(); renderChatOptions(); updateChatVisibility();
        showNotification('Account deleted', 'deleted', { position: 'bottom-right' });
        return;
      }
      return originalConfirmAccountAction?.();
    } catch (error) { notifyError(error); }
  };

  // OAuth connections and provider status.
  async function finishRumbleConnection() {
    try {
      await api('/api/platform/rumble/connect', { method: 'POST', body: JSON.stringify({ popupConfirmed: true }) });
      await loadConnectionsAndFollowing();
      showNotification('Rumble account connected', 'saved', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  }

  window.connectAccount = async platformName => {
    if (!accountState.signedIn) { handleProfilePrimaryAction(); return; }
    const platform = String(platformName || '').toLowerCase();
    if (platform === 'rumble') {
      const popup = window.open('https://rumble.com/account/login', 'multistreams-rumble-connect', 'popup=yes,width=980,height=760,resizable=yes,scrollbars=yes');
      if (!popup) {
        showNotification('Allow the Rumble sign-in pop-up to connect your account', 'info', { position: 'bottom-right' });
        return;
      }
      showNotification('Sign in to Rumble, then close the pop-up to finish', 'info', { position: 'bottom-right' });
      const startedAt = Date.now();
      const watcher = setInterval(() => {
        if (popup.closed) {
          clearInterval(watcher);
          finishRumbleConnection();
        } else if (Date.now() - startedAt > 10 * 60_000) clearInterval(watcher);
      }, 700);
      return;
    }
    if (!['twitch', 'youtube', 'kick'].includes(platform)) return;
    location.href = `/api/oauth/${platform}/start?returnTo=/multistreams`;
  };

  window.updateConnectAccountStatuses = () => {
    for (const platform of ['twitch', 'youtube', 'kick', 'rumble']) {
      const element = document.getElementById(`${platform}-status`);
      if (!element) continue;
      const connected = real.connections.some(item => item.platform === platform);
      element.textContent = connected ? 'Connected' : 'Disconnected';
      element.style.color = connected ? '#22c55e' : '#ef4444';
    }
  };

  // Persisted settings, current state, and layouts.
  window.loadSettings = () => {};
  window.saveSettings = () => {
    if (!accountState.signedIn) return;
    clearTimeout(real.settingsTimer);
    real.settingsTimer = setTimeout(() => api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }) }).catch(notifyError), 350);
  };
  window.saveState = () => {
    if (!accountState.signedIn) return;
    clearTimeout(real.stateTimer);
    real.stateTimer = setTimeout(() => api('/api/state', { method: 'PUT', body: JSON.stringify({ channels, layout: currentLayout }) }).catch(notifyError), 350);
  };

  const originalSaveAndCloseSettings = window.saveAndCloseSettings;
  window.saveAndCloseSettings = async () => {
    try {
      applySettings?.();
      await Promise.all([
        api('/api/settings', { method: 'PUT', body: JSON.stringify({ settings }) }),
        api('/api/profile/me', { method: 'PATCH', body: JSON.stringify({
          username: settings.username, bio: settings.bio, avatarUrl: settings.profilePicture || '', bannerUrl: settings.bannerPicture || '',
          profileVisibility: settings.profileVisibility, hideWatchBadges: settings.hideWatchBadges,
          hideSocials: settings.hideProfileSocials, hideSharedLayouts: settings.hideSharedLayouts, socials: settings.socialLinks || {}
        }) }),
        updateAccountSecurityDetails()
      ]);
      closeSettingsModal(null, true);
      await Promise.all([refreshSession(), loadRemoteProfile()]);
      showNotification('Settings saved securely', 'settings', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

  window.saveCurrentLayout = async () => {
    const name = document.getElementById('layout-name-input')?.value.trim() || '';
    try {
      const payload = await api('/api/layouts', { method: 'POST', body: JSON.stringify({ name, channels, layout: currentLayout }) });
      savedLayouts.unshift(payload.layout);
      document.getElementById('layout-name-input').value = '';
      renderSavedLayouts();
      showNotification(`Saved “${name}” to Saved Layouts`, 'saved');
    } catch (error) { notifyError(error); }
  };
  window.deleteSavedLayout = async (event, index) => {
    event?.stopPropagation();
    const layout = savedLayouts[index];
    if (!layout) return;
    try { await api(`/api/layouts/${encodeURIComponent(layout.id)}`, { method: 'DELETE' }); savedLayouts.splice(index, 1); renderSavedLayouts(); showNotification(`Deleted “${layout.name}”`, 'deleted'); }
    catch (error) { notifyError(error); }
  };

  // Feedback and community layouts use server attribution/webhooks.
  window.sendFeedback = async () => {
    const message = document.getElementById('feedback-message')?.value.trim() || '';
    try {
      await api('/api/feedback', { method: 'POST', body: JSON.stringify({ message, category: selectedFeedbackCategory }) });
      document.getElementById('feedback-message').value = '';
      closeFeedbackModal(null, true);
      showNotification('Feedback sent successfully', 'feedback', { force: true, position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

  function renderRealCommunityLayouts(layouts) {
    const container = document.getElementById('community-layouts-list');
    if (!container) return;
    container.innerHTML = layouts.length ? layouts.map((layout, index) => `
      <div class="saved-layout-card" data-community-index="${index}" style="cursor:pointer;">
        <div class="saved-layout-info" style="flex:1;"><h4 style="margin-bottom:6px;">${escapeHTML(layout.name)}</h4>
          <div class="community-submitter-row"><img class="community-submitter-avatar" src="${escapeHTML(layout.submitterAvatar)}" alt="">
            <span>Submitted by:</span><button type="button" class="community-submitter-link" data-submitter="${escapeHTML(layout.submittedBy)}">${escapeHTML(layout.submittedBy)}</button></div>
          <div style="display:flex;gap:6px;flex-wrap:wrap;">${(layout.categories || []).map(category => `<span class="browse-tag">${escapeHTML(category)}</span>`).join('')}</div>
        </div><div style="font-size:12px;color:var(--text-muted);text-align:right;">${layout.streamCount} streams · ${escapeHTML(layout.layoutType)} layout</div>
      </div>`).join('') : '<div class="browse-empty"><div>No community layouts have been published yet.</div></div>';
    container.querySelectorAll('[data-community-index]').forEach(card => card.addEventListener('click', () => loadCommunityLayout(layouts[Number(card.dataset.communityIndex)])));
    container.querySelectorAll('[data-submitter]').forEach(button => button.addEventListener('click', event => { event.stopPropagation(); openCommunitySubmitterProfile(event, button.dataset.submitter); }));
  }

  window.openCommunityLayoutsModal = async () => {
    const modal = document.getElementById('community-layouts-modal');
    modal?.classList.add('active');
    try {
      const payload = await api('/api/community-layouts');
      real.communityLayouts = payload.layouts || [];
      const count = document.getElementById('community-layout-count'); if (count) count.textContent = `(${real.communityLayouts.length})`;
      renderRealCommunityLayouts(real.communityLayouts);
      const input = document.getElementById('community-search');
      if (input) input.oninput = () => renderRealCommunityLayouts(real.communityLayouts.filter(layout => `${layout.name} ${layout.submittedBy}`.toLowerCase().includes(input.value.trim().toLowerCase())));
    } catch (error) { notifyError(error); }
  };

  window.submitCommunityLayout = async () => {
    const name = document.getElementById('submit-layout-name')?.value.trim() || '';
    const link = document.getElementById('submit-layout-link')?.value.trim() || '';
    const parsed = link && typeof parseProfileLayoutLink === 'function' ? parseProfileLayoutLink(link) : null;
    const layoutChannels = parsed?.streams?.length ? parsed.streams : channels;
    try {
      await api('/api/community-layouts', { method: 'POST', body: JSON.stringify({ name, channels: layoutChannels, layout: parsed?.layout || currentLayout }) });
      closeSubmitLayoutModal(null, true);
      showNotification(`“${name}” was submitted to Community Layouts`, 'submitted');
    } catch (error) { notifyError(error); }
  };

  // Real global search.
  async function searchGlobal(query, platform) {
    try {
      const payload = await api(`/api/search/global?q=${encodeURIComponent(query)}&limit=20`);
      return (payload.items || []).filter(item => item.platform === platform).map(item => ({
        id: item.id, name: item.username || item.name, username: item.username, displayName: item.name, platform: item.platform,
        avatar: item.avatar, thumbnail: item.avatar, live: item.live, category: item.category, viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url
      }));
    } catch { return []; }
  }
  window.searchAllPlatforms = async query => {
    try {
      const payload = await api(`/api/search/global?q=${encodeURIComponent(query)}&limit=20`);
      const groups = { twitch: [], youtube: [], kick: [], rumble: [] };
      for (const item of payload.items || []) {
        if (!groups[item.platform]) continue;
        groups[item.platform].push({
          id: item.id, name: item.username || item.name, username: item.username, displayName: item.name,
          platform: item.platform, avatar: item.avatar, thumbnail: item.avatar, live: item.live,
          category: item.category, viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url
        });
      }
      return groups;
    } catch {
      return { twitch: [], youtube: [], kick: [], rumble: [] };
    }
  };
  window.searchTwitch = async (query, options = {}) => {
    if (options.broadcasterId) {
      try {
        const params = new URLSearchParams({ view: 'clips', broadcasterId: String(options.broadcasterId), limit: String(Number(options.limit) || 8) });
        const payload = await api(`/api/browse/twitch?${params}`);
        return (payload.items || []).map(item => ({ ...item, creator: item.creator || item.username, thumbnailUrl: item.thumbnail, creatorAvatarUrl: item.avatar, durationSeconds: item.duration }));
      } catch { return []; }
    }
    return searchGlobal(query, 'twitch');
  };
  const legacyYoutubeMedia = item => ({ ...item, creator: item.name || item.username, channelId: item.username, thumbnailUrl: item.thumbnail, creatorAvatarUrl: item.avatar, duration: item.durationSeconds });
  window.searchYouTube = async (query, options = {}) => {
    if (options.type === 'video') {
      const params = new URLSearchParams({ view: 'clips', limit: String(Number(options.limit) || 8) });
      if (query) params.set('q', query);
      if (options.channelId) params.set('channelId', String(options.channelId));
      const payload = await api(`/api/browse/youtube?${params}`);
      return (payload.items || []).map(legacyYoutubeMedia);
    }
    return searchGlobal(query, 'youtube');
  };
  window.fetchYouTubeMostPopularVideos = async limit => {
    try { const payload = await api(`/api/browse/youtube?view=clips&chart=mostPopular&limit=${Number(limit) || 8}`); return (payload.items || []).map(legacyYoutubeMedia); }
    catch { return []; }
  };
  window.searchKick = async query => {
    try { const payload = await api(`/api/channel/kick/${encodeURIComponent(query)}`); const item = payload.channel; return [{ id: item.id, name: item.username, username: item.username, displayName: item.name, platform: 'kick', avatar: '', live: item.live, category: item.category, viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url }]; }
    catch { return []; }
  };
  window.searchRumble = async (query, limit = 10) => {
    try { return (await api(`/api/third-party/rumble/search?q=${encodeURIComponent(query)}&limit=${Number(limit) || 10}`)).items || []; }
    catch { return []; }
  };
  window.getRumbleVideoInfo = async input => {
    try {
      const key = /^https?:\/\//i.test(input) ? 'url' : 'id';
      return (await api(`/api/third-party/rumble/video?${key}=${encodeURIComponent(input)}`)).data;
    } catch { return null; }
  };
  window.fetchTwitchUserProfiles = async (values, options = {}) => Promise.all((values || []).slice(0, 20).map(async value => {
    try { const payload = await api(`/api/channel/twitch/${encodeURIComponent(value)}`); return { id: payload.channel.id, login: payload.channel.username, display_name: payload.channel.name, profile_image_url: payload.channel.avatar, offline_image_url: payload.channel.banner, description: payload.channel.description }; }
    catch { return null; }
  })).then(items => items.filter(Boolean));
  window.fetchTwitchLiveStreams = async limit => (await api(`/api/browse/twitch?view=live&limit=${Number(limit) || 10}`)).items.map((item, index) => ({ ...item, rank: index + 1, status: 'Live now', description: item.title, avatarUrl: item.avatar, viewers: `${compact(item.viewers)} viewers` }));
  window.fetchTwitchLiveStreamByLogin = async login => {
    try { const payload = await api(`/api/channel/twitch/${encodeURIComponent(login)}`); const stream = payload.channel.stream; return stream ? { ...stream, game_name: stream.category, viewer_count: stream.viewers, user_login: stream.username } : null; }
    catch { return null; }
  };

  // Real browse directory.
  function browseLoading() {
    const content = document.getElementById('browse-content');
    if (content) content.innerHTML = '<div class="browse-empty"><div><span class="global-search-spinner" aria-hidden="true"></span><br>Loading live platform data…</div></div>';
  }
  async function fetchBrowse(view, categoryId = '') {
    const query = document.getElementById('browse-search')?.value.trim() || '';
    const params = new URLSearchParams({ view, limit: view === 'categories' ? '50' : '40' });
    if (query) params.set('q', query);
    if (categoryId) params.set('categoryId', categoryId);
    const payload = await api(`/api/browse/${currentBrowsePlatform}?${params}`);
    real.browse[currentBrowsePlatform][view] = payload.items || [];
    return payload.items || [];
  }
  window.getBrowseCategories = () => real.browse[currentBrowsePlatform]?.categories || [];
  window.getBrowseStreams = () => real.browse[currentBrowsePlatform]?.live || [];
  window.getBrowseClips = () => real.browse[currentBrowsePlatform]?.clips || [];
  window.loadBrowseCategories = async () => {
    const content = document.getElementById('browse-content'); if (!content) return;
    browseLoading();
    try {
      let items = await fetchBrowse('categories');
      items = sortBrowseItems(items.filter(item => !isBrowseCategoryHidden(item.name)));
      content.innerHTML = items.length ? `<div class="browse-section-label">Explore ${escapeHTML(currentBrowsePlatform)} categories</div><div class="browse-category-grid">${items.map(category => `
        <article class="browse-category-card" data-category-id="${escapeHTML(category.id)}" tabindex="0"><div class="browse-category-art">${category.image ? `<img src="${escapeHTML(category.image)}" alt="${escapeHTML(category.name)}" loading="lazy">` : `<div style="height:100%;display:grid;place-items:center;background:linear-gradient(145deg,#111827,#07111f);color:var(--accent);font-size:28px;">${getPlatformIcon(currentBrowsePlatform)}</div>`}</div>
        <div class="browse-category-name">${escapeHTML(category.name)}</div>${['kick', 'youtube'].includes(currentBrowsePlatform) ? '' : `<div class="browse-category-viewers">${compact(category.watching)} watching</div>`}</article>`).join('')}</div>` : renderBrowseEmpty('No real categories match this search.');
      content.querySelectorAll('[data-category-id]').forEach(card => card.addEventListener('click', () => { const category = items.find(item => String(item.id) === card.dataset.categoryId); if (category) selectCategory(category.name, category.image, category.id); }));
    } catch (error) { content.innerHTML = renderBrowseEmpty(error.message); }
  };
  window.loadBrowseLiveChannels = async () => {
    const content = document.getElementById('browse-content'); if (!content) return; browseLoading();
    try { const items = sortBrowseItems(await fetchBrowse('live')); content.innerHTML = `<div class="browse-section-label">Live on ${escapeHTML(currentBrowsePlatform)}</div>${renderBrowseLiveCards(items)}`; bindBrowseStreamCards(content); }
    catch (error) { content.innerHTML = renderBrowseEmpty(error.message); }
  };
  window.loadBrowseClips = async () => {
    const content = document.getElementById('browse-content'); if (!content) return; browseLoading();
    try { const items = sortBrowseItems(await fetchBrowse('clips')); content.innerHTML = `<div class="browse-section-label">Popular clips and videos on ${escapeHTML(currentBrowsePlatform)}</div>${renderBrowseClipCards(items.map(item => ({ ...item, username: item.username || item.name, daysAgo: Math.max(0, Math.floor((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 86400000)), duration: typeof item.duration === 'number' ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}` : item.duration, videoEmbed: item.embedUrl })))}`; bindBrowseClipCards(content); }
    catch (error) { content.innerHTML = renderBrowseEmpty(error.message); }
  };
  window.selectCategory = async (name, image, id) => {
    currentBrowseCategory = { id: id || getBrowseCategories().find(item => item.name === name)?.id || '', name, image, watching: getBrowseCategories().find(item => item.name === name)?.watching ?? null, followers: null, tags: [] };
    currentBrowseTab = 'category'; currentCategoryMedia = 'live';
    const search = document.getElementById('browse-search'); if (search) search.value = '';
    await renderBrowseCategoryDetail();
  };
  window.renderBrowseCategoryDetail = async () => {
    const content = document.getElementById('browse-content'); if (!content || !currentBrowseCategory) return; browseLoading();
    try {
      const view = currentCategoryMedia === 'clips' ? 'clips' : 'live';
      const items = sortBrowseItems(await fetchBrowse(view, currentBrowseCategory.id));
      const clips = items.map(item => ({ ...item, username: item.username || item.name, daysAgo: Math.max(0, Math.floor((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 86400000)), duration: typeof item.duration === 'number' ? `${Math.floor(item.duration / 60)}:${String(Math.floor(item.duration % 60)).padStart(2, '0')}` : item.duration, videoEmbed: item.embedUrl }));
      content.innerHTML = `<section class="category-detail"><div class="category-detail-top"><div class="category-detail-art">${currentBrowseCategory.image ? `<img src="${escapeHTML(currentBrowseCategory.image)}" alt="">` : ''}</div><div class="category-detail-info"><h2>${escapeHTML(currentBrowseCategory.name)}</h2><div class="category-detail-stats">${['kick', 'youtube'].includes(currentBrowsePlatform) ? '' : `<span>${compact(currentBrowseCategory.watching)} watching</span>`}<span>Live platform data</span></div></div><button class="category-back-button" onclick="returnToBrowseCategories()"><i class="fa-solid fa-arrow-left"></i> Categories</button></div>
        <div class="category-media-tabs"><button class="category-media-tab ${view === 'live' ? 'active' : ''}" onclick="switchCategoryMedia('live')">Livestreams</button><button class="category-media-tab ${view === 'clips' ? 'active' : ''}" onclick="switchCategoryMedia('clips')">Clips</button></div>
        <div class="category-results-heading"><span>${items.length} ${view === 'live' ? 'live channels' : 'clips'}</span><span>Real-time</span></div>${view === 'live' ? renderBrowseLiveCards(items) : renderBrowseClipCards(clips)}</section>`;
      if (view === 'live') bindBrowseStreamCards(content); else bindBrowseClipCards(content);
    } catch (error) { content.innerHTML = renderBrowseEmpty(error.message); }
  };

  // Stream creation and hover details use current provider data.
  async function resolveChannel(platform, name) {
    if (platform === 'rumble') return { platform, username: name, name: 'Rumble stream', title: '', category: 'Rumble', viewers: 0, live: true, url: name, avatar: '', banner: '', socials: [{ platform: 'rumble', url: name }] };
    const payload = await api(`/api/channel/${platform}/${encodeURIComponent(name)}`);
    return payload.channel;
  }
  window.createStream = async (name, displayName, platform, skipSave) => {
    try {
      const detail = await resolveChannel(platform, name);
      const directYoutubeVideo = platform === 'youtube' && /^[A-Za-z0-9_-]{11}$/.test(name);
      if (platform === 'youtube' && !directYoutubeVideo && !detail.stream?.id) throw new Error(`${detail.name || name} is not live on YouTube right now.`);
      const playerName = platform === 'youtube' ? (directYoutubeVideo ? name : detail.stream.id) : (detail.username || name.toLowerCase());
      const newStream = { id: `${Date.now()}${Math.random().toString(36).slice(2)}`, name: playerName, platform, muted: true, displayName: detail.name || displayName || name, viewers: detail.live ? compact(detail.viewers) : 'Offline', time: detail.live ? elapsed(detail.stream?.startedAt) : 'Offline', avatar: detail.avatar, banner: detail.banner, followers: detail.followers, category: detail.category, title: detail.title, url: detail.url, live: detail.live };
      channels.push(newStream); finishAddingStream(newStream, skipSave);
    } catch (error) { notifyError(error, `Could not load ${platform} channel data.`); }
  };
  window.createYouTubeStream = (name, displayName) => window.createStream(name, displayName, 'youtube', false);
  window.addStream = (nameInput, platformInput = 'twitch', skipSave = false) => {
    let value = String(nameInput || document.getElementById('channelInput')?.value || '').trim();
    let platform = String(platformInput || 'twitch').toLowerCase();
    if (!value) return;
    if (/twitch\.tv\//i.test(value)) { platform = 'twitch'; value = value.match(/twitch\.tv\/([^/?#]+)/i)?.[1] || value; }
    else if (/kick\.com\//i.test(value)) { platform = 'kick'; value = value.match(/kick\.com\/([^/?#]+)/i)?.[1] || value; }
    else if (/youtu(?:be\.com|\.be)/i.test(value)) { platform = 'youtube'; value = getYouTubeID(value) || value.match(/(?:@|channel\/)([^/?#]+)/i)?.[1] || value; }
    else if (/rumble\.com\//i.test(value)) { platform = 'rumble'; value = normalizeRumbleUrl(value); }
    if (channels.some(channel => channel.platform === platform && channel.name.toLowerCase() === value.toLowerCase())) return;
    window.createStream(value, value, platform, skipSave);
  };

  let streamHoverRequestToken = 0;
  let streamHoverCloseTimer = null;
  let activeStreamHoverTarget = null;
  window.hideStreamHoverCard = (immediate = false) => {
    streamHoverRequestToken += 1;
    clearTimeout(streamHoverCloseTimer);
    activeStreamHoverTarget = null;
    const card = document.getElementById('stream-hover-card');
    if (!card) return;
    if (immediate) { card.remove(); return; }
    card.classList.add('is-closing');
    streamHoverCloseTimer = setTimeout(() => card.remove(), 140);
  };

  window.showStreamHoverCard = async (stream, targetElement) => {
    hideStreamHoverCard(true);
    const requestToken = ++streamHoverRequestToken;
    activeStreamHoverTarget = targetElement;
    let detail;
    try { detail = await resolveChannel(stream.platform, stream.name); } catch { detail = { ...stream, name: stream.displayName, username: stream.name, live: stream.live, url: stream.url, socials: [] }; }
    if (requestToken !== streamHoverRequestToken || !targetElement?.isConnected || !targetElement.matches(':hover')) return;
    const card = document.createElement('div'); card.className = 'stream-hover-card'; card.id = 'stream-hover-card';
    const socialMarkup = (detail.socials || []).map(social => `<a href="${escapeHTML(social.url)}" target="_blank" rel="noopener" title="${escapeHTML(social.platform)}">${getPlatformIcon(social.platform)}</a>`).join('');
    card.innerHTML = `<div class="hover-banner" style="background-image:url('${String(detail.banner || '').replace(/['()]/g, '')}')"></div><div class="hover-pfp-wrapper">${avatarMarkup({ ...detail, platform: stream.platform }, 'hover-pfp')}${detail.live ? '<div class="hover-live-badge">LIVE</div>' : ''}</div>
      <div class="hover-content"><div class="hover-username">${escapeHTML(detail.name || stream.displayName)}</div>${detail.followers === null || detail.followers === undefined ? '' : `<div class="hover-followers">${compact(detail.followers)} Followers</div>`}
      <div class="hover-streaming">${detail.live ? `Streaming <span class="accent-text">${escapeHTML(detail.category || 'Live')}</span> with <span class="accent-text">${compact(detail.viewers)}</span> viewers` : 'Currently offline'}</div>
      <div class="hover-socials">${socialMarkup}</div><div class="hover-actions"><a class="hover-follow-btn" href="${escapeHTML(detail.url || '#')}" target="_blank" rel="noopener">Open Channel</a><button class="hover-report-btn" title="Report" onclick="openFeedbackModal?.()"><i class="fas fa-exclamation-triangle"></i></button></div></div>`;
    document.body.appendChild(card);
    const rect = targetElement.getBoundingClientRect();
    card.style.left = `${Math.min(window.innerWidth - 340, Math.max(10, rect.left + window.scrollX))}px`;
    card.style.top = `${rect.bottom + window.scrollY + 8}px`;
    card.style.display = 'block';
    card.addEventListener('mouseenter', () => clearTimeout(streamHoverCloseTimer));
    card.addEventListener('mouseleave', hideStreamHoverCard);
  };

  document.addEventListener('pointermove', event => {
    if (!activeStreamHoverTarget) return;
    const card = document.getElementById('stream-hover-card');
    if (activeStreamHoverTarget.contains(event.target) || card?.contains(event.target)) return;
    hideStreamHoverCard();
  }, true);

  // Server-backed profiles, follows, and privacy.
  window.getOwnProfileRecord = () => real.profile || toLegacyProfile(real.session?.user, true) || { id: 'me', isOwn: true, username: 'User' };
  window.getViewedProfileRecord = () => real.viewedProfile || getOwnProfileRecord();
  window.getSearchableProfiles = () => [getOwnProfileRecord(), ...real.profileResults];
  window.getProfileAccessState = profile => profile?.backendAccess || { allowed: true, reason: '' };
  window.renderProfileSearchResults = async query => {
    const results = document.getElementById('profile-search-results'); const input = document.getElementById('profile-directory-search-input');
    if (!results || !input || !String(query).trim()) { hideProfileSearchResults(); return; }
    results.innerHTML = '<div class="profile-search-empty"><span class="global-search-spinner"></span> Searching profiles…</div>'; results.classList.add('active');
    try {
      const payload = await api(`/api/profiles?q=${encodeURIComponent(query)}`);
      real.profileResults = (payload.profiles || []).map(profile => toLegacyProfile(profile, profile.id === real.session?.user?.id));
      results.innerHTML = real.profileResults.length ? real.profileResults.map(profile => `<button type="button" class="profile-search-result-card" data-profile-username="${escapeHTML(profile.username)}" style="background-image:url(&quot;${escapeHTML(profile.banner)}&quot;)"><img class="profile-search-result-avatar" src="${escapeHTML(profile.avatar)}" alt=""><span class="profile-search-result-copy"><strong>${escapeHTML(profile.username)}</strong><span>${profile.backendAccess?.allowed === false ? 'Private profile' : 'View profile'}</span></span></button>`).join('') : `<div class="profile-search-empty">No profiles found for “${escapeHTML(query)}”.</div>`;
      results.querySelectorAll('[data-profile-username]').forEach(button => button.addEventListener('click', () => viewProfile(button.dataset.profileUsername)));
      input.setAttribute('aria-expanded', 'true');
    } catch (error) { results.innerHTML = `<div class="profile-search-empty">${escapeHTML(error.message)}</div>`; }
  };
  window.viewProfile = async username => {
    try {
      if (username === 'me' || username === accountState.username) real.viewedProfile = real.profile;
      else { const payload = await api(`/api/profiles/${encodeURIComponent(username)}`); real.viewedProfile = toLegacyProfile(payload.profile, false); }
      viewedProfileId = real.viewedProfile?.id || 'me'; clearProfileSearch(); hideFollowedUsersPanel(); renderMyProfile();
    } catch (error) { notifyError(error); }
  };
  async function hydrateDirectProfilePath() {
    const match = location.pathname.match(/^\/profile\/([^/]+)\/?$/);
    if (!match) return;
    const username = decodeURIComponent(match[1]);
    document.querySelectorAll('.dropdown-menu').forEach(menu => menu.classList.remove('active'));
    document.getElementById('my-profile-modal')?.classList.add('active');
    await window.viewProfile(username);
    switchProfileTab?.('layouts');
    document.querySelector('#my-profile-modal .profile-modal-scroll')?.scrollTo({ top: 0 });
    document.title = `${username} | Multistreams.tv`;
  }
  window.openCommunitySubmitterProfile = async (event, username) => { event?.preventDefault(); event?.stopPropagation(); closeCommunityLayoutsModal(null, true); document.getElementById('my-profile-modal')?.classList.add('active'); await viewProfile(username); };
  window.toggleViewedProfileFollow = async () => {
    const profile = getViewedProfileRecord(); if (!profile || profile.isOwn) return;
    try {
      const method = profile.following ? 'DELETE' : 'PUT';
      const payload = await api(`/api/profiles/${encodeURIComponent(profile.username)}/follow`, { method });
      profile.following = payload.following; updateProfileFollowButton(profile); await loadFollowedProfiles();
    } catch (error) { notifyError(error); }
  };
  window.updateProfileFollowButton = profile => {
    const button = document.getElementById('profile-follow-button'); if (!button) return;
    if (!profile || profile.isOwn) { button.hidden = true; return; }
    button.hidden = false; button.classList.toggle('following', Boolean(profile.following)); button.innerHTML = `<i class="fa-solid ${profile.following ? 'fa-user-check' : 'fa-user-plus'}"></i><span>${profile.following ? 'Following' : 'Follow'}</span>`;
  };
  async function loadFollowedProfiles() {
    if (!accountState.signedIn) return;
    const payload = await api('/api/profiles/followed');
    real.followedProfiles = (payload.profiles || []).map(profile => toLegacyProfile(profile, false));
  }
  window.renderFollowedUsersPanel = async () => {
    const panel = document.getElementById('profile-followed-panel'); if (!panel) return;
    try { await loadFollowedProfiles(); panel.innerHTML = `<div class="profile-followed-heading"><span>Followed Users</span><span>${real.followedProfiles.length} followed</span></div>${real.followedProfiles.length ? `<div class="profile-followed-list">${real.followedProfiles.map(profile => `<button class="profile-followed-card" data-followed="${escapeHTML(profile.username)}"><img class="profile-followed-avatar" src="${escapeHTML(profile.avatar)}"><span class="profile-followed-copy"><strong>${escapeHTML(profile.username)}</strong><span>View profile</span></span><i class="fa-solid fa-chevron-right"></i></button>`).join('')}</div>` : '<div class="profile-followed-empty">No followed profiles yet.</div>'}`; panel.querySelectorAll('[data-followed]').forEach(button => button.addEventListener('click', () => viewProfile(button.dataset.followed))); }
    catch (error) { panel.innerHTML = `<div class="profile-followed-empty">${escapeHTML(error.message)}</div>`; }
  };

  // Backend Gemini proxy; the API key never reaches the browser.
  window.getAISearchAPIKey = () => 'backend-managed';
  window.requestAISearchModel = async (model, contents, _apiKey, includeGoogleSearch) => {
    const response = await fetch('/api/ai/search', { method: 'POST', credentials: 'include', headers: { 'content-type': 'application/json' }, signal: aiSearchAbortController?.signal, body: JSON.stringify({ model, contents, systemInstruction: AI_SEARCH_SYSTEM_PROMPT, googleSearch: includeGoogleSearch }) });
    const payload = await readAISearchAPIResponse(response);
    return { response, data: payload.data?.response || {}, errorText: payload.errorText };
  };

  // Backend daily rewards and watch time.
  window.saveDailyRewardState = () => {};
  window.claimDailyReward = async () => {
    if (rewardRolling || !accountState.signedIn) { if (!accountState.signedIn) handleProfilePrimaryAction(); return; }
    try {
      const payload = await api('/api/rewards/claim', { method: 'POST', body: '{}' });
      const card = getCollectibleCardById(payload.reward.id);
      const winner = createCollectibleReward(card);
      dailyRewardState.unlockedCardIds = Array.from(new Set([...(dailyRewardState.unlockedCardIds || []), payload.reward.id]));
      dailyRewardState.lastWon = payload.reward.rarity;
      dailyRewardState.lastWonCardId = payload.reward.id;
      dailyRewardState.claimed = !DAILY_REWARD_CONFIG.developerMode;
      dailyRewardState.claimedAt = DAILY_REWARD_CONFIG.developerMode ? null : new Date().toISOString();
      dailyRewardState.watchedSeconds = 0;
      syncDailyRewardInventory(dailyRewardState); rewardRolling = true; updateDailyRewardUI();
      animateDailyRewardCaseOpen(() => runDailyRewardReel(winner));
    } catch (error) { notifyError(error); updateDailyRewardUI(); }
  };
  setInterval(async () => {
    if (!accountState.signedIn || document.visibilityState !== 'visible' || !channels.some(channel => !channel.hidden)) return;
    try {
      const payload = await api('/api/watchtime', { method: 'POST', body: JSON.stringify({ seconds: 30 }) });
      dailyRewardState.watchedSeconds = Number(payload.status?.watchSeconds) || 0;
      updateDailyRewardUI();
    } catch {}
  }, 30_000);

  async function refreshActiveStreamData() {
    for (const stream of channels.filter(item => item.platform !== 'rumble')) {
      try {
        const detail = await resolveChannel(stream.platform, stream.name);
        stream.displayName = detail.name || stream.displayName;
        stream.viewers = detail.live ? compact(detail.viewers) : 'Offline';
        stream.time = detail.live ? elapsed(detail.stream?.startedAt) : 'Offline';
        stream.avatar = detail.avatar || stream.avatar;
        stream.banner = detail.banner || stream.banner;
        stream.followers = detail.followers;
        stream.category = detail.category || stream.category;
        stream.title = detail.title || stream.title;
        stream.live = detail.live;
        const frame = document.querySelector(`.stream-frame[data-id="${CSS.escape(stream.id)}"]`);
        if (frame) {
          const name = frame.querySelector('.pill-name'); if (name) name.textContent = stream.displayName;
          const stats = frame.querySelector('.pill-stats'); if (stats) stats.innerHTML = `<div class="dot"></div> ${escapeHTML(stream.viewers)}<div class="pill-divider"></div> ⏱ ${escapeHTML(stream.time)}`;
        }
      } catch {}
    }
  }
  setInterval(refreshActiveStreamData, 60_000);
  setInterval(() => { if (accountState.signedIn) loadConnectionsAndFollowing().catch(() => {}); }, 90_000);

  window.MS_API = { api, real, bootstrap, refreshSession, loadConnectionsAndFollowing, loadFeatured };
  hydrateDirectProfilePath().catch(error => notifyError(error, 'This profile could not be loaded.'));
  bootstrap();
})();
