// Copyright (c) 2026. Qian Cheng. Licensed under GPL v3

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
    [key: string]: JsonValue | undefined;
}
