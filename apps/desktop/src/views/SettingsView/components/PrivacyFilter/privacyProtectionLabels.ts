import { type MessageKey, t } from '@/i18n';
import type {
    PrivacyFilterModelId,
    PrivacyProtectionKind,
    PrivacyProtectionRuleMatch,
} from '@/services/NativeService/privacyFilter';

export const privacyProtectionKindLabels: Record<PrivacyProtectionKind, MessageKey> = {
    secret: 'settings.privacyFilter.records.kind.secret',
    custom: 'settings.privacyFilter.records.kind.custom',
    email: 'settings.privacyFilter.type.email',
    phone: 'settings.privacyFilter.type.phone',
    privatePerson: 'settings.privacyFilter.type.person',
    privateAddress: 'settings.privacyFilter.type.address',
    privateDate: 'settings.privacyFilter.type.date',
    account: 'settings.privacyFilter.type.account',
    paymentCard: 'settings.privacyFilter.type.paymentCard',
    ipAddress: 'settings.privacyFilter.type.ipAddress',
    url: 'settings.privacyFilter.type.url',
};

const ruleLabels: Record<
    Exclude<PrivacyProtectionRuleMatch['id'], 'customPrefix' | 'customWord' | 'localModel'>,
    MessageKey
> = {
    privateKey: 'settings.privacyFilter.rule.privateKey',
    apiKey: 'settings.privacyFilter.rule.apiKey',
    jwt: 'settings.privacyFilter.rule.jwt',
    secretAssignment: 'settings.privacyFilter.rule.secretAssignment',
    urlPassword: 'settings.privacyFilter.rule.urlPassword',
    email: 'settings.privacyFilter.rule.email',
    phone: 'settings.privacyFilter.rule.phone',
    chinaId: 'settings.privacyFilter.rule.chinaId',
    paymentCard: 'settings.privacyFilter.rule.paymentCard',
};
const modelNames: Record<PrivacyFilterModelId, string> = {
    'astrlink-guard-int8': ['AstrLink', 'Guard', 'INT8'].join(' '),
    'openai-privacy-filter': ['OpenAI', 'Privacy', 'Filter', 'Q8'].join(' '),
    'openmed-privacy-filter': ['OpenMed', 'Privacy', 'Filter', 'Q8'].join(' '),
};

export function privacyProtectionRuleDescription(
    hit: PrivacyProtectionRuleMatch,
    kind: PrivacyProtectionKind
): string {
    if (hit.id === 'customPrefix' || hit.id === 'customWord') {
        return t(
            hit.id === 'customPrefix'
                ? 'settings.privacyFilter.rule.customPrefix'
                : 'settings.privacyFilter.rule.customWord',
            { value: hit.value }
        );
    }
    if (hit.id === 'localModel') {
        return t('settings.privacyFilter.rule.localModel', {
            model: modelNames[hit.modelId],
            category: t(privacyProtectionKindLabels[kind]),
        });
    }
    return t(ruleLabels[hit.id]);
}
