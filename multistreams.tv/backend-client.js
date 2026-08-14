(() => {
  'use strict';

  const real = {
    session: null,
    profile: null,
    viewedProfile: null,
    profileResults: [],
    followedProfiles: [],
    blockedProfiles: [],
    blockedProfilesLoaded: false,
    notifications: [],
    notificationIds: new Set(),
    notificationsInitialized: false,
    conversations: [],
    activeConversation: null,
    activeConversationUsername: '',
    sidebarExpanded: { following: false, featured: false, categories: false },
    recommendedCategories: [],
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
    const useInitials = forceInitials || !item?.avatar;
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
      layouts: (profile.layouts || []).map(layout => ({ ...layout, link: layout.link || buildLayoutLink(layout.channels || [], layout.layout, layout.name) })),
      panels: Array.isArray(profile.panels) ? profile.panels : [],
      stats: profile.stats || { layouts: 0, followers: 0, following: 0 },
      connections: profile.connections || {},
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

  function buildLayoutLink(layoutChannels, layout, name = 'Shared Layout') {
    const url = new URL('/layout', location.origin);
    url.searchParams.set('streams', (layoutChannels || []).map(channel => `${channel.platform}:${channel.name}`).join(','));
    url.searchParams.set('layout', layout || 'grid');
    url.searchParams.set('name', name || 'Shared Layout');
    return url.toString();
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

  function describeDevice(userAgent) {
    const ua = String(userAgent || '');
    const browser = /Edg\//.test(ua) ? 'Microsoft Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Google Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Web Browser';
    const system = /Windows NT/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Unknown device';
    return `${browser} on ${system}`;
  }

  async function loadSecurityDevices() {
    if (!accountState.signedIn) {
      accountState.devices = [];
      renderSignedInDevices?.();
      return;
    }
    const payload = await api('/api/security/devices');
    accountState.devices = (payload.devices || []).map(device => ({
      id: device.id,
      name: describeDevice(device.user_agent),
      lastActive: device.last_seen_at || device.created_at,
      current: Boolean(device.current)
    }));
    renderSignedInDevices?.();
  }

  window.renderSignedInDevices = () => {
    const list = document.getElementById('security-device-list');
    if (!list) return;
    const devices = accountState.signedIn ? accountState.devices || [] : [];
    list.innerHTML = devices.length ? devices.map(device => `<div class="security-device-card"><span class="security-device-icon"><i class="fa-solid fa-laptop" aria-hidden="true"></i></span><span class="security-device-copy"><strong>${escapeHTML(device.name)}</strong><span>Active ${new Date(device.lastActive || Date.now()).toLocaleString()}</span></span>${device.current ? '<span class="security-current-badge">Current</span>' : ''}<button type="button" class="security-device-signout" data-device-signout="${escapeHTML(device.id)}">Sign Out</button></div>`).join('') : '<div class="privacy-blocked-empty">No signed-in devices to display.</div>';
    list.querySelectorAll('[data-device-signout]').forEach(button => button.addEventListener('click', () => window.signOutSecurityDevice(button.dataset.deviceSignout)));
  };

  window.signOutSecurityDevice = async deviceId => {
    try {
      const payload = await api(`/api/security/devices/${encodeURIComponent(deviceId)}`, { method: 'DELETE' });
      if (payload.current) {
        applySession({ authenticated: false, user: null });
        closeSettingsModal?.(null, true);
        channels = []; savedLayouts = [];
        renderStreams?.(); renderChatOptions?.(); updateChatVisibility?.();
        showNotification('Signed out of this device', 'info', { force: true, position: 'bottom-right' });
        return;
      }
      await loadSecurityDevices();
      showNotification('Device signed out', 'settings', { force: true, position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

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

  function renderBackendBlockedProfiles() {
    const list = document.getElementById('privacy-blocked-list');
    const count = document.getElementById('privacy-blocked-count');
    if (!list) return;
    const profiles = real.blockedProfiles || [];
    if (count) count.textContent = `${profiles.length} blocked`;
    list.innerHTML = profiles.length ? profiles.map(profile => `
      <div class="privacy-blocked-user">
        <img class="privacy-blocked-avatar" src="${escapeHTML(profile.avatarUrl || '/logos and assets/defualt_profile_pfp.png')}" alt="${escapeHTML(profile.username)}">
        <span class="privacy-blocked-copy"><strong>${escapeHTML(profile.username)}</strong><span>${escapeHTML(profile.bio || 'Blocked from viewing your profile')}</span></span>
        <button type="button" class="privacy-unblock-button" data-unblock-profile="${escapeHTML(profile.username)}"><i class="fa-solid fa-unlock" aria-hidden="true"></i>Unblock</button>
      </div>`).join('') : '<div class="privacy-blocked-empty">No profiles are currently blocked.</div>';
    list.querySelectorAll('[data-unblock-profile]').forEach(button => button.addEventListener('click', () => unblockPrivacyProfile(button.dataset.unblockProfile)));
  }

  async function loadBlockedProfiles() {
    if (!accountState.signedIn) {
      real.blockedProfiles = [];
      real.blockedProfilesLoaded = true;
      settings.blockedProfiles = [];
      renderBackendBlockedProfiles();
      return;
    }
    const payload = await api('/api/profiles/blocked');
    real.blockedProfiles = payload.profiles || [];
    real.blockedProfilesLoaded = true;
    settings.blockedProfiles = real.blockedProfiles.map(profile => String(profile.username || '').toLowerCase());
    renderBackendBlockedProfiles();
  }

  async function loadRemoteSettings() {
    if (!accountState.signedIn) return;
    const payload = await api('/api/settings');
    settings = { ...settings, ...(payload.settings || {}), username: real.session.user.username };
    if (real.blockedProfilesLoaded) settings.blockedProfiles = real.blockedProfiles.map(profile => String(profile.username || '').toLowerCase());
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
    const followingIdentity = stream => `${stream.platform}:${stream.id || stream.videoId || stream.username || stream.name}`;
    const nextFollowingIds = new Set(followedStreams.map(followingIdentity));
    const newlyLive = real.followingIds.size && settings.liveNotificationsEnabled !== false
      ? followedStreams.filter(stream => !real.followingIds.has(followingIdentity(stream)))
      : [];
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
    pruneDeletedLiveNotifications?.(followedStreams);
    const visibleFollowedStreams = followedStreams.filter(stream => !isLiveNotificationDismissed?.(stream));
    const persistedBackendLive = (mockLiveStreamers || []).filter(stream => stream.backendNotificationId);
    const activeLive = visibleFollowedStreams.map(stream => ({
      username: stream.name || stream.username,
      channelUsername: stream.username || stream.name,
      title: stream.title || '',
      avatar: stream.avatar || '',
      platform: stream.platform,
      id: stream.id || '',
      videoId: stream.platform === 'youtube' ? (stream.id || stream.videoId || '') : '',
      channelId: stream.channelId || '',
      category: stream.category || 'Live',
      viewers: hasViewerCount(stream) ? compact(stream.viewers) : 'LIVE',
      startedAt: stream.startedAt || '',
      createdAt: stream.notificationCreatedAt || stream.startedAt || new Date().toISOString()
    }));
    const mergedLive = new Map();
    [...activeLive, ...persistedBackendLive].forEach(stream => {
      const key = liveNotificationIdentity?.(stream)?.key || followingIdentity(stream);
      if (!isLiveNotificationDismissed?.(stream) && !mergedLive.has(key)) mergedLive.set(key, stream);
    });
    mockLiveStreamers = [...mergedLive.values()].sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
    saveLiveNotifications?.();
    newlyLive.filter(stream => !isLiveNotificationDismissed?.(stream)).forEach(stream => {
      showLiveNotificationPopup?.({
        username: stream.name || stream.username,
        channelUsername: stream.username || stream.name,
        title: stream.title || `${stream.name || stream.username} is now live`,
        avatar: stream.avatar || '',
        platform: stream.platform,
        id: stream.id || '',
        videoId: stream.platform === 'youtube' ? (stream.id || stream.videoId || '') : '',
        channelId: stream.channelId || '',
        category: stream.category || 'Live',
        viewers: hasViewerCount(stream) ? compact(stream.viewers) : 'LIVE',
        startedAt: stream.startedAt || '',
        createdAt: new Date().toISOString()
      });
    });
    calculateNotificationCounts?.();
  }

  function sortSidebarItems(items, valueOf) {
    return [...(items || [])].sort((a, b) => {
      const difference = Number(valueOf(a) || 0) - Number(valueOf(b) || 0);
      return sortDesc ? -difference : difference;
    });
  }

  function balanceSidebarPlatforms(items, valueOf) {
    const sorted = sortSidebarItems(items, valueOf);
    const preferredOrder = ['twitch', 'youtube', 'kick', 'rumble'];
    const groups = new Map(preferredOrder.map(platform => [platform, sorted.filter(item => item.platform === platform)]));
    sorted.forEach(item => { if (!groups.has(item.platform)) groups.set(item.platform, sorted.filter(candidate => candidate.platform === item.platform)); });
    const balanced = [];
    while (balanced.length < sorted.length) {
      let added = false;
      groups.forEach(group => {
        const item = group.shift();
        if (!item) return;
        balanced.push(item);
        added = true;
      });
      if (!added) break;
    }
    return balanced;
  }

  function updateSidebarSortButton() {
    const button = document.getElementById('sidebar-sort-toggle');
    if (!button) return;
    const nextLabel = sortDesc ? 'Sort least to most viewers' : 'Sort most to least viewers';
    button.title = nextLabel;
    button.setAttribute('aria-label', nextLabel);
    button.setAttribute('aria-pressed', String(!sortDesc));
  }

  function renderFeatured() {
    updateSidebarSortButton();
    const sortedFeatured = balanceSidebarPlatforms(real.featured, item => item.viewers);
    const sidebar = document.getElementById('featured-list');
    if (sidebar) {
      const shown = real.sidebarExpanded.featured ? sortedFeatured : sortedFeatured.slice(0, 6);
      sidebar.innerHTML = shown.map(user => `
        <div class="followed-channel" data-featured-platform="${escapeHTML(user.platform)}" data-featured-name="${escapeHTML(user.username)}">
          ${avatarMarkup(user, 'followed-avatar')}
          <div class="followed-info"><div class="followed-name">${escapeHTML(user.name)}</div><div class="followed-category">${escapeHTML(user.category || 'Live')}</div></div>
          <div class="followed-viewers"><div class="dot" style="background:${getPlatformColor(user.platform)}"></div>${hasViewerCount(user) ? compact(user.viewers) : 'LIVE'}</div>
        </div>`).join('');
      sidebar.querySelectorAll('[data-featured-name]').forEach(card => card.addEventListener('click', () => addStream(card.dataset.featuredName, card.dataset.featuredPlatform)));
    }
    const toggle = document.getElementById('featured-show-toggle');
    if (toggle) { toggle.hidden = real.featured.length <= 6; toggle.textContent = real.sidebarExpanded.featured ? 'Show Less' : 'Show More'; }
    renderRecommendedCategories();
    renderRealSuggested();
  }

  function renderRecommendedCategories() {
    const container = document.getElementById('recommended-category-list');
    if (!container) return;
    const sortedCategories = sortSidebarItems(real.recommendedCategories, item => item.watching);
    const shown = real.sidebarExpanded.categories ? sortedCategories : sortedCategories.slice(0, 6);
    container.innerHTML = shown.map(category => `<div class="recommended-category" data-category-id="${escapeHTML(category.id)}"><img src="${escapeHTML(category.image || '')}" alt=""><span class="recommended-category-copy"><strong>${escapeHTML(category.name)}</strong><span>${Number(category.liveChannels || 0)} live channels</span></span><span class="recommended-category-viewers">${compact(category.watching)}</span></div>`).join('');
    container.querySelectorAll('[data-category-id]').forEach(card => card.addEventListener('click', () => {
      const category = real.recommendedCategories.find(item => String(item.id) === String(card.dataset.categoryId));
      openClipsModal?.();
      if (category) setTimeout(() => selectCategory?.(category.name, category.image, category.id), 40);
    }));
    const toggle = document.getElementById('categories-show-toggle');
    if (toggle) { toggle.hidden = real.recommendedCategories.length <= 6; toggle.textContent = real.sidebarExpanded.categories ? 'Show Less' : 'Show More'; }
  }

  function renderRealSuggested() {
    const container = document.getElementById('empty-suggested');
    if (!container || !real.featured.length) return;
    const sortedFeatured = balanceSidebarPlatforms(real.featured, item => item.viewers);
    const cards = Array.from({ length: Math.min(4, sortedFeatured.length) }, (_, offset) => sortedFeatured[(featuredRotationIndex + offset) % sortedFeatured.length]);
    container.innerHTML = cards.map(user => `
      <div class="suggested-card featured-rotating-card">
        ${avatarMarkup(user, 'suggested-avatar')}<div class="suggested-name-row"><div class="name" title="${escapeHTML(user.name)}">${escapeHTML(user.name)}</div><span class="suggested-platform-icon" title="${escapeHTML(user.platform)}" aria-label="${escapeHTML(user.platform)}">${getPlatformIcon(user.platform)}</span></div>
        <div class="cat">${escapeHTML(user.live ? user.category : `${user.platform} channel`)}</div>
        <div class="viewers"><i class="fa-solid ${user.live ? 'fa-eye' : 'fa-circle'}" aria-hidden="true"></i>${user.live ? `${compact(user.viewers)} watching` : 'Offline'}</div>
        <button type="button" data-watch-name="${escapeHTML(user.username)}" data-watch-platform="${escapeHTML(user.platform)}">Watch Now</button>
      </div>`).join('');
    container.querySelectorAll('[data-watch-name]').forEach(button => button.addEventListener('click', () => addStream(button.dataset.watchName, button.dataset.watchPlatform)));
  }

  window.renderSuggested = renderRealSuggested;
  window.renderFeaturedList = renderFeatured;

  async function loadFeatured() {
    const [payload, categories] = await Promise.all([api('/api/featured?limit=20'), api('/api/browse/twitch?view=categories&limit=30')]);
    real.featured = (payload.items || []).filter(item => item.live);
    real.recommendedCategories = (categories.items || []).sort((a, b) => Number(b.watching || 0) - Number(a.watching || 0));
    renderFeatured();
  }

  window.toggleSidebarSection = section => {
    if (!(section in real.sidebarExpanded)) return;
    real.sidebarExpanded[section] = !real.sidebarExpanded[section];
    if (section === 'following') renderFollowedList?.();
    else renderFeatured();
  };

  window.renderFollowedList = () => {
    const list = document.getElementById('followed-list');
    if (!list) return;
    updateSidebarSortButton();
    const sorted = sortSidebarItems(mockFollowedData, item => item.realData?.viewers);
    const shown = real.sidebarExpanded.following ? sorted : sorted.slice(0, 6);
    list.innerHTML = shown.map(user => `<div class="followed-channel" data-followed-platform="${escapeHTML(user.platform)}" data-followed-name="${escapeHTML(user.name)}">${avatarMarkup({ ...user.realData, name: user.name, avatar: user.avatar }, 'followed-avatar')}<div class="followed-info"><div class="followed-name">${escapeHTML(user.name)}</div><div class="followed-category">${escapeHTML(user.category || 'Live')}</div></div><div class="followed-viewers"><div class="dot" style="background:${getPlatformColor(user.platform)}"></div>${hasViewerCount(user.realData) ? compact(user.realData.viewers) : 'LIVE'}</div></div>`).join('');
    list.querySelectorAll('[data-followed-name]').forEach(card => card.addEventListener('click', () => toggleStream(card.dataset.followedName, card.dataset.followedPlatform)));
    const toggle = document.getElementById('followed-show-toggle');
    if (toggle) { toggle.hidden = sorted.length <= 6; toggle.textContent = real.sidebarExpanded.following ? 'Show Less' : 'Show More'; }
  };

  window.toggleSort = () => {
    sortDesc = !sortDesc;
    window.renderFollowedList();
    renderFeatured();
  };

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
      const oauthRelayParams = new URLSearchParams(location.search);
      if (location.pathname === '/multistreams'
        && oauthRelayParams.get('state')
        && (oauthRelayParams.get('code') || oauthRelayParams.get('error'))
        && !oauthRelayParams.get('oauth')) {
        location.replace(`/api/oauth/twitch/callback?${oauthRelayParams.toString()}`);
        return;
      }
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
      const incomingSharedLayout = typeof parseProfileLayoutLink === 'function'
        ? parseProfileLayoutLink(location.href)
        : null;
      const jobs = [loadFeatured()];
      if (session.authenticated) {
        jobs.push(
          loadRemoteProfile(),
          loadRemoteSettings(),
          loadBlockedProfiles(),
          loadConnectionsAndFollowing(),
          loadRewardData(),
          loadSecurityDevices(),
          loadBackendNotifications()
        );
        if (!incomingSharedLayout?.streams?.length) jobs.push(loadRemoteState());
      }
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
      const sharedLayout = incomingSharedLayout;
      if (sharedLayout?.streams?.length) {
        applyLoadedLayout({ name: sharedLayout.name || 'Shared Layout', streams: sharedLayout.streams, layout: sharedLayout.layout, source: 'Shared link' });
      }
      if (params.get('auth') === 'two-factor' && params.get('ticket')) {
        real.loginTicket = params.get('ticket');
        document.querySelector('#account-two-factor-modal .two-factor-otp-card')?.setAttribute('hidden', '');
        const copy = document.getElementById('account-two-factor-copy');
        if (copy) copy.textContent = 'Google sign-in was verified. Enter the current six-digit code from your authenticator app to finish signing in.';
        openAccountTwoFactorModal?.();
      }
      if (params.get('status') === 'connected') showNotification(`${params.get('oauth') || 'Platform'} connected successfully`, 'saved', { position: 'bottom-right' });
      if (params.get('auth') === 'success') showNotification('Signed in successfully', 'saved', { position: 'bottom-right' });
      if (params.has('oauth') || params.has('auth') || params.has('status')) {
        params.delete('oauth'); params.delete('auth'); params.delete('status'); params.delete('ticket');
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
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadBlockedProfiles(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData(), loadSecurityDevices(), loadBackendNotifications()]);
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
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadBlockedProfiles(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData(), loadSecurityDevices(), loadBackendNotifications()]);
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
      await Promise.all([loadRemoteProfile(), loadRemoteSettings(), loadBlockedProfiles(), loadRemoteState(), loadConnectionsAndFollowing(), loadRewardData(), loadSecurityDevices(), loadBackendNotifications()]);
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
    if (platform === 'youtube') {
      location.href = '/api/oauth/google/start?purpose=youtube-connect&returnTo=/multistreams';
      return;
    }
    if (!['twitch', 'kick'].includes(platform)) return;
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

  window.addProfileSharedLayout = async () => {
    const nameInput = document.getElementById('profile-layout-name-input');
    const linkInput = document.getElementById('profile-layout-link-input');
    const name = nameInput?.value.trim() || '';
    const parsed = parseProfileLayoutLink(linkInput?.value.trim() || '');
    if (!name) {
      nameInput?.setCustomValidity('Enter a layout name.');
      nameInput?.reportValidity();
      nameInput?.addEventListener('input', () => nameInput.setCustomValidity(''), { once: true });
      return;
    }
    if (!parsed?.streams?.length) {
      linkInput?.setCustomValidity('Enter a valid Multistreams layout share link.');
      linkInput?.reportValidity();
      linkInput?.addEventListener('input', () => linkInput.setCustomValidity(''), { once: true });
      return;
    }
    try {
      await api('/api/community-layouts', { method: 'POST', body: JSON.stringify({ name, channels: parsed.streams, layout: parsed.layout }) });
      await loadRemoteProfile();
      renderProfileSharedLayouts(real.profile);
      closeProfileLayoutAddModal(null, true);
      showNotification(`Added “${name}” to your profile`, 'saved', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

  window.removeProfileSharedLayout = async (event, layoutId) => {
    event?.stopPropagation();
    const layout = real.profile?.layouts?.find(item => item.id === layoutId);
    try {
      await api(`/api/community-layouts/${encodeURIComponent(layoutId)}`, { method: 'DELETE' });
      real.communityLayouts = real.communityLayouts.filter(item => item.id !== layoutId);
      await loadRemoteProfile();
      renderProfileSharedLayouts(real.profile);
      renderRealCommunityLayouts(real.communityLayouts);
      showNotification(`Removed “${layout?.name || 'layout'}” from your profile and Community Layouts`, 'deleted', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

  // Real global search.
  async function searchGlobal(query, platform) {
    try {
      const payload = await api(`/api/search/global?q=${encodeURIComponent(query)}&limit=20`);
      return (payload.items || []).filter(item => item.platform === platform).map(item => ({
        id: item.id, name: item.username || item.name, username: item.username, displayName: item.name, platform: item.platform,
        avatar: item.avatar, thumbnail: item.avatar, live: item.live, category: item.category, title: item.title || '',
        viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url
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
          category: item.category, title: item.title || '', viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url
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
    try { const payload = await api(`/api/channel/kick/${encodeURIComponent(query)}`); const item = payload.channel; return [{ id: item.id, name: item.username, username: item.username, displayName: item.name, platform: 'kick', avatar: item.avatar || '', live: item.live, category: item.category, title: item.title || '', viewers: item.viewers ?? null, viewerCountAvailable: item.viewerCountAvailable, url: item.url }]; }
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
  function browseMediaDuration(item) {
    const value = item?.duration ?? item?.durationSeconds;
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
      const total = Math.floor(value);
      const hours = Math.floor(total / 3600);
      const minutes = Math.floor((total % 3600) / 60);
      const seconds = String(total % 60).padStart(2, '0');
      return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}` : `${minutes}:${seconds}`;
    }
    return typeof value === 'string' && value !== 'undefined' ? value : '';
  }

  window.loadBrowseClips = async () => {
    const content = document.getElementById('browse-content'); if (!content) return; browseLoading();
    try { const items = sortBrowseItems(await fetchBrowse('clips')); content.innerHTML = `<div class="browse-section-label">Popular clips and videos on ${escapeHTML(currentBrowsePlatform)}</div>${renderBrowseClipCards(items.map(item => ({ ...item, username: item.username || item.name, daysAgo: Math.max(0, Math.floor((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 86400000)), duration: browseMediaDuration(item), videoEmbed: item.embedUrl })))}`; bindBrowseClipCards(content); }
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
      const clips = items.map(item => ({ ...item, username: item.username || item.name, daysAgo: Math.max(0, Math.floor((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 86400000)), duration: browseMediaDuration(item), videoEmbed: item.embedUrl }));
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
      const videoId = platform === 'youtube' ? (directYoutubeVideo ? name : detail.stream?.id || '') : '';
      const playerName = platform === 'youtube'
        ? (videoId || detail.id || detail.username || name)
        : (detail.username || name.toLowerCase());
      const viewerCountAvailable = hasViewerCount(detail);
      const newStream = {
        id: `${Date.now()}${Math.random().toString(36).slice(2)}`,
        name: playerName,
        platform,
        muted: true,
        displayName: detail.name || displayName || name,
        viewers: detail.live ? (viewerCountAvailable ? compact(detail.viewers) : 'LIVE') : 'Offline',
        viewerCountAvailable,
        time: detail.live ? elapsed(detail.stream?.startedAt) : 'Offline',
        avatar: detail.avatar || '',
        banner: detail.banner || '',
        followers: detail.followers,
        category: detail.category,
        title: detail.title,
        url: detail.url,
        live: detail.live,
        videoId,
        channelId: platform === 'youtube' ? detail.id || '' : ''
      };
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

  function streamHoverCardMarkup(detail, stream) {
    const socialMarkup = (detail.socials || []).map(social => `<a href="${escapeHTML(social.url)}" target="_blank" rel="noopener" title="${escapeHTML(social.platform)}">${getPlatformIcon(social.platform)}</a>`).join('');
    const liveSummary = hasViewerCount(detail)
      ? `Streaming <span class="accent-text">${escapeHTML(detail.category || 'Live')}</span> with <span class="accent-text">${compact(detail.viewers)}</span> viewers`
      : `Streaming <span class="accent-text">${escapeHTML(detail.category || 'Live')}</span> <span class="accent-text">&middot; LIVE</span>`;
    return `<div class="hover-banner" style="background-image:url('${String(detail.banner || '').replace(/['()]/g, '')}')"></div><div class="hover-pfp-wrapper">${avatarMarkup({ ...detail, platform: stream.platform }, 'hover-pfp')}${detail.live ? '<div class="hover-live-badge">LIVE</div>' : ''}</div>
      <div class="hover-content"><div class="hover-username">${escapeHTML(detail.name || stream.displayName || stream.name)}</div>${detail.followers === null || detail.followers === undefined ? '' : `<div class="hover-followers">${compact(detail.followers)} Followers</div>`}
      <div class="hover-streaming">${detail.live ? liveSummary : 'Currently offline'}</div>
      <div class="hover-socials">${socialMarkup}</div><div class="hover-actions"><a class="hover-follow-btn" href="${escapeHTML(detail.url || '#')}" target="_blank" rel="noopener">Open Channel</a><button class="hover-report-btn" title="Report" onclick="openFeedbackModal?.()"><i class="fas fa-exclamation-triangle"></i></button></div></div>`;
  }

  function positionStreamHoverCard(card, targetElement) {
    const rect = targetElement.getBoundingClientRect();
    const cardHeight = card.offsetHeight || 300;
    const cardWidth = card.offsetWidth || 320;
    const spaceBelow = window.innerHeight - rect.bottom;
    const showAbove = spaceBelow < cardHeight + 4 && rect.top > spaceBelow;
    const requestedTop = showAbove ? rect.top - cardHeight + 2 : rect.bottom - 2;
    card.classList.toggle('flipped-above', showAbove);
    card.style.left = `${Math.min(window.innerWidth - cardWidth - 10, Math.max(10, rect.left))}px`;
    card.style.top = `${Math.max(10, Math.min(window.innerHeight - cardHeight - 10, requestedTop))}px`;
  }

  window.showStreamHoverCard = (stream, targetElement) => {
    hideStreamHoverCard(true);
    const requestToken = ++streamHoverRequestToken;
    activeStreamHoverTarget = targetElement;
    const card = document.createElement('div'); card.className = 'stream-hover-card'; card.id = 'stream-hover-card';
    const initialDetail = { ...stream, name: stream.displayName || stream.name, username: stream.name, live: stream.live !== false, url: stream.url, socials: [] };
    card.innerHTML = streamHoverCardMarkup(initialDetail, stream);
    document.body.appendChild(card);
    card.style.display = 'block';
    card.style.position = 'fixed';
    positionStreamHoverCard(card, targetElement);
    card.addEventListener('mouseenter', () => clearTimeout(streamHoverCloseTimer));
    card.addEventListener('mouseleave', hideStreamHoverCard);
    void resolveChannel(stream.platform, stream.name).then(detail => {
      if (requestToken !== streamHoverRequestToken || !card.isConnected || !targetElement?.isConnected) return;
      card.innerHTML = streamHoverCardMarkup(detail, stream);
      positionStreamHoverCard(card, targetElement);
    }).catch(() => {});
  };

  document.addEventListener('pointermove', event => {
    if (!activeStreamHoverTarget) return;
    const card = document.getElementById('stream-hover-card');
    if (activeStreamHoverTarget.contains(event.target) || card?.contains(event.target)) return;
    clearTimeout(streamHoverCloseTimer);
    streamHoverCloseTimer = setTimeout(() => hideStreamHoverCard(), 220);
  }, true);

  // Server-backed profiles, follows, and privacy.
  window.getOwnProfileRecord = () => real.profile || toLegacyProfile(real.session?.user, true) || { id: 'me', isOwn: true, username: 'User' };
  window.getViewedProfileRecord = () => real.viewedProfile || getOwnProfileRecord();
  window.getSearchableProfiles = () => [getOwnProfileRecord(), ...real.profileResults];
  window.getProfileAccessState = profile => profile?.backendAccess || { allowed: true, reason: '' };
  window.renderBlockedProfilesList = renderBackendBlockedProfiles;

  let privacyBlockSearchTimer = null;
  let privacyBlockSearchToken = 0;
  function hidePrivacyBlockSearchResults() {
    clearTimeout(privacyBlockSearchTimer);
    privacyBlockSearchToken += 1;
    document.getElementById('privacy-block-search-results')?.classList.remove('active');
    document.getElementById('privacy-block-search-shell')?.classList.remove('is-loading');
    document.getElementById('privacy-block-username')?.setAttribute('aria-expanded', 'false');
  }
  window.searchPrivacyBlockProfiles = query => {
    const value = String(query || '').trim();
    const results = document.getElementById('privacy-block-search-results');
    const shell = document.getElementById('privacy-block-search-shell');
    const input = document.getElementById('privacy-block-username');
    clearTimeout(privacyBlockSearchTimer);
    if (!results || !shell || !input) return;
    if (!accountState.signedIn) {
      results.innerHTML = '<div class="privacy-block-search-empty">Sign in to search for and block profiles.</div>';
      results.classList.add('active');
      input.setAttribute('aria-expanded', 'true');
      return;
    }
    if (value.length < 2) {
      results.innerHTML = '<div class="privacy-block-search-empty">Enter at least two characters to search profiles.</div>';
      results.classList.toggle('active', Boolean(value));
      input.setAttribute('aria-expanded', value ? 'true' : 'false');
      shell.classList.remove('is-loading');
      return;
    }
    shell.classList.add('is-loading');
    results.innerHTML = '<div class="privacy-block-search-empty">Searching profiles…</div>';
    results.classList.add('active');
    input.setAttribute('aria-expanded', 'true');
    const token = ++privacyBlockSearchToken;
    privacyBlockSearchTimer = setTimeout(async () => {
      try {
        const payload = await api(`/api/profiles?q=${encodeURIComponent(value)}`);
        if (token !== privacyBlockSearchToken) return;
        const ownUsername = String(real.session?.user?.username || '').toLowerCase();
        const blocked = new Set(real.blockedProfiles.map(profile => String(profile.username || '').toLowerCase()));
        const profiles = (payload.profiles || []).filter(profile => {
          const username = String(profile.username || '').toLowerCase();
          return username && username !== ownUsername && !blocked.has(username);
        });
        results.innerHTML = profiles.length ? profiles.map(profile => `
          <button type="button" class="privacy-block-search-card" data-block-profile="${escapeHTML(profile.username)}" role="option" style="background-image:url(&quot;${escapeHTML(profile.bannerUrl || '/logos and assets/defualt_profile_banner.png')}&quot;)">
            <img class="privacy-blocked-avatar" src="${escapeHTML(profile.avatarUrl || '/logos and assets/defualt_profile_pfp.png')}" alt="">
            <span class="privacy-blocked-copy"><strong>${escapeHTML(profile.username)}</strong><span>${profile.access?.allowed === false ? 'Private profile · click to block' : 'Profile found · click to block'}</span></span>
            <i class="fa-solid fa-ban privacy-block-search-action" aria-hidden="true"></i>
          </button>`).join('') : `<div class="privacy-block-search-empty">No available profiles found for “${escapeHTML(value)}”.</div>`;
        results.querySelectorAll('[data-block-profile]').forEach(button => button.addEventListener('click', () => blockPrivacyProfile(button.dataset.blockProfile)));
      } catch (error) {
        if (token === privacyBlockSearchToken) results.innerHTML = `<div class="privacy-block-search-empty">${escapeHTML(error.message)}</div>`;
      } finally {
        if (token === privacyBlockSearchToken) shell.classList.remove('is-loading');
      }
    }, 240);
  };
  window.blockPrivacyProfile = async username => {
    if (!accountState.signedIn) { handleProfilePrimaryAction(); return; }
    try {
      await api(`/api/profiles/${encodeURIComponent(username)}/block`, { method: 'PUT' });
      const input = document.getElementById('privacy-block-username');
      if (input) input.value = '';
      hidePrivacyBlockSearchResults();
      await loadBlockedProfiles();
      renderMyProfile?.();
      showNotification(`${username} was blocked`, 'settings', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };
  window.blockProfileFromPrivacy = () => {
    const first = document.querySelector('#privacy-block-search-results [data-block-profile]');
    if (first) blockPrivacyProfile(first.dataset.blockProfile);
  };
  window.unblockPrivacyProfile = async username => {
    if (!accountState.signedIn) return;
    try {
      await api(`/api/profiles/${encodeURIComponent(username)}/block`, { method: 'DELETE' });
      await loadBlockedProfiles();
      renderMyProfile?.();
      showNotification(`${username} was unblocked`, 'settings', { position: 'bottom-right' });
    } catch (error) { notifyError(error); }
  };

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
      const wasFollowing = Boolean(profile.following);
      const method = wasFollowing ? 'DELETE' : 'PUT';
      const payload = await api(`/api/profiles/${encodeURIComponent(profile.username)}/follow`, { method });
      profile.following = payload.following; profile.stats = payload.stats || profile.stats;
      if (real.profile?.stats) real.profile.stats.following = Math.max(0, Number(real.profile.stats.following || 0) + (payload.following ? 1 : -1));
      updateProfileFollowButton(profile); enhanceProfileUI(); await loadFollowedProfiles();
      showNotification(`${payload.following ? 'Now following' : 'Unfollowed'} ${profile.username}`, 'follow', { title: payload.following ? 'Profile followed' : 'Profile unfollowed', position: 'bottom-left' });
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

  async function loadBackendNotifications({ announce = false } = {}) {
    if (!accountState.signedIn) {
      real.notifications = [];
      messageNotificationCount = 0;
      updateNotificationBadge?.();
      return;
    }
    const payload = await api('/api/notifications');
    const incoming = (payload.notifications || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    const unseenUnread = incoming.filter(item => !item.readAt && !real.notificationIds.has(item.id));
    if (unseenUnread.length) {
      notificationsMarkedAsRead = false;
      localStorage.setItem('notificationsMarkedAsRead', 'false');
    }
    if (announce && real.notificationsInitialized) {
      for (const item of unseenUnread) {
        if (item.type === 'message') showNotification(`${item.metadata?.senderUsername || 'Someone'}: ${item.message}`, 'message', { title: 'New private message', position: 'bottom-left' });
        if (item.type === 'follow') showNotification(`${item.metadata?.followerUsername || 'Someone'} followed you`, 'follow', { title: 'New follower', position: 'bottom-left' });
      }
    }
    real.notifications = incoming;
    real.notificationIds = new Set(incoming.map(item => item.id));
    real.notificationsInitialized = true;
    messageNotificationCount = incoming.filter(item => item.type === 'message' && !item.readAt).length;
    const backendLive = incoming.filter(item => item.type === 'live').map(item => ({
      username: item.metadata?.name || item.metadata?.username || 'YouTube creator',
      channelUsername: item.metadata?.username || item.metadata?.channelId || '',
      title: item.metadata?.title || item.message || 'Live now',
      avatar: item.metadata?.avatar || '', thumbnail: item.metadata?.thumbnail || '',
      platform: item.metadata?.platform || 'youtube', id: item.metadata?.videoId || '', videoId: item.metadata?.videoId || '',
      channelId: item.metadata?.channelId || '',
      viewers: Number.isFinite(Number(item.metadata?.viewers)) ? compact(item.metadata.viewers) : 'LIVE',
      startedAt: item.metadata?.startedAt || '', createdAt: item.createdAt, backendNotificationId: item.id
    })).filter(item => !isLiveNotificationDismissed?.(item));
    const activeLive = (mockLiveStreamers || []).filter(item => !item.backendNotificationId);
    const mergedLive = new Map();
    [...backendLive, ...activeLive].forEach(item => {
      const key = liveNotificationIdentity?.(item)?.key || `${item.platform}:${item.videoId || item.channelUsername}`;
      if (!mergedLive.has(key)) mergedLive.set(key, item);
    });
    mockLiveStreamers = [...mergedLive.values()].sort((a, b) => new Date(b.createdAt || b.startedAt || 0) - new Date(a.createdAt || a.startedAt || 0));
    saveLiveNotifications?.();
    calculateNotificationCounts?.();
    updateNotificationBadge?.();
    if (document.getElementById('notificationsMenu')?.classList.contains('active') && document.getElementById('tab-messages')?.style.color?.includes('accent')) window.renderMessageNotifications?.(document.getElementById('notification-content'));
  }

  window.markBackendNotificationsRead = async () => {
    try { await api('/api/notifications/read', { method: 'POST', body: '{}' }); await loadBackendNotifications(); }
    catch (error) { console.error(error); }
  };

  window.deleteBackendNotification = async notificationId => {
    if (!notificationId) return;
    try { await api(`/api/notifications/${encodeURIComponent(notificationId)}`, { method: 'DELETE' }); }
    catch (error) { console.error(error); }
  };

  window.renderMessageNotifications = container => {
    if (!container) return;
    const messages = real.notifications.filter(item => item.type === 'message');
    messageNotificationCount = messages.filter(item => !item.readAt).length;
    updateNotificationBadge?.();
    container.innerHTML = messages.length ? messages.map(item => `<article class="notification-card-hover notification-menu-card ${item.readAt ? '' : 'is-unread'}" data-message-notification="${escapeHTML(item.id)}" data-message-user="${escapeHTML(item.metadata?.senderUsername || '')}"><img class="notification-menu-icon" src="${escapeHTML(item.metadata?.senderAvatarUrl || '/logos and assets/defualt_profile_pfp.png')}" alt=""><div class="notification-menu-copy"><strong>${escapeHTML(item.metadata?.senderUsername || 'Multistreams user')}</strong><p>${escapeHTML(item.message)}</p><small style="display:block;margin-top:6px;color:var(--text-muted);font-size:9px;">${new Date(item.createdAt).toLocaleString()}</small></div><span class="notification-relative-time">${formatRelativeNotificationTime(item.createdAt)}</span><button class="notification-close-btn" type="button" data-delete-message-notification="${escapeHTML(item.id)}" aria-label="Delete message notification">✕</button></article>`).join('') : '<div style="padding:40px 20px;text-align:center;color:var(--text-muted);font-size:14px;">No message notifications yet.</div>';
    container.querySelectorAll('[data-message-notification]').forEach(card => card.addEventListener('click', event => {
      if (event.target.closest('[data-delete-message-notification]')) return;
      openPrivateConversation(card.dataset.messageUser);
    }));
    container.querySelectorAll('[data-delete-message-notification]').forEach(button => button.addEventListener('click', async event => {
      event.stopPropagation();
      try { await api(`/api/notifications/${encodeURIComponent(button.dataset.deleteMessageNotification)}`, { method: 'DELETE' }); await loadBackendNotifications(); window.renderMessageNotifications(container); }
      catch (error) { notifyError(error); }
    }));
  };

  function renderPrivateMessages(messages) {
    const history = document.getElementById('private-message-history');
    if (!history) return;
    history.innerHTML = messages.length ? messages.map(message => `<div class="private-message-bubble ${message.outgoing ? 'outgoing' : ''}"><p>${escapeHTML(message.body)}</p><time datetime="${escapeHTML(message.createdAt)}">${new Date(message.createdAt).toLocaleString()}</time></div>`).join('') : '<div class="profile-followed-empty" style="margin:auto;">No messages yet. Start the conversation.</div>';
    history.scrollTop = history.scrollHeight;
  }

  window.openPrivateConversation = async username => {
    if (!accountState.signedIn || !username) return;
    try {
      document.getElementById('notificationsMenu')?.classList.remove('active');
      document.getElementById('private-message-modal')?.classList.add('active');
      document.getElementById('private-message-history').innerHTML = '<div class="service-status-loading"><span class="global-search-spinner"></span>Loading messages…</div>';
      const payload = await api(`/api/messages/${encodeURIComponent(username)}`);
      real.activeConversation = payload.conversation;
      real.activeConversationUsername = payload.conversation.user.username;
      document.getElementById('private-message-title').textContent = payload.conversation.user.username;
      document.getElementById('private-message-avatar').src = payload.conversation.user.avatarUrl || '/logos and assets/defualt_profile_pfp.png';
      renderPrivateMessages(payload.messages || []);
      await loadBackendNotifications();
      document.getElementById('private-message-input')?.focus();
    } catch (error) { closePrivateMessageModal?.(null, true); notifyError(error); }
  };

  window.openViewedProfileConversation = () => {
    const profile = getViewedProfileRecord();
    if (profile && !profile.isOwn) window.openPrivateConversation(profile.username);
  };

  window.closePrivateMessageModal = (event, force = false) => {
    const modal = document.getElementById('private-message-modal');
    if (!modal || (!force && event?.target !== modal)) return;
    modal.classList.remove('active');
    real.activeConversation = null;
    real.activeConversationUsername = '';
  };

  window.sendPrivateMessage = async event => {
    event?.preventDefault();
    const input = document.getElementById('private-message-input');
    const message = input?.value.trim() || '';
    if (!message || !real.activeConversationUsername) return;
    try {
      input.disabled = true;
      await api(`/api/messages/${encodeURIComponent(real.activeConversationUsername)}`, { method: 'POST', body: JSON.stringify({ message }) });
      input.value = '';
      const payload = await api(`/api/messages/${encodeURIComponent(real.activeConversationUsername)}`);
      renderPrivateMessages(payload.messages || []);
    } catch (error) { notifyError(error); }
    finally { input.disabled = false; input.focus(); }
  };

  document.addEventListener('pointerdown', event => {
    const shell = document.getElementById('privacy-block-search-shell');
    if (shell && !shell.contains(event.target)) hidePrivacyBlockSearchResults();
  }, true);

  function renderProfileAbout(profile) {
    const summary = document.getElementById('profile-about-summary');
    const panelContainer = document.getElementById('profile-about-panels');
    if (!summary || !panelContainer || !profile) return;
    const socials = Object.entries(profile.socialLinks || {});
    summary.innerHTML = `<h3>About ${escapeHTML(profile.username)} <span style="color:#4ade80;font-size:10px;">${Number(profile.stats?.followers || 0).toLocaleString()} followers</span></h3><p>${escapeHTML(profile.bio || 'This user has not added a bio yet.')}</p>${socials.length ? `<div class="profile-about-socials">${socials.map(([platform, url]) => `<a href="${escapeHTML(url)}" target="_blank" rel="noopener noreferrer"><span class="profile-about-social-icon" aria-hidden="true">${getPlatformIcon(String(platform).toLowerCase())}</span><span>${escapeHTML(platform)}</span></a>`).join('')}</div>` : ''}`;
    const owns = Boolean(profile.isOwn);
    document.getElementById('profile-add-panel-button').hidden = !owns;
    const items = profile.panels || [];
    panelContainer.innerHTML = items.length ? items.map(panel => `<article class="profile-about-panel" draggable="${owns}" data-profile-panel="${escapeHTML(panel.id)}">${panel.imageUrl ? `<img src="${escapeHTML(panel.imageUrl)}" alt="">` : ''}${owns ? `<button class="profile-about-panel-edit" type="button" data-edit-panel="${escapeHTML(panel.id)}" aria-label="Edit panel"><i class="fa-solid fa-pen"></i></button>` : ''}<div class="profile-about-panel-copy"><h4>${escapeHTML(panel.title || 'About')}</h4>${panel.description ? `<p>${escapeHTML(panel.description)}</p>` : ''}${panel.url ? `<a href="${escapeHTML(panel.url)}" target="_blank" rel="noopener noreferrer" style="display:inline-block;margin-top:8px;color:var(--accent);font-size:9px;">Visit link <i class="fa-solid fa-arrow-up-right-from-square"></i></a>` : ''}</div></article>`).join('') : `<button class="profile-about-panel" type="button" ${owns ? 'onclick="openProfilePanelEditor()"' : 'disabled'} style="display:grid;place-items:center;width:100%;color:var(--text-muted);font-size:28px;cursor:${owns ? 'pointer' : 'default'};">${owns ? '+' : '<span style="font-size:10px;">No about panels yet.</span>'}</button>`;
    panelContainer.querySelectorAll('[data-edit-panel]').forEach(button => button.addEventListener('click', () => openProfilePanelEditor(button.dataset.editPanel)));
    if (owns) bindProfilePanelReorder(panelContainer);
  }

  function bindProfilePanelReorder(container) {
    let dragged = null;
    container.querySelectorAll('[data-profile-panel]').forEach(card => {
      card.addEventListener('dragstart', () => { dragged = card; card.style.opacity = '.45'; });
      card.addEventListener('dragend', async () => {
        card.style.opacity = '';
        const ids = [...container.querySelectorAll('[data-profile-panel]')].map(item => item.dataset.profilePanel);
        try { const payload = await api('/api/profile/panels/reorder', { method: 'PUT', body: JSON.stringify({ ids }) }); real.profile.panels = payload.panels || []; }
        catch (error) { notifyError(error); }
      });
      card.addEventListener('dragover', event => { event.preventDefault(); if (dragged && dragged !== card) container.insertBefore(dragged, card); });
    });
  }

  function enhanceProfileUI() {
    const profile = getViewedProfileRecord();
    if (!profile) return;
    const stats = profile.stats || { layouts: profile.layouts?.length || 0, followers: 0, following: 0 };
    const statRoot = document.getElementById('my-profile-stats');
    if (statRoot) statRoot.innerHTML = `<button type="button" data-profile-stat="layouts"><strong>${Number(stats.layouts || 0).toLocaleString()}</strong> layouts</button><button type="button" onclick="openProfileUserList('followers')"><strong>${Number(stats.followers || 0).toLocaleString()}</strong> followers</button><button type="button" onclick="openProfileUserList('following')"><strong>${Number(stats.following || 0).toLocaleString()}</strong> following</button>`;
    const allowed = profile.backendAccess?.allowed !== false;
    const messageButton = document.getElementById('profile-message-button');
    if (messageButton) messageButton.hidden = profile.isOwn || !allowed;
    const moreButton = document.getElementById('profile-more-toggle');
    if (moreButton) moreButton.hidden = profile.isOwn || !allowed;
    const clipsConnected = Boolean(profile.connections?.twitch);
    const videosConnected = Boolean(profile.connections?.youtube);
    document.getElementById('profile-tab-clips').hidden = !clipsConnected;
    document.getElementById('profile-tab-videos').hidden = !videosConnected;
    renderProfileAbout(profile);
  }

  const baseRenderMyProfile = window.renderMyProfile;
  window.renderMyProfile = (...args) => { const value = baseRenderMyProfile?.(...args); enhanceProfileUI(); return value; };

  window.switchProfileTab = tab => {
    const profile = getViewedProfileRecord();
    const allowed = new Set(['layouts', 'badges', 'about']);
    if (profile?.connections?.twitch) allowed.add('clips');
    if (profile?.connections?.youtube) allowed.add('videos');
    activeProfileTab = allowed.has(tab) ? tab : 'layouts';
    for (const name of ['layouts', 'badges', 'clips', 'videos', 'about']) {
      document.getElementById(`profile-tab-${name}`)?.classList.toggle('active', activeProfileTab === name);
      document.getElementById(`profile-content-${name}`)?.classList.toggle('active', activeProfileTab === name);
    }
    if (activeProfileTab === 'clips' || activeProfileTab === 'videos') loadProfileMedia(activeProfileTab);
    if (activeProfileTab === 'about') renderProfileAbout(profile);
  };

  async function loadProfileMedia(type) {
    const profile = getViewedProfileRecord();
    const container = document.getElementById(type === 'clips' ? 'profile-clips-grid' : 'profile-videos-grid');
    if (!profile || !container) return;
    container.innerHTML = '<div class="service-status-loading" style="grid-column:1/-1"><span class="global-search-spinner"></span>Loading real media…</div>';
    try {
      const payload = await api(`/api/profiles/${encodeURIComponent(profile.username)}/${type}`);
      const items = (payload.items || []).map(item => ({ ...item, username: item.username || item.name, daysAgo: Math.max(0, Math.floor((Date.now() - new Date(item.createdAt || Date.now()).getTime()) / 86400000)), duration: browseMediaDuration(item), videoEmbed: item.embedUrl }));
      container.innerHTML = items.length ? renderBrowseClipCards(items) : `<div class="profile-followed-empty" style="grid-column:1/-1">No ${type} are available right now.</div>`;
      bindBrowseClipCards(container);
    } catch (error) { container.innerHTML = `<div class="profile-followed-empty" style="grid-column:1/-1">${escapeHTML(error.message)}</div>`; }
  }

  window.openProfileUserList = async type => {
    const profile = getViewedProfileRecord();
    if (!profile) return;
    const modal = document.getElementById('profile-user-list-modal');
    const list = document.getElementById('profile-user-list');
    document.getElementById('profile-user-list-title').textContent = type === 'followers' ? 'Followers' : 'Following';
    const titleIcon = document.getElementById('profile-user-list-icon');
    if (titleIcon) titleIcon.className = `fa-solid ${type === 'followers' ? 'fa-user-group' : 'fa-user-check'}`;
    modal.classList.add('active');
    list.innerHTML = '<div class="service-status-loading"><span class="global-search-spinner"></span>Loading users…</div>';
    try {
      const payload = await api(`/api/profiles/${encodeURIComponent(profile.username)}/${type}`);
      list.innerHTML = payload.profiles.length ? payload.profiles.map(user => `<button class="profile-user-list-card" data-profile-user="${escapeHTML(user.username)}"><img src="${escapeHTML(user.avatarUrl)}" alt=""><strong>${escapeHTML(user.username)}</strong></button>`).join('') : `<div class="profile-followed-empty">No ${type} yet.</div>`;
      list.querySelectorAll('[data-profile-user]').forEach(button => button.addEventListener('click', async () => { closeProfileUserList(null, true); await viewProfile(button.dataset.profileUser); }));
    } catch (error) { list.innerHTML = `<div class="profile-followed-empty">${escapeHTML(error.message)}</div>`; }
  };
  window.closeProfileUserList = (event, force = false) => { const modal = document.getElementById('profile-user-list-modal'); if (modal && (force || event?.target === modal)) modal.classList.remove('active'); };

  window.toggleProfileMoreMenu = event => { event?.stopPropagation(); const menu = document.getElementById('profile-more-menu'); const open = !menu.classList.contains('active'); menu.classList.toggle('active', open); document.getElementById('profile-more-toggle')?.setAttribute('aria-expanded', String(open)); };
  window.reportViewedProfile = () => { const profile = getViewedProfileRecord(); document.getElementById('profile-more-menu')?.classList.remove('active'); openFeedbackModal?.(); setFeedbackCategory?.('general'); const input = document.getElementById('feedback-message'); if (input && profile) input.value = `Report profile: ${profile.username}\nProfile URL: ${location.origin}/profile/${encodeURIComponent(profile.username)}\n\nReason: `; };
  window.blockViewedProfile = async () => { const profile = getViewedProfileRecord(); if (!profile || profile.isOwn) return; try { await api(`/api/profiles/${encodeURIComponent(profile.username)}/block`, { method: 'PUT' }); await loadBlockedProfiles(); closeMyProfileModal?.(null, true); showNotification(`${profile.username} was blocked`, 'follow', { position: 'bottom-left' }); } catch (error) { notifyError(error); } };

  window.openProfilePanelEditor = panelId => {
    const panel = (real.profile?.panels || []).find(item => item.id === panelId) || null;
    document.getElementById('profile-panel-id').value = panel?.id || '';
    document.getElementById('profile-panel-title').value = panel?.title || '';
    document.getElementById('profile-panel-image').value = panel?.imageUrl || '';
    document.getElementById('profile-panel-description').value = panel?.description || '';
    document.getElementById('profile-panel-url').value = panel?.url || '';
    document.getElementById('profile-panel-delete').hidden = !panel;
    document.getElementById('profile-panel-editor-modal').classList.add('active');
  };
  window.closeProfilePanelEditor = (event, force = false) => { const modal = document.getElementById('profile-panel-editor-modal'); if (modal && (force || event?.target === modal)) modal.classList.remove('active'); };
  window.saveProfilePanel = async event => { event?.preventDefault(); const id = document.getElementById('profile-panel-id').value; const body = { title: document.getElementById('profile-panel-title').value, imageUrl: document.getElementById('profile-panel-image').value, description: document.getElementById('profile-panel-description').value, url: document.getElementById('profile-panel-url').value }; try { const payload = await api(id ? `/api/profile/panels/${encodeURIComponent(id)}` : '/api/profile/panels', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) }); real.profile.panels = payload.panels || []; if (real.viewedProfile?.isOwn) real.viewedProfile.panels = real.profile.panels; closeProfilePanelEditor(null, true); renderProfileAbout(real.profile); showNotification('About panel saved', 'saved', { position: 'bottom-right' }); } catch (error) { notifyError(error); } };
  window.deleteProfilePanel = async () => { const id = document.getElementById('profile-panel-id').value; if (!id) return; try { const payload = await api(`/api/profile/panels/${encodeURIComponent(id)}`, { method: 'DELETE' }); real.profile.panels = payload.panels || []; real.viewedProfile.panels = real.profile.panels; closeProfilePanelEditor(null, true); renderProfileAbout(real.profile); showNotification('About panel removed', 'deleted', { position: 'bottom-right' }); } catch (error) { notifyError(error); } };

  window.openServiceStatusModal = async () => {
    const modal = document.getElementById('service-status-modal');
    const content = document.getElementById('service-status-content');
    modal.classList.add('active');
    content.innerHTML = '<div class="service-status-loading"><span class="global-search-spinner"></span>Checking services…</div>';
    try {
      const payload = await api('/api/status');
      const labels = { operational: 'All systems operational', degraded: 'Some systems are degraded', down: 'Service interruption detected' };
      const icon = payload.status === 'operational' ? 'fa-circle-check' : 'fa-triangle-exclamation';
      const incidents = payload.services.flatMap(service => (service.incidents || []).map(incident => ({ ...incident, service: service.name })));
      content.innerHTML = `<div class="service-status-overall"><i class="fa-solid ${icon}" aria-hidden="true"></i><div><strong>${labels[payload.status] || 'Service status'}</strong><span>${payload.services.length} monitored service${payload.services.length === 1 ? '' : 's'} · Last checked ${new Date(payload.checkedAt).toLocaleString()}</span></div></div>${payload.warning ? `<div class="service-status-warning"><i class="fa-solid fa-triangle-exclamation" aria-hidden="true"></i>&nbsp; ${escapeHTML(payload.warning)}</div>` : ''}<div class="service-status-list">${payload.services.map(service => { const state = ['operational', 'degraded', 'down'].includes(service.status) ? service.status : 'degraded'; const history = Array.isArray(service.history) ? service.history : []; const timeline = `<div class="service-status-timeline" aria-label="Recent response history">${history.map(period => { const periodState = ['operational', 'degraded', 'down'].includes(period.status) ? period.status : 'unknown'; const when = period.checkedAt ? new Date(period.checkedAt).toLocaleString() : 'No response sample'; const response = period.responseTime === null || period.responseTime === undefined ? '' : ` · ${Number(period.responseTime)} ms`; const tooltip = `${periodState === 'unknown' ? 'No data' : periodState[0].toUpperCase() + periodState.slice(1)} · ${when}${response}`; return `<span class="service-status-pill ${periodState}" tabindex="0" role="img" aria-label="${escapeHTML(tooltip)}" data-tooltip="${escapeHTML(tooltip)}"></span>`; }).join('')}</div>`; return `<div class="service-status-row"><div><strong>${escapeHTML(service.name)}</strong><span style="display:block;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHTML(service.url)}</span></div><span>${service.uptime === null ? 'Live check' : `${Number(service.uptime).toFixed(3)}% uptime`}</span>${timeline}<span>${Number(service.responseTime || 0)} ms response</span><span class="service-status-state ${state}">${escapeHTML(state)}</span></div>`; }).join('')}</div>${incidents.length ? `<section class="service-status-incidents"><h3>Recent incidents</h3>${incidents.slice(0, 8).map(incident => `<div class="service-status-incident"><div><strong>${escapeHTML(incident.reason || 'Service interruption')}</strong><span>${escapeHTML(incident.service)}</span></div><span>${incident.startedAt ? new Date(incident.startedAt).toLocaleString() : 'Time unavailable'}</span></div>`).join('')}</section>` : ''}`;
    } catch (error) { content.innerHTML = `<div class="profile-followed-empty"><i class="fa-solid fa-triangle-exclamation"></i><br>${escapeHTML(error.message)}<br><button class="secondary-btn" style="margin-top:12px" onclick="openServiceStatusModal()">Try again</button></div>`; }
  };
  window.closeServiceStatusModal = (event, force = false) => { const modal = document.getElementById('service-status-modal'); if (modal && (force || event?.target === modal)) modal.classList.remove('active'); };

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
  setInterval(() => { if (accountState.signedIn && document.visibilityState === 'visible') loadBackendNotifications({ announce: true }).catch(() => {}); }, 30_000);

  window.MS_API = { api, real, bootstrap, refreshSession, loadBlockedProfiles, loadConnectionsAndFollowing, loadFeatured };
  hydrateDirectProfilePath().catch(error => notifyError(error, 'This profile could not be loaded.'));
  bootstrap();
})();
