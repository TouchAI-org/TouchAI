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
const introDemoFiles = [
    'public/touchai-intro/touchai-components.html',
    'public/touchai-intro-en/touchai-components.html',
];
const englishFeatureDemoFiles = featureDemoFiles.filter((file) => file.includes('-en/'));
const englishHomepageDemoFiles = [
    'public/feature-work-organizer-en/touchai-components.html',
    'public/feature-reminder-en/touchai-components.html',
    'public/touchai-intro-en/touchai-components.html',
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

const glimmLayerRule = homepage.match(/\.glimm-click-layer\s*\{[\s\S]*?\}/);
if (!glimmLayerRule || !/pointer-events:\s*none;/.test(glimmLayerRule[0])) {
    fail('Homepage glimm transition layer must never block pointer interaction.');
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

    if (/const\s+scrollProgress\s*=/.test(html) || /maxScroll\s*\*\s*scrollProgress/.test(html)) {
        fail(`${file} must keep scroll-driven responses pinned to the latest generated text.`);
    }

    if (
        !/@media\s*\(min-width:\s*841px\)\s*\{[\s\S]*?body\.is-scroll-driven\.is-complete\s+\.chat-panel/.test(
            html
        )
    ) {
        fail(`${file} must keep scroll-driven complete-state height overrides desktop-only.`);
    }
});

introDemoFiles.forEach((file) => {
    const html = readSiteFile(file);

    if (html.includes('.response li > span:last-child') && !html.includes(':not(.kbd)')) {
        fail(`${file} must not let list span rules turn inline .kbd tags into full-width blocks.`);
    }

    if (!html.includes('function keepLatestResponseVisible()')) {
        fail(`${file} must keep the latest intro demo text visible while scrolling.`);
    }

    if (/const\s+scrollProgress\s*=/.test(html) || /maxScroll\s*\*\s*scrollProgress/.test(html)) {
        fail(`${file} must not map intro demo scrolling by proportional progress.`);
    }
});

englishFeatureDemoFiles.forEach((file) => {
    const html = readSiteFile(file);

    if (!html.includes('<html lang="en">')) {
        fail(`${file} must declare English document language.`);
    }
});

const assertEnglishDemoLabels = (file, requiredTokens) => {
    const html = readSiteFile(file);
    requiredTokens.forEach((token) => {
        if (!html.includes(token)) {
            fail(`${file} must include ${JSON.stringify(token)}.`);
        }
    });
};

assertEnglishDemoLabels('public/feature-work-organizer-en/touchai-components.html', [
    'TouchAI conversation demo',
    'Window toolbar',
    'New conversation',
    'Conversation history',
    'Maximize window',
    'Pin window',
    'User prompt',
    'Copy problem',
    'Scroll to bottom',
    'Message composer',
    'Problem input',
    'Send',
    'Answer actions',
    'Thinking',
    'Copy answer',
    'Regenerate answer',
]);

[
    'public/feature-reminder-en/touchai-components.html',
    'public/touchai-intro-en/touchai-components.html',
].forEach((file) => {
    if (!readSiteFile(file).includes('<html lang="en">')) {
        fail(`${file} must declare English document language.`);
    }
});

if (
    /querySelectorAll\('p, h2, ul, li, \.math-block, \.response-divider'\)/.test(
        readSiteFile('public/feature-reminder/touchai-components.html')
    )
) {
    fail('Reminder demo resetVisibleBlocks must also clear tool-call visibility.');
}

if (
    /querySelectorAll\('p, h2, ul, li, \.math-block, \.response-divider'\)/.test(
        readSiteFile('public/feature-reminder-en/touchai-components.html')
    )
) {
    fail('English reminder demo resetVisibleBlocks must also clear tool-call visibility.');
}

[
    'public/feature-reminder/touchai-components.html',
    'public/feature-reminder-en/touchai-components.html',
].forEach((file) => {
    const html = readSiteFile(file);

    if (
        !/function setResponseProgress\(progress\)\s*\{[\s\S]*?setToolCallVisibility\(ratio\);/.test(
            html
        )
    ) {
        fail(`${file} must include tool calls in scroll-driven response progress reveals.`);
    }

    if (
        !/const\s+textRevealProgress\s*=\s*ratio\s*<=\s*0\.24\s*\?\s*0\s*:\s*\(ratio\s*-\s*0\.24\)\s*\/\s*0\.76;/.test(
            html
        )
    ) {
        fail(`${file} must finish showing both MCP tool calls before the answer text starts rendering.`);
    }
});

if (failures.length) {
    console.error(failures.map((message) => `- ${message}`).join('\n'));
    process.exit(1);
}

console.log('Homepage regression checks passed.');
