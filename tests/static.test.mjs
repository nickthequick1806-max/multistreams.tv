import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const html = await readFile(new URL('../multistreams.tv/multistreams.html', import.meta.url), 'utf8');
const backendClient = await readFile(new URL('../multistreams.tv/backend-client.js', import.meta.url), 'utf8');
const contactClient = await readFile(new URL('../multistreams.tv/contact.js', import.meta.url), 'utf8');
const oauthRoute = await readFile(new URL('../src/routes/oauth.js', import.meta.url), 'utf8');
const aiRoute = await readFile(new URL('../src/routes/ai.js', import.meta.url), 'utf8');
const platforms = await readFile(new URL('../src/platforms.js', import.meta.url), 'utf8');
const thirdPartyRoute = await readFile(new URL('../src/routes/third-party.js', import.meta.url), 'utf8');
const worker = await readFile(new URL('../src/index.js', import.meta.url), 'utf8');
const wrangler = await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8');

test('no provider API keys, OAuth bearer tokens, or Discord webhooks remain in frontend source', () => {
  assert.doesNotMatch(html, /AIza[0-9A-Za-z_-]{20,}/);
  assert.doesNotMatch(html, /discord\.com\/api\/webhooks\//);
  assert.doesNotMatch(html, /YB3lxGALkuaqHAf31EQcMwKfWlt1/);
  assert.doesNotMatch(html, /Bearer\s+[0-9a-z]{20,}/i);
  assert.doesNotMatch(backendClient, /x-goog-api-key|client_secret|discord\.com\/api\/webhooks\//i);
  assert.doesNotMatch(contactClient, /x-api-key|client_secret|discord\.com\/api\/webhooks\//i);
});

test('all inline classic scripts and the backend client parse as JavaScript', () => {
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)].map(match => match[1]);
  assert.ok(scripts.length > 0);
  scripts.forEach((source, index) => assert.doesNotThrow(() => new vm.Script(source, { filename: `multistreams-inline-${index}.js` })));
  assert.doesNotThrow(() => new vm.Script(backendClient, { filename: 'backend-client.js' }));
  assert.match(html, /<script src="\/backend-client\.js\?v=[0-9.]+"><\/script>/);
});

test('platform-aware UI fallbacks and category metadata rules are present', () => {
  assert.doesNotMatch(backendClient, /forceInitials \|\| item\?\.platform === 'kick'/);
  assert.match(backendClient, /suggested-platform-icon/);
  assert.match(backendClient, /hasViewerCount/);
  assert.match(backendClient, /\['kick', 'youtube'\]\.includes\(currentBrowsePlatform\)/);
  assert.doesNotMatch(backendClient, /Rumble did not recognize that Live Stream API URL/);
});

test('YouTube account connection reuses the Google profile OAuth entry point', () => {
  assert.match(backendClient, /\/api\/oauth\/google\/start\?purpose=youtube-connect&returnTo=\/multistreams/);
  assert.match(oauthRoute, /const GOOGLE_YOUTUBE_PURPOSE = 'youtube-connect'/);
  assert.match(oauthRoute, /fetchIdentity\(connectedPlatform, tokens\.access_token, env\)/);
  assert.match(oauthRoute, /destination\.searchParams\.set\('oauth', connectedPlatform\)/);
  assert.match(oauthRoute, /await saveConnection\(env, result\.user\.id, 'youtube'/);
  assert.match(oauthRoute, /return OAUTH\.youtube\.scopes/);
});

test('production UI fixes remain wired to backend-normalized data', () => {
  assert.doesNotMatch(html, /id="ai-search-model"/);
  assert.match(html, /notificationsEnabled:\s*true/);
  assert.match(html, /uiSounds:\s*true/);
  assert.match(html, /data\.items\?\.find\(item => item\.platform === 'youtube'\)\?\.id/);
  assert.match(html, /data\.items\?\.\[0\]\?\.id \|\| null/);
  assert.match(backendClient, /parseProfileLayoutLink\(location\.href\)/);
  assert.match(backendClient, /\/api\/security\/devices\/\$\{encodeURIComponent\(deviceId\)\}/);
  assert.match(html, /AI_SEARCH_ICON\.png/);
  assert.match(html, /stream\.platform === 'youtube' && stream\.id \? stream\.id/);
  assert.match(backendClient, /videoId \|\| detail\.id \|\| detail\.username \|\| name/);
  assert.doesNotMatch(backendClient, /is not live on YouTube right now/);
  assert.match(html, /function liveNotificationIdentity/);
  assert.match(html, /function pruneDeletedLiveNotifications/);
  assert.match(html, /loadLiveNotifications\(\);\s*calculateNotificationCounts/);
  assert.doesNotMatch(html, /mockLiveStreamers = \[\];\s*deletedLiveNotifications = \[\]/);
});

test('OAuth, AI recovery, YouTube data fallbacks, and share routes have regressions covered', () => {
  assert.match(wrangler, /"TWITCH_REDIRECT_URI":\s*"https:\/\/multistreams\.tv\/multistreams"/);
  assert.match(backendClient, /\/api\/oauth\/twitch\/callback\?\$\{oauthRelayParams\.toString\(\)\}/);
  assert.match(aiRoute, /MALFORMED_FUNCTION_CALL/);
  assert.match(aiRoute, /Do not emit or call any function/);
  assert.match(platforms, /\/activities\?part=snippet,contentDetails&home=true&maxResults=50/);
  assert.doesNotMatch(platforms, /slice\.map\(channelId => youtubeSearchVideos/);
  assert.match(platforms, /forHandle=/);
  assert.match(platforms, /if \(live && error\?\.code === 'youtube_rate_limited' && env\.SCRAPECREATORS_API_KEY\)/);
  assert.match(platforms, /\/search\?part=snippet&type=channel/);
  assert.match(thirdPartyRoute, /\/v1\/youtube\/shorts\/trending/);
  assert.match(thirdPartyRoute, /\/v1\/rumble\//);
  assert.match(oauthRoute, /Array\.isArray\(tokens\.scope\)/);
  assert.match(worker, /new URL\('\/api\/oauth\/twitch\/callback'/);
  assert.match(platforms, /appToken\(env, 'twitch', true\)/);
  assert.match(worker, /async function layoutShell/);
  assert.match(wrangler, /"run_worker_first":\s*\[[^\]]*"\/layout"/);
  assert.match(html, /function createLayoutShareLink/);
  assert.match(html, /async function hydrateLoadedLayoutChannels/);
  assert.match(html, /channels = await hydrateLoadedLayoutChannels\(streams\)/);
  assert.match(backendClient, /if \(!incomingSharedLayout\?\.streams\?\.length\) jobs\.push\(loadRemoteState\(\)\)/);
  assert.match(html, /-webkit-line-clamp:\s*2/);
  assert.match(html, /notificationsMarkedAsRead = false/);
  assert.match(html, /clip\.duration \? `<span class="browse-duration">/);
  assert.match(backendClient, /function browseMediaDuration\(item\)/);
  assert.match(backendClient, /card\.style\.position = 'fixed'/);
  assert.doesNotMatch(platforms, /sharedPublicLiveIndex/);
  assert.match(platforms, /if \(categoryId\) params\.set\('videoCategoryId', categoryId\)/);
  assert.match(platforms, /recordedDurationSeconds/);
  assert.match(platforms, /async function youtubeCreatorLiveFallback/);
  assert.match(platforms, /async function youtubeCreatorChannelDetail/);
  assert.match(platforms, /categoryName \? `\$\{categoryName\} live`/);
  assert.match(platforms, /const streams = requestedVideo\s*\?\s*\(requestedVideo\.live \? \[requestedVideo\] : \[\]\)/);
  assert.match(platforms, /SCRAPECREATORS_API_KEY && error\?\.code === 'youtube_rate_limited'/);
  assert.match(platforms, /async function kickUsers/);
  assert.match(platforms, /async function kickChannelDetail/);
  assert.match(platforms, /broadcaster_user/);
  assert.match(platforms, /profile_picture/);
  assert.match(platforms, /appToken\(env, 'kick', true\)/);
  assert.match(backendClient, /avatar: item\.avatar \|\| ''/);
  assert.match(backendClient, /hasViewerCount\(detail\)/);
  assert.doesNotMatch(html, /enteringGrid[\s\S]{0,500}player\.kick\.com/);
});
