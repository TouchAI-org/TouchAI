import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const siteRoot = path.resolve(scriptDir, '..');

const readSiteFile = (relativePath) => fs.readFileSync(path.join(siteRoot, relativePath), 'utf8');

const homepage = readSiteFile('src/pages/index.astro');
const componentDemo = readSiteFile('src/components/ComponentDemo.astro');
const runtime = readSiteFile('src/scripts/component-demo-runtime.ts');
const featureDemoFiles = [
    'public/feature-solver/touchai-components.html',
    'public/feature-solver-en/touchai-components.html',
    'public/feature-work-organizer/touchai-components.html',
    'public/feature-work-organizer-en/touchai-components.html',
    'public/feature-reminder/touchai-components.html',
    'public/feature-reminder-en/touchai-components.html',
];
const failures = [];

const fail = (message) => failures.push(message);

const assertMissing = (source, label, forbidden) => {
    if (source.includes(forbidden)) {
        fail(`${label} still contains ${JSON.stringify(forbidden)}.`);
    }
};

[
    'data-github-stat="issues"',
    "data-github-stat='issues'",
    'open_issues',
    'search/issues',
    'teams.stats.issues',
    'Open issues',
].forEach((token) => assertMissing(homepage, 'homepage', token));

for (const match of homepage.matchAll(
    /\.feature-(?:component|work|reminder)-card\s*\{([^{}]*)\}/g
)) {
    const block = match[1];
    if (block.includes('height: auto') || block.includes('aspect-ratio: 760 / 657')) {
        fail('Feature demo cards must keep using --feature-demo-height instead of aspect-ratio.');
    }
}

for (const match of homepage.matchAll(/\.github-stats\s*\{([^{}]*)\}/g)) {
    if (match[1].includes('repeat(3')) {
        fail('GitHub stats layout still reserves three columns after removing Open issues.');
    }
}

if (homepage.includes('const getCompactFeatureStart')) {
    fail('Feature demos must not use early compact viewport start thresholds.');
}

if (homepage.includes('window.innerHeight * 0.92')) {
    fail('Feature demos must not start when the block only reaches the lower viewport.');
}

if (!homepage.includes('trigger: featureBlock') || !homepage.includes('getFeatureStickyTop()')) {
    fail('Feature demos must start when the sticky feature shell reaches the viewport center.');
}

if (!homepage.includes('syncFeatureDemoProgress(solverFrame, 0, true)')) {
    fail('Feature demos must force-send zero progress on initial load.');
}

featureDemoFiles.forEach((file) => {
    const html = readSiteFile(file);
    const promptInput = html.match(/<input[\s\S]*?class="prompt-input"[\s\S]*?>/);
    if (promptInput && !promptInput[0].includes('value=""')) {
        fail(`${file} prompt input must start empty.`);
    }
});

const requiresFeatureCompleteAutoHeight = (source, label) => {
    const selectors = [
        '.feature-component-frame.is-complete .chat-panel',
        '.feature-work-frame.is-complete .chat-panel',
        '.feature-reminder-frame.is-complete .chat-panel',
        '.feature-component-frame.is-scroll-driven.is-complete .chat-panel',
        '.feature-work-frame.is-scroll-driven.is-complete .chat-panel',
        '.feature-reminder-frame.is-scroll-driven.is-complete .chat-panel',
    ];

    let hasRule = false;
    let searchFrom = 0;
    while (!hasRule) {
        const ruleStart = source.indexOf(selectors[0], searchFrom);
        if (ruleStart < 0) break;
        const ruleFragment = source.slice(ruleStart, ruleStart + 1200);
        hasRule =
            selectors.every((selector) => ruleFragment.includes(selector)) &&
            ruleFragment.includes('min-height: 0 !important') &&
            ruleFragment.includes('height: auto !important');
        searchFrom = ruleStart + selectors[0].length;
    }

    if (!hasRule) {
        fail(`${label} must override feature demo complete-state chat panels to auto height.`);
    }
};

requiresFeatureCompleteAutoHeight(componentDemo, 'ComponentDemo host CSS');
requiresFeatureCompleteAutoHeight(runtime, 'component demo runtime CSS');

const requiresFeatureStageTopAlignment = (source, label) => {
    const selectors = [
        '.feature-component-frame .stage',
        '.feature-work-frame .stage',
        '.feature-reminder-frame .stage',
    ];

    let hasRule = false;
    let searchFrom = 0;
    while (!hasRule) {
        const ruleStart = source.indexOf(selectors[0], searchFrom);
        if (ruleStart < 0) break;
        const ruleFragment = source.slice(ruleStart, ruleStart + 600);
        hasRule =
            selectors.every((selector) => ruleFragment.includes(selector)) &&
            ruleFragment.includes('justify-content: flex-start !important');
        searchFrom = ruleStart + selectors[0].length;
    }

    if (!hasRule) {
        fail(`${label} must top-align feature demo stages so idle cards stay centered.`);
    }
};

requiresFeatureStageTopAlignment(componentDemo, 'ComponentDemo host CSS');
requiresFeatureStageTopAlignment(runtime, 'component demo runtime CSS');

featureDemoFiles.forEach((file) => {
    const html = readSiteFile(file);
    if (html.includes('.response li > span:last-child') && !html.includes(':not(.kbd)')) {
        fail(`${file} must not let list span rules turn inline .kbd tags into full-width blocks.`);
    }

    if (
        !html.includes('function keepLatestResponseVisible()') ||
        !html.includes('keepLatestResponseVisible();')
    ) {
        fail(`${file} must keep scroll-driven responses pinned to the newest generated text.`);
    }

    if (html.includes('scrollProgress') || html.includes('maxScroll * scrollProgress')) {
        fail(`${file} must keep scroll-driven responses pinned to the latest generated text.`);
    }
});

if (failures.length) {
    console.error(failures.map((message) => `- ${message}`).join('\n'));
    process.exit(1);
}

console.log('Homepage regression checks passed.');
