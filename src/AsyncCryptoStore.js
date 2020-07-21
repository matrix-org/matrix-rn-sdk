/*
Copyright 2020 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

const E2E_PREFIX = 'crypto.';
const KEY_END_TO_END_ACCOUNT = E2E_PREFIX + 'account';
const KEY_CROSS_SIGNING_KEYS = E2E_PREFIX + 'cross_signing_keys';
const KEY_NOTIFIED_ERROR_DEVICES = E2E_PREFIX + 'notified_error_devices';
const KEY_DEVICE_DATA = E2E_PREFIX + 'device_data';
const KEY_INBOUND_SESSION_PREFIX = E2E_PREFIX + 'inboundgroupsessions/';
const KEY_INBOUND_SESSION_WITHHELD_PREFIX = E2E_PREFIX + 'inboundgroupsessions.withheld/';
const KEY_ROOMS_PREFIX = E2E_PREFIX + 'rooms/';
const KEY_SESSIONS_NEEDING_BACKUP = E2E_PREFIX + 'sessionsneedingbackup';

function keyEndToEndSession(deviceKey, sessionKey) {
    return (
        E2E_PREFIX + 'sessions/' +
        encodeURIComponent(deviceKey) + '/' +
        encodeURIComponent(sessionKey)
    );
}

function keyEndToEndSessionProblems(deviceKey, sessionKey) {
    return (
        E2E_PREFIX + 'session.problems/' +
        encodeURIComponent(deviceKey) + '/' +
        encodeURIComponent(sessionKey)
    );
}

function keyEndToEndInboundGroupSession(senderKey, sessionId) {
    return (
        KEY_INBOUND_SESSION_PREFIX +
        encodeURIComponent(senderKey) + '/' +
        encodeURIComponent(sessionId)
    );
}

function keyEndToEndInboundGroupSessionWithheld(senderKey, sessionId) {
    return (
        KEY_INBOUND_SESSION_WITHHELD_PREFIX +
        encodeURIComponent(senderKey) + '/' +
        encodeURIComponent(sessionId)
    );
}

function keyEndToEndRoomsPrefix(roomId) {
    return KEY_ROOMS_PREFIX + roomId;
}

/**
 * @implements {module:crypto/store/base~CryptoStore}
 */
class AsyncCryptoStore {
    constructor(asyncStorageClass) {
        this.asyncStorage = asyncStorageClass;
    }

    // Olm Sessions

    async countEndToEndSessions(txn, func) {
        const allKeys = await this.asyncStorage.getAllKeys();

        const count = allKeys.filter(k => k.startsWith(E2E_PREFIX + 'sessions/')).length;
        func(count);
    }

    async getEndToEndSession(deviceKey, sessionId, txn, func) {
        const session = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
        func(session);
    }

    async getEndToEndSessions(deviceKey, txn, func) {
        const allKeys = await this.asyncStorage.getAllKeys();
        const sessions = {};
        for (const k of allKeys.filter(k => k.startsWith(E2E_PREFIX + 'sessions/' + deviceKey + '/'))) {
            const sessionId = k.split('/')[2];
            sessions[sessionId] = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
        }

        func(sessions);
    }

    async getAllEndToEndSessions(txn, func) {
        const allKeys = this.asyncStorage.getAllKeys();
        for (const k of allKeys.filter(k => k.startsWith(E2E_PREFIX + 'sessions/'))) {
            const deviceKey = k.split('/')[1];
            const sessionId = k.split('/')[2];
            const sessionInfo = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
            func(sessionInfo);
        }
        func(null);
    }

    storeEndToEndSession(deviceKey, sessionId, sessionInfo, txn) {
        return this._setJsonItem(
            keyEndToEndSession(deviceKey, sessionId), sessionInfo,
        );
    }

    async storeEndToEndSessionProblem(deviceKey, type, fixed) {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = await this._getJsonItem(key) || [];
        problems.push({type, fixed, time: Date.now()});
        problems.sort((a, b) => {
            return a.time - b.time;
        });
        await this._setJsonItem(key, problems);
    }

    async getEndToEndSessionProblem(deviceKey, timestamp) {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = await this._getJsonItem(this.store, key) || [];
        if (!problems.length) {
            return null;
        }
        const lastProblem = problems[problems.length - 1];
        for (const problem of problems) {
            if (problem.time > timestamp) {
                return Object.assign({}, problem, {fixed: lastProblem.fixed});
            }
        }
        if (lastProblem.fixed) {
            return null;
        } else {
            return lastProblem;
        }
    }

    async filterOutNotifiedErrorDevices(devices) {
        const notifiedErrorDevices = await this._getJsonItem(
            KEY_NOTIFIED_ERROR_DEVICES,
        ) || {};
        const ret = [];

        for (const device of devices) {
            const {userId, deviceInfo} = device;
            if (userId in notifiedErrorDevices) {
                if (!(deviceInfo.deviceId in notifiedErrorDevices[userId])) {
                    ret.push(device);
                    notifiedErrorDevices[userId][deviceInfo.deviceId] = true;
                }
            } else {
                ret.push(device);
                notifiedErrorDevices[userId] = {[deviceInfo.deviceId]: true };
            }
        }

        await this._setJsonItem(KEY_NOTIFIED_ERROR_DEVICES, notifiedErrorDevices);

        return ret;
    }

    // Inbound Group Sessions

    async getEndToEndInboundGroupSession(senderCurve25519Key, sessionId, txn, func) {
        func(
            await this._getJsonItem(
                keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            ),
            await this._getJsonItem(
                keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
            ),
        );
    }

    async getAllEndToEndInboundGroupSessions(txn, func) {
        const inboundGroupSessionKeys = (await this.asyncStorage.getAllKeys()).filter(
            k => k.startsWith(KEY_INBOUND_SESSION_PREFIX),
        );

        for (const k of inboundGroupSessionKeys) {
            const keyParts = k.split('/');
            const senderKey = decodeURIComponent(keyParts[1]);
            const sessionId = decodeURIComponent(keyParts[2]);

            const sessionData = await this._getJsonItem(k);
            func({
                senderKey,
                sessionId,
                sessionData,
            });
        }
        func(null);
    }

    async addEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        const existing = await this._getJsonItem(
            keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
        );
        if (!existing) {
            await this.storeEndToEndInboundGroupSession(
                senderCurve25519Key, sessionId, sessionData, txn,
            );
        }
    }

    storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn) {
        return this._setJsonItem(
            keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            sessionData,
        );
    }

    storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key, sessionId, sessionData, txn,
    ) {
        return this._setJsonItem(
            keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
            sessionData,
        );
    }

    // Device data

    async getEndToEndDeviceData(txn, func) {
        func(await this._getJsonItem(KEY_DEVICE_DATA));
    }

    storeEndToEndDeviceData(deviceData, txn) {
        return this._setJsonItem(
            KEY_DEVICE_DATA, deviceData,
        );
    }

    // Rooms

    storeEndToEndRoom(roomId, roomInfo, txn) {
        return this._setJsonItem(
            keyEndToEndRoomsPrefix(roomId), roomInfo,
        );
    }

    async getEndToEndRooms(txn, func) {
        const prefix = keyEndToEndRoomsPrefix('');

        const e2eRoomsKeys = (await this.asyncStorage.getAllKeys()).filter(
            k => k.startsWith(prefix),
        );

        const result = {};
        for (const k of e2eRoomsKeys) {
            const roomId = k.substr(prefix.length);
            result[roomId] = await this._getJsonItem(k);
        }
        func(result);
    }

    // Sessions Needing Backup

    async getSessionsNeedingBackup(limit) {
        const sessionsNeedingBackup = await this._getJsonItem(
            KEY_SESSIONS_NEEDING_BACKUP,
        ) || {};
        const sessions = [];

        for (const k of Object.keys(sessionsNeedingBackup)) {
            const keyParts = k.split('/');
            const senderKey = keyParts[0];
            const sessionId = keyParts[1];
            await this.getEndToEndInboundGroupSession(
                senderKey, sessionId, null,
                (sessionData) => {
                    sessions.push({
                        senderKey: senderKey,
                        sessionId: sessionId,
                        sessionData: sessionData,
                    });
                },
            );
            if (limit && sessions.length >= limit) {
                break;
            }
        }
        return sessions;
    }

    async countSessionsNeedingBackup() {
        const sessionsNeedingBackup = await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP) || {};
        return Object.keys(sessionsNeedingBackup).length;
    }

    async unmarkSessionsNeedingBackup(sessions) {
        const sessionsNeedingBackup = await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP) || {};
        for (const session of sessions) {
            delete sessionsNeedingBackup[session.senderKey + '/' + session.sessionId];
        }
        await this._setJsonItem(
            KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup,
        );
    }

    async markSessionsNeedingBackup(sessions) {
        const sessionsNeedingBackup = this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP) || {};
        for (const session of sessions) {
            sessionsNeedingBackup[session.senderKey + '/' + session.sessionId] = true;
        }
        await this._setJsonItem(
            KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup,
        );
    }

    /**
     * Delete all data from this store.
     *
     * @returns {Promise} Promise which resolves when the store has been cleared.
     */
    async deleteAllData() {
        const allE2eStorageKeys = (await this.asyncStorage.getAllKeys()).filter(k => k.startsWith(E2E_PREFIX));

        for (const k of allE2eStorageKeys) {
            await this.asyncStorage.removeItem(k);
        }
    }

    // Olm account

    async getAccount(txn, func) {
        const account = await this._getJsonItem(KEY_END_TO_END_ACCOUNT);
        func(account);
    }

    storeAccount(txn, newData) {
        return this._setJsonItem(
            KEY_END_TO_END_ACCOUNT, newData,
        );
    }

    async getCrossSigningKeys(txn, func) {
        const keys = await this._getJsonItem(KEY_CROSS_SIGNING_KEYS);
        func(keys);
    }

    async getSecretStorePrivateKey(txn, func, type) {
        const key = await this._getJsonItem(E2E_PREFIX + `ssss_cache.${type}`);
        func(key);
    }

    storeCrossSigningKeys(txn, keys) {
        return this._setJsonItem(
            KEY_CROSS_SIGNING_KEYS, keys,
        );
    }

    storeSecretStorePrivateKey(txn, type, key) {
        return this._setJsonItem(
            E2E_PREFIX + `ssss_cache.${type}`, key,
        );
    }

    async _getJsonItem(key) {
        // if the key is absent, AsyncStore.getItem() returns null, and
        // JSON.parse(null) === null, so this returns null.
        return JSON.parse(await this.asyncStorage.getItem(key));
    }

    async _setJsonItem(key, val) {
        return this.asyncStorage.setItem(key, JSON.stringify(val));
    }
}

module.exports = AsyncCryptoStore;
