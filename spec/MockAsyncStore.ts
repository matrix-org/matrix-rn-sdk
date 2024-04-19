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

import AsyncStore from "../src/AsyncStore";

export default class MockAsyncStore implements AsyncStore {
    private data = new Map<string, string>();

    public clear(): void {
        this.data.clear();
    }

    public async getAllKeys(): Promise<string[]> {
        return [...this.data.keys()];
    }

    public async getItem(key: string): Promise<string | null> {
        const item = this.data.get(key);
        return item === undefined ? null : item;
    }

    public async setItem(key: string, value: string): Promise<void> {
        this.data.set(key, value);
    }

    public async removeItem(key: string): Promise<void> {
        this.data.delete(key);
    }
}
