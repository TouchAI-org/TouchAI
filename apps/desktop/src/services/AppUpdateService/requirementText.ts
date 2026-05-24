import type { AppUpdateRequirement } from './types';

import { t } from '@/i18n';

export function getAppUpdateRequirementReasonText(
    requirement: AppUpdateRequirement | null
): string {
    if (!requirement?.required) {
        return '';
    }

    switch (requirement.requiredSeverity) {
        case 'critical':
            return t('appUpdate.requiredGate.reason.critical');
        case 'security':
            return t('appUpdate.requiredGate.reason.security');
        case 'recommended':
            return t('appUpdate.requiredGate.reason.recommended');
        default:
            return t('appUpdate.requiredGate.reason.required');
    }
}
