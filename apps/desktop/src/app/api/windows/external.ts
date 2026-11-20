import { openUrl } from '@/platform/windows/external';

export function openExternalLink(url: string): Promise<void> {
    return openUrl(url);
}
