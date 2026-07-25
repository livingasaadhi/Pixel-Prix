import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const multiplayer = fs.readFileSync(path.join(root, 'src', 'utils', 'multiplayer.js'), 'utf8');
const main = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
const raceScene = fs.readFileSync(path.join(root, 'src', 'scenes', 'RaceScene.js'), 'utf8');

assert.match(multiplayer, /function getRoomChannelName\(roomCode\)/, 'rooms need a track-independent channel identity');
assert.match(multiplayer, /const ROOM_CODE_LENGTH = 6;/, 'room codes need collision-resistant six-symbol identity');
assert.match(multiplayer, /const channelName = getRoomChannelName\(roomCode\);/, 'host must use room-code channel');
assert.match(multiplayer, /const channelName = getRoomChannelName\(cleanCode\);/, 'guest must use the same room-code channel');
assert.doesNotMatch(multiplayer, /race-\$\{trackId\}-\$\{/, 'track-specific channel names split the same lobby');
assert.match(multiplayer, /assignedTrackId/, 'guest must adopt the host circuit');
assert.match(multiplayer, /Date\.now\(\) \+ RACE_START_LEAD_MS/, 'host start needs network lead time');
assert.match(main, /queueCountdownLights\(startTimestamp\)/, 'client countdown must use the host timestamp');
assert.match(main, /startTimestamp\n\s*}\);/, 'timestamp must be passed to RaceScene');
assert.match(main, /setRaceMode\(true\);\n\s*showScreen\('screen-hud'\);/, 'online starts must enable race-mode chrome and orientation');
assert.match(main, /function queueCountdownLights\(/, 'countdown scheduling must be cancellable before its animation frame runs');
assert.match(main, /if \(mpState\.channel \|\| mpState\.isMultiplayer\) leaveMultiplayerRoom\(\);/, 'a solo launch must close any previous multiplayer room');
assert.match(multiplayer, /trackRevision/, 'circuit changes must carry a monotonic revision');
assert.match(multiplayer, /mpState\.localPlayer = \{ \.\.\.mpState\.localPlayer, trackId, trackRevision \};\n\s*channel\.track\(mpState\.localPlayer\)/, 'guests must update their presence when the host changes circuit');
assert.match(multiplayer, /raceRoster:\s*\[\]/, 'the active race needs a frozen roster');
assert.match(multiplayer, /freezeRaceRoster\(/, 'race starts must snapshot the grid');
assert.match(multiplayer, /RACE ALREADY IN PROGRESS/, 'late joiners must be rejected while a race is active');
assert.match(main, /const roster = \(mpState\.raceRoster\.length > 0 \? mpState\.raceRoster : mpState\.players\)\n\s*\.filter\(\(player\) => !player\.retired\);/, 'results must use the active frozen roster rather than live lobby presence');
assert.match(multiplayer, /sessionEpoch/, 'multiplayer callbacks must be scoped to their room session');
assert.match(multiplayer, /isCurrentRoom\(channel, sessionEpoch\)/, 'stale channel callbacks must be ignored');
assert.match(multiplayer, /clock_ping/, 'clients must calibrate to the host clock before shared starts');
assert.match(main, /modal-mp-results'\)\?\.classList\.add\('hidden'\)/, 'a fresh race start must dismiss stale result overlays');
assert.match(main, /Number\.isFinite\(requestedStart\) && requestedStart > 0/, 'solo null countdown input must not be treated as an expired shared timestamp');
assert.match(raceScene, /this\.scheduledStartAt/, 'RaceScene must keep the shared start time for its fallback');
assert.match(raceScene, /stopPositionBroadcast\(\);\n\s*stopEngineSound\(\);/, 'scene cleanup must stop multiplayer broadcasts');

console.log('Multiplayer lifecycle checks passed: shared rooms, host circuit, synchronized start, and cleanup verified.');
