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
    private error: any = null;

    private resolve: ((value: void | PromiseLike<void>) => void) | null = null;
    private reject: ((reason?: any) => void) | null = null;

    private promise = new Promise<void>((resolve, reject) => {
        this.resolve = resolve;
        this.reject = reject;
    });

    getPromise(): Promise<void> {
        return this.promise;
    }

    async execute(func: () => Promise<void>) {
        this.onOperationStarted();
        try {
            await func();
        } catch (e) {
            this.error = e;
        } finally {
            this.onOperationEnded();
        }
    }

    private onOperationStarted() {
        if (this.resolve === null) {
            throw new Error("Tried to start a new operation on a completed transaction");
        }
        this.numOps += 1;
    }

    private onOperationEnded() {
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

    constructor(private storage: AsyncCryptoStorage) {}

    async _getAllOutgoingKeyRequestKeys(): Promise<string[]> {
        return (await this.storage.getAllKeys()).filter((k) => k.startsWith(OUTGOING_KEY_REQUEST_PREFIX));
    }

    async _getJsonItem(key: string): Promise<any> {
        const item = await this.storage.getItem(key);
        if (item === null) {
            return null;
        }
        return JSON.parse(item);
    }

    async _setJsonItem(key: string, val: any): Promise<void> {
        return this.storage.setItem(key, JSON.stringify(val));
    }

    // CryptoStore

    async containsData(): Promise<boolean> {
        return this.initialized;
    }

    async startup(): Promise<CryptoStore> {
        this.initialized = true;
        return this;
    }

    async deleteAllData(): Promise<void> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(E2E_PREFIX));
        for (const key of keys) {
            await this.storage.removeItem(key);
        }
    }

    async getMigrationState(): Promise<MigrationState> {
        return (await this._getJsonItem(KEY_END_TO_END_MIGRATION_STATE)) ?? MigrationState.NOT_STARTED;
    }

    async setMigrationState(migrationState: MigrationState): Promise<void> {
        await this._setJsonItem(KEY_END_TO_END_MIGRATION_STATE, migrationState);
    }

    async getOrAddOutgoingRoomKeyRequest(request: OutgoingRoomKeyRequest): Promise<OutgoingRoomKeyRequest> {
        const req = await this.getOutgoingRoomKeyRequest(request.requestBody);
        if (req) {
            return req;
        }
        await this._setJsonItem(keyOutgoingKeyRequest(request.requestId), request);
        return request;
    }

    async getOutgoingRoomKeyRequest(requestBody: IRoomKeyRequestBody): Promise<OutgoingRoomKeyRequest | null> {
        for (const key of await this._getAllOutgoingKeyRequestKeys()) {
            const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (
                req.requestBody.room_id === requestBody.room_id &&
                req.requestBody.session_id === requestBody.session_id
            ) {
                return req;
            }
        }
        return null;
    }

    async getOutgoingRoomKeyRequestByState(wantedStates: number[]): Promise<OutgoingRoomKeyRequest | null> {
        for (const key of await this._getAllOutgoingKeyRequestKeys()) {
            const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (wantedStates.includes(req.state)) {
                return req;
            }
        }
        return null;
    }

    async getAllOutgoingRoomKeyRequestsByState(wantedState: number): Promise<OutgoingRoomKeyRequest[]> {
        const reqs: OutgoingRoomKeyRequest[] = [];
        for (const key of await this._getAllOutgoingKeyRequestKeys()) {
            const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (req.state == wantedState) {
                reqs.push(req);
            }
        }
        return reqs;
    }

    async getOutgoingRoomKeyRequestsByTarget(
        userId: string,
        deviceId: string,
        wantedStates: number[],
    ): Promise<OutgoingRoomKeyRequest[]> {
        const reqs: OutgoingRoomKeyRequest[] = [];
        for (const key of await this._getAllOutgoingKeyRequestKeys()) {
            const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
            if (
                wantedStates.includes(req.state) &&
                req.recipients.some((r) => r.userId === userId && r.deviceId === deviceId)
            ) {
                reqs.push(req);
            }
        }
        return reqs;
    }

    async updateOutgoingRoomKeyRequest(
        requestId: string,
        expectedState: number,
        updates: Partial<OutgoingRoomKeyRequest>,
    ): Promise<OutgoingRoomKeyRequest | null> {
        const key = keyOutgoingKeyRequest(requestId);

        const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
        if (!req || req.state !== expectedState) {
            return null;
        }

        Object.assign(req, updates);
        await this._setJsonItem(key, req);
        return req;
    }

    async deleteOutgoingRoomKeyRequest(
        requestId: string,
        expectedState: number,
    ): Promise<OutgoingRoomKeyRequest | null> {
        const key = keyOutgoingKeyRequest(requestId);

        const req = (await this._getJsonItem(key)) as OutgoingRoomKeyRequest;
        if (!req || req.state !== expectedState) {
            return null;
        }

        await this.storage.removeItem(key);
        return req;
    }

    getAccount(txn: unknown, func: (accountPickle: string | null) => void): void {
        (txn as Transaction).execute(async () => {
            const accountPickle = await this._getJsonItem(KEY_END_TO_END_ACCOUNT);
            func(accountPickle);
        });
    }

    storeAccount(txn: unknown, accountPickle: string): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(KEY_END_TO_END_ACCOUNT, accountPickle);
        });
    }

    getCrossSigningKeys(txn: unknown, func: (keys: Record<string, CrossSigningKeyInfo> | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = await this._getJsonItem(KEY_CROSS_SIGNING_KEYS);
            func(keys);
        });
    }

    getSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        func: (key: SecretStorePrivateKeys[K] | null) => void,
        type: K,
    ): void {
        (txn as Transaction).execute(async () => {
            const key = await this._getJsonItem(keySecretStorePrivateKey(type));
            func(key);
        });
    }

    storeCrossSigningKeys(txn: unknown, keys: Record<string, CrossSigningKeyInfo>): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(KEY_CROSS_SIGNING_KEYS, keys);
        });
    }

    storeSecretStorePrivateKey<K extends keyof SecretStorePrivateKeys>(
        txn: unknown,
        type: K,
        key: SecretStorePrivateKeys[K],
    ): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(keySecretStorePrivateKey(type), key);
        });
    }

    countEndToEndSessions(txn: unknown, func: (count: number) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            const count = keys.filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX)).length;
            func(count);
        });
    }

    getEndToEndSession(
        deviceKey: string,
        sessionId: string,
        txn: unknown,
        func: (session: ISessionInfo | null) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const session = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
            func(session);
        });
    }

    getEndToEndSessions(
        deviceKey: string,
        txn: unknown,
        func: (sessions: { [sessionId: string]: ISessionInfo }) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            const prefix = prefixEndToEndSession(deviceKey);
            const sessions = {};
            for (const k of keys.filter((k) => k.startsWith(prefix))) {
                const sessionId = decodeURIComponent(k.split("/")[2]);
                // TODO: Can we not just use k directly here?
                (sessions as any)[sessionId] = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
            }
            func(sessions);
        });
    }

    getAllEndToEndSessions(txn: unknown, func: (session: ISessionInfo | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = await this.storage.getAllKeys();
            for (const k of keys.filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX))) {
                const deviceKey = decodeURIComponent(k.split("/")[1]);
                const sessionId = decodeURIComponent(k.split("/")[2]);
                // TODO: Can we not just use k directly here?
                const sessionInfo = await this._getJsonItem(keyEndToEndSession(deviceKey, sessionId));
                func(sessionInfo);
            }
        });
    }

    storeEndToEndSession(deviceKey: string, sessionId: string, sessionInfo: ISessionInfo, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(keyEndToEndSession(deviceKey, sessionId), sessionInfo);
        });
    }

    async storeEndToEndSessionProblem(deviceKey: string, type: string, fixed: boolean): Promise<void> {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = ((await this._getJsonItem(key)) || []) as IProblem[];
        problems.push({ type, fixed, time: Date.now() });
        problems.sort((a, b) => a.time - b.time);
        await this._setJsonItem(key, problems);
    }

    async getEndToEndSessionProblem(deviceKey: string, timestamp: number): Promise<IProblem | null> {
        const key = keyEndToEndSessionProblems(deviceKey);
        const problems = ((await this._getJsonItem(key)) || []) as IProblem[];
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

    async filterOutNotifiedErrorDevices(devices: IOlmDevice<DeviceInfo>[]): Promise<IOlmDevice<DeviceInfo>[]> {
        const notifiedErrorDevices: { [userId: string]: { [deviceId: string]: boolean } } =
            (await this._getJsonItem(KEY_NOTIFIED_ERROR_DEVICES)) || {};

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

        await this._setJsonItem(KEY_NOTIFIED_ERROR_DEVICES, notifiedErrorDevices);

        return ret;
    }

    async getEndToEndSessionsBatch(): Promise<ISessionInfo[] | null> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(END_TO_END_SESSION_PREFIX));

        const result: ISessionInfo[] = [];

        for (const k of keys) {
            const session: ISessionInfo | null = await this._getJsonItem(k);
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

    async deleteEndToEndSessionsBatch(
        sessions: { deviceKey?: string | undefined; sessionId?: string | undefined }[],
    ): Promise<void> {
        for (const { deviceKey, sessionId } of sessions) {
            if (deviceKey === undefined || sessionId === undefined) {
                continue;
            }
            await this.storage.removeItem(keyEndToEndSession(deviceKey, sessionId));
        }
    }

    getEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        txn: unknown,
        func: (groupSession: InboundGroupSessionData | null, groupSessionWithheld: IWithheld | null) => void,
    ): void {
        (txn as Transaction).execute(async () => {
            const groupSession: InboundGroupSessionData | null = await this._getJsonItem(
                keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId),
            );
            const groupSessionWithheld: IWithheld | null = await this._getJsonItem(
                keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
            );
            func(groupSession, groupSessionWithheld);
        });
    }

    getAllEndToEndInboundGroupSessions(txn: unknown, func: (session: ISession | null) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX));

            for (const k of keys) {
                const keyParts = k.split("/");
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
        });
    }

    addEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            const existing = await this._getJsonItem(keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId));
            if (!existing) {
                await this.storeEndToEndInboundGroupSession(senderCurve25519Key, sessionId, sessionData, txn);
            }
        });
    }

    storeEndToEndInboundGroupSession(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: InboundGroupSessionData,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(keyEndToEndInboundGroupSession(senderCurve25519Key, sessionId), sessionData);
        });
    }

    storeEndToEndInboundGroupSessionWithheld(
        senderCurve25519Key: string,
        sessionId: string,
        sessionData: IWithheld,
        txn: unknown,
    ): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(
                keyEndToEndInboundGroupSessionWithheld(senderCurve25519Key, sessionId),
                sessionData,
            );
        });
    }

    async countEndToEndInboundGroupSessions(): Promise<number> {
        return (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX)).length;
    }

    async getEndToEndInboundGroupSessionsBatch(): Promise<SessionExtended[] | null> {
        const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(INBOUND_SESSION_PREFIX));

        const result: SessionExtended[] = [];

        for (const k of keys) {
            const keyParts = k.split("/");
            const senderKey = decodeURIComponent(keyParts[1]);
            const sessionId = decodeURIComponent(keyParts[2]);
            const sessionData = await this._getJsonItem(k);

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

    async deleteEndToEndInboundGroupSessionsBatch(sessions: { senderKey: string; sessionId: string }[]): Promise<void> {
        for (const { senderKey, sessionId } of sessions) {
            await this.storage.removeItem(keyEndToEndInboundGroupSession(senderKey, sessionId));
        }
    }

    getEndToEndDeviceData(txn: unknown, func: (deviceData: IDeviceData | null) => void): void {
        (txn as Transaction).execute(async () => {
            func(await this._getJsonItem(KEY_DEVICE_DATA));
        });
    }

    storeEndToEndDeviceData(deviceData: IDeviceData, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(KEY_DEVICE_DATA, deviceData);
        });
    }

    storeEndToEndRoom(roomId: string, roomInfo: IRoomEncryption, txn: unknown): void {
        (txn as Transaction).execute(async () => {
            await this._setJsonItem(keyEndToEndRoom(roomId), roomInfo);
        });
    }

    getEndToEndRooms(txn: unknown, func: (rooms: Record<string, IRoomEncryption>) => void): void {
        (txn as Transaction).execute(async () => {
            const keys = (await this.storage.getAllKeys()).filter((k) => k.startsWith(ROOMS_PREFIX));
            const result: Record<string, IRoomEncryption> = {};
            for (const k of keys) {
                const roomId = k.slice(ROOMS_PREFIX.length);
                result[roomId] = await this._getJsonItem(k);
            }
            func(result);
        });
    }

    async getSessionsNeedingBackup(limit: number): Promise<ISession[]> {
        const sessionsNeedingBackup: { [sessionKey: string]: boolean } =
            (await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {};
        const sessions: ISession[] = [];

        for (const k of Object.keys(sessionsNeedingBackup)) {
            const keyParts = k.split("/");
            const senderKey = decodeURIComponent(keyParts[0]);
            const sessionId = decodeURIComponent(keyParts[1]);

            const sessionData: InboundGroupSessionData | null = await this._getJsonItem(
                keyEndToEndInboundGroupSession(senderKey, sessionId),
            );
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

    async countSessionsNeedingBackup(txn?: unknown): Promise<number> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup: { [sessionKey: string]: boolean } =
            (await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {};
        return Object.keys(sessionsNeedingBackup).length;
    }

    async unmarkSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup: { [sessionKey: string]: boolean } =
            (await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {};
        for (const session of sessions) {
            delete sessionsNeedingBackup[
                encodeURIComponent(session.senderKey) + "/" + encodeURIComponent(session.sessionId)
            ];
        }
        await this._setJsonItem(KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup);
    }

    async markSessionsNeedingBackup(sessions: ISession[], txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const sessionsNeedingBackup: { [sessionKey: string]: boolean } =
            (await this._getJsonItem(KEY_SESSIONS_NEEDING_BACKUP)) || {};
        for (const session of sessions) {
            sessionsNeedingBackup[encodeURIComponent(session.senderKey) + "/" + encodeURIComponent(session.sessionId)] =
                true;
        }
        await this._setJsonItem(KEY_SESSIONS_NEEDING_BACKUP, sessionsNeedingBackup);
    }

    async addSharedHistoryInboundGroupSession(
        roomId: string,
        senderKey: string,
        sessionId: string,
        txn?: unknown,
    ): Promise<void> {
        // TODO: How to handle txn here?
        const key = keySharedHistoryInboundGroupSessions(roomId);
        const sessions: [senderKey: string, sessionId: string][] = (await this._getJsonItem(key)) ?? [];
        sessions.push([senderKey, sessionId]);
        await this._setJsonItem(key, sessions);
    }

    async getSharedHistoryInboundGroupSessions(
        roomId: string,
        txn?: unknown,
    ): Promise<[senderKey: string, sessionId: string][]> {
        // TODO: How to handle txn here?
        const sessions: [senderKey: string, sessionId: string][] =
            (await this._getJsonItem(keySharedHistoryInboundGroupSessions(roomId))) ?? [];
        return sessions;
    }

    async addParkedSharedHistory(roomId: string, data: ParkedSharedHistory, txn?: unknown): Promise<void> {
        // TODO: How to handle txn here?
        const parked: ParkedSharedHistory[] = (await this._getJsonItem(keyParkedSharedHistory(roomId))) ?? [];
        parked.push(data);
        await this._setJsonItem(keyParkedSharedHistory(roomId), parked);
    }

    async takeParkedSharedHistory(roomId: string, txn?: unknown): Promise<ParkedSharedHistory[]> {
        // TODO: How to handle txn here?
        const key = keyParkedSharedHistory(roomId);
        const parked: ParkedSharedHistory[] = (await this._getJsonItem(key)) ?? [];
        await this.storage.removeItem(key);
        return parked;
    }

    doTxn<T>(mode: Mode, stores: Iterable<string>, func: (txn: unknown) => T, log?: Logger | undefined): Promise<T> {
        const txn = new Transaction();
        const promise = txn.getPromise();
        const result = func(txn);
        return promise.then(() => {
            return result;
        });
    }
}
