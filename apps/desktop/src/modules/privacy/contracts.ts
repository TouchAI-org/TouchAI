export type { PrivacyFilterSettings } from './settings';
export * from '@/config/privacy';

import type { PrivacyProtectionKind, PrivacyProtectionRule } from '@/config/privacy';

export interface PrivacyRestoredSpan {
    start: number;
    end: number;
    original: string;
    placeholder: string;
    kind: PrivacyProtectionKind;
    rule?: PrivacyProtectionRule;
}

export interface PrivacyReviewAnnotation extends PrivacyRestoredSpan {
    messageId: number | string;
    textHash: string;
}

export interface PrivacyReviewSnapshot {
    generation: number;
    annotations: readonly PrivacyReviewAnnotation[];
}
