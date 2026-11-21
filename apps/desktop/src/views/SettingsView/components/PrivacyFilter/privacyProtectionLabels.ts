import type { PrivacyProtectionKind } from '@/app/api/privacy';
import type { MessageKey } from '@/i18n';

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
