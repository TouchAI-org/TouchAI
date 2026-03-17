export function truncateText(text: string, maxLength: number, ellipsis = '...'): string {
    return text.length > maxLength ? text.substring(0, maxLength) + ellipsis : text;
}
