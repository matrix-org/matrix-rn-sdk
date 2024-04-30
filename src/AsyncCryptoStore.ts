/*
Copyright 2024 The Matrix.org Foundation C.I.C.

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

import { IRoomKeyRequestBody } from "matrix-js-sdk/lib/crypto";
import { CrossSigningKeyInfo } from "matrix-js-sdk/lib/crypto-api";
import { IOlmDevice } from "matrix-js-sdk/lib/crypto/algorithms/megolm";
import { DeviceInfo } from "matrix-js-sdk/lib/crypto/deviceinfo";
import { InboundGroupSessionData } from "matrix-js-sdk/lib/crypto/OlmDevice";
import { IRoomEncryption } from "matrix-js-sdk/lib/crypto/RoomList";
import {
    CryptoStore,
    IDeviceData,
    IProblem,
    ISession,
    ISessionInfo,
    IWithheld,
    MigrationState,
    Mode,
    OutgoingRoomKeyRequest,
    ParkedSharedHistory,
    SecretStorePrivateKeys,
    SESSION_BATCH_SIZE,
    SessionExtended,
} from "matrix-js-sdk/lib/crypto/store/base";
import { Logger } from "matrix-js-sdk/lib/logger";

import AsyncCryptoStorage from "./AsyncStore";

const E2E_PREFIX = "crypto.";

const OUTGOING_KEY_REQUEST_PREFIX = E2E_PREFIX + "outgoingkeyrequest/";
const SECRET_STORE_PRIVATE_KEY_PREFIX = E2E_PREFIX + "ssss_cache.";
const END_TO_END_SESSION_PREFIX = E2E_PREFIX + "sessions/";
const END_TO_END_SESSION_PROBLEMS_PREFIX = E2E_PREFIX + "session.problems/";
const INBOUND_SESSION_PREFIX = E2E_PREFIX + "inboundgroupsessions/";
const INBOUND_SESSION_WITHHELD_PREFIX = E2E_PREFIX + "inboundgroupsessions.withheld/";
const ROOMS_PREFIX = E2E_PREFIX + "rooms/";
const SHARED_HISTORY_INBOUND_SESSIONS_PREFIX = E2E_PREFIX + "sharedhistory.inboundgroupsessions/";
const PARKED_SHARED_HISTORY_PREFIX = E2E_PREFIX + "sharedhistory.parked/";

function prefixEndToEndSession(deviceKey: string): string {
    return END_TO_END_SESSION_PREFIX + encodeURIComponent(deviceKey) + "/";
}

const KEY_END_TO_END_ACCOUNT = E2E_PREFIX + "account";
const KEY_CROSS_SIGNING_KEYS = E2E_PREFIX + "cross_signing_keys";
const KEY_NOTIFIED_ERROR_DEVICES = E2E_PREFIX + "notified_error_devices";
const KEY_DEVICE_DATA = E2E_PREFIX + "device_data";
const KEY_SESSIONS_NEEDING_BACKUP = E2E_PREFIX + "sessionsneedingbackup";
const KEY_END_TO_END_MIGRATION_STATE = E2E_PREFIX + "migration";

function keyOutgoingKeyRequest(requestId: string): string {
    return OUTGOING_KEY_REQUEST_PREFIX + encodeURIComponent(requestId);
}

function keySecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(type: K): string {
    return SECRET_STORE_PRIVATE_KEY_PREFIX + encodeURIComponent(`${type}`);
}

function keyEndToEndSession(deviceKey: string, sessionKey: string): string {
    return prefixEndToEndSession(deviceKey) + encodeURIComponent(sessionKey);
}

function keyEndToEndSessionProblems(deviceKey: string): string {
    return END_TO_END_SESSION_PROBLEMS_PREFIX + encodeURIComponent(deviceKey);
}

function keyEndToEndInboundGroupSession(senderKey: string, sessionId: string): string {
    return INBOUND_SESSION_PREFIX + encodeURIComponent(senderKey) + "/" + encodeURIComponent(sessionId);
}

function keyEndToEndInboundGroupSessionWithheld(senderKey: string, sessionId: string): string {
    return INBOUND_SESSION_WITHHELD_PREFIX + encodeURIComponent(senderKey) + "/" + encodeURIComponent(sessionId);
}

function keyEndToEndRoom(roomId: string): string {
    return ROOMS_PREFIX + roomId;
}

function keySharedHistoryInboundGroupSessions(roomId: string): string {
    return SHARED_HISTORY_INBOUND_SESSIONS_PREFIX + encodeURIComponent(roomId);
}

function keyParkedSharedHistory(roomId: string): string {
    return PARKED_SHARED_HISTORY_PREFIX + encodeURIComponent(roomId);
}

class Transaction {
    private numOps = 0;
    private error: unknown = null;

    private resolve: ((value: void | PromiseLike<void>) => void) | null = null;
    private reject: ((reason?: unknown) => void) | null = null;

    private promise = new Promise<void>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });

    public getPromise(): Promise<void> {
        return this.promise;
    }

    public async execute(func: () => Promise<void>): Promise<void> {
        this.onOperationStarted();
        try {
            await func();
        } catch (e) {
            this.error = e;
        } finally {
            this.onOperationEnded();
        }
    }

    private onOperationStarted(): void {
        if (this.resolve === null) {
            throw new Error("Tried to start a new operation on a completed transaction");
        }
        this.numOps += 1;
    }

    private onOperationEnded(): void {
        this.numOps -= 1;
        if (this.numOps === 0) {
            this.error ? this.reject?.(this.error) : this.resolve?.();
            this.resolve = null;
            this.reject = null;
        }
    }
}

export default class AsyncCryptoStore implements CryptoStore {
    private initialized = false;

    public constructor(private storage: AsyncCryptoStorage) {}

    private async getAllOutgoingKeyRequestKeys(): Promise<string[]> {
        return (await this.storage.getAllKeys()).filter((k) => k.startsWith(OUTGOING_KEY_REQUEST_PREFIX));
    }

    private async getJsonItem(key: string): Promise<unknown> {
        const item = await this.storage.getItem(key);
        if (item === null) {
            return null;
        }
        return JSON.parse(item);
    }

    private async setJsonItem(key: string, val: unknown): Promise<void> {
        return this.storage.setItem(key, JSON.stringify(val));
    }

    // CryptoStore

    public async containsData(): Promise<boolean> {
        return this.initialized;
    }

    public async startup(): Promise<CryptoStore> {
        this.initialized = true;
        return this;
    }

    public async deleteAllData(): Promise<void> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(E2E_PREFIX));
        for (const key of keys) {
            await this.storage.removeItem(key);
        }
    }

    public async getMigrationState(): Promise<MigrationState> {
        return ((await this.getJsonItem(KEY_END_TO_END_MIGRATION_STATE)) ??
            MigrationState.NOT_STARTED) as MigrationState;
    }

    public async setMigrationState(migrationState: MigrationState): Promise<void> {
        await this.setJsonItem(KEY_END_TO_END_MIGRATION_STATE, migrationState);
    }

    public async getOrAddOutgoingRoomKeyRequest(request: OutgoingRoomKeyRequest): Promise<OutgoingRoomKeyRequest> {
        const req = await this.getOutgoingRoomKeyRequest(request.requestBody);
        if (req) {
            return req;
        }
        await this.setJsonItem(keyOutgoingKeyRequest(request.requestId), request);
        return request;
    }

    public async getOutgoingRoomKeyRequest(requestBody: IRoomKeyRequestBody): Promise<OutgoingRoomKeyRequest | null> {
        for (const key of await this.getAllOutgoingKeyRequestKeys()) {
            const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (
                req.requestBody.room_id === requestBody.room_id &&
                req.requestBody.session_id === requestBody.session_id
            ) {
                return req;
            }
        }
        return null;
    }

    public async getOutgoingRoomKeyRequestByState(wantedStates: number[]): Promise<OutgoingRoomKeyRequest | null> {
        for (const key of await this.getAllOutgoingKeyRequestKeys()) {
            const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (wantedStates.includes(req.state)) {
                return req;
            }
        }
        return null;
    }

    public async getAllOutgoingRoomKeyRequestsByState(wantedState: number): Promise<OutgoingRoomKeyRequest[]> {
        const reqs: OutgoingRoomKeyRequest[] = [];
        for (const key of await this.getAllOutgoingKeyRequestKeys()) {
            const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (req.state == wantedState) {
                reqs.push(req);
            }
        }
        return reqs;
    }

    public async getOutgoingRoomKeyRequestsByTarget(
        userId: string,
        deviceId: string,
        wantedStates: number[],
    ): Promise<OutgoingRoomKeyRequest[]> {
        const reqs: OutgoingRoomKeyRequest[] = [];
        for (const key of await this.getAllOutgoingKeyRequestKeys()) {
            const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (
                wantedStates.includes(req.state) &&
                req.recipients.some((r) => r.userId === userId && r.deviceId === deviceId)
            ) {
                reqs.push(req);
            }
        }
        return reqs;
    }

    public async updateOutgoingRoomKeyRequest(
        requestId: string,
        expectedState: number,
        updates: Partial<OutgoingRoomKeyRequest>,
    ): Promise<OutgoingRoomKeyRequest | null> {
        const key = keyOutgoingKeyRequest(requestId);

        const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
        if (!req || req.state !== expectedState) {
            return null;
        }

        Object.assign(req, updates);
        await this.setJsonItem(key, req);
        return req;
    }

    public async deleteOutgoingRoomKeyRequest(
        requestId: string,
        expectedState: number,
    ): Promise<OutgoingRoomKeyRequest | null> {
        const key = keyOutgoingKeyRequest(requestId);

        const req = (await this.getJsonItem(key)) as OutgoingRoomKeyRequest;
        if (!req || req.state !== expectedState) {
            return null;
        }

        await this.storage.removeItem(key);
        return req;
    }

    public getAccount(txn: unknown, func: (accountPickle: string | null) => void): void {
        (txn as Transaction).execute(async () => {
            const accountPickle = (await this.getJsonItem(KEY_END_TO_END_ACCOUNT)) as string | null;
            func(accountPickle);
        });
    }

    public storeAccount(txn: unknown, accountPickle: string): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(KEY_END_TO_END_ACCOUNT, accountPickle);
        });
    }

    public getCrossSigningKeys(txn: unknown, func: (keys: Record<string, CrossSigningKeyInfo> | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = (await this.getJsonItem(KEY_CROSS_SIGNING_KEYS)) as Record<string, CrossSigningKeyInfo> | null;
            func(keys);
        });
    }

    public getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void {
        (txn as Transaction).execute(async () => {
            const key = (await this.getJsonItem(keySecretStorePrivateKey(type))) as SecretStorePrivateKeys[K] | null;
            func(key);
        });
    }

    public storeCrossSigningKeys(txn: unknown, keys: Record<string, CrossSigningKeyInfo>): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(KEY_CROSS_SIGNING_KEYS, keys);
        });
    }

    public storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(keySecretStorePrivateKey(type), key);
        });
    }

    public countEndToEndSessions(txn: unknown, func: (count: number) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            const count = keys.filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX)).length;
            func(count);
        });
    }

    public getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: unknown,
        func: (session: ISessionInfo | null) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const session = (await this.getJsonItem(keyEndToEndSession(deviceKey, sessionId))) as ISessionInfo | null;
            func(session);
        });
    }

    public getEndToEndSessions(
        deviceKey: string,
        txn: unknown,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            const prefix = prefixEndToEndSession(deviceKey);
            const sessions: { [sessionId: string]: ISessionInfo } = {};
            for (const k of keys.filter((k) => k.startsWith(prefix))) {
                const sessionId = decodeURIComponent(k.split("/")[2]);
                // TODO: Can we not just use k directly here?
                sessions[sessionId] = (await this.getJsonItem(
                    keyEndToEndSession(deviceKey, sessionId),
                )) as ISessionInfo;
            }
            func(sessions);
        });
    }

    public getAllEndToEndSessions(txn: unknown, func: (session: ISessionInfo | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            for (const k of keys.filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX))) {
                const deviceKey = decodeURIComponent(k.split("/")[1]);
                const sessionId = decodeURIComponent(k.split("/")[2]);
                // TODO: Can we not just use k directly here?
                const sessionInfo = (await this.getJsonItem(
                    keyEndToEndSession(deviceKey, sessionId),
                )) as ISessionInfo | null;
                func(sessionInfo);
            }
        });
    }

    public storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(keyEndToEndSession(deviceKey, sessionId), sessionInfo);
        });
    }

    public async storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void> {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = ((await this.getJsonItem(key)) || []) as IProblem[];
        problems.push({ type, fixed, time: Date.now() });
        problems.sort((a, b) => a.time - b.time);
        await this.setJsonItem(key, problems);
    }

    public async getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null> {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = ((await this.getJsonItem(key)) || []) as IProblem[];
        if (!problems.length) {
            return null;
        }

        const lastProblem = problems[problems.length - 1];

        for (const problem of problems) {
            if (problem.time > timestamp) {
                return Object.assign({}, problem, { fixed: lastProblem.fixed });
            }
        }

        if (lastProblem.fixed) {
            return null;
        } else {
            return lastProblem;
        }
    }

    public async filterOutNotifiedErrorDevices(devices: IOlmDevice<DeviceInfo>[]): Promise<IOlmDevice<DeviceInfo>[]> {
        const notifiedErrorDevices = ((await this.getJsonItem(KEY_NOTIFIED_ERROR_DEVICES)) || {}) as {
            [userId: string]: { [deviceId: string]: boolean };
        };

        const ret = [];

        for (const device of devices) {
            const { userId, deviceInfo } = device;
            if (userId in notifiedErrorDevices) {
                if (!(deviceInfo.deviceId in notifiedErrorDevices[userId])) {
                    ret.push(device);
                    notifiedErrorDevices[userId][deviceInfo.deviceId] = true;
                }
            } else {
                ret.push(device);
                notifiedErrorDevices[userId] = { [deviceInfo.deviceId]: true };
            }
        }

        await this.setJsonItem(KEY_NOTIFIED_ERROR_DEVICES, notifiedErrorDevices);

        return ret;
    }

    public async getEndToEndSessionsBatch(): Promise<ISessionInfo[] | null> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX));

        const result: ISessionInfo[] = [];

        for (const k of keys) {
            const session = (await this.getJsonItem(k)) as ISessionInfo | null;
            if (!session) {
                console.error(`Could not find session ${k}`);
                continue;
            }

            result.push(session);

            if (result.length >= SESSION_BATCH_SIZE) {
                return result;
            }
        }

        if (result.length === 0) {
            return null;
        }

        return result; // We found fewer sessions than the batch size
    }

    public async deleteEndToEndSessionsBatch(
        sessions: { deviceKey?: string | undefined; sessionId?: string | undefined }[],
    ): Promise<void> {
        for (const { deviceKey, sessionId } of sessions) {
            if (deviceKey === undefined || sessionId === undefined) {
                continue;
            }
            await this.storage.removeItem(keyEndToEndSession(deviceKey, sessionId));
        }
    }

    public getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: unknown,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const groupSession = (await this.getJsonItem(
                keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            )) as InboundGroupSessionData | null;
            const groupSessionWithheld = (await this.getJsonItem(
                keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
            )) as IWithheld | null;
            func(groupSession, groupSessionWithheld);
        });
    }

    public getAllEndToEndInboundGroupSessions(txn: unknown, func: (session: ISession | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX));

            for (const k of keys) {
                const keyParts = k.split("/");
                const senderKey = decodeURIComponent(keyParts[1]);
                const sessionId = decodeURIComponent(keyParts[2]);
                const sessionData = (await this.getJsonItem(k)) as InboundGroupSessionData;
                func({
                    senderKey,
                    sessionId,
                    sessionData,
                });
            }

            func(null);
        });
    }

    public addEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            const existing = await this.getJsonItem(keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId));
            if (!existing) {
                await this.storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn);
            }
        });
    }

    public storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId), sessionData);
        });
    }

    public storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: IWithheld,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId), sessionData);
        });
    }

    public async countEndToEndInboundGroupSessions(): Promise<number> {
        return (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX)).length;
    }

    public async getEndToEndInboundGroupSessionsBatch(): Promise<SessionExtended[] | null> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX));

        const result: SessionExtended[] = [];

        for (const k of keys) {
            const keyParts = k.split("/");
            const senderKey = decodeURIComponent(keyParts[1]);
            const sessionId = decodeURIComponent(keyParts[2]);
            const sessionData = (await this.getJsonItem(k)) as InboundGroupSessionData;

            result.push({
                senderKey,
                sessionId,
                sessionData,
                needsBackup: k in this.getSessionsNeedingBackup(0),
            });

            if (result.length >= SESSION_BATCH_SIZE) {
                return result;
            }
        }

        if (result.length === 0) {
            return null;
        }

        return result; // We found fewer sessions than the batch size
    }

    public async deleteEndToEndInboundGroupSessionsBatch(
        sessions: { senderKey: string; sessionId: string }[],
    ): Promise<void> {
        for (const { senderKey, sessionId } of sessions) {
            await this.storage.removeItem(keyEndToEndInboundGroupSession(senderKey, sessionId));
        }
    }

    public getEndToEndDeviceData(txn: unknown, func: (deviceData: IDeviceData | null) => void): void {
        (txn as Transaction).execute(async () => {
            func((await this.getJsonItem(KEY_DEVICE_DATA)) as IDeviceData | null);
        });
    }

    public storeEndToEndDeviceData(deviceData: IDeviceData, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(KEY_DEVICE_DATA, deviceData);
        });
    }

    public storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this.setJsonItem(keyEndToEndRoom(roomId), roomInfo);
        });
    }

    public getEndToEndRooms(txn: unknown, func: (rooms: Record<string, IRoomEncryption>) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(ROOMS_PREFIX));
            const result: Record<string, IRoomEncryption> = {};
            for (const k of keys) {
                const roomId = k.slice(ROOMS_PREFIX.length);
                result[roomId] = (await this.getJsonItem(k)) as IRoomEncryption;
            }
            func(result);
        });
    }

    public async getSessionsNeedingBackup(limit: number): Promise<ISession[]> {
        const sessionsNeedingBackup = ((await this.getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {}) as {
            [sessionKey: string]: boolean;
        };
        const sessions: ISession[] = [];

        for (const k of Object.keys(sessionsNeedingBackup)) {
            const keyParts = k.split("/");
            const senderKey = decodeURIComponent(keyParts[0]);
            const sessionId = decodeURIComponent(keyParts[1]);

            const sessionData = (await this.getJsonItem(
                keyEndToEndInboundGroupSession(senderKey, sessionId),
            )) as InboundGroupSessionData | null;
            if (!sessionData) {
                console.error(`Could not find session data for inbound group session with ${sessionId}`);
                continue;
            }

            sessions.push({ senderKey, sessionId, sessionData });

            if (limit && sessions.length >= limit) {
                break;
            }
        }

        return sessions;
    }

    public async countSessionsNeedingBackup(txn?: unknown): Promise<number> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup = ((await this.getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {}) as {
            [sessionKey: string]: boolean;
        };
        return Object.keys(sessionsNeedingBackup).length;
    }

    public async unmarkSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup = ((await this.getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {}) as {
            [sessionKey: string]: boolean;
        };
        for (const session of sessions) {
            delete sessionsNeedingBackup[
                encodeURIComponent(session.senderKey) + "/" + encodeURIComponent(session.sessionId)
            ];
        }
        await this.setJsonItem(KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup);
    }

    public async markSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup = ((await this.getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {}) as {
            [sessionKey: string]: boolean;
        };
        for (const session of sessions) {
            sessionsNeedingBackup[encodeURIComponent(session.senderKey) + "/" + encodeURIComponent(session.sessionId)] =
                true;
        }
        await this.setJsonItem(KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup);
    }

    public async addSharedHistoryInboundGroupSession(
        roomId: string,
        senderKey: string,
        sessionId: string,
        txn?: unknown,
    ): Promise<void> {
        // TODO: How to handle txn here?
        const key = keySharedHistoryInboundGroupSessions(roomId);
        const sessions = ((await this.getJsonItem(key)) ?? []) as [senderKey: string, sessionId: string][];
        sessions.push([senderKey, sessionId]);
        await this.setJsonItem(key, sessions);
    }

    public async getSharedHistoryInboundGroupSessions(
        roomId: string,
        txn?: unknown,
    ): Promise<[senderKey: string, sessionId: string][]> {
        // TODO: How to handle txn here?
        const sessions = ((await this.getJsonItem(keySharedHistoryInboundGroupSessions(roomId))) ?? []) as [
            senderKey: string,
            sessionId: string,
        ][];
        return sessions;
    }

    public async addParkedSharedHistory(roomId: string, data: ParkedSharedHistory, txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const parked = ((await this.getJsonItem(keyParkedSharedHistory(roomId))) ?? []) as ParkedSharedHistory[];
        parked.push(data);
        await this.setJsonItem(keyParkedSharedHistory(roomId), parked);
    }

    public async takeParkedSharedHistory(roomId: string, txn?: unknown): Promise<ParkedSharedHistory[]> {
        // TODO: How to handle txn here?
        const key = keyParkedSharedHistory(roomId);
        const parked = ((await this.getJsonItem(key)) ?? []) as ParkedSharedHistory[];
        await this.storage.removeItem(key);
        return parked;
    }

    public doTxn<T>(
        mode: Mode,
        stores: Iterable<string>,
        func: (txn: unknown) => T,
        log?: Logger | undefined,
    ): Promise<T> {
        const txn = new Transaction();
        const promise = txn.getPromise();
        const result = func(txn);
        return promise.then(() => {
            return result;
        });
    }
}
