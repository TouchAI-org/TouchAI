export function createWidgetMarkupInspector(resourceSelector: string) {
    return Object.freeze({
        inspect(html: string) {
            const template = document.createElement('template');
            template.innerHTML = html;
            const parsed = new DOMParser().parseFromString(html, 'text/html');
            return {
                firstElementTag: template.content.firstElementChild?.tagName ?? null,
                baseUrl: window.location.href,
                resourceUrls: [...parsed.querySelectorAll(resourceSelector)].map((element) =>
                    (
                        element.getAttribute('src') ||
                        element.getAttribute('href') ||
                        element.getAttribute('data') ||
                        ''
                    )
                        .replace(/\s+/g, ' ')
                        .trim()
                ),
            };
        },
    });
}
