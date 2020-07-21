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

const AsyncCryptoStore = require('../src/AsyncCryptoStore');
const MockAsyncStore = require('./MockAsyncStore');

let asyncCryptoStore;

/*
 * NB. these tests apply equally to any crypto store and could be ported into the js-sdk
 * in general, except for the fact that these tests rely on the functions returning promises
 * thay resolve when they're done. This allows the tests to fail in a sensible way if the
 * impl doesn't call the callback at all.
 */

beforeEach(async () => {
    MockAsyncStore.clear();
    asyncCryptoStore = new AsyncCryptoStore(MockAsyncStore);
});

test('counts number of end to end sessions', async () => {
    await asyncCryptoStore.storeEndToEndSession('adevicekey', 'sess1', 'somedata', null);
    await asyncCryptoStore.storeEndToEndSession('adevicekey', 'sess2', 'moredata', null);

    return new Promise(resolve => {
        asyncCryptoStore.countEndToEndSessions(null, count => {
            expect(count).toEqual(2);
            resolve();
        });
    });
});

test('stores & retrieves end to end sessions', async () => {
    await asyncCryptoStore.storeEndToEndSession('adevicekey', 'sess1', 'somedata', null);

    return new Promise(resolve => {
        asyncCryptoStore.getEndToEndSession('adevicekey', 'sess1', null, sessionData => {
            expect(sessionData).toEqual('somedata');
            resolve();
        });
    });
});

test('stores & retrieves multiple end to end sessions', async () => {
    await asyncCryptoStore.storeEndToEndSession('dev1', 'sess1', 'thisissess1', null);
    await asyncCryptoStore.storeEndToEndSession('dev1', 'sess2', 'thisissess2', null);
    await asyncCryptoStore.storeEndToEndSession('dev2', 'sess1', 'thisissess1dev2', null);

    await asyncCryptoStore.getEndToEndSessions('dev1', null, sessions => {
        expect(sessions['sess1']).toEqual('thisissess1');
        expect(sessions['sess2']).toEqual('thisissess2');
        expect(Object.keys(sessions).length).toEqual(2);
    });
});

test('addEndToEndInboundGroupSession adds only the first', async () => {
    await asyncCryptoStore.addEndToEndInboundGroupSession('senderkey1', 'sessid1', 'manydata', null);
    await asyncCryptoStore.addEndToEndInboundGroupSession('senderkey1', 'sessid1', 'differentdata', null);

    await asyncCryptoStore.getEndToEndInboundGroupSession('senderkey1', 'sessid1', null, (sessiondata, withheld) => {
        expect(sessiondata).toEqual('manydata');
    });
});

test('storeEndToEndInboundGroupSession overwrites', async () => {
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey1', 'sessid1', 'manydata', null);
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey1', 'sessid1', 'differentdata', null);

    await asyncCryptoStore.getEndToEndInboundGroupSession('senderkey1', 'sessid1', null, (sessiondata, withheld) => {
        expect(sessiondata).toEqual('differentdata');
    });
});

test('getAllEndToEndInboundGroupSessions gets all end to end sessions', async () => {
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey1', 'sessid1', 'beep', null);
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey1', 'sessid2', 'boop', null);
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey2', 'sessid1', 'burp', null);

    const cb = jest.fn();

    await asyncCryptoStore.getAllEndToEndInboundGroupSessions(null, cb);

    expect(cb.mock.calls.length).toEqual(4);
    // technically these don't need to be in order
    expect(cb.mock.calls[0][0]).toEqual({senderKey: 'senderkey1', sessionId: 'sessid1', sessionData: 'beep'});
    expect(cb.mock.calls[1][0]).toEqual({senderKey: 'senderkey1', sessionId: 'sessid2', sessionData: 'boop'});
    expect(cb.mock.calls[2][0]).toEqual({senderKey: 'senderkey2', sessionId: 'sessid1', sessionData: 'burp'});
    expect(cb.mock.calls[3][0]).toEqual(null);
});

test('end to end group session keys and values can contain slashes', async () => {
    await asyncCryptoStore.storeEndToEndInboundGroupSession('this/that', 'here/there', 'now/then', null);

    const cb = jest.fn();
    await asyncCryptoStore.getAllEndToEndInboundGroupSessions(null, cb);
    expect(cb.mock.calls[0][0]).toEqual({senderKey: 'this/that', sessionId: 'here/there', sessionData: 'now/then'});

    await asyncCryptoStore.getEndToEndInboundGroupSession('this/that', 'here/there', null, (sessiondata, withheld) => {
        expect(sessiondata).toEqual('now/then');
    });
});

test('stores witheld session data', async () => {
    await asyncCryptoStore.storeEndToEndInboundGroupSession('senderkey1', 'sessid1', 'manydata', null);
    await asyncCryptoStore.storeEndToEndInboundGroupSessionWithheld(
        'senderkey1', 'sessid1', 'withheld_because_i_just_cant_even', null,
    );

    await asyncCryptoStore.getEndToEndInboundGroupSession('senderkey1', 'sessid1', null, (sessiondata, withheld) => {
        expect(sessiondata).toEqual('manydata');
        expect(withheld).toEqual('withheld_because_i_just_cant_even');
    });
});

test('stores device data', async () => {
    const theData = {data1: 'suchdata', data2: 'manydata'};

    await asyncCryptoStore.storeEndToEndDeviceData(theData, null);
    await asyncCryptoStore.getEndToEndDeviceData(null, devData => {
        expect(devData).toEqual(theData);
    });
});

test('stores end to end rooms', async () => {
    await asyncCryptoStore.storeEndToEndRoom('5', {info: 'bleep'}, null);
    await asyncCryptoStore.storeEndToEndRoom('101', {info: 'bloop'}, null);

    const cb = jest.fn();
    await asyncCryptoStore.getEndToEndRooms(null, cb);

    expect(cb.mock.calls[0][0]).toEqual({
        '5': {info: 'bleep'},
        '101': {info: 'bloop'},
    });
});

test('marks and unmarks sessions needing backup', async () => {
    await asyncCryptoStore.storeEndToEndInboundGroupSession('bob', 'one', 'data', null);
    await asyncCryptoStore.storeEndToEndInboundGroupSession('bob', 'two', 'data', null);

    {
        const numSessionsNeedingBackup = await asyncCryptoStore.countSessionsNeedingBackup();
        expect(numSessionsNeedingBackup).toEqual(0);
        const sessionsNeedingBackup = await asyncCryptoStore.getSessionsNeedingBackup();
        expect(sessionsNeedingBackup).toEqual([]);
    }

    await asyncCryptoStore.markSessionsNeedingBackup([{
        senderKey: 'bob',
        sessionId: 'one',
    }]);

    {
        const numSessionsNeedingBackup = await asyncCryptoStore.countSessionsNeedingBackup();
        expect(numSessionsNeedingBackup).toEqual(1);
        const sessionsNeedingBackup = await asyncCryptoStore.getSessionsNeedingBackup();
        expect(sessionsNeedingBackup).toEqual([{
            senderKey: 'bob',
            sessionId: 'one',
            sessionData: 'data',
        }]);
    }

    await asyncCryptoStore.unmarkSessionsNeedingBackup([{
        senderKey: 'bob',
        sessionId: 'one',
    }]);

    {
        const numSessionsNeedingBackup = await asyncCryptoStore.countSessionsNeedingBackup();
        expect(numSessionsNeedingBackup).toEqual(0);
        const sessionsNeedingBackup = await asyncCryptoStore.getSessionsNeedingBackup();
        expect(sessionsNeedingBackup).toEqual([]);
    }
});

test('stores & retrieves account', async () => {
    await asyncCryptoStore.storeAccount(null, {thingy: 'thingamabob'});

    const cb = jest.fn();
    await asyncCryptoStore.getAccount(null, cb);
    expect(cb.mock.calls[0][0]).toEqual({thingy: 'thingamabob'});
});

test('stores & retrieves cross signing keys', async () => {
    await asyncCryptoStore.storeCrossSigningKeys(null, {thingy: 'thingamabob'});

    const cb = jest.fn();
    await asyncCryptoStore.getCrossSigningKeys(null, cb);
    expect(cb.mock.calls[0][0]).toEqual({thingy: 'thingamabob'});
});

test('stores & retrieves secret store keys', async () => {
    await asyncCryptoStore.storeSecretStorePrivateKey(null, 'thekey', 'thesecret');

    const cb = jest.fn();
    await asyncCryptoStore.getSecretStorePrivateKey(null, cb, 'thekey');
    expect(cb.mock.calls[0][0]).toEqual('thesecret');
});

test('deleteAllData deletes only E2E data', async () => {
    await asyncCryptoStore.storeEndToEndSession('adevicekey', 'sess1', 'somedata', null);
    await MockAsyncStore.setItem('someOtherData', 'preciousData');

    await asyncCryptoStore.deleteAllData();

    const cb = jest.fn();
    await asyncCryptoStore.getEndToEndSession('adevicekey', 'sess1', null, cb);
    expect(cb.mock.calls[0][0]).toEqual(null);

    const otherData = await MockAsyncStore.getItem('someOtherData');
    expect(otherData).toEqual('preciousData');
});
