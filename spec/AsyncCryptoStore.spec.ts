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

import { IDeviceData } from "matrix-js-sdk/lib/crypto/store/base";

import AsyncCryptoStore from "../src/AsyncCryptoStore";
import MockAsyncStore from "./MockAsyncStore";

describe("AsyncCryptoStore", () => {
    const mockAsyncStore = new MockAsyncStore();
    let asyncCryptoStore = new AsyncCryptoStore(mockAsyncStore);

    beforeEach(async () => {
        mockAsyncStore.clear();
        asyncCryptoStore = new AsyncCryptoStore(mockAsyncStore);
    });

    test("counts number of end to end sessions", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndSession("adevicekey", "sess1", { sessionId: "some-id" }, txn);
            await asyncCryptoStore.storeEndToEndSession("adevicekey", "sess2", { sessionId: "another-id" }, txn);
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.countEndToEndSessions(txn, (count) => {
                expect(count).toEqual(2);
            });
        });
    });

    test("stores & retrieves end to end sessions", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndSession("adevicekey", "sess1", { sessionId: "some-id" }, txn);
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndSession("adevicekey", "sess1", txn, (sessionData) => {
                expect(sessionData).toEqual({ sessionId: "some-id" });
            });
        });
    });

    test("stores & retrieves multiple end to end sessions", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndSession("dev1", "sess1", { sessionId: "some-id" }, txn);
            await asyncCryptoStore.storeEndToEndSession("dev1", "sess2", { sessionId: "another-id" }, txn);
            await asyncCryptoStore.storeEndToEndSession("dev2", "sess1", { sessionId: "yet-another-id" }, txn);
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndSessions("dev1", txn, (sessions) => {
                expect(sessions["sess1"]).toEqual({ sessionId: "some-id" });
                expect(sessions["sess2"]).toEqual({ sessionId: "another-id" });
                expect(Object.keys(sessions).length).toEqual(2);
            });
        });
    });

    test("addEndToEndInboundGroupSession adds only the first", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.addEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.addEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "another-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                txn,
                (sessiondata, withheld) => {
                    expect(sessiondata).toEqual({
                        room_id: "some-id",
                        session: "some-session",
                        forwardingCurve25519KeyChain: [],
                    });
                },
            );
        });
    });

    test("storeEndToEndInboundGroupSession overwrites", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "another-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                txn,
                (sessiondata, withheld) => {
                    expect(sessiondata).toEqual({
                        room_id: "some-id",
                        session: "another-session",
                        forwardingCurve25519KeyChain: [],
                    });
                },
            );
        });
    });

    test("getAllEndToEndInboundGroupSessions gets all end to end sessions", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey1",
                "sessid2",
                {
                    room_id: "some-id",
                    session: "another-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey2",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "yet-another-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getAllEndToEndInboundGroupSessions(txn, cb);
        });

        expect(cb.mock.calls.length).toEqual(4);

        // technically these don't need to be in order
        expect(cb.mock.calls[0][0]).toEqual({
            senderKey: "senderkey1",
            sessionId: "sessid1",
            sessionData: {
                room_id: "some-id",
                session: "some-session",
                forwardingCurve25519KeyChain: [],
            },
        });
        expect(cb.mock.calls[1][0]).toEqual({
            senderKey: "senderkey1",
            sessionId: "sessid2",
            sessionData: {
                room_id: "some-id",
                session: "another-session",
                forwardingCurve25519KeyChain: [],
            },
        });
        expect(cb.mock.calls[2][0]).toEqual({
            senderKey: "senderkey2",
            sessionId: "sessid1",
            sessionData: {
                room_id: "some-id",
                session: "yet-another-session",
                forwardingCurve25519KeyChain: [],
            },
        });

        expect(cb.mock.calls[3][0]).toEqual(null);
    });

    test("end to end group session keys and values can contain slashes", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "this/that",
                "here/there",
                {
                    room_id: "some/id",
                    session: "some/session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getAllEndToEndInboundGroupSessions(txn, cb);
        });

        expect(cb.mock.calls[0][0]).toEqual({
            senderKey: "this/that",
            sessionId: "here/there",
            sessionData: {
                room_id: "some/id",
                session: "some/session",
                forwardingCurve25519KeyChain: [],
            },
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndInboundGroupSession(
                "this/that",
                "here/there",
                txn,
                (sessiondata, withheld) => {
                    expect(sessiondata).toEqual({
                        room_id: "some/id",
                        session: "some/session",
                        forwardingCurve25519KeyChain: [],
                    });
                },
            );
        });
    });

    test("stores witheld session data", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
            await asyncCryptoStore.storeEndToEndInboundGroupSessionWithheld(
                "senderkey1",
                "sessid1",
                {
                    room_id: "some-id",
                    code: "some-code",
                    reason: "some-reason",
                },
                txn,
            );
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndInboundGroupSession(
                "senderkey1",
                "sessid1",
                txn,
                (sessiondata, withheld) => {
                    expect(sessiondata).toEqual({
                        room_id: "some-id",
                        session: "some-session",
                        forwardingCurve25519KeyChain: [],
                    });
                    expect(withheld).toEqual({
                        room_id: "some-id",
                        code: "some-code",
                        reason: "some-reason",
                    });
                },
            );
        });
    });

    test("stores device data", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndDeviceData(
                {
                    devices: {},
                    trackingStatus: {},
                },
                txn,
            );
        });

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndDeviceData(txn, (devData) => {
                expect(devData).toEqual({
                    devices: {},
                    trackingStatus: {},
                });
            });
        });
    });

    test("stores end to end rooms", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndRoom("5", { algorithm: "some-algorithm" }, txn);
            await asyncCryptoStore.storeEndToEndRoom("101", { algorithm: "another-algorithm" }, txn);
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndRooms(txn, cb);
        });

        expect(cb.mock.calls[0][0]).toEqual({
            "5": { algorithm: "some-algorithm" },
            "101": { algorithm: "another-algorithm" },
        });
    });

    test("marks and unmarks sessions needing backup", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "bob",
                "one",
                {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndInboundGroupSession(
                "bob",
                "two",
                {
                    room_id: "another-id",
                    session: "another-session",
                    forwardingCurve25519KeyChain: [],
                },
                txn,
            );
        });

        expect(await asyncCryptoStore.countSessionsNeedingBackup()).toEqual(0);
        expect(await asyncCryptoStore.getSessionsNeedingBackup(0)).toEqual([]);

        await asyncCryptoStore.markSessionsNeedingBackup([{ senderKey: "bob", sessionId: "one" }]);

        expect(await asyncCryptoStore.countSessionsNeedingBackup()).toEqual(1);
        expect(await asyncCryptoStore.getSessionsNeedingBackup(0)).toEqual([
            {
                senderKey: "bob",
                sessionId: "one",
                sessionData: {
                    room_id: "some-id",
                    session: "some-session",
                    forwardingCurve25519KeyChain: [],
                },
            },
        ]);

        await asyncCryptoStore.unmarkSessionsNeedingBackup([{ senderKey: "bob", sessionId: "one" }]);

        expect(await asyncCryptoStore.countSessionsNeedingBackup()).toEqual(0);
        expect(await asyncCryptoStore.getSessionsNeedingBackup(0)).toEqual([]);
    });

    test("stores & retrieves account", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeAccount(txn, "thingamabob");
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getAccount(txn, cb);
        });

        expect(cb.mock.calls[0][0]).toEqual("thingamabob");
    });

    test("stores & retrieves cross signing keys", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeCrossSigningKeys(txn, {
                "some-key": {
                    keys: {},
                    usage: [],
                    user_id: "some-id",
                },
            });
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getCrossSigningKeys(txn, cb);
        });

        expect(cb.mock.calls[0][0]).toEqual({
            "some-key": {
                keys: {},
                usage: [],
                user_id: "some-id",
            },
        });
    });

    test("stores & retrieves secret store keys", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeSecretStorePrivateKey(txn, "m.megolm_backup.v1", {
                iv: "some-iv",
                ciphertext: "some-ciphertext",
                mac: "some-mac",
            });
        });

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getSecretStorePrivateKey(txn, cb, "m.megolm_backup.v1");
        });

        expect(cb.mock.calls[0][0]).toEqual({
            iv: "some-iv",
            ciphertext: "some-ciphertext",
            mac: "some-mac",
        });
    });

    test("deleteAllData deletes only E2E data", async () => {
        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.storeEndToEndSession("adevicekey", "sess1", { session: "some-session" }, txn);
        });

        await mockAsyncStore.setItem("someOtherData", "preciousData");

        await asyncCryptoStore.deleteAllData();

        const cb = jest.fn();

        await asyncCryptoStore.doTxn("readwrite", [], async (txn) => {
            await asyncCryptoStore.getEndToEndSession("adevicekey", "sess1", txn, cb);
        });

        expect(cb.mock.calls[0][0]).toEqual(null);

        expect(await mockAsyncStore.getItem("someOtherData")).toEqual("preciousData");
    });
});
